// Frame/slot planning for the wasm backend: one traversal over the CPS IR
// that assigns every binding a frame slot, records escapes and devirt facts
// on per-node annotations, and finalizes the typed-slot and elision
// classification. This module OWNS the level structures (TLevel/TScope) and
// the `__p` annotations: their planning-owned fields (slots/size/rev/fnCtx/
// typed/elideOk/elided and the annotation facts) are never written outside
// this module. What emitters DO write on plan-owned structures: `locals`/
// `raw` walk state — attached to each walk's innermost level (a planned case
// level or globalLvl just as often as an entryLevel/thunkBase mint) — and
// `thunk` on letk/dcall annotations, set at emission when the thunk is
// created. Consumers read the published Plan and the annotations through
// the accessors below. The design doc for the whole backend lives at the
// top of wasm.ts.

import {WasmError} from "./wasm_types.ts";
import {type CIr, type CTerm, type CAtom, type CPrim, type CFn} from "../../frontend/cps_ir.ts";
import {analyzeDevirt, numericEntries, type Devirt, type NumEntry} from "./wasm_devirt.ts";
import {OP_EQ, OP_GE, OP_GT, OP_LE, OP_LT, OP_NE} from "../../ops.ts";
import type {Type} from "../../frontend/unify.ts";
import type {Fn} from "./wasm_body.ts";

// ---------------------------------------------------------------------------
// Static scope: the frame-slot model mirroring the interpreter's Env chain.
// Levels only grow during a unit walk (a scope's rest runs inside the
// extended frame; a materialized letk's rest runs inside its F_n), so there
// are no pops. levels[0] is the innermost (current) frame. The plan owns
// the level objects; the emitter's walk constructs the same chains over
// them (identical traversal) and attaches its own locals/raw.
export type TLevel = {
  slots: Map<string, number>,
  size: number,
  // Same-fn local bindings ($ret, a handle's ret binder, a case's exit
  // binder). Dropped when the scope is replayed into a thunk: $ret/$exit
  // resolve to the thunk's kNext param there. Emit-owned: planning never
  // writes it.
  locals: Map<string, number> | null,
  // A numeric entry's param locals: name -> raw width. The wasm local holds
  // the unboxed value (not an anyref), so reads normalize like ops, and a
  // thunk replay (thunkBase) drops the map like locals — only the frame
  // slots stay reachable cross-function. Emit-owned: planning never writes
  // it.
  raw?: Map<string, string>,
  // PR3: reverse of `slots` (slot index -> name) — write sites resolve
  // through (d, i) and need the name to consult `typed`.
  rev?: (string | undefined)[],
  // PR3: the wasm-fn region this level's slots bind in. A slot read or
  // written from any other region (thunks, case fns, nested lambdas) is
  // recorded by the planner and disqualifies typed-slot treatment — locals
  // die with the invocation, frames survive it.
  fnCtx?: number,
  // PR3: slot name -> numeric width, set by classifySlots after planning
  // completes. A typed slot never lands in the slots array; reads and
  // writes resolve to a same-fn wasm local through the WALK's tloc map
  // (NOT `locals`: resolveT's any-depth locals search assumes anyref
  // locals — a typed slot's unboxed value there would type-mismatch every
  // pushRef). Per-walk because multiple fns emit the same planned scopes.
  typed?: Map<string, string>,
  // PR3: scope-node level whose every slot is typed — the emitter skips
  // the frame allocation (all values ride same-fn locals) and the frame
  // hop drops together with it. Only scope nodes set this: chain anchors
  // (cfn param levels, letk entry/F_n frames, the main frame) always
  // materialize because other fns reach them through the parent chain.
  elideOk?: boolean,
  elided?: boolean,
};
export type TScope = TLevel[];

function lvl(): TLevel {
  return {slots: new Map(), size: 0, locals: null};
}
function addSlot(l: TLevel, name: string): number {
  const i = l.size++;
  l.slots.set(name, i);
  (l.rev ??= [])[i] = name;
  return i;
}

// The emit-side base level for a CFn entry walk: fresh per entry (each
// entry's walk attaches its own locals/raw to it), seeded with the params'
// slots — the same slot numbering the planned cfnParams level carries.
export function entryLevel(fn: CFn): TLevel {
  const l = lvl();
  for (const p of fn.params) addSlot(l, p);
  return l;
}

