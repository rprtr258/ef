// unify: the type-system core — the `Type` union and its shapes, the
// unifier (union-find over type/effect variables, untyped-literal num
// flexing, speculative checkpoint/restore), and HM generalization over the
// checker `Env`. A leaf over prims.ts: the shape constructors (tArr/tFun/
// tTup) and the prim constants live there, and prims imports only this
// module's type shapes (type-only, erased at runtime). Failure paths render
// types and throw through type_display.ts (showT/TypeError_) — a leaf that
// imports this module's shapes type-only, so the runtime edge is one-way
// (unify → type_display).
import {rowOf, tArr, tFun, tTup, TANY} from "../prims.ts";
import {showT, TypeError_} from "./type_display.ts";

export type Type = Prim | ArrT | TupT | FunT | Var | AnyT;

export type NumName = "i32" | "i64" | "u32" | "u64" | "f32" | "f64" | "int" | "float";

export type Prim = { tag: "prim", name: NumName | "string" | "bool" | "unit" | "type" };
// "int" / "float" are the untyped numeric-literal types (produced only by
// num literals): `1` accepts any numeric context and defaults to i64, `1.5`
// any float context and defaults to f64. They are not writable in source.
export const INT_NAMES = new Set<NumName>(["i32", "i64", "u32", "u64"]);
export const FLOAT_NAMES = new Set<NumName>(["f32", "f64"]);
export const NUMERIC_NAMES = new Set<NumName>([...INT_NAMES, ...FLOAT_NAMES, "int", "float"]);

export type ArrT = { tag: "arr", elem: Type };
// Tuples: a fixed-arity record. `name` is null for unnamed fields (`[int, float]`)
// or a label for named fields (`[x: float, y: float]`). Names are structural only
// for field access; unification compares arity + positional types, not names.

export type TupField = { name: string | null, type: Type };

export type TupT = { tag: "tup", fields: TupField[] };
// Effect rows: performed op names plus possibly-unbound effect variables (a
// call to a callee whose row is still unresolved propagates that variable
// into the ambient row, so polymorphic callers stay effect-tracked), with a
// wholly-unbound row standing for row polymorphism. Effect variables unify
// by union-find; a wholly-unbound row unifies with a concrete row by binding
// to it; two concrete rows check by subset — the second row (the value's)
// must be covered by the first row (the context's), with the context's
// variables absorbing the value's unmatched ops. This lets higher-order
// builtins be effect-polymorphic:
// `map : ((a) -> b ! e, [a]) -> [b] ! e` for a fresh `e`.

export type EffVar = { tag: "effvar", id: number };
// The effect row of a function type: performed op names (`ops`) plus
// possibly-unbound effect variables (`vars` — unknown effects riding along,
// e.g. from an unannotated HOF parameter). A wholly-unbound row — `map`'s
// `e` in `((a) -> b ! e, [a]) -> [b] ! e` above — is a row with empty `ops`
// and a single fresh variable in `vars`. Constructed via prims.ts's rowOf
// (a leaf, like tFun — the builtin table and the parser build rows without
// a runtime dependency on this module).

export type Effs = { ops: Set<string>, vars: Set<EffVar> };

export type FunT = { tag: "fun", params: Type[], ret: Type, effs: Effs,
  // Suspension markers discovered during checking — data, not constraints.
  // `contCall`: the FunT is a resume binder's type; invoking it re-enters
  // captured CPS machinery and can suspend (multi-shot). `anyTaint`: an
  // `any` unified into this position (unify is a no-op for `any`, so the
  // row alone cannot vouch for purity). Both force sites typed by this
  // FunT to stay suspending.
  contCall?: true,
  anyTaint?: true,
};
export type Var = { tag: "var", id: number };

export type AnyT = { tag: "any" };

// The numeric width of a resolved type: concrete widths as-is, untyped
// int/float num types lowered to their defaults (int → i64, float → f64 —
// literal defaulting, not width conversion). This is THE backend lowering
// point: stamps.ts and the wasm devirtualizer read widths only through it,
// so untyped num types surviving the checker never leak into codegen.
// null for non-numeric types.

export function widthOf(t: Type): {w: NumName, concrete: boolean} | null {
  if (t.tag !== "prim") return null;
  const n = t.name as NumName;
  if (INT_NAMES.has(n) || FLOAT_NAMES.has(n)) return {w: n, concrete: true};
  if (n === "int") return {w: "i64", concrete: false};
  if (n === "float") return {w: "f64", concrete: false};
  return null;
}

