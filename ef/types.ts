import type {Expr, Item} from "./parser";

export type Type = Prim | ArrT | TupT | FunT | Var | AnyT;
export type Prim = { tag: "prim", name: "int" | "float" | "string" | "bool" | "unit" };
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

export const TINT: Prim = {tag: "prim", name: "int"};
export const TFLOAT: Prim = {tag: "prim", name: "float"};
export const TSTR: Prim = {tag: "prim", name: "string"};
export const TBOOL: Prim = {tag: "prim", name: "bool"};
export const TNULL: Prim = {tag: "prim", name: "unit"};
export const TANY: AnyT = {tag: "any"};

export function tArr(elem: Type): ArrT { return {tag: "arr", elem}; }
export function tTup(fields: TupField[]): TupT { return {tag: "tup", fields}; }
export function tFun(params: Type[], ret: Type, effs: Effs): FunT {
  return {tag: "fun", params, ret, effs};
}

// Effect declaration: parameter types + the type the resumed continuation yields.
export type EffectSig = {
  params: Type[],
  ret: Type,
};

// Union-find over type variables; substitution stored in `binds`.
class Uni {
  parent = new Map<number, number>();
  n = 0;
  fresh(): Var {
    const id = this.n++;
    this.parent.set(id, id);
    return {tag: "var", id};
  }
  find(id: number): number {
    let r = id;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    while (this.parent.get(id) !== r) {
      const nx = this.parent.get(id)!;
      this.parent.set(id, r);
      id = nx;
    }
    return r;
  }
}
const uni = new Uni();
const binds = new Map<number, Type>();

export function res(t: Type): Type {
  if (t.tag !== "var")
    return t;
  const r = uni.find(t.id);
  const b = binds.get(r);
  return b !== undefined ? res(b) : {tag: "var", id: r};
}

export function showT(t: Type): string {
  switch (t.tag) {
    case "prim": return t.name;
    case "arr": return "[" + showT(t.elem) + "]";
    case "tup":
      return "[" + t.fields.map(f =>
        f.name === null ? showT(f.type) : f.name + ": " + showT(f.type)).join(", ") + "]";
    case "any": return "any";
    case "var": {
      const r = res(t);
      return r.tag === "var" ? "t" + r.id : showT(r);
    }
    case "fun": {
      const ps = t.params.map(showT).join(", ");
      const er = resEff(t.effs);
      const e = er instanceof Set
        ? (er.size > 0 ? " ! { " + [...er].join(", ") + " }" : "")
        : " ! { e" + er.id + " }";
      return "(" + ps + ") -> " + showT(t.ret) + e;
    }
  }
}

// --- Effect variables (row polymorphism) ---
// Separate union-find from type variables: effect rows resolve to `Set<string>`
// (or stay unbound variables), not to `Type`s.
let effCounter = 0;
const effParent = new Map<number, number>();
const effBinds = new Map<number, Set<string>>();
function freshEff(): EffVar {
  const id = effCounter++;
  effParent.set(id, id);
  return {tag: "effvar", id};
}
function effFind(id: number): number {
  let r = id;
  while (effParent.get(r) !== r) r = effParent.get(r)!;
  let c = id;
  while (effParent.get(c) !== r) {
    const nx = effParent.get(c)!;
    effParent.set(c, r);
    c = nx;
  }
  return r;
}
// Resolve an effect row: follow the union-find; if bound, return the concrete
// set (and further resolve any set-of... sets are always ground). Unbound →
// the canonical variable.
function resEff(e: Effs): Effs {
  if (e instanceof Set) return e;
  const r = effFind(e.id);
  const b = effBinds.get(r);
  return b ?? {tag: "effvar", id: r};
}

export function freshVar(): Var { return uni.fresh(); }

