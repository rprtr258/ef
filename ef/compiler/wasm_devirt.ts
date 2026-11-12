// Devirtualization analysis over the CPS IR (leaf: cps_ir + analysis + the
// checker's type resolver for numeric-entry eligibility).
//
// Per-slot closure provenance + per-CFn purity fixpoint + numeric-entry
// eligibility. The wasm emitters consume the results through the returned
// site map (copied onto `__p` annotations by planIr) and TermPlan.cfnPure. Soundness rests on two
// checker guarantees: **no shadowing** (checkBind — no same-frame
// redeclaration, no hiding an enclosing binding) makes a flat per-unit
// name→provenance map exact, and **ANF** (bind/let RHS is an atom) gives
// every slot exactly one binding node and no value-merging join points.
//
// The purity classification is deliberately independent of the checker's
// effect rows: a direct-classified fn can still suspend (an `any`-callee
// generic `call` contributes no ops to the row; a mixed fn — row {} with
// internal handles — performs inside its islands), so every gate here is
// computed from the IR shape itself, never from `direct` alone.

import {BUILTINS} from "./analysis.ts";
import type {CAtom, CFn, CIr, CTerm} from "./cps_ir.ts";
import {widthOf, type Type} from "./types.ts";
import {numSig} from "./wasm_tables.ts";

// The CPS-native builtins (the ones whose trampolines call ef closures).
// Mirrors builtins.ts's `kind: "native"` entries — the wasm backend already
// special-cases exactly these in directBuiltin/emitMapLike.
const NATIVE_BUILTINS: ReadonlySet<string> = new Set(["map", "each", "flatmap"]);

// Facts for one dcall/call site.
type SiteInfo = {
  // The callee atom resolves to a slot whose only possible value is direct
  // CFn `devirt`'s mkfn closure. The slot always holds a $CLO with that fun
  // index (envs still differ per activation) — the emitter may issue a
  // static T_DABI call instead of the flag dispatch + call_indirect.
  devirt?: number,
  // The callee's capts are empty: it never dereferences its env, so the
  // static call needs no closure value at all (null frame parent).
  noEnv?: true,
  // Arg positions whose atom resolves to such a slot (map-callback
  // eligibility at map/each/flatmap sites).
  argFun: Map<number, number>,
  // dcall only: the rest subtree is suspension-free and every callee
  // reachable from it is pure — the emitter may run the rest inline after
  // the static call instead of building a rest cell + thunk.
  inlineRest?: true,
};

export type Devirt = {
  // Per-CFn: no call/perform/handle node anywhere in the body, and every
  // dcall target is (transitively) pure. `pure` implies `direct`.
  cfnPure: boolean[],
  sites: Map<CTerm, SiteInfo>,
};

// Why one callee edge is or isn't provably suspension-free.
type Edge =
  | {k: "fun", fun: number} // a CFn closure: pure iff cfnPure[fun] (fixpoint)
  | {k: "ok"}               // fn-kind builtin trampoline: computes inline
  | {k: "unknown"};         // resume binder / any-smuggled value / unprovable slot

const edgePure = (e: Edge, pure: boolean[]): boolean =>
  e.k === "ok" || (e.k === "fun" && pure[e.fun] === true);

