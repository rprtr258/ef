import type {Expr, ExprID, Program} from "./parser";
import {builtins} from "./builtins.ts";
import {TI32, TI64, TU32, TU64, TF32, TF64, TANY, TBOOL, TFLOAT, TINT, TNULL, TSTR} from "./prims.ts";
import {assertNever} from "./assert.ts";

export type Type = Prim | ArrT | TupT | FunT | Var | AnyT;
export type NumName = "i32" | "i64" | "u32" | "u64" | "f32" | "f64" | "int" | "float";
export type Prim = { tag: "prim", name: NumName | "string" | "bool" | "unit" };
// "int" / "float" are the untyped numeric-literal types (produced only by
// num literals): `1` accepts any numeric context and defaults to i64, `1.5`
// any float context and defaults to f64. They are not writable in source.
export const INT_NAMES = new Set<NumName>(["i32", "i64", "u32", "u64"]);
export const FLOAT_NAMES = new Set<NumName>(["f32", "f64"]);
const NUMERIC_NAMES = new Set<NumName>([...INT_NAMES, ...FLOAT_NAMES, "int", "float"]);
export type ArrT = { tag: "arr", elem: Type };
// Tuples: a fixed-arity record. `name` is null for unnamed fields (`[int, float]`)
// or a label for named fields (`[x: float, y: float]`). Names are structural only
// for field access; unification compares arity + positional types, not names.
export type TupField = { name: string | null, type: Type };
export type TupT = { tag: "tup", fields: TupField[] };
// Effect rows: a concrete `Set<string>` of performed effects, or an
// unbound effect variable (row polymorphism). Effect variables unify by
// union-find; a variable unifies with a concrete set by binding to it; two
// concrete sets unify by equality. This lets higher-order builtins be
// effect-polymorphic: `map : ((a) -> b ! e, [a]) -> [b] ! e` for a fresh `e`.
export type EffVar = { tag: "effvar", id: number };
export type Effs = Set<string> | EffVar;
export type FunT = { tag: "fun", params: Type[], ret: Type, effs: Effs };
export type Var = { tag: "var", id: number };
export type AnyT = { tag: "any" };

export {TI32, TI64, TU32, TU64, TF32, TF64, TINT, TFLOAT, TSTR, TBOOL, TNULL, TANY};

export function tArr(elem: Type): ArrT { return {tag: "arr", elem}; }
export function tTup(fields: TupField[]): TupT { return {tag: "tup", fields}; }
export function tFun(params: Type[], ret: Type, effs: Effs): FunT {
  return {tag: "fun", params, ret, effs};
}

// Effect declaration: parameter types + the type the resumed continuation
// yields. Parser-produced sigs may leave parameters unannotated (`null`) —
// the checker replaces those with fresh variables when registering the
// effect (builtins' sigs are always concrete).
export type EffectSig = {
  params: (Type | null)[],
  ret: Type,
};

// The unifier: ALL mutable unification state in one object — the type-variable
// union-find, the substitution map `binds`, and the effect-row union-find.
// One instance per checking session, created by `checkProgram` and carried
// across REPL lines inside `Checked`. `Type` values are plain data; every
// resolver below is a method, so independent `checkProgram` calls (tests!) never
// share state. Effect rows are a concrete `Set<string>` of performed effects,
// or an unbound effect variable (row polymorphism): a variable unifies with a
// concrete set by binding to it; two concrete sets unify by equality. This
// lets higher-order builtins be effect-polymorphic:
// `map : ((a) -> b ! e, [a]) -> [b] ! e` for a fresh `e`.
export class Unifier {
  parent = new Map<number, number>();
  n = 0;
  binds = new Map<number, Type>();
  effParent = new Map<number, number>();
  effBinds = new Map<number, Set<string>>();
  effCounter = 0;

