// Optimization passes over the CPS IR, applied by toCps as the final stage
// of conversion (cps.ts): every consumer — the interpreter, the wasm
// backend — sees the same optimized term, and none of them knows the passes
// exist.
//
// Soundness rests on converter invariants (cps_ir.ts): converter temps are
// $-prefixed and fresh per conversion (region-local, never colliding with
// source names), temps bind exactly once, and a temp's uses all sit after
// its binding in term order. Regions are closed — a closure body never
// references another region's temps — so the spine term and each
// funcs[i].body are optimized independently.
//
// The passes, iterated to a fixpoint (every firing strictly shrinks the
// term, so the loop terminates):
//
// Read-temp substitution: every variable read binds a fresh temp
// (`bind $t = x`). The temp only carries information when it crosses a
// suspension (then it sits in some letk's freeze list) or when an `assign`
// to the source var can run between the read and a use. Otherwise it is a
// pure eta-expansion: drop the bind and read the source var at the use
// sites. Frozen temps of never-assigned vars are rewritten too — the freeze
// entry snapshots the var's slot at letk entry, which equals the temp's
// bind-once value when the var is never assigned. Source-named binds are
// never dropped: top-level bindings must land in the caller's frame for the
// REPL accumulator.
//
// Prim-let fusion: `let $t = prim; bind x = $t` (primLet feeding a source
// binding) collapses to `let x = prim`. The temp is consumed by the very
// next node, so no suspension can separate the prim's throw window from the
// binding, and the fused let keeps x in the frame the spine runs over.
//
// Exit-continuation beta: a letk whose body never references it and whose
// rest references it exactly once is beta-reduced at that reference. (a) A
// `jump` reference: the body, with the param replaced by the jump's
// argument, replaces the jump (the while loop's exit continuation).
// (b) A call k-operand reference whose body is a pure param-forward
// (`jump e(param)`): the operand retargets to e and the letk drops. The
// reification concern only bars splicing bodies that compute; a pure
// forward's cell is a trampoline the resume can skip — and must skip,
// or a tail-resuming case invocation chains its pending cell to the
// previous one's and a tail-resumption loop's continuation grows one link
// per iteration. Splicing is sound because the body's free temps are
// exactly the dropped freeze list: bind-once temps whose slots persist
// across resumes, so a live read at the jump site yields what the frozen
// image would have restored.
//
// Dead binding drop: a temp bound by `bind` (atoms cannot throw) or by `let`
// over a throw-free prim (allocation, @as, and op prims outside ops.ts's
// TRAPPING_OPS — the only operators that can trap) with zero uses in its
// region is dropped. Statement-position discarded values leave exactly these
// shapes; dead trapping prims (field reads, TRAPPING_OPS ops) keep their
// binding so the throw survives. Zero-use mkfns drop the same way (closure
// creation has no effects); the capts/freeze guards keep a captured or
// frozen closure value alive.
//
// Cross-function inlining (cps_inline.ts) runs ahead of these passes each
// iteration and may orphan the callee's CFn once its mkfn drops; pruneFns
// then drops unreferenced CFns and reindexes the survivors.

import {assertNever} from "../assert.ts";
import {TRAPPING_OPS} from "../ops.ts";
import {inlineCallees, pruneFns} from "./cps_inline.ts";
import type {CAtom, CIr, CPrim, CTerm} from "./cps_ir.ts";

const isTemp = (name: string): boolean => name.startsWith("$");

// Rewrite every value-position atom of one node through `f`. Continuation
// operands (jump/call/perform/handle k) are not value positions: they name
// continuations, never values, and stay put under value substitutions.
function mapAtoms(t: CTerm, f: (a: CAtom) => CAtom): void {
  switch (t.t) {
    case "bind": case "dlet": case "assign": t.val = f(t.val); return;
    case "let": mapPrimAtoms(t.rhs, f); return;
    case "call": t.fn = f(t.fn); t.args = t.args.map(f); return;
    case "dcall": t.fn = f(t.fn); t.args = t.args.map(f); return;
    case "perform": t.args = t.args.map(f); return;
    case "jump": t.arg = f(t.arg); return;
    case "halt": t.v = f(t.v); return;
    case "dret": t.v = f(t.v); return;
    case "if": t.c = f(t.c); return;
    case "letk":
      if (t.freeze !== undefined)
        t.freeze = t.freeze.map(fr => ({name: fr.name, val: f(fr.val)}));
      return;
    case "handle": case "mkfn": case "scope": return;
    default: assertNever(t);
  }
}

