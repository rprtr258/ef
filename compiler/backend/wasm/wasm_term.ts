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
//   denotes the ambient continuation), walks the hctx boundary stack for a
//   handler (O(1) for the innermost; forwarding follows outer pointers),
//   records the live k cell + the reversed chain of forwarded boundaries
//   in the resume record and tail-calls the case body over an hframe copy;
//   with no handler the host fallback runs and the value dispatches
//   through the k cell.
// - `handle` pushes a $HDLCTX boundary {case table, hframe, outer, kret}
//   onto the hctx global (handler boundaries never sit in K-cell chains)
//   and binds the ret binder to the K_BND sentinel (frame slot + local);
//   case bodies emit as T_KABI functions over the hframe with the exit
//   binder bound to their k param. The Return case's resume binder
//   (identity returning the done value) is materialized by the ret case
//   fn's prologue.
//
// The frame model mirrors the interpreter's Env chain exactly (that is the
// contract capts/freeze assume): scope nodes, materialized-letk definition
// frames and their per-entry activation frames, and CFn param frames all
// extend; non-materialized letks bind their param in the current frame;
// bind/let/mkfn/dlet store into the current frame; a handle's ret-binder
// slot lives in the current frame. Frame sizes and slot indices come from
// wasm_plan.ts (planIr — a traversal mirroring this walk exactly); its
// per-node annotations are read through the plan module's accessors, its
// levels and Plan read-only.

import binaryen from "binaryen";
import * as w from "./wasm_consts.ts";
import {WasmError, _T, type ValueRef} from "./wasm_types.ts";
import {BUILTINS} from "../../frontend/analysis.ts";
import {OP_ADD, OP_DIV, OP_EQ, OP_GE, OP_GT, OP_LE, OP_LT, OP_MUL, OP_NE, OP_NEG, OP_NOT, OP_REM, OP_SUB} from "../../ops.ts";
import {mapLikeFrameWords, numSig} from "./wasm_tables.ts";
import {type CIr, type CTerm, type CAtom, type CPrim, type CFn} from "../../frontend/cps_ir.ts";
import {Buf, Fn, anyref, constF64, emitStrCat, f32, f64, i32, i64, newFn, pushRef, retCell, slot, storeSlot, typed, unboxSlice, walkLoop} from "./wasm_body.ts";
import {type Indices, type IndexRegistrar, register} from "./wasm_pipeline.ts";
import {type Emit, emitDispatch, emitCaseScan, selectBool, emitFail, i31of, makeRestThunk, hdlGet, CMP_OPS, emitCallClosure, emitDirectEntryCall, emitNumericEntryCall, rebox, boxShapeOf, planeLocal, reboxCallResult, tracePoint} from "./wasm_emit.ts";
import {type Plan, type TLevel, type TScope, type LetkP, type DcallP, type CallP, letkP, hdlP, scopeP, dcallP, callP, entryLevel, thunkBase, analyzeEscapes} from "./wasm_plan.ts";

// ---------------------------------------------------------------------------
// Static scope: frame-slot resolution mirroring the interpreter's Env chain.
// Levels are planned in wasm_plan.ts (TLevel/TScope live there); the
// emitter's walk consumes them read-only and constructs the same chains
// (identical traversal). levels[0] is the innermost (current) frame.
function addLocal(l: TLevel, name: string, local: number): void {
  if (l.locals === null) l.locals = new Map();
  l.locals.set(name, local);
}

function resolveT(ts: TScope, name: string): {d: number, i: number, local: number | null, raw?: string} | null {
  // Same-fn local bindings ($ret, a handle's HDL cell, a case's exit) are
  // function-level: they resolve at any frame depth (scope nodes push the
  // binding level deeper, but the local stays valid). Thunk scopes demote
  // all locals, so nothing leaks across functions.
  for (const l of ts) {
    const raw = l.raw?.get(name);
    if (raw !== undefined) return {d: -1, i: -1, local: l.locals!.get(name)!, raw};
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
  // A numeric entry's raw return width: dret unboxes its value to that
  // width before returning (the entry's signature result is a raw
  // valtype, not an anyref box).
  rawRet?: string,
  // Thunks created inside a direct fn: their thunks' cells chain to a
  // terminal return-cell instead of the raw null kL (a null next would
  // fire emitDispatch's null-k inside void arms — see emitDcallThunk).
  kTerminal?: boolean,
  // PR3: typed slot locals per level — per WALK (per wasm fn): the same
  // planned scopes are emitted by multiple fns (a CFn's boxed and numeric
  // entries), and a map on the shared level would hand the second fn the
  // first fn's local indices. Keyed by the level's slots Map (thunkBase
  // copies share it with the planned level).
  tloc: Map<Map<string, number>, Map<string, number>>,
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
  if (a.t === "var") {
    // A numeric entry's param local holds the raw width value: box it for
    // the anyref plane. Param reference nodes are not always stamped (a
    // plain sym read carries no numKind), so the raw check runs on every
    // var read.
    const r = resolveT(wk.ts, a.name);
    if (r !== null && r.raw !== undefined) {
      f.body.localGet(r.local!);
      rebox(wk.em, f, r.raw);
      return;
    }
    if (a.stamp !== undefined) pushStampedVar(wk, a);
    else pushRef(f, atomRef(wk, a));
  } else pushRef(f, atomRef(wk, a));
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
      const v = anyref(f);
      b.globalGet(g, binaryen.anyref);
      b.localSet(v);
      return {k: "local", l: v};
    }
    if (typeof a.v === "string") {
      const g = wk.em.lay.strStatics.get(a.v);
      if (g === undefined) throw new WasmError(`internal: no static for string literal`);
      const v = anyref(f);
      b.globalGet(g, binaryen.anyref);
      b.localSet(v);
      return {k: "local", l: v};
    }
    if (a.v === true || a.v === false) return {k: "bool", v: a.v ? 1 : 0};
    return wk.em.lay.unitRef; // unit
  }
  const r = resolveT(wk.ts, a.name);
  if (r !== null) {
    if (r.raw !== undefined) return {k: "raw", l: r.local!, w: r.raw};
    {
      // Typed slot: the value is unboxed. A stamped read (the atom's
      // numKind always equals the slot's width) takes it raw; adaptive
      // reads rebox into an anyref first.
      for (const l of wk.ts) {
        const tw = l.typed?.get(a.name);
        if (tw === undefined) continue;
        const tl = typedLocal(wk, l, a.name, tw);
        if (a.stamp === tw) return {k: "raw", l: tl, w: tw};
        const v = anyref(f);
        b.localGet(tl);
        rebox(wk.em, f, tw);
        b.localSet(v);
        return {k: "local", l: v};
      }
    }
    if (r.local !== null) return {k: "local", l: r.local};
    if (r.d === 0) return {k: "slot", i: r.i};
    const v = anyref(f);
    b.localGet(0);
    for (let k = 0; k < frameHops(wk.ts, r.d); k++) b.structGet(4, 0); // walk parent frames
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
  const r = atomRef(wk, a);
  if (r.k === "raw") {
    // Typed slot (numeric-entry params resolve raw in pushAtom before this
    // point): the local holds the unboxed width value — box it at the
    // stamp's shape for the anyref plane.
    b.localGet(r.l);
    rebox(wk.em, f, r.w);
    return;
  }
  pushRef(f, r);
  const wkn = a.stamp!;
  if (a.adaptFrom !== undefined) {
    // The stored box rides the binding's own width (adaptFrom), this read
    // flexed to another: adaptively unbox to the f64 plane, then convert
    // to the read's width and rebox (the checker only marks widths whose
    // values are representable — exact within the i64 2^53 promise).
    b.callFn(wk.em.ix.fNum64);
    adaptRaw(f, wkn);
    rebox(wk.em, f, wkn);
    return;
  }
  if (wkn === "f64") return; // the f64 plane's $F64 boxes pass through
  b.callFn(widthHelper(wk.em, wkn));
  rebox(wk.em, f, wkn);
}

// Convert the raw f64 on the stack to the raw value at `wkn`'s plane
// (truncating toward zero for int targets, like the interpreter's toBig).
function adaptRaw(f: Fn, wkn: string): void {
  const b = f.body;
  if (wkn === "f64") return;
  if (wkn === "f32") b.num(w.F32_DEMOTE);
  else if (wkn === "i32") b.num(w.TRUNC_F64);
  else if (wkn === "u32") b.num(w.TRUNC_F64_U);
  else if (wkn === "i64") b.num(w.I64_TRUNC_F64);
  else if (wkn === "u8") {
    b.num(w.TRUNC_F64_U);
    b.i32Const(255);
    b.num(w.AND);
  } else {
    b.num(w.TRUNC_F64_U);
    b.num(w.I64_EXTEND_I32_U);
  }
}

function widthHelper(em: Emit, wkn: string): number {
  return wkn === "f32" ? em.ix.fF32of
    : wkn === "i32" ? em.ix.fI32of
    : wkn === "u8" || wkn === "u32" ? em.ix.fU32of
    : wkn === "i64" ? em.ix.fI64of
    : em.ix.fU64of;
}

// Store a value into (depth, slot) of the frame chain. A typed slot (name
// via the level's reverse map) unboxes into its same-fn local instead;
// `raw` marks the stack value as already unboxed at the slot's width (a
// numeric-entry result or a raw-atom read).
function storeAt(wk: Walk, d: number, i: number, v: number, raw = false): void {
  const b = wk.f.body;
  const l = wk.ts[d];
  const name = l.rev?.[i];
  const tw = name !== undefined ? l.typed?.get(name) : undefined;
  if (tw !== undefined) {
    const tl = typedLocal(wk, l, name!, tw);
    b.localGet(v);
    if (!raw) b.readBoxPayload(boxShapeOf(tw));
    b.localSet(tl);
    return;
  }
  b.localGet(0);
  for (let k = 0; k < frameHops(wk.ts, d); k++) b.structGet(4, 0);
  b.structGet(4, 1);
  b.i32Const(i);
  b.localGet(v);
  b.arraySet();
}

// The single static-depth → parent-hop translation (storeAt, atomRef and
// resolveK all route through it). Elided scope levels allocate no frame
// and never rebind local 0, so each skipped extend drops one hop together
// with the allocation: hops = the frame-allocating levels in ts[0..d]
// minus one (the innermost allocating level's frame IS local 0).
function frameHops(ts: TScope, d: number): number {
  let hops = -1;
  for (let k = 0; k <= d; k++) if (ts[k].elided !== true) hops++;
  return hops;
}