  fresh(): Var {
    const id = this.n++;
    this.parent.set(id, id);
    return {tag: "var", id};
  }
  freshEff(): EffVar {
    const id = this.effCounter++;
    this.effParent.set(id, id);
    return {tag: "effvar", id};
  }
  // Union-find find with path compression. An unknown id (possible for
  // parser-allocated alias type parameters, which use a separate negative id
  // space) is its own root.
  find(id: number): number {
    let r = id;
    for (;;) {
      const p = this.parent.get(r);
      if (p === undefined || p === r) break;
      r = p;
    }
    for (;;) {
      const p = this.parent.get(id);
      if (p === undefined || p === r) break;
      this.parent.set(id, r);
      id = p;
    }
    return r;
  }
  effFind(id: number): number {
    let r = id;
    for (;;) {
      const p = this.effParent.get(r);
      if (p === undefined || p === r) break;
      r = p;
    }
    for (;;) {
      const p = this.effParent.get(id);
      if (p === undefined || p === r) break;
      this.effParent.set(id, r);
      id = p;
    }
    return r;
  }
  // Resolve a type variable: follow the union-find and any binding.
  res(t: Type): Type {
    if (t.tag !== "var")
      return t;
    const r = this.find(t.id);
    const b = this.binds.get(r);
    return b !== undefined ? this.res(b) : {tag: "var", id: r};
  }
  // Resolve an effect row: follow the union-find; if bound, return the
  // concrete set (sets are always ground). Unbound → the canonical variable.
  resEff(e: Effs): Effs {
    if (e instanceof Set) return e;
    const r = this.effFind(e.id);
    const b = this.effBinds.get(r);
    return b ?? {tag: "effvar", id: r};
  }
  // Deeply resolve every type/effect variable in `t`. Displayed types
  // (`showT`, closure types stamped on lambda nodes) are always deep-resolved,
  // so display never needs the unifier.
  deepRes(t: Type): Type {
    const r = this.res(t);
    if (r.tag === "arr") return tArr(this.deepRes(r.elem));
    if (r.tag === "tup") return tTup(r.fields.map(f => ({name: f.name, type: this.deepRes(f.type)})));
    if (r.tag === "fun")
      return tFun(r.params.map(p => this.deepRes(p)), this.deepRes(r.ret), this.resEff(r.effs));
    return r;
  }

  // Speculative-unification checkpoint: snapshot the union-find + effect state
  // so a homogenization attempt (`[a, b]` as array vs tuple) can be rolled
  // back on failure without corrupting the types inferred for the elements.
  // ponytail: O(n) per snapshot; fine for literal-sized element lists, not loops.
  checkpoint(): Snapshot {
    return {
      parent: new Map(this.parent), n: this.n, binds: new Map(this.binds),
      effParent: new Map(this.effParent), effBinds: new Map(this.effBinds),
      effCounter: this.effCounter,
    };
  }
  restore(s: Snapshot): void {
    this.parent = s.parent; this.n = s.n; this.binds = s.binds;
    this.effParent = s.effParent; this.effBinds = s.effBinds;
    this.effCounter = s.effCounter;
  }

  // Unify two effect rows. var+var union; var+set binds; set+set requires
  // equality — except the empty set `∅` is the polymorphic bottom: a function
  // typed `... ! ∅` performs no effects and may be used wherever *any* effect
  // set is expected (it is refined to the other set). This keeps unannotated
  // HOF parameters flexible without let-generalization.
  unifyEff(a: Effs, b: Effs): void {
    const ra = this.resEff(a), rb = this.resEff(b);
    if (!(ra instanceof Set) && !(rb instanceof Set)) {
      this.effParent.set(this.effFind(ra.id), this.effFind(rb.id));
      return;
    }
    if (!(ra instanceof Set)) { this.effBinds.set(this.effFind(ra.id), rb as Set<string>); return; }
    if (!(rb instanceof Set)) { this.effBinds.set(this.effFind(rb.id), ra); return; }
    if (ra.size === 0) return; // ∅ unifies with anything (refine to rb)
    if (rb.size === 0) return;
    if (ra.size !== rb.size || ![...ra].every(op => rb.has(op)))
      throw new TypeError_(
        `effect mismatch: { ${[...ra].join(", ")} } ≠ { ${[...rb].join(", ")} }`);
  }

  occurs(id: number, t: Type): boolean {
    switch (t.tag) {
      case "var": return this.find(t.id) === id;
      case "arr": return this.occurs(id, t.elem);
      case "tup": return t.fields.some(f => this.occurs(id, f.type));
      case "fun": return t.params.some(p => this.occurs(id, p)) || this.occurs(id, t.ret);
      default: return false;
    }
  }

  bindVar(id: number, t: Type): void {
    const r = this.find(id);
    if (this.occurs(r, t))
      throw new TypeError_("recursive type");
    this.binds.set(r, t);
  }

  // True if `t` contains an `any` (the absorbing escape type). Used to warn
  // when `any` is *inferred* (e.g. from `list(...)` / `head` of an `[any]`)
  // rather than explicitly written, so silent escapes are visible. `res` is
  // applied so bound type variables are resolved before checking.
  containsAny(t: Type): boolean {
    const r = this.res(t);
    if (r.tag === "any") return true;
    if (r.tag === "arr") return this.containsAny(r.elem);
    if (r.tag === "tup") return r.fields.some(f => this.containsAny(f.type));
    if (r.tag === "fun") return r.params.some(p => this.containsAny(p)) || this.containsAny(r.ret);
    return false;
  }

  warnInferredAny(name: string, t: Type): void {
    console.warn(
      `warning: \`${name}\` inferred as \`${showT(this.deepRes(t))}\` (contains \`any\`); ` +
      `add an explicit annotation to silence`,
    );
  }

