// IR term emitters (stage 2): wasm codegen over the CPS IR from cps.ts.
// Every "rest of computation" already exists in the IR as a named `letk`
// continuation, so the emitter is a direct term walk:
//
// - non-materialized letks (referenced only by jumps from code that cannot
//   have suspended since their installation) become wasm blocks (loops when
//   the body jumps back); `jump` stores the param into the letk's slot and
//   brs. Their freeze lists are vacuous: no suspension can occur between
//   installation and entry, and temps are bind-once per prim site.
// - materialized letks (named as call/perform/handle k operands, or jumped
//   to from inside a materialized letk's body — i.e. any cross-fn
//   reference) install a K_RET cell {thunk, F_n, next = ambient k} at
//   execution; their body emits into a T_III_I thunk (frame, v, kNext).
//   The freeze temps are captured into F_n at installation (multi-shot
//   frozen accs); each entry runs over a fresh activation frame. In the
//   thunk, $ret/$exit resolve to the kNext param.
// - `call` is always a tail call (the term has nothing after it; the k
//   operand carries the rest), reusing emitCallClosure's boxed ABI.
// - `perform` boxes its atoms into the op-args carrier, resolves the
//   k-operand cell (the reified continuation — the converter guarantees it
//   denotes the ambient continuation), walks the ambient chain for a
//   K_HDL, builds the resume record over the slice [k-cell .. handler)
//   and tail-calls the case body over an hframe copy; with no handler the
//   host fallback runs and the value dispatches through the k cell.
// - `handle` installs a K_HDL {case table, hframe, next = the k-operand
//   cell}; the body emits inline with the ret binder bound to the HDL
//   (frame slot + local); case bodies emit as T_KABI functions over the
//   hframe with the exit binder bound to their k param. The Return case's
//   resume binder (identity returning the done value) is materialized by
//   the ret case fn's prologue.
//
// The frame model mirrors the interpreter's Env chain exactly (that is the
// contract capts/freeze assume): scope nodes, materialized-letk definition
// frames and their per-entry activation frames, and CFn param frames all
// extend; non-materialized letks bind their param in the current frame;
// bind/let/mkfn/dlet store into the current frame; a handle's ret-binder
// slot lives in the current frame. Frame sizes and slot indices come from
// a planning pass (planIr) whose traversal mirrors emitTerm's exactly;
// findings attach to the IR nodes (a per-compile artifact nothing else
// reads afterwards).

import binaryen from "binaryen";
import * as w from "./wasm_consts.ts";
import {WasmError, _T, type ValueRef} from "./wasm_types.ts";
import {BUILTINS} from "./analysis.ts";
import {DBGTRACE} from "./wasm_tables.ts";
import {type CIr, type CTerm, type CAtom, type CPrim} from "./cps_ir.ts";
import {type Buf, Fn} from "./wasm_body.ts";
import {type Emit, emitDispatch, emitCaseScan, selectBool, emitFail, i31of, makeRestThunk, cellGet, CMP_OPS, emitCallClosure, emitDirectEntryCall, tracePoint} from "./wasm_emit.ts";

// ---------------------------------------------------------------------------
// Static scope: frame-slot resolution mirroring the interpreter's Env chain.
// Levels only grow during a unit walk (a scope's rest runs inside the
// extended frame; a materialized letk's rest runs inside its F_n), so there
// are no pops. levels[0] is the innermost (current) frame. The plan and the
// emitter share the same level objects (both traversals construct the chains
// identically).
type TLevel = {
  slots: Map<string, number>,
  size: number,
  // Same-fn local bindings ($ret, a handle's ret binder, a case's exit
  // binder). Dropped when the scope is replayed into a thunk: $ret/$exit
  // resolve to the thunk's kNext param there.
  locals: Map<string, number> | null,
};
type TScope = TLevel[];

function lvl(): TLevel {
  return {slots: new Map(), size: 0, locals: null};
}
function addSlot(l: TLevel, name: string): number {
  const i = l.size++;
  l.slots.set(name, i);
  return i;
}
function addLocal(l: TLevel, name: string, local: number): void {
  if (l.locals === null) l.locals = new Map();
  l.locals.set(name, local);
}

function resolveT(ts: TScope, name: string): {d: number, i: number, local: number | null} | null {
  // Same-fn local bindings ($ret, a handle's HDL cell, a case's exit) are
  // function-level: they resolve at any frame depth (scope nodes push the
  // binding level deeper, but the local stays valid). Thunk scopes demote
  // all locals, so nothing leaks across functions.
  for (const l of ts) {
    const loc = l.locals?.get(name);
    if (loc !== undefined) return {d: -1, i: -1, local: loc};
  }
  for (let d = 0; d < ts.length; d++) {
    const i = ts[d].slots.get(name);
    if (i !== undefined) return {d, i, local: null};
  }
  return null;
}

// ---------------------------------------------------------------------------
// Node annotations (per-compile; attached by planUnit, read by emitTerm).
type LetkP = {
  mat: boolean,
  fnSlot?: number,           // F_n slot holding the continuation cell
  fnLvl?: TLevel,            // F_n's level — size read at emit time (the
  // rest's bindings land in F_n after __p was attached, so the size is
  // only final once planning completes)
  freezeSlots?: Map<string, number>,
  entryScope?: TScope,       // thunk body base: [entry, F_n, ...site]
  restScope?: TScope,        // the rest runs inside F_n: [F_n, ...site]
  isLoop?: boolean,          // the body jumps back to this letk
  bodyEsc?: Set<string>,     // the thunk body's own escape set
  param?: string,            // the param name (label delivery target)
  thunk?: Fn,                // created at emission
  paramSlot?: number,        // non-materialized: the param's slot
};
type CaseP = {base: TScope, esc: Set<string>, fnIdx: number};
type HdlP = {
  hdlIdx: number,
  hframeSize: number,
  retSlot: number,
  caseP: CaseP[],            // op cases, declaration order
  retP?: CaseP,              // the Return case
  idRetIdx?: number,         // no-Return-case identity ret (npMax > 0)
  retResumeIdx?: number,     // ret case's identity resume binder
};
type ScopeP = TLevel;

type ALetk = CTerm & {t: "letk"} & {__p?: LetkP};
type AHandle = CTerm & {t: "handle"} & {__p?: HdlP};
type AScope = CTerm & {t: "scope"} & {__p?: ScopeP};
type DcallP = {
  entryScope?: TScope,       // thunk rest base: [entry, F_n, ...site]
  bodyEsc?: Set<string>,     // the rest's own escape set
  fnLvl?: TLevel,            // the cell's frame (F_n)
  thunk?: Fn,                // created at emission
};
type ADcall = CTerm & {t: "dcall"} & {__p?: DcallP};

// ---------------------------------------------------------------------------
// Escape analysis.
//
// Materialized = named as a call/perform/handle k operand, or referenced
// from inside a materialized letk's body (fixpoint: materializing a letk
// makes its body a cross-fn unit, whose continuation references force
// further materializations). Case bodies never reference outer letk names
// (the converter converts them with the exit tail only), and nested CFns
// cannot either (each is converted independently), so the analysis runs
// per-term with the bound-within-body-subtree rule below.

function numberLetks(t: CTerm, opKs: Set<string>, at: Map<string, {enter: number, exit: number}>, st: {n: number}): void {
  const enter = st.n++;
  switch (t.t) {
    case "letk":
      numberLetks(t.body, opKs, at, st);
      numberLetks(t.rest, opKs, at, st);
      at.set(t.name, {enter, exit: st.n++});
      break;
    case "let": case "bind": case "mkfn": case "dlet": case "assign": case "scope":
      numberLetks(t.rest, opKs, at, st);
      break;
    case "dcall":
      // The rest runs inside a thunk: its k operands must materialize their
      // targets like any other cross-unit reference. Register the rest's
      // letks BEFORE the operand scan — the rest's spine shares the site's
      // numbering scope (its letk ranges stay inside this range).
      numberLetks(t.rest, opKs, at, st);
      break;
    case "call": case "perform":
      if (t.k.t === "var") opKs.add(t.k.name); // the k operand's cell is
      // entered at runtime (the call's completion / the resume's dispatch)
      // — its letk, if any, must be materialized.
      break;
    case "handle":
      if (t.k.t === "var") opKs.add(t.k.name);
      numberLetks(t.body, opKs, at, st);
      for (const c of t.cases) numberLetks(c.body, opKs, at, st);
      break;
    case "if":
      numberLetks(t.a, opKs, at, st);
      numberLetks(t.b, opKs, at, st);
      break;
    default:
      break; // jump/halt: no letk bindings
  }
}

function analyzeEscapes(term: CTerm): Set<string> {
  const opKs = new Set<string>();
  const letkAt = new Map<string, {enter: number, exit: number}>();
  numberLetks(term, opKs, letkAt, {n: 0});
  const esc = new Set(opKs);
  const boundOutside = (name: string, root: {enter: number, exit: number} | null): boolean => {
    const bnd = letkAt.get(name);
    if (bnd === undefined) return false; // a runtime binding, not a letk
    return root === null || !(bnd.enter >= root.enter && bnd.exit <= root.exit);
  };
  const walk = (t: CTerm, root: {enter: number, exit: number} | null): void => {
    switch (t.t) {
      case "letk": {
        const range = letkAt.get(t.name)!;
        const inner = esc.has(t.name) ? range : root;
        walk(t.body, inner);
        walk(t.rest, root);
        break;
      }
      case "let": case "bind": case "mkfn": case "dlet": case "assign": case "scope":
        walk(t.rest, root);
        break;
      case "dcall":
        // The rest runs inside a materialized thunk, so any letk it jumps to
        // must materialize — boundedOutside against a range nothing falls
        // inside marks every jumped name.
        walk(t.rest, {enter: -1, exit: -1});
        break;
      case "call": case "perform":
        if (t.k.t === "var" && boundOutside(t.k.name, root)) esc.add(t.k.name);
        break;
      case "jump":
        // A jump from inside a MATERIALIZED unit (a thunk body) to an
        // outer letk cannot be a label br (cross-function) — the target
        // must materialize too. Non-materialized contexts jump by label.
        if (root !== null && t.k.t === "var" && boundOutside(t.k.name, root))
          esc.add(t.k.name);
        break;
      case "handle":
        if (t.k.t === "var" && boundOutside(t.k.name, root)) esc.add(t.k.name);
        walk(t.body, root);
        for (const c of t.cases) walk(c.body, root);
        break;
      case "if":
        walk(t.a, root);
        walk(t.b, root);
        break;
      default:
        break;
    }
  };
  let before = -1;
  while (esc.size !== before) {
    before = esc.size;
    walk(term, null);
  }
  return esc;
}

// A letk whose own body jumps back to it needs a wasm `loop`, not `block`.
function jumpsTo(t: CTerm, name: string): boolean {
  switch (t.t) {
    case "jump": return t.k.t === "var" && t.k.name === name;
    case "letk": return jumpsTo(t.body, name) || jumpsTo(t.rest, name);
    case "let": case "bind": case "mkfn": case "dlet": case "assign": case "scope":
      return jumpsTo(t.rest, name);
    case "dcall": return jumpsTo(t.rest, name);
    case "call": case "perform": return false;
    case "handle":
      return jumpsTo(t.body, name) || t.cases.some(c => jumpsTo(c.body, name));
    case "if": return jumpsTo(t.a, name) || jumpsTo(t.b, name);
    default: return false;
  }
}

// Top-level bind names in a term spine (they land in the frame the spine
// runs over; deeper binds live in scope/letk child frames or units).
function countTopBinds(t: CTerm): number {
  switch (t.t) {
    case "bind": case "let": case "mkfn": return 1 + countTopBinds(t.rest);
    case "dlet": return t.fields.length + countTopBinds(t.rest);
    case "assign": return countTopBinds(t.rest);
    // dcall binds its result inside its thunk's activation frame, not the
    // site's spine frame.
    case "dcall": return 0;
    default: return 0; // if/letk/handle/scope open their own frames/units
  }
}

