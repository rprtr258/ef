import type {Expr, ExprID, Program, TypeTok} from "./parser";
import {BUILTINS, BUILTIN_TABLE} from "../builtin_table.ts";
import {ARITH_OPS, CMP_OPS, EQ_OPS, OP_ADD, OP_DIV, OP_NEG, OP_NOT} from "../ops.ts";
import {TANY, TBOOL, TFLOAT, TINT, TUNIT, TSTR, rowOf, tArr, tFun, tTup} from "../prims.ts";
import {showT, TypeError_} from "./type_display.ts";
import {
  FLOAT_NAMES, INT_NAMES, NUMERIC_NAMES, widthOf,
  Env, Unifier,
  type Effs, type FunT, type NumName, type Prim, type Type, type TupT,
} from "./unify.ts";
import {
  beginLamWidths, checkLamWidths, endLamWidths,
  stampArrKind, stampComputeWidth, stampDivWidth, stampEqWidth, stampNumKinds,
  stampSuspension, touchNumericVar,
} from "../stamps.ts";
import {assertNever} from "../assert.ts";
import type {Loc, LocRange} from "./lexer.ts";
import {exprChildren, type BinderKinds} from "./walk.ts";

// Traversal arrangement: the pure structural scans (hasPerformOutsideLambdas,
// caseReferencesK) enumerate children through walk.ts's exprChildren, so
// child order is stated once. inferNode keeps its own exhaustive switch —
// its per-variant logic interleaves unification, env extension, and error
// anchoring with child inference, so its visit order is semantics, not
// structure, and cannot go through a shared pre-order visitor.

// Effect declaration: parameter types + the type the resumed continuation
// yields. Parser-produced sigs may leave parameters unannotated (`null`) —
// the checker replaces those with fresh variables when registering the
// effect (builtins' sigs are always concrete).
export type EffectSig = {
  params: (Type | null)[],
  ret: Type,
  // Display-only param names (LSP hover): parser sigs keep the source names,
  // builtin sigs name theirs. Rendered as `name: type` per position; absent
  // names render the bare type as before.
  names?: string[],
};

// Names no binding may take: BUILTINS is the shared list of everything an
// ef program can name — operators (structural, not env-seeded) plus
// non-effect builtins. Read at module init from builtin_table.ts, a leaf —
// init-order safe by construction.
const BUILTIN_NAMES = new Set(BUILTINS.map(b => b.name));

// No shadowing: a binding may not take any name reachable from its frame —
// not a builtin (they live in the top frame), not an enclosing binding, not
// even a same-frame redeclaration (later bindings never overwrite earlier
// ones, so the REPL acc chain is strict for free). Effect names are a
// separate namespace (`Out!` vs a binding `Out`) and stay bindable.
function checkBind(env: Env, name: string): void {
  // `_` is the discard convention (the unused-arg lint skips it too), so it
  // may repeat and rebind freely.
  if (name === "_") return;
  if (BUILTIN_NAMES.has(name))
    throw new TypeError_(`cannot shadow builtin '${name}'`);
  if (env.vars.has(name))
    throw new TypeError_(`cannot redeclare '${name}'`);
  for (let p = env.parent; p !== null; p = p.parent)
    if (p.vars.has(name))
      throw new TypeError_(`cannot shadow '${name}'`);
}

// Token emission coverage (compile-time): every kind from walk.ts's
// BinderKinds — the assertNever-guarded binder-site enumeration — is
// classified here as token-recorded (TokBinders, enforced at the recordTok
// call sites via the kind argument) or deliberately unrecorded
// (UnrecordedBinders: dlet field binders keep the bare element type — and
// within already-recorded kinds, individual binder sites may simply not
// emit, e.g. the handle resume binder `k`, never an expression identifier;
// classification is per kind, not per site). While a binder kind is
// recordTok call fails to compile: a new binder-bearing node variant —
// already forced into forEachBinder by its assertNever — must classify its
// binders there, then emit through its inferNode arm (or land in
// UnrecordedBinders).
type TokBinders = "lambda" | "let" | "handle";
type UnrecordedBinders = "dlet";
type BinderCoverage =
  [Exclude<BinderKinds, TokBinders | UnrecordedBinders>] extends [never] ? TokBinders : never;
// Kinds at the recordTok call sites: the emitting binder kinds plus `sym` —
// the one identifier-use site (a reference records wherever it appears, not
// only at binders).
type TokKinds = BinderCoverage | "sym";

// Per-checkProgram-call recording of checking output that is not unifier
// state: the type recorded per checked node (the width/suspension stamp
// post-passes read it after all items are checked; the LSP reads per-node
// types off the returned Checked), the value-identifier tokens for the LSP,
// and the effect signatures (their display-only param names feed the same
// hover surface). Created per call and threaded through inference alongside
// `effs`: REPL lines share the unifier and the effect map but not the node
// slice, so per-line types must not leak across lines' ExprID spaces, and a
// returned Checked keeps its own recordings alive via its own reference.
class TokenRecorder {
  readonly nodeTypes: (Type | undefined)[] = [];
  readonly semToks: TypeTok[] = [];
  constructor(
    readonly nodes: Expr[],        // the checked slice (pin's self-box lookups)
    readonly locs: (LocRange | undefined)[], // the same slice's node extents (Program.locs)
    private readonly uni: Unifier, // token classification resolves first
    private readonly effects: Map<string, EffectSig>,
  ) {}