  typeMismatch(actual: Type, expected: Type, name?: string): TypeMismatch {
    const a = showT(this.deepRes(actual)), e = showT(this.deepRes(expected));
    const lhs = name !== undefined ? `${name} : ${a}` : `got      : ${a}`;
    return new TypeMismatch(`Type mismatch:\n${lhs}\nexpected : ${e}`);
  }

  unify(a: Type, b: Type): void {
    const ra = this.res(a), rb = this.res(b);
    if (ra.tag === "any" || rb.tag === "any") return;
    if (ra.tag === "var" && rb.tag === "var") {
      this.parent.set(this.find(ra.id), this.find(rb.id));
      return;
    }
    if (ra.tag === "var") { this.bindVar(ra.id, rb); return; }
    if (rb.tag === "var") { this.bindVar(rb.id, ra); return; }
    if (ra.tag === "prim" && rb.tag === "prim") {
      // Numeric compatibility: untyped literals are wildcards — `1` accepts
      // any numeric context, `1.5` only float contexts (f32/f64, or the
      // untyped-int side of mixed literal arithmetic). Concrete widths are
      // strict: i32 ~ i64 is a type error, use @as to convert.
      const an = ra.name as NumName, bn = rb.name as NumName;
      if (an === bn) return;                               // exact: i32 ~ i32, string ~ string, ...
      if (an === "int" && NUMERIC_NAMES.has(bn)) return;   // `1` -> any numeric
      if (bn === "int" && NUMERIC_NAMES.has(an)) return;
      if (an === "float" && (bn === "float" || FLOAT_NAMES.has(bn))) return;  // `1.5` -> f32/f64
      if (bn === "float" && (an === "float" || FLOAT_NAMES.has(an))) return;
      throw this.typeMismatch(ra, rb);
    }
    if (ra.tag === "arr" && rb.tag === "arr") { this.unify(ra.elem, rb.elem); return; }
    if (ra.tag === "tup" && rb.tag === "tup") {
      if (ra.fields.length !== rb.fields.length)
        throw new TypeError_(`tuple arity ${ra.fields.length} ≠ ${rb.fields.length}`);
      for (let i = 0; i < ra.fields.length; i++) this.unify(ra.fields[i].type, rb.fields[i].type);
      return;
    }
    if (ra.tag === "fun" && rb.tag === "fun") {
      if (ra.params.length !== rb.params.length)
        throw new TypeError_(`arity ${ra.params.length} ≠ ${rb.params.length}`);
      for (let i = 0; i < ra.params.length; i++) this.unify(ra.params[i], rb.params[i]);
      this.unify(ra.ret, rb.ret);
      this.unifyEff(ra.effs, rb.effs);
      return;
    }
    throw this.typeMismatch(ra, rb);
  }

  // Collect the free type- and effect-variable roots of a type into `tvs`/`evs`.
  collectVars(t: Type, tvs: Set<number>, evs: Set<number>): void {
    const r = this.res(t);
    if (r.tag === "var") tvs.add(this.find(r.id));
    else if (r.tag === "arr") this.collectVars(r.elem, tvs, evs);
    else if (r.tag === "tup") for (const f of r.fields) this.collectVars(f.type, tvs, evs);
    else if (r.tag === "fun") {
      for (const p of r.params) this.collectVars(p, tvs, evs);
      this.collectVars(r.ret, tvs, evs);
      const er = this.resEff(r.effs);
      if (!(er instanceof Set)) evs.add(this.effFind(er.id));
    }
  }

  // Rebuild `t` substituting the given type/effect var roots with fresh copies.
  copyScheme(t: Type, tm: Map<number, Type>, em: Map<number, Effs>): Type {
    const r = this.res(t);
    switch (r.tag) {
      case "var": return tm.get(this.find(r.id)) ?? r;
      case "arr": return tArr(this.copyScheme(r.elem, tm, em));
      case "tup": return tTup(r.fields.map(f => ({name: f.name, type: this.copyScheme(f.type, tm, em)})));
      case "fun":
        return tFun(
          r.params.map(p => this.copyScheme(p, tm, em)),
          this.copyScheme(r.ret, tm, em),
          this.copyEff(r.effs, em),
        );
      default: return r;
    }
  }

  copyEff(e: Effs, em: Map<number, Effs>): Effs {
    const r = this.resEff(e);
    return r instanceof Set ? r : (em.get(this.effFind(r.id)) ?? r);
  }