// ---------------------------------------------------------------------------
// The planner. One traversal per unit; mirrors emitTerm's traversal
// exactly (same case order, same scope threading).

type Cx = {
  cfnBase: Map<number, TScope>,
  hdlOrder: AHandle[],
  caseCount: number,
  idRetCount: number,
  retResCount: number,
};

function planUnit(cx: Cx, term: CTerm, base: TScope, esc: Set<string>): void {
  const walk = (t: CTerm, ts: TScope, esc: Set<string>): void => {
    switch (t.t) {
      case "letk": {
        const al = t as ALetk;
        if (esc.has(t.name)) {
          const fl = lvl();
          const fnSlot = addSlot(fl, t.name);
          const freezeSlots = new Map<string, number>();
          if (t.freeze !== undefined)
            for (const fr of t.freeze) freezeSlots.set(fr.name, addSlot(fl, fr.name));
          const entry = lvl();
          addSlot(entry, t.param);
          const bodyEsc = analyzeEscapes(t.body);
          al.__p = {
            mat: true, fnSlot, fnLvl: fl, freezeSlots,
            entryScope: [entry, fl, ...ts], restScope: [fl, ...ts],
            isLoop: jumpsTo(t.body, t.name), bodyEsc, param: t.param,
          };
          planUnit(cx, t.body, [entry, fl, ...ts], bodyEsc);
          // The rest runs inside F_n: its bindings (e.g. a handle's $hret
          // slot) extend F_n — fnLvl.size is read at emit time, after
          // planning finalizes the level.
          walk(t.rest, [fl, ...ts], esc);
        } else {
          al.__p = {mat: false, paramSlot: addSlot(ts[0], t.param), isLoop: jumpsTo(t.body, t.name)};
          walk(t.body, ts, esc);
          walk(t.rest, ts, esc);
        }
        break;
      }
      case "let": case "bind": case "mkfn":
        addSlot(ts[0], t.name);
        if (t.t === "mkfn" && !cx.cfnBase.has(t.fun)) cx.cfnBase.set(t.fun, [...ts]);
        walk(t.rest, ts, esc);
        break;
      case "dlet":
        for (const fld of t.fields) addSlot(ts[0], fld);
        walk(t.rest, ts, esc);
        break;
      case "assign":
        walk(t.rest, ts, esc);
        break;
      case "scope": {
        const as = t as AScope;
        as.__p = lvl();
        walk(t.rest, [as.__p, ...ts], esc);
        break;
      }
      case "call": case "perform":
        break;
      case "dcall": {
        const ad = t as ADcall;
        // The rest runs in the cell's activation frame: entry holds the
        // result slot, fl is the cell's frame (F_n) — the CPS-entry thunk
        // allocates the activation over the captured F_n; the direct-entry
        // path dispatches its result through the same cell.
        const fl = lvl();
        const entry = lvl();
        addSlot(entry, t.name);
        const restEsc = analyzeEscapes(t.rest);
        ad.__p = {entryScope: [entry, fl, ...ts], bodyEsc: restEsc, fnLvl: fl};
        planUnit(cx, t.rest, [entry, fl, ...ts], restEsc);
        break;
      }
      case "handle": {
        const ah = t as AHandle;
        const retSlot = addSlot(ts[0], t.ret);
        const npMax = Math.max(0, ...t.cases.map(c => c.params.length));
        const topBinds = Math.max(0, ...t.cases.map(c => countTopBinds(c.body)));
        const hframeSize = npMax + 2 + topBinds;
        const hp: HdlP = {hdlIdx: cx.hdlOrder.length, hframeSize, retSlot, caseP: []};
        ah.__p = hp;
        cx.hdlOrder.push(ah);
        for (const c of t.cases) {
          if (c.op === "Return") continue;
          const hl = lvl();
          for (let i = 0; i < npMax; i++) addSlot(hl, i < c.params.length ? c.params[i] : `$p${i}`);
          addSlot(hl, c.resume);
          const cesc = analyzeEscapes(c.body);
          hp.caseP.push({base: [hl, ...ts], esc: cesc, fnIdx: cx.caseCount++});
          planUnit(cx, c.body, [hl, ...ts], cesc);
        }
        const retCase = t.cases.find(c => c.op === "Return");
        if (retCase !== undefined) {
          const hl = lvl();
          for (let i = 0; i < npMax; i++) addSlot(hl, `$p${i}`);
          addSlot(hl, retCase.resume);
          addSlot(hl, retCase.params[0]);
          const resc = analyzeEscapes(retCase.body);
          hp.retP = {base: [hl, ...ts], esc: resc, fnIdx: cx.caseCount++};
          hp.retResumeIdx = cx.retResCount++;
          planUnit(cx, retCase.body, [hl, ...ts], resc);
        } else if (npMax > 0) {
          hp.idRetIdx = cx.idRetCount++;
        }
        walk(t.body, ts, esc);
        break;
      }
      case "if":
        walk(t.a, ts, esc);
        walk(t.b, ts, esc);
        break;
      default:
        break;
    }
  };
  walk(term, base, esc);
}

export type TermPlan = {
  cfnBase: Map<number, TScope>,
  // per-CFn direct classification (mkfn emission stamps the $CLO flag; the
  // emitCfns split picks the entry ABI)
  cfnDirect: boolean[],
  hdlOrder: AHandle[],
  caseCount: number,
  idRetCount: number,
  retResCount: number,
  globalLvl: TLevel, // the main term's base level (slot map shared with the plan)
};

export function planIr(ir: CIr): TermPlan {
  const cx: Cx = {cfnBase: new Map(), hdlOrder: [], caseCount: 0, idRetCount: 0, retResCount: 0};
  const globalLvl = lvl();
  planUnit(cx, ir.term, [globalLvl], analyzeEscapes(ir.term));
  // A lambda's mkfn site may live in a LATER lambda's body (nested lambdas),
  // so plan in fixpoint order: each pass plans the fns whose site scopes
  // are already known; nesting depth bounds the passes.
  const pending = new Set<number>(ir.funcs.map((_, i) => i));
  while (pending.size > 0) {
    let progressed = false;
    for (const i of [...pending]) {
      const base = cx.cfnBase.get(i);
      if (base === undefined) continue;
      pending.delete(i);
      progressed = true;
      const fn = ir.funcs[i];
      const paramsL = lvl();
      for (const p of fn.params) addSlot(paramsL, p);
      planUnit(cx, fn.body, [paramsL, ...base], analyzeEscapes(fn.body));
    }
    if (!progressed)
      throw new WasmError(`internal: lambda ${[...pending][0]} has no mkfn site`);
  }
  return {
    cfnBase: cx.cfnBase, cfnDirect: ir.funcs.map(fn => fn.direct === true), hdlOrder: cx.hdlOrder,
    caseCount: cx.caseCount, idRetCount: cx.idRetCount, retResCount: cx.retResCount,
    globalLvl,
  };
}

// ---------------------------------------------------------------------------
// Emission.

type Walk = {
  em: Emit,
  f: Fn,
  ts: TScope,
  kL: number,     // ambient chain head (local index; 1 = $ret/kNext family)
  esc: Set<string>,
  labels: {name: string, openDepth: number, isLoop: boolean, param: string}[],
  depth: number,  // open wasm structured instructions (br index arithmetic)
  // The enclosing case body's exit binder (thunks inside it rebind it to
  // the kNext param — its value at the suspension IS the ambient chain).
  exitName?: string,
  // The enclosing handle's ret binder. eval.ts's $hret is a done-marker
  // returned to the AMBIENT run loop — on resume re-entries run() processes
  // it with kOuter = the resume's k2 — so thunks rebind it to kNext too
  // (the cell's next = the fresh-HDL chain → k2), never the frozen frame
  // slot (which still holds the original handle's HDL cell).
  retName?: string,
  // Direct-ABI function body (T_DABI, no k): dret returns the boxed value
  // directly; the kL local is a never-set (null) $K ref so the generic
  // land-cell paths terminate in a plain return.
  directFn?: true,
  // Thunks created inside a direct fn: their thunks' cells chain to a
  // terminal return-cell instead of the raw null kL (a null next would
  // fire emitDispatch's null-k inside void arms — see emitDcallThunk).
  kTerminal?: boolean,
};

// The next-pointer operand for a dcall's synthesized cell: the ambient
// chain head — but inside a DIRECT fn that is the never-set null local, and
// a null next makes the completion's dret fire emitDispatch's null-k inside
// void arms (a while's condition). Chain to the per-compile terminal cell
// instead: a K_RET whose fragment just returns its param — the completion's
// value unwinds as each fragment's result.
function cellNextE(wk: Walk, b: Buf): void {
  if (wk.kTerminal === true) {
    b.globalGet(wk.em.lay.terminalCellG, binaryen.anyref);
    return;
  }
  b.localGet(wk.kL);
}

function pushAtom(wk: Walk, a: CAtom): void {
  const f = wk.f;  // A stamped UNIT literal must BOX: its raw JS null pushes as ref.null any
  // (a frame parent — poison for a frame slot). Box a zero payload at the
  // stamp's shape directly — unit carries no payload, so zero bits are
  // fine (and the unitRef global would type-mismatch structNew's pop).
  if (a.t === "lit" && a.v === null && a.stamp !== undefined) {
    if (a.stamp === "f64") f.body.f64Const(0);
    else if (a.stamp === "i64" || a.stamp === "u64") f.body.i64Const(0n);
    else f.body.i32Const(0); // f32's $F32 box is never a unit carrier —
    // unit stamps only ride i64 (the while chains) — the i32 const covers
    // the remaining int shapes' structNew pops
    rebox(wk.em, f, a.stamp);
    return;
  }
  if (a.t === "var" && a.stamp !== undefined) pushStampedVar(wk, a);
  else f.pushRef(atomRef(wk, a));
}

// Load an atom's value ref. Literals ride the static pools (i64/u64
// materialize from the raw lexeme — a JS number loses bits beyond 2^53);
// vars resolve through the frame chain or same-fn locals, falling back to
// the global $CLO slots for builtin natives (map/each/flatmap).
function atomRef(wk: Walk, a: CAtom): ValueRef {
  const f = wk.f, b = f.body;
  if (a.t === "lit") {
    if (typeof a.v === "number") {
      // i64/u64 literals key by their raw lexeme: the static builder parses
      // it exactly (a JS number loses bits beyond 2^53).
      const key = `${a.stamp ?? "f64"}:${a.raw ?? String(a.v)}`;
      const g = wk.em.lay.numStatics.get(key);
      if (g === undefined) throw new WasmError(`internal: no static for num ${key}`);
      const v = f.anyref();
      b.globalGet(g, binaryen.anyref);
      b.localSet(v);
      return {k: "local", l: v};
    }
    if (typeof a.v === "string") {
      const g = wk.em.lay.strStatics.get(a.v);
      if (g === undefined) throw new WasmError(`internal: no static for string literal`);
      const v = f.anyref();
      b.globalGet(g, binaryen.anyref);
      b.localSet(v);
      return {k: "local", l: v};
    }
    if (a.v === true || a.v === false) return {k: "bool", v: a.v ? 1 : 0};
    return wk.em.lay.unitRef; // unit
  }
  const r = resolveT(wk.ts, a.name);
  if (r !== null) {
    if (r.local !== null) return {k: "local", l: r.local};
    if (r.d === 0) return {k: "slot", i: r.i};
    const v = f.anyref();
    b.localGet(0);
    for (let k = 0; k < r.d; k++) b.structGet(4, 0); // walk parent frames
    b.structGet(4, 1);
    b.i32Const(r.i);
    b.arrayGet(1);
    b.localSet(v);
    return {k: "local", l: v};
  }
  const clo = wk.em.lay.cloOffsets.get(a.name);
  if (clo !== undefined) return {k: "g", gi: clo};
  throw new WasmError(`internal: unbound ${a.name} in term emission`);
}