export function analyzeDevirt(ir: CIr): Devirt {
  const sites = new Map<CTerm, SiteInfo>();
  const direct = ir.funcs.map(fn => fn.direct === true);
  // edges[fi]: null once the fn is known-impure (a call/perform/handle node
  // or an unknown dcall target); otherwise the callee edges left to resolve.
  const edges: (Edge[] | null)[] = ir.funcs.map(() => []);
  // Per-dcall rest facts, collected while walking the rest: a suspending
  // node or an impure-possible callee inside the rest kills its inline mark.
  const restFacts = new Map<CTerm, {sus: boolean, es: Edge[]}>();
  // Names assigned anywhere: a slot so named may hold different closures
  // over time, and per-unit maps cannot see another unit's assign — treat
  // them as unprovable in every unit (local rebinds are rare in hot code).
  const assignedNames = new Set<string>();
  const collectAssigns = (t: CTerm): void => {
    switch (t.t) {
      case "assign":
        assignedNames.add(t.name);
        collectAssigns(t.rest);
        break;
      case "letk":
        collectAssigns(t.body);
        collectAssigns(t.rest);
        break;
      case "let": case "bind": case "mkfn": case "dlet": case "scope": case "dcall":
        collectAssigns(t.rest);
        break;
      case "handle":
        for (const c of t.cases) collectAssigns(c.body);
        collectAssigns(t.body);
        break;
      case "if":
        collectAssigns(t.a);
        collectAssigns(t.b);
        break;
      default:
        break; // call/perform/halt/dret/jump carry no sub-terms to walk
    }
  };
  collectAssigns(ir.term);
  for (const fn of ir.funcs) collectAssigns(fn.body);

  // One unit = the main term or one CFn body. Returns the unit's final
  // provenance map (the main term's seeds the CFn walks).
  const walkUnit = (body: CTerm, fi: number | null, seed?: Map<string, number | undefined>): Map<string, number | undefined> => {
    // name → CFn fun when every value the slot can hold is that mkfn's
    // closure; an explicit undefined = bound but unprovable; missing =
    // unbound (builtin or param like a resume binder). CFn bodies are
    // seeded with the main term's final map: top-level bindings live in
    // the main frame, and no-shadowing keeps the lambda from hiding them.
    const prov = new Map<string, number | undefined>(seed);
    // Enclosing dcall rests (innermost last): every sus node and callee
    // edge inside a rest is recorded on all of them.
    const stack: {sus: boolean, es: Edge[]}[] = [];
    const noteSus = (): void => {
      if (fi !== null) edges[fi] = null;
      for (const c of stack) c.sus = true;
    };
    const noteEdge = (e: Edge): void => {
      if (fi !== null && edges[fi] !== null) edges[fi].push(e);
      for (const c of stack) c.es.push(e);
    };
    const atomProv = (a: CAtom): number | undefined =>
      a.t === "var" ? prov.get(a.name) : undefined;
    const site = (t: CTerm): SiteInfo => {
      let si = sites.get(t);
      if (si === undefined) {
        si = {argFun: new Map()};
        sites.set(t, si);
      }
      return si;
    };
    // Devirt annotations read the callee's own provenance (calleeFun): for
    // a native builtin the purity edge rides on the CALLBACK, but the
    // callee itself is not a CFn — only slots proven to hold one CFn's
    // closure devirtualize.
    const calleeFun = (fn: CAtom): number | undefined =>
      fn.t === "var" ? prov.get(fn.name) : undefined;
    // Callee edge for the purity fixpoint: slot provenance first, then
    // builtin kind, else unknown.
    const edgeOf = (fn: CAtom, args: CAtom[]): Edge => {
      const cf = calleeFun(fn);
      if (cf !== undefined) return {k: "fun", fun: cf};
      if (fn.t !== "var") return {k: "unknown"};
      // Unbound at a dcall site means a builtin: only fn-kind trampolines
      // (row {} — computes inline) and the natives (pure callback) can sit
      // there; anything else — effect builtins, resume binders, non-builtins
      // — is unknown.
      if (!BUILTINS.some(b => b.name === fn.name)) return {k: "unknown"};
      if (NATIVE_BUILTINS.has(fn.name)) {
        // map/each/flatmap: suspension-free iff the callback's provenance
        // is a pure CFn — rides the fixpoint as a fun edge. (The native
        // builtins all take the callback as their first arg, so args[0]
        // exists whenever this branch runs.)
        const cb = args[0];
        if (cb.t === "var") {
          const cpf = prov.get(cb.name);
          if (cpf !== undefined) return {k: "fun", fun: cpf};
        }
        return {k: "unknown"};
      }
      return {k: "ok"};
    };
    const recordArgs = (args: CAtom[], si: SiteInfo): void => {
      for (let i = 0; i < args.length; i++) {
        const f = atomProv(args[i]);
        if (f !== undefined) si.argFun.set(i, f);
      }
    };
    const visit = (t: CTerm): void => {
      switch (t.t) {
        case "letk": {
          // Loop phis and resume deliveries land here: params are joins,
          // never single-valued.
          prov.set(t.param, undefined);
          if (t.freeze !== undefined)
            for (const fr of t.freeze) prov.set(fr.name, atomProv(fr.val));
          visit(t.body);
          visit(t.rest);
          break;
        }
        case "let":
          // A prim result: field reads can surface arbitrary closures.
          prov.set(t.name, undefined);
          visit(t.rest);
          break;
        case "bind":
          prov.set(t.name, assignedNames.has(t.name) ? undefined : atomProv(t.val));
          visit(t.rest);
          break;
        case "mkfn":
          prov.set(t.name, assignedNames.has(t.name) ? undefined : t.fun);
          visit(t.rest);
          break;
        case "dlet":
          for (const fld of t.fields) prov.set(fld, undefined);
          visit(t.rest);
          break;
        case "assign": {
          // Re-binding: keep the provenance only when it survives the merge.
          const src = atomProv(t.val);
          prov.set(t.name, prov.get(t.name) === src ? src : undefined);
          visit(t.rest);
          break;
        }
        case "scope":
          visit(t.rest);
          break;
        case "call": {
          // Generic call: the callee may suspend (a CPS row, or an
          // any-hole closure) — impure by definition.
          noteSus();
          const si = site(t);
          recordArgs(t.args, si);
          const cf = calleeFun(t.fn);
          if (cf !== undefined && direct[cf]) {
            si.devirt = cf;
            if (ir.funcs[cf].capts.length === 0) si.noEnv = true;
          }
          break;
        }
        case "dcall": {
          const si = site(t);
          recordArgs(t.args, si);
          const cf = calleeFun(t.fn);
          if (cf !== undefined && direct[cf]) {
            si.devirt = cf;
            if (ir.funcs[cf].capts.length === 0) si.noEnv = true;
          }
          noteEdge(edgeOf(t.fn, t.args));
          const col = {sus: false, es: [] as Edge[]};
          stack.push(col);
          prov.set(t.name, undefined); // the result may be any closure
          visit(t.rest);
          stack.pop();
          restFacts.set(t, col);
          break;
        }
        case "perform":
          noteSus();
          break;
        case "handle": {
          noteSus();
          prov.set(t.ret, undefined);
          for (const c of t.cases) {
            for (const p of c.params) prov.set(p, undefined);
            prov.set(c.resume, undefined);
            visit(c.body);
          }
          visit(t.body);
          break;
        }
        case "if":
          visit(t.a);
          visit(t.b);
          break;
        default:
          break; // jump/halt/dret carry atoms only
      }
    };
    visit(body);
    return prov;
  };

  const mainProv = walkUnit(ir.term, null);
  for (let i = 0; i < ir.funcs.length; i++) walkUnit(ir.funcs[i].body, i, mainProv);

  // Purity fixpoint: pure = no sus node, and every dcall edge resolves pure.
  const pure = ir.funcs.map((_, i) => edges[i] !== null);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < ir.funcs.length; i++) {
      if (!pure[i]) continue;
      const es = edges[i]!;
      if (es.some(e => !edgePure(e, pure))) {
        pure[i] = false;
        changed = true;
      }
    }
  }

  // Inline-rest marking: a dcall whose own callee is pure and whose rest
  // subtree is suspension-free with only-pure callees. (A call node inside
  // the rest counts as sus: it is the any-hole/mixed-callee suspension
  // vector, and the cell path already handles it.)
  for (const [t, si] of sites) {
    if (t.t !== "dcall" || si.devirt === undefined) continue;
    if (pure[si.devirt] !== true) continue;
    const facts = restFacts.get(t);
    if (facts === undefined) continue;
    if (facts.sus || !facts.es.every(e => edgePure(e, pure))) continue;
    si.inlineRest = true;
  }

  return {cfnPure: pure, sites};
}