  // Every checked node's inferred type lands here exactly once (infer's
  // single site); the lambda-retTyp retry path re-infers the same node and
  // may overwrite — the slot holds each node's final stamp.
  recordType(id: ExprID, t: Type): void { this.nodeTypes[id] = t; }
  typeOf(id: ExprID): Type | undefined { return this.nodeTypes[id]; }

  // One emission point for value-identifier tokens: a resolved fn type
  // highlights `function`, anything else `variable`. Positionless binders
  // (parse recovery) record nothing. `kind` carries the emitting node kind
  // for the coverage guard above; it drives nothing at runtime.
  recordTok(_kind: TokKinds, pos: Loc | undefined, name: string, t: Type): void {
    if (pos === undefined) return;
    const rt = this.uni.res(t);
    this.semToks.push({pos, len: name.length, name, kind: rt.tag === "fun" ? "function" : "variable"});
  }

  // Effect signature registration (checker-fresh param types + the parser's
  // display names) through the same emission point as the token streams.
  recordEffect(name: string, sig: EffectSig): void { this.effects.set(name, sig); }
}

// Forward a flattened row's members into an ambient accumulator row — ops
// and still-unbound variables both (a polymorphic callee's row variable must
// ride along; see the app case).
function absorbEffs(dst: Effs, src: Effs): void {
  for (const op of src.ops) dst.ops.add(op);
  for (const v of src.vars) dst.vars.add(v);
}

// Infer an `[...]` literal. With an `expected` tuple, elements are checked
// against the tuple's field types (named-tuple construction). Without one,
// attempt homogeneous unification behind a checkpoint; on failure build a
// tuple from the (preserved) element types.
function inferArr(
  id: ExprID,
  nodes: Expr[],
  expected: TupT | null,
  env: Env,
  effs: Effs,
  effects: Map<string, EffectSig>,
  rec: TokenRecorder,
): Type {
  const e = nodes[id];
  if (e.t !== "arr") throw new Error("inferArr: not an array literal");
  if (expected !== null) {
    if (e.elems.length !== expected.fields.length)
      throw new TypeError_(`literal arity ${e.elems.length} ≠ tuple ${expected.fields.length}`);
    stampArrKind(e, "tup");
    for (let i = 0; i < e.elems.length; i++) {
      const ft = expected.fields[i].type;
      const el = e.elems[i];
      // Propagate the tuple expectation into a nested `[...]` literal so that
      // `m: [[f,f,f],...] = [[1,2,3],...]` builds inner tuples, not arrays.
      const et = (nodes[el].t === "arr" && env.uni.res(ft).tag === "tup")
        ? inferArr(el, nodes, env.uni.res(ft) as TupT, env, effs, effects, rec)
        : infer(el, nodes, env, effs, effects, rec);
      env.uni.unify(et, ft);
    }
    return expected;
  }
  const elemTs = e.elems.map(a => infer(a, nodes, env, effs, effects, rec));
  const snap = env.uni.checkpoint();
  try {
    const elem = env.uni.fresh();
    for (const et of elemTs)
      env.uni.unify(elem, et);
    stampArrKind(e, "arr");
    return tArr(env.uni.res(elem));
  } catch (_) {
    env.uni.restore(snap);
    stampArrKind(e, "tup");
    return tTup(elemTs.map(t => ({name: null, type: env.uni.res(t)})));
  }
}

// Infer `e` expecting a tuple type. Propagates the expectation into array
// literals (so `[1,2,3]` becomes a tuple), blocks (last statement), and
// lambda bodies (return type), so a declared `[f,f,f]` return flows into a
// `[x, y, z]` body literal. Both call sites (lambda retTyp, block tail)
// guard on the expectation being a resolved tup, so `expected` is a TupT.
function inferWith(id: ExprID, nodes: Expr[], expected: TupT, env: Env, effs: Effs, effects: Map<string, EffectSig>, rec: TokenRecorder): Type {
  const e = nodes[id];
  if (e.t === "arr")
    return inferArr(id, nodes, expected, env, effs, effects, rec);
  if (e.t === "block") {
    const n = env.extend();
    let last: Type = TUNIT;
    // A `;`-terminated tail discards the last statement's value: the block
    // is unit, so no tup expectation flows into it.
    for (let i = 0; i < e.stmts.length; i++)
      last = !e.semi && i === e.stmts.length - 1
        ? inferWith(e.stmts[i], nodes, expected, n, effs, effects, rec)
        : infer(e.stmts[i], nodes, n, effs, effects, rec);
    return e.semi ? TUNIT : last;
  }
  if (e.t === "lambda" && e.retTyp !== null) {
    const saved = e.retTyp;
    e.retTyp = expected;
    try { return infer(id, nodes, env, effs, effects, rec); }
    finally { e.retTyp = saved; }
  }
  return infer(id, nodes, env, effs, effects, rec);
}

// Parse a `.N` numeric field name into an index, or null if `name` isn't numeric.
function fieldIndex(name: string): number | null {
  return /^[0-9]+$/.test(name) ? Number(name) : null;
}

// Operator classifications (ARITH_OPS/CMP_OPS/EQ_OPS) are hosted in ops.ts.
// The checker special-cases them in `infer` instead of the generic
// function-application path; `+` is dispatched separately (see `plusType`).
function isNum(t: Type): t is Prim {
  return t.tag === "prim" && NUMERIC_NAMES.has(t.name as NumName);
}

const ANY_ARITH = "any is not a numeric width — concrete widths required for arithmetic";
// `==` / `!=` are special-cased in `infer` (see EQ_OPS): they are NOT installed
// as ordinary `(any, any) -> bool` function bindings, so they can't be used as
// first-class values and can't silently compare unrelated types.