// A stamped var read normalizes exactly like evalAtom: unbox through the
// width's adaptive helper, rebox at the width's shape.
function pushStampedVar(wk: Walk, a: CAtom & {t: "var"}): void {
  const f = wk.f, b = f.body;
  f.pushRef(atomRef(wk, a));
  const wkn = a.stamp!;
  if (wkn === "f64") return; // the f64 plane's $F64 boxes pass through
  b.callFn(widthHelper(wk.em, wkn));
  rebox(wk.em, f, wkn);
}

function widthHelper(em: Emit, wkn: string): number {
  return wkn === "f32" ? em.ix.fF32of
    : wkn === "i32" ? em.ix.fI32of
    : wkn === "u32" ? em.ix.fU32of
    : wkn === "i64" ? em.ix.fI64of
    : em.ix.fU64of;
}

function boxShapeOf(wkn: string): number {
  switch (wkn) {
    case "i32": return 7;
    case "u32": return 8;
    case "i64": return 9;
    case "u64": return 10;
    case "f32": return 11;
    default: return 0; // $F64
  }
}

// Box the width-typed value on the stack (the f64 plane rides $box).
export function rebox(em: Emit, f: Fn, wkn: string): void {
  if (wkn === "f64") f.body.callFn(em.ix.fBox);
  else f.body.structNew(boxShapeOf(wkn));
}

function planeLocal(f: Fn, wkn: string): number {
  return wkn === "f32" ? f.f32()
    : wkn === "i64" || wkn === "u64" ? f.i64()
    : wkn === "f64" ? f.f64() // the f64 plane's scratch holds raw f64 payloads
    : f.i32(); // i32/u32-plane scratch
}

// Store an anyref local into (depth, slot) of the frame chain.
function storeAt(wk: Walk, d: number, i: number, v: number): void {
  const b = wk.f.body;
  b.localGet(0);
  for (let k = 0; k < d; k++) b.structGet(4, 0);
  b.structGet(4, 1);
  b.i32Const(i);
  b.localGet(v);
  b.arraySet();
}


// Fresh child frame with `size` slots (parent = the current frame). The
// local is $FRAME-typed (struct.get on an anyref-typed expression fails
// binaryen's isStruct assertion — local 0 is $FRAME-typed for the same
// reason).
function extendFrame(wk: Walk, size: number): number {
  const f = wk.f, b = f.body;
  const fp = f.typed(_T.RF[4]);
  b.localGet(0);
  b.i32Const(size);
  b.arrayNew(1);
  b.structNew(4);
  b.localSet(fp);
  return fp;
}

// ---------------------------------------------------------------------------
// Prims: pure computations, never suspend.

function emitPrim(wk: Walk, p: CPrim): number {
  const f = wk.f, b = f.body;
  switch (p.t) {
    case "op": {
      const res = f.anyref();
      emitOpPrim(wk, p);
      b.localSet(res);
      return res;
    }
    case "arr": {
      const blk = f.anyref();
      b.i32Const(p.args.length);
      b.arrayNew(1);
      b.localSet(blk);
      for (let k = 0; k < p.args.length; k++) {
        // Value-explicit order: the element's ref before the destination.
        const r = f.anyref();
        pushAtom(wk, p.args[k]);
        b.localSet(r);
        b.localGet(blk);
        b.refCast(1, true);
        b.i32Const(k);
        b.localGet(r);
        b.arraySet();
      }
      b.localGet(blk);
      b.refCast(1, true);
      if (p.kind === "tup") b.structNew(12); // $TUP
      else {
        b.i32Const(0);
        b.i32Const(p.args.length);
        b.structNew(3); // slice window {data, 0, n}
      }
      const res = f.anyref();
      b.localSet(res);
      return res;
    }
    case "as":
      return emitAsPrim(wk, p);
    case "field": {
      const o = f.anyref();
      pushAtom(wk, p.obj);
      b.localSet(o);
      return emitFieldRead(wk, o, p.idx, p.name);
    }
  }
}

// Field access with the tuple/array runtime dispatch (the IR prim carries
// no shape mark — the interpreter runtime-dispatches on the value, and so
// does the codegen; the bounds failures carry the field name exactly like
// evalPrim).
function emitFieldRead(wk: Walk, o: number, idx: number, name: string): number {
  const f = wk.f, b = f.body;
  const res = f.anyref();
  b.localGet(o);
  b.refTest(12, false); // $TUP
  b.if(w.ANYREF); // both arms leave the field value (an anyref box)
  {
    const blk = f.anyref();
    b.localGet(o);
    b.refCast(12, true);
    b.structGet(12, 0);
    b.localSet(blk);
    b.localGet(blk);
    b.refCast(1, true);
    b.arrayLen();
    b.i32Const(idx);
    b.u8(w.LEU);
    b.if();
    emitFail(wk.em, f, 2, wk.em.lay.strStatics.get(name) ?? null,
      f.constF64(idx),
      () => { b.localGet(blk); b.refCast(1, true); b.arrayLen(); b.u8(w.CONV_I32); },
      f.constF64(0));
    b.u8(w.END);
    b.localGet(blk);
    b.refCast(1, true);
    b.i32Const(idx);
    b.arrayGet(1);
  }
  b.u8(w.ELSE);
  {
    const d = f.anyref(), off = f.i32(), len = f.i32();
    b.localGet(o);
    f.unboxSlice(d, off, len);
    b.localGet(len);
    b.i32Const(idx);
    b.u8(w.LEU);
    b.if();
    emitFail(wk.em, f, 2, wk.em.lay.strStatics.get(name) ?? null,
      f.constF64(idx),
      () => { b.localGet(len); b.u8(w.CONV_I32); },
      f.constF64(0));
    b.u8(w.END);
    b.localGet(d);
    b.refCast(1, true);
    b.localGet(off);
    b.i32Const(idx);
    b.u8(w.ADD);
    b.arrayGet(1);
  }
  b.u8(w.END);
  b.localSet(res);
  return res;
}

// @as conversion (keyed by the prim's target stamp and the operand atom's
// stamp): trunc (float→int, toward zero),
// boolnum (bool→0/1), else width adaptation via the adaptive helpers.
function emitAsPrim(wk: Walk, p: CPrim & {t: "as"}): number {
  const em = wk.em, f = wk.f, b = f.body;
  const targetW = p.stamp;
  const v = f.anyref();
  pushAtom(wk, p.arg);
  b.localSet(v);
  if (p.asKind === "trunc") {
    // float -> int: trunc toward zero (out-of-range traps on the wasm side
    // — a frozen divergence from the interpreter's wrap).
    b.localGet(v);
    b.readBoxPayload(0);
    if (targetW === "u32") {
      b.u8(w.TRUNC_F64_U);
      const t = f.i32();
      b.localSet(t);
      b.localGet(t);
      b.structNew(8);
    } else if (targetW === "i32") {
      b.u8(w.TRUNC_F64);
      const t = f.i32();
      b.localSet(t);
      b.localGet(t);
      b.structNew(7);
    } else if (targetW === "u64") {
      b.u8(w.TRUNC_F64_U);
      b.u8(w.I64_EXTEND_I32_U);
      const t = f.i64();
      b.localSet(t);
      b.localGet(t);
      b.structNew(10);
    } else if (targetW === "i64") {
      b.u8(w.TRUNC_F64);
      b.u8(w.I64_EXTEND_I32_S);
      const t = f.i64();
      b.localSet(t);
      b.localGet(t);
      b.structNew(9);
    } else if (targetW === "f32") {
      b.u8(w.CONV_F32_I32);
      const t = f.f32();
      b.localSet(t);
      b.localGet(t);
      b.structNew(11);
    } else {
      b.u8(w.FTRUNC);
      b.callFn(em.ix.fBox);
    }
  } else if (p.asKind === "boolnum") {
    // bool -> 0/1 boxed at the TARGET width (the interpreter's
    // normWidth(v ? 1 : 0, stamp)); fTruthy yields the i32, then rebox.
    b.localGet(v);
    b.callFn(em.ix.fTruthy);
    if (targetW === "i32") {
      const t = f.i32();
      b.localSet(t);
      b.localGet(t);
      b.structNew(7);
    } else if (targetW === "u32") {
      const t = f.i32();
      b.localSet(t);
      b.localGet(t);
      b.structNew(8);
    } else if (targetW === "i64") {
      b.u8(w.I64_EXTEND_I32_S);
      const t = f.i64();
      b.localSet(t);
      b.localGet(t);
      b.structNew(9);
    } else if (targetW === "u64") {
      b.u8(w.I64_EXTEND_I32_U);
      const t = f.i64();
      b.localSet(t);
      b.localGet(t);
      b.structNew(10);
    } else if (targetW === "f32") {
      b.u8(w.CONV_F32_I32);
      const t = f.f32();
      b.localSet(t);
      b.localGet(t);
      b.structNew(11);
    } else {
      b.u8(w.CONV_I32); // f64 (default/undefined target)
      b.callFn(em.ix.fBox);
    }
  } else {
    // Width adaptation: adaptive unbox to the target, rebox at its shape.
    b.localGet(v);
    if (targetW !== undefined && targetW !== "f64") b.callFn(widthHelper(em, targetW));
    if (targetW === undefined || targetW === "f64") {
      b.callFn(em.ix.fNum64); // adaptive unbox: the source rides in its own box
      b.callFn(em.ix.fBox);
    } else b.structNew(boxShapeOf(targetW));
  }
  const res = f.anyref();
  b.localSet(res);
  return res;
}

