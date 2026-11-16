// Cross-function inlining over the CPS IR, run by cps_opt.ts's fixpoint
// ahead of the four local passes. The pass preserves the source-level shape
// (one CPS closure per lambda, one mkfn per CFn, capts = the body's free
// value vars), so the interpreter, the wasm backend and the trace contract
// stay oblivious to it.
//
// Candidates. A call/dcall site whose callee var's provenance is a mkfn
// (mkfn temps alias through `bind` chains; names are globally unique — the
// checker rejects shadowing and redeclaration — so one unit-wide
// provenance map is exact) inlines when either:
//
// - the closure value is referenced exactly once anywhere (alias binds,
//   capts, freeze entries; each alias bind consumes one read of the
//   aliased name) and that use is this site — the closure object then
//   disappears via the dead-mkfn drop, or
//
// - the callee's body is small (SMALL_BODY nodes), with a per-callee
//   ancestry cap (MAX_DEPTH, threaded per site node through the fixpoint's
//   iterations) — recursive callees (self-references through capts) unroll
//   exactly MAX_DEPTH generations and stop.
//
// Skipped: dcall sites whose callee is not classified direct (dcall never
// suspends, so the callee cannot be), callees whose body contains a handle
// (a mixed function's tail handle k operand is the never-set `$ret`
// resolved to a terminal cell — there is no site continuation to splice),
// splices of non-direct callees into direct regions, and argument-count
// mismatches.
//
// Splice mechanics (why it is sound):
//
// - Args are atoms (converter ANF). Each param is re-let-bound to its
//   argument atom at the site (`bind $il… = arg`) — fresh bind-once temps,
//   so a param read can never observe a later assignment to the argument's
//   source var, and their cross-suspension reads flow through the freeze
//   machinery exactly like the reads they replace (param reads were read
//   temps / freeze entries, renamed along).
// - Every binder of the spliced body gets a fresh `$il` name (params, let
//   temps, source binds, letk names/params, dcall names, dlet fields,
//   nested mkfn names): the callee's frame names must not collide with the
//   receiving region's frame (the same callee can be spliced at several
//   sites). Freeze entry names and vals rename along, so the spliced letks
//   freeze exactly what they froze before; no freeze list is recomputed.
// - A non-direct callee's `$ret` (its continuation, bound by apply at
//   entry) is substituted by the site's k operand; it only ever appears in
//   the body's k operands. Direct callees deliver with `dret`: at a call
//   site each dret jumps the site's k; at a dcall site the result flows to
//   `name` — a single-dret body rewrites the dret into the result bind,
//   otherwise a freeze-free wrapper letk takes the delivery (eval.ts's
//   adhocK captures nothing either; direct bodies never suspend, so the
//   wrapper is never re-entered multi-shot). numKind normalization is
//   preserved: a call's k operand is a norm-carrying wrapper letk or a
//   normless tail, and a dcall's norm moves onto the delivered atom's
//   stamp — evalAtom and wasm's pushAtom normalize stamped atoms, while a
//   non-materialized letk entry does not, so the stamp rides the atom
//   rather than the wrapper letk.
// - Capts are by-reference reads of the defining scope's frame, and names
//   are globally unique, so a capt read at the call site resolves to the
//   same slot the closure's env chain would have read — live-frame
//   semantics are identical. Splicing into a closure body adds the
//   callee's capts to that body's free vars, so capts lists are recomputed
//   from the bodies after the pass (converter recipe:
//   freeVars(body, {RET, …params})) and mkfn capts lists are re-synced.
// - Closures created inside the callee are cloned into fresh CFns for the
//   splice: wasm pins each CFn's frame layout to the first-planned mkfn
//   site's scope chain (cfnBase), so a shared body read through a second
//   creation site would resolve its capts against the wrong frame. Clones
//   rename references to the spliced body's binders (they surface as
//   capts of the nested CFns); the nested fns' own binders keep their
//   names, and their `$ret`/dret boundaries are copied verbatim.
//
// Termination: a call/dcall node fires at most once (it is replaced by
// fresh nodes); a spliced site's ancestry depth is fixed at creation, so
// per-callee nesting is capped and the splice tree is finite. Term growth
// per firing is bounded by the body size times that tree.