// Unifier: ALL mutable unification state in one object — the type-variable
// union-find, the substitution map `binds`, and the effect-row union-find.
// One instance per checking session, created by `checkProgram` and carried
// across REPL lines inside `Checked`. `Type` values are plain data; the
// unifier is plain data too, and every resolver below is a free function
// over it, so independent `checkProgram` calls (tests!) never share state.
// A function's effect row (`Effs`) lists performed ops;
// unbound effect variables in its `vars` stand for still-unknown effects
// (row polymorphism): a wholly-unbound row unifies with a concrete row by
// binding its variable to it; two concrete rows check by subset — the second
// row (the value's) must be covered by the first row (the context's).
// This lets higher-order builtins be effect-polymorphic:
// `map : ((a) -> b ! e, [a]) -> [b] ! e` for a fresh `e`.

export type Unifier = {
  parent: Map<number, number>,
  n: number,
  binds: Map<number, Type>,
  effParent: Map<number, number>,
  effBinds: Map<number, Effs>,
  // Row variable id → the callee type variable it was forced for (app-case
  // fallback). Lets the lambda's effect-annotation pinning tell parameter-
  // borne variables (pin them) from a recursive self-call's variable (the
  // binding's own unification constrains it afterwards).
  forcedRows: Map<number, number>,
  effCounter: number,
  // Fresh per-literal untyped num prims (uniNewNum). Unifying a num type with
  // a numeric context BINDS the width into the instance itself (uniFlexNum) —
  // every recorded reference to it resolves to the concrete width. Shared
  // singletons (TINT/TFLOAT in builtin signatures) are never in `nums`, so
  // unifying against them never mutates. numLinks records same-kind
  // num-type pairs (op result ↔ operands) whose width is only decided
  // later, resolved to concrete by uniResolveNums at end of check.
  nums: Set<Prim>,
  numLinks: Array<[Prim, Prim]>,
  // Representatives of unbound vars that unified with `any` — the absorbing
  // unification binds nothing, so this set is the only record that such a
  // var's type is `any`. uniContainsAny consults it.
  anyVars: Set<number>,
};

export function newUnifier(): Unifier {
  return {
  parent: new Map<number, number>(), n: 0, binds: new Map<number, Type>(),
  effParent: new Map<number, number>(), effBinds: new Map<number, Effs>(),
  forcedRows: new Map<number, number>(), effCounter: 0,
  nums: new Set<Prim>(), numLinks: [], anyVars: new Set<number>(),
  };
}
export function uniNewNum(u: Unifier, name: "int" | "float"): Prim {
  const p: Prim = {tag: "prim", name};
  u.nums.add(p);
  return p;
}

export function uniFresh(u: Unifier): Var {
  const id = u.n++;
  u.parent.set(id, id);
  return {tag: "var", id};
}
// Bind a num type's width in place (no-op for the shared TINT/TFLOAT
// singletons — they stay context-flexible defaults). The name may itself
// be a num name ("int"/"float"): the mixed-literal case mutates the
// int side to "float", still resolved by resolveNums.

export function uniFlexNum(u: Unifier, num: Prim, name: NumName): void {
  if (u.nums.has(num)) num.name = name;
}
// Link an op-site result num type with an operand num type: whichever
// side resolves a concrete width first (annotation, outer op, defaulting)
// propagates to the other in resolveNums.

export function uniLinkNums(u: Unifier, result: Prim, operand: Prim): void {
  u.numLinks.push([result, operand]);
}
// End-of-check num-type resolution: propagate linked widths to a fixpoint
// (annotation, outer op, or a concrete context decides the shared width).
// No defaulting here: untyped num types ("int"/"float") stay valid through
// checking — the REPL acc keeps them, and per-read copies flex per use.
// Backends lower them to the defaults (int → i64, float → f64) via
// widthOf at every stamp site.