// Speculative-unification checkpoint: snapshot the union-find + effect state so
// a homogenization attempt (`[a, b]` as array vs tuple) can be rolled back on
// failure without corrupting the types inferred for the elements themselves.
// ponytail: O(n) per snapshot; fine for literal-sized element lists, not loops.
type Snapshot = {
  parent: Map<number, number>, n: number,
  binds: Map<number, Type>,
  effParent: Map<number, number>, effBinds: Map<number, Set<string>>,
  effCounter: number,
};
function checkpoint(): Snapshot {
  return {
    parent: new Map(uni.parent), n: uni.n,
    binds: new Map(binds),
    effParent: new Map(effParent), effBinds: new Map(effBinds),
    effCounter,
  };
}
function restore(s: Snapshot): void {
  uni.parent = s.parent; uni.n = s.n;
  binds.clear(); for (const [k, v] of s.binds) binds.set(k, v);
  effParent.clear(); for (const [k, v] of s.effParent) effParent.set(k, v);
  effBinds.clear(); for (const [k, v] of s.effBinds) effBinds.set(k, v);
  effCounter = s.effCounter;
}

// Unify two effect rows. var+var union; var+set binds; set+set requires
// equality — except the empty set `∅` is the polymorphic bottom: a function
// typed `... ! ∅` performs no effects and may be used wherever *any* effect
// set is expected (it is refined to the other set). This keeps unannotated
// HOF parameters flexible without let-generalization.
function unifyEff(a: Effs, b: Effs): void {
  const ra = resEff(a), rb = resEff(b);
  if (!(ra instanceof Set) && !(rb instanceof Set)) {
    effParent.set(effFind(ra.id), effFind(rb.id));
    return;
  }
  if (!(ra instanceof Set)) { effBinds.set(effFind(ra.id), rb as Set<string>); return; }
  if (!(rb instanceof Set)) { effBinds.set(effFind(rb.id), ra); return; }
  if (ra.size === 0) return; // ∅ unifies with anything (refine to rb)
  if (rb.size === 0) return;
  if (ra.size !== rb.size || ![...ra].every(op => rb.has(op)))
    throw new TypeError_(
      `effect mismatch: { ${[...ra].join(", ")} } ≠ { ${[...rb].join(", ")} }`);
}

function occurs(id: number, t: Type): boolean {
  switch (t.tag) {
    case "var": return uni.find(t.id) === id;
    case "arr": return occurs(id, t.elem);
    case "tup": return t.fields.some(f => occurs(id, f.type));
    case "fun": return t.params.some(p => occurs(id, p)) || occurs(id, t.ret);
    default: return false;
  }
}

function bindVar(id: number, t: Type): void {
  const r = uni.find(id);
  if (occurs(r, t))
    throw new TypeError_("recursive type");
  binds.set(r, t);
}

// True if `t` contains an `any` (the absorbing escape type). Used to warn when
// `any` is *inferred* (e.g. from `list(...)` / `head` of an `[any]`) rather than
// explicitly written, so silent escapes are visible. `res` is applied so bound
// type variables are resolved before checking.
function containsAny(t: Type): boolean {
  const r = res(t);
  if (r.tag === "any") return true;
  if (r.tag === "arr") return containsAny(r.elem);
  if (r.tag === "tup") return r.fields.some(f => containsAny(f.type));
  if (r.tag === "fun") return r.params.some(containsAny) || containsAny(r.ret);
  return false;
}