  // HM let-generalization: abstract the type/effect vars of `t` that are not
  // free in the environment. Returns a concrete `Type` (nothing to generalize)
  // or a `Scheme` thunk that instantiates fresh copies per use. Builtins are
  // already stored as such thunks; user `let` gets the same treatment.
  generalize(env: Env, t: Type): Type | Scheme {
    const envTvs = new Set<number>();
    const envEvs = new Set<number>();
    for (let e: Env | null = env; e !== null; e = e.parent)
      for (const v of e.vars.values())
        if (typeof v !== "function")
          this.collectVars(v, envTvs, envEvs);
    const tvs = new Set<number>();
    const evs = new Set<number>();
    this.collectVars(t, tvs, evs);
    const gtvs = [...tvs].filter(id => !envTvs.has(id));
    const gevs = [...evs].filter(id => !envEvs.has(id));
    if (gtvs.length === 0 && gevs.length === 0) return this.res(t);
    return () => {
      const tm = new Map<number, Type>();
      const em = new Map<number, Effs>();
      for (const id of gtvs)
        tm.set(id, this.fresh());
      for (const id of gevs)
        em.set(id, this.freshEff());
      return this.copyScheme(t, tm, em);
    };
  }
}

// Snapshot of a `Unifier`'s state, for speculative unification (see checkpoint).
type Snapshot = {
  parent: Map<number, number>, n: number,
  binds: Map<number, Type>,
  effParent: Map<number, number>, effBinds: Map<number, Set<string>>,
  effCounter: number,
};

// Format a type for display. Expects a *deep-resolved* type (see
// `Unifier.deepRes`): any variable shown is a genuinely unbound one.
// Type variables display as letters (a, b, ..., z, a1, b1, ...) in order of
// first appearance, so the same variable always prints the same letter.
export function showT(t: Type): string {
  const names = new Map<number, string>();
  const go = (t: Type): string => {
    switch (t.tag) {
      case "prim": return t.name === "int" ? "i64" : t.name === "float" ? "f64" : t.name;
      case "arr": return "[" + go(t.elem) + "]";
      case "tup":
        return "[" + t.fields.map(f =>
          f.name === null ? go(f.type) : f.name + ": " + go(f.type)).join(", ") + "]";
      case "any": return "any";
      case "var": {
        let n = names.get(t.id);
        if (n === undefined) {
          const i = names.size;
          const l = String.fromCharCode(97 + (i % 26));
          n = i < 26 ? l : `${l}${Math.floor(i / 26)}`;
          names.set(t.id, n);
        }
        return n;
      }
      case "fun": {
        const ps = t.params.map(go).join(", ");
        const e = t.effs instanceof Set
          ? (t.effs.size > 0 ? " ! { " + [...t.effs].join(", ") + " }" : "")
          : ` ! { e${t.effs.id} }`;
        return "(" + ps + ") -> " + go(t.ret) + e;
      }
    }
  };
  return go(t);
}

export class TypeError_ extends Error {}
// A unification failure reported as "Type mismatch". Subclassed so `infer`
// can attach the source position of the innermost expression being checked
// when the mismatch surfaced.
class TypeMismatch extends TypeError_ {
  // Non-enumerable so it doesn't leak into error stringification.
  located = false;
  constructor(msg: string) {
    super(msg);
    Object.defineProperty(this, "located", {value: false, enumerable: false, writable: true});
  }
}

type Scheme = () => Type; // polymorphic type scheme, instantiated fresh per use

export class Env {
  vars = new Map<string, Type | Scheme>();
  constructor(public parent: Env | null, public uni: Unifier) {}
  lookup(name: string): Type | Scheme | undefined {
    let e: Env | null = this.parent;
    if (this.vars.has(name))
      return this.vars.get(name);
    while (e !== null) {
      if (e.vars.has(name))
        return e.vars.get(name);
      e = e.parent;
    }
    return undefined;
  }
  // Resolved lookup: instantiate scheme thunks and deep-resolve — always a
  // concrete, displayable type.
  lookupResolved(name: string): Type {
    const t = this.lookup(name)!;
    return this.uni.deepRes(typeof t === "function" ? t() : t);
  }
  extend(): Env {
    return new Env(this, this.uni);
  }
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
  effs: Set<string>,
  effects: Map<string, EffectSig>,
): Type {
  const e = nodes[id];
  if (e.t !== "arr") throw new Error("inferArr: not an array literal");
  if (expected !== null) {
    if (e.elems.length !== expected.fields.length)
      throw new TypeError_(`literal arity ${e.elems.length} ≠ tuple ${expected.fields.length}`);
    for (let i = 0; i < e.elems.length; i++) {
      const ft = expected.fields[i].type;
      const el = e.elems[i];
      // Propagate the tuple expectation into a nested `[...]` literal so that
      // `let m: [[f,f,f],...] = [[1,2,3],...]` builds inner tuples, not arrays.
      const et = (nodes[el].t === "arr" && env.uni.res(ft).tag === "tup")
        ? inferArr(el, nodes, env.uni.res(ft) as TupT, env, effs, effects)
        : infer(el, nodes, env, effs, effects);
      env.uni.unify(et, ft);
    }
    return expected;
  }
  const elemTs = e.elems.map(a => infer(a, nodes, env, effs, effects));
  const snap = env.uni.checkpoint();
  try {
    const elem = env.uni.fresh();
    for (const et of elemTs)
      env.uni.unify(elem, et);
    return tArr(env.uni.res(elem));
  } catch (_) {
    env.uni.restore(snap);
    return tTup(elemTs.map(t => ({name: null, type: env.uni.res(t)})));
  }
}