// The scope replayed for a thunk: the site's frames with all locals
// demoted; $ret/$exit resolve to the kNext param (bound in the entry level
// by emitLetkThunk/emitDcallThunk's caller).
export function thunkBase(entryScope: TScope): TScope {
  // locals demote (cross-fn); elided carries over — the replayed chain's
  // hop counting (frameHops) must skip the same levels the site fn
  // skipped. typed stays dropped: a thunk body's walk must not resurrect
  // site-fn typed slots (its ts differs from the rest walk's planned
  // restScope originals otherwise — divergence breaks while loops).
  return entryScope.map(l => ({slots: l.slots, size: l.size, locals: null, elided: l.elided}));
}

// ---------------------------------------------------------------------------
// Node annotations (per-compile; attached by planUnit, read by the term
// emitters through the accessors at the end of this section — the `__p`
// property never leaves this module).
export type LetkP = {
  mat: boolean,
  fnSlot?: number,           // F_n slot holding the continuation cell
  fnLvl?: TLevel,            // F_n's level — size read at emit time (the
  // rest's bindings land in F_n after the annotation was attached, so the
  // size is only final once planning completes)
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
export type HdlP = {
  hdlIdx: number,
  hframeSize: number,
  retSlot: number,
  caseP: CaseP[],            // op cases, declaration order
  retP?: CaseP,              // the Return case
  idRetIdx?: number,         // no-Return-case identity ret (npMax > 0)
  retResumeIdx?: number,     // ret case's identity resume binder
};
export type ScopeP = TLevel;

export type DcallP = {
  entryScope?: TScope,       // thunk rest base: [entry, F_n, ...site]
  bodyEsc?: Set<string>,     // the rest's own escape set
  fnLvl?: TLevel,            // the cell's frame (F_n)
  thunk?: Fn,                // created at emission
  // Devirt analysis (wasm_devirt.ts): the callee slot's only value is
  // direct CFn fun's closure — static T_DABI call, no flag dispatch. With
  // noEnv the callee has no capts: no closure value is loaded at all (null
  // frame parent).
  devirt?: {fun: number, noEnv?: true},
  // The rest is suspension-free with only-pure callees: it runs inline
  // after the static call (planned into the site's frame, no rest cell).
  inlineRest?: true,
  // Arg positions with singleton clo provenance (map-callback eligibility).
  argFun?: Map<number, number>,
};
export type CallP = {
  devirt?: {fun: number, noEnv?: true},  // the callee slot's only value is direct CFn fun's closure
  argFun?: Map<number, number>,          // arg positions with singleton clo provenance (map callbacks)
};

// The annotated node types stay private: only the planner writes `__p`,
// only these accessors read it.
type ALetk = CTerm & {t: "letk"} & {__p?: LetkP};
type AHandle = CTerm & {t: "handle"} & {__p?: HdlP};
type AScope = CTerm & {t: "scope"} & {__p?: ScopeP};
type ADcall = CTerm & {t: "dcall"} & {__p?: DcallP};
type ACall = CTerm & {t: "call"} & {__p?: CallP};

// Annotation accessors: the emitters' only read path onto plan facts. Each
// guards the node kind it serves, so a wrong-kind accessor call fails to
// compile; undefined = the node has no plan annotation of that shape.
export const letkP = (t: CTerm & {t: "letk"}): LetkP | undefined => (t as ALetk).__p;
export const hdlP = (t: CTerm & {t: "handle"}): HdlP | undefined => (t as AHandle).__p;
export const scopeP = (t: CTerm & {t: "scope"}): ScopeP | undefined => (t as AScope).__p;
export const dcallP = (t: CTerm & {t: "dcall"}): DcallP | undefined => (t as ADcall).__p;
export const callP = (t: CTerm & {t: "call"}): CallP | undefined => (t as ACall).__p;

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

export function analyzeEscapes(term: CTerm): Set<string> {
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
  dv: Devirt,
  cfnParams: Map<number, TLevel>,
  // PR3 slot classification recording: candidate widths at binding sites
  // (poisoned by width-unstable or cross-fn assigns), cross-fn reads per
  // level, and the current wasm-fn region id. classifySlots finalizes the
  // TLevel.typed/elided flags after the fixpoint completes.
  cand: Map<TLevel, Map<string, string>>,
  xread: Map<TLevel, Set<string>>,
  fnCtx: number,
};

// A binding's candidate width from its RHS prim: op/as prims carry the
// result stamp (norm decides the stored plane), boolean-result comparisons
// never qualify, and `+` (the f64-dispatch prim, whose fast path can
// produce a $STR string) only when every arg is numerically stamped —
// then the string arm is statically impossible.
function rhsWidth(p: CPrim): string | undefined {
  if (p.t === "op") {
    if (p.op === OP_LT || p.op === OP_GT || p.op === OP_LE || p.op === OP_GE || p.op === OP_EQ || p.op === OP_NE) return undefined;
    if (!p.args.every(a => a.stamp !== undefined)) return undefined;
    return p.norm ?? p.stamp;
  }
  if (p.t === "as") return p.stamp;
  return undefined;
}

const noteCand = (cx: Cx, l: TLevel, name: string, w: string | undefined): void => {
  if (w === undefined) return;
  let m = cx.cand.get(l);
  if (m === undefined) cx.cand.set(l, m = new Map<string, string>());
  m.set(name, w);
};

// An assign re-binds an existing slot: a different width, an unstamped
// value, or a cross-fn write (a thunk writing a site variable through the
// chain) all poison the candidate. Resolution mirrors resolveT's order —
// fn-level locals first (never slots), then the slot walk.
const noteAssign = (cx: Cx, ts: TScope, name: string, w: string | undefined): void => {
  for (let d = 0; d < ts.length; d++) {
    if (!ts[d].slots.has(name)) continue;
    const m = cx.cand.get(ts[d]);
    if (m !== undefined && m.has(name) &&
      (ts[d].fnCtx !== cx.fnCtx || w === undefined || w !== m.get(name))) m.delete(name);
    return;
  }
};

// Record a slot read: fn-level locals resolve same-fn by construction; a
// slot resolved in a different wasm-fn region than its level's ctx goes to
// the level's cross-read set (reads after a suspension are always
// cross-fn — the ANF discipline freezes operands, so no special case).
const noteRead = (cx: Cx, ts: TScope, name: string): void => {
  for (let d = 0; d < ts.length; d++) {
    if (ts[d].locals?.has(name) === true) return;
    if (!ts[d].slots.has(name)) continue;
    if (process.env["EF_DBG_NR"] === "1") console.error(`noteRead ${name} lvlCtx=${ts[d].fnCtx} cur=${cx.fnCtx}`);
    if (ts[d].fnCtx !== cx.fnCtx) {
      let s = cx.xread.get(ts[d]);
      if (s === undefined) cx.xread.set(ts[d], s = new Set());
      s.add(name);
    }
    return;
  }
};

const readAtom = (cx: Cx, ts: TScope, a: CAtom | undefined): void => {
  if (a !== undefined && a.t === "var") noteRead(cx, ts, a.name);
};

function planUnit(cx: Cx, term: CTerm, base: TScope, esc: Set<string>): void {
  const walk = (t: CTerm, ts: TScope, esc: Set<string>): void => {
    switch (t.t) {
      case "letk": {
        const al = t as ALetk;
        if (esc.has(t.name)) {
          const fl = lvl();
          fl.fnCtx = cx.fnCtx;
          const fnSlot = addSlot(fl, t.name);
          const freezeSlots = new Map<string, number>();
          if (t.freeze !== undefined)
            for (const fr of t.freeze) {
              freezeSlots.set(fr.name, addSlot(fl, fr.name));
              readAtom(cx, ts, fr.val);
            }
          const entry = lvl();
          const siteCtx = cx.fnCtx;
          entry.fnCtx = ++cx.fnCtx;
          addSlot(entry, t.param);
          const bodyEsc = analyzeEscapes(t.body);
          al.__p = {
            mat: true, fnSlot, fnLvl: fl, freezeSlots,
            entryScope: [entry, fl, ...ts], restScope: [fl, ...ts],
            isLoop: jumpsTo(t.body, t.name), bodyEsc, param: t.param,
          };
          planUnit(cx, t.body, [entry, fl, ...ts], bodyEsc);
          cx.fnCtx = siteCtx;
          // The rest runs inside F_n: its bindings (e.g. a handle's $hret
          // slot) extend F_n — fnLvl.size is read at emit time, after
          // planning finalizes the level.
          walk(t.rest, [fl, ...ts], esc);
        } else {
          al.__p = {mat: false, paramSlot: addSlot(ts[0], t.param), isLoop: jumpsTo(t.body, t.name)};
          noteCand(cx, ts[0], t.param, t.norm); // loop-carried params: same-fn label delivery
          walk(t.body, ts, esc);
          walk(t.rest, ts, esc);
        }
        break;
      }
      case "let": case "bind": case "mkfn":
        addSlot(ts[0], t.name);
        if (t.t === "let") {
          noteCand(cx, ts[0], t.name, rhsWidth(t.rhs));
          if (t.rhs.t === "op" || t.rhs.t === "arr") for (const a of t.rhs.args) readAtom(cx, ts, a);
          else if (t.rhs.t === "as") readAtom(cx, ts, t.rhs.arg);
          else readAtom(cx, ts, t.rhs.obj);
        } else if (t.t === "bind") {
          noteCand(cx, ts[0], t.name, t.val.stamp);
          readAtom(cx, ts, t.val);
        }
        if (t.t === "mkfn" && !cx.cfnBase.has(t.fun)) cx.cfnBase.set(t.fun, [...ts]);
        walk(t.rest, ts, esc);
        break;
      case "dlet":
        for (const fld of t.fields) addSlot(ts[0], fld);
        readAtom(cx, ts, t.val);
        walk(t.rest, ts, esc);
        break;
      case "assign":
        noteAssign(cx, ts, t.name, t.val.stamp);
        readAtom(cx, ts, t.val);
        walk(t.rest, ts, esc);
        break;
      case "scope": {
        const as = t as AScope;
        as.__p = lvl();
        as.__p.fnCtx = cx.fnCtx;
        as.__p.elideOk = true;
        walk(t.rest, [as.__p, ...ts], esc);
        break;
      }
      case "call": {
        // Devirt analysis: a known direct CFn callee — the emitter issues a
        // static T_DABI call and dispatches through the site's k operand;
        // argFun feeds the tight map/each/flatmap loop specialization.
        readAtom(cx, ts, t.fn);
        for (const a of t.args) readAtom(cx, ts, a);
        readAtom(cx, ts, t.k);
        const dv = cx.dv.sites.get(t);
        if (dv !== undefined) {
          (t as ACall).__p = {
            ...(dv.devirt !== undefined
              ? {devirt: dv.noEnv === true ? {fun: dv.devirt, noEnv: true} : {fun: dv.devirt}}
              : {}),
            ...(dv.argFun.size > 0 ? {argFun: dv.argFun} : {}),
          };
        }
        break;
      }
      case "perform":
        for (const a of t.args) readAtom(cx, ts, a);
        readAtom(cx, ts, t.k);
        break;
      case "dcall": {
        const ad = t as ADcall;
        readAtom(cx, ts, t.fn);
        for (const a of t.args) readAtom(cx, ts, a);
        const dvi = cx.dv.sites.get(t);
        if (dvi?.inlineRest === true) {
          // Inline rest (devirt pass): the result and the rest's binds land
          // in the site's frame — no phantom cell frames, no rest cell. The
          // site's own esc keeps letk materialization consistent with the
          // emitter's inline walk of the rest.
          addSlot(ts[0], t.name);
          noteCand(cx, ts[0], t.name, t.norm);
          ad.__p = {
            inlineRest: true, devirt: dvi.noEnv === true ? {fun: dvi.devirt!, noEnv: true} : {fun: dvi.devirt!},
            argFun: dvi.argFun,
          };
          walk(t.rest, ts, esc);
          break;
        }
        // The rest runs in the cell's activation frame: entry holds the
        // result slot, fl is the cell's frame (F_n) — the CPS-entry thunk
        // allocates the activation over the captured F_n; the direct-entry
        // path dispatches its result through the same cell.
        const fl = lvl();
        fl.fnCtx = cx.fnCtx;
        const entry = lvl();
        entry.fnCtx = ++cx.fnCtx;
        addSlot(entry, t.name);
        const restEsc = analyzeEscapes(t.rest);
        ad.__p = {
          entryScope: [entry, fl, ...ts], bodyEsc: restEsc, fnLvl: fl,
          ...(dvi?.devirt !== undefined
            ? {devirt: dvi.noEnv === true ? {fun: dvi.devirt, noEnv: true} : {fun: dvi.devirt}}
            : {}),
          ...(dvi !== undefined && dvi.argFun.size > 0 ? {argFun: dvi.argFun} : {}),
        };
        planUnit(cx, t.rest, [entry, fl, ...ts], restEsc);
        cx.fnCtx = fl.fnCtx;
        break;
      }
      case "handle": {
        const ah = t as AHandle;
        const retSlot = addSlot(ts[0], t.ret);
        const npMax = Math.max(0, ...t.cases.map(c => c.params.length));
        const topBinds = Math.max(0, ...t.cases.map(c => countTopBinds(c.body)));
        // hframe layout: [params npMax][op resume binder][Return value]
        // [topBinds][ret binder] — the Return case's identity resume gets
        // the trailing slot: a Return completion through the boundary
        // overwrites the binder it stores, and a twice-resuming case body
        // (l := k(true); r := k(false)) still needs the op binder at npMax.
        const hframeSize = npMax + 3 + topBinds;
        const hp: HdlP = {hdlIdx: cx.hdlOrder.length, hframeSize, retSlot, caseP: []};
        ah.__p = hp;
        cx.hdlOrder.push(ah);
        const siteCtx = cx.fnCtx;
        for (const c of t.cases) {
          if (c.op === "Return") continue;
          const hl = lvl();
          hl.fnCtx = ++cx.fnCtx;
          for (let i = 0; i < npMax; i++) addSlot(hl, i < c.params.length ? c.params[i] : `$p${i}`);
          addSlot(hl, c.resume);
          const cesc = analyzeEscapes(c.body);
          hp.caseP.push({base: [hl, ...ts], esc: cesc, fnIdx: cx.caseCount++});
          planUnit(cx, c.body, [hl, ...ts], cesc);
          cx.fnCtx = siteCtx;
        }
        const retCase = t.cases.find(c => c.op === "Return");
        if (retCase !== undefined) {
          const hl = lvl();
          hl.fnCtx = ++cx.fnCtx;
          for (let i = 0; i < npMax; i++) addSlot(hl, `$p${i}`);
          // Hole keeps the Return value at npMax+1 (the K_BND store site);
          // the ret binder itself goes LAST — a Return completion through
          // the boundary must not overwrite the op resume binder at npMax,
          // which a twice-resuming case body still needs.
          addSlot(hl, `$retbinder`);
          addSlot(hl, retCase.params[0]);
          const resc = analyzeEscapes(retCase.body);
          hp.retP = {base: [hl, ...ts], esc: resc, fnIdx: cx.caseCount++};
          hp.retResumeIdx = cx.retResCount++;
          planUnit(cx, retCase.body, [hl, ...ts], resc);
          addSlot(hl, retCase.resume);
          cx.fnCtx = hl.fnCtx;
        } else if (npMax > 0) {
          hp.idRetIdx = cx.idRetCount++;
        }
        walk(t.body, ts, esc);
        break;
      }
      case "if":
        readAtom(cx, ts, t.c);
        walk(t.a, ts, esc);
        walk(t.b, ts, esc);
        break;
      case "call":
        readAtom(cx, ts, t.fn);
        for (const a of t.args) readAtom(cx, ts, a);
        readAtom(cx, ts, t.k);
        break;
      case "perform":
        for (const a of t.args) readAtom(cx, ts, a);
        readAtom(cx, ts, t.k);
        break;
      case "jump":
        readAtom(cx, ts, t.k);
        readAtom(cx, ts, t.arg);
        break;
      case "dret":
        readAtom(cx, ts, t.v);
        break;
      case "halt":
        readAtom(cx, ts, t.v);
        break;
      default:
        break;
    }
  };
  walk(term, base, esc);
}

// The published plan over the wasm seam: final once planIr returns.
// Consumers (wasm_term/wasm_body/wasm_module/wasm_pipeline) read it —
// planning and classification mutate the underlying levels/annotations only
// inside this module.
export type Plan = {
  readonly cfnBase: Map<number, TScope>,
  // per-CFn direct classification (mkfn emission stamps the $CLO flag; the
  // emitCfns split picks the entry ABI)
  readonly cfnDirect: boolean[],
  // per-CFn purity (wasm_devirt.ts fixpoint): no call/perform/handle and
  // only-pure dcall targets — gates the tight map loops and inline rests
  readonly cfnPure: boolean[],
  // per-CFn numeric entry (wasm_devirt.ts eligibility): null = boxed entry
  // only. Emission of the second entry and the site dispatches read it.
  readonly numEntry: (NumEntry | null)[],
  // per-CFn planned param level (the numeric entry's activation frame
  // allocates its size; the emit-side entryLevel carries the same slots)
  readonly cfnParams: Map<number, TLevel>,
  readonly hdlOrder: (CTerm & {t: "handle"})[],
  readonly caseCount: number,
  readonly idRetCount: number,
  readonly retResCount: number,
  readonly globalLvl: TLevel, // the main term's base level (slot map shared with the plan)
  readonly mainFrameSize: number, // globalLvl's final size — run()'s frame allocation
};

export function planIr(ir: CIr, deepRes?: (t: Type) => Type): Plan {
  // Devirt analysis first: its site facts shape this walk (an inline-rest
  // dcall plans its rest into the site's frame instead of phantom cell
  // frames) and ride along onto the __p annotations. The numeric-entry
  // eligibility reads the same site map plus the checker's deep resolver —
  // computed up front so the fixpoint can skip typed-slot candidates for
  // params that ride raw locals in a numeric entry.
  const dv = analyzeDevirt(ir);
  const escs = ir.funcs.map(fn => analyzeEscapes(fn.body));
  const numEntry = deepRes === undefined ? ir.funcs.map(() => null) : numericEntries(ir, dv.sites, deepRes, escs);
  const cx: Cx = {cfnBase: new Map(), hdlOrder: [], caseCount: 0, idRetCount: 0, retResCount: 0, dv, cfnParams: new Map(), cand: new Map(), xread: new Map(), fnCtx: 0};
  const globalLvl = lvl();
  globalLvl.fnCtx = 0;
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
      paramsL.fnCtx = ++cx.fnCtx;
      for (let k = 0; k < fn.params.length; k++) {
        addSlot(paramsL, fn.params[k]);
      }
      cx.cfnParams.set(i, paramsL);
      planUnit(cx, fn.body, [paramsL, ...base], escs[i]);
    }
    if (!progressed)
      throw new WasmError(`internal: lambda ${[...pending][0]} has no mkfn site`);
  }
  // Planning is complete: every read/write is recorded, so finalize the
  // typed-slot and elision flags on the shared level objects.
  classifySlots(cx.cand, cx.xread);
  return {
    cfnBase: cx.cfnBase, cfnDirect: ir.funcs.map(fn => fn.direct === true), cfnPure: dv.cfnPure,
    numEntry,
    cfnParams: cx.cfnParams, hdlOrder: cx.hdlOrder,
    caseCount: cx.caseCount, idRetCount: cx.idRetCount, retResCount: cx.retResCount,
    globalLvl,
    mainFrameSize: globalLvl.size,
  };
}