function warnInferredAny(name: string, t: Type): void {
  console.warn(
    `warning: \`${name}\` inferred as \`${showT(res(t))}\` (contains \`any\`); ` +
    `add an explicit annotation to silence`,
  );
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

// Format a unification failure as a multi-line "Type mismatch" report. When
// `name` is supplied (e.g. the callee in a non-function call) the actual type
// is labelled with it, otherwise it is shown as `got`.
function typeMismatch(actual: Type, expected: Type, name?: string): TypeMismatch {
  const a = showT(res(actual)), e = showT(res(expected));
  const lhs = name ? `${name} : ${a}` : `got      : ${a}`;
  return new TypeMismatch(`Type mismatch:\n${lhs}\nexpected : ${e}`);
}

export function unify(a: Type, b: Type): void {
  const ra = res(a), rb = res(b);
  if (ra.tag === "any" || rb.tag === "any") return;
  if (ra.tag === "var" && rb.tag === "var") {
    uni.parent.set(uni.find(ra.id), uni.find(rb.id));
    return;
  }
  if (ra.tag === "var") { bindVar(ra.id, rb); return; }
  if (rb.tag === "var") { bindVar(rb.id, ra); return; }
  if (ra.tag === "prim" && rb.tag === "prim") {
    // int and float are compatible: numeric widening lets an int flow where a
    // float is expected and vice versa (value kept at runtime either way).
    const nums = new Set(["int", "float"]);
    if (ra.name !== rb.name && !(nums.has(ra.name) && nums.has(rb.name)))
      throw typeMismatch(ra, rb);
    return;
  }
  if (ra.tag === "arr" && rb.tag === "arr") { unify(ra.elem, rb.elem); return; }
  if (ra.tag === "tup" && rb.tag === "tup") {
    if (ra.fields.length !== rb.fields.length)
      throw new TypeError_(`tuple arity ${ra.fields.length} ≠ ${rb.fields.length}`);
    for (let i = 0; i < ra.fields.length; i++) unify(ra.fields[i].type, rb.fields[i].type);
    return;
  }
  if (ra.tag === "fun" && rb.tag === "fun") {
    if (ra.params.length !== rb.params.length)
      throw new TypeError_(`arity ${ra.params.length} ≠ ${rb.params.length}`);
    for (let i = 0; i < ra.params.length; i++) unify(ra.params[i], rb.params[i]);
    unify(ra.ret, rb.ret);
    unifyEff(ra.effs, rb.effs);
    return;
  }
  throw typeMismatch(ra, rb);
}

type Scheme = () => Type; // polymorphic type scheme, instantiated fresh per use

// Collect the free type- and effect-variable roots of a type into `tvs`/`evs`.
function collectVars(t: Type, tvs: Set<number>, evs: Set<number>): void {
  const r = res(t);
  if (r.tag === "var") tvs.add(uni.find(r.id));
  else if (r.tag === "arr") collectVars(r.elem, tvs, evs);
  else if (r.tag === "tup") for (const f of r.fields) collectVars(f.type, tvs, evs);
  else if (r.tag === "fun") {
    for (const p of r.params) collectVars(p, tvs, evs);
    collectVars(r.ret, tvs, evs);
    const er = resEff(r.effs);
    if (!(er instanceof Set)) evs.add(effFind(er.id));
  }
}

// Rebuild `t` substituting the given type/effect var roots with fresh copies.
function copyScheme(t: Type, tm: Map<number, Type>, em: Map<number, Effs>): Type {
  const r = res(t);
  switch (r.tag) {
    case "var": return tm.get(uni.find(r.id)) ?? r;
    case "arr": return tArr(copyScheme(r.elem, tm, em));
    case "tup": return tTup(r.fields.map(f => ({name: f.name, type: copyScheme(f.type, tm, em)})));
    case "fun":
      return tFun(
        r.params.map(p => copyScheme(p, tm, em)),
        copyScheme(r.ret, tm, em),
        copyEff(r.effs, em),
      );
    default: return r;
  }
}

function copyEff(e: Effs, em: Map<number, Effs>): Effs {
  const r = resEff(e);
  return r instanceof Set ? r : (em.get(effFind(r.id)) ?? r);
}

// A top-level program item: an expression, an effect declaration, or a
// parametric type alias (`type Pair(a, b) = [a, b];`). Aliases are resolved at
// parse time by substituting type args into the body.
export type Alias = { name: string, tparams: Map<string, Var>, body: Type };

// Instantiate a parametric type alias by substituting its type-parameter vars
// with the given argument types (fresh vars for any missing/trailing args).
// ponytail: no recursion guard — recursive aliases (`type T = [T]`) stack-loop;
// add a depth cap if recursive aliases become needed.
export function instantiateAlias(al: Alias, args: Type[]): Type {
  const tm = new Map<number, Type>();
  let i = 0;
  for (const [, v] of al.tparams) tm.set(uni.find(v.id), args[i++] ?? freshVar());
  return copyScheme(al.body, tm, new Map());
}

// HM let-generalization: abstract the type/effect vars of `t` that are not
// free in the environment. Returns a concrete `Type` (nothing to generalize)
// or a `Scheme` thunk that instantiates fresh copies per use. Builtins are
// already stored as such thunks; user `let` now gets the same treatment.
function generalize(env: Env, t: Type): Type | Scheme {
  const envTvs = new Set<number>();
  const envEvs = new Set<number>();
  for (let e: Env | null = env; e !== null; e = e.parent)
    for (const v of e.vars.values())
      if (typeof v !== "function")
        collectVars(v, envTvs, envEvs);
  const tvs = new Set<number>();
  const evs = new Set<number>();
  collectVars(t, tvs, evs);
  const gtvs = [...tvs].filter(id => !envTvs.has(id));
  const gevs = [...evs].filter(id => !envEvs.has(id));
  if (gtvs.length === 0 && gevs.length === 0) return res(t);
  return () => {
    const tm = new Map<number, Type>();
    const em = new Map<number, Effs>();
    for (const id of gtvs)
      tm.set(id, freshVar());
    for (const id of gevs)
      em.set(id, freshEff());
    return copyScheme(t, tm, em);
  };
}

export class Env {
  vars = new Map<string, Type | Scheme>();
  constructor(public parent: Env | null) {}
  lookup(name: string): Type | Scheme | undefined {
    let e: Env | null = this;
    while (e !== null) {
      if (e.vars.has(name))
        return e.vars.get(name);
      e = e.parent;
    }
    return undefined;
  }
  extend(): Env {
    return new Env(this);
  }
}

// Infer an `[...]` literal. With an `expected` tuple, elements are checked
// against the tuple's field types (named-tuple construction). Without one,
// attempt homogeneous unification behind a checkpoint; on failure build a
// tuple from the (preserved) element types.
function inferArr(
  e: Expr & {t: "arr"},
  expected: TupT | null,
  env: Env,
  effs: Set<string>,
  effects: Map<string, EffectSig>,
): Type {
  if (expected !== null) {
    if (e.elems.length !== expected.fields.length)
      throw new TypeError_(`literal arity ${e.elems.length} ≠ tuple ${expected.fields.length}`);
    for (let i = 0; i < e.elems.length; i++) {
      const ft = expected.fields[i].type;
      const el = e.elems[i];
      // Propagate the tuple expectation into a nested `[...]` literal so that
      // `let m: [[f,f,f],...] = [[1,2,3],...]` builds inner tuples, not arrays.
      const et = (el.t === "arr" && res(ft).tag === "tup")
        ? inferArr(el, res(ft) as TupT, env, effs, effects)
        : infer(el, env, effs, effects);
      unify(et, ft);
    }
    return expected;
  }
  const elemTs = e.elems.map(a => infer(a, env, effs, effects));
  const snap = checkpoint();
  try {
    const elem = freshVar();
    for (const et of elemTs)
      unify(elem, et);
    return tArr(res(elem));
  } catch (_) {
    restore(snap);
    return tTup(elemTs.map(t => ({name: null, type: res(t)})));
  }
}

// Infer `e` expecting a tuple type. Propagates the expectation into array
// literals (so `[1,2,3]` becomes a tuple), blocks (last statement), and
// lambda bodies (return type), so a declared `[f,f,f]` return flows into a
// `[x, y, z]` body literal. Falls back to plain `infer` otherwise.
function inferWith(e: Expr, expected: Type, env: Env, effs: Set<string>, effects: Map<string, EffectSig>): Type {
  const rt = res(expected);
  if (rt.tag !== "tup")
    return infer(e, env, effs, effects);
  if (e.t === "arr")
    return inferArr(e, rt, env, effs, effects);
  if (e.t === "block") {
    const n = env.extend();
    let last: Type = TNULL;
    for (let i = 0; i < e.stmts.length; i++)
      last = i === e.stmts.length - 1
        ? inferWith(e.stmts[i], rt, n, effs, effects)
        : infer(e.stmts[i], n, effs, effects);
    return last;
  }
  if (e.t === "lambda" && e.retTyp !== null) {
    const saved = e.retTyp;
    e.retTyp = rt;
    try { return infer(e, env, effs, effects); }
    finally { e.retTyp = saved; }
  }
  return infer(e, env, effs, effects);
}

// Parse a `.N` numeric field name into an index, or null if `name` isn't numeric.
function fieldIndex(name: string): number | null {
  return /^[0-9]+$/.test(name) ? Number(name) : null;
}

// Operators handled by special-casing in `infer` (numeric widening / same-type
// equality), not via the generic function-application path. `+` is NOT here —
// it is overloaded with string concatenation (see `plusType`).
const NUMOPS = new Set(["-", "*", "/", "%"]);
const CMPOPS = new Set(["<", ">", "<=", ">="]);

// Equality ops require both operands to share a type (numeric widening still
// lets `int ~ float`); cross-type comparisons like `"a" == 1` are rejected.
const EQOPS = new Set(["==", "!="]);
function isNum(t: Type): t is Prim {
  return t.tag === "prim" && (t.name === "int" || t.name === "float");
}
// `==` / `!=` are special-cased in `infer` (see EQOPS): they are NOT installed
// as ordinary `(any, any) -> bool` function bindings, so they can't be used as
// first-class values and can't silently compare unrelated types.

// Unify two operand types under a numeric op and return the widened result
// (float if either side is float, else int; `any` if either is `any`).
function numeric(a: Type, b: Type, op: string): Type {
  const ra = res(a), rb = res(b);
  if (ra.tag === "any" || rb.tag === "any") return TANY;
  if (isNum(ra) && isNum(rb))
    return ra.name === "float" || rb.name === "float" ? TFLOAT : TINT;
  if (isNum(ra) && rb.tag === "var") { unify(rb, ra); return ra; }
  if (isNum(rb) && ra.tag === "var") { unify(ra, rb); return rb; }
  if (ra.tag === "var" && rb.tag === "var") { unify(ra, rb); return res(ra); }
  if (ra.tag === "var") { unify(ra, TINT); return TINT; }
  if (rb.tag === "var") { unify(rb, TINT); return TINT; }
  throw new TypeError_(`${op}: ${showT(ra)} and ${showT(rb)} are not numeric`);
}

// `+` is overloaded: num+num (numeric widening) or string+string -> string.
// Mixed (`"a" + 1`) is a type error. `any` on either side stays `any`.
function plusType(a: Type, b: Type): Type {
  const ra = res(a), rb = res(b);
  if (ra.tag === "any" || rb.tag === "any") return TANY;
  const sa = isNum(ra), sb = isNum(rb);
  if (sa && sb)
    return ra.name === "float" || rb.name === "float" ? TFLOAT : TINT;
  const stra = ra.tag === "prim" && ra.name === "string";
  const strb = rb.tag === "prim" && rb.name === "string";
  if (stra && strb) return TSTR;
  if (sa && rb.tag === "var") { unify(rb, ra); return ra; }
  if (sb && ra.tag === "var") { unify(ra, rb); return rb; }
  if (stra && rb.tag === "var") { unify(rb, ra); return ra; }
  if (strb && ra.tag === "var") { unify(ra, rb); return rb; }
  if (ra.tag === "var" && rb.tag === "var") { unify(ra, rb); return res(ra); }
  throw new TypeError_(`+: ${showT(ra)} and ${showT(rb)} are not both numeric or both string`);
}

// infer: returns the type, side-effecting `effs` with performed effects.
function infer(
  e: Expr,
  env: Env,
  effs: Set<string>,
  effects: Map<string, EffectSig>,
): Type {
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
        const pt = p.typ ?? freshVar();
        n.vars.set(p.name, pt);
        ps.push(pt);
      }
      const innerEffs = new Set<string>();
      const ret = e.retTyp !== null && res(e.retTyp).tag === "tup"
        ? inferWith(e.body, e.retTyp, n, innerEffs, effects)
        : infer(e.body, n, innerEffs, effects);
      if (e.retTyp !== null)
        unify(e.retTyp, ret);
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
      const declared = e.typ ?? freshVar();
      env.vars.set(e.name, declared);
      // A tuple annotation on an `[...]` literal makes it a tuple even when its
      // elements would otherwise unify homogeneously (e.g. `let p: [float, float] = [1.0, 2.0]`).
      const vt = (e.typ !== null && res(e.typ).tag === "tup" && e.val.t === "arr")
        ? inferArr(e.val, res(e.typ) as TupT, env, effs, effects)
        : infer(e.val, env, effs, effects);
      unify(declared, vt);
      const rt = res(declared);
      // Exclude the self-binding from the free-var context before
      // generalizing (otherwise its own vars read as free-in-env → no-op).
      env.vars.delete(e.name);
      // Value restriction: generalize only lambda values (literals carry no
      // type vars; `arr` literals are typed directly, not via `list`).
      // This keeps mutable-array/assign soundness (no `let x = []` : [a]).
      env.vars.set(e.name, e.typ !== null ? rt : (e.val.t === "lambda" ? generalize(env, rt) : rt));
      if (e.typ === null && containsAny(rt))
        warnInferredAny(e.name, rt);
      return TNULL;
    }
    // `[a, b, c]` literal: array `[T]` if all element types unify, else a
    // tuple `[T1, ..., Tn]`. `expected` (a tuple) forces tuple-ness.
    case "arr":
      return inferArr(e, null, env, effs, effects);
    // `obj.x` / `obj.0`: resolve the field index from the (tuple or array)
    // element type and stamp it on the node for the evaluator.
    case "field": {
      const ot = res(infer(e.obj, env, effs, effects));
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
      const vt = res(infer(e.val, env, effs, effects));
      if (vt.tag === "tup") {
        if (vt.fields.length !== e.fields.length)
          throw new TypeError_(`destructure arity ${e.fields.length} ≠ tuple ${vt.fields.length}`);
        for (let i = 0; i < e.fields.length; i++) {
          const ft = e.fields[i].typ;
          if (ft !== null)
            unify(ft, vt.fields[i].type);
          env.vars.set(e.fields[i].name, ft ?? vt.fields[i].type);
        }
      } else if (vt.tag === "arr") {
        for (const f of e.fields) {
          if (f.typ !== null)
            unify(f.typ, vt.elem);
          env.vars.set(f.name, f.typ ?? vt.elem);
        }
      } else {
        throw new TypeError_(`cannot destructure non-record type: ${showT(vt)}`);
      }
      return TNULL;
    }
    case "if": {
      const c = infer(e.c, env, effs, effects);
      unify(c, TBOOL);
      const a = infer(e.a, env, effs, effects);
      const b = infer(e.b, env, effs, effects);
      unify(a, b);
      return res(a);
    }
    case "while": {
      const c = infer(e.c, env, effs, effects);
      unify(c, TBOOL);
      infer(e.body, env, effs, effects);
      return TNULL;
    }
    case "assign": {
      const cur = env.lookup(e.name);
      if (cur === undefined) throw new TypeError_(`Assignment to unbound symbol: ${e.name}`);
      const vt = infer(e.val, env, effs, effects);
      // Unify against the declared type so `let guess: float` keeps its type.
      unify(typeof cur === "function" ? cur() : cur, vt);
      return TNULL;
    }
    case "block": {
      const n = env.extend();
      let last: Type = TNULL;
      for (const s of e.stmts) last = infer(s, n, effs, effects);
      return last;
    }
    case "perform": {
      const sig = effects.get(e.op);
      if (sig === undefined)
        throw new TypeError_(`Unknown effect: ${e.op} (declare with: effect ${e.op}(...);)`);
      if (e.args.length !== sig.params.length)
        throw new TypeError_(`effect ${e.op}: ${sig.params.length} args, got ${e.args.length}`);
      const argTs = e.args.map(a => infer(a, env, effs, effects));
      for (let i = 0; i < sig.params.length; i++) unify(sig.params[i], argTs[i]);
      effs.add(e.op);
      return sig.ret;
    }
    case "handle": {
      const bodyEffs = new Set<string>();
      const bodyT = infer(e.body, env, bodyEffs, effects);
      let resultT: Type | null = null;
      for (const c of e.cases) {
        const n = env.extend();
        const sig = effects.get(c.op);
        if (sig === undefined && c.op !== "Return")
          throw new TypeError_(`Handler for unknown effect: ${c.op}`);
        if (c.op === "Return") {
          n.vars.set(c.params[0].name, res(bodyT));
        } else {
          for (let i = 0; i < c.params.length; i++) {
            n.vars.set(c.params[i].name, sig!.params[i] ?? TANY);
          }
        }
        // resume: (sig.ret) -> resultT ; Return's resume is identity over bodyT
        const resumeT = c.op === "Return"
          ? tFun([res(bodyT)], freshVar(), new Set())
          : tFun([sig!.ret], freshVar(), new Set());
        n.vars.set(c.resume, resumeT);
        const ct = infer(c.body, n, new Set<string>(), effects);
        if (resultT === null)
          resultT = ct;
        else
          unify(resultT, ct);
        unify(resumeT.ret, ct);
      }
      for (const c of e.cases) bodyEffs.delete(c.op);
      for (const op of bodyEffs) effs.add(op);
      return resultT ?? TNULL;
    }
    case "app": {
      // Array literals desugar to list(...); type as homogeneous [T].
      if (e.fn.t === "sym" && e.fn.v === "list") {
        const elem = freshVar();
        for (const a of e.args) unify(elem, infer(a, env, effs, effects));
        return tArr(res(elem));
      }
      // `+` is overloaded: numeric widening or string concatenation.
      if (e.fn.t === "sym" && e.fn.v === "+") {
        const at = infer(e.args[0], env, effs, effects);
        const bt = infer(e.args[1], env, effs, effects);
        return plusType(at, bt);
      }
      // Numeric operators (- * / %) and comparisons (< > <= >=) widen int/float;
      // unary neg is handled below. Kept out of BINOPS so they get this logic.
      if (e.fn.t === "sym" && (NUMOPS.has(e.fn.v) || CMPOPS.has(e.fn.v))) {
        const at = infer(e.args[0], env, effs, effects);
        const bt = infer(e.args[1], env, effs, effects);
        const widened = numeric(at, bt, e.fn.v);
        if (CMPOPS.has(e.fn.v)) return TBOOL;
        // `/` is type-preserving: int/int -> int (truncated at runtime),
        // float/float -> float, and any-operand -> float (don't truncate
        // unknowns). The checker stamps which division this is on the node so
        // the evaluator (which sees untyped JS numbers) knows whether to truncate.
        if (e.fn.v === "/") { e.div = widened === TINT ? "int" : "float"; return widened; }
        return widened;
      }
      if (e.fn.t === "sym" && e.fn.v === "neg") {
        const at = infer(e.args[0], env, effs, effects);
        return numeric(at, at, "neg");
      }
      // Equality: both operands must share a type (numeric widening lets
      // `int ~ float`). Cross-type (`"a" == 1`) is a type error.
      if (e.fn.t === "sym" && EQOPS.has(e.fn.v)) {
        const at = infer(e.args[0], env, effs, effects);
        const bt = infer(e.args[1], env, effs, effects);
        unify(at, bt);
        return TBOOL;
      }
      const ft = infer(e.fn, env, effs, effects);
      const fr = res(ft);
      // When the callee is a known function, an `[...]` literal argument
      // passed against a tuple parameter type is inferred as that tuple
      // (mirroring the `let : [..] = [...]` special case).
      const argTs = e.args.map((a, i) => {
        if (a.t === "arr" && fr.tag === "fun" && fr.params[i] && res(fr.params[i]).tag === "tup")
          return inferArr(a, res(fr.params[i]) as TupT, env, effs, effects);
        return infer(a, env, effs, effects);
      });
      const ret = freshVar();
      if (fr.tag === "fun") {
        if (fr.params.length !== argTs.length)
          throw new TypeError_(`arity ${fr.params.length} ≠ ${argTs.length}`);
        for (let i = 0; i < argTs.length; i++) unify(fr.params[i], argTs[i]);
        unify(fr.ret, ret);
        // The callee's effect row is unified with each callback argument's
        // effect row via the param unification above (polymorphic builtins
        // share one effect variable between the callback and the result).
        // Whatever the callee's row resolves to now is what the call performs.
        const er = resEff(fr.effs);
        if (er instanceof Set) for (const op of er) effs.add(op);
        return res(ret);
      }
      if (fr.tag === "any") return TANY;
      const expected = tFun(argTs, ret, new Set());
      try { unify(ft, expected); }
      catch (err) {
        if (err instanceof TypeError_ && e.fn.t === "sym")
          throw typeMismatch(ft, expected, e.fn.v);
        throw err;
      }
      return res(ret);
    }
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