import {assertNever} from "../assert.ts";
import {RET} from "./cps.ts";
import type {CAtom, CFn, CIr, CPrim, CTerm} from "./cps_ir.ts";

// Body-node budget for the small-body rule; ancestry cap for recursive
// callees (each generation's sites carry depth + 1).
const SMALL_BODY = 16;
const MAX_DEPTH = 1;

// Child replacement walk over the CPS IR (the same traversal cps_opt.ts's
// passes share; kept local to keep cps_ir.ts a types-only leaf).
function rewriteChildren(t: CTerm, rw: (c: CTerm) => CTerm): void {
  switch (t.t) {
    case "letk": t.body = rw(t.body); t.rest = rw(t.rest); return;
    case "let": case "bind": case "mkfn": case "dlet": case "assign": case "scope":
      t.rest = rw(t.rest); return;
    case "dcall": t.rest = rw(t.rest); return;
    case "if": t.a = rw(t.a); t.b = rw(t.b); return;
    case "handle":
      t.body = rw(t.body);
      for (const c of t.cases) c.body = rw(c.body);
      return;
    case "call": case "perform": case "jump": case "halt": case "dret": return;
    default: assertNever(t);
  }
}

// name → the fun whose closure value the name provably holds, or undefined
// when the name is bound to something unprovable (assigned names, params,
// builtin values, `_` rebinds). Bind aliases follow `bind` chains.
function provenance(ir: CIr, assigned: Set<string>): Map<string, number | undefined> {
  const prov = new Map<string, number | undefined>();
  // Pass 1 registers every mkfn name first: a capt read reaches across
  // units, so a bind in one region can alias a closure bound in another.
  const binders = (t: CTerm): void => {
    switch (t.t) {
      case "mkfn":
        prov.set(t.name, assigned.has(t.name) ? undefined : t.fun);
        binders(t.rest);
        return;
      case "letk": binders(t.body); binders(t.rest); return;
      case "let": case "bind": case "dcall": case "dlet": case "assign": case "scope":
        binders(t.rest); return;
      case "if": binders(t.a); binders(t.b); return;
      case "handle": binders(t.body); for (const c of t.cases) binders(c.body); return;
      case "call": case "perform": case "jump": case "halt": case "dret": return;
      default: assertNever(t);
    }
  };
  // Pass 2 resolves bind aliases; binders precede their uses in term order
  // (and nested lambdas get higher funcs indices than their parents), so a
  // single ordered walk sees every val's provenance.
  const aliases = (t: CTerm): void => {
    switch (t.t) {
      case "bind":
        prov.set(t.name, t.val.t === "var" && !assigned.has(t.name)
          ? prov.get(t.val.name)
          : undefined);
        aliases(t.rest);
        return;
      case "letk": aliases(t.body); aliases(t.rest); return;
      case "let": case "mkfn": case "dcall": case "dlet": case "assign": case "scope":
        aliases(t.rest); return;
      case "if": aliases(t.a); aliases(t.b); return;
      case "handle": aliases(t.body); for (const c of t.cases) aliases(c.body); return;
      case "call": case "perform": case "jump": case "halt": case "dret": return;
      default: assertNever(t);
    }
  };
  binders(ir.term);
  for (const fn of ir.funcs) binders(fn.body);
  aliases(ir.term);
  for (const fn of ir.funcs) aliases(fn.body);
  return prov;
}