// Stamped operator computation over IR atoms, operands loaded from atoms.
// Leaves the boxed result on the stack.
function emitOpPrim(wk: Walk, p: CPrim & {t: "op"}): void {
  const em = wk.em, f = wk.f, b = f.body;
  const wkName = p.stamp;
  const isF32 = wkName === "f32", isI32 = wkName === "i32", isU32 = wkName === "u32";
  const isI64 = wkName === "i64", isU64 = wkName === "u64";
  const isNarrow = isI32 || isU32, isWide = isI64 || isU64;
  const name = p.op;
  // A stamped operand at the site's width reads its box payload directly
  // (the checker's stamps-before-calls discipline guarantees the shape);
  // anything else goes through the adaptive helper — including the f64
  // plane ($num64), which unboxes the operand for raw arithmetic.
  const pushArg = (i: number): void => {
    const a = p.args[i];
    if (a.stamp === wkName) {
      // Same-width box: cast to its shape and read the raw payload (the
      // payload type follows the shape — $I64 carries i64, $F64 f64, ...).
      f.pushRef(atomRef(wk, a));
      b.readBoxPayload(boxShapeOf(wkName));
    } else {
      f.pushRef(atomRef(wk, a));
      b.callFn(wkName === "f64" ? em.ix.fNum64 : widthHelper(em, wkName));
    }
  };
  const unbox = (i: number): number => {
    const loc = planeLocal(f, wkName);
    pushArg(i);
    b.localSet(loc);
    return loc;
  };
  const boxW = (): void => rebox(em, f, wkName);
  switch (name) {
    case "+": {
      if (wkName === "f64") {
        const a = f.anyref(), bv = f.anyref();
        pushAtom(wk, p.args[0]);
        b.localSet(a);
        pushAtom(wk, p.args[1]);
        b.localSet(bv);
        b.localGet(a); b.refTest(0, false);
        b.localGet(bv); b.refTest(0, false);
        b.u8(w.AND);
        b.u8(w.IF); b.u8(w.ANYREF);
        b.localGet(a); b.readBoxPayload(0);
        b.localGet(bv); b.readBoxPayload(0);
        b.u8(w.FADD);
        b.callFn(em.ix.fBox);
        b.u8(w.ELSE);
        b.localGet(a); b.refTest(2, false);
        b.localGet(bv); b.refTest(2, false);
        b.u8(w.AND);
        b.u8(w.IF); b.u8(w.ANYREF);
        f.emitStrCat(a, bv);
        b.u8(w.ELSE); b.refNull(w.ANYREF);
        b.u8(w.END);
        b.u8(w.END);
        break;
      }
      {
        const x = unbox(0), y = unbox(1);
        b.localGet(x);
        b.localGet(y);
        b.u8(isF32 ? w.F32_ADD : isWide ? w.I64_ADD : w.ADD);
        boxW();
      }
      break;
    }
    case "-": case "*": {
      const x = unbox(0), y = unbox(1);
      b.localGet(x);
      b.localGet(y);
      b.u8(name === "-"
        ? (isF32 ? w.F32_SUB : isNarrow ? w.SUB : isWide ? w.I64_SUB : w.FSUB)
        : (isF32 ? w.F32_MUL : isNarrow ? w.MUL : isWide ? w.I64_MUL : w.FMUL));
      boxW();
      break;
    }
    case "/": case "%": {
      if (isNarrow || isWide) {
        // Integer division traps on ÷0; signed `/` also guards INT_MIN ÷ -1
        // (wasm's div_s overflows there; the interpreter fails identically
        // via ef_fail — rem by -1 is fine, REMS of INT_MIN by -1 is 0).
        const x = unbox(0), y = unbox(1);
        b.localGet(y);
        b.u8(isWide ? w.I64_EQZ : w.EQZ);
        b.u8(w.IF); b.u8(0x40);
        emitFail(em, f, 3, null, f.constF64(0), f.constF64(0), f.constF64(0));
        b.u8(w.END);
        if (name === "/" && (isI32 || isI64)) {
          b.localGet(y);
          if (isWide) b.i64Const(-1n); else b.i32Const(-1);
          b.u8(isWide ? w.I64_EQ : w.EQ);
          b.localGet(x);
          if (isWide) b.i64Const(-(2n ** 63n)); else b.i32Const(-2147483648);
          b.u8(isWide ? w.I64_EQ : w.EQ);
          b.u8(w.AND);
          b.u8(w.IF); b.u8(0x40);
          emitFail(em, f, 4, null, f.constF64(0), f.constF64(0), f.constF64(0));
          b.u8(w.END);
        }
        b.localGet(x);
        b.localGet(y);
        b.u8(name === "/"
          ? (isI32 ? w.DIVS : isU32 ? w.DIVU : isI64 ? w.I64_DIVS : w.I64_DIVU)
          : (isI32 ? w.REMS : isU32 ? w.REMU : isI64 ? w.I64_REMS : w.I64_REMU));
        boxW();
        break;
      }
      if (name === "%") {
        const x = unbox(0), y = unbox(1), t = f.f64();
        if (isF32) { b.localGet(x); b.u8(w.F64_PROMOTE); b.localGet(y); b.u8(w.F64_PROMOTE); }
        else { b.localGet(x); b.localGet(y); }
        b.u8(w.FDIV); b.u8(w.FTRUNC); b.localSet(t);
        b.localGet(x); b.localGet(y); b.localGet(t); b.u8(w.FMUL); b.u8(w.FSUB);
        if (isF32) b.u8(w.F32_DEMOTE);
      } else {
        const x = unbox(0), y = unbox(1);
        if (isF32) {
          // The interpreter computes float / in f64 and frounds the result
          // (the site's norm) — promote, divide, demote for the f32 box.
          b.localGet(x); b.u8(w.F64_PROMOTE);
          b.localGet(y); b.u8(w.F64_PROMOTE);
          b.u8(w.FDIV); b.u8(w.F32_DEMOTE);
        } else { b.localGet(x); b.localGet(y); b.u8(w.FDIV); }
      }
      boxW();
      break;
    }
    case "neg": {
      const x = unbox(0);
      if (isF32) {
        b.localGet(x); b.u8(w.F32_NEG);
      } else if (isNarrow) {
        b.i32Const(0); b.localGet(x); b.u8(w.SUB);
      } else if (isWide) {
        b.i64Const(0n); b.localGet(x); b.u8(w.I64_SUB);
      } else {
        b.localGet(x); b.u8(w.FNEG);
      }
      boxW();
      break;
    }
    case "<": case ">": case "<=": case ">=": {
      const x = unbox(0), y = unbox(1);
      selectBool(em, f, () => {
        b.localGet(x);
        b.localGet(y);
        b.u8(CMP_OPS[name][wkName]);
      });
      break;
    }
    case "==": case "!=": {
      if (wkName !== "f64") {
        const x = unbox(0), y = unbox(1);
        selectBool(em, f, () => {
          b.localGet(x); b.localGet(y);
          b.u8(isF32 ? w.F32_EQ : isWide ? w.I64_EQ : w.EQ);
        });
        if (name === "!=") {
          i31of(b);
          b.u8(w.EQZ);
          selectBool(em, f);
        }
        break;
      }
      pushAtom(wk, p.args[0]);
      pushAtom(wk, p.args[1]);
      b.callFn(em.ix.fEq);
      if (name === "!=") {
        i31of(b);
        b.u8(w.EQZ);
        selectBool(em, f);
      }
      break;
    }
    case "not": {
      pushAtom(wk, p.args[0]);
      b.callFn(em.ix.fTruthy);
      b.u8(w.EQZ);
      selectBool(em, f);
      break;
    }
    default:
      throw new WasmError(`internal: no inline emitter for operator ${name}`);
  }
  // The prim's norm re-normalizes a result computed in a different plane
  // than the app node's stamp (identity otherwise).
  if (p.norm !== undefined && p.norm !== wkName) {
    const r = f.anyref();
    b.localSet(r);
    b.localGet(r);
    if (p.norm !== "f64") b.callFn(widthHelper(em, p.norm));
    rebox(em, f, p.norm);
  }
}

// ---------------------------------------------------------------------------
// Continuation-operand resolution + delivery.

type KRef =
  | {kind: "cell", local: number}
  | {kind: "label", name: string, param: string, openDepth: number, isLoop: boolean};

function resolveK(wk: Walk, a: CAtom): KRef {
  if (a.t !== "var") throw new WasmError("internal: k operand must be a var");
  const name = a.name;
  if (!wk.esc.has(name)) {
    const lab = wk.labels.find(l => l.name === name);
    if (lab !== undefined) {
      return {kind: "label", name, param: lab.param, openDepth: lab.openDepth, isLoop: lab.isLoop};
    }
  }
  const f = wk.f, b = f.body;
  const r = resolveT(wk.ts, name);
  if (r === null) throw new WasmError(`internal: unbound continuation ${name}`);
  if (r.local !== null) return {kind: "cell", local: r.local};
  const cell = f.anyref();
  b.localGet(0);
  for (let k = 0; k < r.d; k++) b.structGet(4, 0);
  b.structGet(4, 1);
  b.i32Const(r.i);
  b.arrayGet(1);
  b.localSet(cell);
  return {kind: "cell", local: cell};
}

// ---------------------------------------------------------------------------
// The term walker. Every case ends its unit position (all value flow is
// explicit in the term), so nothing falls through.