// Numeric op result under strict same-type arithmetic: untyped literals
// (`int`/`float` names) are wildcards that take the other side's concrete
// width — unification binds the width into the wildcard instance itself
// (float wins between two wildcards; two distinct concrete widths are a
// type error — @as converts explicitly). Two same-kind wildcards get a
// fresh result wildcard linked to both operands: a later concrete context
// (annotation, outer op) mutates the result and resolveWilds propagates the
// width into the literals, so operands and op share one final width.
function numericResult(u: Unifier, ra: Type, rb: Type, op: string): Type {
  if (isNum(ra) && rb.tag === "var") { u.unify(rb, ra); return ra; }
  if (isNum(rb) && ra.tag === "var") { u.unify(ra, rb); return rb; }
  if (ra.tag === "var" && rb.tag === "var") { u.unify(ra, rb); return u.res(ra); }
  if (ra.tag === "var") { u.unify(ra, TINT); return TINT; }
  if (rb.tag === "var") { u.unify(rb, TINT); return TINT; }
  if (ra.tag === "prim" && rb.tag === "prim") {
    const na = ra.name as NumName, nb = rb.name as NumName;
    if (na === "int" || na === "float") {
      if (nb === "int" || nb === "float") {
        if (na !== nb) {
          // Mixed wildcards: the int side flexes to float (both default f64).
          u.flexWild(na === "int" ? ra : rb, "float");
          return TFLOAT;
        }
        const r = u.newWild(na);
        u.linkWilds(r, ra);
        u.linkWilds(r, rb);
        return r;
      }
      u.flexWild(ra, nb); return rb;              // concrete width wins
    }
    if (nb === "int" || nb === "float") { u.flexWild(rb, na); return ra; }
    if (na === nb) return ra;                     // strict same-width
    throw new TypeError_(`${op}: ${showT(ra)} and ${showT(rb)} are different numeric widths (use @as to convert)`);
  }
  throw new TypeError_(`${op}: ${showT(ra)} and ${showT(rb)} are not numeric`);
}

// Unify two operand types under a numeric op and return the widened result
// (float if either side is float, else int; `any` if either is `any`).
function numeric(u: Unifier, a: Type, b: Type, op: string): Type {
  touchNumericVar(u, a);
  touchNumericVar(u, b);
  const ra = u.res(a), rb = u.res(b);
  if (ra.tag === "any" || rb.tag === "any") throw new TypeError_(ANY_ARITH);
  return numericResult(u, ra, rb, op);
}

// `+` is overloaded: num+num (strict same-width, untyped literals flex) or
// string+string -> string. Mixed (`"a" + 1`) is a type error. `any` on either
// side stays `any`.
function plusType(u: Unifier, a: Type, b: Type): Type {
  touchNumericVar(u, a);
  touchNumericVar(u, b);
  const ra = u.res(a), rb = u.res(b);
  if (ra.tag === "any" || rb.tag === "any") throw new TypeError_(ANY_ARITH);
  const sa = isNum(ra), sb = isNum(rb);
  if (sa && sb) return numericResult(u, ra, rb, OP_ADD);
  const stra = ra.tag === "prim" && ra.name === "string";
  const strb = rb.tag === "prim" && rb.name === "string";
  if (stra && strb) return TSTR;
  if (sa && rb.tag === "var") { u.unify(rb, ra); return ra; }
  if (sb && ra.tag === "var") { u.unify(ra, rb); return rb; }
  if (stra && rb.tag === "var") { u.unify(rb, ra); return ra; }
  if (strb && ra.tag === "var") { u.unify(ra, rb); return rb; }
  if (ra.tag === "var" && rb.tag === "var") { u.unify(ra, rb); return u.res(ra); }
  throw new TypeError_(`+: ${showT(ra)} and ${showT(rb)} are not both numeric or both string`);
}

// Resume-delivery rule (see AGENTS.md "resume k type"): both walks drive the
// spine-gated resume typing in the handle case.

// Does `root`'s evaluation spine perform any op — everything except nested
// lambda bodies (a lambda's performs land on the lambda's own row) and
// handle case bodies (they run past the handler, so only `body` is on the
// spine)? Children beyond those two exclusions are exactly exprChildren's.
function hasPerformOutsideLambdas(nodes: Expr[], root: ExprID): boolean {
  const e = nodes[root];
  if (e.t === "perform") return true;
  if (e.t === "lambda") return false;
  const kids = e.t === "handle" ? [e.body] : exprChildren(e);
  return kids.some(id => hasPerformOutsideLambdas(nodes, id));
}

// Does the case body lexically reference the resume binder `name`? Any
// textual occurrence counts — even inside lambda bodies (`map(k, opts)`) or
// shadowed — so the gate over-approximates referencing and can only fire
// more, never less.
function caseReferencesK(nodes: Expr[], name: string, root: ExprID): boolean {
  let found = false;
  // Pre-order DFS through exprChildren, stopping at the first occurrence.
  const go = (id: ExprID): boolean => {
    const e = nodes[id];
    if (e.t === "sym" && e.v === name) {
      found = true;
      return false;
    }
    for (const k of exprChildren(e))
      if (!go(k)) return false;
    return true;
  };
  go(root);
  return found;
}