// Reference counts for the single-use test: every var atom (value
// positions and continuation operands), every freeze entry name and val,
// and every mkfn capt occurrence — a capture is a genuine use of the
// closure. aliasBinds counts, per name, the pure `bind x = var name`
// forwards: each consumes one read of the aliased name and re-exposes it,
// so it nets out of the use count.
function refInfo(ir: CIr): {refs: Map<string, number>, aliasBinds: Map<string, number>} {
  const refs = new Map<string, number>();
  const aliasBinds = new Map<string, number>();
  const bump = (name: string): void => {
    refs.set(name, (refs.get(name) ?? 0) + 1);
  };
  const bumpVar = (a: CAtom): void => {
    if (a.t === "var") bump(a.name);
  };
  const primAtoms = (p: CPrim): void => {
    switch (p.t) {
      case "op": case "arr": for (const a of p.args) bumpVar(a); return;
      case "as": bumpVar(p.arg); return;
      case "field": bumpVar(p.obj); return;
      default: assertNever(p);
    }
  };
  const rec = (t: CTerm): void => {
    switch (t.t) {
      case "bind":
        bumpVar(t.val);
        if (t.val.t === "var") aliasBinds.set(t.val.name, (aliasBinds.get(t.val.name) ?? 0) + 1);
        break;
      case "dlet": case "assign": bumpVar(t.val); break;
      case "let": primAtoms(t.rhs); break;
      case "call": bumpVar(t.fn); for (const a of t.args) bumpVar(a); bumpVar(t.k); break;
      case "dcall": bumpVar(t.fn); for (const a of t.args) bumpVar(a); break;
      case "perform": for (const a of t.args) bumpVar(a); bumpVar(t.k); break;
      case "jump": bumpVar(t.k); bumpVar(t.arg); break;
      case "halt": bumpVar(t.v); break;
      case "dret": bumpVar(t.v); break;
      case "if": bumpVar(t.c); break;
      case "letk":
        if (t.freeze !== undefined)
          for (const fr of t.freeze) {
            bump(fr.name);
            bumpVar(fr.val);
          }
        break;
      case "handle": bumpVar(t.k); break;
      case "mkfn":
        for (const c of t.capts) bump(c);
        break;
      case "scope": break;
      default: assertNever(t);
    }
    rewriteChildren(t, (c) => {
      rec(c);
      return c;
    });
  };
  rec(ir.term);
  for (const fn of ir.funcs) rec(fn.body);
  return {refs, aliasBinds};
}

// Uses of the closure funcs[J] hold: reads of every name whose provenance
// is J, minus the alias forwards.
function closureUses(prov: Map<string, number | undefined>, info: ReturnType<typeof refInfo>): Map<number, number> {
  const uses = new Map<number, number>();
  for (const [nm, p] of prov) {
    if (typeof p !== "number") continue;
    const net = (info.refs.get(nm) ?? 0) - (info.aliasBinds.get(nm) ?? 0);
    uses.set(p, (uses.get(p) ?? 0) + net);
  }
  return uses;
}

function termSize(t: CTerm): number {
  let n = 1;
  rewriteChildren(t, (c) => {
    n += termSize(c);
    return c;
  });
  return n;
}

function hasHandle(t: CTerm): boolean {
  let found = t.t === "handle";
  rewriteChildren(t, (c) => {
    if (!found && hasHandle(c)) found = true;
    return c;
  });
  return found;
}

function countDrets(t: CTerm): number {
  let n = t.t === "dret" ? 1 : 0;
  rewriteChildren(t, (c) => {
    n += countDrets(c);
    return c;
  });
  return n;
}

// Whether the body's tail chain opens scopes before its delivery: spine
// splices must not nest the host rest under a new frame.
function wrapsScope(t: CTerm): boolean {
  let cur = t;
  while (cur.t === "scope") cur = cur.rest;
  return cur.t !== "letk" && cur.t !== "let" && cur.t !== "bind" && cur.t !== "dcall" &&
    cur.t !== "mkfn" && cur.t !== "dlet" && cur.t !== "assign";
}

// Binders of one region: every name the splice must rename to keep the
// callee's frame names out of the receiving region's frame.
function collectBinders(t: CTerm, out: string[]): void {
  switch (t.t) {
    case "letk":
      out.push(t.name, t.param);
      collectBinders(t.body, out);
      collectBinders(t.rest, out);
      return;
    case "let": case "bind": case "mkfn": case "dcall":
      out.push(t.name);
      collectBinders(t.rest, out);
      return;
    case "dlet":
      out.push(...t.fields);
      collectBinders(t.rest, out);
      return;
    case "assign": case "scope":
      collectBinders(t.rest, out);
      return;
    case "if":
      collectBinders(t.a, out);
      collectBinders(t.b, out);
      return;
    case "handle":
      out.push(t.ret);
      collectBinders(t.body, out);
      for (const c of t.cases) {
        out.push(c.resume, ...c.params);
        collectBinders(c.body, out);
      }
      return;
    case "call": case "perform": case "jump": case "halt": case "dret":
      return;
    default: assertNever(t);
  }
}