function emitTerm(wk: Walk, t: CTerm): void {
  const em = wk.em, f = wk.f, b = f.body;
  // One host call per term-node entry (EFTRACE=1); the host prints the
  // ring buffer when a trap escapes. A direct body's dret marks the
  // boundary completion (a leaked dret there traps — label it).
  tracePoint(wk.em, f, `f${f.fid}(idx${f.idx}) ${t.t}${t.t === "dret" && wk.directFn ? ":direct" : ""}`);
  switch (t.t) {
    case "letk": {
      const al = t as ALetk;
      const p = al.__p!;
      if (p.mat) {
        // 1. Emit the body into its thunk (the funcref index must exist
        // before the cell installs).
        const thunk = makeRestThunk(em, "letk:" + t.name);
        p.thunk = thunk;
        emitLetkThunk(wk, thunk, t, p);
        // 2. Install: F_n = {parent, [cont, ...frozen]}; cell = {K_RET,
        // thunk, F_n, next = ambient kL}; current frame := F_n.
        const fpN = extendFrame(wk, p.fnLvl!.size);
        if (t.freeze !== undefined) {
          const slots = f.typed(_T.RF[1]);
          b.localGet(fpN);
          b.structGet(4, 1);
          b.localSet(slots);
          for (const fr of t.freeze) {
            const si = p.freezeSlots!.get(fr.name)!;
            const v = f.anyref();
            pushAtom(wk, fr.val);
            b.localSet(v);
            b.localGet(slots);
            b.i32Const(si);
            b.localGet(v);
            b.arraySet();
          }
        }
        const cell = f.anyref();
        b.i31Const(w.K_RET);
        b.i32Const(thunk.idx);
        b.refI31();
        b.localGet(fpN);
        cellNextE(wk, b); // the terminal cell inside a direct fn: a raw
        // null next fires the null-k yield inside void arms on completion
        b.refCast(5, true); // $K.next is $K-typed
        b.structNew(5);
        b.localSet(cell);
        b.localGet(fpN);
        b.structGet(4, 1);
        b.i32Const(p.fnSlot!);
        b.localGet(cell);
        b.arraySet();
        b.localGet(fpN);
        b.localSet(0);
        // 3. The rest runs inside F_n; the walker's scope shifts to the
        // planned restScope (the pre-pass pushed the F_n level).
        const saved = wk.ts;
        wk.ts = p.restScope!;
        emitTerm(wk, t.rest);
        wk.ts = saved;
        break;
      }
      // Non-materialized: a wasm label, not a cell. Loop when the body
      // jumps back (br re-enters the body); otherwise the body sits AFTER
      // the block — br to a block lands at its END, so the jumpers' br
      // falls into the body there. Only the rest goes inside: it is
      // dynamically unreachable-after-dispatch but its jumps to this letk
      // (a while's first-entry `again`) only validate with the label open.
      // The site frame is saved and restored before the body runs: scopes
      // inside the body/rest rebind local 0, and a re-entry (br) must find
      // the frame chain the body's slot depths assume.
      const siteF = f.typed(_T.RF[4]);
      b.localGet(0);
      b.localSet(siteF);
      wk.labels.push({name: t.name, openDepth: wk.depth, isLoop: p.isLoop === true, param: t.param});
      if (p.isLoop === true) {
        b.u8(w.LOOP); b.u8(0x40);
        wk.depth++;
        b.localGet(siteF);
        b.localSet(0); // each iteration re-enters at the site frame
        emitTerm(wk, t.body);
        emitTerm(wk, t.rest);
        wk.labels.pop();
        wk.depth--;
        b.u8(w.END);
        b.u8(0x00); // unreachable: the body/rest dispatch away, never fall through
      } else {
        b.u8(w.BLOCK); b.u8(0x40);
        wk.depth++;
        emitTerm(wk, t.rest);
        wk.labels.pop();
        wk.depth--;
        b.u8(w.END);
        b.localGet(siteF);
        b.localSet(0); // the br lands here: run the body at the site frame
        emitTerm(wk, t.body); // then the body dispatches away
      }
      break;
    }
    case "let": {
      const res = emitPrim(wk, t.rhs);
      const si = wk.ts[0].slots.get(t.name);
      if (si === undefined) throw new WasmError(`internal: no slot for ${t.name}`);
      storeAt(wk, 0, si, res);
      emitTerm(wk, t.rest);
      break;
    }
    case "bind": {
      const v = f.anyref();
      pushAtom(wk, t.val);
      b.localSet(v);
      storeAt(wk, 0, wk.ts[0].slots.get(t.name)!, v);
      emitTerm(wk, t.rest);
      break;
    }
    case "mkfn": {
      const baseScope = wk.em.plan.cfnBase.get(t.fun);
      if (baseScope === undefined) throw new WasmError(`internal: no base scope for fun ${t.fun}`);
      const clo = f.anyref();
      b.i32Const(wk.em.ix.lambda0 + t.fun);
      b.refI31();
      b.localGet(0); // the captured frame
      b.i32Const(baseScope[0].size);
      b.refI31();
      // direct flag: the closure's entry ABI (T_DABI when the function
      // classified direct)
      b.i32Const(wk.em.plan.cfnDirect[t.fun] === true ? 1 : 0);
      b.refI31();
      b.structNew(6);
      b.localSet(clo);
      storeAt(wk, 0, wk.ts[0].slots.get(t.name)!, clo);
      emitTerm(wk, t.rest);
      break;
    }
    case "call": {
      const direct = directBuiltin(wk, t.fn);
      const fc = f.anyref();
      if (direct === undefined) {
        // Closure call: load the callee value (a user $CLO, a builtin $CLO
        // from the value-builtins pool, or a case-body resume binder).
        pushAtom(wk, t.fn);
        b.localSet(fc);
      }
      const kref = resolveK(wk, t.k);
      if (kref.kind === "label") throw new WasmError("internal: call k must be materialized");
      const argEmit = (k: number, ffp: number): void => {
        const r = f.anyref();
        pushAtom(wk, t.args[k]);
        b.localSet(r);
        b.localGet(ffp);
        b.refCast(4, true);
        b.structGet(4, 1);
        b.i32Const(k);
        b.localGet(r);
        b.arraySet();
      };
      if (direct !== undefined) {
        emitCallClosure(f, fc, t.args.length, argEmit, {tail: true, kL: kref.local, direct});
        break;
      }
      // Unknown callee kind: the $CLO flag picks the entry ABI. A direct
      // entry returns its value — dispatch it through the site's continuation
      // here; a CPS entry takes the generic tail call.
      const flag = f.i32();
      b.localGet(fc);
      b.refCast(6, true);
      b.structGet(6, 3);
      b.i31Get();
      b.localSet(flag);
      b.localGet(flag);
      // Void arms: both diverge (the direct arm's dispatch yield is
      // dynamically dead — its null-k path returns the value; leftovers the
      // Buf drops are unreachable code). The scope counts in br-depth
      // arithmetic: track it for jumps inside the arms.
      b.if();
      wk.depth++;
      emitDirectEntryCall(em, f, fc, t.args.length, argEmit, {kind: "k", kL: kref.local});
      b.u8(w.RETURN); // the dispatch's null-k yield: the site's value
      b.u8(w.ELSE);
      emitCallClosure(f, fc, t.args.length, argEmit, {tail: true, kL: kref.local});
      b.u8(w.END);
      wk.depth--;
      b.u8(w.UNREACHABLE); // both arms diverge (tail call / the dispatch's return)
      break;
    }
    case "perform":
      emitPerformT(wk, t);
      break;
    case "handle":
      emitHandleT(wk, t);
      break;
    case "if": {
      const cond = f.anyref();
      pushAtom(wk, t.c);
      b.localSet(cond);
      b.localGet(cond);
      b.callFn(em.ix.fTruthy);
      b.u8(w.IF); b.u8(0x40);
      wk.depth++;
      emitTerm(wk, t.a);
      b.u8(w.ELSE);
      emitTerm(wk, t.b);
      wk.depth--;
      b.u8(w.END);
      b.u8(0x00); // unreachable: both arms dispatch away
      break;
    }
    case "scope": {
      const as = t as AScope;
      const fp = extendFrame(wk, as.__p!.size);
      b.localGet(fp);
      b.localSet(0);
      const saved = wk.ts;
      wk.ts = [as.__p!, ...wk.ts];
      emitTerm(wk, t.rest);
      wk.ts = saved;
      break;
    }
    case "dlet": {
      const v = f.anyref();
      pushAtom(wk, t.val);
      b.localSet(v);
      emitDlet(wk, t, v);
      emitTerm(wk, t.rest);
      break;
    }
    case "assign": {
      const r = resolveT(wk.ts, t.name);
      if (r === null) throw new WasmError(`internal: assign of unbound ${t.name}`);
      const v = f.anyref();
      pushAtom(wk, t.val);
      b.localSet(v);
      storeAt(wk, r.d, r.i, v);
      emitTerm(wk, t.rest);
      break;
    }
    case "jump": {
      const name = t.k.t === "var" ? t.k.name : null;
      if (name === null) throw new WasmError("internal: jump k must be a var");
      const v = f.anyref();
      pushAtom(wk, t.arg);
      b.localSet(v);
      const kref = resolveK(wk, t.k);
      if (kref.kind === "label") {
        // Store into the letk's param slot (the jump site may sit inside
        // deeper scopes — resolve through the frame chain), then br.
        const r = resolveT(wk.ts, kref.param);
        if (r === null) throw new WasmError(`internal: letk param ${kref.param} unbound at jump`);
        storeAt(wk, r.d, r.i, v);
        b.u8(w.BR);
        b.lebU(wk.depth - kref.openDepth - 1);
        break;
      }
      emitDispatch(em, f, v, kref.local);
      break;
    }
    case "halt": {
      // The program boundary: run() called main (the only non-tail call in
      // the chain), so a plain return lands the program result there. A
      // unit-literal result rides the canonical null box (the tagged-null
      // unit the interpreter echoes) — pushAtom's stamped path would
      // surface a $I64 0 that hostUnbox shows as "0".
      const v = f.anyref();
      if (t.v.t === "lit" && t.v.v === null) f.pushRef(em.lay.unitRef);
      else pushAtom(wk, t.v);
      b.localSet(v);
      b.localGet(v);
      b.u8(w.RETURN);
      break;
    }
    case "dret": {
      // Direct-function boundary: the boxed value IS the return. In a direct
      // body the kL local is never set (null), so dispatch would immediately
      // take its null-k branch — return straight away. Everywhere else
      // (thunks over CPS regions) the ambient chain head is real.
      const v = f.anyref();
      pushAtom(wk, t.v);
      b.localSet(v);
      if (wk.directFn === true) {
        b.localGet(v);
        b.u8(w.RETURN);
      } else {
        emitDispatch(em, f, v, wk.kL);
      }
      break;
    }
    case "dcall": {
      const p = (t as ADcall).__p!;
      // Tail shape: the rest delivers the dcall's own result to the boundary
      // (dret in a direct body, halt in main) — the direct path can
      // return_call, keeping tail recursion O(1) on the wasm stack.
      const tailDret = (t.rest.t === "dret" || t.rest.t === "halt") &&
        t.rest.v.t === "var" && t.rest.v.name === t.name;
      const argEmit = (k: number, ffp: number): void => {
        const r = f.anyref();
        pushAtom(wk, t.args[k]);
        b.localSet(r);
        b.localGet(ffp);
        b.refCast(4, true);
        b.structGet(4, 1);
        b.i32Const(k);
        b.localGet(r);
        b.arraySet();
      };
      const direct = directBuiltin(wk, t.fn);
      const fcb = direct === undefined ? f.anyref() : -1;
      if (direct === undefined) {
        pushAtom(wk, t.fn);
        b.localSet(fcb);
      }
      if (direct !== undefined) {
        // Builtin trampolines are T_KABI (no dual entries): the generic
        // land-cell path — builtin closures carry flag 0.
        const fpN2 = extendFrame(wk, p.fnLvl!.size);
        const thunk = makeRestThunk(em, "dcall:" + t.name);
        p.thunk = thunk;
        emitDcallThunk(wk, thunk, t, p);
        const cell = f.retCell(thunk.idx, () => cellNextE(wk, b), fpN2);
        emitCallClosure(f, fcb, t.args.length, argEmit, {tail: true, kL: cell, direct});
        break;
      }
      // Unknown callee value: the $CLO flag picks the entry ABI. Static
      // knowledge is only a hint, never a bypass — a pure-typed slot can
      // hold a resume binder or an any-smuggled suspending closure.
      const fc = f.anyref();
      pushAtom(wk, t.fn);
      b.localSet(fc);
      const flag = f.i32();
      b.localGet(fc);
      b.refCast(6, true);
      b.structGet(6, 3);
      b.i31Get();
      b.localSet(flag);
      b.localGet(flag);
      // Void arms: the direct arm ends in a return_call (tail) or in a
      // dispatch (non-tail — the rest runs in the cell's thunk, so the
      // site always diverges); the CPS arm always tail-calls. The scope
      // counts in br-depth arithmetic (the arms may br outer labels).
      b.if();
      wk.depth++;
      if (tailDret) {
        // Tail: a native return_call — tail recursion stays O(1) on the
        // wasm stack. Norm is skipped: the callee rounds at its own
        // producing nodes and the caller's stamp is the same width.
        emitDirectEntryCall(em, f, fc, t.args.length, argEmit, {kind: "tail"});
      } else {
        // Direct entry: frame over the closure's env; the result is
        // dispatched into the rest cell so the rest runs in its thunk —
        // the same layout the CPS arm uses, minus the generic callee
        // trampoline (the saving: one continuation operand + one T_KABI
        // indirection per call).
        const r = emitDirectEntryCall(em, f, fc, t.args.length, argEmit, {kind: "raw"});
        const fpN2 = extendFrame(wk, p.fnLvl!.size);
        const thunk = makeRestThunk(em, "dcall:" + t.name);
        p.thunk = thunk;
        emitDcallThunk(wk, thunk, t, p);
        const cell = f.retCell(thunk.idx, () => cellNextE(wk, b), fpN2);
        if (t.norm !== undefined) {
          const nrm = f.anyref();
          b.localGet(r);
          if (t.norm !== "f64") b.callFn(widthHelper(em, t.norm));
          else b.callFn(em.ix.fNum64);
          rebox(em, f, t.norm);
          b.localSet(nrm);
          emitDispatch(em, f, nrm, cell);
        } else {
          emitDispatch(em, f, r, cell);
        }
      }
      b.u8(w.ELSE);
      // CPS entry (resume binder, any-smuggled closure): the land-cell path —
      // the cell's frame is F_n (allocated here), next the ambient chain
      // (null in a direct body: the completion's dret returns the value).
      const fpN2 = extendFrame(wk, p.fnLvl!.size);
      const thunk = makeRestThunk(em, "dcall:" + t.name);
      p.thunk = thunk;
      emitDcallThunk(wk, thunk, t, p);
      const cell = f.retCell(thunk.idx, () => cellNextE(wk, b), fpN2);
      emitCallClosure(f, fc, t.args.length, argEmit, {tail: true, kL: cell});
      b.u8(w.END);
      wk.depth--;
      b.u8(w.UNREACHABLE); // both arms diverge (tail call / the rest's own tail)
      break;
    }
    default:
      throw new WasmError("internal: no term emitter for this node");
  }
}

// The dcall rest thunk (T_III_I: frame = F_n, v = the call's result,
// kNext = the cell's next = the ambient at the site). Allocates the fresh
// activation frame (the result slot + the rest's top-level binds), writes
// the normalized result, and runs the rest with kNext as the ambient — the
// same frame layout the direct-entry inline path installs.
function emitDcallThunk(wk: Walk, thunk: Fn, t: CTerm & {t: "dcall"}, p: DcallP): void {
  const em = wk.em;
  const entry = p.entryScope![0];
  // directFn must NOT leak into thunks: they are CPS fragments over the
  // materialized chain — their dret dispatches through kNext (the cell's
  // next), it never returns the fragment's value. A direct fn's ambient kL
  // is the never-set null: thunks created inside one get a TERMINAL return
  // cell below (kTerminal, inherited) instead of the raw null, so a dret
  // inside a void arm dispatches to a K_RET whose fragment just returns its
  // param — the value unwinds as each fragment's result instead of yielding
  // inside a void arm (whose trailing unreachable would execute).
  const tw: Walk = {em, f: thunk, ts: thunkBase(p.entryScope!), kL: 2, esc: p.bodyEsc!, labels: [], depth: 0, exitName: wk.exitName, retName: wk.retName, kTerminal: wk.kTerminal};
  addLocal(tw.ts[0], "$ret", 2);
  if (wk.exitName !== undefined) addLocal(tw.ts[0], wk.exitName, 2);
  if (wk.retName !== undefined) addLocal(tw.ts[0], wk.retName, 2);
  const nb = extendFrame(tw, entry.size);
  thunk.body.localGet(nb);
  thunk.body.localSet(0);
  const si = entry.slots.get(t.name);
  if (si === undefined) throw new WasmError(`internal: no slot for ${t.name}`);
  // The result (local 1), normalized by the dcall's norm, into the result
  // slot — the same box-normalization the inline path applies.
  if (t.norm !== undefined) {
    const nrm = thunk.anyref();
    thunk.body.localGet(1);
    if (t.norm !== "f64") thunk.body.callFn(widthHelper(em, t.norm));
    else thunk.body.callFn(em.ix.fNum64);
    rebox(em, thunk, t.norm);
    thunk.body.localSet(nrm);
    thunk.storeSlot(si, () => thunk.body.localGet(nrm));
  } else {
    thunk.storeSlot(si, () => thunk.body.localGet(1));
  }
  emitTerm(tw, t.rest);
}