export function uniResolveNums(u: Unifier): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const [r, o] of u.numLinks) {
      const wr = widthOf(r), wo = widthOf(o);
      if (wr === null || wo === null) continue;
      // Only fresh num types are mutable — the shared TINT/TFLOAT
      // singletons keep their context-flexible name, so a link touching
      // one never sets changed (the fixpoint must terminate even when an
      // edge can never fully resolve).
      if (wr.concrete !== wo.concrete) {
        if (wr.concrete && u.nums.has(o) && o.name !== wr.w) { o.name = wr.w; changed = true; }
        else if (!wr.concrete && u.nums.has(r) && r.name !== wo.w) { r.name = wo.w; changed = true; }
        } else if (!wr.concrete && wr.w !== wo.w) {
        // Mixed num kinds across a link (int vs float): the int
        // side flexes to float — the float side may still flex to a
        // concrete f32/f64 in a later round.
        if (wr.w === "i64" && u.nums.has(r) && r.name !== "float") { r.name = "float"; changed = true; }
        else if (wo.w === "i64" && u.nums.has(o) && o.name !== "float") { o.name = "float"; changed = true; }
      }
    }
  }
}
export function uniFreshEff(u: Unifier): EffVar {
  const id = u.effCounter++;
  u.effParent.set(id, id);
  return {tag: "effvar", id};
}
// Union-find find with path compression. An unknown id (possible for
// parser-allocated alias type parameters, which use a separate negative id
// space) is its own root.

export function uniFind(u: Unifier, id: number): number {
  let r = id;
  for (;;) {
    const p = u.parent.get(r);
    if (p === undefined || p === r) break;
    r = p;
  }
  for (;;) {
    const p = u.parent.get(id);
    if (p === undefined || p === r) break;
    u.parent.set(id, r);
    id = p;
  }
  return r;
}
export function uniEffFind(u: Unifier, id: number): number {
  let r = id;
  for (;;) {
    const p = u.effParent.get(r);
    if (p === undefined || p === r) break;
    r = p;
  }
  for (;;) {
    const p = u.effParent.get(id);
    if (p === undefined || p === r) break;
    u.effParent.set(id, r);
    id = p;
  }
  return r;
}
// Resolve a type variable: follow the union-find and any binding.

export function uniRes(u: Unifier, t: Type): Type {
  if (t.tag !== "var")
  return t;
  const r = uniFind(u, t.id);
  const b = u.binds.get(r);
  return b !== undefined ? uniRes(u, b) : {tag: "var", id: r};
}
// Flatten an effect row: resolve every variable member (bound ones inline
// their bound row's members, recursively); unbound ones stay as canonical
// variables. Cycle-guarded: a variable bound to a row containing its own
// root resolves without looping.

export function uniResRow(u: Unifier, e: Effs, seen?: Set<number>, keepCycles = false): Effs {
  const out = rowOf(e.ops);
  const guard = seen ?? new Set<number>();
  for (const v of e.vars) {
    const root = uniEffFind(u, v.id);
    if (guard.has(root)) {
      // A row variable unified with a row containing itself (ρ = {ρ}, the
      // shape recursion produces). The least fixpoint contributes nothing,
      // so semantic consumers collapse it; display keeps the variable —
      // an unconstrained parameter's row shows as a generic row instead
      // of a concrete empty claim.
      if (keepCycles) out.vars.add({tag: "effvar", id: root});
      continue;
    }
    const b = u.effBinds.get(root);
    if (b === undefined) out.vars.add({tag: "effvar", id: root});
    else {
      guard.add(root);
      const rb = uniResRow(u, b, guard, keepCycles);
      for (const op of rb.ops) out.ops.add(op);
      for (const bv of rb.vars) out.vars.add(bv);
      guard.delete(root);
    }
  }
  return out;
}
// Deeply resolve every type/effect variable in `t`. Displayed types
// (`showT`, closure types stamped on lambda nodes) are always deep-resolved,
// so display never needs the unifier.

export function uniDeepRes(u: Unifier, t: Type, nested = false): Type {
  const r = uniRes(u, t);
  if (r.tag === "arr") return tArr(uniDeepRes(u, r.elem, nested));
  if (r.tag === "tup") return tTup(r.fields.map(f => ({name: f.name, type: uniDeepRes(u, f.type, nested)})));
  if (r.tag === "fun")
  return tFun(r.params.map(p => uniDeepRes(u, p, true)), uniDeepRes(u, r.ret, true),
  uniResRow(u, r.effs, undefined, nested),
  r.contCall === true || r.anyTaint === true ? {contCall: r.contCall, anyTaint: r.anyTaint} : undefined);
  return r;
}