// Capts must track the bodies' free vars (splicing moves the callee's
// capts into the receiving region's free vars); the converter's recipe
// recomputes them and the mkfn capts lists are re-synced to match.
function refreshCapts(ir: CIr): void {
  for (const fn of ir.funcs) {
    const bound = new Set<string>([RET, ...fn.params]);
    fn.capts = freeVars(fn.body, bound);
  }
  const sync = (t: CTerm): void => {
    if (t.t === "mkfn") t.capts = [...ir.funcs[t.fun].capts];
    rewriteChildren(t, (c) => {
      sync(c);
      return c;
    });
  };
  sync(ir.term);
  for (const fn of ir.funcs) sync(fn.body);
}

// Converter recipe (cps.ts's convLambda): the body's free vars outside
// `$ret` and the params.
function freeVars(t: CTerm, bound: Set<string>): string[] {
  const free = new Set<string>();
  const walk = (t: CTerm, bound: Set<string>): void => {
    const atom = (a: CAtom): void => {
      if (a.t === "var" && !bound.has(a.name)) free.add(a.name);
    };
    const withB = (names: string[]): Set<string> => {
      const b = new Set(bound);
      for (const nm of names) b.add(nm);
      return b;
    };
    switch (t.t) {
      case "letk":
        walk(t.body, withB([t.name, t.param]));
        walk(t.rest, withB([t.name]));
        return;
      case "let":
        if (t.rhs.t === "op" || t.rhs.t === "arr") for (const a of t.rhs.args) atom(a);
        else if (t.rhs.t === "as") atom(t.rhs.arg);
        else atom(t.rhs.obj);
        walk(t.rest, withB([t.name]));
        return;
      case "bind":
        atom(t.val);
        walk(t.rest, withB([t.name]));
        return;
      case "mkfn":
        walk(t.rest, withB([t.name]));
        return;
      case "call":
        atom(t.fn);
        for (const a of t.args) atom(a);
        atom(t.k);
        return;
      case "dcall":
        atom(t.fn);
        for (const a of t.args) atom(a);
        walk(t.rest, withB([t.name]));
        return;
      case "perform":
        for (const a of t.args) atom(a);
        atom(t.k);
        return;
      case "handle": {
        walk(t.body, withB([t.ret]));
        for (const c of t.cases)
          walk(c.body, withB([t.exit, c.resume, ...c.params]));
        return;
      }
      case "if":
        atom(t.c);
        walk(t.a, bound);
        walk(t.b, bound);
        return;
      case "scope":
        walk(t.rest, bound);
        return;
      case "dlet":
        atom(t.val);
        walk(t.rest, withB(t.fields));
        return;
      case "assign":
        atom(t.val);
        walk(t.rest, bound);
        return;
      case "jump":
        atom(t.k);
        atom(t.arg);
        return;
      case "halt":
        atom(t.v);
        return;
      case "dret":
        atom(t.v);
        return;
      default: assertNever(t);
    }
  };
  walk(t, bound);
  return [...free];
}

// Drop CFns no mkfn references (single-use inlining orphans the callee's
// body once its mkfn is dead-dropped) and reindex the survivors.
export function pruneFns(ir: CIr): boolean {
  const used = new Set<number>();
  const walk = (t: CTerm): void => {
    if (t.t === "mkfn") used.add(t.fun);
    rewriteChildren(t, (c) => {
      walk(c);
      return c;
    });
  };
  walk(ir.term);
  for (const fn of ir.funcs) walk(fn.body);
  if (used.size === ir.funcs.length) return false;
  const remap = new Map<number, number>();
  const kept: CFn[] = [];
  for (const [i, fn] of ir.funcs.entries()) {
    if (used.has(i)) {
      remap.set(i, kept.length);
      kept.push(fn);
    }
  }
  ir.funcs = kept;
  const reindex = (t: CTerm): void => {
    if (t.t === "mkfn") t.fun = remap.get(t.fun)!;
    rewriteChildren(t, (c) => {
      reindex(c);
      return c;
    });
  };
  reindex(ir.term);
  for (const fn of ir.funcs) reindex(fn.body);
  return true;
}

