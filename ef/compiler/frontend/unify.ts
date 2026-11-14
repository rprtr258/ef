// unify: the type-system core — the `Type` union and its shapes, the
// unifier (union-find over type/effect variables, untyped-literal wildcard
// flexing, speculative checkpoint/restore), and HM generalization over the
// checker `Env`. A leaf over prims.ts: the shape constructors (tArr/tFun/
// tTup) and the prim constants live there, and prims imports only this
// module's type shapes (type-only, erased at runtime). Failure paths render
// types and throw through type_display.ts (showT/TypeError_) — a leaf that
// imports this module's shapes type-only, so the runtime edge is one-way
// (unify → type_display).
import {tArr, tFun, tTup} from "../prims.ts";
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
// Effect rows: a concrete `Set<string>` of performed effects, or an
// unbound effect variable (row polymorphism). Effect variables unify by
// union-find; a variable unifies with a concrete set by binding to it; two
// concrete sets unify by equality. This lets higher-order builtins be
// effect-polymorphic: `map : ((a) -> b ! e, [a]) -> [b] ! e` for a fresh `e`.
type EffVar = { tag: "effvar", id: number };
export type Effs = Set<string> | EffVar;
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
// int/float literals defaulted to i64/f64 (literal defaulting, not width
// conversion). null for non-numeric types.
export function widthOf(t: Type): {w: NumName, concrete: boolean} | null {
  if (t.tag !== "prim") return null;
  const n = t.name as NumName;
  if (INT_NAMES.has(n) || FLOAT_NAMES.has(n)) return {w: n, concrete: true};
  if (n === "int") return {w: "i64", concrete: false};
  if (n === "float") return {w: "f64", concrete: false};
  return null;
}

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
  // Fresh per-literal wildcard prims (newWild) and the concrete width each
  // flexed to at unify time — a literal's numKind stamp is its flex, not the
  // i64/f64 default. Keyed by instance identity; the shared TINT/TFLOAT
  // singletons are never in `wilds`, so unifying against them never records.
  wilds = new Set<Prim>();
  wildFlex = new Map<Prim, NumName>();

  newWild(name: "int" | "float"): Prim {
    const p: Prim = {tag: "prim", name};
    this.wilds.add(p);
    return p;
  }

  fresh(): Var {
    const id = this.n++;
    this.parent.set(id, id);
    return {tag: "var", id};
  }
  // Record that a fresh wildcard literal took a concrete numeric width in
  // this unification (no-op for the shared TINT/TFLOAT singletons).
  rememberFlex(wild: Prim, concrete: NumName): void {
    if (this.wilds.has(wild)) this.wildFlex.set(wild, concrete);
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
      return tFun(r.params.map(p => this.deepRes(p)), this.deepRes(r.ret), this.resEff(r.effs),
        r.contCall === true || r.anyTaint === true ? {contCall: r.contCall, anyTaint: r.anyTaint} : undefined);
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
  // when `any` is *inferred* (e.g. from indexing an `[any]`) rather than
  // explicitly written, so silent escapes are visible. `res` is
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
    if (ra.tag === "any" || rb.tag === "any") {
      // `any` flowing into a function-typed position erases the row evidence
      // at every site typed by that FunT — the marker keeps suspension
      // stamping conservative (stampSuspension reads it).
      if (ra.tag === "fun") ra.anyTaint = true;
      if (rb.tag === "fun") rb.anyTaint = true;
      return;
    }
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
      if (an === "int" && NUMERIC_NAMES.has(bn)) { this.rememberFlex(ra, bn); return; }   // `1` -> any numeric
      if (bn === "int" && NUMERIC_NAMES.has(an)) { this.rememberFlex(rb, an); return; }
      if (an === "float" && (bn === "float" || FLOAT_NAMES.has(bn))) { this.rememberFlex(ra, bn); return; }  // `1.5` -> f32/f64
      if (bn === "float" && (an === "float" || FLOAT_NAMES.has(an))) { this.rememberFlex(rb, an); return; }
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
          r.contCall === true || r.anyTaint === true ? {contCall: r.contCall, anyTaint: r.anyTaint} : undefined,
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

// A unification failure — kept distinct so the app-call catch can rethrow it
// annotated with the callee's name (typeMismatch).
class TypeMismatch extends TypeError_ {}

type Scheme = () => Type; // polymorphic type scheme, instantiated fresh per use

export class Env {
  vars = new Map<string, Type | Scheme>();
  // Names bound mutable in this frame (`:=` / `: T =` / `[a, b] :=`). Assign
  // resolves against the innermost frame binding the name and requires it here.
  muts = new Set<string>();
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