// infer: returns the type, side-effecting `effs` with performed effects.
// `id` indexes into the program's flat node slice `nodes`. Every node's
// inferred type is recorded on the recorder (`rec.nodeTypes`); after checking
// completes, a post-pass stamps each node whose type resolves to a numeric width with
// `numKind` (concrete widths as-is, untyped int/float literals defaulted to
// i64/f64). The evaluator normalizes each node's value to that width's
// runtime representation (i32/u32/f32/f64: JS number, i64/u64: BigInt) and
// the wasm backend reads f32 stamps for its fround round-trip.
function infer(
  id: ExprID,
  nodes: Expr[],
  env: Env,
  effs: Effs,
  effects: Map<string, EffectSig>,
  rec: TokenRecorder,
): Type {
  const t = inferNode(id, nodes, env, effs, effects, rec);
  rec.recordType(id, t);
  return t;
}

function inferNode(
  id: ExprID,
  nodes: Expr[],
  env: Env,
  effs: Effs,
  effects: Map<string, EffectSig>,
  rec: TokenRecorder,
): Type {
  const e = nodes[id];
  try {
  switch (e.t) {
    case "num": return env.uni.newWild(e.isFloat ? "float" : "int");
    case "str": return TSTR;
    case "bool": return TBOOL;
    case "unit": return TUNIT;
    case "sym": {
      const s = env.lookup(e.v);
      if (s === undefined)
        throw new TypeError_("Unbound: " + e.v);
      const t = typeof s === "function" ? s() : s;
      // A read of a wildcard-typed value (a binding over an untyped literal,
      // or a signature's TINT/TFLOAT) copies the wildcard per read: each
      // use flexes its own width in unification without leaking the
      // mutation into the binding's type or sibling reads. Concrete prims
      // are immutable and shared as-is.
      const rt = env.uni.res(t);
      const t2 = rt.tag === "prim" && (rt.name === "int" || rt.name === "float")
        ? env.uni.newWild(rt.name)
        : t;
      // Copied reads remember the binding's own type: after resolution the
      // checker marks reads whose site width diverged from the binding's
      // box width (the backends adapt the stored representation there).
      if (t2 !== t) (e as Expr & {bindTyp?: Type}).bindTyp = t;
      // Value-identifier highlighting: operator desugar syms never reach here
      // (the app case handles them without inferring the callee node).
      rec.recordTok("sym", rec.locs[id]?.start, e.v, t2);
      return t2;
    }
    case "lambda": {
      const n = env.extend();
      const ps: Type[] = [];
      const unann: {name: string, id: number}[] = [];
      for (const p of e.params) {
        checkBind(n, p.name);
        if (p.typ === null) {
          const pt = env.uni.fresh();
          unann.push({name: p.name, id: pt.id});
          n.vars.set(p.name, pt);
          ps.push(pt);
        } else {
          n.vars.set(p.name, p.typ);
          ps.push(p.typ);
        }
        // Params bind mutable: `n = n / 2` on a parameter rebinds it locally
        // (pre-existing behavior under assignment-to-nearest-binding).
        n.muts.add(p.name);
      }
      const innerEffs = rowOf();
      // Width-ambiguity tracking: register this lambda's unannotated param
      // vars for the body's numeric ops; the `let` binding the lambda runs
      // the rejection check (checkLamWidths).
      const ctx = beginLamWidths(unann);
      let ret: Type;
      try {
        const rt = e.retTyp !== null ? env.uni.res(e.retTyp) : null;
        ret = rt !== null && rt.tag === "tup"
          ? inferWith(e.body, nodes, rt, n, innerEffs, effects, rec)
          : infer(e.body, nodes, n, innerEffs, effects, rec);
      } finally {
        endLamWidths(ctx, e, unann);
      }
      if (e.retTyp !== null) {
        env.uni.unify(e.retTyp, ret);
      }
      // Effect annotation is optional: if `! { ... }` is omitted, the
      // function's effect set is derived from the body's performed effects.
      // If present, the declaration is the function's exact row — it is never
      // altered. Unbound row variables (an unannotated HOF parameter's
      // unknown effects) are pinned to the declared set, so the function
      // performs exactly what it declares and a callee stepping outside the
      // declaration fails at the call site. An empty declaration cannot pin
      // unknown effects to anything, so a body whose unannotated parameter
      // performs is rejected — annotate the parameter's type instead.
      if (e.retEffs !== null) {
        const decl = e.retEffs.size > 0 ? [...e.retEffs].join(", ") : "∅";
        for (const v of env.uni.resRow(innerEffs).vars) {
          const owner = env.uni.forcedRows.get(env.uni.effFind(v.id));
          // Skip variables not borne by this lambda's parameters: a recursive
          // self-call's row variable is constrained by the binding's own
          // unification right after this check.
          if (owner !== undefined && !ps.some(p => p.tag === "var" && p.id === owner)) continue;
          if (e.retEffs.size === 0)
            throw new TypeError_(
              `effect annotation ! { ∅ } can't cover an unannotated parameter's effects — annotate the parameter's type with its effect row`);
          env.uni.effBinds.set(env.uni.effFind(v.id), rowOf(e.retEffs));
        }
        for (const op of env.uni.resRow(innerEffs).ops) {
          if (!e.retEffs.has(op))
            throw new TypeError_(`effect ${op} not declared in signature (declared: ${decl})`);
        }
      }
      const ft = tFun(ps, e.retTyp ?? ret, e.retEffs !== null ? rowOf(e.retEffs) : innerEffs);
      e.typ = ft;
      // Param binders classified here, after the body has unified — an
      // unannotated param used as a callee resolves to a FunT by now.
      for (let i = 0; i < e.params.length; i++) {
        const p = e.params[i];
        rec.recordTok("lambda", p.pos, p.name, ps[i]);
      }
      return ft;
    }
    case "let": {
      checkBind(env, e.name);
      // Recursive binding: the name is in scope in its own value, so
      // `f :: fn(...){...}` can call itself.
      const declared = e.typ ?? env.uni.fresh();
      env.vars.set(e.name, declared);
      // Mutability is a property of the binding in this frame: redeclaring a
      // name as const (or as mutable) in the same frame flips the flag, so
      // assignment always resolves against the latest declaration.
      if (e.mut) env.muts.add(e.name);
      else env.muts.delete(e.name);
      // A tuple annotation on an `[...]` literal makes it a tuple even when its
      // elements would otherwise unify homogeneously (e.g. `p: [float, float] = [1.0, 2.0]`).
      const vt = (e.typ !== null && env.uni.res(e.typ).tag === "tup" && nodes[e.val].t === "arr")
        ? inferArr(e.val, nodes, env.uni.res(e.typ) as TupT, env, effs, effects, rec)
        : infer(e.val, nodes, env, effs, effects, rec);
      env.uni.unify(declared, vt);
      const rt = env.uni.res(declared);
      rec.recordTok("let", rec.locs[id]?.start, e.name, declared);
      // The lambda's stamped type is final: its parameter variables have been
      // bound (or not), so deep-resolve it — display never needs the unifier.
      const lam = nodes[e.val];
      if (lam.t === "lambda") {
        if (lam.typ !== undefined)
          lam.typ = env.uni.deepRes(lam.typ) as FunT;
        checkLamWidths(env.uni, lam);
      }
      // Exclude the self-binding from the free-var context before
      // generalizing (otherwise its own vars read as free-in-env → no-op).
      env.vars.delete(e.name);
      // Value restriction: generalize only immutable lambda values (literals
      // carry no type vars; `arr` literals are typed directly by inferArr).
      // This keeps mutable-array/assign soundness (no `x := []` : [a]), and
      // mutable lambdas stay monomorphic too: assignment must unify against
      // the binding's stored type — a generalized scheme would instantiate
      // fresh vars per use, so `x = fn(y: i64) { y + 1 }` could never inform
      // later uses, which would keep checking against the stale scheme while
      // the runtime runs the new closure (type confusion).
      env.vars.set(e.name, e.typ !== null ? rt : (nodes[e.val].t === "lambda" && !e.mut ? env.uni.generalize(env, rt) : rt));
      if (e.typ === null && env.uni.containsAny(rt))
        env.uni.warnInferredAny(e.name, rt);
      return TUNIT;
    }
    case "arr":
      return inferArr(id, nodes, null, env, effs, effects, rec);
    // `@as(expr, T)`: the one explicit numeric cast. Numeric widths only;
    // float -> int truncates toward zero, bool -> numeric gives 0/1, and
    // everything else is value-preserving (an f32 target rounds via the
    // node's generic f32 stamp; i32 -> i64 and f32 -> f64 are no-ops).
    case "as": {
      const at = env.uni.res(infer(e.e, nodes, env, effs, effects, rec));
      const target = e.typ;
      if (target.tag !== "prim" || target.name === "int" || target.name === "float" || !NUMERIC_NAMES.has(target.name as NumName))
        throw new TypeError_(`@as: target must be a numeric width (i32 i64 u32 u64 f32 f64), got ${showT(target)}`);
      const srcOk = at.tag === "any" || (at.tag === "prim" && (NUMERIC_NAMES.has(at.name as NumName) || at.name === "bool"));
      if (!srcOk)
        throw new TypeError_(`@as: cannot cast ${showT(at)} to ${showT(target)}`);
      const tn = target.name as NumName;
      if (INT_NAMES.has(tn) && at.tag === "prim" && (FLOAT_NAMES.has(at.name as NumName) || at.name === "float"))
        e.asKind = "trunc";
      else if (at.tag === "prim" && at.name === "bool")
        e.asKind = "boolnum";
      return target;
    }
    // `obj.x` / `obj.0`: resolve the field index from the (tuple or array)
    // element type and stamp it on the node for the evaluator.
    case "field": {
      const ot = env.uni.res(infer(e.obj, nodes, env, effs, effects, rec));
      if (ot.tag === "arr") {
        const idx = fieldIndex(e.name);
        if (idx === null)
          throw new TypeError_(`arrays use .N indexing, not .${e.name}`);
        e.idx = idx;
        e.shape = "arr";
        return ot.elem;
      }
      if (ot.tag === "tup") {
        e.shape = "tup";
        let idx: number | null = null;
        if (/^[0-9]+$/.test(e.name)) {
          idx = Number(e.name);
          if (idx < 0 || idx >= ot.fields.length)
            throw new TypeError_(`.${e.name} out of range for tuple of ${ot.fields.length}`);
        } else {
          idx = ot.fields.findIndex(f => f.name === e.name);
          if (idx < 0)
            throw new TypeError_(`tuple has no field .${e.name}`);
        }
        e.idx = idx;
        return ot.fields[idx].type;
      }
      throw new TypeError_(`field access on non-record type: ${showT(ot)}`);
    }
    // `[a, b] := val;` — destructure a tuple (or array) into bindings.
    case "dlet": {
      const vt = env.uni.res(infer(e.val, nodes, env, effs, effects, rec));
      if (vt.tag === "tup") {
        e.shape = "tup";
        if (vt.fields.length !== e.fields.length)
          throw new TypeError_(`destructure arity ${e.fields.length} ≠ tuple ${vt.fields.length}`);
        for (let i = 0; i < e.fields.length; i++) {
          const ft = e.fields[i].typ;
          if (ft !== null)
            env.uni.unify(ft, vt.fields[i].type);
          checkBind(env, e.fields[i].name);
          env.vars.set(e.fields[i].name, ft ?? vt.fields[i].type);
        }
      } else if (vt.tag === "arr") {
        e.shape = "arr";
        for (const f of e.fields) {
          if (f.typ !== null)
            env.uni.unify(f.typ, vt.elem);
          checkBind(env, f.name);
          env.vars.set(f.name, f.typ ?? vt.elem);
        }
      } else {
        throw new TypeError_(`cannot destructure non-record type: ${showT(vt)}`);
      }
      if (e.mut)
        for (const f of e.fields) env.muts.add(f.name);
      else
        for (const f of e.fields) env.muts.delete(f.name);
      return TUNIT;
    }
    case "if": {
      const c = infer(e.c, nodes, env, effs, effects, rec);
      env.uni.unify(c, TBOOL);
      const a = infer(e.a, nodes, env, effs, effects, rec);
      const b = infer(e.b, nodes, env, effs, effects, rec);
      env.uni.unify(a, b);
      return env.uni.res(a);
    }
    case "while": {
      const c = infer(e.c, nodes, env, effs, effects, rec);
      env.uni.unify(c, TBOOL);
      infer(e.body, nodes, env, effs, effects, rec);
      return TUNIT;
    }
    case "assign": {
      // Find the innermost frame binding the name; assignment mutates that
      // binding and requires it to be mutable (`::` / `[a, b] ::` consts and
      // builtin/effect bindings reject it).
      let fr: Env | null = env;
      while (fr !== null && !fr.vars.has(e.name)) fr = fr.parent;
      if (fr === null) throw new TypeError_(`Assignment to unbound symbol: ${e.name}`);
      if (!fr.muts.has(e.name))
        throw new TypeError_(`cannot assign to const '${e.name}' (declare with := to make it mutable)`);
      const cur = fr.vars.get(e.name)!;
      const vt = infer(e.val, nodes, env, effs, effects, rec);
      // Unify against the declared type so `guess: float` keeps its type.
      env.uni.unify(typeof cur === "function" ? cur() : cur, vt);
      return TUNIT;
    }
    case "block": {
      const n = env.extend();
      let last: Type = TUNIT;
      for (const s of e.stmts) last = infer(s, nodes, n, effs, effects, rec);
      // The last expression is the block's value only when no `;` follows it.
      return e.semi ? TUNIT : last;
    }
    case "perform": {
      const sig = effects.get(e.op);
      if (sig === undefined)
        throw new TypeError_(`Unknown effect: ${e.op} (declare with: effect ${e.op}(...);)`);
      if (e.args.length !== sig.params.length)
        throw new TypeError_(`effect ${e.op}: ${sig.params.length} args, got ${e.args.length}`);
      const argTs = e.args.map(a => infer(a, nodes, env, effs, effects, rec));
      for (let i = 0; i < sig.params.length; i++) env.uni.unify(sig.params[i] ?? TANY, argTs[i]);
      effs.ops.add(e.op);
      return sig.ret;
    }
    case "handle": {
      const bodyEffs = rowOf();
      const bodyT = infer(e.body, nodes, env, bodyEffs, effects, rec);
      // Spine-gated resume typing: with no Return case and no perform on the
      // body's spine, every resumption runs the body to completion, so the
      // value k delivers is the body's completion — its boundary value, or a
      // nested case body's completion when the rest re-performs. Op cases
      // that reference k therefore also unify k's return with the body type;
      // a perform-spined body (or a Return case) keeps the looser boundary.
      const bodyCompletes = !e.cases.some(c => c.op === "Return") && !hasPerformOutsideLambdas(nodes, e.body);
      let resultT: Type | null = null;
      for (const c of e.cases) {
        const n = env.extend();
        const sig = effects.get(c.op);
        if (sig === undefined && c.op !== "Return")
          throw new TypeError_(`Handler for unknown effect: ${c.op}`);
        if (c.op === "Return") {
          checkBind(n, c.params[0].name);
          const bt = env.uni.res(bodyT);
          n.vars.set(c.params[0].name, bt);
          rec.recordTok("handle", c.params[0].pos, c.params[0].name, bt);
        } else {
          for (let i = 0; i < c.params.length; i++) {
            const cp = c.params[i];
            checkBind(n, cp.name);
            const pt = sig!.params[i] ?? TANY;
            n.vars.set(cp.name, pt);
            rec.recordTok("handle", cp.pos, cp.name, pt);
          }
        }
        // resume: (sig.ret) -> resultT ; Return's resume is identity over bodyT
        const resumeT = c.op === "Return"
          ? tFun([env.uni.res(bodyT)], env.uni.fresh(), rowOf(), {contCall: true})
          : tFun([sig!.ret], env.uni.fresh(), rowOf(), {contCall: true});
        checkBind(n, c.resume);
        n.vars.set(c.resume, resumeT);
        // Case bodies run outside this handler (its perform's continuation
        // resumes past it), so their performed effects forward to the
        // ambient row — an op they perform unhandled must remain tracked
        // (a fresh set here would let effects escape untracked).
        const ct = infer(c.body, nodes, n, effs, effects, rec);
        if (resultT === null)
          resultT = ct;
        else
          env.uni.unify(resultT, ct);
        env.uni.unify(resumeT.ret, ct);
        if (bodyCompletes && caseReferencesK(nodes, c.resume, c.body))
          env.uni.unify(resumeT.ret, env.uni.res(bodyT));
      }
      for (const c of e.cases) bodyEffs.ops.delete(c.op);
      absorbEffs(effs, bodyEffs);
      return resultT ?? TUNIT;
    }
    case "app": {
      const fn = nodes[e.fn];
      // `+` is overloaded: strict numeric arithmetic or string concatenation.
      if (fn.t === "sym" && fn.v === OP_ADD) {
        const at = infer(e.args[0], nodes, env, effs, effects, rec);
        const bt = infer(e.args[1], nodes, env, effs, effects, rec);
        const widened = plusType(env.uni, at, bt);
        // The numeric `+` stamps exactly like the other arithmetic ops (the
        // string case leaves no width to stamp).
        stampComputeWidth(env.uni, e, widened);
        return widened;
      }
      // Numeric operators (- * / %) and comparisons (< > <= >=) widen int/float;
      // unary neg is handled below. Kept out of BINOPS so they get this logic.
      if (fn.t === "sym" && (ARITH_OPS.has(fn.v) || CMP_OPS.has(fn.v))) {
        const at = infer(e.args[0], nodes, env, effs, effects, rec);
        const bt = infer(e.args[1], nodes, env, effs, effects, rec);
        const widened = numeric(env.uni, at, bt, fn.v);
        stampComputeWidth(env.uni, e, widened);
        if (CMP_OPS.has(fn.v)) return TBOOL;
        // `/` is type-preserving: int/int -> int (truncated at runtime),
        // float/float -> float; the division's width is stamped on the node
        // so the evaluator/emitters pick truncation and the signed/unsigned
        // op variants.
        if (fn.v === OP_DIV) {
          stampDivWidth(env.uni, e, widened);
          return widened;
        }
        return widened;
      }
      if (fn.t === "sym" && fn.v === OP_NEG) {
        const at = infer(e.args[0], nodes, env, effs, effects, rec);
        const widened = numeric(env.uni, at, at, OP_NEG);
        stampComputeWidth(env.uni, e, widened);
        return widened;
      }
      if (fn.t === "sym" && fn.v === OP_NOT) {
        const at = infer(e.args[0], nodes, env, effs, effects, rec);
        env.uni.unify(at, TBOOL);
        return TBOOL;
      }
      // Equality: both operands must share a type (untyped literals flex,
      // concrete widths are strict — `i32 == i64` is an error). Cross-type
      // (`"a" == 1`) is a type error.
      if (fn.t === "sym" && EQ_OPS.has(fn.v)) {
        const at = infer(e.args[0], nodes, env, effs, effects, rec);
        const bt = infer(e.args[1], nodes, env, effs, effects, rec);
        env.uni.unify(at, bt);
        stampEqWidth(env.uni, e, at, bt);
        return TBOOL;
      }
      const ft = infer(e.fn, nodes, env, effs, effects, rec);
      const fr = env.uni.res(ft);
      // When the callee is a known function, an `[...]` literal argument
      // passed against a tuple parameter type is inferred as that tuple
      // (mirroring the `name: [..] = [...]` special case).
      const argTs = e.args.map((a, i) => {
        if (nodes[a].t === "arr" && fr.tag === "fun" && i < fr.params.length && env.uni.res(fr.params[i]).tag === "tup")
          return inferArr(a, nodes, env.uni.res(fr.params[i]) as TupT, env, effs, effects, rec);
        return infer(a, nodes, env, effs, effects, rec);
      });
      const ret = env.uni.fresh();
      if (fr.tag === "fun") {
        if (fr.params.length !== argTs.length)
          throw new TypeError_(`arity ${fr.params.length} ≠ ${argTs.length}`);
        for (let i = 0; i < argTs.length; i++) env.uni.unify(fr.params[i], argTs[i]);
        env.uni.unify(fr.ret, ret);
        // The callee's effect row is unified with each callback argument's
        // effect row via the param unification above (polymorphic builtins
        // share one effect variable between the callback and the result).
        // Whatever the callee's row resolves to now is what the call performs:
        // concrete ops flow into the ambient row, and a still-unbound row
        // variable rides along as a member, so a polymorphic caller (an
        // unannotated HOF parameter) stays effect-tracked — when its parameter
        // later unifies with an effectful callee, the row resolves there.
        absorbEffs(effs, env.uni.resRow(fr.effs));
        return env.uni.res(ret);
      }
      if (fr.tag === "any") return TANY;
      // Forcing an unknown callee into a function shape gives it a fresh row
      // variable, not the empty row: an empty row here would let the callee's
      // performed effects vanish from every ambient row (the escaped-closure
      // unhandled-effect hole). The variable unifies with the eventual
      // callee's row at this call's arg unification and propagates above.
      const expected = tFun(argTs, ret, rowOf([], [env.uni.freshEff()]));
      // Remember which callee type variable this row variable was forced
      // for: the effect-annotation pinning must only cover variables belonging
      // to this lambda's parameters — a recursive self-call's variable is
      // constrained by the binding's own unification afterwards, and pinning
      // it here would reject a pure self-recursion under `! { ∅ }`.
      const rowVar = expected.effs;
      if (ft.tag === "var" && rowVar.ops.size === 0 && rowVar.vars.size === 1)
        env.uni.forcedRows.set([...rowVar.vars][0].id, ft.id);
      try { env.uni.unify(ft, expected); }
      catch (err) {
        if (err instanceof TypeError_ && fn.t === "sym")
          throw env.uni.typeMismatch(ft, expected, fn.v);
        throw err;
      }
      // The unknown callee's row is a fresh variable — propagate it, so the
      // enclosing function's row carries "whatever this parameter performs".
      absorbEffs(effs, env.uni.resRow(expected.effs));
      return env.uni.res(ret);
    }
    default:
      return assertNever(e);
  }
  } catch (err) {
    // Locate the innermost checker error at the position of the expression
    // being inferred when it was thrown. The first (deepest) frame to catch
    // wins; outer frames see `pos` set and skip.
    const p = rec.locs[id]?.start;
    if (err instanceof TypeError_ && err.pos === undefined && p !== undefined)
      err.pos = p;
    throw err;
  }
}