export function checkProgram(
  items: Item[],
  acc?: { env: Env, effects: Map<string, EffectSig> },
): { env: Env, effects: Map<string, EffectSig>, lastType: Type } {
  let env: Env;
  let effects: Map<string, EffectSig>;
  if (acc !== undefined) {
    env = acc.env;
    effects = acc.effects;
  } else {
    effects = new Map<string, EffectSig>();
    // Builtin effects, interpreted by the runtime when left unhandled.
    // `Read(path): string` reads a file; `Write(path, content): null` writes one.
    // `Println(v: any): null` and `Out(s: string): null` are the console effects.
    // User `effect` decls below may add or override these.
    effects.set("Read", {params: [TSTR], ret: TSTR});
    effects.set("Write", {params: [TSTR, TSTR], ret: TNULL});
    effects.set("Println", {params: [TANY], ret: TNULL});
    effects.set("Out", {params: [TSTR], ret: TNULL});
    // `Exit(code: int): unit` terminates the process by default (never resumes);
    // `Wait(secs: int): unit` blocks for `secs` seconds then resumes with unit.
    // Both are effects so a handler can intercept them.
    effects.set("Exit", {params: [TINT], ret: TNULL});
    effects.set("Wait", {params: [TINT], ret: TNULL});
    // `Random(): float` resumes with a random number in [0, 1).
    effects.set("Random", {params: [], ret: TFLOAT});
    env = new Env(null);
    env.vars.set("not", tFun([TBOOL], TBOOL, new Set()));
    env.vars.set("list", tFun([TANY], tArr(TANY), new Set()));
    env.vars.set("head", () => { const a = freshVar(); return tFun([tArr(a)], a, new Set()); });
    env.vars.set("tail", () => { const a = freshVar(); return tFun([tArr(a)], tArr(a), new Set()); });
    env.vars.set("concat", () => { const a = freshVar(); return tFun([tArr(a), tArr(a)], tArr(a), new Set()); });
    env.vars.set("flat", () => { const a = freshVar(); return tFun([tArr(tArr(a))], tArr(a), new Set()); });
    env.vars.set("len", () => { const a = freshVar(); return tFun([tArr(a)], TINT, new Set()); });
    env.vars.set("strlen", tFun([TSTR], TINT, new Set()));
    env.vars.set("map", () => {
      const a = freshVar(), b = freshVar(), e = freshEff();
      return tFun([tFun([a], b, e), tArr(a)], tArr(b), e);
    });
    // --- builtins added for the star.ink port ---
    env.vars.set("PI", TFLOAT);
    env.vars.set("cos", tFun([TFLOAT], TFLOAT, new Set()));
    env.vars.set("sin", tFun([TFLOAT], TFLOAT, new Set()));
    env.vars.set("abs", tFun([TFLOAT], TFLOAT, new Set()));
    env.vars.set("round", tFun([TFLOAT], TINT, new Set()));
    env.vars.set("sqrt", tFun([TFLOAT], TFLOAT, new Set()));
    env.vars.set("range", tFun([TINT, TINT, TINT], tArr(TINT), new Set()));
    env.vars.set("char", tFun([TINT], TSTR, new Set()));
    env.vars.set("number", tFun([TSTR], TFLOAT, new Set()));
    env.vars.set("args", tFun([], tArr(TSTR), new Set()));
    env.vars.set("get", () => { const a = freshVar(); return tFun([tArr(a), TINT], a, new Set()); });
    env.vars.set("set", () => { const a = freshVar(); return tFun([tArr(a), TINT, a], TNULL, new Set()); });
    env.vars.set("each", () => {
      const a = freshVar(), b = freshVar(), e = freshEff();
      return tFun([tFun([a, TINT], b, e), tArr(a)], TNULL, e);
    });
    env.vars.set("flatmap", () => {
      const a = freshVar(), b = freshVar(), e = freshEff();
      return tFun([tFun([a, TINT], tArr(b), e), tArr(a)], tArr(b), e);
    });
  }

  for (const it of items.filter(it => "effect" in it))
    effects.set(it.effect, it.sig);

  let lastType: Type = TNULL;
  for (const it of items.filter(it => "e" in it))
    lastType = infer(it.e, env, new Set(), effects);

  return {env, effects, lastType};
}