// The letk thunk (T_III_I: frame = F_n, v = the resumed value, kNext = the
// cell's next = the ambient at installation). Allocates the fresh
// activation frame (param + the body's top-level binds), writes the
// normalized param, and runs the body with kNext as the ambient.
function emitLetkThunk(wk: Walk, thunk: Fn, t: CTerm & {t: "letk"}, p: LetkP): void {
  const em = wk.em;
  const entry = p.entryScope![0];
  // directFn must NOT leak into thunks: they are CPS fragments over the
  // materialized chain — their dret dispatches through kNext (the cell's
  // next), it never returns the fragment's value.
  const tw: Walk = {em, f: thunk, ts: thunkBase(p.entryScope!), kL: 2, esc: p.bodyEsc!, labels: [], depth: 0, exitName: wk.exitName, retName: wk.retName, kTerminal: wk.kTerminal};
  // $ret (the enclosing case's exit binder, the enclosing handle's ret
  // binder) denote the kNext param in a thunk: the cell's next = the ambient
  // at installation = the value those bindings held at the perform/call
  // site — and on resume re-entries the dynamic chain the interpreter's
  // per-run kOuter/k2rebinding produces.
  addLocal(tw.ts[0], "$ret", 2);
  if (wk.exitName !== undefined) addLocal(tw.ts[0], wk.exitName, 2);
  if (wk.retName !== undefined) addLocal(tw.ts[0], wk.retName, 2);
  const nb = extendFrame(tw, entry.size);
  thunk.body.localGet(nb);
  thunk.body.localSet(0);
  // Param (local 1), normalized by the letk's norm, into slot 0. The param
  // is always a box: narrow/wide ints unbox via their width helper, f64 via
  // the adaptive $num64 (the value may ride in any numeric box).
  if (t.norm !== undefined) {
    const nrm = thunk.anyref();
    thunk.body.localGet(1);
    if (t.norm !== "f64") thunk.body.callFn(widthHelper(em, t.norm));
    else thunk.body.callFn(em.ix.fNum64);
    rebox(em, thunk, t.norm);
    thunk.body.localSet(nrm);
    thunk.storeSlot(0, () => thunk.body.localGet(nrm));
  } else {
    thunk.storeSlot(0, () => thunk.body.localGet(1));
  }
  emitTerm(tw, t.body);
}

// The scope replayed for a thunk: the site's frames with all locals
// demoted; $ret/$exit resolve to the kNext param (bound in the entry
// level by emitLetkThunk's caller).
function thunkBase(entryScope: TScope): TScope {
  return entryScope.map(l => ({slots: l.slots, size: l.size, locals: null}));
}

// Direct builtin specialization: an unbound callee name that names a used
// builtin trampoline.
function directBuiltin(wk: Walk, fnAtom: CAtom): {idx: number, fsize: number} | undefined {
  if (fnAtom.t !== "var") return undefined;
  if (resolveT(wk.ts, fnAtom.name) !== null) return undefined;
  const name = fnAtom.name;
  if (!wk.em.o.usedBuiltins.has(name)) return undefined;
  if (!BUILTINS.some(bb => bb.name === name)) return undefined;
  const idx = wk.em.ix.builtinFnIdx.get(name);
  if (idx === undefined) return undefined;
  // Trampoline frame: args + map-like counters (0 for plain builtins).
  const extra = name === "each" ? 1 : (name === "map" || name === "flatmap") ? 2 : 0;
  return {idx, fsize: 0 + extra + (name === "map" || name === "flatmap" || name === "each" ? 0 : 0) + argcOf(name)};
  function argcOf(n: string): number {
    switch (n) {
      case "map": case "flatmap": return 2;
      case "each": return 2;
      default: return 0;
    }
  }
}

// Destructure a tuple/array-window value into the current frame's field
// slots (runtime shape dispatch, matching the interpreter's dlet).
function emitDlet(wk: Walk, t: CTerm & {t: "dlet"}, v: number): void {
  const f = wk.f, b = f.body;
  b.localGet(v);
  b.refTest(12, false); // $TUP
  b.if();
  {
    const blk = f.anyref();
    b.localGet(v);
    b.refCast(12, true);
    b.structGet(12, 0);
    b.localSet(blk);
    for (let i = 0; i < t.fields.length; i++) {
      b.localGet(blk);
      b.refCast(1, true);
      b.i32Const(i);
      b.arrayGet(1);
      const tmp = f.anyref();
      b.localSet(tmp);
      storeAt(wk, 0, wk.ts[0].slots.get(t.fields[i])!, tmp);
    }
  }
  b.u8(w.ELSE);
  {
    const d = f.anyref(), off = f.i32(), len = f.i32();
    b.localGet(v);
    f.unboxSlice(d, off, len);
    for (let i = 0; i < t.fields.length; i++) {
      b.localGet(d);
      b.refCast(1, true);
      b.localGet(off);
      b.i32Const(i);
      b.u8(w.ADD);
      b.arrayGet(1);
      const tmp = f.anyref();
      b.localSet(tmp);
      storeAt(wk, 0, wk.ts[0].slots.get(t.fields[i])!, tmp);
    }
  }
  b.u8(w.END);
}

// ---------------------------------------------------------------------------
// perform (IR): the k-operand cell is the continuation.
// Slice = [k cell .. handler) captured by position (the shared resume
// fn's splice machinery unchanged).

function emitPerformT(wk: Walk, t: CTerm & {t: "perform"}): void {
  const em = wk.em, f = wk.f, b = f.body;
  // Fine-grained runtime trace points (EFTRACE, via tracePoint): bisects
  // which perform phase traps — the walk/rec/case-dispatch machinery is
  // deep.
  const tr = (s: string): void => tracePoint(em, f, `f${f.fid} ${s}`);
  const blk = f.anyref(), cell = f.anyref();
  b.i32Const(t.args.length);
  b.arrayNew(1);
  b.localSet(blk);
  for (let k = 0; k < t.args.length; k++) {
    const r = f.anyref();
    pushAtom(wk, t.args[k]);
    b.localSet(r);
    b.localGet(blk);
    b.refCast(1, true);
    b.i32Const(k);
    b.localGet(r);
    b.arraySet();
  }
  b.localGet(blk);
  b.refCast(1, true);
  b.i32Const(0);
  b.i32Const(t.args.length);
  b.structNew(3); // op-args carrier: fresh window [0, n)
  b.localSet(cell);
  tr("perform:carrier " + t.op);
  const opid = em.d.effOpIds.get(t.op)!;
  const kref = resolveK(wk, t.k);
  if (kref.kind === "label") throw new WasmError("internal: perform k must be materialized");
  // The k operand denotes the ambient continuation (converter guarantee),
  // so the reified cell IS the ambient head: the walk starts at its next.
  const kL = f.anyref(), hdl = f.anyref(), tbl = f.anyref();
  const steps = f.i32();
  const knd = f.i32();
  let found = 0, fnIdx = 0, fsz = 0, nparams = 0;
  b.localGet(kref.local);
  b.localSet(kL);
  b.i32Const(0);
  b.localSet(steps);
  f.walkLoop(
    () => {
      b.localIsNull(kL); // k=0 → no handler anywhere → host fallback
    },
    () => {
      cellGet(b, kL, 0); b.i31Get();
      b.localSet(knd);
      tracePoint(em, f, "walk:kind", () => b.localGet(knd));
      b.localGet(knd);
      b.i32Const(w.K_HDL);
      b.u8(w.EQ);
      b.if();
      tracePoint(em, f, "walk:K_HDL");
      cellGet(b, kL, 1);
      b.localSet(tbl);
      tracePoint(em, f, "walk:tbl", () => {
        b.localGet(tbl);
        b.refCast(1, true);
        b.i32Const(0);
        b.arrayGet(1); // first row's opid — identifies WHICH handle's table
        b.refCast(w.I31REF, false);
        b.i31Get();
      });
      tracePoint(em, f, "walk:fsz", () => {
        cellGet(b, kL, 2);
        b.refCast(4, true);
        b.structGet(4, 1);
        b.arrayLen(); // original handle frame vs the resume hfc (fsz=4)
      });
      ({found, fnIdx, fsz, nparams} = emitCaseScan(f, tbl, () => b.i32Const(opid), () => {
        b.localGet(kL);
        b.localSet(hdl); // remember the matching handler cell
      }));
      b.localGet(found);
      b.u8(w.BR_IF);
      b.lebU(2); // matched handler → leave the walk
      b.u8(w.END);
      if (DBGTRACE) {
        // K_RET only: field a = the thunk funcref (i31) — identifies the
        // letk (an HDL's field 1 is a table ref, not an i31).
        b.localGet(knd);
        b.u8(w.EQZ);
        b.if();
        tracePoint(em, f, "walk:fn", () => {
          cellGet(b, kL, 1);
          b.refCast(w.I31REF, false);
          b.i31Get();
        });
        b.u8(w.END);
      }
      cellGet(b, kL, 3);
      b.localSet(kL);
      b.localGet(steps);
      b.i32Const(1);
      b.u8(w.ADD);
      b.localSet(steps);
      tracePoint(em, f, "walk:step", () => b.localGet(steps));
    },
  );
  // Resume capture record: 5 slots {1: slice, 2: table, 3: hfc, 4: slen};
  // slice = [k cell] + the walked cells (slen = steps + 1).
  const rec = extendFrame(wk, 5);
  const recSlots = f.typed(_T.RF[1]);
  b.localGet(rec);
  b.structGet(4, 1);
  b.localSet(recSlots);
  b.i31Const(em.ix.resumeFn.idx); // i31Const already refI31s
  b.localGet(rec);
  b.i32Const(1);
  b.refI31();
  b.i32Const(0); // CPS entry (T_KABI): the resume fn drives the chain
  b.refI31();
  b.structNew(6); // the resume binder: $CLO over $resumeCapture
  const rclo = f.anyref();
  b.localSet(rclo);
  b.localGet(found);
  b.if(); // void: both arms end in tail calls (the no-handler arm drops
  // the dead null-k path's block result below)
  // FOUND ARM — everything here dereferences hdl (null when no handler
  // matched; the walk may end at k=0 without ever setting it).
  tracePoint(em, f, "perform:found", () => b.localGet(fsz)); // matched row's fsize
  // rec[1] = the captured chain [k cell .. handler); rec[2] = the handler's
  // case table; rec[3] = the per-invocation hframe copy; rec[4] = the chain
  // length (the shared resume fn splices the fresh HDL back in on resume).
  b.localGet(recSlots);
  b.i32Const(1);
  b.localGet(kref.local);
  b.refCast(5, true);
  b.localGet(steps);
  b.i32Const(1);
  b.u8(w.ADD);
  b.refI31();
  tr("perform:preCapture");
  b.callFn(em.ix.fCapture);
  b.arraySet();
  tr("perform:rec1");
  b.localGet(recSlots);
  b.i32Const(2);
  b.localGet(hdl);
  b.refCast(5, true);
  b.structGet(5, 1); // the matched handler's case table
  b.arraySet();
  tr("perform:rec2");
  // rec[0] = the ORIGINAL HDL cell: the shared resume fn's off-chain
  // rewrite needs it to recognize install-time cells tailing into this
  // handle (fCapture's copies hide it — the splice only retargets copies).
  b.localGet(recSlots);
  b.i32Const(0);
  b.localGet(hdl);
  b.refCast(5, true);
  b.arraySet();
  // Per-invocation hframe copy (case invocations of one handler nest; the
  // resume record roots this invocation's copy).
  // fsz is a runtime local from the scan — the frame size and copy length
  // read the local (a JS i32Const here would emit the local's INDEX as a
  // constant); the op arity is static (the performed op's arg count = the
  // matched row's nparams).
  const hfc = f.typed(_T.RF[4]), slots = f.typed(_T.RF[1]);
  // The hfc's parent = the matched handler's hframe parent: the case body's
  // slot depths resolve against the HANDLE site's frame chain (where the
  // case is defined), not the perform site's (which may be inside a letk
  // thunk with extra activation frames).
  b.localGet(hdl);
  b.refCast(5, true);
  b.structGet(5, 2); // the shared hframe
  b.refCast(4, true);
  b.structGet(4, 0); // its parent = the handle site's frame
  b.localGet(fsz);
  b.arrayNew(1);
  b.structNew(4);
  b.localSet(hfc);
  b.localGet(hfc);
  b.structGet(4, 1);
  b.localSet(slots);
  b.localGet(slots);
  b.i32Const(0);
  b.localGet(hdl);
  b.refCast(5, true);
  b.structGet(5, 2); // the shared hframe
  b.refCast(4, true);
  b.structGet(4, 1);
  b.i32Const(0);
  b.localGet(fsz);
  b.arrayCopy(1, 1);
  tr("perform:hfcCopied");
  for (let k = 0; k < t.args.length; k++) {
    b.localGet(slots);
    b.i32Const(k);
    b.localGet(cell);
    b.refCast(3, true);
    b.structGet(3, 0); // data
    b.refCast(1, true);
    b.i32Const(k);
    b.arrayGet(1);
    b.arraySet();
  }
  b.localGet(slots);
  b.localGet(nparams); // the resume slot = the matched row's nparams (npMax)
  b.localGet(rclo);
  b.arraySet();
  tr("perform:caseDispatch");
  b.localGet(recSlots);
  b.i32Const(3);
  b.localGet(hfc);
  b.arraySet();
  b.localGet(recSlots);
  b.i32Const(4);
  b.localGet(steps);
  b.i32Const(1);
  b.u8(w.ADD);
  b.refI31();
  b.arraySet();
  b.localGet(hfc);
  // k = the matched handler's own continuation, walked past K_HDL cells:
  // on a resumed perform the found hdl is a chain copy whose next is the
  // fresh splice cell — the case body's completion ($xit = kNext) must
  // reach the resume's k2 directly, exactly like the interpreter's
  // per-run kOuter, not re-enter the fresh cell's Return scan. A null
  // next is the tail handle's direct boundary: the case completion's
  // null-k dispatch returns the value to the direct entry, so the walk
  // exits before dereferencing.
  const ckn = f.typed(_T.RF[5]);
  const ckx = f.i32();
  cellGet(b, hdl, 3);
  b.localSet(ckn);
  f.walkLoop(
    () => {
      // ckx = 1 (exit) iff ckn is null (the tail handle's direct boundary —
      // the case completion's null-k dispatch returns to the entry) or ckn
      // is not a same-table K_HDL splice cell.
      b.localGet(ckn);
      b.u8(0xd1); // ref.is_null
      b.localSet(ckx);
      b.localGet(ckx);
      b.u8(w.EQZ);
      b.if();
      cellGet(b, ckn, 0); b.i31Get();
      b.i32Const(w.K_HDL); b.u8(w.EQ); b.u8(w.EQZ);
      b.localSet(ckx);
      b.localGet(ckx);
      b.u8(w.EQZ);
      b.if();
      cellGet(b, ckn, 1); b.refCast(w.EQREF, true);
      b.localGet(tbl); b.refCast(w.EQREF, true);
      b.refEq(); b.u8(w.EQZ);
      b.localSet(ckx);
      b.u8(w.END);
      b.u8(w.END);
      b.localGet(ckx);
    },
    () => {
      cellGet(b, ckn, 3);
      b.localSet(ckn);
      tracePoint(em, f, `f${f.fid} cknhop`, () => {
        const t1 = f.i32();
        b.localGet(ckn);
        b.u8(0xd1);
        b.localSet(t1);
        b.localGet(t1);
      });
    },
  );
  b.localGet(ckn);
  b.localGet(fnIdx);
  tracePoint(em, f, `f${f.fid} perform:dispatch`, () => {
    // val = ref.is_null(ckn) — the case completion target's nullness
    const t1 = f.i32();
    b.localGet(ckn);
    b.u8(0xd1); // ref.is_null
    b.localSet(t1);
    b.localGet(t1);
  });
  b.u8(w.RETURN_CALL_INDIRECT);
  b.lebU(w.T_KABI);
  b.lebU(0);
  b.u8(w.ELSE);
  tr("perform:noHandler");
  // No handler: the host interprets the op and the value flows to the
  // reified continuation (the k cell).
  const v = f.anyref();
  b.i32Const(opid);
  b.localGet(cell);
  b.callFn(em.o.impIdx.get("ef_perform")!);
  b.localSet(v);
  emitDispatch(em, f, v, kref.local);
  b.drop(); // the null-k path's block result; dead here (cell is non-null)
  b.u8(w.END);
  b.u8(0x00); // unreachable: both arms end in a tail call
}