export type Checked = {
  env: Env,
  effects: Map<string, EffectSig>,
  uni: Unifier,
  lastType: Type,
  // Union of this call's items' top-level residual effect rows — performed
  // ops with no matching handler in their subtree (the checker's own
  // ops-minus-handled bookkeeping; lambdas defer their performs). exec
  // fails fast on entries that are neither builtin effects nor covered by
  // an interp override, instead of letting runTop throw mid-run after side
  // effects. Fresh per checkProgram call (not accumulated from acc).
  unhandled: Set<string>,
  // Value-identifier semantic tokens recorded during this call (kind
  // function/variable) — the LSP merges them with the parser's typeToks.
  semToks: TypeTok[],
  // Inferred type per node from this call — the LSP's per-node type source
  // (hover); the width/suspension stamps were already applied to the nodes.
  // Indexed by ExprID, parallel to Program.nodes (holes at nodes infer never
  // reached, e.g. operator-desugar callee syms).
  nodeTypes: (Type | undefined)[],
};

// checkProgram: typecheck `prog`. `acc` is the previous result — the REPL
// passes it back to accumulate bindings across lines. `lastType` (the last
// item's type) is returned fully resolved; callers never call `res`.
export function checkProgram(
  prog: Program,
  acc?: Checked,
): Checked {
  const uni = acc?.uni ?? new Unifier();
  let env: Env;
  let effects: Map<string, EffectSig>;
  if (acc !== undefined) {
    env = acc.env;
    effects = acc.effects;
  } else {
    effects = new Map<string, EffectSig>(BUILTIN_TABLE.filter(b => b.kind === "effect").map(b => [b.name, b.sig]));
    env = new Env(null, uni);
    for (const b of BUILTIN_TABLE) {
      if (b.kind !== "effect") {
        const bt = b.t;
        // Instantiated per use through copyScheme: the wildcard prims in a
        // signature (the TFLOAT/TINT singletons) copy to fresh wilds per
        // call site, so a call flexes its own copy without leaking the
        // width into the signature or other sites.
        env.vars.set(b.name, () =>
          uni.copyScheme(typeof bt === "function" ? bt(uni) : bt, new Map(), new Map()));
      }
    }
  }

  // The per-call recorder over this call's node slice (see TokenRecorder).
  const rec = new TokenRecorder(prog.nodes, prog.locs, uni, effects);
  for (const it of prog.items.filter(it => "effect" in it))
    rec.recordEffect(it.effect, {params: it.sig.params.map(t => t ?? uni.fresh()), ret: it.sig.ret, names: it.sig.names});

  let lastType: Type = TUNIT;
  // One shared sink for all items: infer only ever ADDS residuals to the
  // ambient row (handler matching happens in each handle's local bodyEffs
  // before forwarding), so a program-wide unhandled-op set falls out. The
  // row may carry unbound effect variables (propagated from polymorphic
  // callers); after checking, a variable that resolved to concrete ops
  // contributes those, and one that never resolved contributes nothing —
  // no constraint ever tied it to a perform.
  const row = rowOf();
  for (const it of prog.items.filter(it => "e" in it))
    lastType = infer(it.e, prog.nodes, env, row, effects, rec);
  const unhandled = new Set<string>();
  for (const op of uni.resRow(row).ops)
    unhandled.add(op);

  // Wildcard resolution: propagate op-linked widths, then default every
  // still-unbound wildcard (int → i64, float → f64). After this the checker
  // has left no untyped literals — every numeric node type is concrete, so
  // numKind stamping reads widths straight off the resolved types.
  uni.resolveWilds();
  stampNumKinds(prog.nodes, uni, rec.nodeTypes);
  // Divergent reads: a per-read wildcard copy may have flexed to a width
  // different from the binding's own box width (one untyped binding read
  // at several widths). Mark those reads so the backends adapt the stored
  // representation instead of assuming the stamp's box shape.
  for (let id = 0; id < rec.nodeTypes.length; id++) {
    const t = rec.nodeTypes[id];
    if (t === undefined) continue;
    const n = prog.nodes[id];
    if (n.t !== "sym") continue;
    const src = n as Expr & {bindTyp?: Type, adaptFrom?: string};
    if (src.bindTyp === undefined) continue;
    const sw = widthOf(uni.res(t));
    const bt = uni.res(src.bindTyp);
    const bw = bt.tag === "prim" ? widthOf(bt) : null;
    if (sw !== null && sw.concrete && bw !== null && bw.concrete && bw.w !== sw.w)
      src.adaptFrom = bw.w;
  }
  stampSuspension(prog.nodes, uni, rec.nodeTypes);

  return {env, effects, uni, lastType: uni.deepRes(lastType), unhandled, semToks: rec.semToks, nodeTypes: rec.nodeTypes};
}
