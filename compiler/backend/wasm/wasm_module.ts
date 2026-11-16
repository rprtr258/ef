// Module-level function emission of the wasm backend: builtin trampolines
// and host-import thunks, main, and the run/accessor init
// functions the host imports. The design doc for the whole
// backend lives at the top of wasm.ts.
import {BUILTINS} from "../../frontend/analysis.ts";
import {OP_ADD, OP_EQ, OP_GE, OP_GT, OP_LE, OP_LT, OP_NE, OP_NOT} from "../../ops.ts";
import {OPS} from "../../env.ts";
import {_T, WasmError} from "./wasm_types.ts";
import {Buf, Fn, allocArrBlk, anyref, boxArr, constF64, elemAddr, elemAddrOff, f64, fnLoop, i32, i64, newFn, pushRef, slot, slotF64, typed, unboxArr, unboxSlice} from "./wasm_body.ts";
import {type Indices, type IndexRegistrar, type Opt, register} from "./wasm_pipeline.ts";
import {type Emit, emitCallClosure, emitDirectEntryCall, emitDispatch, emitFail, i31of, ladderBody, makeRestThunk, rebox, selectBool, NUM64_ARMS} from "./wasm_emit.ts";
import * as w from "./wasm_consts.ts";

// Σ over the n per-element cells in backing `src` (viewed at offset `off`):
// array elements add their length, scalars add 1 (the tag test, not the
// value — JS Array.prototype.flat parity; a resumed scalar flowing back
// through a map-like land path lands exactly here). The shared size pass
// of flat and flatmap; `total` accumulates.
function collectLen(f: Fn, src: number, off: number, n: number, total: number): void {
  const b = f.body;
  fnLoop(f, () => { b.localGet(n); }, i => {
    const cell = anyref(f);
    elemAddrOff(f, src, i, off);
    b.arrayGet(1);
    b.localSet(cell);
    b.localGet(cell);
    b.refTest(3, false); // is a slice wrapper?
    b.if();
    b.localGet(cell);
    b.refCast(3, true);
    b.structGet(3, 2);
    b.localGet(total);
    b.num(w.ADD);
    b.localSet(total);
    b.els();
    b.localGet(total);
    b.i32Const(1);
    b.num(w.ADD);
    b.localSet(total);
    b.end();
  });
}

// Copy the n per-element cells from backing `src` (viewed at offset `off`)
// into the fresh backing `dst`: slice elements copy their windows at the
// running write index, scalars copy as themselves. The shared finalize of
// flat and flatmap; boxArr(dst) afterwards.
function collectCopy(f: Fn, src: number, off: number, dst: number, n: number): void {
  const b = f.body;
  const ww = i32(f);
  b.i32Const(0);
  b.localSet(ww);
  fnLoop(f, () => { b.localGet(n); }, i => {
    const cell = anyref(f), xd = anyref(f), xo = i32(f), xl = i32(f);
    elemAddrOff(f, src, i, off);
    b.arrayGet(1);
    b.localSet(cell);
    b.localGet(cell);
    b.refTest(3, false);
    b.if();
    b.localGet(cell);
    unboxSlice(f, xd, xo, xl);
    fnLoop(f, () => { b.localGet(xl); }, j => {
      elemAddr(f, dst, ww);
      elemAddrOff(f, xd, j, xo);
      b.arrayGet(1);
      b.arraySet();
      b.localGet(ww);
      b.i32Const(1);
      b.num(w.ADD);
      b.localSet(ww);
    });
    b.els();
    elemAddr(f, dst, ww);
    b.localGet(cell);
    b.arraySet();
    b.localGet(ww);
    b.i32Const(1);
    b.num(w.ADD);
    b.localSet(ww);
    b.end();
  });
}

// Builtin trampoline declarations: one (frame, k) fn per used builtin in
// BUILTINS order, created + registered here context-free so the $CLO
// statics (layoutStatics) and direct call sites resolve their funcrefs
// before emission; emitBuiltins fills the bodies in the same order.
export function registerBuiltins(reg: IndexRegistrar, ix: Indices, o: Opt): void {
  for (const {name} of BUILTINS) {
    if (!o.usedBuiltins.has(name)) continue;
    const f = newFn(2);
    ix.builtinFnIdx.set(name, register(reg, `builtin:${name}`, f, w.T_KABI));
    ix.builtinFns.push(f);
  }
}