function mapPrimAtoms(p: CPrim, f: (a: CAtom) => CAtom): void {
  switch (p.t) {
    case "op": case "arr": p.args = p.args.map(f); return;
    case "as": p.arg = f(p.arg); return;
    case "field": p.obj = f(p.obj); return;
    default: assertNever(p);
  }
}

function rewriteChildren(t: CTerm, rw: (c: CTerm) => CTerm): void {
  switch (t.t) {
    case "letk": t.body = rw(t.body); t.rest = rw(t.rest); return;
    case "let": case "bind": case "mkfn": case "dlet": case "assign": case "scope":
      t.rest = rw(t.rest); return;
    case "dcall": t.rest = rw(t.rest); return;
    case "if": t.a = rw(t.a); t.b = rw(t.b); return;
    case "handle":
      t.body = rw(t.body);
      for (const c of t.cases)
        c.body = rw(c.body);
      return;
    case "call": case "perform": case "jump": case "halt": case "dret": return;
    default: assertNever(t);
  }
}

// All atom positions of one node, including continuation operands — the
// counting counterpart of mapAtoms (which skips k operands on purpose).
function visitRefs(t: CTerm, f: (a: CAtom) => void): void {
  switch (t.t) {
    case "bind": case "dlet": case "assign": f(t.val); return;
    case "let": mapPrimAtoms(t.rhs, (a) => { f(a); return a; }); return;
    case "call": f(t.fn); for (const a of t.args) f(a); f(t.k); return;
    case "dcall": f(t.fn); for (const a of t.args) f(a); return;
    case "perform": for (const a of t.args) f(a); f(t.k); return;
    case "jump": f(t.k); f(t.arg); return;
    case "halt": f(t.v); return;
    case "dret": f(t.v); return;
    case "if": f(t.c); return;
    case "letk": if (t.freeze !== undefined) for (const fr of t.freeze) f(fr.val); return;
    case "handle": f(t.k); return;
    case "mkfn": case "scope": return;
    default: assertNever(t);
  }
}

// References to `name` anywhere in the subtree: value atoms, continuation
// operands, and letk freeze entries (names and vals).
function countRefs(root: CTerm, name: string): number {
  let n = 0;
  const rec = (t: CTerm): CTerm => {
    if (t.t === "letk" && t.freeze !== undefined)
      for (const fr of t.freeze)
        if (fr.name === name)
          n++;
    visitRefs(t, (a) => {
      if (a.t === "var" && a.name === name)
        n++;
    });
    rewriteChildren(t, rec);
    return t;
  };
  rec(root);
  return n;
}

function varUseCounts(root: CTerm): Map<string, number> {
  const uses = new Map<string, number>();
  const rec = (t: CTerm): CTerm => {
    visitRefs(t, (a) => {
      if (a.t === "var")
        uses.set(a.name, (uses.get(a.name) ?? 0) + 1);
    });
    rewriteChildren(t, rec);
    return t;
  };
  rec(root);
  return uses;
}

function freezeNames(root: CTerm): Set<string> {
  const s = new Set<string>();
  const rec = (t: CTerm): CTerm => {
    if (t.t === "letk" && t.freeze !== undefined)
      for (const fr of t.freeze)
        s.add(fr.name);
    rewriteChildren(t, rec);
    return t;
  };
  rec(root);
  return s;
}

function collectAssigned(ir: CIr): Set<string> {
  const s = new Set<string>();
  const rec = (t: CTerm): CTerm => {
    if (t.t === "assign")
      s.add(t.name);
    rewriteChildren(t, rec);
    return t;
  };
  rec(ir.term);
  for (const fn of ir.funcs) rec(fn.body);
  return s;
}

function collectCapts(ir: CIr): Set<string> {
  return new Set(ir.funcs.flatMap(fn => fn.capts));
}