// One numeric entry's plan: the callee's concrete numeric param widths and
// return width, plus the interned numeric signature's type index.
export type NumEntry = {ws: string[], r: string, sig: number};

// Is the body shape-safe for a raw-return entry? Every dispatch tail inside
// the entry returns anyref (dispatch chains, rest thunks, handler case
// fns), so the body may contain none of them: no call/perform/handle nodes,
// no materialized letks (their jumps dispatch), and every dcall statically
// devirtualized with an inline rest (a cell-path rest dispatches; a tail
// rest return_calls the boxed anyref entry).
function entrySafeBody(fn: CFn, esc: Set<string>, sites: Map<CTerm, SiteInfo>): boolean {
  let ok = true;
  const scan = (t: CTerm): void => {
    if (!ok) return;
    switch (t.t) {
      case "call": case "perform": case "handle":
        ok = false;
        break;
      case "letk":
        if (esc.has(t.name)) { ok = false; break; } // materialized thunk unit
        scan(t.body); scan(t.rest);
        break;
      case "dcall": {
        if ((t.rest.t === "dret" || t.rest.t === "halt") &&
          t.rest.v.t === "var" && t.rest.v.name === t.name) { ok = false; break; } // tail rest
        const si = sites.get(t);
        if (si?.devirt === undefined || si.inlineRest !== true) { ok = false; break; }
        scan(t.rest);
        break;
      }
      case "let": case "bind": case "mkfn": case "scope": case "dlet": case "assign":
        scan(t.rest);
        break;
      case "if":
        scan(t.a); scan(t.b);
        break;
      case "jump": case "halt": case "dret":
        break;
    }
  };
  scan(fn.body);
  return ok;
}