export function emitBuiltins(em: Emit): Fn[] {
  const out: Fn[] = [];
  let bi = 0;
  for (const {name} of BUILTINS) {
    if (!em.o.usedBuiltins.has(name)) continue;
    const f = em.ix.builtinFns[bi++]; // (frame, k): builtins are T_KABI trampolines
    f.em = em;
    const b = f.body;
    const box = () => {
      b.callFn(em.ix.fBox);
    };
    // Shared get/set prologue: slot 1 read adaptively as i64 (fI64of) and
    // wrapped to i32 in idxL; slot 0's slice wrapper unboxed into (data,
    // off, len) — the view's window. set keeps the wrapper in xsL first.
    // The wrapped idx is verified to round-trip (i64 → i32 → i64) so a huge
    // index can't alias a small one; the OOB error uses the caller's code
    // (get=1 / set=6), matching the interpreter's message.
    const readIdx = (idx64L: number, idxL: number, blkL: number, offL: number, lenL: number, failCode: number, xsL?: number): void => {
      pushRef(f, {k: "slot", i: 1});
      b.callFn(em.ix.fI64of);
      b.localSet(idx64L);
      if (xsL === undefined) slot(f, 0);
      else { slot(f, 0); b.localSet(xsL); b.localGet(xsL); }
      unboxSlice(f, blkL, offL, lenL);
      b.localGet(idx64L);
      b.num(w.I32_WRAP_I64);
      b.localSet(idxL);
      b.localGet(idx64L);
      b.localGet(idxL);
      b.num(w.I64_EXTEND_I32_S);
      b.num(w.I64_NE);
      b.if();
      emitFail(em, f, failCode, null, () => {
        b.localGet(idx64L);
        b.num(w.CONV_F64_I64);
      }, () => {
        b.localGet(lenL);
        b.num(w.CONV_I32);
      }, constF64(f, 0));
      b.end();
    };
    switch (name) {
      case OP_ADD:
      case OP_LT:
      case OP_GT:
      case OP_LE:
      case OP_GE: {
        // The only operators with unstamped sites (string `+`, string
        // comparisons — every other app site is width-stamped and compiles
        // inline). The host applies the interpreter's own closure (env.ts
        // OPS): parity by construction for every width/boxing combination.
        b.i32Const(OPS.findIndex(([n]) => n === name));
        slot(f, 0);
        slot(f, 1);
        b.callFn(em.o.impIdx.get("ef_binop")!);
        break;
      }
      case OP_EQ: {
        slot(f, 0);
        slot(f, 1);
        b.callFn(em.ix.fEq);
        break;
      }
      case OP_NE: {
        slot(f, 0);
        slot(f, 1);
        b.callFn(em.ix.fEq);
        i31of(b); // eq result's i31 bool payload
        b.num(w.EQZ); // 1 when $eq said false
        selectBool(em, f);
        break;
      }
      case OP_NOT: {
        // `!` desugars to an app of the operator sym; its sites carry no
        // width stamp, so they dispatch here rather than inline.
        slot(f, 0);
        b.callFn(em.ix.fTruthy);
        b.num(w.EQZ);
        selectBool(em, f);
        break;
      }
      case "sub": {
        // Zero-copy view: struct.new over the operand's own fields. from/to
        // are i64 args (slots 1/2); the operand stays in slot 0.
        const data = anyref(f), off = i32(f), len = i32(f);
        const from64 = i64(f), to64 = i64(f), from = i32(f), to = i32(f);
        pushRef(f, {k: "slot", i: 1});
        b.callFn(em.ix.fI64of);
        b.localSet(from64);
        pushRef(f, {k: "slot", i: 2});
        b.callFn(em.ix.fI64of);
        b.localSet(to64);
        slot(f, 0);
        unboxSlice(f, data, off, len);
        b.localGet(from64);
        b.num(w.I32_WRAP_I64);
        b.localSet(from);
        b.localGet(to64);
        b.num(w.I32_WRAP_I64);
        b.localSet(to);
        // from < 0 || to < from || to > len
        b.localGet(from64);
        b.i64Const(0n);
        b.num(w.I64_LTS);
        b.localGet(to64);
        b.localGet(from64);
        b.num(w.I64_LTS);
        b.num(w.OR);
        b.localGet(to64);
        b.localGet(len);
        b.num(w.I64_EXTEND_I32_S);
        b.num(w.I64_GTU);
        b.num(w.OR);
        b.if();
        emitFail(em, f, 5, null, () => {
          b.localGet(from64);
          b.num(w.CONV_F64_I64);
        }, () => {
          b.localGet(to64);
          b.num(w.CONV_F64_I64);
        }, () => {
          b.localGet(len);
          b.num(w.CONV_I32);
        });
        b.end();
        b.localGet(data);
        b.refCast(1, false); // exact (ref null $ELEMS) for the struct.new field
        b.localGet(off);
        b.localGet(from);
        b.num(w.ADD);
        b.localGet(to);
        b.localGet(from);
        b.num(w.SUB);
        b.structNew(3);
        break;
      }
      case "concat": {
        const ad = anyref(f), ao = i32(f), al = i32(f);
        const bd = anyref(f), bo = i32(f), bl = i32(f);
        slot(f, 0);
        unboxSlice(f, ad, ao, al);
        slot(f, 1);
        unboxSlice(f, bd, bo, bl);
        const n = i32(f);
        b.localGet(al);
        b.localGet(bl);
        b.num(w.ADD);
        b.localSet(n);
        const blk = allocArrBlk(f, n);
        // array.copy both windows into the fresh dst (no overlap: dst is new).
        b.localGet(blk); b.refCast(1, true); b.i32Const(0);
        b.localGet(ad); b.refCast(1, true); b.localGet(ao); b.localGet(al);
        b.arrayCopy(1, 1);
        b.localGet(blk); b.refCast(1, true); b.localGet(al);
        b.localGet(bd); b.refCast(1, true); b.localGet(bo); b.localGet(bl);
        b.arrayCopy(1, 1);
        boxArr(f, blk);
        break;
      }
      case "flat": {
        const xd = anyref(f), xo = i32(f), n = i32(f), total = i32(f);
        slot(f, 0);
        unboxSlice(f, xd, xo, n);
        b.i32Const(0);
        b.localSet(total);
        collectLen(f, xd, xo, n, total);
        const blk = allocArrBlk(f, total);
        collectCopy(f, xd, xo, blk, n);
        boxArr(f, blk);
        break;
      }
      case "len":
      case "strlen": {
        // len: the wrapper's len field (the view's length); strlen: the
        // $STR's byte count (UTF-8).
        slot(f, 0);
        if (name === "len") { b.refCast(3, true); b.structGet(3, 2); }
        else { b.refCast(2, true); b.arrayLen(); }
        b.num(w.I64_EXTEND_I32_S); // len is i64
        b.structNew(9);
        break;
      }
      case "PI":
        b.globalGet(em.lay.piG);
        break;
      case "cos":
      case "sin":
        slot(f, 0);
        b.callFn(em.o.impIdx.get(`ef_${name}`)!);
        break;
      case "sqrt":
      case "abs": {
        const x = f64(f);
        slot(f, 0);
        b.callFn(em.ix.fNum64); // adaptive: an $F32 box promotes
        b.localSet(x);
        b.localGet(x);
        b.num(name === "sqrt" ? w.FSQRT : w.FABS);
        box();
        break;
      }
      case "round": {
        const x = slotF64(f, 0);
        b.localGet(x);
        b.f64Const(0.5);
        b.num(w.FADD);
        b.num(w.FFLOOR);
        b.num(w.I64_TRUNC_F64); // round is i64
        b.structNew(9);
        break;
      }
      case "range": {
        // range is an i64 builtin: the bounds read adaptively ($I64
        // boxes; $F64 boxes truncate), the count and the elements compute
        // in i64. Count = the interpreter's
        // max(0, ceil((e - s) / step)): with span = |e - s| and mag =
        // |step|, elements exist iff (step > 0) == (e > s) && step != 0,
        // and the count is ceil(span / mag) = (span + mag - 1) / mag over
        // non-negatives (unsigned division is exact there).
        const s = i64(f), ev = i64(f), stepv = i64(f), span = i64(f), mag = i64(f);
        const dirOK = i32(f), n = i32(f);
        const readI64 = (i: number, loc: number): void => {
          pushRef(f, {k: "slot", i});
          b.callFn(em.ix.fI64of);
          b.localSet(loc);
        };
        const abs = (loc: number): void => {
          const neg = i32(f), flip = i64(f), xored = i64(f);
          b.localGet(loc);
          b.i64Const(0n);
          b.num(w.I64_LTS);
          b.localSet(neg);
          b.localGet(neg);
          b.if(0x7e);
          b.i64Const(-1n); // neg: the XOR mask -1 (the two's-complement negate)
          b.els();
          b.i64Const(0n);
          b.end();
          b.localSet(flip);
          b.localGet(flip);
          b.localGet(loc);
          b.num(w.I64_XOR);
          b.localSet(xored);
          b.localGet(neg);
          b.if(0x7e);
          b.i64Const(1n);
          b.els();
          b.i64Const(0n);
          b.end();
          b.localGet(xored);
          b.num(w.I64_ADD);
          b.localSet(loc);
        };
        readI64(0, s);
        readI64(1, ev);
        readI64(2, stepv);
        // span = |e - s|, mag = |step|
        b.localGet(ev);
        b.localGet(s);
        b.num(w.I64_SUB);
        b.localSet(span);
        abs(span);
        b.localGet(stepv);
        b.localSet(mag);
        abs(mag);
        // dirOK = step != 0 && (step > 0) == (e > s)
        b.localGet(stepv);
        b.i64Const(0n);
        b.num(w.I64_NE);
        b.localGet(stepv);
        b.i64Const(0n);
        b.num(w.I64_GTS);
        b.localGet(ev);
        b.localGet(s);
        b.num(w.I64_GTS);
        b.num(w.EQ);
        b.num(w.AND);
        b.localSet(dirOK);
        b.localGet(dirOK);
        b.if(0x7f);
        b.localGet(span);
        b.localGet(mag);
        b.num(w.I64_ADD);
        b.i64Const(1n);
        b.num(w.I64_SUB);
        b.localGet(mag);
        b.num(w.I64_DIVU);
        b.num(w.I32_WRAP_I64);
        b.els();
        b.i32Const(0);
        b.end();
        b.localSet(n);
        const blk = allocArrBlk(f, n);
        fnLoop(f, () => {
          b.localGet(n);
        }, k => {
          elemAddr(f, blk, k);
          b.localGet(s);
          b.localGet(k);
          b.num(w.I64_EXTEND_I32_S);
          b.localGet(stepv);
          b.num(w.I64_MUL);
          b.num(w.I64_ADD);
          b.structNew(9);
          b.arraySet();
        });
        boxArr(f, blk);
        break;
      }
      case "char": {
        // char's code-point arg is i64: adapt the box, wrap to i32,
        // hand the host a plain number box (the import reads the f64
        // payload).
        const cp = i64(f);
        pushRef(f, {k: "slot", i: 0});
        b.callFn(em.ix.fI64of);
        b.localSet(cp);
        b.localGet(cp);
        b.num(w.I32_WRAP_I64);
        b.num(w.CONV_I32);
        b.callFn(em.ix.fBox);
        b.callFn(em.o.impIdx.get("ef_char")!);
        break;
      }
      case "number":
        slot(f, 0);
        b.callFn(em.o.impIdx.get("ef_number")!);
        break;
      case "bytes": {
        // UTF-8 bytes are the string representation itself: a fresh boxed
        // [u8] array over the string's own bytes. A string value is a bare
        // $STR array (no slice wrapper); packed array.get loads unsigned,
        // so elements are already 0..255 for the $U32 box.
        const sd = typed(f, _T.RN[2]), sl = i32(f);   // (ref $STR) local
        slot(f, 0);
        b.refCast(2, false);
        b.localSet(sd);
        b.localGet(sd);
        b.arrayLen();
        b.localSet(sl);
        const blk = allocArrBlk(f, sl);
        fnLoop(f, () => { b.localGet(sl); }, i => {
          elemAddr(f, blk, i);
          b.localGet(sd);
          b.localGet(i);
          b.arrayGet(2);
          b.structNew(8);   // $U32 box — u8 shares the masked-i32 box
          b.arraySet();
        });
        boxArr(f, blk);
        break;
      }
      case "args":
        b.callFn(em.o.impIdx.get("ef_args")!);
        break;
      case "get": {
        const blk = anyref(f), off = i32(f), len = i32(f), idx = i32(f);
        const idx64 = i64(f);
        readIdx(idx64, idx, blk, off, len, 1);
        b.localGet(idx);
        b.i32Const(0);
        b.num(w.LTS); // idx < 0
        b.localGet(idx);
        b.localGet(len);
        b.num(w.GEU); // idx >= len (the view's length)
        b.num(w.OR);
        b.if();
        emitFail(em, f, 1, null, () => {
          b.localGet(idx64);
          b.num(w.CONV_F64_I64); // f64.convert_i64_s — the index as an f64
        }, () => {
          b.localGet(len);
          b.num(w.CONV_I32);
        }, constF64(f, 0));
        b.end();
        elemAddrOff(f, blk, idx, off);
        b.arrayGet(1);
        break;
      }
      case "set": {
        const xs = anyref(f), blk = anyref(f), off = i32(f), len = i32(f), idx = i32(f), v = anyref(f);
        const idx64 = i64(f);
        readIdx(idx64, idx, blk, off, len, 6, xs);
        slot(f, 2);
        b.localSet(v);
        // Strictly in-window write through the view: idx < 0 || idx >= len
        // fails (code 6); there is no growth — concat is the only appender.
        b.localGet(idx);
        b.i32Const(0);
        b.num(w.LTS);
        b.localGet(idx);
        b.localGet(len);
        b.num(w.GEU);
        b.num(w.OR);
        b.if();
        emitFail(em, f, 6, null, () => {
          b.localGet(idx64);
          b.num(w.CONV_F64_I64);
        }, () => {
          b.localGet(len);
          b.num(w.CONV_I32);
        }, constF64(f, 0));
        b.end();
        elemAddrOff(f, blk, idx, off);
        b.localGet(v);
        b.arraySet();
        b.refNull(w.ANYREF);
        break;
      }
      case "map":
      case "each":
      case "flatmap":
        emitMapLike(em, f, name);
        break;
      default:
        throw new WasmError(`internal: builtin ${name} not implemented`);
    }
    // Complete with the ABI's dispatch: builtins are called with k=0, so
    // dispatch(0, v) just returns the computed value.
    const v = anyref(f);
    b.localSet(v);
    emitDispatch(em, f, v);
    out.push(f);
  }
  return out;
}