// Drop read temps whose source var is never assigned anywhere. The map is
// threaded down the walk: a temp's bind always precedes its uses, so every
// use site is visited with the mapping in place (and temp names are fresh,
// so no binder below can shadow a mapped name).
function substReadTemps(root: CTerm, assigned: Set<string>, capts: Set<string>): [term: CTerm, changed: boolean] {
  const map = new Map<string, Extract<CAtom, {t: "var"}>>();
  const changed = {v: false};
  const rw = (t: CTerm): CTerm => {
    if (t.t === "letk" && t.freeze !== undefined) {
      // A frozen read temp snapshots its source var instead: same value at
      // letk entry (the var is never assigned), restored under the var's
      // name so the substituted reads in the body resolve to it.
      const seen = new Set<string>();
      const kept: {name: string, val: CAtom}[] = [];
      for (const fr of t.freeze) {
        const rep = map.get(fr.name);
        const self = fr.val.t === "var" && fr.val.name === fr.name;
        if (rep === undefined || !self) {
          if (!seen.has(fr.name)) { seen.add(fr.name); kept.push(fr); }
          continue;
        }
        if (!seen.has(rep.name)) {
          seen.add(rep.name);
          // Carry the source stamp: the freeze snapshot must land in the
          // same representation the temp's bind produced.
          kept.push({name: rep.name, val: {t: "var", name: rep.name, stamp: rep.stamp}});
        }
      }
      t.freeze = kept.length > 0 ? kept : undefined;
    }
    mapAtoms(t, (a) => {
      if (a.t !== "var") return a;
      const rep = map.get(a.name);
      if (rep === undefined) return a;
      changed.v = true;
      return rep;
    });
    // Substituting the val first makes the mapping transitive: a temp read
    // by another temp's bind resolves to the original var, since the first
    // temp's bind is gone by the time the second one's uses are read.
    // The temp itself must never be an assign target: converter temps are
    // bind-once, but cps_inline.ts renames the callee's source binds to
    // fresh temp names, and an assigned one is a mutable slot, not a read
    // temp — dropping its bind would strand its assign targets.
    if (t.t === "bind" && isTemp(t.name) && t.val.t === "var"
        && !assigned.has(t.val.name) && !assigned.has(t.name) && !capts.has(t.name)) {
      // The substitute carries the bind's source stamp: reads normalized at
      // the temp (BigInt vs number) must stay stamped when the temp goes
      // away, or stamped ops see mixed representations.
      map.set(t.name, t.val);
      changed.v = true;
      return rw(t.rest);
    }
    rewriteChildren(t, rw);
    return t;
  };
  return [rw(root), changed.v];
}

function fuseLetBinds(root: CTerm): [term: CTerm, changed: boolean] {
  const uses = varUseCounts(root);
  const frozen = freezeNames(root);
  const changed = {v: false};
  const rw = (t: CTerm): CTerm => {
    if (t.t === "let" && isTemp(t.name) && (uses.get(t.name) ?? 0) === 1 && !frozen.has(t.name)
        && t.rest.t === "bind" && t.rest.val.t === "var" && t.rest.val.name === t.name
        && t.rest.val.stamp === undefined) {
      changed.v = true;
      const fused: CTerm = {t: "let", name: t.rest.name, rhs: t.rhs, rest: t.rest.rest};
      rewriteChildren(fused, rw);
      return fused;
    }
    rewriteChildren(t, rw);
    return t;
  };
  return [rw(root), changed.v];
}

function betaExitLetks(root: CTerm, capts: Set<string>): [term: CTerm, changed: boolean] {
  const changed = {v: false};
  const rw = (t: CTerm): CTerm => {
    if (t.t === "letk" && !capts.has(t.name)
        && countRefs(t.body, t.name) === 0 && countRefs(t.rest, t.name) === 1) {
      // (a) The single reference is a jump: splice the body into it. The
      // param must need no normalization (the spliced body reads it raw).
      if (t.norm === undefined) {
        const arg = findExitArg(t.rest, t.name);
        if (arg !== undefined) {
          changed.v = true;
          const body = t.body;
          mapAtoms(body, (a) => (a.t === "var" && a.name === t.param ? arg : a));
          const replace = (c: CTerm): CTerm => {
            if (c.t === "jump" && c.k.t === "var" && c.k.name === t.name) return body;
            rewriteChildren(c, replace);
            return c;
          };
          return replace(t.rest);
        }
      }
      // (b) The single reference is a CALL's k operand and the body is a
      // pure param-forward (`jump e(param)`): retarget the operand to e and
      // drop the letk — the pending cell was a pure trampoline. Leaving it
      // in costs more than a dispatch: every tail-resuming case invocation
      // chains its pending cell to the previous one's, so a tail-resumption
      // loop's continuation grows one link per iteration (both backends
      // retain the whole chain for the loop's lifetime). Calls only: the
      // callee is a resume binder, so the value delivered into the cell is
      // the sub-run's checker-produced completion (canonical — the param
      // norm would be a no-op). A perform's cell may also be fed by the
      // host's unhandled-op resume, whose values are un-normalized, so
      // those trampolines stay.
      const fwd = pureForwardTarget(t.body, t.param);
      if (fwd !== undefined) {
        const site = findKOperandSite(t.rest, t.name);
        if (site !== undefined) {
          site.k = {t: "var", name: fwd};
          changed.v = true;
          return t.rest;
        }
      }
    }
    rewriteChildren(t, rw);
    return t;
  };
  return [rw(root), changed.v];
}