// deepRes, plus any-absorbed unbound vars (see anyVars) rendered as `any` —
// the one display form for inferred-`any` types; plain deepRes would show
// such a var as a type-var letter.

export function uniDeepResAny(u: Unifier, t: Type): Type {
  const r = uniRes(u, t);
  if (r.tag === "var") return u.anyVars.has(r.id) ? TANY : r;
  if (r.tag === "arr") return tArr(uniDeepResAny(u, r.elem));
  if (r.tag === "tup") return tTup(r.fields.map(f => ({name: f.name, type: uniDeepResAny(u, f.type)})));
  if (r.tag === "fun")
  return tFun(r.params.map(p => uniDeepResAny(u, p)), uniDeepResAny(u, r.ret),
  uniResRow(u, r.effs),
  r.contCall === true || r.anyTaint === true ? {contCall: r.contCall, anyTaint: r.anyTaint} : undefined);
  return r;
}

// Speculative-unification checkpoint: snapshot the union-find + effect state
// so a homogenization attempt (`[a, b]` as array vs tuple) can be rolled
// back on failure without corrupting the types inferred for the elements.
// ponytail: O(n) per snapshot; fine for literal-sized element lists, not loops.

export function uniCheckpoint(u: Unifier): Snapshot {
  return {
    parent: new Map(u.parent), n: u.n, binds: new Map(u.binds),
    effParent: new Map(u.effParent), effBinds: new Map(u.effBinds),
    effCounter: u.effCounter,
    };
}
export function uniRestore(u: Unifier, s: Snapshot): void {
  u.parent = s.parent; u.n = s.n; u.binds = s.binds;
  u.effParent = s.effParent; u.effBinds = s.effBinds;
  u.effCounter = s.effCounter;
}

// Unify two effect rows. A wholly-unbound row (empty `ops`, one unbound
// `vars` member — a row variable like `map`'s `e`) unifies with a concrete
// row by binding its variable to the whole other row (that row's own
// unbound variables keep riding along); two wholly-unbound rows with
// distinct variables are the SAME unknown and union-find together —
// binding each to the other would be a cycle, and pinning either to ∅
// would drop effects flowing in later. The same variable on both sides (a
// self-call's forced row meeting the binding's own row) falls through to
// the wholesale bind, re-binding the variable to a row containing itself:
// the ρ = {ρ} shape recursion produces — semantically ∅ (resRow collapses
// the cycle), while display and quantification keep the variable.
// Two concrete rows check by subset, not equality: `a` is the context's
// row (an annotation, a callee's parameter row, the first if branch — the
// row every unifyEff consumer propagates onward) and `b` is the value's
// actual row, so `b`'s ops must all be covered by `a`'s ops or `a`'s
// variables. Effect subsumption is contravariant in function position:
// `fn ... ! { E }` checks against `fn ... ! { E, F }` — adding effects to
// the expected row is valid, the reverse is not — and the empty row `∅`
// needs no special case: as the value's row it is simply subsumed by any
// context row, while an effectful value against a `∅`-typed context is a
// genuine mismatch (letting it through would let the value's performed
// effects vanish from every ambient row). When a concrete row
// carries unbound variables, the variables absorb the other side's
// unmatched ops: `! { x, e } ~ ! { x, y }` binds `e := { y }`. This keeps
// unannotated HOF parameters flexible without let-generalization and lets
// polymorphic callers carry their callee's row.

