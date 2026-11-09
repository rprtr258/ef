// Module-level function emission of the wasm backend: builtin trampolines
// and host-import thunks (§7), main (§7.2) and the run/accessor init
// functions the host imports (§4). The §-numbered design doc for the whole
// backend lives at the top of wasm.ts.
import {type ExprID} from "./parser.ts";
import {BUILTINS} from "./analysis.ts";
import {WasmError} from "./wasm_types.ts";
import {Buf, Fn} from "./wasm_body.ts";
import {frameSizeOf} from "./wasm_pipeline.ts";
import {NUM64_ARMS, type Emit, Split, emitCallClosure, emitDispatch, emitFail, expr, fillRest, i31of, ladderBody, makeRestThunk, selectBool} from "./wasm_emit.ts";
import * as w from "./wasm_consts.ts";

// Σ over the n per-element cells in backing `src`: array elements add
// their length, scalars add 1 (the tag test, not the value — JS
// Array.prototype.flat parity; a resumed scalar flowing back through a
// map-like land path lands exactly here). The shared size pass of flat
// and flatmap; `total` accumulates.
function collectLen(f: Fn, src: number, n: number, total: number): void {
  const b = f.body;
  f.loop(() => { b.localGet(n); }, i => {
    const cell = f.anyref();
    f.elemAddr(src, i);
    b.arrayGet(1);
    b.localSet(cell);
    b.localGet(cell);
    b.refTest(3, false); // is $ARR?
    b.if();
    b.localGet(cell);
    b.refCast(3, true);
    b.structGet(3, 0);
    b.refCast(1, true);
    b.arrayLen(); // inner len
    b.localGet(total);
    b.u8(w.ADD);
    b.localSet(total);
    b.u8(w.ELSE);
    b.localGet(total);
    b.i32Const(1);
    b.u8(w.ADD);
    b.localSet(total);
    b.u8(w.END);
  });
}

// Copy the n per-element cells from backing `src` into the fresh backing
// `dst`: array elements copy their items at the running write index (the
// element values, same layout the box/collect path reads back), scalars
// copy as themselves. The shared finalize of flat and flatmap; boxArr(dst)
// afterwards.
function collectCopy(f: Fn, src: number, dst: number, n: number): void {
  const b = f.body;
  const ww = f.i32();
  b.i32Const(0);
  b.localSet(ww);
  f.loop(() => { b.localGet(n); }, i => {
    const cell = f.anyref(), xb = f.anyref(), xl = f.i32();
    f.elemAddr(src, i);
    b.arrayGet(1);
    b.localSet(cell);
    b.localGet(cell);
    b.refTest(3, false);
    b.if();
    b.localGet(cell);
    f.unboxArr(xb);
    b.arrLenOf(xb);
    b.localSet(xl);
    f.loop(() => { b.localGet(xl); }, j => {
      f.elemAddr(dst, ww);
      f.elemAddr(xb, j);
      b.arrayGet(1);
      b.arraySet();
      b.localGet(ww);
      b.i32Const(1);
      b.u8(w.ADD);
      b.localSet(ww);
    });
    b.u8(w.ELSE);
    f.elemAddr(dst, ww);
    b.localGet(cell);
    b.arraySet();
    b.localGet(ww);
    b.i32Const(1);
    b.u8(w.ADD);
    b.localSet(ww);
    b.u8(w.END);
  });
}