// The exit continuation a pure param-forward letk body jumps to, if the
// body is exactly `jump e(param)`.
function pureForwardTarget(body: CTerm, param: string): string | undefined {
  if (body.t === "jump" && body.k.t === "var" && body.arg.t === "var"
      && body.arg.name === param) return body.k.name;
  return undefined;
}

// The call node whose k operand names `name`, if that unique reference
// (guaranteed by the caller's ref count) is such a node.
function findKOperandSite(c: CTerm, name: string): (CTerm & {t: "call"}) | undefined {
  if (c.t === "call" && c.k.t === "var" && c.k.name === name) return c;
  let hit: (CTerm & {t: "call"}) | undefined;
  rewriteChildren(c, (x) => {
    if (hit === undefined) hit = findKOperandSite(x, name);
    return x;
  });
  return hit;
}

// The argument of the unique jump to `name` in the subtree, if that unique
// reference (guaranteed by the caller's ref count) is a jump node.
function findExitArg(c: CTerm, name: string): CAtom | undefined {
  if (c.t === "jump" && c.k.t === "var" && c.k.name === name) return c.arg;
  const kids: CTerm[] = [];
  rewriteChildren(c, (x) => { kids.push(x); return x; });
  for (const k of kids) {
    const r = findExitArg(k, name);
    if (r !== undefined) return r;
  }
  return undefined;
}

function dropDeadBinds(root: CTerm, capts: Set<string>): [term: CTerm, changed: boolean] {
  const uses = varUseCounts(root);
  const frozen = freezeNames(root);
  const changed = {v: false};
  // Throw-free prims: allocation, @as, and operator prims outside ops.ts's
  // TRAPPING_OPS (div/rem — the only operators that can trap). A field read
  // or a trapping op prim can throw, so their dead bindings stay.
  const throwFree = (p: CPrim): boolean =>
    p.t === "arr" || p.t === "as" || (p.t === "op" && !TRAPPING_OPS.has(p.op));
  const dead = (name: string): boolean =>
    isTemp(name) && (uses.get(name) ?? 0) === 0 && !frozen.has(name) && !capts.has(name);
  const rw = (t: CTerm): CTerm => {
    if ((t.t === "bind" || t.t === "mkfn") && dead(t.name)) {
      changed.v = true;
      return rw(t.rest);
    }
    if (t.t === "let" && dead(t.name) && throwFree(t.rhs)) {
      changed.v = true;
      return rw(t.rest);
    }
    rewriteChildren(t, rw);
    return t;
  };
  return [rw(root), changed.v];
}

// Runs every pass over the spine and each closure body until none fires.
// Assigned names and capts are pass-invariant across the four local passes,
// so they are collected once; the inlining round changes both (spliced
// bodies carry new free vars and assign targets), so they are re-collected
// when it fires. The ancestry map keys each call/dcall node's splice depth
// per callee — node objects persist across iterations, so the caps hold for
// the whole optimizeCps run.
export function optimizeCps(ir: CIr): CIr {
  let assigned = collectAssigned(ir);
  let capts = collectCapts(ir);
  const depths = new WeakMap<CTerm, Map<number, number>>();
  let inlineN = 0;
  for (let i = 0; i < 100; i++) {
    // Fresh spliced-binder names must stay unique across iterations (two
    // rounds can splice into the same region), so the counter lives here.
    let changed = inlineCallees(ir, depths, assigned, () => `$il${inlineN++}`);
    if (changed) {
      capts = collectCapts(ir);
      assigned = collectAssigned(ir);
    }
    const [a, achanged] = substReadTemps(ir.term, assigned, capts);
    const [b, bchanged] = fuseLetBinds(a);
    const [c, cchanged] = betaExitLetks(b, capts);
    const [d, dchanged] = dropDeadBinds(c, capts);
    ir.term = d;
    changed = changed || achanged || bchanged || cchanged || dchanged;
    for (const fn of ir.funcs) {
      const [f1, f1changed] = substReadTemps(fn.body, assigned, capts);
      const [f2, f2changed] = fuseLetBinds(f1);
      const [f3, f3changed] = betaExitLetks(f2, capts);
      const [f4, f4changed] = dropDeadBinds(f3, capts);
      fn.body = f4;
      changed = changed || f1changed || f2changed || f3changed || f4changed;
    }
    if (changed && pruneFns(ir)) {
      capts = collectCapts(ir);
      assigned = collectAssigned(ir);
    }
    if (!changed)
      break;
  }
  return ir;
}