// The same-fn local holding a typed slot's unboxed value, allocated on
// first use in the fn that binds the slot (classification excludes every
// other fn's reads and writes, so one fn ever allocates). Keyed by the
// level's slots map — thunkBase copies share it with the planned levels,
// so a body walk and the rest walk (planned restScope originals) hit the
// same entry. Rides the WALK's map, never `locals` (resolveT's any-depth
// locals search assumes anyref locals).
function typedLocal(wk: Walk, l: TLevel, name: string, w: string): number {
  let m = wk.tloc.get(l.slots);
  const got = m?.get(name);
  if (got !== undefined) return got;
  const tl = planeLocal(wk.f, w);
  if (m === undefined) wk.tloc.set(l.slots, m = new Map<string, number>());
  m.set(name, tl);
  return tl;
}


// Fresh child frame with `size` slots (parent = the current frame). The
// local is $FRAME-typed (struct.get on an anyref-typed expression fails
// binaryen's isStruct assertion — local 0 is $FRAME-typed for the same
// reason).
function extendFrame(wk: Walk, size: number): number {
  const f = wk.f, b = f.body;
  const fp = typed(f, _T.RF[4]);
  b.localGet(0);
  b.i32Const(size);
  b.arrayNew(1);
  b.structNew(4);
  b.localSet(fp);
  return fp;
}

// ---------------------------------------------------------------------------
// Prims: pure computations, never suspend.