// Numeric-entry eligibility per CFn. A candidate is a direct CFn whose
// deep-resolved checker type is all-concrete-numeric: deepRes resolves
// bound vars through the unifier (directly-passed lambdas included) but
// leaves quantified type vars unbound, so polymorphic fns stay ineligible,
// and anyTaint is inherited through the resolution. Emission additionally
// demands one Step-1 static call site whose arg/result stamps shape-match
// the signature — the stamps-vs-typ comparison is defensive (monomorphic
// callees unify site stamps to the param widths) but keeps a drifting site
// on the boxed static call.
export function numericEntries(
  ir: CIr, sites: Map<CTerm, SiteInfo>, deepRes: (t: Type) => Type, escs: Set<string>[],
): (NumEntry | null)[] {
  const out: (NumEntry | null)[] = ir.funcs.map(() => null);
  const width = (t: Type): string | null => {
    const w = widthOf(deepRes(t));
    return w !== null && w.concrete ? w.w : null;
  };
  const cands: {fun: number, ws: string[], r: string}[] = [];
  for (let i = 0; i < ir.funcs.length; i++) {
    const fn = ir.funcs[i];
    if (fn.direct !== true || fn.typ === undefined || fn.typ.anyTaint === true) continue;
    // A body whose dispatch tails flow through the anyref plane (handlers,
    // runtime dispatch, cell-path rests) cannot take the raw-return entry:
    // the entry's valtype result would mismatch every return_call in it.
    if (!entrySafeBody(fn, escs[i], sites)) continue;
    const ft = deepRes(fn.typ);
    if (ft.tag !== "fun") continue;
    const ws: string[] = [];
    let ok = true;
    for (const p of ft.params) {
      const w = width(p);
      if (w === null) { ok = false; break; }
      ws.push(w);
    }
    if (!ok) continue;
    const r = width(ft.ret);
    if (r === null) continue;
    cands.push({fun: i, ws, r});
  }
  if (cands.length === 0) return out;
  for (const [t, si] of sites) {
    if (si.devirt === undefined) continue;
    const c = cands.find(cc => cc.fun === si.devirt);
    if (c === undefined || out[c.fun] !== null) continue;
    const rStamp = t.t === "dcall" ? t.norm : (t as {rstamp?: string}).rstamp;
    const args = (t as {args: CAtom[]}).args;
    if (rStamp !== c.r || args.length !== c.ws.length) continue;
    let ok = true;
    for (let k = 0; k < args.length; k++) {
      if (args[k].stamp !== c.ws[k]) { ok = false; break; }
    }
    if (ok) out[c.fun] = {ws: c.ws, r: c.r, sig: numSig(c.ws, c.r)};
  }
  return out;
}