function uniUnifyEff(u: Unifier, a: Effs, b: Effs): void {
  const fa = uniResRow(u, a), fb = uniResRow(u, b);
  if (fa.ops.size === 0 && fa.vars.size === 1 && fb.ops.size === 0 && fb.vars.size === 1) {
    const ra = uniEffFind(u, [...fa.vars][0].id), rb = uniEffFind(u, [...fb.vars][0].id);
    if (ra !== rb) {
      u.effParent.set(ra, rb);
      return;
    }
  }
  if (fa.ops.size === 0 && fa.vars.size === 1) {
    const [va] = fa.vars;
    u.effBinds.set(uniEffFind(u, va.id), b);
    return;
  }
  if (fb.ops.size === 0 && fb.vars.size === 1) {
    const [vb] = fb.vars;
    u.effBinds.set(uniEffFind(u, vb.id), a);
    return;
  }
  const dA = [...fb.ops].filter(op => !fa.ops.has(op)); // ops only B has: A's ops + A's vars must cover
  const dB = [...fa.ops].filter(op => !fb.ops.has(op)); // ops only A has: fine — the context row may exceed the value's
  const showA = () => [...fa.ops, ...[...fa.vars].map(v => `e${v.id}`)].join(", ");
  const showB = () => [...fb.ops, ...[...fb.vars].map(v => `e${v.id}`)].join(", ");
  if (dA.length > 0 && fa.vars.size === 0)
  throw new TypeError_(`effect mismatch: { ${showA()} } ≠ { ${showB()} }`);
  for (const v of fa.vars) u.effBinds.set(uniEffFind(u, v.id), rowOf(dA));
  for (const v of fb.vars) u.effBinds.set(uniEffFind(u, v.id), rowOf(dB));
}

function uniOccurs(u: Unifier, id: number, t: Type): boolean {
  switch (t.tag) {
    case "var": return uniFind(u, t.id) === id;
    case "arr": return uniOccurs(u, id, t.elem);
    case "tup": return t.fields.some(f => uniOccurs(u, id, f.type));
    case "fun": return t.params.some(p => uniOccurs(u, id, p)) || uniOccurs(u, id, t.ret);
    default: return false;
  }
}

function uniBindVar(u: Unifier, id: number, t: Type): void {
  const r = uniFind(u, id);
  if (uniOccurs(u, r, t))
  throw new TypeError_("recursive type");
  u.binds.set(r, t);
}

// True if `t` contains an `any` (the absorbing escape type). Used to warn
// when `any` is *inferred* (e.g. from indexing an `[any]`) rather than
// explicitly written, so silent escapes are visible. `res` is
// applied so bound type variables are resolved before checking.

export function uniContainsAny(u: Unifier, t: Type): boolean {
  const r = uniRes(u, t);
  if (r.tag === "any") return true;
  if (r.tag === "var") return u.anyVars.has(r.id);
  if (r.tag === "arr") return uniContainsAny(u, r.elem);
  if (r.tag === "tup") return r.fields.some(f => uniContainsAny(u, f.type));
  if (r.tag === "fun") return r.params.some(p => uniContainsAny(u, p)) || uniContainsAny(u, r.ret);
  return false;
}

export function uniTypeMismatch(u: Unifier, actual: Type, expected: Type, name?: string): TypeMismatch {
  const a = showT(uniDeepRes(u, actual)), e = showT(uniDeepRes(u, expected));
  const lhs = name !== undefined ? `${name} : ${a}` : `got      : ${a}`;
  return new TypeMismatch(`Type mismatch:\n${lhs}\nexpected : ${e}`);
}