// ---------------------------------------------------------------------------
// handle (IR).

function emitHandleT(wk: Walk, t: AHandle): void {
  const em = wk.em, f = wk.f, b = f.body;
  const hp = t.__p!;
  const hf = f.typed(_T.RF[4]), hdl = f.anyref();
  b.localGet(0); // parent = the frame at the handle site
  b.i32Const(hp.hframeSize);
  b.arrayNew(1);
  b.structNew(4);
  b.localSet(hf);
  // HDL next = the handle's own continuation (the k-operand cell — always
  // materialized; the converter wrapped the after-handle rest). A tail
  // handle in a direct body resolves k to the never-set knull local — the
  // terminal cell stands in: a real K_RET whose fragment returns the value,
  // so the caseDispatch's ckn walk yields a live chain link (a raw null
  // would sever the resume's k2 threading and lose propagating performs).
  const kref = resolveK(wk, t.k);
  if (kref.kind === "label") throw new WasmError("internal: handle k must be materialized");
  b.i31Const(w.K_HDL);
  b.globalGet(em.lay.hdlTableOff.get(hp.hdlIdx)!);
  b.localGet(hf);
  if (wk.kTerminal === true && kref.local === wk.kL) {
    // The tail handle's knull boundary: the terminal cell stands in so the
    // caseDispatch's ckn walk yields a live chain link (a raw null would
    // sever the resume's k2 threading and lose propagating performs).
    cellNextE(wk, b);
    b.refCast(5, true); // $K.next is $K-typed (cellNextE pushes an anyref global)
  } else {
    b.localGet(kref.local);
    b.refCast(5, true);
  }
  b.structNew(5);
  b.localSet(hdl);
  // The ret binder: the HDL cell — frame slot (thunks inside the body
  // reach it through the chain) + a local for inline jumps.
  storeAt(wk, 0, hp.retSlot, hdl);
  addLocal(wk.ts[0], t.ret, hdl);
  // Body with the handler cell as the ambient continuation: every value
  // flows through the handler's Return entry. Thunks created inside the
  // body rebind the ret binder to their kNext (the done-marker rule). The
  // island's ambient chain is the HDL cell — a real continuation — so
  // kTerminal clears: cells installed inside must chain to it (their
  // completions reach the handler's ret path), not to the direct entry's
  // terminal return.
  const saved = wk.kL;
  const savedRet = wk.retName;
  const savedTerm = wk.kTerminal;
  wk.kL = hdl;
  wk.kTerminal = false;
  wk.retName = t.ret;
  emitTerm(wk, t.body);
  wk.kL = saved;
  wk.retName = savedRet;
  wk.kTerminal = savedTerm;
  b.u8(0x00); // unreachable: the body's dispatch tail-calls away
}

// Case fns (T_KABI over the hframe): the exit binder is the k param; op
// cases read their resume binder from the hframe (written at the perform
// site); the Return case's prologue materializes its identity resume.
function emitCaseBody(em: Emit, f: Fn, body: CTerm, base: TScope, esc: Set<string>, exitName: string, retResumeIdx: number | undefined, npMax: number): void {
  const wk: Walk = {em, f, ts: base, kL: 1, esc, labels: [], depth: 0, exitName};
  tracePoint(em, f, `case f${f.fid} enter`);
  if (retResumeIdx !== undefined) {
    // resume binder (slot npMax) := $CLO{retResume, env = this hframe} —
    // the funcref is retRes0 + retResumeIdx (the plan's per-handle counter
    // indexes into the ret-resume block, not the raw table).
    const clo = f.anyref();
    const bb = f.body;
    bb.i32Const(em.ix.retRes0 + retResumeIdx);
    bb.refI31();
    bb.localGet(0);
    bb.i32Const(0);
    bb.refI31();
    bb.i32Const(0); // CPS entry (T_KABI)
    bb.refI31();
    bb.structNew(6);
    bb.localSet(clo);
    f.storeSlot(npMax, () => bb.localGet(clo));
  }
  addLocal(base[0], exitName, 1);
  emitTerm(wk, body);
}

// Identity ret fn (no explicit Return case): deliver hf[slot] through k.
// The terminal-return fragment: (frame, v, kNext) -> v — the direct-fn
// dcall fallbacks' terminal chain link (see cellNextE). A plain return:
// the dispatcher's return_call chain unwinds the value to the direct fn's
// return.
export function emitTerminalRet(em: Emit, f: Fn): void {
  f.em = em;
  f.body.localGet(1);
  em.funcs.push(f);
}

function emitIdRetFn(em: Emit, f: Fn, slot: number): void {
  const b = f.body;
  const v = f.anyref();
  b.localGet(0);
  b.structGet(4, 1);
  b.i32Const(slot);
  b.arrayGet(1);
  b.localSet(v);
  emitDispatch(em, f, v);
}

// The ret case's identity resume: (frame, k) -> the done value (the
// invocation hframe's Return slot, reached via the $CLO env = the frame's
// parent), dispatched through k — exactly the interpreter's
// `native((_a, k2) => k2(out.value))`.
function emitRetResumeFn(em: Emit, f: Fn, slot: number): void {
  const b = f.body;
  const v = f.anyref();
  b.localGet(0);
  b.structGet(4, 0); // the $CLO env (the invocation's hframe)
  b.structGet(4, 1);
  b.i32Const(slot);
  b.arrayGet(1);
  b.localSet(v);
  emitDispatch(em, f, v);
}