function emitPrim(wk: Walk, p: CPrim, rawW?: string): number {
  const f = wk.f, b = f.body;
  switch (p.t) {
    case "op": {
      if (rawW !== undefined) {
        // Raw result path (a typed destination slot): the unboxed width
        // value parks in a plane local.
        const res = planeLocal(f, rawW);
        emitOpPrim(wk, p, rawW);
        b.localSet(res);
        return res;
      }
      const res = anyref(f);
      emitOpPrim(wk, p);
      b.localSet(res);
      return res;
    }
    case "arr": {
      const blk = anyref(f);
      b.i32Const(p.args.length);
      b.arrayNew(1);
      b.localSet(blk);
      for (let k = 0; k < p.args.length; k++) {
        // Value-explicit order: the element's ref before the destination.
        const r = anyref(f);
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
      const res = anyref(f);
      b.localSet(res);
      return res;
    }
    case "as":
      return emitAsPrim(wk, p);
    case "field": {
      const o = anyref(f);
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
  const res = anyref(f);
  b.localGet(o);
  b.refTest(12, false); // $TUP
  b.if(w.ANYREF); // both arms leave the field value (an anyref box)
  {
    const blk = anyref(f);
    b.localGet(o);
    b.refCast(12, true);
    b.structGet(12, 0);
    b.localSet(blk);
    b.localGet(blk);
    b.refCast(1, true);
    b.arrayLen();
    b.i32Const(idx);
    b.num(w.LEU);
    b.if();
    emitFail(wk.em, f, 2, wk.em.lay.strStatics.get(name) ?? null,
      constF64(f, idx),
      () => { b.localGet(blk); b.refCast(1, true); b.arrayLen(); b.num(w.CONV_I32); },
      constF64(f, 0));
    b.end();
    b.localGet(blk);
    b.refCast(1, true);
    b.i32Const(idx);
    b.arrayGet(1);
  }
  b.els();
  {
    const d = anyref(f), off = i32(f), len = i32(f);
    b.localGet(o);
    unboxSlice(f, d, off, len);
    b.localGet(len);
    b.i32Const(idx);
    b.num(w.LEU);
    b.if();
    emitFail(wk.em, f, 2, wk.em.lay.strStatics.get(name) ?? null,
      constF64(f, idx),
      () => { b.localGet(len); b.num(w.CONV_I32); },
      constF64(f, 0));
    b.end();
    b.localGet(d);
    b.refCast(1, true);
    b.localGet(off);
    b.i32Const(idx);
    b.num(w.ADD);
    b.arrayGet(1);
  }
  b.end();
  b.localSet(res);
  return res;
}

// @as conversion (keyed by the prim's target stamp and the operand atom's
// stamp): trunc (float→int, toward zero),
// boolnum (bool→0/1), else width adaptation via the adaptive helpers.
function emitAsPrim(wk: Walk, p: CPrim & {t: "as"}): number {
  const em = wk.em, f = wk.f, b = f.body;
  const targetW = p.stamp;
  const v = anyref(f);
  pushAtom(wk, p.arg);
  b.localSet(v);
  if (p.asKind === "trunc") {
    // float -> int: trunc toward zero (out-of-range traps on the wasm side
    // — a frozen divergence from the interpreter's wrap).
    b.localGet(v);
    b.readBoxPayload(0);
    if (targetW === "u32") {
      b.num(w.TRUNC_F64_U);
      const t = i32(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(8);
    } else if (targetW === "u8") {
      b.num(w.TRUNC_F64_U);
      b.i32Const(255);
      b.num(w.AND);
      const t = i32(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(8);
    } else if (targetW === "i32") {
      b.num(w.TRUNC_F64);
      const t = i32(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(7);
    } else if (targetW === "u64") {
      b.num(w.TRUNC_F64_U);
      b.num(w.I64_EXTEND_I32_U);
      const t = i64(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(10);
    } else if (targetW === "i64") {
      b.num(w.TRUNC_F64);
      b.num(w.I64_EXTEND_I32_S);
      const t = i64(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(9);
    } else if (targetW === "f32") {
      b.num(w.CONV_F32_I32);
      const t = f32(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(11);
    } else {
      b.num(w.FTRUNC);
      b.callFn(em.ix.fBox);
    }
  } else if (p.asKind === "boolnum") {
    // bool -> 0/1 boxed at the TARGET width (the interpreter's
    // normWidth(v ? 1 : 0, stamp)); fTruthy yields the i32, then rebox.
    b.localGet(v);
    b.callFn(em.ix.fTruthy);
    if (targetW === "i32") {
      const t = i32(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(7);
    } else if (targetW === "u32") {
      const t = i32(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(8);
    } else if (targetW === "u8") {
      const t = i32(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(8); // 0/1 are in byte range — no mask
    } else if (targetW === "i64") {
      b.num(w.I64_EXTEND_I32_S);
      const t = i64(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(9);
    } else if (targetW === "u64") {
      b.num(w.I64_EXTEND_I32_U);
      const t = i64(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(10);
    } else if (targetW === "f32") {
      b.num(w.CONV_F32_I32);
      const t = f32(f);
      b.localSet(t);
      b.localGet(t);
      b.structNew(11);
    } else {
      b.num(w.CONV_I32); // f64 (default/undefined target)
      b.callFn(em.ix.fBox);
    }
  } else {
    // Width adaptation: adaptive unbox to the target, rebox at its shape.
    // u8 masks after the helper: sources outside the f64-plane conversion
    // path (e.g. @as of an i64) can exceed 255, and the interpreter's
    // normWidth(& 255) wraps where the raw unbox does not.
    b.localGet(v);
    if (targetW !== undefined && targetW !== "f64") b.callFn(widthHelper(em, targetW));
    if (targetW === "u8") {
      b.i32Const(255);
      b.num(w.AND);
    }
    if (targetW === undefined || targetW === "f64") {
      b.callFn(em.ix.fNum64); // adaptive unbox: the source rides in its own box
      b.callFn(em.ix.fBox);
    } else b.structNew(boxShapeOf(targetW));
  }
  const res = anyref(f);
  b.localSet(res);
  return res;
}

// Stamped operator computation over IR atoms, operands loaded from atoms.
// Leaves the boxed result on the stack.
function emitOpPrim(wk: Walk, p: CPrim & {t: "op"}, rawW?: string): void {
  const em = wk.em, f = wk.f, b = f.body;
  const wkName = p.stamp;
  const isF32 = wkName === "f32", isI32 = wkName === "i32", isU32 = wkName === "u32";
  const isI64 = wkName === "i64", isU64 = wkName === "u64";
  const isU8 = wkName === "u8";
  // u8 arithmetic runs on the i32 plane but wraps mod 256 — wasm's i32 ops
  // only wrap mod 2^32, so every u8-producing op masks its result; div/rem
  // of masked operands stay in range and need no mask.
  const mask8 = (): void => { if (isU8) { b.i32Const(255); b.num(w.AND); } };
  const isNarrow = isI32 || isU32 || isU8, isWide = isI64 || isU64;
  const name = p.op;
  // A stamped operand at the site's width reads its box payload directly
  // (the checker's stamps-before-calls discipline guarantees the shape);
  // anything else goes through the adaptive helper — including the f64
  // plane ($num64), which unboxes the operand for raw arithmetic.
  const pushArg = (i: number): void => {
    const a = p.args[i];
    if (a.t === "var") {
      // A divergent read (the stored box rides the binding's width, this
      // site flexed to another): adaptive unbox to f64, then convert to
      // the op's raw plane.
      if (a.adaptFrom !== undefined) {
        pushRef(f, atomRef(wk, a));
        b.callFn(em.ix.fNum64);
        adaptRaw(f, wkName);
        return;
      }
      // A numeric entry's param local: same width reads straight off the
      // raw local (no box, no unbox); a different width (only reachable via
      // @as chains) boxes at the local's own width first so the adaptive
      // helper sees a proper box.
      const r = resolveT(wk.ts, a.name);
      if (r !== null && r.raw !== undefined) {
        b.localGet(r.local!);
        if (r.raw !== wkName) {
          rebox(em, f, r.raw);
          b.callFn(wkName === "f64" ? em.ix.fNum64 : widthHelper(em, wkName));
        }
        return;
      }
      // A typed slot's local (tloc keeps it out of resolveT's locals
      // search): same unbox discipline as raw params.
      for (const l of wk.ts) {
        const tw = l.typed?.get(a.name);
        if (tw === undefined) continue;
        const tl = typedLocal(wk, l, a.name, tw);
        b.localGet(tl);
        if (tw !== wkName) {
          rebox(em, f, tw);
          b.callFn(wkName === "f64" ? em.ix.fNum64 : widthHelper(em, wkName));
        }
        return;
      }
    }
    if (a.stamp === wkName) {
      // Same-width box: cast to its shape and read the raw payload (the
      // payload type follows the shape — $I64 carries i64, $F64 f64, ...).
      pushRef(f, atomRef(wk, a));
      b.readBoxPayload(boxShapeOf(wkName));
    } else {
      pushRef(f, atomRef(wk, a));
      b.callFn(wkName === "f64" ? em.ix.fNum64 : widthHelper(em, wkName));
    }
  };
  const unbox = (i: number): number => {
    const loc = planeLocal(f, wkName);
    pushArg(i);
    b.localSet(loc);
    return loc;
  };
  const boxW = (): void => { if (rawW === undefined) rebox(em, f, wkName); };
  switch (name) {
    case OP_ADD: {
      if (wkName === "f64") {
        const a = anyref(f), bv = anyref(f);
        pushAtom(wk, p.args[0]);
        b.localSet(a);
        pushAtom(wk, p.args[1]);
        b.localSet(bv);
        b.localGet(a); b.refTest(0, false);
        b.localGet(bv); b.refTest(0, false);
        b.num(w.AND);
        b.if(rawW === undefined ? w.ANYREF : 0x7c); // f64 valtype
        b.localGet(a); b.readBoxPayload(0);
        b.localGet(bv); b.readBoxPayload(0);
        b.num(w.FADD);
        if (rawW === undefined) b.callFn(em.ix.fBox);
        b.els();
        if (rawW === undefined) {
          b.localGet(a); b.refTest(2, false);
          b.localGet(bv); b.refTest(2, false);
          b.num(w.AND);
          b.if(w.ANYREF);
          emitStrCat(f, a, bv);
          b.els(); b.refNull(w.ANYREF);
          b.end();
        } else {
          // A typed numeric destination (every arg numerically stamped)
          // makes the string arm statically impossible; unreachable keeps
          // the if/else arms type-consistent with the f64 result.
          b.unreachable();
        }
        b.end();
        break;
      }
      {
        const x = unbox(0), y = unbox(1);
        b.localGet(x);
        b.localGet(y);
        b.num(isF32 ? w.F32_ADD : isWide ? w.I64_ADD : w.ADD);
        mask8();
        boxW();
      }
      break;
    }
    case OP_SUB: case OP_MUL: {
      const x = unbox(0), y = unbox(1);
      b.localGet(x);
      b.localGet(y);
      b.num(name === OP_SUB
        ? (isF32 ? w.F32_SUB : isNarrow ? w.SUB : isWide ? w.I64_SUB : w.FSUB)
        : (isF32 ? w.F32_MUL : isNarrow ? w.MUL : isWide ? w.I64_MUL : w.FMUL));
      mask8();
      boxW();
      break;
    }
    case OP_DIV: case OP_REM: {
      if (isNarrow || isWide) {
        // Integer division traps on ÷0; signed `/` also guards INT_MIN ÷ -1
        // (wasm's div_s overflows there; the interpreter fails identically
        // via ef_fail — rem by -1 is fine, REMS of INT_MIN by -1 is 0).
        const x = unbox(0), y = unbox(1);
        b.localGet(y);
        b.num(isWide ? w.I64_EQZ : w.EQZ);
        b.if(0x40);
        emitFail(em, f, 3, null, constF64(f, 0), constF64(f, 0), constF64(f, 0));
        b.end();
        if (name === OP_DIV && (isI32 || isI64)) {
          b.localGet(y);
          if (isWide) b.i64Const(-1n); else b.i32Const(-1);
          b.num(isWide ? w.I64_EQ : w.EQ);
          b.localGet(x);
          if (isWide) b.i64Const(-(2n ** 63n)); else b.i32Const(-2147483648);
          b.num(isWide ? w.I64_EQ : w.EQ);
          b.num(w.AND);
          b.if(0x40);
          emitFail(em, f, 4, null, constF64(f, 0), constF64(f, 0), constF64(f, 0));
          b.end();
        }
        b.localGet(x);
        b.localGet(y);
        b.num(name === OP_DIV
          ? (isI32 ? w.DIVS : isU32 || isU8 ? w.DIVU : isI64 ? w.I64_DIVS : w.I64_DIVU)
          : (isI32 ? w.REMS : isU32 || isU8 ? w.REMU : isI64 ? w.I64_REMS : w.I64_REMU));
        boxW();
        break;
      }
      if (name === OP_REM) {
        const x = unbox(0), y = unbox(1);
        let xs = x, ys = y;
        if (isF32) {
          // The whole computation runs in the f64 plane (like the
          // interpreter's raw f64 `%`), so the f32 operands must live in
          // f64 locals before FMUL/FSUB consume them.
          const x64 = f64(f), y64 = f64(f);
          b.localGet(x); b.num(w.F64_PROMOTE); b.localSet(x64);
          b.localGet(y); b.num(w.F64_PROMOTE); b.localSet(y64);
          xs = x64; ys = y64;
        }
        const t = f64(f);
        b.localGet(xs); b.localGet(ys); b.num(w.FDIV); b.num(w.FTRUNC); b.localSet(t);
        b.localGet(xs); b.localGet(ys); b.localGet(t); b.num(w.FMUL); b.num(w.FSUB);
        if (isF32) b.num(w.F32_DEMOTE);
      } else {
        const x = unbox(0), y = unbox(1);
        if (isF32) {
          // The interpreter computes float / in f64 and frounds the result
          // (the site's norm) — promote, divide, demote for the f32 box.
          b.localGet(x); b.num(w.F64_PROMOTE);
          b.localGet(y); b.num(w.F64_PROMOTE);
          b.num(w.FDIV); b.num(w.F32_DEMOTE);
        } else { b.localGet(x); b.localGet(y); b.num(w.FDIV); }
      }
      boxW();
      break;
    }
    case OP_NEG: {
      const x = unbox(0);
      if (isF32) {
        b.localGet(x); b.num(w.F32_NEG);
      } else if (isNarrow) {
        b.i32Const(0); b.localGet(x); b.num(w.SUB);
        mask8();
      } else if (isWide) {
        b.i64Const(0n); b.localGet(x); b.num(w.I64_SUB);
      } else {
        b.localGet(x); b.num(w.FNEG);
      }
      boxW();
      break;
    }
    case OP_LT: case OP_GT: case OP_LE: case OP_GE: {
      const x = unbox(0), y = unbox(1);
      selectBool(em, f, () => {
        b.localGet(x);
        b.localGet(y);
        b.num(CMP_OPS[name][wkName]);
      });
      break;
    }
    case OP_EQ: case OP_NE: {
      if (wkName !== "f64") {
        const x = unbox(0), y = unbox(1);
        selectBool(em, f, () => {
          b.localGet(x); b.localGet(y);
          b.num(isF32 ? w.F32_EQ : isWide ? w.I64_EQ : w.EQ);
        });
        if (name === OP_NE) {
          i31of(b);
          b.num(w.EQZ);
          selectBool(em, f);
        }
        break;
      }
      pushAtom(wk, p.args[0]);
      pushAtom(wk, p.args[1]);
      b.callFn(em.ix.fEq);
      if (name === OP_NE) {
        i31of(b);
        b.num(w.EQZ);
        selectBool(em, f);
      }
      break;
    }
    case OP_NOT: {
      pushAtom(wk, p.args[0]);
      b.callFn(em.ix.fTruthy);
      b.num(w.EQZ);
      selectBool(em, f);
      break;
    }
    default:
      throw new WasmError(`internal: no inline emitter for operator ${name}`);
  }
  // The prim's norm re-normalizes a result computed in a different plane
  // than the app node's stamp (identity otherwise). The raw path only
  // fires for identity norms (the caller gates rawW), so a norm pass
  // would consume an unboxed value — skip it.
  if (rawW === undefined && p.norm !== undefined && p.norm !== wkName) {
    const r = anyref(f);
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
  const cell = anyref(f);
  b.localGet(0);
  for (let k = 0; k < frameHops(wk.ts, r.d); k++) b.structGet(4, 0);
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
      const p = letkP(t)!;
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
          const slots = typed(f, _T.RF[1]);
          b.localGet(fpN);
          b.structGet(4, 1);
          b.localSet(slots);
          for (const fr of t.freeze) {
            const si = p.freezeSlots!.get(fr.name)!;
            const v = anyref(f);
            pushAtom(wk, fr.val);
            b.localSet(v);
            b.localGet(slots);
            b.i32Const(si);
            b.localGet(v);
            b.arraySet();
          }
        }
        const cell = anyref(f);
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
        // F_n level over the CURRENT walk scopes (copies share the planned
        // slots maps, so slot indices match the planned restScope while
        // typed visibility stays consistent with the body walk above — a
        // thunk-level bind written cell-path must be read cell-path).
        const saved = wk.ts;
        wk.ts = [p.restScope![0], ...wk.ts];
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
      const siteF = typed(f, _T.RF[4]);
      b.localGet(0);
      b.localSet(siteF);
      wk.labels.push({name: t.name, openDepth: wk.depth, isLoop: p.isLoop === true, param: t.param});
      if (p.isLoop === true) {
        b.loop(0x40);
        wk.depth++;
        b.localGet(siteF);
        b.localSet(0); // each iteration re-enters at the site frame
        emitTerm(wk, t.body);
        emitTerm(wk, t.rest);
        wk.labels.pop();
        wk.depth--;
        b.end();
        b.unreachable(); // unreachable: the body/rest dispatch away, never fall through
      } else {
        b.block(0x40);
        wk.depth++;
        emitTerm(wk, t.rest);
        wk.labels.pop();
        wk.depth--;
        b.end();
        b.localGet(siteF);
        b.localSet(0); // the br lands here: run the body at the site frame
        emitTerm(wk, t.body); // then the body dispatches away
      }
      break;
    }
    case "let": {
      const si = wk.ts[0].slots.get(t.name);
      if (si === undefined) throw new WasmError(`internal: no slot for ${t.name}`);
      const tw = wk.ts[0].typed?.get(t.name);
      if (tw !== undefined && t.rhs.t === "op" &&
        (t.rhs.norm === undefined || t.rhs.norm === t.rhs.stamp) && t.rhs.stamp === tw) {
        // Op-site unboxing: the prim's raw width value lands directly in
        // the slot's typed local (no box, no readBoxPayload round trip).
        const res = emitPrim(wk, t.rhs, tw);
        const tl = typedLocal(wk, wk.ts[0], t.name, tw);
        b.localGet(res);
        b.localSet(tl);
      } else {
        const res = emitPrim(wk, t.rhs);
        storeAt(wk, 0, si, res);
      }
      emitTerm(wk, t.rest);
      break;
    }
    case "bind": {
      const v = anyref(f);
      pushAtom(wk, t.val);
      b.localSet(v);
      storeAt(wk, 0, wk.ts[0].slots.get(t.name)!, v);
      emitTerm(wk, t.rest);
      break;
    }
    case "mkfn": {
      const baseScope = wk.em.plan.cfnBase.get(t.fun);
      if (baseScope === undefined) throw new WasmError(`internal: no base scope for fun ${t.fun}`);
      const clo = anyref(f);
      b.i32Const(wk.em.ix.cfnFns[t.fun].idx);
      b.refI31();
      b.localGet(0); // the captured frame
      b.i32Const(baseScope[0].size);
      b.refI31();
      // direct flag: the closure's entry ABI (T_DABI when the function
      // classified direct)
      b.i32Const(wk.em.plan.cfnDirect[t.fun] === true ? 1 : 0);
      b.refI31();
      // numeric entry: table index + signature tag (both 0 = boxed only)
      const num = wk.em.plan.numEntry[t.fun];
      b.i32Const(num !== null ? wk.em.ix.numFn.get(t.fun)! + 1 : 0);
      b.refI31();
      b.i32Const(num !== null ? num.sig : 0);
      b.refI31();
      b.structNew(6);
      b.localSet(clo);
      storeAt(wk, 0, wk.ts[0].slots.get(t.name)!, clo);
      emitTerm(wk, t.rest);
      break;
    }
    case "call": {
      const direct = directBuiltin(wk, t.fn);
      const cp = callP(t);
      const fc = anyref(f);
      if (direct === undefined && cp?.devirt?.noEnv !== true) {
        // Closure call: load the callee value (a user $CLO, a builtin $CLO
        // from the value-builtins pool, or a case-body resume binder). A
        // noEnv devirt target has no capts — the value is never read.
        pushAtom(wk, t.fn);
        b.localSet(fc);
      }
      const kref = resolveK(wk, t.k);
      if (kref.kind === "label") throw new WasmError("internal: call k must be materialized");
      const argEmit = (k: number, ffp: number): void => {
        const r = anyref(f);
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
        // Tight map/each/flatmap: the callback argument's provenance is a
        // pure direct CFn — a per-site specialized loop fn (callback's
        // T_DABI entry baked in; no per-element flag dispatch). Native
        // builtins always convert to call nodes (they invoke ef closures),
        // so this is the only tight-loop seam.
        const callDirect = mapTightDirect(em, t.fn, direct, callP(t));
        emitCallClosure(f, fc, t.args.length, argEmit, {tail: true, kL: kref.local, direct: callDirect});
        break;
      }
      const cp2 = callP(t);
      if (cp2?.devirt !== undefined) {
        // Provenance (wasm_devirt.ts): the callee slot's only binding is
        // direct CFn fun's mkfn — static T_DABI call; the result dispatches
        // through the site's materialized continuation (the k operand).
        const st = devirtSt(em, cp2.devirt);
        const num = em.plan.numEntry[cp2.devirt.fun];
        const numOk = num !== null && siteNumericSig(t)?.sig === num.sig;
        if (numOk) {
          emitNumericEntryCall(em, f, fc, t.args.length, (k) => pushRawAtom(wk, t.args[k]),
            {kind: "k", kL: kref.local},
            {...num, funcref: em.ix.numFn.get(cp2.devirt.fun)!, noEnv: st.noEnv});
        } else {
          emitDirectEntryCall(em, f, fc, t.args.length, argEmit, {kind: "k", kL: kref.local}, st);
        }
        b.ret(); // the dispatch's null-k yield: the site's value
        break;
      }
      // Unknown callee kind: the $CLO flag picks the entry ABI. A direct
      // entry returns its value — dispatch it through the site's continuation
      // here; a CPS entry takes the generic tail call. With all-numeric
      // stamps the direct arm's shape-tagged numeric entry takes the call
      // with raw operands (tag mismatch → boxed direct entry).
      const flag = i32(f);
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
      const exp = siteNumericSig(t);
      if (exp !== null) {
        // Shared-result selection: the numeric tag check picks raw
        // call_indirect vs the boxed direct entry, both binding the boxed
        // result into v; one dispatch delivers it through the site's
        // continuation (the null-k yield returns the site's value).
        const {numfn} = pushNumericMatch(f, fc, exp.sig);
        const v = anyref(f);
        b.if();
        rawIndirectCall(wk, fc, t.args, numfn, exp.sig);
        const rv = reboxCallResult(em, f, exp.r);
        b.localGet(rv);
        b.localSet(v);
        b.els();
        const vb = emitDirectEntryCall(em, f, fc, t.args.length, argEmit, {kind: "raw"});
        b.localGet(vb);
        b.localSet(v);
        b.end();
        emitDispatch(em, f, v, kref.local);
      } else {
        emitDirectEntryCall(em, f, fc, t.args.length, argEmit, {kind: "k", kL: kref.local});
      }
      b.ret(); // the dispatch's null-k yield: the site's value
      b.els();
      emitCallClosure(f, fc, t.args.length, argEmit, {tail: true, kL: kref.local});
      b.end();
      wk.depth--;
      b.unreachable(); // both arms diverge (tail call / the dispatch's return)
      break;
    }
    case "perform":
      emitPerformT(wk, t);
      break;
    case "handle":
      emitHandleT(wk, t);
      break;
    case "if": {
      const cond = anyref(f);
      pushAtom(wk, t.c);
      b.localSet(cond);
      b.localGet(cond);
      b.callFn(em.ix.fTruthy);
      b.if(0x40);
      wk.depth++;
      emitTerm(wk, t.a);
      b.els();
      emitTerm(wk, t.b);
      wk.depth--;
      b.end();
      b.unreachable(); // unreachable: both arms dispatch away
      break;
    }
    case "scope": {
      const p = scopeP(t)!;
      const saved = wk.ts;
      wk.ts = [p, ...wk.ts];
      if (p.elided !== true) {
        // Every slot rides a same-fn typed local: no frame to allocate, and
        // frameHops skips this level's hop together with it.
        const fp = extendFrame(wk, p.size);
        b.localGet(fp);
        b.localSet(0);
      }
      emitTerm(wk, t.rest);
      wk.ts = saved;
      break;
    }
    case "dlet": {
      const v = anyref(f);
      pushAtom(wk, t.val);
      b.localSet(v);
      emitDlet(wk, t, v);
      emitTerm(wk, t.rest);
      break;
    }
    case "assign": {
      const r = resolveT(wk.ts, t.name);
      if (r === null) throw new WasmError(`internal: assign of unbound ${t.name}`);
      const v = anyref(f);
      pushAtom(wk, t.val);
      b.localSet(v);
      if (r.raw !== undefined) {
        // A numeric entry's param: the local is the binding — unbox the
        // assigned value (the checker stamps it at the param's width) into
        // the raw local.
        b.localGet(v);
        b.readBoxPayload(boxShapeOf(r.raw));
        b.localSet(r.local!);
      } else storeAt(wk, r.d, r.i, v);
      emitTerm(wk, t.rest);
      break;
    }
    case "jump": {
      const name = t.k.t === "var" ? t.k.name : null;
      if (name === null) throw new WasmError("internal: jump k must be a var");
      const v = anyref(f);
      pushAtom(wk, t.arg);
      b.localSet(v);
      const kref = resolveK(wk, t.k);
      if (kref.kind === "label") {
        // Store into the letk's param slot (the jump site may sit inside
        // deeper scopes — resolve through the frame chain), then br.
        const r = resolveT(wk.ts, kref.param);
        if (r === null) throw new WasmError(`internal: letk param ${kref.param} unbound at jump`);
        storeAt(wk, r.d, r.i, v);
        b.br(wk.depth - kref.openDepth - 1);
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
      const v = anyref(f);
      if (t.v.t === "lit" && t.v.v === null) pushRef(f, em.lay.unitRef);
      else pushAtom(wk, t.v);
      b.localSet(v);
      b.localGet(v);
      b.ret();
      break;
    }
    case "dret": {
      // Direct-function boundary: the boxed value IS the return. In a direct
      // body the kL local is never set (null), so dispatch would immediately
      // take its null-k branch — return straight away. Everywhere else
      // (thunks over CPS regions) the ambient chain head is real. A numeric
      // entry's raw signature returns the unboxed payload.
      const v = anyref(f);
      pushAtom(wk, t.v);
      b.localSet(v);
      if (wk.rawRet !== undefined) {
        b.localGet(v);
        b.readBoxPayload(boxShapeOf(wk.rawRet));
      } else if (wk.directFn === true) {
        b.localGet(v);
      } else {
        emitDispatch(em, f, v, wk.kL);
        break;
      }
      b.ret();
      break;
    }
    case "dcall": {
      const p = dcallP(t)!;
      // Tail shape: the rest delivers the dcall's own result to the boundary
      // (dret in a direct body, halt in main) — the direct path can
      // return_call, keeping tail recursion O(1) on the wasm stack.
      const tailDret = (t.rest.t === "dret" || t.rest.t === "halt") &&
        t.rest.v.t === "var" && t.rest.v.name === t.name;
      const argEmit = (k: number, ffp: number): void => {
        const r = anyref(f);
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
      // The closure value is only needed for its env: builtin targets don't
      // use it, and a noEnv devirt target has no capts to read through it.
      const skipClo = direct !== undefined || p.devirt?.noEnv === true;
      const fcb = skipClo ? -1 : anyref(f);
      if (!skipClo) {
        pushAtom(wk, t.fn);
        b.localSet(fcb);
      }
      if (p.devirt !== undefined) {
        // Provenance (wasm_devirt.ts): the callee slot's only binding is
        // direct CFn fun's mkfn — the slot always holds that closure (envs
        // still differ per activation; the env comes from the value, unless
        // noEnv: the callee has no capts and never dereferences it).
        const st = devirtSt(em, p.devirt);
        if (tailDret) {
          // return_call requires the callee's return to be the caller's
          // return exactly — the numeric entry's raw result can't flow
          // through a T_DABI/anyref boundary, so tails stay on the boxed
          // entry (the rebox would need a frame of its own).
          emitDirectEntryCall(em, f, fcb, t.args.length, argEmit, {kind: "tail"}, st);
          break;
        }
        // The numeric entry takes the call when the callee has one and the
        // site's stamps shape-match its signature (the box round-trips
        // through emitDirectEntryCall otherwise). Its result arrives
        // already reboxed at the entry's return width (= the site's norm —
        // the match pinned them equal), so the site's own norm pass is
        // skipped for numeric calls below.
        const num = em.plan.numEntry[p.devirt.fun];
        const numOk = num !== null && siteNumericSig(t)?.sig === num.sig;
        // A typed destination slot at the entry's return width takes the
        // raw result directly (the reboxCallResult round trip is skipped).
        const rtw = wk.ts[0].typed?.get(t.name);
        const rawOk = numOk && rtw !== undefined && t.norm === rtw;
        const call = numOk
          ? emitNumericEntryCall(em, f, fcb, t.args.length, (k) => pushRawAtom(wk, t.args[k]), {kind: "raw"},
            {...num, funcref: em.ix.numFn.get(p.devirt.fun)!, noEnv: st.noEnv}, rawOk ? t.norm : undefined)
          : emitDirectEntryCall(em, f, fcb, t.args.length, argEmit, {kind: "raw"}, st);
        if (p.inlineRest === true) {
          // Suspension-free rest + pure callee: run the rest inline. The
          // result binds into the site's slot (planned there), the rest
          // walks with the ambient scope — no rest cell, no thunk.
          const r = call;
          const si = wk.ts[0].slots.get(t.name);
          if (si === undefined) throw new WasmError(`internal: no slot for ${t.name}`);
          if (t.norm !== undefined && !numOk) {
            const nrm = anyref(f);
            b.localGet(r);
            if (t.norm !== "f64") b.callFn(widthHelper(em, t.norm));
            else b.callFn(em.ix.fNum64);
            rebox(em, f, t.norm);
            b.localSet(nrm);
            storeAt(wk, 0, si, nrm);
          } else {
            storeAt(wk, 0, si, r, rawOk);
          }
          emitTerm(wk, t.rest);
          break;
        }
        // Cell path with the static call: the rest still runs in its own
        // thunk (the site may sit after a suspension, or the rest holds a
        // materialized continuation the cell must preserve).
        const r = call;
        const fpN2 = extendFrame(wk, p.fnLvl!.size);
        const thunk = makeRestThunk(em, "dcall:" + t.name);
        p.thunk = thunk;
        emitDcallThunk(wk, thunk, t, p);
        const cell = retCell(f, thunk.idx, () => cellNextE(wk, b), fpN2);
        if (t.norm !== undefined && !numOk) {
          const nrm = anyref(f);
          b.localGet(r);
          if (t.norm !== "f64") b.callFn(widthHelper(em, t.norm));
          else b.callFn(em.ix.fNum64);
          rebox(em, f, t.norm);
          b.localSet(nrm);
          emitDispatch(em, f, nrm, cell);
        } else {
          emitDispatch(em, f, r, cell);
        }
        break;
      }
      if (direct !== undefined) {
        // Tight map/each/flatmap: the callback argument's provenance is a
        // pure direct CFn — a per-site specialized loop fn (callback's
        // T_DABI entry baked in; no per-element flag dispatch). Otherwise
        // the shared trampoline: T_KABI (no dual entries), the generic
        // land-cell path — builtin closures carry flag 0.
        const callDirect = mapTightDirect(em, t.fn, direct, p);
        const fpN2 = extendFrame(wk, p.fnLvl!.size);
        const thunk = makeRestThunk(em, "dcall:" + t.name);
        p.thunk = thunk;
        emitDcallThunk(wk, thunk, t, p);
        const cell = retCell(f, thunk.idx, () => cellNextE(wk, b), fpN2);
        emitCallClosure(f, fcb, t.args.length, argEmit, {tail: true, kL: cell, direct: callDirect});
        break;
      }
      // Unknown callee value: the $CLO flag picks the entry ABI. Static
      // knowledge is only a hint, never a bypass — a pure-typed slot can
      // hold a resume binder or an any-smuggled suspending closure.
      const fc = anyref(f);
      pushAtom(wk, t.fn);
      b.localSet(fc);
      const flag = i32(f);
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
        // indirection per call). With all-numeric stamps the closure's
        // numeric entry (shape-tagged) takes the call with raw operands;
        // any other closure fails the tag check and takes the boxed entry.
        const exp = siteNumericSig(t);
        const r = anyref(f);
        if (exp !== null) {
          const {numfn} = pushNumericMatch(f, fc, exp.sig);
          b.if();
          rawIndirectCall(wk, fc, t.args, numfn, exp.sig);
          const rv = reboxCallResult(em, f, exp.r);
          b.localGet(rv);
          b.localSet(r);
          b.els();
          const rb = emitDirectEntryCall(em, f, fc, t.args.length, argEmit, {kind: "raw"});
          b.localGet(rb);
          b.localSet(r);
          b.end();
        } else {
          const rb = emitDirectEntryCall(em, f, fc, t.args.length, argEmit, {kind: "raw"});
          b.localGet(rb);
          b.localSet(r);
        }
        const fpN2 = extendFrame(wk, p.fnLvl!.size);
        const thunk = makeRestThunk(em, "dcall:" + t.name);
        p.thunk = thunk;
        emitDcallThunk(wk, thunk, t, p);
        const cell = retCell(f, thunk.idx, () => cellNextE(wk, b), fpN2);
        if (t.norm !== undefined) {
          const nrm = anyref(f);
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
      b.els();
      // CPS entry (resume binder, any-smuggled closure): the land-cell path —
      // the cell's frame is F_n (allocated here), next the ambient chain
      // (null in a direct body: the completion's dret returns the value).
      const fpN2 = extendFrame(wk, p.fnLvl!.size);
      const thunk = makeRestThunk(em, "dcall:" + t.name);
      p.thunk = thunk;
      emitDcallThunk(wk, thunk, t, p);
      const cell = retCell(f, thunk.idx, () => cellNextE(wk, b), fpN2);
      emitCallClosure(f, fc, t.args.length, argEmit, {tail: true, kL: cell});
      b.end();
      wk.depth--;
      b.unreachable(); // both arms diverge (tail call / the rest's own tail)
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
  // p comes from the caller's dcallP(t)! — the caller already unwrapped and
  // attached p.thunk, so the annotation is never read twice.
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
  const tw: Walk = {em, f: thunk, ts: thunkBase(p.entryScope!), kL: 2, esc: p.bodyEsc!, labels: [], depth: 0, exitName: wk.exitName, retName: wk.retName, kTerminal: wk.kTerminal, tloc: new Map()};
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
    const nrm = anyref(thunk);
    thunk.body.localGet(1);
    if (t.norm !== "f64") thunk.body.callFn(widthHelper(em, t.norm));
    else thunk.body.callFn(em.ix.fNum64);
    rebox(em, thunk, t.norm);
    thunk.body.localSet(nrm);
    storeSlot(thunk, si, () => thunk.body.localGet(nrm));
  } else {
    storeSlot(thunk, si, () => thunk.body.localGet(1));
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
  const tw: Walk = {em, f: thunk, ts: thunkBase(p.entryScope!), kL: 2, esc: p.bodyEsc!, labels: [], depth: 0, exitName: wk.exitName, retName: wk.retName, kTerminal: wk.kTerminal, tloc: new Map()};
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
    const nrm = anyref(thunk);
    thunk.body.localGet(1);
    if (t.norm !== "f64") thunk.body.callFn(widthHelper(em, t.norm));
    else thunk.body.callFn(em.ix.fNum64);
    rebox(em, thunk, t.norm);
    thunk.body.localSet(nrm);
    storeSlot(thunk, 0, () => thunk.body.localGet(nrm));
  } else {
    storeSlot(thunk, 0, () => thunk.body.localGet(1));
  }
  emitTerm(tw, t.body);
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
  // Trampoline frame: args + the map-like result window (0 for plain
  // builtins) — mapLikeFrameWords is the single table for these extras.
  return {idx, fsize: mapLikeFrameWords(name) + argcOf(name)};
  function argcOf(n: string): number {
    switch (n) {
      case "map": case "flatmap": return 2;
      case "each": return 2;
      default: return 0;
    }
  }
}

// Static direct-entry descriptor for a devirt-annotated callee: the CFn's
// registered funcref, base frame size from the planned mkfn-site scope.
function devirtSt(em: Emit, d: {fun: number, noEnv?: true}): {idx: number, fsize: number, noEnv?: true} {
  return d.noEnv === true
    ? {idx: em.ix.cfnFns[d.fun].idx, fsize: em.plan.cfnBase.get(d.fun)![0].size, noEnv: true}
    : {idx: em.ix.cfnFns[d.fun].idx, fsize: em.plan.cfnBase.get(d.fun)![0].size};
}

// The site's numeric signature when every arg carries a stamp and the
// result does too: null anywhere else (an unstamped operand could hold any
// numeric shape — the boxed paths adapt through the runtime helpers).
function siteNumericSig(t: CTerm & {t: "dcall"} | CTerm & {t: "call"}): {sig: number, ws: string[], r: string} | null {
  const r = t.t === "dcall" ? t.norm : t.rstamp;
  if (r === undefined) return null;
  const ws: string[] = [];
  for (const a of t.args) {
    if (a.stamp === undefined) return null;
    ws.push(a.stamp);
  }
  return {sig: numSig(ws, r), ws, r};
}

// Push atom k's value RAW at its stamp width — the numeric-entry call
// ABI. Literals const directly (i64/u64 materialize from the raw lexeme
// like the statics builder); vars read the raw param local or unbox the
// boxed source (slot/chain/static — the shape follows the stamp, which the
// site's match check pinned to the callee's param width).
function pushRawAtom(wk: Walk, a: CAtom): void {
  const f = wk.f, b = f.body;
  if (a.t === "lit") {
    const st = a.stamp ?? "f64";
    // A stamped UNIT literal boxes zero bits at the stamp's shape (unit
    // carries no payload) — its raw JS null never reaches the consts.
    if (a.v === null) {
      if (st === "i64" || st === "u64") b.i64Const(0n);
      else if (st === "f64") b.f64Const(0);
      else b.i32Const(0);
      return;
    }
    if (st === "f64") b.f64Const(a.v as number);
    else if (st === "f32") b.f32Const(a.v as number);
    // i64/u64 materialize from the raw lexeme (a JS number loses bits
    // beyond 2^53) — the converter keeps raw on every stamped 64-bit literal.
    else if (st === "i64" || st === "u64") b.i64Const(BigInt(a.raw!));
    else b.i32Const(a.v as number); // i32/u32 — low 32 bits, like the statics
    return;
  }
  const r = resolveT(wk.ts, a.name);
  if (r !== null && r.raw !== undefined) {
    b.localGet(r.local!); // the caller's match check pinned the widths equal
    return;
  }
  {
    // Typed slot: the unboxed value rides the walk's tloc local — the
    // caller's match check pinned the widths equal (a.stamp), so take it
    // raw.
    for (const l of wk.ts) {
      const tw = l.typed?.get(a.name);
      if (tw === undefined) continue;
      b.localGet(typedLocal(wk, l, a.name, tw));
      return;
    }
  }
  pushRef(f, atomRef(wk, a));
  b.readBoxPayload(boxShapeOf(a.stamp ?? "f64"));
}

// Raw-operand call of the closure's numeric entry through the funcref
// table (generic sites read the entry index off the $CLO): the frame
// operand (the closure's env — the entry extends it into its activation
// frame), the raw args, then the dynamic table index + the site's numeric
// signature immediate. Leaves the raw result on the operand stack.
function rawIndirectCall(wk: Walk, fc: number, args: CAtom[], numfn: number, expected: number): void {
  const f = wk.f, b = f.body;
  b.localGet(fc);
  b.refCast(6, true);
  b.structGet(6, 1); // (ref null $FRAME) — the entry's frame operand
  for (const a of args) pushRawAtom(wk, a);
  b.localGet(numfn);
  b.callIndirect(expected, false);
}

// Numeric-entry tag test over a closure value: numfn (table index + 1)
// non-zero and numsig equal to the site's expected signature. Leaves the
// condition on the operand stack; side-effects numfn/numsig locals.
function pushNumericMatch(f: Fn, fc: number, expected: number): {numfn: number} {
  const b = f.body;
  const numfn = i32(f), numsig = i32(f);
  b.localGet(fc); b.refCast(6, true); b.structGet(6, 4); b.i31Get(); b.localSet(numfn);
  b.localGet(fc); b.refCast(6, true); b.structGet(6, 5); b.i31Get(); b.localSet(numsig);
  b.localGet(numfn); b.num(w.EQZ); b.num(w.EQZ); // numfn != 0
  b.localGet(numsig); b.i32Const(expected); b.num(w.EQ);
  b.num(w.AND);
  return {numfn};
}

// Which of a numeric entry's params must ALSO land boxed in the activation
// frame: any cross-function unit may read them through the frame chain —
// closures created inside (capts read the env slots), materialized letk
// thunks (scope replay demotes locals), and handle case bodies (separate
// fns over the hframe). Everything else keeps the params raw-local only.
function escapedParams(fn: CFn, esc: Set<string>): Set<string> {
  const params = fn.params;
  const hit = new Set<string>();
  const boxAll = (): void => { for (const p of params) hit.add(p); };
  const scan = (t: CTerm): void => {
    switch (t.t) {
      case "mkfn":
        for (const c of t.capts) if (params.includes(c)) hit.add(c);
        scan(t.rest);
        break;
      case "handle":
        boxAll(); // case bodies are separate fns — box everything
        break;
      case "letk":
        if (esc.has(t.name)) { boxAll(); break; } // materialized thunk unit
        scan(t.body); scan(t.rest);
        break;
      case "let": case "bind": scan(t.rest); break;
      case "dcall": scan(t.rest); break;
      case "call": case "perform": case "jump": case "halt": case "dret": break;
      case "scope": case "dlet": case "assign": scan(t.rest); break;
      case "if": scan(t.a); scan(t.b); break;
    }
  };
  scan(fn.body);
  return hit;
}

// Tight map/each/flatmap override at a builtin call site: when the callback
// argument's provenance is a pure direct CFn, call a per-site specialized
// loop fn instead of the shared trampoline. Everything else keeps the
// generic path.
function mapTightDirect(em: Emit, fnAtom: CAtom, direct: {idx: number, fsize: number}, p: CallP | DcallP | undefined): {idx: number, fsize: number} {
  if (p?.argFun === undefined || fnAtom.t !== "var") return direct;
  const name = fnAtom.name;
  if (name !== "map" && name !== "each" && name !== "flatmap") return direct;
  const cbFun = p.argFun.get(0);
  if (cbFun === undefined || em.plan.cfnPure[cbFun] !== true || em.plan.cfnDirect[cbFun] !== true) return direct;
  return {idx: tightMapFn(em, name, devirtSt(em, {fun: cbFun})), fsize: direct.fsize};
}

// A per-site tight map-like loop fn: created + registered here at the call
// site (its index lands in the thunk block — creation order), body filled
// later by emitTightMaps (wasm_module.ts — emitMapLike lives above this
// module's layer). Deduped per (builtin, callback) pair.
function tightMapFn(em: Emit, name: string, cb: {idx: number, fsize: number}): number {
  const found = em.tightMaps.find(tm => tm.name === name && tm.cb.idx === cb.idx && tm.cb.fsize === cb.fsize);
  if (found !== undefined) return found.f.idx;
  const f = newFn(2, em);
  register(em.reg, `thunk${em.thunks.length}`, f, w.T_KABI);
  em.thunks.push(f);
  em.tightMaps.push({f, name, cb});
  return f.idx;
}

// Destructure a tuple/array-window value into the current frame's field
// slots (runtime shape dispatch, matching the interpreter's dlet).
function emitDlet(wk: Walk, t: CTerm & {t: "dlet"}, v: number): void {
  const f = wk.f, b = f.body;
  b.localGet(v);
  b.refTest(12, false); // $TUP
  b.if();
  {
    const blk = anyref(f);
    b.localGet(v);
    b.refCast(12, true);
    b.structGet(12, 0);
    b.localSet(blk);
    for (let i = 0; i < t.fields.length; i++) {
      b.localGet(blk);
      b.refCast(1, true);
      b.i32Const(i);
      b.arrayGet(1);
      const tmp = anyref(f);
      b.localSet(tmp);
      storeAt(wk, 0, wk.ts[0].slots.get(t.fields[i])!, tmp);
    }
  }
  b.els();
  {
    const d = anyref(f), off = i32(f), len = i32(f);
    b.localGet(v);
    unboxSlice(f, d, off, len);
    for (let i = 0; i < t.fields.length; i++) {
      b.localGet(d);
      b.refCast(1, true);
      b.localGet(off);
      b.i32Const(i);
      b.num(w.ADD);
      b.arrayGet(1);
      const tmp = anyref(f);
      b.localSet(tmp);
      storeAt(wk, 0, wk.ts[0].slots.get(t.fields[i])!, tmp);
    }
  }
  b.end();
}

// ---------------------------------------------------------------------------
// perform (IR): the k-operand cell is the continuation; handler lookup
// walks the hctx boundary stack, never the K-cell chain.

function emitPerformT(wk: Walk, t: CTerm & {t: "perform"}): void {
  const em = wk.em, f = wk.f, b = f.body;
  // Fine-grained runtime trace points (EFTRACE, via tracePoint): bisects
  // which perform phase traps — the walk/rec/case-dispatch machinery is
  // deep.
  const tr = (s: string): void => tracePoint(em, f, `f${f.fid} ${s}`);
  const blk = anyref(f), cell = anyref(f);
  b.i32Const(t.args.length);
  b.arrayNew(1);
  b.localSet(blk);
  for (let k = 0; k < t.args.length; k++) {
    const r = anyref(f);
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
  // Resume capture record: 5 slots {0: slice head, 1: table, 2: hfc,
  // 3: null (the matched boundary is not retained — see the stores below),
  // 4: skipped boundaries}. The slice head is the
  // perform site's own k cell — live and shared: the resume fn conses a
  // fresh $HDLCTX onto hctx (the paper's resumption re-arming the handler
  // on the resumer's context) and dispatches straight into the captured
  // chain — no slice copy, no splice, no off-chain rewrite. The skipped
  // chain holds REVERSED copies of the boundaries forwarded over (innermost
  // first): a resumed segment stays lexically inside them, so the resume
  // re-chains them above the fresh entry — the paper's Mforward consing.
  const rec = extendFrame(wk, 5);
  const recSlots = typed(f, _T.RF[1]);
  b.localGet(rec);
  b.structGet(4, 1);
  b.localSet(recSlots);
  b.i31Const(em.ix.resumeFn.idx); // i31Const already refI31s
  b.localGet(rec);
  b.i32Const(1);
  b.refI31();
  b.i32Const(0); // CPS entry (T_KABI): the resume fn drives the chain
  b.refI31();
  b.i32Const(0); // resume binders have no numeric entry
  b.refI31();
  b.i32Const(0);
  b.refI31();
  b.structNew(6); // the resume binder: $CLO over $resumeFn
  const rclo = anyref(f);
  b.localSet(rclo);
  b.localGet(recSlots);
  b.i32Const(0);
  b.localGet(kref.local);
  b.refCast(5, true);
  b.arraySet();
  // Handler lookup: walk the hctx boundary stack — the paper's effect
  // continuation at a fixed position. O(1) for the innermost handler;
  // forwarding follows outer pointers, one step per handler boundary —
  // never through the K-cell chain, so recursion depth is invisible here.
  // Each forwarded boundary is consed (reversed) into the skip chain for
  // the resume record.
  const cur = anyref(f), entry = anyref(f), tbl = anyref(f);
  const skip = anyref(f);
  b.globalGet(em.lay.ctxG);
  b.localSet(cur);
  b.refNull(21);
  b.localSet(skip);
  let found = 0, fnIdx = 0, fsz = 0, nparams = 0;
  walkLoop(f, 
    () => {
      b.localIsNull(cur);
    },
    () => {
      hdlGet(b, cur, 1);
      b.localSet(tbl);
      ({found, fnIdx, fsz, nparams} = emitCaseScan(f, tbl, () => b.i32Const(opid)));
      b.localGet(found);
      b.if();
      b.localGet(cur);
      b.localSet(entry);
      b.br(2); // matched handler → leave the walk
      b.end();
      // Forwarded boundary: cons a private copy (verbatim fields, outer =
      // the chain built so far) — the resume fn re-chains these above its
      // fresh entry so the sub-run's completions re-enter them.
      b.i31Const(w.K_HDL);
      hdlGet(b, cur, 1); // tab
      hdlGet(b, cur, 2); // hframe
      b.localGet(skip); // outer
      b.refCast(21, true);
      hdlGet(b, cur, 4); // kret (verbatim)
      b.structNew(21);
      b.localSet(skip);
      hdlGet(b, cur, 3); // outer — the next enclosing boundary
      b.localSet(cur);
    },
  );
  b.localGet(found);
  b.if(); // void: both arms end in tail calls (the no-handler arm drops
  // the dead null-k path's block result below)
  // FOUND ARM — everything here dereferences entry (set iff the hctx walk
  // matched; the walk may end at hctx = null without ever setting it).
  tracePoint(em, f, "perform:found", () => b.localGet(fsz)); // matched row's fsize
  // rec[1] = the matched boundary's case table; rec[2] = the per-invocation
  // hframe copy. rec[0] (the slice head) was stored before the lookup.
  b.localGet(recSlots);
  b.i32Const(1);
  hdlGet(b, entry, 1); // the matched boundary's case table
  b.arraySet();
  tr("perform:rec1");
  // Per-invocation hframe copy (case invocations of one handler nest; the
  // resume record roots this invocation's copy).
  // fsz is a runtime local from the scan — the frame size and copy length
  // read the local (a JS i32Const here would emit the local's INDEX as a
  // constant); the op arity is static (the performed op's arg count, and
  // the arg slots are a prefix of the npMax-wide param block).
  const hfc = typed(f, _T.RF[4]), slots = typed(f, _T.RF[1]);
  // The hfc's parent = the matched boundary's hframe parent: the case body's
  // slot depths resolve against the HANDLE site's frame chain (where the
  // case is defined), not the perform site's (which may be inside a letk
  // thunk with extra activation frames). On a fresh (resumed) entry the
  // hframe is the record's hfc — its parent chains back to the handle site
  // through the copy that created it.
  const ehf = typed(f, _T.RF[4]);
  hdlGet(b, entry, 2); // the boundary's hframe
  b.refCast(4, true);
  b.localSet(ehf);
  b.localGet(ehf);
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
  b.localGet(ehf);
  b.structGet(4, 1);
  b.i32Const(0);
  b.localGet(fsz);
  b.arrayCopy(1, 1);
  // The copy must not carry the parent invocation's ret binder: its $CLO
  // env is the parent hfc, so copied stale binders would chain every past
  // hfc off the live one (the ret case re-stores its binder on entry).
  b.localGet(slots);
  b.localGet(fsz);
  b.i32Const(1);
  b.num(w.SUB);
  b.refNull(6);
  b.arraySet();
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
  b.localGet(nparams); // the resume slot = the table's npMax (case fns read
                       // the binder there, whatever the matched op's arity)
  b.localGet(rclo);
  b.arraySet();
  tr("perform:caseDispatch");
  b.localGet(recSlots);
  b.i32Const(2);
  b.localGet(hfc);
  b.arraySet();
  // Slot 3 stays null: the matched boundary is reachable through hctx while
  // the invocation is live, and storing it here would chain records across
  // invocations (rec → entry.hfc → stale resume binder → previous rec),
  // retaining every past iteration's record set in tail-resumption loops.
  b.localGet(recSlots);
  b.i32Const(4);
  b.localGet(skip);
  b.arraySet();
  // The case body runs OUTSIDE the handler (the paper's case clause on the
  // stack tail below the matched pair): pop the boundary before dispatch.
  // Its completion ($xit) = the boundary's kret — the handle's own
  // continuation on the first run, the resumer's k2 on a fresh entry.
  const ckn = typed(f, _T.RF[5]);
  hdlGet(b, entry, 4);
  b.localSet(ckn);
  hdlGet(b, entry, 3); // outer
  b.globalSet(em.lay.ctxG);
  b.localGet(hfc);
  b.localGet(ckn);
  b.localGet(fnIdx);
  tracePoint(em, f, `f${f.fid} perform:dispatch`, () => {
    // val = ref.is_null(ckn) — the case completion target's nullness
    const t1 = i32(f);
    b.localGet(ckn);
    b.isNull(); // ref.is_null
    b.localSet(t1);
    b.localGet(t1);
  });
  b.callIndirect(w.T_KABI, true);
  b.els();
  tr("perform:noHandler");
  // No handler: the host interprets the op and the value flows to the
  // reified continuation (the k cell).
  const v = anyref(f);
  b.i32Const(opid);
  b.localGet(cell);
  b.callFn(em.o.impIdx.get("ef_perform")!);
  b.localSet(v);
  emitDispatch(em, f, v, kref.local);
  b.drop(); // the null-k path's block result; dead here (cell is non-null)
  b.end();
  b.unreachable(); // unreachable: both arms end in a tail call
}

// ---------------------------------------------------------------------------
// handle (IR).

function emitHandleT(wk: Walk, t: CTerm & {t: "handle"}): void {
  const em = wk.em, f = wk.f, b = f.body;
  const hp = hdlP(t)!;
  const hf = typed(f, _T.RF[4]), kn = typed(f, _T.RF[5]);
  b.localGet(0); // parent = the frame at the handle site
  b.i32Const(hp.hframeSize);
  b.arrayNew(1);
  b.structNew(4);
  b.localSet(hf);
  // kret = the handle's own continuation (the k-operand cell — always
  // materialized; the converter wrapped the after-handle rest): the Return
  // delivery target for the first run. A tail handle in a direct body
  // resolves k to the never-set knull local — the terminal cell stands in:
  // the case body's completion returns the value (a raw null would sever
  // the resume's k2 threading and lose propagating performs).
  const kref = resolveK(wk, t.k);
  if (kref.kind === "label") throw new WasmError("internal: handle k must be materialized");
  if (wk.kTerminal === true && kref.local === wk.kL) {
    cellNextE(wk, b);
    b.refCast(5, true); // $K.next is $K-typed (cellNextE pushes an anyref global)
  } else {
    b.localGet(kref.local);
    b.refCast(5, true);
  }
  b.localSet(kn);
  // The boundary entry (the paper's effect-continuation stack cell): pushed
  // onto hctx for the body's run — performs match its case table, the
  // K_BND sentinel resolves Return deliveries through it. outer = the
  // pre-entry hctx; the entry is discarded (popped at the sentinel) when
  // the body completes, and never sits in any K-cell chain.
  const entry = anyref(f);
  b.i31Const(w.K_HDL);
  b.globalGet(em.lay.hdlTableOff.get(hp.hdlIdx)!);
  b.localGet(hf);
  b.globalGet(em.lay.ctxG);
  b.refCast(21, true); // outer: (ref null $HDLCTX) — null passes (top level)
  b.localGet(kn);
  b.structNew(21);
  b.localSet(entry);
  b.localGet(entry);
  b.globalSet(em.lay.ctxG);
  // The ret binder ($hret): the K_BND sentinel — frame slot (thunks inside
  // the body reach it through the chain) + a local for inline resolves. The
  // sentinel resolves through hctx at dispatch, so a resumed sub-run's
  // completion reaches the fresh entry's kret (the resumer's k2) with no
  // per-resume retargeting.
  const bnd = anyref(f);
  b.globalGet(em.lay.bndG);
  b.localSet(bnd);
  storeAt(wk, 0, hp.retSlot, bnd);
  addLocal(wk.ts[0], t.ret, bnd);
  // Body with the boundary sentinel as the ambient continuation: every
  // value flows through the hctx boundary's Return entry. Thunks created
  // inside the body rebind the ret binder to their kNext (the done-marker
  // rule). kTerminal clears: cells installed inside must chain to the
  // sentinel (their completions reach the boundary's ret path), not to the
  // direct entry's terminal return.
  const saved = wk.kL;
  const savedRet = wk.retName;
  const savedTerm = wk.kTerminal;
  wk.kL = bnd; // a local holding the sentinel cell
  wk.kTerminal = false;
  wk.retName = t.ret;
  emitTerm(wk, t.body);
  wk.kL = saved;
  wk.retName = savedRet;
  wk.kTerminal = savedTerm;
  b.unreachable(); // unreachable: the body's dispatch tail-calls away
}

// Case fns (T_KABI over the hframe): the exit binder is the k param; op
// cases read their resume binder from the hframe (written at the perform
// site); the Return case's prologue materializes its identity resume.
function emitCaseBody(em: Emit, f: Fn, body: CTerm, base: TScope, esc: Set<string>, exitName: string, retResumeIdx: number | undefined): void {
  const wk: Walk = {em, f, ts: base, kL: 1, esc, labels: [], depth: 0, exitName, tloc: new Map()};
  tracePoint(em, f, `case f${f.fid} enter`);
  if (retResumeIdx !== undefined) {
    // resume binder (the hframe's last slot) := $CLO{retResume, env = this
    // hframe} — the funcref is the plan's per-handle ret-resume record (the
    // plan's counter indexes into the ret-resume block, not the raw table).
    // The trailing slot keeps the Return completion from clobbering the op
    // resume binder at npMax (see planHandle's hframe layout).
    const clo = anyref(f);
    const bb = f.body;
    bb.i32Const(em.ix.retResFns[retResumeIdx].idx);
    bb.refI31();
    bb.localGet(0);
    bb.i32Const(0);
    bb.refI31();
    bb.i32Const(0); // CPS entry (T_KABI)
    bb.refI31();
    bb.i32Const(0); // resume binders have no numeric entry
    bb.refI31();
    bb.i32Const(0);
    bb.refI31();
    bb.structNew(6);
    bb.localSet(clo);
    storeSlot(f, base[0].size - 1, () => bb.localGet(clo));
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
  const v = anyref(f);
  b.localGet(0);
  b.structGet(4, 1);
  b.i32Const(slot);
  b.arrayGet(1);
  b.localSet(v);
  emitDispatch(em, f, v);
}

// The ret case's identity resume: (frame, k) -> the done value (the Return
// slot of the frame the K_BND sentinel stored it in — the $CLO env),
// dispatched through k — exactly the interpreter's
// `native((_a, k2) => k2(out.value))`.
function emitRetResumeFn(em: Emit, f: Fn, slot: number): void {
  const b = f.body;
  const v = anyref(f);
  b.localGet(0); // the $CLO env (the invocation's hframe)
  b.structGet(4, 1);
  b.i32Const(slot);
  b.arrayGet(1);
  b.localSet(v);
  emitDispatch(em, f, v);
}

// The shared resume fn — its record layout and hctx re-consing are
// IR-independent; the slice head is the perform's k-operand cell.
export function emitResumeFn(em: Emit, rf: Fn): void {
  rf.em = em;
  tracePoint(em, rf, "resumeFn enter");
  {
    const b = rf.body;
    const v = anyref(rf), rec = anyref(rf), head = typed(rf, _T.RF[5]);
    const recSlot = (n: number): void => {
      b.localGet(rec);
      b.refCast(4, true);
      b.structGet(4, 1);
      b.i32Const(n);
      b.arrayGet(1);
    };
    slot(rf, 0);
    b.localSet(v); // the resumed value: the closure call frame's slot 0
    b.localGet(0);
    b.structGet(4, 0); // the capture record (env frame)
    b.localSet(rec);
    // The paper's resumption: cons a fresh $HDLCTX onto hctx — the handler
    // re-armed on top of the RESUMER's context — then dispatch the resumed
    // value into the captured chain (rec[0], the live perform-site k cell,
    // shared untouched). No slice copy, no splice, no off-chain rewrite;
    // multi-shot resume just re-conses, and every cell in the sub-run that
    // tails into the K_BND sentinel resolves through the fresh entry.
    // rec[4] = the reversed chain of boundaries the perform forwarded over
    // (record-private copies, innermost LAST). Re-cons them above the fresh
    // entry: the sub-run stays lexically inside them, so its ops match them
    // first and its completions re-enter their Return paths before reaching
    // the fresh boundary (the paper's Mforward consing).
    const fresh = anyref(rf), prev = anyref(rf), sn = anyref(rf);
    b.i31Const(w.K_HDL);
    recSlot(1); // the matched boundary's case table
    recSlot(2); // the invocation's hfc
    b.globalGet(em.lay.ctxG); // outer = the resumer's context
    b.refCast(21, true);
    b.localGet(1); // kret = the k this closure was invoked with
    b.structNew(21);
    b.localSet(fresh);
    b.localGet(fresh);
    b.localSet(prev);
    recSlot(4);
    b.localSet(sn);
    walkLoop(rf, 
      () => { b.localIsNull(sn); },
      () => {
        b.i31Const(w.K_HDL);
        hdlGet(b, sn, 1); // tab (verbatim)
        hdlGet(b, sn, 2); // hframe (verbatim)
        b.localGet(prev); // outer = the chain built so far
        b.refCast(21, true);
        hdlGet(b, sn, 4); // kret (verbatim)
        b.structNew(21);
        b.localSet(prev);
        hdlGet(b, sn, 3); // next skipped boundary (toward S1)
        b.localSet(sn);
      },
    );
    b.localGet(prev); // copyS1, or fresh when nothing was forwarded
    b.globalSet(em.lay.ctxG);
    recSlot(0);
    b.refCast(5, true);
    b.localSet(head);
    emitDispatch(em, rf, v, head);
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
export function emitCfns(em: Emit, ir: CIr): void {
  for (let i = 0; i < ir.funcs.length; i++) {
    const fn = ir.funcs[i];
    const base = em.plan.cfnBase.get(i)!;
    const paramsL = entryLevel(fn);
    const f = em.ix.cfnFns[i];
    f.em = em;
    // PR3 v1: cfn params stay boxed. The generic map/each/flatmap
    // trampolines box the callback's INDEX argument through $F64's fBox
    // regardless of the declared param width, so an entry-side unbox to
    // the declared width would ref.cast-fail — param typing needs a
    // caller-ABI guarantee first.
    if (fn.direct === true) {
      // Direct ABI: (frame) -> anyref — no continuation operand. The kL
      // local is never set (null): generic land-cell paths inside (a dcall's
      // CPS-entry branch) build cells whose next is null, so their completions
      // return instead of walking a chain. dret returns the boxed value.
      const knull = typed(f, _T.RF[5]);
      const wk: Walk = {
        em, f, ts: [paramsL, ...base], kL: knull,
        esc: analyzeEscapes(fn.body), labels: [], depth: 0, directFn: true, kTerminal: true, tloc: new Map(),
      };
      addLocal(wk.ts[0], "$ret", knull); // never referenced (dret boundary)
      emitTerm(wk, fn.body);
      em.funcs.push(f);
      continue;
    }
    const wk: Walk = {
      em, f, ts: [paramsL, ...base], kL: 1,
      esc: analyzeEscapes(fn.body), labels: [], depth: 0, tloc: new Map(),
    };
    addLocal(wk.ts[0], "$ret", 1);
    emitTerm(wk, fn.body);
    em.funcs.push(f);
  }
  // Numeric direct-ABI entries (ir.funcs order — the dnum block's layout
  // order). The frame operand is the closure's captured env; the entry
  // itself extends it into the activation frame for the body's binds.
  // Slots 0..n-1 stay dead (params ride raw locals — the walk's slot
  // numbering keeps matching the planned scopes); params a cross-function
  // unit can read through the frame chain box into their slot at entry.
  let dn = 0;
  for (let i = 0; i < ir.funcs.length; i++) {
    const num = em.plan.numEntry[i];
    if (num === null) continue;
    const fn = ir.funcs[i];
    const base = em.plan.cfnBase.get(i)!;
    const esc = analyzeEscapes(fn.body);
    const escaped = escapedParams(fn, esc);
    const f = em.ix.dnumFns[dn++];
    f.em = em;
    const paramsL = entryLevel(fn);
    paramsL.raw = new Map();
    for (let k = 0; k < fn.params.length; k++) {
      if (!escaped.has(fn.params[k])) {
        addLocal(paramsL, fn.params[k], 1 + k); // frame param is local 0
        paramsL.raw.set(fn.params[k], num.ws[k]);
      }
    }
    const knull = typed(f, _T.RF[5]);
    const wk: Walk = {
      em, f, ts: [paramsL, ...base], kL: knull,
      esc, labels: [], depth: 0, directFn: true, kTerminal: true, rawRet: num.r, tloc: new Map(),
    };
    addLocal(wk.ts[0], "$ret", knull); // never referenced (dret boundary)
    // Activation frame over the captured env: the body's binds live in its
    // slots (slot indices already include the dead param reservations).
    const fp = extendFrame(wk, em.plan.cfnParams.get(i)!.size);
    const bb = f.body;
    bb.localGet(fp);
    bb.localSet(0);
    for (let k = 0; k < fn.params.length; k++) {
      if (!escaped.has(fn.params[k])) continue;
      const pv = 1 + k;
      storeSlot(f, k, () => {
        bb.localGet(pv);
        rebox(em, f, num.ws[k]);
      });
    }
    emitTerm(wk, fn.body);
    em.funcs.push(f);
  }
}

// CFn declarations: boxed entries (T_DABI/T_KABI by the devirt's direct
// classification) + numeric direct-ABI entries, created + registered here
// context-free in ir.funcs order so every funcref and its final sig exist
// before any body resolves a (possibly forward) call target; emitCfns
// fills the bodies in the same order.
export function registerCfns(reg: IndexRegistrar, ix: Indices, ir: CIr, plan: Plan): void {
  ix.cfnFns = ir.funcs.map((fn, i) => {
    const f = newFn(fn.direct === true ? 1 : 2);
    register(reg, `cfn${i}`, f, fn.direct === true ? w.T_DABI : w.T_KABI);
    return f;
  });
  for (let i = 0; i < ir.funcs.length; i++) {
    const num = plan.numEntry[i];
    if (num === null) continue;
    const f = newFn(1 + num.ws.length);
    register(reg, `dnum${i}`, f, num.sig);
    ix.numFn.set(i, f.idx);
    ix.dnumFns.push(f);
  }
}

// Case-fn declarations (op cases + explicit Return cases, fnIdx order) and
// per-handle identity rets (idRetIdx order), created + registered here
// context-free so the case tables layoutStatics builds carry their
// funcrefs; emitCaseFns fills the bodies in the same order.
export function registerCaseFns(reg: IndexRegistrar, ix: Indices, plan: Plan): void {
  for (const hdl of plan.hdlOrder) {
    const hp = hdlP(hdl)!;
    for (const c of hdl.cases) {
      if (c.op === "Return") continue;
      const f = newFn(2);
      register(reg, `case${hp.hdlIdx}:${c.op}`, f, w.T_KABI);
      ix.caseFns.push(f);
    }
    if (hdl.cases.some(c => c.op === "Return")) {
      const f = newFn(2);
      register(reg, `retcase${hp.hdlIdx}`, f, w.T_KABI);
      ix.caseFns.push(f);
    }
  }
  for (const hdl of plan.hdlOrder) {
    const hp = hdlP(hdl)!;
    if (hp.idRetIdx === undefined) continue;
    const f = newFn(2);
    register(reg, `idret${hp.hdlIdx}`, f, w.T_KABI);
    ix.idRetFns.push(f);
  }
}

// Ret-resume declarations (one per handle with an explicit Return case,
// retResumeIdx order), created + registered here context-free; bodies are
// filled by emitRetResumes in the same order.
export function registerRetResumes(reg: IndexRegistrar, ix: Indices, plan: Plan): void {
  for (const hdl of plan.hdlOrder) {
    const hp = hdlP(hdl)!;
    if (hp.retResumeIdx === undefined) continue;
    const f = newFn(2);
    register(reg, `retres${hp.hdlIdx}`, f, w.T_KABI);
    ix.retResFns.push(f);
  }
}

// Case fns + identity rets + ret resumes, in plan order (registration order —
// registerCaseFns/registerRetResumes — is the module's function order).
export function emitCaseFns(em: Emit): void {
  // The identityRet fn (registered by the index phase) holds the shared
  // default-Return body for npMax=0 handles without an explicit Return
  // case: read the Return value emitDispatch stashed in hframe slot 1,
  // dispatch it through k.
  const idf = em.ix.identityRet;
  idf.em = em;
  emitIdRetFn(em, idf, 1);
  em.funcs.push(idf);
  // Pass 1: every case fn (op cases + explicit Return cases) — they fill
  // the contiguous case block (registration order), so they must all be
  // emitted before the identity rets (pass 2), which follow them in the fn
  // list. A per-handle interleaving here would collide funcrefs once a
  // program has two handles without explicit Return cases.
  for (const hdl of em.plan.hdlOrder) {
    const hp = hdlP(hdl)!;
    const cases = hdl.cases;
    let ci = 0;
    for (const c of cases) {
      if (c.op === "Return") continue;
      const cp = hp.caseP[ci++];
      const f = em.ix.caseFns[cp.fnIdx];
      f.em = em;
      emitCaseBody(em, f, c.body, cp.base, cp.esc, hdl.exit, undefined);
      em.funcs.push(f);
    }
    const retCase = cases.find(c => c.op === "Return");
    if (retCase !== undefined) {
      const cp = hp.retP!;
      const f = em.ix.caseFns[cp.fnIdx];
      f.em = em;
      emitCaseBody(em, f, retCase.body, cp.base, cp.esc, hdl.exit, hp.retResumeIdx);
      em.funcs.push(f);
    }
  }
  // Pass 2: per-handle identity rets (handles without an explicit Return
  // case), in plan order over the idRet block.
  for (const hdl of em.plan.hdlOrder) {
    const hp = hdlP(hdl)!;
    if (hp.idRetIdx === undefined) continue;
    const npMax = Math.max(0, ...hdl.cases.map(c => c.params.length));
    const f = em.ix.idRetFns[hp.idRetIdx];
    f.em = em;
    emitIdRetFn(em, f, npMax + 1);
    em.funcs.push(f);
  }
}

// Ret-resume fns (one per handle with an explicit Return case).
export function emitRetResumes(em: Emit): void {
  for (const hdl of em.plan.hdlOrder) {
    const hp = hdlP(hdl)!;
    if (hp.retResumeIdx === undefined) continue;
    const cases = hdl.cases;
    const npMax = Math.max(0, ...cases.map(c => c.params.length));
    const f = em.ix.retResFns[hp.retResumeIdx];
    f.em = em;
    emitRetResumeFn(em, f, npMax + 1);
    em.funcs.push(f);
  }
}

// The program term over the global frame; halt returns the program result
// (run() is the only non-tail caller in the chain). Returns the main fn for
// the caller (wasm.ts) to push last and hand to emitInits.
export function emitMain(em: Emit, ir: CIr): Fn {
  const f = newFn(2, em);
  f.em = em;
  const wk: Walk = {
    em, f, ts: [em.plan.globalLvl], kL: 1,
    esc: analyzeEscapes(ir.term), labels: [], depth: 0, tloc: new Map(),
  };
  emitTerm(wk, ir.term);
  return f;
}