export function uniUnify(u: Unifier, a: Type, b: Type): void {
  const ra = uniRes(u, a), rb = uniRes(u, b);
  if (ra.tag === "any" || rb.tag === "any") {
    // `any` flowing into a function-typed position erases the row evidence
    // at every site typed by that FunT — the marker keeps suspension
    // stamping conservative (stampSuspension reads it).
    if (ra.tag === "fun") ra.anyTaint = true;
    if (rb.tag === "fun") rb.anyTaint = true;
    // The absorbing unification binds no var, so the only record that a
    // var's type is `any` is this set — containsAny reads it.
    if (ra.tag === "var") u.anyVars.add(uniFind(u, ra.id));
    if (rb.tag === "var") u.anyVars.add(uniFind(u, rb.id));
    return;
  }
  if (ra.tag === "var" && rb.tag === "var") {
    u.parent.set(uniFind(u, ra.id), uniFind(u, rb.id));
    return;
  }
  if (ra.tag === "var") { uniBindVar(u, ra.id, rb); return; }
  if (rb.tag === "var") { uniBindVar(u, rb.id, ra); return; }
  if (ra.tag === "prim" && rb.tag === "prim") {
    // Numeric compatibility: untyped literals are num types — `1` accepts
    // any numeric context, `1.5` only float contexts (f32/f64, or the
    // untyped-int side of mixed literal arithmetic). Concrete widths are
    // strict: i32 ~ i64 is a type error, use @as to convert. A num type
    // meeting a context binds that width into its instance in place.
    const an = ra.name as NumName, bn = rb.name as NumName;
    if (an === bn) return;                               // exact: i32 ~ i32, string ~ string, ...
    if (an === "int" && NUMERIC_NAMES.has(bn)) { uniFlexNum(u, ra, bn); return; }   // `1` -> any numeric
    if (bn === "int" && NUMERIC_NAMES.has(an)) { uniFlexNum(u, rb, an); return; }
    if (an === "float" && (bn === "float" || FLOAT_NAMES.has(bn))) { uniFlexNum(u, ra, bn); return; }  // `1.5` -> f32/f64
    if (bn === "float" && (an === "float" || FLOAT_NAMES.has(an))) { uniFlexNum(u, rb, an); return; }
    throw uniTypeMismatch(u, ra, rb);
  }
  if (ra.tag === "arr" && rb.tag === "arr") { uniUnify(u, ra.elem, rb.elem); return; }
  if (ra.tag === "tup" && rb.tag === "tup") {
    if (ra.fields.length !== rb.fields.length)
    throw new TypeError_(`tuple arity ${ra.fields.length} ≠ ${rb.fields.length}`);
    for (let i = 0; i < ra.fields.length; i++) uniUnify(u, ra.fields[i].type, rb.fields[i].type);
    return;
  }
  if (ra.tag === "fun" && rb.tag === "fun") {
    if (ra.params.length !== rb.params.length)
    throw new TypeError_(`arity ${ra.params.length} ≠ ${rb.params.length}`);
    for (let i = 0; i < ra.params.length; i++) uniUnify(u, ra.params[i], rb.params[i]);
    uniUnify(u, ra.ret, rb.ret);
    uniUnifyEff(u, ra.effs, rb.effs);
    return;
  }
  throw uniTypeMismatch(u, ra, rb);
}

// Collect the free type- and effect-variable roots of a type into `tvs`/`evs`.

function uniCollectVars(u: Unifier, t: Type, tvs: Set<number>, evs: Set<number>): void {
  const r = uniRes(u, t);
  if (r.tag === "var") tvs.add(uniFind(u, r.id));
  else if (r.tag === "arr") uniCollectVars(u, r.elem, tvs, evs);
  else if (r.tag === "tup") for (const f of r.fields) uniCollectVars(u, f.type, tvs, evs);
  else if (r.tag === "fun") {
    for (const p of r.params) uniCollectVars(u, p, tvs, evs);
    uniCollectVars(u, r.ret, tvs, evs);
    // keepCycles: a self-referential row variable (ρ = {ρ}, what recursion
    // produces) is collected as quantifiable — collapsing it here would
    // bake the least-fixpoint ∅ into every instance.
    for (const v of uniResRow(u, r.effs, undefined, true).vars)
    evs.add(uniEffFind(u, v.id));
  }
}

// Rebuild `t` substituting the given type/effect var roots with fresh copies.

export function uniCopyScheme(u: Unifier, t: Type, tm: Map<number, Type>, em: Map<number, Effs>): Type {
  const r = uniRes(u, t);
  switch (r.tag) {
    case "var": return tm.get(uniFind(u, r.id)) ?? r;
    case "arr": return tArr(uniCopyScheme(u, r.elem, tm, em));
    case "tup": return tTup(r.fields.map(f => ({name: f.name, type: uniCopyScheme(u, f.type, tm, em)})));
    case "fun":
    return tFun(
    r.params.map(p => uniCopyScheme(u, p, tm, em)),
    uniCopyScheme(u, r.ret, tm, em),
    uniCopyEff(u, r.effs, em),
    r.contCall === true || r.anyTaint === true ? {contCall: r.contCall, anyTaint: r.anyTaint} : undefined,
    );
    default:
    // Num prims (untyped-literal types — the shared TINT/TFLOAT
    // signature singletons and fresh literal num types alike)
    // instantiate fresh per use: the call site flexes its own copy via
    // flexNum without leaking a width into the signature or other
    // sites. Concrete prims are immutable — shared as-is.
    if (r.tag === "prim" && (r.name === "int" || r.name === "float"))
    return uniNewNum(u, r.name);
    return r;
  }
}