// The devirt pass's per-site tight map/each/flatmap loop fns: registered by
// the dcall/call emitters (which may run in CFns or the main term — always
// before this), bodies emitted now that the shared trampolines' helpers
// exist. Runs after emitMain, before the thunks land in the fn list.
export function emitTightMaps(em: Emit): void {
  for (const tm of em.tightMaps) emitMapLike(em, tm.f, tm.name, tm.cb);
}

// map/each/flatmap CPS: the entry (this builtin Fn) runs with the
// caller's RET cell as its k and its result dispatches through the
// caller's continuation. The entry allocates the result array into its
// own frame and tail-calls the loop-entry thunk with the next index
// riding its value arg; each iteration installs a fresh per-iteration
// land frame {parent: the entry frame, slots: [the boxed index]} and
// calls the callback with a RET cell {K_RET, iter-land, that frame,
// ambient k} — so a performing callback walks the caller's handler
// chain, and a completed callback lands in the per-iteration thunk
// (res[i] = v at the cell's own index, loop-entry at i+1). The index is
// frozen in the cell's frame the moment the cell is installed, so a
// captured copy resumed later re-delivers into its own iteration — never
// re-reading shared loop state (the interp's per-element land closure,
// builtins.ts natives). The result/tmp array stays in the entry frame:
// shared across resumes, monotonic (each delivery overwrites its own
// slot), so the loop survives suspension.
// `cb` (devirt): when set, this is a per-site tight variant — the callback
// is a proven pure direct CFn; its T_DABI entry is called statically (env
// still read off the closure value), no per-element flag dispatch.
function emitMapLike(em: Emit, f: Fn, name: string, cb?: {idx: number, fsize: number}): void {
  const b = f.body;
  const resSlot = name === "each" ? -1 : 2; // map: res, flatmap: tmp
  const loopEntry = makeRestThunk(em, "maplike:loopEntry");
  const iterLand = makeRestThunk(em, "maplike:iterLand");
  // Per-iteration land: store the callback result (map/flatmap) at the
  // iteration's own index, continue the loop at i + 1. frame = the
  // iteration's own land frame (slot 0 = the boxed index), v = the
  // callback result, k = the ambient continuation (passed to the next
  // iteration).
  {
    const t = iterLand, tb = t.body;
    const iL = i32(t);
    slot(t, 0); // the land frame's boxed index ($I64 box)
    tb.readBoxPayload(9);
    tb.num(w.I32_WRAP_I64);
    tb.localSet(iL);
    if (name !== "each") {
      const blk = anyref(t);
      tb.localGet(0); tb.structGet(4, 0); // the entry frame (the land frame's parent)
      tb.structGet(4, 1);
      tb.i32Const(resSlot);
      tb.arrayGet(1);
      unboxArr(t, blk);
      elemAddr(t, blk, iL);
      tb.localGet(1);
      tb.arraySet();
    }
    tb.localGet(0); tb.structGet(4, 0); // the entry frame
    tb.localGet(iL);
    tb.i32Const(1);
    tb.num(w.ADD);
    tb.num(w.I64_EXTEND_I32_S); // the next index rides the $I64 box
    rebox(em, t, "i64");
    tb.localGet(2);
    tb.callFn(loopEntry.idx, true);
  }

  // Loop entry: done → finalize (box the result / flatmap copy) and
  // dispatch through this thunk's k; else call the callback on element i
  // over a fresh per-iteration land frame. The next index arrives in the
  // value arg as an $I64 box (the value arg is an anyref under the
  // T_III_I ABI — a raw frame-parent null would misvalidate struct.new).
  {
    const t = loopEntry, tb = t.body;
    const xd = anyref(t), xo = i32(t), n = i32(t), iL = i32(t), fc = anyref(t);
    slot(t, 1); // the xs wrapper (arg 1) → its view window (data, off, len)
    unboxSlice(t, xd, xo, n);
    tb.localGet(1); // the value arg = the next index ($I64 box)
    tb.readBoxPayload(9);
    tb.num(w.I32_WRAP_I64);
    tb.localSet(iL);
    tb.localGet(iL);
    tb.localGet(n);
    tb.num(w.GEU);
    tb.if(0x40);
    const v = anyref(t);
    if (name === "map") {
      const res = anyref(t);
      slot(t, resSlot);
      unboxArr(t, res);
      boxArr(t, res);
    } else if (name === "each") {
      pushRef(t, em.lay.unitRef);
    } else {
      // flatmap: total = Σ per-element lengths; allocate; copy; box. The
      // tmp array is fresh (off 0), so its collect pass takes off 0.
      const tmp = anyref(t), tmpOff = i32(t), total = i32(t);
      slot(t, resSlot);
      unboxArr(t, tmp);
      tb.i32Const(0);
      tb.localSet(tmpOff);
      tb.i32Const(0);
      tb.localSet(total);
      collectLen(t, tmp, tmpOff, n, total);
      const res = allocArrBlk(t, total);
      collectCopy(t, tmp, tmpOff, res, n);
      boxArr(t, res);
    }
    tb.localSet(v);
    emitDispatch(em, t, v, 2); // k = this thunk's k param
    tb.ret(); // only the k=0 branch reaches here, with the value
    tb.els();
    // Iteration: elem = xs[i] (through the view's window); the callback's
    // RET cell lands in iterLand (landA) over a fresh per-iteration land
    // frame, with next = this thunk's k. The callback closure's flag picks
    // the entry ABI: direct entries return their value — land it in
    // iterLand here; CPS entries take the generic land-cell call.
    slot(t, 0);
    tb.localSet(fc);
    const elem = anyref(t);
    elemAddrOff(t, xd, iL, xo);
    tb.arrayGet(1);
    tb.localSet(elem);
    // The per-iteration land frame {parent: the entry frame, slots: [the
    // boxed index]}: once the cell is installed the frame is never written
    // again, so a captured copy freezes its iteration's index.
    const landFrame = (): void => {
      const slots = anyref(t);
      tb.i32Const(1);
      tb.arrayNew(1);
      tb.localSet(slots);
      tb.localGet(slots);
      tb.refCast(1, true);
      tb.i32Const(0);
      tb.localGet(1); // the boxed index (this thunk's value arg)
      tb.arraySet();
      tb.localGet(0); // parent = the entry frame
      tb.localGet(slots);
      tb.refCast(1, true);
      tb.structNew(4); // {parent, slots} — the cell's frame operand
    };
    const cbArgs = (k: number, ffp: number): void => {
      // Suspension-safe as-is: elem/iL are locals set before the call, and
      // fBox cannot suspend, so no operand spans a suspension point.
      tb.localGet(ffp); tb.refCast(4, true); tb.structGet(4, 1);
      tb.i32Const(k);
      if (k === 0) tb.localGet(elem);
      else {
        // The index param is typed i64 — box at $I64 (an $F64 box would
        // trap the callback's stamped i64 reads).
        tb.localGet(iL);
        tb.num(w.I64_EXTEND_I32_S);
        rebox(em, t, "i64");
      }
      tb.arraySet();
    };
    const argc = name === "map" ? 1 : 2;
    if (cb !== undefined) {
      // Tight variant: static T_DABI call over the callback's env, landed
      // in iterLand — no flag read, no call_indirect, no CPS arm.
      emitDirectEntryCall(em, t, fc, argc, cbArgs, {kind: "land", landA: iterLand.idx, kL: 2, landFrameE: landFrame}, cb);
      tb.unreachable(); // the land dispatch always tails
    } else {
      const cbFlag = i32(t);
      tb.localGet(fc); tb.refCast(6, true); tb.structGet(6, 3); tb.i31Get();
      tb.localSet(cbFlag);
      tb.localGet(cbFlag);
      tb.if();
      emitDirectEntryCall(em, t, fc, argc, cbArgs, {kind: "land", landA: iterLand.idx, kL: 2, landFrameE: landFrame});
      tb.unreachable(); // the land dispatch always tails
      tb.els();
      emitCallClosure(t, fc, argc, cbArgs, {land: true, kL: 2, landA: iterLand.idx, landFrameE: landFrame});
      tb.unreachable(); // the callback always tails into iterLand
      tb.end();
      tb.unreachable(); // both flag arms diverge
    }
    tb.end();
    tb.unreachable(); // both iteration arms diverge; keep the implicit end typed
  }
  // Entry (this builtin Fn): allocate the result array, tail-call the loop
  // entry with index 0. n comes from the wrapper's len field (the view's
  // length), not the backing's.
  const n = i32(f);
  slot(f, 1);
  b.refCast(3, true);
  b.structGet(3, 2);
  b.localSet(n);
  if (resSlot >= 0) {
    const res = allocArrBlk(f, n);
    b.localGet(0); b.structGet(4, 1);
    b.i32Const(resSlot);
    boxArr(f, res); // the slot holds the $ARR wrapper (iterLand + the
                         // done path read it back as a wrapper)
    b.arraySet();
  }
  b.localGet(0);
  // The next index (0) rides the $I64 box: loopEntry reads its value arg
  // as an $I64 box, and the unitRef static is an $F64 box — wrong shape.
  b.i64Const(0n);
  rebox(em, f, "i64");
  b.localGet(1);
  b.callFn(loopEntry.idx, true);
}