// PR3 slot classification: finalizes TLevel.typed/elided flags after
// planning completes. A slot is typed when it has a concrete numeric
// candidate (noteCand), every assign re-stamps it at the same width and
// from the same wasm-fn region (noteAssign poisons otherwise), and it is
// never read cross-fn (noteRead). A typed slot's value lives only in a
// same-fn wasm local — locals die on unwind, frames survive — so any
// cross-fn reach (captures, post-suspension reads, cross-fn writes)
// disqualifies. A scope-node level whose every slot is typed elides its
// frame allocation: the frame cells would stay null and the chain hop
// drops together with the skipped extendFrame (frameHops skips elided
// levels; the runtime parent chain matches because a skipped extend never
// rebinds local 0). Chain anchors — cfn param levels, letk entry/F_n
// frames, the main frame — carry no elideOk mark and always materialize.
export function classifySlots(
  cand: Map<TLevel, Map<string, string>>,
  xread: Map<TLevel, Set<string>>,
): void {
  for (const [l, cs] of cand) {
    if (cs.size === 0) continue;
    const xr = xread.get(l);
    const typed = new Map<string, string>();
    for (const [name, w] of cs) {
      if (xr !== undefined && xr.has(name)) continue;
      typed.set(name, w);
    }
    if (typed.size === 0) continue;
    l.typed = typed;
    if (l.elideOk === true && typed.size === l.size) l.elided = true;
  }
}