// Runs one inlining round over the spine and every closure body. `depths`
// threads each site's splice ancestry across the optimizer's fixpoint
// iterations (keyed on the node object; clones are fresh nodes). `assigned`
// grows with the renamed assign targets the splice introduces.
export function inlineCallees(ir: CIr, depths: WeakMap<CTerm, Map<number, number>>, assigned: Set<string>, fresh: () => string): boolean {
  const prov = provenance(ir, assigned);
  const info = refInfo(ir);
  const uses = closureUses(prov, info);
  const handleFree = new Map<number, boolean>();
  const sizes = new Map<number, number>();
  // Callee-graph recursion: any closure that can reach itself through
  // provenance-resolved calls — directly or mutually — never unrolls. Each
  // generation's recursive call sites lose the tail-dcall shape wasm's
  // inlineRest turns into a wasm loop (deep tail recursion would overflow),
  // and mutual cycles re-seed fresh depth-0 sites from the surviving
  // original regions every iteration.
  const recursive = new Set<number>();
  const edges = new Map<number, number[]>();
  const collectEdges = (t: CTerm, fun: number): void => {
    if ((t.t === "call" || t.t === "dcall") && t.fn.t === "var") {
      const target = prov.get(t.fn.name);
      if (typeof target === "number") {
        const list = edges.get(fun);
        if (list === undefined || !list.includes(target)) edges.set(fun, [...(list ?? []), target]);
      }
    }
    rewriteChildren(t, (c) => {
      collectEdges(c, fun);
      return c;
    });
  };
  for (const [i, fn] of ir.funcs.entries()) collectEdges(fn.body, i);
  const reaches = (from: number, target: number, seen: Set<number>): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const nxt of edges.get(from) ?? []) if (reaches(nxt, target, seen)) return true;
    return false;
  };
  for (const f of edges.keys()) if (reaches(f, f, new Set())) recursive.add(f);

  const process = (root: CTerm, regionDirect: boolean, spine: boolean): [CTerm, boolean] => {
    let fired = false;
    const walk = (t: CTerm): CTerm => {
      const rep = splice(t, regionDirect, spine);
      if (rep !== undefined) {
        fired = true;
        return walk(rep);
      }
      rewriteChildren(t, walk);
      return t;
    };
    return [walk(root), fired];
  };

  const splice = (t: CTerm, regionDirect: boolean, spine: boolean): CTerm | undefined => {
    if (t.t !== "call" && t.t !== "dcall") return undefined;
    if (t.fn.t !== "var") return undefined;
    const fun = prov.get(t.fn.name);
    if (typeof fun !== "number") return undefined;
    const cfn = ir.funcs[fun];
    if (t.t === "dcall" && cfn.direct !== true) return undefined;
    if (t.t === "call" && regionDirect && cfn.direct !== true) return undefined;
    if (t.args.length !== cfn.params.length) return undefined;
    let hf = handleFree.get(fun);
    if (hf === undefined) {
      hf = !hasHandle(cfn.body);
      handleFree.set(fun, hf);
    }
    if (!hf) return undefined;
    // The REPL accumulator contract (eval.ts's runLine): top-level binds
    // must land in the caller's frame. A spine splice keeps that only when
    // the delivery is the single-dret result bind — a wrapper letk would
    // run the host rest inside the continuation's env, and scopes nesting
    // the dret would push a frame between the top frame and the following
    // binds.
    const drets = countDrets(cfn.body);
    if (spine && (drets !== 1 || wrapsScope(cfn.body))) return undefined;
    const single = uses.get(fun) === 1;
    if (!single) {
      if (recursive.has(fun)) return undefined;
      let size = sizes.get(fun);
      if (size === undefined) {
        size = termSize(cfn.body);
        sizes.set(fun, size);
      }
      const site = depths.get(t);
      if (size > SMALL_BODY || (site?.get(fun) ?? 0) >= MAX_DEPTH) return undefined;
    }

    return buildSplice(t, fun, cfn, spine);
  };

  const buildSplice = (t: CTerm & ({t: "call"} | {t: "dcall"}), fun: number, cfn: CFn, spine: boolean): CTerm => {
    // Every binder of the spliced body gets a fresh name.
    const ren = new Map<string, string>();
    const rn = (name: string): string => ren.get(name) ?? name;
    for (const p of cfn.params) ren.set(p, fresh());
    const binders: string[] = [];
    collectBinders(cfn.body, binders);
    for (const b of binders) ren.set(b, fresh());

    // A multi-dret direct callee delivers through a wrapper letk: the
    // host rest moves into its body, the drets jump it.
    const drets = countDrets(cfn.body);
    const wrapName = t.t === "dcall" && drets > 1 ? fresh() : undefined;
    const wrapParam = wrapName !== undefined ? fresh() : undefined;
    // The site's delivery target for `$ret` (non-direct) and dret tails.
    const retK: CAtom | undefined = t.t === "call"
      ? t.k
      : wrapName !== undefined ? {t: "var", name: wrapName} : undefined;

    const cloneVal = (a: CAtom): CAtom =>
      a.t === "var" && ren.has(a.name) ? {...a, name: ren.get(a.name)!} : {...a};

    const clonePrim = (p: CPrim): CPrim => {
      switch (p.t) {
        case "op": case "arr": return {...p, args: p.args.map(cloneVal)};
        case "as": return {...p, arg: cloneVal(p.arg)};
        case "field": return {...p, obj: cloneVal(p.obj)};
        default: assertNever(p);
      }
    };

    // `$ret` substitutes only in the spliced body itself (top); nested
    // closure bodies own their `$ret`.
    const cloneK = (a: CAtom, top: boolean): CAtom => {
      if (top && a.t === "var" && a.name === RET) {
        if (retK === undefined)
          throw new Error("internal: inlining a direct callee whose body references $ret");
        return {...retK};
      }
      return cloneVal(a);
    };

    const cloneFn = (src: CFn): number => {
      const cloned: CFn = {
        params: src.params,
        capts: src.capts.map(rn),
        typ: src.typ,
        direct: src.direct,
        body: undefined as unknown as CTerm,
      };
      const idx = ir.funcs.push(cloned) - 1;
      cloned.body = cloneTerm(src.body, false);
      return idx;
    };

    const cloneTerm = (x: CTerm, top: boolean): CTerm => {
      switch (x.t) {
        case "letk":
          return {
            t: "letk", name: rn(x.name), param: rn(x.param),
            norm: x.norm,
            freeze: x.freeze === undefined
              ? undefined
              : x.freeze.map(fr => ({name: rn(fr.name), val: cloneVal(fr.val)})),
            body: cloneTerm(x.body, top), rest: cloneTerm(x.rest, top),
          };
        case "let":
          return {t: "let", name: rn(x.name), rhs: clonePrim(x.rhs), rest: cloneTerm(x.rest, top)};
        case "bind":
          return {t: "bind", name: rn(x.name), val: cloneVal(x.val), rest: cloneTerm(x.rest, top)};
        case "mkfn": {
          const idx = cloneFn(ir.funcs[x.fun]);
          return {
            t: "mkfn", name: rn(x.name), params: x.params, capts: x.capts.map(rn),
            fun: idx, rest: cloneTerm(x.rest, top),
          };
        }
        case "call":
          return {
            t: "call", fn: cloneVal(x.fn), args: x.args.map(cloneVal),
            k: cloneK(x.k, top), rstamp: x.rstamp,
          };
        case "dcall":
          return {
            t: "dcall", fn: cloneVal(x.fn), args: x.args.map(cloneVal),
            name: rn(x.name), norm: x.norm, rest: cloneTerm(x.rest, top),
          };
        case "perform":
          return {t: "perform", op: x.op, args: x.args.map(cloneVal), k: cloneK(x.k, top)};
        case "handle":
          throw new Error("internal: inlining a callee whose body contains a handle");
        case "if":
          return {t: "if", c: cloneVal(x.c), a: cloneTerm(x.a, top), b: cloneTerm(x.b, top)};
        case "scope":
          return {t: "scope", rest: cloneTerm(x.rest, top)};
        case "dlet":
          return {
            t: "dlet", val: cloneVal(x.val), fields: x.fields.map(rn),
            rest: cloneTerm(x.rest, top),
          };
        case "assign":
          return {t: "assign", name: rn(x.name), val: cloneVal(x.val), rest: cloneTerm(x.rest, top)};
        case "jump":
          return {t: "jump", k: cloneK(x.k, top), arg: cloneVal(x.arg)};
        case "halt":
          return {t: "halt", v: cloneVal(x.v)};
        case "dret":
          if (!top) return {t: "dret", v: cloneVal(x.v)};
          return deliver(x.v);
        default: assertNever(x);
      }
    };

    // A direct callee's completion at this site: jump the call site's k,
    // or bind the dcall result (norm rides the delivered atom's stamp —
    // non-materialized letk entries don't normalize, stamped atoms do in
    // both backends).
    const deliver = (v: CAtom): CTerm => {
      const cv = cloneVal(v);
      if (t.t === "call") return {t: "jump", k: {...t.k}, arg: cv};
      const nv: CAtom = t.norm === undefined ? cv : {...cv, stamp: t.norm};
      if (wrapName === undefined)
        return {t: "bind", name: t.name, val: nv, rest: t.rest};
      return {t: "jump", k: {t: "var", name: wrapName}, arg: nv};
    };

    // Params re-bind to the site's argument atoms, then the spliced body.
    // Arg atoms are HOST reads (binders live in the receiving region) — for
    // self-recursion host and callee are the same region, so the args must
    // bypass the rename map or their reads would dangle. Spine splices also
    // strip the callee body's leading scopes: they would push a frame
    // between the caller's frame and the host rest, breaking the REPL
    // accumulator's frame contract.
    let body = cloneTerm(cfn.body, true);
    if (spine)
      while (body.t === "scope") body = body.rest;
    for (let i = cfn.params.length - 1; i >= 0; i--)
      body = {t: "bind", name: ren.get(cfn.params[i])!, val: {...t.args[i]}, rest: body};

    // Splice ancestry for the fresh sites: one level deeper for this
    // callee. Existing node maps stay (never overwritten — a lowered depth
    // could uncap a chain).
    const m = new Map(depths.get(t) ?? []);
    m.set(fun, (m.get(fun) ?? 0) + 1);
    const note = (x: CTerm): void => {
      if ((x.t === "call" || x.t === "dcall") && !depths.has(x)) depths.set(x, m);
      rewriteChildren(x, (c) => {
        note(c);
        return c;
      });
    };
    note(body);

    if (t.t === "call") return body;
    // dcall: the spliced body takes the site's place; with a wrapper, the
    // host rest moves into the wrapper's body.
    if (wrapName === undefined) return body;
    return {
      t: "letk", name: wrapName, param: wrapParam!,
      body: {
        t: "bind", name: t.name,
        val: t.norm === undefined
          ? {t: "var", name: wrapParam!}
          : {t: "var", name: wrapParam!, stamp: t.norm},
        rest: t.rest,
      },
      rest: body,
    };
  };

  const [term, tChanged] = process(ir.term, false, true);
  ir.term = term;
  let changed = tChanged;
  const nUnits = ir.funcs.length;
  for (let i = 0; i < nUnits; i++) {
    const fn = ir.funcs[i];
    const [body, fChanged] = process(fn.body, fn.direct === true, false);
    fn.body = body;
    if (fChanged) changed = true;
  }

  if (changed) refreshCapts(ir);
  return changed;
}