// The shared resume fn — its record layout and slice-splice mechanics are
// IR-independent; the slice head is the perform's k-operand cell.
export function emitResumeFn(em: Emit, rf: Fn): void {
  rf.em = em;
  tracePoint(em, rf, "resumeFn enter");
  {
    const b = rf.body;
    const v = rf.anyref(), rec = rf.anyref(), slice = rf.anyref();
    const copy = rf.anyref(), fresh = rf.anyref(), cur = rf.anyref();
    const len = rf.i32(), j = rf.i32();
    const recSlot = (n: number): void => {
      b.localGet(rec);
      b.refCast(4, true);
      b.structGet(4, 1);
      b.i32Const(n);
      b.arrayGet(1);
    };
    rf.slot(0);
    b.localSet(v); // the resumed value: the closure call frame's slot 0
    b.localGet(0);
    b.structGet(4, 0); // the capture record (env frame)
    b.localSet(rec);
    recSlot(1);
    b.localSet(slice);
    recSlot(4);
    i31of(b);
    b.localSet(len);
    b.localGet(slice);
    b.refCast(5, true);
    b.localGet(len);
    b.refI31();
    b.callFn(em.ix.fCapture);
    b.localSet(copy);
    b.i31Const(w.K_HDL);
    recSlot(2); // a = the matched handler's case table
    recSlot(3); // b = the invocation's hframe copy
    b.localGet(1); // next = the k this closure was invoked with
    b.refCast(5, true); // $K.next is $K-typed
    b.structNew(5);
    b.localSet(fresh);
    // Splice the fresh HDL onto the copy's bottom: len-1 next-steps from
    // the head (len ≥ 1 — the slice always starts at the perform's k cell).
    b.localGet(copy);
    b.localSet(cur);
    b.i32Const(1);
    b.localSet(j);
    rf.walkLoop(
      () => {
        b.localGet(j);
        b.localGet(len);
        b.u8(w.EQ);
      },
      () => {
        cellGet(b, cur, 3);
        b.localSet(cur);
        b.localGet(j);
        b.i32Const(1);
        b.u8(w.ADD);
        b.localSet(j);
      },
    );
    b.localGet(cur);
    b.refCast(5, true);
    b.localGet(fresh);
    b.refCast(5, true);
    b.structSet(3);
    // Off-chain cell rewrite: the interpreter's done marker short-circuits
    // to the resuming run's k2 (pending outer resumptions are abandoned),
    // so every K cell in the sub-run's frames whose next tails into a
    // K_HDL OF THIS HANDLE — while-exit cells and other install-time cells
    // off the captured next-chain — must tail into the fresh HDL instead;
    // else a resumed sub-run completing through them halts at the original
    // κ (or routes through a stale earlier fresh chain, looping forever).
    // Handle identity = the case table (field a is shared by the original
    // HDL and every fresh copy; fCapture's copies hide the original, and
    // the splice only retargets copied cells).
    // `copy` is the copied chain's HEAD cell (fCapture walks `next`).
    const cel = rf.typed(_T.RF[5]);
    const fr = rf.typed(_T.RF[4]), slots = rf.typed(_T.RF[1]);
    const nxt = rf.anyref(), val = rf.anyref(), ck = rf.typed(_T.RF[5]);
    const tab = rf.anyref();
    const i2 = rf.i32(), slen = rf.i32(), s2 = rf.i32(), tst = rf.i32();
    tracePoint(em, rf, "scan:enter", () => b.localGet(len));
    recSlot(2);
    b.localSet(tab); // this handle's case table: the HDL identity
    b.localGet(copy);
    b.refCast(5, true);
    b.localSet(cel);
    b.i32Const(0);
    b.localSet(i2);
    rf.walkLoop(
      () => {
        // exit when i2 >= len OR cel == null — an overshot len must not
        // deref a null chain tail (amb.ef crashed struct.get-ing null).
        b.localGet(i2); b.localGet(len); b.u8(w.LTS);
        b.localGet(cel); b.u8(0xd1); b.u8(w.EQZ); // cel non-null
        b.u8(w.AND);
        b.u8(w.EQZ);
      },
      () => {
        b.localGet(cel);
        b.structGet(5, 3); // save next before any rewrite of this cell
        b.localSet(nxt);
        b.localGet(cel);
        b.structGet(5, 2); // the cell's frame (b field)
        b.refCast(4, true);
        b.localSet(fr);
        rf.walkLoop(
          () => { b.localIsNull(fr); },
          () => {
            b.localGet(fr);
            b.structGet(4, 1);
            b.localSet(slots);
            b.localGet(slots);
            b.arrayLen();
            b.localSet(slen);
            tracePoint(em, rf, "scan:frame", () => b.localGet(slen));
            b.i32Const(0);
            b.localSet(s2);
            rf.walkLoop(
              () => { b.localGet(s2); b.localGet(slen); b.u8(w.LTS); b.u8(w.EQZ); },
              () => {
                b.localGet(slots); b.localGet(s2); b.arrayGet(1);
                b.localSet(val);
                b.localGet(val);
                b.refTest(5, false);
                b.localSet(tst);
                if (DBGTRACE) {
                  b.localGet(tst);
                  b.if();
                  tracePoint(em, rf, "scan:kcell", () => b.i32Const(1));
                  b.u8(w.END);
                }
                b.localGet(tst);
                b.if();
                b.localGet(val);
                b.refCast(5, false);
                b.localSet(ck);
                // Rewrite only when ck.NEXT is a K_HDL of this handle (same
                // case table). Reading ck's OWN a field instead matched the
                // handle's HDL cells themselves — retargeting the original
                // HDL's next to the fresh cell severed the chain to OUTER
                // handles (amb.ef's Emit became unhandled on resume).
                b.localGet(ck);
                b.structGet(5, 3);
                b.localSet(nxt);
                b.localGet(nxt);
                b.refTest(5, false);
                b.localSet(tst);
                b.localGet(tst);
                b.if();
                b.localGet(nxt);
                b.refCast(5, false);
                b.structGet(5, 0);
                b.i31Get();
                b.i32Const(w.K_HDL);
                b.u8(w.EQ);
                b.localSet(tst);
                b.localGet(tst);
                b.if();
                b.localGet(nxt);
                b.refCast(5, false);
                b.structGet(5, 1);
                b.refCast(w.EQREF, true); // ref.eq needs eqref on both sides
                b.localGet(tab);
                b.refCast(w.EQREF, true);
                b.refEq();
                b.localSet(tst);
                b.localGet(tst);
                b.if();
                tracePoint(em, rf, "scan:rewrite", () => b.localGet(s2));
                b.localGet(ck);
                b.localGet(fresh);
                b.refCast(5, true); // $K.next is (ref null $5)
                b.structSet(3);
                b.u8(w.END);
                b.u8(w.END);
                b.u8(w.END);
                b.u8(w.END); // closes the is-K-cell guard
                b.localGet(s2); b.i32Const(1); b.u8(w.ADD); b.localSet(s2);
              },
            );
            b.localGet(fr);
            b.structGet(4, 0);
            b.localSet(fr);
          },
        );
        b.localGet(nxt); // advance along the captured chain
        b.refCast(5, true);
        b.localSet(cel);
        b.localGet(i2); b.i32Const(1); b.u8(w.ADD); b.localSet(i2);
      },
    );
    tracePoint(em, rf, "scan:done");
    emitDispatch(em, rf, v, copy); // k = the closure's own k param
  }
  em.funcs.push(rf);
}

// ---------------------------------------------------------------------------
// Orchestration: emit all functions of a compile.

// CFns (T_KABI over their captured scope + params) and main (T_KABI over
// the global frame). Letk thunks are created during the walks (makeRestThunk
// appends them to em.thunks in creation order). Case fns, identity rets and
// ret resumes are emitted into em.funcs in plan order — the caller (wasm.ts)
// sequences: helpers → this → builtins → thunks → main.
export function emitCfns(em: Emit, ir: CIr, plan: TermPlan): void {
  (em as Emit & {plan?: TermPlan}).plan = plan;
  for (let i = 0; i < ir.funcs.length; i++) {
    const fn = ir.funcs[i];
    const base = plan.cfnBase.get(i)!;
    const paramsL = lvl();
    for (const p of fn.params) addSlot(paramsL, p);
    if (fn.direct === true) {
      // Direct ABI: (frame) -> anyref — no continuation operand. The kL
      // local is never set (null): generic land-cell paths inside (a dcall's
      // CPS-entry branch) build cells whose next is null, so their completions
      // return instead of walking a chain. dret returns the boxed value.
      const f = new Fn(1, em);
      f.typeIdx = w.T_DABI;
      f.idx = em.ix.lambda0 + i;
      em.ix.funcRefTypes.set(f.idx, w.T_DABI);
      const knull = f.typed(_T.RF[5]);
      const wk: Walk = {
        em, f, ts: [paramsL, ...base], kL: knull,
        esc: analyzeEscapes(fn.body), labels: [], depth: 0, directFn: true, kTerminal: true,
      };
      addLocal(wk.ts[0], "$ret", knull); // never referenced (dret boundary)
      emitTerm(wk, fn.body);
      em.funcs.push(f);
      continue;
    }
    const f = new Fn(2, em);
    f.typeIdx = w.T_KABI;
    f.idx = em.ix.lambda0 + i;
    em.ix.funcRefTypes.set(f.idx, w.T_KABI);
    const wk: Walk = {
      em, f, ts: [paramsL, ...base], kL: 1,
      esc: analyzeEscapes(fn.body), labels: [], depth: 0,
    };
    addLocal(wk.ts[0], "$ret", 1);
    emitTerm(wk, fn.body);
    em.funcs.push(f);
  }
}

// Case fns + identity rets + ret resumes, in plan order (must match the
// funcref indices assigned in wasm.ts's index layout).
export function emitCaseFns(em: Emit, plan: TermPlan): void {
  // The identityRet slot is always reserved in the index layout (its index
  // precedes case0) — it holds the shared default-Return fn for npMax=0
  // handles without an explicit Return case: read the Return value
  // emitDispatch stashed in hframe slot 1, dispatch it through k.
  const idf = new Fn(2, em);
  idf.typeIdx = w.T_KABI;
  idf.idx = em.ix.identityRet.idx;
  em.ix.funcRefTypes.set(idf.idx, w.T_KABI);
  idf.em = em;
  emitIdRetFn(em, idf, 1);
  em.funcs.push(idf);
  // Pass 1: every case fn (op cases + explicit Return cases) — the layout
  // assigns them the contiguous case0.. block, so they must all be emitted
  // before the identity rets (pass 2), which own the idRet0.. block. A
  // per-handle interleaving here would collide funcrefs once a program has
  // two handles without explicit Return cases.
  for (const hdl of plan.hdlOrder) {
    const hp = hdl.__p!;
    const cases = hdl.cases;
    const npMax = Math.max(0, ...cases.map(c => c.params.length));
    let ci = 0;
    for (const c of cases) {
      if (c.op === "Return") continue;
      const cp = hp.caseP[ci++];
      const f = new Fn(2, em);
      f.typeIdx = w.T_KABI;
      f.idx = em.ix.case0 + cp.fnIdx;
      em.ix.funcRefTypes.set(f.idx, w.T_KABI);
      f.em = em;
      emitCaseBody(em, f, c.body, cp.base, cp.esc, hdl.exit, undefined, npMax);
      em.funcs.push(f);
    }
    const retCase = cases.find(c => c.op === "Return");
    if (retCase !== undefined) {
      const cp = hp.retP!;
      const f = new Fn(2, em);
      f.typeIdx = w.T_KABI;
      f.idx = em.ix.case0 + cp.fnIdx;
      em.ix.funcRefTypes.set(f.idx, w.T_KABI);
      f.em = em;
      emitCaseBody(em, f, retCase.body, cp.base, cp.esc, hdl.exit, hp.retResumeIdx, npMax);
      em.funcs.push(f);
    }
  }
  // Pass 2: per-handle identity rets (handles without an explicit Return
  // case), in plan order over the idRet0.. block.
  for (const hdl of plan.hdlOrder) {
    const hp = hdl.__p!;
    if (hp.idRetIdx === undefined) continue;
    const npMax = Math.max(0, ...hdl.cases.map(c => c.params.length));
    const f = new Fn(2, em);
    f.typeIdx = w.T_KABI;
    f.idx = em.ix.idRet0 + hp.idRetIdx;
    em.ix.funcRefTypes.set(f.idx, w.T_KABI);
    f.em = em;
    emitIdRetFn(em, f, npMax + 1);
    em.funcs.push(f);
  }
}

// Ret-resume fns (one per handle with an explicit Return case).
export function emitRetResumes(em: Emit, plan: TermPlan): void {
  let n = 0;
  for (const hdl of plan.hdlOrder) {
    const hp = hdl.__p!;
    if (hp.retResumeIdx === undefined) continue;
    const cases = hdl.cases;
    const npMax = Math.max(0, ...cases.map(c => c.params.length));
    const f = new Fn(2, em);
    f.typeIdx = w.T_KABI;
    f.idx = em.ix.retRes0 + n++;
    em.ix.funcRefTypes.set(f.idx, w.T_KABI);
    f.em = em;
    emitRetResumeFn(em, f, npMax + 1);
    em.funcs.push(f);
  }
}

// The program term over the global frame; halt returns the program result
// (run() is the only non-tail caller in the chain).
export function emitMain(em: Emit, ir: CIr, plan: TermPlan): void {
  const f = new Fn(2, em);
  f.typeIdx = w.T_KABI;
  f.em = em;
  const wk: Walk = {
    em, f, ts: [plan.globalLvl], kL: 1,
    esc: analyzeEscapes(ir.term), labels: [], depth: 0,
  };
  emitTerm(wk, ir.term);
  em.mainFn = f;
}

// The main fn's frame-size provider for run() (emitInits).
export function mainFrameSize(plan: TermPlan): number {
  return plan.globalLvl.size;
}