// run (allocates the global frame, calls main with k = null) and the
// 12 host accessors (JS cannot read GC fields directly). Appended after
// main; each registers through the registrar at its push position. mainFn
// is the program-term function returned by emitMain.
export function emitInits(em: Emit, mainFn: Fn): void {
  const mainIdx = register(em.reg, "main", mainFn, w.T_KABI);
  const run = newFn(0, em);
  register(em.reg, "run", run, w.T_RUN);
  {
    const b = run.body;
    b.refNull(4); // global frame parent = null
    b.i32Const(em.plan.mainFrameSize);
    b.arrayNew(1);
    b.structNew(4);
    b.refNull(5); // k = null: main's dispatch returns its value
    b.callFn(mainIdx);
  }
  em.funcs.push(run);
  const acc = (params: number, typeIdx: number, emit: (b: Buf, f: Fn) => void): Fn => {
    const f = newFn(params, em);
    register(em.reg, `init${em.funcs.length}`, f, typeIdx);
    emit(f.body, f);
    em.funcs.push(f);
    return f;
  };
  // __tag(v) -> i32: 0 unit (null) 1 $F64 2 bool 3 str 4 arr 5 clo,
  // 6..10 = $I32/$U32/$I64/$U64/$F32 (tag = box shape − 1 for the appended
  // per-width number shapes 7..11), 11 = $TUP (shape 12).
  acc(1, 14, (b) => {
    b.localIsNull(0);
    b.if(0x7f);
    b.i32Const(0);
    b.els();
    const tag = (ht: number, t: number) => {
      b.localGet(0);
      b.refTest(ht, false);
      b.if(0x7f);
      b.i32Const(t);
      b.els();
    };
    // Test box shapes in order: I31=2, $F64=1, $STR=3, $ARR=4, $CLO=5,
    // then the per-width number boxes $I32..$F32 = 6..10, then $TUP = 11.
    const TAGS: [number, number][] = [
      [w.I31REF, 2], [0, 1], [2, 3], [3, 4], [6, 5],
      [7, 6], [8, 7], [9, 8], [10, 9], [11, 10], [12, 11],
    ];
    for (const [ht, t] of TAGS) tag(ht, t);
    b.unreachable();
    for (let i = 0; i < 12; i++) b.end(); // close the if/else chain
  });
  // __num(v) -> f64: the full numeric-box ladder (the JS side reads any
  // width's box as a Number — $F32 promotes, the int boxes convert, $F64 is
  // the payload; a non-number still traps at the final cast). Same arms as
  // $num64 minus its $F64-identity fast arm (the payload read is the
  // default here).
  acc(1, w.T_NUM64, (b) => ladderBody(b, {ret: 0x7c, arms: NUM64_ARMS, defOps: []}));
  // __str_len(v) -> i32
  acc(1, 14, (b) => {
    b.localGet(0);
    b.refCast(2, false);
    b.arrayLen();
  });
  // __str_get(v, i) -> i32 — UTF-8 byte; packed array.get loads unsigned.
  acc(2, 20, (b) => {
    b.localGet(0);
    b.refCast(2, false);
    b.localGet(1);
    b.arrayGet(2);
  });
  // __arr_len(v) -> i32: the view's length (wrapper field 2).
  acc(1, 14, (b) => {
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 2);
  });
  // __arr_get(v, i) -> anyref: data[off + i] — accessor-side bounds live
  // with the module's get; the host calls this on values it boxed itself.
  acc(2, 22, (b) => {
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 0);
    b.localGet(1);
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 1);
    b.num(w.ADD);
    b.arrayGet(1);
  });
  // Box constructors/readers: __mk_num (the $F64 box), then __mk_f32/__f32,
  // __mk_i32/__mk_u32/__i32/__u32, __mk_i64/__mk_u64/__i64/__u64 (the
  // i64/u64 param is a JS BigInt through the standard wasm
  // JS-BigInt integration). Payload is raw two's-complement bits — the HOST
  // masks __u32 with >>> 0 and __u64 with BigInt.asUintN(64, ...). Call order
  // is positional: export names zip onto the last functions in push order.
  const mkBox = (ti: number, shape: number): void => {
    acc(1, ti, (b) => {
      b.localGet(0);
      b.structNew(shape);
    });
  };
  const getBox = (ti: number, shape: number): void => {
    acc(1, ti, (b) => {
      b.localGet(0);
      b.readBoxPayload(shape);
    });
  };
  mkBox(w.T_BOX, 0); // __mk_num
  mkBox(w.T_MKF32, 11); // __mk_f32
  getBox(w.T_F32, 11); // __f32
  mkBox(w.T_MKI32, 7); // __mk_i32
  mkBox(w.T_MKI32, 8); // __mk_u32
  getBox(w.T_GETI32, 7); // __i32
  getBox(w.T_GETI32, 8); // __u32
  mkBox(w.T_MKI64, 9); // __mk_i64
  mkBox(w.T_MKI64, 10); // __mk_u64
  getBox(w.T_GETI64, 9); // __i64
  getBox(w.T_GETI64, 10); // __u64
  // __mk_bool(b) -> anyref
  acc(1, 12, (b) => {
    b.localGet(0);
    b.refI31();
  });
  // __str_new(n) -> anyref
  acc(1, 12, (b) => {
    b.localGet(0);
    b.arrayNew(2);
  });
  // __str_set(v, i, u) -> ()
  acc(3, 21, (b) => {
    b.localGet(0);
    b.refCast(2, false);
    b.localGet(1);
    b.localGet(2);
    b.arraySet();
  });
  // __arr_new(n) -> anyref: fresh backing {n slots}, window [0, n).
  acc(1, 12, (b) => {
    b.localGet(0);
    b.arrayNew(1);
    b.i32Const(0);
    b.localGet(0);
    b.structNew(3);
  });
  // __arr_set(v, i, x) -> (): data[off + i] = x.
  acc(3, 23, (b) => {
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 0);
    b.localGet(1);
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 1);
    b.num(w.ADD);
    b.localGet(2);
    b.arraySet();
  });
  // __tup_new(n) -> anyref: fresh $TUP fields {n slots}.
  acc(1, 12, (b) => {
    b.localGet(0);
    b.arrayNew(1);
    b.structNew(12);
  });
  // __tup_len(v) -> i32
  acc(1, 14, (b) => {
    b.localGet(0);
    b.refCast(12, false);
    b.structGet(12, 0);
    b.arrayLen();
  });
  // __tup_get(v, i) -> anyref
  acc(2, 22, (b) => {
    b.localGet(0);
    b.refCast(12, false);
    b.structGet(12, 0);
    b.localGet(1);
    b.arrayGet(1);
  });
  // __tup_set(v, i, x) -> ()
  acc(3, 23, (b) => {
    b.localGet(0);
    b.refCast(12, false);
    b.structGet(12, 0);
    b.localGet(1);
    b.localGet(2);
    b.arraySet();
  });
}