export function emitBuiltins(em: Emit, builtin0: number): Fn[] {
  const out: Fn[] = [];
  // Wide-priority dispatch for the trampolines' fallback plane (typed-widths
  // step 5): the interpreter's eitherBig coerces the Number side to BigInt
  // (trunc) whenever either operand is a BigInt (an $I64/$U64 box), so the
  // fallback computes in i64 then, reading each box with its own signedness
  // ($I64/$I32 signed, $U64/$U32 unsigned, floats truncate — asBig's
  // BigInt(Math.trunc(v))), and in f64 otherwise.
  // Emits the either-wide condition (an i32 on the operand stack, for an IF).
  const eitherWide = (bb: Buf): void => {
    bb.localGet(0);
    bb.refTest(9, false);
    bb.localGet(0);
    bb.refTest(10, false);
    bb.u8(w.OR);
    bb.localGet(1);
    bb.refTest(9, false);
    bb.localGet(1);
    bb.refTest(10, false);
    bb.u8(w.OR);
    bb.u8(w.OR);
  };
  // Per-box-signedness i64 read of frame slot i (eitherBig's asBig).
  const readI64Signed = (bb: Buf, i: number): void => {
    bb.localGet(i);
    bb.refTest(10, false);
    bb.localGet(i);
    bb.refTest(8, false);
    bb.u8(w.OR);
    bb.u8(w.IF);
    bb.u8(0x7e);
    bb.localGet(i);
    bb.callFn(em.ix.fU64of);
    bb.u8(w.ELSE);
    bb.localGet(i);
    bb.callFn(em.ix.fI64of);
    bb.u8(w.END);
  };
  // Adaptive f64 read of frame slot i ($num64 — any numeric box converts).
  const readNum64 = (fn: Fn, bb: Buf, i: number): number => {
    const l = fn.f64();
    fn.slot(i);
    bb.callFn(em.ix.fNum64);
    bb.localSet(l);
    return l;
  };
  for (const {name} of BUILTINS) {
    if (!em.o.usedBuiltins.has(name)) continue;
    const f = new Fn(2, em); // (frame, k): builtins are T_KABI trampolines
    f.typeIdx = w.T_KABI;
    f.idx = builtin0 + out.length; // matches the push order (usedBuiltins filter)
    em.ix.funcRefTypes.set(f.idx, w.T_KABI);
    const b = f.body;
    const box = () => {
      b.callFn(em.ix.fBox);
    };
    // Shared get/set prologue: slot 1 read adaptively as i64 (fI64of) and
    // wrapped to i32 in idxL; slot 0 unboxed into the list backing blkL with
    // its length in lenL. set keeps its wrapper in xsL first.
    const readIdx = (idx64L: number, idxL: number, blkL: number, lenL: number, xsL?: number): void => {
      f.pushRef({k: "slot", i: 1});
      b.callFn(em.ix.fI64of);
      b.localSet(idx64L);
      if (xsL === undefined) f.slot(0);
      else { f.slot(0); b.localSet(xsL); b.localGet(xsL); }
      f.unboxArr(blkL);
      b.arrLenOf(blkL);
      b.localSet(lenL);
      b.localGet(idx64L);
      b.u8(w.I32_WRAP_I64);
      b.localSet(idxL);
    };
    switch (name) {
      case "+": {
        const a = f.anyref(), bv = f.anyref();
        f.slot(0);
        b.localSet(a);
        f.slot(1);
        b.localSet(bv);
        b.bothIs(0, a, bv); // result anyref
        b.loadPayload(0, a);
        b.loadPayload(0, bv);
        b.u8(w.FADD);
        box();
        b.u8(w.ELSE);
        b.bothIs(2, a, bv);
        f.emitStrCat(a, bv);
        b.u8(w.ELSE);
        for (const ht of [9, 10]) { // $I64/$U64: the raw i64 payload add, same box back
          b.bothIs(ht, a, bv);
          b.loadPayload(ht, a);
          b.loadPayload(ht, bv);
          b.u8(w.I64_ADD);
          b.structNew(ht);
          b.u8(w.ELSE);
        }
        b.refNull(w.ANYREF);
        b.u8(w.END);
        b.u8(w.END);
        b.u8(w.END);
        b.u8(w.END);
        break;
      }
      case "-":
      case "*":
      case "%":
      case "neg":
      case "<":
      case ">":
      case "<=":
      case ">=": {
        // Typed-widths step 2: operators reached as values dispatch on the
        // boxed operands' tags — both $F32 computes with the f32 family,
        // anything else takes the f64 plane (matches the inline emitters,
        // which dispatch statically on the site's numKind stamp).
        const f32op = name !== "neg"; // binary ops test both operands
        if (f32op) {
          const a = f.anyref(), bv = f.anyref();
          f.slot(0);
          b.localSet(a);
          f.slot(1);
          b.localSet(bv);
          // name → index into each plane's opcode row [sub, mul, lt, gt, le, ge].
          const oi = (n: string): number => (n === "-" ? 0 : n === "*" ? 1 : n === "<" ? 2 : n === ">" ? 3 : n === "<=" ? 4 : 5);
          // One width plane (see the case comment): both operands are `ht`
          // boxes → load their payloads and compute; % expands JS fmod as
          // a - b*trunc(a/b) (floats: fmod[0] = [div, trunc]) or
          // a - (a rem b)*b (ints: fmod[0] = [rem]); compares select an
          // i31 bool, arithmetic reboxes.
          const plane = (ht: number, alloc: () => number, ops: number[], fmod: [number[], number, number]): void => {
            b.bothIs(ht, a, bv);
            const x = alloc(), y = alloc(), t = alloc();
            b.loadPayload(ht, a);
            b.localSet(x);
            b.loadPayload(ht, bv);
            b.localSet(y);
            if (name === "%") {
              b.localGet(x);
              b.localGet(y);
              for (const o of fmod[0]) b.u8(o);
              b.localSet(t);
              b.localGet(x);
              b.localGet(y);
              b.localGet(t);
              b.u8(fmod[1]);
              b.u8(fmod[2]);
            } else {
              b.localGet(x);
              b.localGet(y);
              b.u8(ops[oi(name)]);
            }
            if (name === "<" || name === ">" || name === "<=" || name === ">=") {
              selectBool(em, f);
            } else {
              b.structNew(ht);
            }
            b.u8(w.ELSE);
          };
          plane(11, () => f.f32(), [w.F32_SUB, w.F32_MUL, w.F32_LT, w.F32_GT, w.F32_LE, w.F32_GE],
            [[w.F32_DIV, w.F32_TRUNC], w.F32_MUL, w.F32_SUB]);
          plane(7, () => f.i32(), [w.SUB, w.MUL, w.LTS, w.GTS, w.LES, w.GES], [[w.REMS], w.MUL, w.SUB]);
          plane(8, () => f.i32(), [w.SUB, w.MUL, w.LTU, w.GTU, w.LEU, w.GEU], [[w.REMU], w.MUL, w.SUB]);
          // $I64/$U64 arms (typed-widths step 4): exact 64-bit compute.
          for (const wide of [9, 10]) {
            plane(wide, () => f.i64(), [
              w.I64_SUB, w.I64_MUL,
              ...(wide === 9 ? [w.I64_LTS, w.I64_GTS, w.I64_LES, w.I64_GES] : [w.I64_LTU, w.I64_GTU, w.I64_LEU, w.I64_GEU]),
            ], [[wide === 9 ? w.I64_REMS : w.I64_REMU], w.I64_MUL, w.I64_SUB]);
          }
        }
        if (name === "<" || name === ">" || name === "<=" || name === ">=") {
          const r = f.i32();
          b.block();
          eitherWide(b);
          b.if();
          // eitherBig: one BigInt side makes the whole compare BigInt
          // (the Number side truncs) — signed i64 order.
          {
            const x = f.i64(), y = f.i64();
            readI64Signed(b, 0);
            b.localSet(x);
            readI64Signed(b, 1);
            b.localSet(y);
            b.localGet(x);
            b.localGet(y);
            b.u8(name === "<" ? w.I64_LTS : name === ">" ? w.I64_GTS : name === "<=" ? w.I64_LES : w.I64_GES);
            b.localSet(r);
          }
          b.u8(w.BR);
          b.lebU(1);
          b.u8(w.END);
          {
            const x = readNum64(f, b, 0), y = readNum64(f, b, 1);
            const cmp = name === "<" ? w.FLT : name === ">" ? w.FGT : name === "<=" ? w.FLE : w.FGE;
            b.localGet(x);
            b.localGet(y);
            b.u8(cmp);
            b.localSet(r);
          }
          b.u8(w.END);
          selectBool(em, f, () => {
            b.localGet(r);
          });
        } else {
          b.block();
          eitherWide(b);
          b.if();
          // eitherBig: i64 math (each box's own signedness read), $I64 box.
          {
            const x = f.i64(), y = f.i64();
            if (name === "neg") {
              b.i64Const(0n);
              readI64Signed(b, 0);
              b.u8(w.I64_SUB);
              b.localSet(x);
            } else {
              readI64Signed(b, 0);
              b.localSet(x);
              readI64Signed(b, 1);
              b.localSet(y);
              if (name === "%") {
                b.localGet(x);
                b.localGet(y);
                b.u8(w.I64_REMS);
              } else {
                b.localGet(x);
                b.localGet(y);
                b.u8(name === "-" ? w.I64_SUB : w.I64_MUL);
              }
            }
            b.structNew(9);
          }
          b.u8(w.BR);
          b.lebU(1);
          b.u8(w.END);
          const x = readNum64(f, b, 0), y = name === "neg" ? 0 : readNum64(f, b, 1);
          if (name === "%") {
            // JS fmod: a - b * trunc(a/b)
            const t = f.f64();
            b.localGet(x);
            b.localGet(y);
            b.u8(w.FDIV);
            b.u8(w.FTRUNC);
            b.localSet(t);
            b.localGet(x);
            b.localGet(y);
            b.localGet(t);
            b.u8(w.FMUL);
            b.u8(w.FSUB);
          } else {
            b.localGet(x);
            if (name === "neg") {
              b.u8(w.FNEG);
            } else {
              b.localGet(y);
              b.u8(name === "-" ? w.FSUB : w.FMUL);
            }
          }
          b.u8(w.END);
          box();
        }
        if (f32op) {
          b.u8(w.END);
          b.u8(w.END);
          b.u8(w.END);
        }
        break;
      }
      case "==": {
        f.slot(0);
        f.slot(1);
        b.callFn(em.ix.fEq);
        break;
      }
      case "!=": {
        f.slot(0);
        f.slot(1);
        b.callFn(em.ix.fEq);
        i31of(b); // eq result's i31 bool payload
        b.u8(w.EQZ); // 1 when $eq said false
        selectBool(em, f);
        break;
      }
      case "not": {
        f.slot(0);
        b.callFn(em.ix.fTruthy);
        b.u8(w.EQZ);
        selectBool(em, f);
        break;
      }
      case "list": {
        // The frame has fsize 0, so the slots array length IS argc — the
        // only argc reader in the backend (do not generalize).
        const n = f.i32();
        b.localGet(0);
        b.structGet(4, 1);
        b.arrayLen();
        b.localSet(n);
        const blk = f.allocArrBlk(n);
        f.loop(() => {
          b.localGet(n);
        }, i => {
          f.elemAddr(blk, i);
          f.slot(i);
          b.arraySet();
        });
        f.boxArr(blk);
        break;
      }
      case "head": {
        const blk = f.anyref();
        f.slot(0);
        f.unboxArr(blk);
        b.arrLenOf(blk);
        b.u8(w.EQZ);
        b.if();
        emitFail(em, f, 0, null, f.constF64(0), f.constF64(0));
        b.u8(w.END);
        b.localGet(blk);
        b.refCast(1, true);
        b.i32Const(0);
        b.arrayGet(1);
        break;
      }
      case "tail": {
        const blk = f.anyref(), len = f.i32(), n1 = f.i32();
        f.slot(0);
        f.unboxArr(blk);
        b.arrLenOf(blk);
        b.localSet(len);
        b.localGet(len);
        b.u8(w.EQZ);
        b.if(0x7f);
        b.i32Const(0);
        b.u8(w.ELSE);
        b.localGet(len);
        b.i32Const(1);
        b.u8(w.SUB);
        b.u8(w.END);
        b.localSet(n1);
        f.emitArrCopy(blk, 1, n1);
        break;
      }
      case "concat": {
        const aBlk = f.anyref(), bBlk = f.anyref(), la = f.i32(), lb = f.i32(), n = f.i32();
        f.slot(0);
        f.unboxArr(aBlk);
        f.slot(1);
        f.unboxArr(bBlk);
        b.arrLenOf(aBlk);
        b.localSet(la);
        b.arrLenOf(bBlk);
        b.localSet(lb);
        b.localGet(la);
        b.localGet(lb);
        b.u8(w.ADD);
        b.localSet(n);
        const blk = f.allocArrBlk(n);
        // array.copy both halves into the fresh dst (no overlap: dst is new).
        b.localGet(blk); b.refCast(1, true); b.i32Const(0);
        b.localGet(aBlk); b.refCast(1, true); b.i32Const(0); b.localGet(la);
        b.arrayCopy(1, 1);
        b.localGet(blk); b.refCast(1, true); b.localGet(la);
        b.localGet(bBlk); b.refCast(1, true); b.i32Const(0); b.localGet(lb);
        b.arrayCopy(1, 1);
        f.boxArr(blk);
        break;
      }
      case "flat": {
        const xss = f.anyref(), n = f.i32(), total = f.i32();
        f.slot(0);
        f.unboxArr(xss);
        b.arrLenOf(xss);
        b.localSet(n);
        b.i32Const(0);
        b.localSet(total);
        collectLen(f, xss, n, total);
        const blk = f.allocArrBlk(total);
        collectCopy(f, xss, blk, n);
        f.boxArr(blk);
        break;
      }
      case "len":
      case "strlen": {
        // len: the closure's $ARR payload; strlen: the $STR itself.
        f.slot(0);
        if (name === "len") { b.refCast(3, true); b.structGet(3, 0); b.refCast(1, true); }
        else b.refCast(2, true);
        b.arrayLen();
        b.u8(w.I64_EXTEND_I32_S); // len is i64 (D7)
        b.structNew(9);
        break;
      }
      case "PI":
        b.globalGet(em.lay.piG);
        break;
      case "cos":
      case "sin":
        f.slot(0);
        b.callFn(em.o.impIdx.get(`ef_${name}`)!);
        break;
      case "sqrt":
      case "abs": {
        const x = f.f64();
        f.slot(0);
        b.callFn(em.ix.fNum64); // adaptive: an $F32 box promotes
        b.localSet(x);
        b.localGet(x);
        b.u8(name === "sqrt" ? w.FSQRT : w.FABS);
        box();
        break;
      }
      case "round": {
        const x = f.slotF64(0);
        b.localGet(x);
        b.f64Const(0.5);
        b.u8(w.FADD);
        b.u8(w.FFLOOR);
        b.u8(w.I64_TRUNC_F64); // round is i64 (D7)
        b.structNew(9);
        break;
      }
      case "range": {
        // range is an i64 builtin (D7): the bounds read adaptively ($I64
        // boxes since step 4; legacy $F64 boxes truncate), the count and
        // the elements compute in i64. Count = the interpreter's
        // max(0, ceil((e - s) / step)): with span = |e - s| and mag =
        // |step|, elements exist iff (step > 0) == (e > s) && step != 0,
        // and the count is ceil(span / mag) = (span + mag - 1) / mag over
        // non-negatives (unsigned division is exact there).
        const s = f.i64(), ev = f.i64(), stepv = f.i64(), span = f.i64(), mag = f.i64();
        const dirOK = f.i32(), n = f.i32();
        const readI64 = (i: number, loc: number): void => {
          f.pushRef({k: "slot", i});
          b.callFn(em.ix.fI64of);
          b.localSet(loc);
        };
        const abs = (loc: number): void => {
          const neg = f.i32(), flip = f.i64();
          b.localGet(loc);
          b.i64Const(0n);
          b.u8(w.I64_LTS);
          b.localSet(neg);
          b.localGet(neg);
          b.if(0x7e);
          b.i64Const(-1n); // neg: the XOR mask -1 (the two's-complement negate)
          b.u8(w.ELSE);
          b.i64Const(0n);
          b.u8(w.END);
          b.localSet(flip);
          b.localGet(flip);
          b.localGet(loc);
          b.u8(w.I64_XOR);
          b.localGet(neg);
          b.if(0x7e);
          b.i64Const(1n);
          b.u8(w.ELSE);
          b.i64Const(0n);
          b.u8(w.END);
          b.u8(w.I64_ADD);
          b.localSet(loc);
        };
        readI64(0, s);
        readI64(1, ev);
        readI64(2, stepv);
        // span = |e - s|, mag = |step|
        b.localGet(ev);
        b.localGet(s);
        b.u8(w.I64_SUB);
        b.localSet(span);
        b.localGet(span);
        abs(span);
        b.localGet(stepv);
        b.localSet(mag);
        b.localGet(mag);
        abs(mag);
        // dirOK = step != 0 && (step > 0) == (e > s)
        b.localGet(stepv);
        b.i64Const(0n);
        b.u8(w.I64_NE);
        b.localGet(stepv);
        b.i64Const(0n);
        b.u8(w.I64_GTS);
        b.localGet(ev);
        b.localGet(s);
        b.u8(w.I64_GTS);
        b.u8(w.EQ);
        b.u8(w.AND);
        b.localSet(dirOK);
        b.localGet(dirOK);
        b.if(0x7f);
        b.localGet(span);
        b.localGet(mag);
        b.u8(w.I64_ADD);
        b.i64Const(1n);
        b.u8(w.I64_SUB);
        b.localGet(mag);
        b.u8(w.I64_DIVU);
        b.u8(w.I32_WRAP_I64);
        b.u8(w.ELSE);
        b.i32Const(0);
        b.u8(w.END);
        b.localSet(n);
        const blk = f.allocArrBlk(n);
        f.loop(() => {
          b.localGet(n);
        }, k => {
          f.elemAddr(blk, k);
          b.localGet(s);
          b.localGet(k);
          b.u8(w.I64_EXTEND_I32_S);
          b.localGet(stepv);
          b.u8(w.I64_MUL);
          b.u8(w.I64_ADD);
          b.structNew(9);
          b.arraySet();
        });
        f.boxArr(blk);
        break;
      }
      case "char": {
        // char's code-point arg is i64 (D7): adapt the box, wrap to i32,
        // hand the host a plain number box (the import reads the f64
        // payload).
        const cp = f.i64();
        f.pushRef({k: "slot", i: 0});
        b.callFn(em.ix.fI64of);
        b.localSet(cp);
        b.localGet(cp);
        b.u8(w.I32_WRAP_I64);
        b.u8(w.CONV_I32);
        b.callFn(em.ix.fBox);
        b.callFn(em.o.impIdx.get("ef_char")!);
        break;
      }
      case "number":
        f.slot(0);
        b.callFn(em.o.impIdx.get("ef_number")!);
        break;
      case "args":
        b.callFn(em.o.impIdx.get("ef_args")!);
        break;
      case "get": {
        const blk = f.anyref(), len = f.i32(), idx = f.i32();
        const idx64 = f.i64();
        readIdx(idx64, idx, blk, len);
        b.localGet(idx);
        b.i32Const(0);
        b.u8(w.LTS); // idx < 0
        b.localGet(idx);
        b.localGet(len);
        b.u8(w.GEU); // idx >= len
        b.u8(w.OR);
        b.if();
        emitFail(em, f, 1, null, () => {
          b.localGet(idx64);
          b.u8(w.CONV_F64_I64); // f64.convert_i64_s — the index as an f64
        }, () => {
          b.localGet(len);
          b.u8(w.CONV_I32);
        });
        b.u8(w.END);
        f.elemAddr(blk, idx);
        b.arrayGet(1);
        break;
      }
      case "set": {
        const xs = f.anyref(), blk = f.anyref(), len = f.i32(), idx = f.i32(), v = f.anyref();
        const idx64 = f.i64();
        readIdx(idx64, idx, blk, len, xs);
        f.slot(2);
        b.localSet(v);
        b.localGet(idx);
        b.localGet(len);
        b.u8(w.LTU); // idx < len → in-place
        b.if();
        f.elemAddr(blk, idx);
        b.localGet(v);
        b.arraySet();
        b.u8(w.ELSE);
        // grow: fresh slots array of len idx+1, copy old, fill holes with
        // unit, repoint the wrapper's backing (aliases share the wrapper,
        // so they all see the growth — §7.1).
        const nb = f.anyref(), nlen = f.i32();
        b.localGet(idx);
        b.i32Const(1);
        b.u8(w.ADD);
        b.localSet(nlen);
        b.localGet(nlen);
        b.arrayNew(1);
        b.localSet(nb);
        f.loop(() => {
          b.localGet(nlen);
        }, k => {
          b.localGet(nb);
          b.refCast(1, true);
          b.localGet(k);
          b.localGet(k);
          b.localGet(len);
          b.u8(w.LTU); // k < old len → copy
          b.if(0x6e); // result anyref
          f.elemAddr(blk, k);
          b.arrayGet(1);
          b.u8(w.ELSE);
          b.refNull(w.ANYREF);
          b.u8(w.END);
          b.arraySet();
        });
        b.localGet(nb);
        b.refCast(1, true);
        b.localGet(idx);
        b.localGet(v);
        b.arraySet();
        b.localGet(xs);
        b.refCast(3, true);
        b.localGet(nb);
        b.refCast(1, true);
        b.structSet(0); // point the wrapper at the new backing
        b.u8(w.END);
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
    const v = f.anyref();
    b.localSet(v);
    emitDispatch(em, f, v);
    out.push(f);
  }
  return out;
}

// map/each/flatmap CPS (§3): a map-like call site is a landCalls split
// site, so the entry (this builtin Fn) runs with the caller's RET cell as
// its k and its result dispatches through the caller's continuation. The
// entry reads the array, allocates the result array into its own frame,
// and tail-calls the loop-entry thunk; each iteration calls the callback
// with a RET cell {K_RET, iter-land, entry frame, ambient k} — so a
// performing callback walks the caller's handler chain, and a completed
// callback lands in the per-iteration thunk (res[i] = v, i+1, loop-entry).
// All loop state (result/tmp array, counter) lives in the entry frame
// slots, so the loop survives suspension. The counter slot holds a boxed
// number (slots are anyref); it is unboxed for comparisons and boxed
// again when passed to the callback as the iteration index.
function emitMapLike(em: Emit, f: Fn, name: string): void {
  const b = f.body;
  const resSlot = name === "each" ? -1 : 2; // map: res, flatmap: tmp
  const iSlot = name === "each" ? 2 : 3;
  const loopEntry = makeRestThunk(em, "maplike:loopEntry");
  const iterLand = makeRestThunk(em, "maplike:iterLand");
  // Per-iteration land: store the callback result (map/flatmap), bump the
  // counter, continue the loop. frame = the entry frame, v = the callback
  // result, k = the ambient continuation (passed to the next iteration).
  {
    const t = iterLand, tb = t.body;
    if (name !== "each") {
      const blk = t.anyref(), iL = t.i32();
      t.slot(resSlot);
      t.unboxArr(blk);
      t.slot(iSlot);
      tb.readBoxPayload(0);
      tb.u8(w.TRUNC_F64);
      tb.localSet(iL);
      t.elemAddr(blk, iL);
      tb.localGet(1);
      tb.arraySet();
    }
    // counter += 1 (boxed back into the slot)
    tb.localGet(0); tb.structGet(4, 1);
    tb.i32Const(iSlot);
    t.slot(iSlot);
    tb.readBoxPayload(0);
    tb.f64Const(1);
    tb.u8(w.FADD);
    tb.callFn(em.ix.fBox);
    tb.arraySet();
    tb.localGet(0);
    t.pushRef(em.lay.unitRef);
    tb.localGet(2);
    tb.u8(w.RETURN_CALL);
    tb.lebU(loopEntry.idx);
  }

  // Loop entry: done → finalize (box the result / flatmap copy) and
  // dispatch through this thunk's k; else call the callback on element i.
  {
    const t = loopEntry, tb = t.body;
    const xb = t.anyref(), n = t.i32(), iL = t.i32(), fc = t.anyref();
    t.slot(1); // the xs wrapper (arg 1) → its backing array and length
    t.unboxArr(xb);
    tb.localGet(xb);
    tb.refCast(1, true);
    tb.arrayLen();
    tb.localSet(n);
    t.slot(iSlot);
    tb.readBoxPayload(0);
    tb.u8(w.TRUNC_F64);
    tb.localSet(iL);
    tb.localGet(iL);
    tb.localGet(n);
    tb.u8(w.GEU);
    tb.u8(w.IF);
    tb.u8(0x40);
    const v = t.anyref();
    if (name === "map") {
      const res = t.anyref();
      t.slot(resSlot);
      t.unboxArr(res);
      t.boxArr(res);
    } else if (name === "each") {
      t.pushRef(em.lay.unitRef);
    } else {
      // flatmap: total = Σ per-element lengths; allocate; copy; box.
      const tmp = t.anyref(), total = t.i32();
      t.slot(resSlot);
      t.unboxArr(tmp);
      tb.i32Const(0);
      tb.localSet(total);
      collectLen(t, tmp, n, total);
      const res = t.allocArrBlk(total);
      collectCopy(t, tmp, res, n);
      t.boxArr(res);
    }
    tb.localSet(v);
    emitDispatch(em, t, v, 2); // k = this thunk's k param
    tb.u8(w.RETURN); // only the k=0 branch reaches here, with the value
    tb.u8(w.ELSE);
    // Iteration: elem = xs[i]; the callback's RET cell lands in iterLand
    // (landA) over this thunk's frame, with next = this thunk's k.
    t.slot(0);
    tb.localSet(fc);
    const elem = t.anyref();
    t.elemAddr(xb, iL);
    tb.arrayGet(1);
    tb.localSet(elem);
    emitCallClosure(em, t, fc, name === "map" ? 1 : 2, (k, ffp) => {
      // Suspension-safe as-is: elem/iL are locals set before the call, and
      // fBox cannot suspend, so no operand spans a suspension point.
      tb.localGet(ffp); tb.refCast(4, true); tb.structGet(4, 1);
      tb.i32Const(k);
      if (k === 0) tb.localGet(elem);
      else {
        tb.localGet(iL);
        tb.u8(w.CONV_I32);
        tb.callFn(em.ix.fBox);
      }
      tb.arraySet();
    }, {land: true, kL: 2, landA: iterLand.idx});
    tb.u8(w.UNREACHABLE); // the callback always tails into iterLand
    tb.u8(w.END);
    tb.u8(w.UNREACHABLE); // both if arms diverge; keep the implicit end typed
  }
  // Entry (this builtin Fn): allocate the result array, init the counter,
  // tail-call the loop entry.
  const xb = f.anyref(), n = f.i32();
  f.slot(1);
  f.unboxArr(xb);
  b.localGet(xb);
  b.refCast(1, true);
  b.arrayLen();
  b.localSet(n);
  if (resSlot >= 0) {
    const res = f.allocArrBlk(n);
    b.localGet(0); b.structGet(4, 1);
    b.i32Const(resSlot);
    f.boxArr(res); // the slot holds the $ARR wrapper (iterLand + the
                         // done path read it back as a wrapper)
    b.arraySet();
  }
  b.localGet(0); b.structGet(4, 1);
  b.i32Const(iSlot);
  b.i32Const(0);
  b.u8(w.CONV_I32);
  b.callFn(em.ix.fBox);
  b.arraySet();
  b.localGet(0);
  f.pushRef(em.lay.unitRef);
  b.localGet(1);
  b.u8(w.RETURN_CALL);
  b.lebU(loopEntry.idx);
}

export function emitMain(em: Emit, f: Fn): void {
  const b = f.body;
  // The global frame is allocated by run() (the frame param is local 0).
  const exprs = em.prog.items.filter((it): it is {e: ExprID} => "e" in it);
  const v = f.anyref();
  if (exprs.length === 0) {
    f.pushRef(em.lay.unitRef);
    b.localSet(v);
  } else {
    // Same split protocol as bodyCatch: a perform/handle at the top level
    // ends the inline body; its fragment re-emits the remaining items.
    const savedCut = em.sp.cutStack;
    const roots = exprs.map(it => it.e);
    em.sp.bodyRoots.push({stmts: roots, sc: em.d.globalScope, tail: false, savedCut: [...savedCut]});
    try {
      try {
        for (let k = 0; k < exprs.length; k++) {
          const r = expr(em, exprs[k].e, f, em.d.globalScope);
          if (k < exprs.length - 1) { /* dropped: nothing on the stack */ }
          else { f.pushRef(r); b.localSet(v); }
        }
      } catch (sp) {
        em.sp.cutStack = savedCut;
        if (!(sp instanceof Split)) throw sp;
        fillRest(em, sp, roots, em.d.globalScope, false);
        return; // the body ends at the split site (both paths tail-call)
      }
      em.sp.cutStack = savedCut;
    } finally {
      em.sp.bodyRoots.pop();
    }
  }
  // run() calls main with k = ref.null $K, so dispatch(null, v) returns
  // the top-level value.
  emitDispatch(em, f, v);
}

// run (allocates the global frame, calls main with k = null) and the
// 12 host accessors (§4 — JS cannot read GC fields directly). Appended
// after main; indices computed here.
export function emitInits(em: Emit): void {
  const mainIdx = em.o.liveImports.length + em.funcs.length - 1; // main is last
  em.ix.funcRefTypes.set(mainIdx, w.T_KABI); // main's funcref slot (after thunks)
  const run = new Fn(0, em);
  run.typeIdx = w.T_RUN;
  run.idx = mainIdx + 1;
  em.ix.funcRefTypes.set(run.idx, w.T_RUN);
  {
    const b = run.body;
    b.refNull(4); // global frame parent = null
    b.i32Const(frameSizeOf(em.ix, em.d.globalScope));
    b.arrayNew(1);
    b.structNew(4);
    b.refNull(5); // k = null: main's dispatch returns its value
    b.u8(w.CALL);
    b.lebU(mainIdx);
  }
  em.funcs.push(run);
  const acc = (params: number, typeIdx: number, emit: (b: Buf, f: Fn) => void): Fn => {
    const f = new Fn(params, em);
    f.typeIdx = typeIdx;
    f.idx = em.o.liveImports.length + em.funcs.length;
    em.ix.funcRefTypes.set(f.idx, typeIdx);
    emit(f.body, f);
    em.funcs.push(f);
    return f;
  };
  // __tag(v) -> i32: 0 unit (null) 1 $F64 2 bool 3 str 4 arr 5 clo,
  // 6..10 = $I32/$U32/$I64/$U64/$F32 (tag = box shape − 1 for the appended
  // per-width number shapes 7..11).
  acc(1, 14, (b) => {
    b.localIsNull(0);
    b.if(0x7f);
    b.i32Const(0);
    b.u8(w.ELSE);
    const tag = (ht: number, t: number) => {
      b.localGet(0);
      b.refTest(ht, false);
      b.if(0x7f);
      b.i32Const(t);
      b.u8(w.ELSE);
    };
    // Test box shapes in order: I31=2, $F64=1, $STR=3, $ARR=4, $CLO=5,
    // then the per-width number boxes $I32..$F32 = 6..10.
    const TAGS: [number, number][] = [
      [w.I31REF, 2], [0, 1], [2, 3], [3, 4], [6, 5],
      [7, 6], [8, 7], [9, 8], [10, 9], [11, 10],
    ];
    for (const [ht, t] of TAGS) tag(ht, t);
    b.u8(w.UNREACHABLE);
    for (let i = 0; i < 11; i++) b.u8(w.END); // close the if/else chain
  });
  // __num(v) -> f64: the full numeric-box ladder (the JS side reads any
  // width's box as a Number — $F32 promotes, the int boxes convert, $F64 is
  // the payload; a non-number still traps at the final cast). Same arms as
  // $num64 minus its $F64-identity fast arm (the payload read is the
  // default here).
  acc(1, 19, (b) => ladderBody(b, {ret: 0x7c, arms: NUM64_ARMS, defOps: []}));
  // __str_len(v) -> i32
  acc(1, 14, (b) => {
    b.localGet(0);
    b.refCast(2, false);
    b.arrayLen();
  });
  // __str_get(v, i) -> i32
  acc(2, 20, (b) => {
    b.localGet(0);
    b.refCast(2, false);
    b.localGet(1);
    b.arrayGet(2);
  });
  // __arr_len(v) -> i32
  acc(1, 14, (b) => {
    b.localGet(0);
    b.readBoxPayload(3);
    b.arrayLen();
  });
  // __arr_get(v, i) -> anyref
  acc(2, 22, (b) => {
    b.localGet(0);
    b.readBoxPayload(3);
    b.localGet(1);
    b.arrayGet(1);
  });
  // Box constructors/readers: __mk_num (the $F64 box), then __mk_f32/__f32,
  // __mk_i32/__mk_u32/__i32/__u32, __mk_i64/__mk_u64/__i64/__u64 (typed-widths
  // steps 2-4; the i64/u64 param is a JS BigInt through the standard wasm
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
  // __arr_new(n) -> anyref
  acc(1, 12, (b) => {
    b.localGet(0);
    b.arrayNew(1);
    b.structNew(3);
  });
  // __arr_set(v, i, x) -> ()
  acc(3, 23, (b) => {
    b.localGet(0);
    b.readBoxPayload(3);
    b.localGet(1);
    b.localGet(2);
    b.arraySet();
  });
}
