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
// Effect rows: a concrete `Set<string | EffVar>` of performed effects (a row
// may carry unbound effect variables — a call to a callee whose row is still
// a variable propagates that variable into the ambient row, so polymorphic
// callers stay effect-tracked), or an unbound effect variable (row
// polymorphism). Effect variables unify by union-find; a variable unifies
// with a concrete set by binding to it; two concrete sets unify by equality.
// This lets higher-order builtins be effect-polymorphic:
// `map : ((a) -> b ! e, [a]) -> [b] ! e` for a fresh `e`.
type EffVar = { tag: "effvar", id: number };
// A concrete effect row: op names plus possibly-unbound effect variables.
export type Row = Set<string | EffVar>;
export type Effs = Row | EffVar;
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

// Unifier: ALL mutable unification state in one object — the type-variable
// union-find, the substitution map `binds`, and the effect-row union-find.
// One instance per checking session, created by `checkProgram` and carried
// across REPL lines inside `Checked`. `Type` values are plain data; every
// resolver below is a method, so independent `checkProgram` calls (tests!) never
// share state. Effect rows are a concrete `Set<string | EffVar>` of performed
// effects (row vars may ride along — see `Effs`), or an unbound effect
// variable (row polymorphism): a variable unifies with a concrete set by
// binding to it; two concrete sets unify by equality. This lets higher-order
// builtins be effect-polymorphic:
// `map : ((a) -> b ! e, [a]) -> [b] ! e` for a fresh `e`.
export class Unifier {
  parent = new Map<number, number>();
  n = 0;
  binds = new Map<number, Type>();
  effParent = new Map<number, number>();
  effBinds = new Map<number, Row>();
  // Row variable id → the callee type variable it was forced for (app-case
  // fallback). Lets the lambda's effect-annotation pinning tell parameter-
  // borne variables (pin them) from a recursive self-call's variable (the
  // binding's own unification constrains it afterwards).
  forcedRows = new Map<number, number>();
  effCounter = 0;
  // Fresh per-literal wildcard prims (newWild). Unifying a wildcard with a
  // numeric context BINDS the width into the instance itself (flexWild) —
  // every recorded reference to it resolves to the concrete width. Shared
  // singletons (TINT/TFLOAT in builtin signatures) are never in `wilds`, so
  // unifying against them never mutates. wildLinks records same-kind
  // wildcard pairs (op result ↔ operands) whose width is only decided
  // later, resolved to concrete by resolveWilds at end of check.
  wilds = new Set<Prim>();
  wildLinks: Array<[Prim, Prim]> = [];

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
  // Bind a wildcard's width in place (no-op for the shared TINT/TFLOAT
  // singletons — they stay context-flexible defaults). The name may itself
  // be a wildcard name ("int"/"float"): the mixed-literal case mutates the
  // int side to "float", still resolved by resolveWilds.
  flexWild(wild: Prim, name: NumName): void {
    if (this.wilds.has(wild)) wild.name = name;
  }
  // Link an op-site result wildcard with an operand wildcard: whichever
  // side resolves a concrete width first (annotation, outer op, defaulting)
  // propagates to the other in resolveWilds.
  linkWilds(result: Prim, operand: Prim): void {
    this.wildLinks.push([result, operand]);
  }
  // End-of-check wildcard resolution: propagate linked widths to a fixpoint,
  // then default every wildcard still unbound (literal defaulting, not
  // width conversion — int → i64, float → f64). After this every wildcard
  // instance is a concrete width: the checker leaves no untyped literals.
  resolveWilds(): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const [r, o] of this.wildLinks) {
        const wr = widthOf(r), wo = widthOf(o);
        if (wr === null || wo === null) continue;
        // Only fresh wildcards are mutable — the shared TINT/TFLOAT
        // singletons keep their context-flexible name, so a link touching
        // one never sets changed (the fixpoint must terminate even when an
        // edge can never fully resolve).
        if (wr.concrete !== wo.concrete) {
          if (wr.concrete && this.wilds.has(o) && o.name !== wr.w) { o.name = wr.w; changed = true; }
          else if (!wr.concrete && this.wilds.has(r) && r.name !== wo.w) { r.name = wo.w; changed = true; }
        } else if (!wr.concrete && wr.w !== wo.w) {
          // Mixed wildcard kinds across a link (int vs float): the int
          // side flexes to float — the float side may still flex to a
          // concrete f32/f64 in a later round.
          if (wr.w === "i64" && this.wilds.has(r) && r.name !== "float") { r.name = "float"; changed = true; }
          else if (wo.w === "i64" && this.wilds.has(o) && o.name !== "float") { o.name = "float"; changed = true; }
        }
      }
    }
    for (const w of this.wilds) {
      if (w.name === "int") w.name = "i64";
      else if (w.name === "float") w.name = "f64";
    }
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
  // concrete set (rows may carry unbound variables — resolve members via
  // `resRow`). Unbound → the canonical variable.
  resEff(e: Effs): Effs {
    if (e instanceof Set) return e;
    const r = this.effFind(e.id);
    const b = this.effBinds.get(r);
    return b ?? {tag: "effvar", id: r};
  }
  // Flatten an effect row: resolve every variable member (bound ones inline
  // their bound row's members, recursively); unbound ones stay as canonical
  // variables. An unbound top-level variable flattens to a singleton row of
  // itself, so callers always receive a row. Cycle-guarded: a variable bound
  // to a row containing its own root resolves without looping.
  resRow(e: Effs, seen?: Set<number>, keepCycles = false): Row {
    const r = this.resEff(e);
    if (!(r instanceof Set)) return new Set<string | EffVar>([r]);
    const out: Row = new Set();
    const guard = seen ?? new Set<number>();
    for (const m of r) {
      if (typeof m === "string") { out.add(m); continue; }
      const root = this.effFind(m.id);
      if (guard.has(root)) {
        // A row variable unified with a row containing itself (ρ = {ρ}, the
        // shape recursion produces). The least fixpoint contributes nothing,
        // so semantic consumers collapse it; display keeps the variable —
        // an unconstrained parameter's row shows as a generic row instead
        // of a concrete empty claim.
        if (keepCycles) out.add({tag: "effvar", id: root});
        continue;
      }
      const b = this.effBinds.get(root);
      if (b === undefined) out.add({tag: "effvar", id: root});
      else {
        guard.add(root);
        for (const mm of this.resRow(b, guard, keepCycles)) out.add(mm);
        guard.delete(root);
      }
    }
    return out;
  }
  // Deeply resolve every type/effect variable in `t`. Displayed types
  // (`showT`, closure types stamped on lambda nodes) are always deep-resolved,
  // so display never needs the unifier.
  deepRes(t: Type, nested = false): Type {
    const r = this.res(t);
    if (r.tag === "arr") return tArr(this.deepRes(r.elem, nested));
    if (r.tag === "tup") return tTup(r.fields.map(f => ({name: f.name, type: this.deepRes(f.type, nested)})));
    if (r.tag === "fun")
      return tFun(r.params.map(p => this.deepRes(p, true)), this.deepRes(r.ret, true),
        this.resRow(r.effs, undefined, nested),
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

  // Unify two effect rows. var+var union; var+set binds (the set may carry
  // unbound variables); set+set requires matching op coverage — except the
  // empty set `∅` is the polymorphic bottom: a function typed `... ! ∅`
  // performs no effects and may be used wherever *any* effect set is expected
  // (it is refined to the other set). When one side carries unbound variables,
  // the variables absorb the other side's unmatched ops: `! { x, e } ~
  // ! { x, y }` binds `e := { y }`. This keeps unannotated HOF parameters
  // flexible without let-generalization and lets polymorphic callers carry
  // their callee's row.
  unifyEff(a: Effs, b: Effs): void {
    const ra = this.resEff(a), rb = this.resEff(b);
    if (!(ra instanceof Set) && !(rb instanceof Set)) {
      this.effParent.set(this.effFind(ra.id), this.effFind(rb.id));
      return;
    }
    if (!(ra instanceof Set)) { this.effBinds.set(this.effFind(ra.id), rb as Row); return; }
    if (!(rb instanceof Set)) { this.effBinds.set(this.effFind(rb.id), ra); return; }
    const fa = this.resRow(ra), fb = this.resRow(rb);
    if (fa.size === 0) return; // ∅ unifies with anything (refine to rb)
    if (fb.size === 0) return;
    const sA = [...fa].filter(m => typeof m === "string");
    const vA = [...fa].filter(m => typeof m !== "string");
    const sB = [...fb].filter(m => typeof m === "string");
    const vB = [...fb].filter(m => typeof m !== "string");
    const setA = new Set(sA), setB = new Set(sB);
    const dA = sB.filter(op => !setA.has(op)); // ops only B has: A's vars must supply
    const dB = sA.filter(op => !setB.has(op)); // ops only A has: B's vars must supply
    if (dA.length > 0 && vA.length === 0)
      throw new TypeError_(
        `effect mismatch: { ${[...fa].map(m => typeof m === "string" ? m : `e${m.id}`).join(", ")} } ≠ { ${[...fb].map(m => typeof m === "string" ? m : `e${m.id}`).join(", ")} }`);
    if (dB.length > 0 && vB.length === 0)
      throw new TypeError_(
        `effect mismatch: { ${[...fa].map(m => typeof m === "string" ? m : `e${m.id}`).join(", ")} } ≠ { ${[...fb].map(m => typeof m === "string" ? m : `e${m.id}`).join(", ")} }`);
    for (const v of vA) this.effBinds.set(this.effFind(v.id), new Set(dA));
    for (const v of vB) this.effBinds.set(this.effFind(v.id), new Set(dB));
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
      // strict: i32 ~ i64 is a type error, use @as to convert. A wildcard
      // meeting a context binds that width into its instance in place.
      const an = ra.name as NumName, bn = rb.name as NumName;
      if (an === bn) return;                               // exact: i32 ~ i32, string ~ string, ...
      if (an === "int" && NUMERIC_NAMES.has(bn)) { this.flexWild(ra, bn); return; }   // `1` -> any numeric
      if (bn === "int" && NUMERIC_NAMES.has(an)) { this.flexWild(rb, an); return; }
      if (an === "float" && (bn === "float" || FLOAT_NAMES.has(bn))) { this.flexWild(ra, bn); return; }  // `1.5` -> f32/f64
      if (bn === "float" && (an === "float" || FLOAT_NAMES.has(an))) { this.flexWild(rb, an); return; }
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
      // keepCycles: a self-referential row variable (ρ = {ρ}, what recursion
      // produces) is collected as quantifiable — collapsing it here would
      // bake the least-fixpoint ∅ into every instance.
      for (const m of this.resRow(r.effs, undefined, true))
        if (typeof m !== "string") evs.add(this.effFind(m.id));
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
      default:
        // Wildcard prims (untyped-literal types — the shared TINT/TFLOAT
        // signature singletons and fresh literal wildcards alike)
        // instantiate fresh per use: the call site flexes its own copy via
        // flexWild without leaking a width into the signature or other
        // sites. Concrete prims are immutable — shared as-is.
        if (r.tag === "prim" && (r.name === "int" || r.name === "float"))
          return this.newWild(r.name);
        return r;
    }
  }

  copyEff(e: Effs, em: Map<number, Effs>): Effs {
    const out: Row = new Set();
    for (const m of this.resRow(e, undefined, true)) {
      if (typeof m === "string") out.add(m);
      else {
        const root = this.effFind(m.id);
        const c = em.get(root);
        if (c === undefined) out.add({tag: "effvar", id: root}); // free var stays
        // quantified: the fresh instance (keepCycles — a self-referential
        // instance must not flatten to ∅ here)
        else for (const mm of this.resRow(c, undefined, true)) out.add(mm);
      }
    }
    // Preserve the historical row shapes: a lone variable stays a bare
    // variable (so var+set unification refines it), a ground set stays a set.
    if (out.size === 1) {
      const [m] = out;
      if (typeof m !== "string") return m;
    }
    return out;
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
        em.set(id, this.instanceEff(id));
      return this.copyScheme(t, tm, em);
    };
  }

  // A fresh instance of a quantified row variable. A variable bound to a
  // pure self-loop (ρ = {ρ}, what recursion produces) stays self-referential
  // in the instance: an unbound copy would read as a genuinely unknown row,
  // making every call to a pure recursive function suspending and its type
  // display generic. resRow collapses the self-loop for semantic consumers
  // and deepRes keeps it for parameter-row display.
  instanceEff(id: number): EffVar {
    const v = this.freshEff();
    const b = this.effBinds.get(id);
    if (b !== undefined && b.size > 0 &&
        [...b].every(m => typeof m !== "string" && this.effFind(m.id) === id))
      this.effBinds.set(v.id, new Set([{tag: "effvar", id: v.id}]));
    return v;
  }
}

// Snapshot of a `Unifier`'s state, for speculative unification (see checkpoint).
type Snapshot = {
  parent: Map<number, number>, n: number,
  binds: Map<number, Type>,
  effParent: Map<number, number>, effBinds: Map<number, Row>,
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