function uniCopyEff(u: Unifier, e: Effs, em: Map<number, Effs>): Effs {
  const out = rowOf();
  const rr = uniResRow(u, e, undefined, true);
  for (const op of rr.ops) out.ops.add(op);
  for (const v of rr.vars) {
    const root = uniEffFind(u, v.id);
    const c = em.get(root);
    if (c === undefined) out.vars.add({tag: "effvar", id: root}); // free var stays
    // quantified: the fresh instance (keepCycles — a self-referential
    // instance must not flatten to ∅ here)
    else {
      const rc = uniResRow(u, c, undefined, true);
      for (const op of rc.ops) out.ops.add(op);
      for (const cv of rc.vars) out.vars.add(cv);
    }
  }
  return out;
}

// HM let-generalization: abstract the type/effect vars of `t` that are not
// free in the environment. Returns a concrete `Type` (nothing to generalize)
// or a `Scheme` thunk that instantiates fresh copies per use. Builtins are
// already stored as such thunks; user `let` gets the same treatment.

export function uniGeneralize(u: Unifier, env: Env, t: Type): Type | Scheme {
  const envTvs = new Set<number>();
  const envEvs = new Set<number>();
  for (let e: Env | null = env; e !== null; e = e.parent)
  for (const v of e.vars.values())
  if (typeof v !== "function")
  uniCollectVars(u, v, envTvs, envEvs);
  const tvs = new Set<number>();
  const evs = new Set<number>();
  uniCollectVars(u, t, tvs, evs);
  const gtvs = [...tvs].filter(id => !envTvs.has(id));
  const gevs = [...evs].filter(id => !envEvs.has(id));
  if (gtvs.length === 0 && gevs.length === 0) return uniRes(u, t);
  return () => {
    const tm = new Map<number, Type>();
    const em = new Map<number, Effs>();
    for (const id of gtvs)
    tm.set(id, uniFresh(u));
    for (const id of gevs)
    em.set(id, uniInstanceEff(u, id));
    return uniCopyScheme(u, t, tm, em);
    };
}

// A fresh instance of a quantified row variable. A variable bound to a
// pure self-loop (ρ = {ρ}, what recursion produces) stays self-referential
// in the instance: an unbound copy would read as a genuinely unknown row,
// making every call to a pure recursive function suspending and its type
// display generic. resRow collapses the self-loop for semantic consumers
// and deepRes keeps it for parameter-row display.

function uniInstanceEff(u: Unifier, id: number): Effs {
  const v = uniFreshEff(u);
  const r = rowOf([], [v]);
  const b = u.effBinds.get(id);
  if (b !== undefined && b.ops.size === 0 && b.vars.size > 0 &&
  [...b.vars].every(m => uniEffFind(u, m.id) === id))
  u.effBinds.set(v.id, r);
  return r;
}

// Snapshot of a `Unifier`'s state, for speculative unification (see checkpoint).
type Snapshot = {
  parent: Map<number, number>, n: number,
  binds: Map<number, Type>,
  effParent: Map<number, number>, effBinds: Map<number, Effs>,
  effCounter: number,
};

// A unification failure — kept distinct so the app-call catch can rethrow it
// annotated with the callee's name (typeMismatch).
class TypeMismatch extends TypeError_ {}

type Scheme = () => Type; // polymorphic type scheme, instantiated fresh per use

export type Env = {
  vars: Map<string, Type | Scheme>,
  // Names bound mutable in this frame (`:=` / `: T =` / `[a, b] :=`). Assign
  // resolves against the innermost frame binding the name and requires it here.
  muts: Set<string>,
  parent: Env | null,
  uni: Unifier,
};

export function newEnv(parent: Env | null, uni: Unifier): Env {
  return {vars: new Map<string, Type | Scheme>(), muts: new Set<string>(), parent, uni};
}

export function envLookup(env: Env, name: string): Type | Scheme | undefined {
  let e: Env | null = env.parent;
  if (env.vars.has(name))
    return env.vars.get(name);
  while (e !== null) {
    if (e.vars.has(name))
      return e.vars.get(name);
    e = e.parent;
  }
  return undefined;
}

// Resolved lookup: instantiate scheme thunks and deep-resolve — always a
// concrete, displayable type.

export function envLookupResolved(env: Env, name: string): Type {
  const t = envLookup(env, name)!;
  return uniDeepRes(env.uni, typeof t === "function" ? t() : t);
}

export function envExtend(env: Env): Env {
  return newEnv(env, env.uni);
}