// Infer `e` expecting a tuple type. Propagates the expectation into array
// literals (so `[1,2,3]` becomes a tuple), blocks (last statement), and
// lambda bodies (return type), so a declared `[f,f,f]` return flows into a
// `[x, y, z]` body literal. Falls back to plain `infer` otherwise.
function inferWith(id: ExprID, nodes: Expr[], expected: Type, env: Env, effs: Set<string>, effects: Map<string, EffectSig>): Type {
  const e = nodes[id];
  const rt = env.uni.res(expected);
  if (rt.tag !== "tup")
    return infer(id, nodes, env, effs, effects);
  if (e.t === "arr")
    return inferArr(id, nodes, rt, env, effs, effects);
  if (e.t === "block") {
    const n = env.extend();
    let last: Type = TNULL;
    for (let i = 0; i < e.stmts.length; i++)
      last = i === e.stmts.length - 1
        ? inferWith(e.stmts[i], nodes, rt, n, effs, effects)
        : infer(e.stmts[i], nodes, n, effs, effects);
    return last;
  }
  if (e.t === "lambda" && e.retTyp !== null) {
    const saved = e.retTyp;
    e.retTyp = rt;
    try { return infer(id, nodes, env, effs, effects); }
    finally { e.retTyp = saved; }
  }
  return infer(id, nodes, env, effs, effects);
}

// Parse a `.N` numeric field name into an index, or null if `name` isn't numeric.
function fieldIndex(name: string): number | null {
  return /^[0-9]+$/.test(name) ? Number(name) : null;
}

// Operators handled by special-casing in `infer` (strict numeric ops /
// same-type
// equality), not via the generic function-application path. `+` is NOT here —
// it is overloaded with string concatenation (see `plusType`).
const NUMOPS = new Set(["-", "*", "/", "%"]);
const CMPOPS = new Set(["<", ">", "<=", ">="]);

// Equality ops require both operands to share a type (untyped literals
// flex, concrete widths are strict); cross-type comparisons like `"a" == 1` are rejected.
const EQOPS = new Set(["==", "!="]);
function isNum(t: Type): t is Prim {
  return t.tag === "prim" && NUMERIC_NAMES.has(t.name as NumName);
}
// `==` / `!=` are special-cased in `infer` (see EQOPS): they are NOT installed
// as ordinary `(any, any) -> bool` function bindings, so they can't be used as
// first-class values and can't silently compare unrelated types.

// Numeric op result under strict same-type arithmetic: untyped literals
// (`int`/`float` names) are wildcards that take the other side's concrete
// width (float literal wins between two wildcards); two distinct concrete
// widths are a type error — @as converts explicitly.
function numericResult(u: Unifier, ra: Type, rb: Type, op: string): Type {
  if (isNum(ra) && rb.tag === "var") { u.unify(rb, ra); return ra; }
  if (isNum(rb) && ra.tag === "var") { u.unify(ra, rb); return rb; }
  if (ra.tag === "var" && rb.tag === "var") { u.unify(ra, rb); return u.res(ra); }
  if (ra.tag === "var") { u.unify(ra, TINT); return TINT; }
  if (rb.tag === "var") { u.unify(rb, TINT); return TINT; }
  if (ra.tag === "prim" && rb.tag === "prim") {
    const na = ra.name as NumName, nb = rb.name as NumName;
    if (na === "int" || na === "float") {
      if (nb === "int" || nb === "float")
        return na === "float" || nb === "float" ? TFLOAT : TINT;
      return rb;                                  // concrete width wins
    }
    if (nb === "int" || nb === "float") return ra;
    if (na === nb) return ra;                     // strict same-width
    throw new TypeError_(`${op}: ${showT(ra)} and ${showT(rb)} are different numeric widths (use @as to convert)`);
  }
  throw new TypeError_(`${op}: ${showT(ra)} and ${showT(rb)} are not numeric`);
}

// Unify two operand types under a numeric op and return the widened result
// (float if either side is float, else int; `any` if either is `any`).
function numeric(u: Unifier, a: Type, b: Type, op: string): Type {
  const ra = u.res(a), rb = u.res(b);
  if (ra.tag === "any" || rb.tag === "any") return TANY;
  return numericResult(u, ra, rb, op);
}

// `+` is overloaded: num+num (strict same-width, untyped literals flex) or
// string+string -> string. Mixed (`"a" + 1`) is a type error. `any` on either
// side stays `any`.
function plusType(u: Unifier, a: Type, b: Type): Type {
  const ra = u.res(a), rb = u.res(b);
  if (ra.tag === "any" || rb.tag === "any") return TANY;
  const sa = isNum(ra), sb = isNum(rb);
  if (sa && sb) return numericResult(u, ra, rb, "+");
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

// infer: returns the type, side-effecting `effs` with performed effects.
// `id` indexes into the program's flat node slice `nodes`. Every node whose
// type resolves to f32 is stamped `f32` — the evaluator and the wasm backend
// round such nodes' values to f32 precision, so f32 arithmetic never observes
// a wider intermediate.
function infer(
  id: ExprID,
  nodes: Expr[],
  env: Env,
  effs: Set<string>,
  effects: Map<string, EffectSig>,
): Type {
  const t = inferNode(id, nodes, env, effs, effects);
  if (t.tag === "prim" && t.name === "f32") (nodes[id] as Expr & {f32?: true}).f32 = true;
  return t;
}

function inferNode(
  id: ExprID,
  nodes: Expr[],
  env: Env,
  effs: Set<string>,
  effects: Map<string, EffectSig>,
): Type {
  const e = nodes[id];
  try {
  switch (e.t) {
    case "num": return e.isFloat ? TFLOAT : TINT;
    case "str": return TSTR;
    case "bool": return TBOOL;
    case "unit": return TNULL;
    case "sym": {
      const s = env.lookup(e.v);
      if (s === undefined)
        throw new TypeError_("Unbound: " + e.v);
      return typeof s === "function" ? s() : s;
    }
    case "lambda": {
      const n = env.extend();
      const ps: Type[] = [];
      for (const p of e.params) {
        const pt = p.typ ?? env.uni.fresh();
        n.vars.set(p.name, pt);
        ps.push(pt);
      }
      const innerEffs = new Set<string>();
      const ret = e.retTyp !== null && env.uni.res(e.retTyp).tag === "tup"
        ? inferWith(e.body, nodes, e.retTyp, n, innerEffs, effects)
        : infer(e.body, nodes, n, innerEffs, effects);
      if (e.retTyp !== null)
        env.uni.unify(e.retTyp, ret);
      // Effect annotation is optional: if `! { ... }` is omitted, the
      // function's effect set is derived from the body's performed effects.
      // If present, it must be a superset of the body's effects.
      if (e.retEffs !== null) {
        const decl = e.retEffs.size > 0 ? [...e.retEffs].join(", ") : "∅";
        for (const op of innerEffs)
          if (!e.retEffs.has(op))
            throw new TypeError_(`effect ${op} not declared in signature (declared: ${decl})`);
      }
      const ft = tFun(ps, e.retTyp ?? ret, e.retEffs ?? innerEffs);
      e.typ = ft;
      return ft;
    }
    case "let": {
      // Recursive binding: the name is in scope in its own value, so
      // `let f = fn(...){...}` can call itself.
      const declared = e.typ ?? env.uni.fresh();
      env.vars.set(e.name, declared);
      // A tuple annotation on an `[...]` literal makes it a tuple even when its
      // elements would otherwise unify homogeneously (e.g. `let p: [float, float] = [1.0, 2.0]`).
      const vt = (e.typ !== null && env.uni.res(e.typ).tag === "tup" && nodes[e.val].t === "arr")
        ? inferArr(e.val, nodes, env.uni.res(e.typ) as TupT, env, effs, effects)
        : infer(e.val, nodes, env, effs, effects);
      env.uni.unify(declared, vt);
      const rt = env.uni.res(declared);
      // The lambda's stamped type is final: its parameter variables have been
      // bound (or not), so deep-resolve it — display never needs the unifier.
      const lam = nodes[e.val];
      if (lam.t === "lambda" && lam.typ !== undefined)
        lam.typ = env.uni.deepRes(lam.typ) as FunT;
      // Exclude the self-binding from the free-var context before
      // generalizing (otherwise its own vars read as free-in-env → no-op).
      env.vars.delete(e.name);
      // Value restriction: generalize only lambda values (literals carry no
      // type vars; `arr` literals are typed directly, not via `list`).
      // This keeps mutable-array/assign soundness (no `let x = []` : [a]).
      env.vars.set(e.name, e.typ !== null ? rt : (nodes[e.val].t === "lambda" ? env.uni.generalize(env, rt) : rt));
      if (e.typ === null && env.uni.containsAny(rt))
        env.uni.warnInferredAny(e.name, rt);
      return TNULL;
    }
    case "arr":
      return inferArr(id, nodes, null, env, effs, effects);
    // `@as(expr, T)`: the one explicit numeric cast. Numeric widths only;
    // float -> int truncates toward zero, bool -> numeric gives 0/1, and
    // everything else is value-preserving (an f32 target rounds via the
    // node's generic f32 stamp; i32 -> i64 and f32 -> f64 are no-ops).
    case "as": {
      const at = env.uni.res(infer(e.e, nodes, env, effs, effects));
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
      const ot = env.uni.res(infer(e.obj, nodes, env, effs, effects));
      if (ot.tag === "arr") {
        const idx = fieldIndex(e.name);
        if (idx === null)
          throw new TypeError_(`arrays use .N indexing, not .${e.name}`);
        e.idx = idx;
        return ot.elem;
      }
      if (ot.tag === "tup") {
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
    // `let [a, b] = val;` — destructure a tuple (or array) into bindings.
    case "dlet": {
      const vt = env.uni.res(infer(e.val, nodes, env, effs, effects));
      if (vt.tag === "tup") {
        if (vt.fields.length !== e.fields.length)
          throw new TypeError_(`destructure arity ${e.fields.length} ≠ tuple ${vt.fields.length}`);
        for (let i = 0; i < e.fields.length; i++) {
          const ft = e.fields[i].typ;
          if (ft !== null)
            env.uni.unify(ft, vt.fields[i].type);
          env.vars.set(e.fields[i].name, ft ?? vt.fields[i].type);
        }
      } else if (vt.tag === "arr") {
        for (const f of e.fields) {
          if (f.typ !== null)
            env.uni.unify(f.typ, vt.elem);
          env.vars.set(f.name, f.typ ?? vt.elem);
        }
      } else {
        throw new TypeError_(`cannot destructure non-record type: ${showT(vt)}`);
      }
      return TNULL;
    }
    case "if": {
      const c = infer(e.c, nodes, env, effs, effects);
      env.uni.unify(c, TBOOL);
      const a = infer(e.a, nodes, env, effs, effects);
      const b = infer(e.b, nodes, env, effs, effects);
      env.uni.unify(a, b);
      return env.uni.res(a);
    }
    case "while": {
      const c = infer(e.c, nodes, env, effs, effects);
      env.uni.unify(c, TBOOL);
      infer(e.body, nodes, env, effs, effects);
      return TNULL;
    }
    case "assign": {
      const cur = env.lookup(e.name);
      if (cur === undefined) throw new TypeError_(`Assignment to unbound symbol: ${e.name}`);
      const vt = infer(e.val, nodes, env, effs, effects);
      // Unify against the declared type so `let guess: float` keeps its type.
      env.uni.unify(typeof cur === "function" ? cur() : cur, vt);
      return TNULL;
    }
    case "block": {
      const n = env.extend();
      let last: Type = TNULL;
      for (const s of e.stmts) last = infer(s, nodes, n, effs, effects);
      return last;
    }
    case "perform": {
      const sig = effects.get(e.op);
      if (sig === undefined)
        throw new TypeError_(`Unknown effect: ${e.op} (declare with: effect ${e.op}(...);)`);
      if (e.args.length !== sig.params.length)
        throw new TypeError_(`effect ${e.op}: ${sig.params.length} args, got ${e.args.length}`);
      const argTs = e.args.map(a => infer(a, nodes, env, effs, effects));
      for (let i = 0; i < sig.params.length; i++) env.uni.unify(sig.params[i] ?? TANY, argTs[i]);
      effs.add(e.op);
      return sig.ret;
    }
    case "handle": {
      const bodyEffs = new Set<string>();
      const bodyT = infer(e.body, nodes, env, bodyEffs, effects);
      let resultT: Type | null = null;
      for (const c of e.cases) {
        const n = env.extend();
        const sig = effects.get(c.op);
        if (sig === undefined && c.op !== "Return")
          throw new TypeError_(`Handler for unknown effect: ${c.op}`);
        if (c.op === "Return") {
          n.vars.set(c.params[0].name, env.uni.res(bodyT));
        } else {
          for (let i = 0; i < c.params.length; i++) {
            n.vars.set(c.params[i].name, sig!.params[i] ?? TANY);
          }
        }
        // resume: (sig.ret) -> resultT ; Return's resume is identity over bodyT
        const resumeT = c.op === "Return"
          ? tFun([env.uni.res(bodyT)], env.uni.fresh(), new Set())
          : tFun([sig!.ret], env.uni.fresh(), new Set());
        n.vars.set(c.resume, resumeT);
        // Case bodies run outside this handler (its perform's continuation
        // resumes past it), so their performed effects forward to the
        // ambient row — an op they perform unhandled must remain tracked
        // (a fresh set here would let effects escape untracked).
        const ct = infer(c.body, nodes, n, effs, effects);
        if (resultT === null)
          resultT = ct;
        else
          env.uni.unify(resultT, ct);
        env.uni.unify(resumeT.ret, ct);
      }
      for (const c of e.cases) bodyEffs.delete(c.op);
      for (const op of bodyEffs) effs.add(op);
      return resultT ?? TNULL;
    }
    case "app": {
      const fn = nodes[e.fn];
      // Array literals desugar to list(...); type as homogeneous [T].
      if (fn.t === "sym" && fn.v === "list") {
        const elem = env.uni.fresh();
        for (const a of e.args) env.uni.unify(elem, infer(a, nodes, env, effs, effects));
        return tArr(env.uni.res(elem));
      }
      // `+` is overloaded: strict numeric arithmetic or string concatenation.
      if (fn.t === "sym" && fn.v === "+") {
        const at = infer(e.args[0], nodes, env, effs, effects);
        const bt = infer(e.args[1], nodes, env, effs, effects);
        return plusType(env.uni, at, bt);
      }
      // Numeric operators (- * / %) and comparisons (< > <= >=) widen int/float;
      // unary neg is handled below. Kept out of BINOPS so they get this logic.
      if (fn.t === "sym" && (NUMOPS.has(fn.v) || CMPOPS.has(fn.v))) {
        const at = infer(e.args[0], nodes, env, effs, effects);
        const bt = infer(e.args[1], nodes, env, effs, effects);
        const widened = numeric(env.uni, at, bt, fn.v);
        if (CMPOPS.has(fn.v)) return TBOOL;
        // `/` is type-preserving: int/int -> int (truncated at runtime),
        // float/float -> float, and any-operand -> float (don't truncate
        // unknowns). The checker stamps which division this is on the node so
        // the evaluator (which sees untyped JS numbers) knows whether to truncate.
        if (fn.v === "/") {
          // Division mode from the (strict) operand type: an untyped-literal
          // or int-width result divides as integers, everything else as float.
          const rw = env.uni.res(widened);
          e.div = rw.tag === "prim" && (INT_NAMES.has(rw.name as NumName) || rw.name === "int") ? "int" : "float";
          return widened;
        }
        return widened;
      }
      if (fn.t === "sym" && fn.v === "neg") {
        const at = infer(e.args[0], nodes, env, effs, effects);
        return numeric(env.uni, at, at, "neg");
      }
      // Equality: both operands must share a type (untyped literals flex,
      // concrete widths are strict — `i32 == i64` is an error). Cross-type
      // (`"a" == 1`) is a type error.
      if (fn.t === "sym" && EQOPS.has(fn.v)) {
        const at = infer(e.args[0], nodes, env, effs, effects);
        const bt = infer(e.args[1], nodes, env, effs, effects);
        env.uni.unify(at, bt);
        return TBOOL;
      }
      const ft = infer(e.fn, nodes, env, effs, effects);
      const fr = env.uni.res(ft);
      // When the callee is a known function, an `[...]` literal argument
      // passed against a tuple parameter type is inferred as that tuple
      // (mirroring the `let : [..] = [...]` special case).
      const argTs = e.args.map((a, i) => {
        if (nodes[a].t === "arr" && fr.tag === "fun" && i < fr.params.length && env.uni.res(fr.params[i]).tag === "tup")
          return inferArr(a, nodes, env.uni.res(fr.params[i]) as TupT, env, effs, effects);
        return infer(a, nodes, env, effs, effects);
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
        // Whatever the callee's row resolves to now is what the call performs.
        const er = env.uni.resEff(fr.effs);
        if (er instanceof Set) for (const op of er) effs.add(op);
        return env.uni.res(ret);
      }
      if (fr.tag === "any") return TANY;
      const expected = tFun(argTs, ret, new Set());
      try { env.uni.unify(ft, expected); }
      catch (err) {
        if (err instanceof TypeError_ && fn.t === "sym")
          throw env.uni.typeMismatch(ft, expected, fn.v);
        throw err;
      }
      return env.uni.res(ret);
    }
    default:
      return assertNever(e);
  }
  } catch (err) {
    // Annotate the innermost type mismatch with the position of the
    // expression being inferred when unification failed. The first (deepest)
    // frame to catch wins; outer frames see `located` set and skip.
    if (err instanceof TypeMismatch && !err.located && e.pos !== undefined) {
      err.located = true;
      err.message = `at line ${e.pos.line}, col ${e.pos.col}: ` + err.message;
    }
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
    const bb = builtins;
    effects = new Map<string, EffectSig>(bb.filter(b => b.kind === "effect").map(b => [b.name, b.sig]));
    env = new Env(null, uni);
    for (const b of bb) {
      if (b.kind !== "effect") {
        const bt = b.t;
        env.vars.set(b.name, typeof bt === "function" ? () => bt(uni) : bt);
      }
    }
  }

  for (const it of prog.items.filter(it => "effect" in it))
    effects.set(it.effect, {params: it.sig.params.map(t => t ?? uni.fresh()), ret: it.sig.ret});

  let lastType: Type = TNULL;
  // One shared sink for all items: infer only ever ADDS residuals to the
  // ambient set (handler matching happens in each handle's local bodyEffs
  // before forwarding), so a program-wide unhandled-op set falls out.
  const unhandled = new Set<string>();
  for (const it of prog.items.filter(it => "e" in it))
    lastType = infer(it.e, prog.nodes, env, unhandled, effects);

  return {env, effects, uni, lastType: uni.deepRes(lastType), unhandled};
}
