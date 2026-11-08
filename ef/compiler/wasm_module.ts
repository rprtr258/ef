// Module-level function emission of the wasm backend: builtin trampolines
// and host-import thunks (§7), main (§7.2) and the run/accessor init
// functions the host imports (§4). The §-numbered design doc for the whole
// backend lives at the top of wasm.ts.
import {type ExprID} from "./parser.ts";
import {BUILTINS} from "./analysis.ts";
import {WasmError} from "./wasm_types.ts";
import {Buf, Fn} from "./wasm_body.ts";
import {frameSizeOf} from "./wasm_pipeline.ts";
import {type Emit, Split, emitCallClosure, emitDispatch, emitFail, expr, fillRest, makeRestThunk, selectBool} from "./wasm_emit.ts";
import * as w from "./wasm_consts.ts";

export function emitBuiltins(em: Emit, builtin0: number): Fn[] {
  const out: Fn[] = [];
  for (const {name} of BUILTINS) {
    if (!em.o.usedBuiltins.has(name)) continue;
    const f = new Fn(2, em); // (frame, k): builtins are T_KABI trampolines
    f.typeIdx = w.T_KABI;
    f.idx = builtin0 + out.length; // matches the push order (usedBuiltins filter)
    em.ix.funcRefTypes.set(f.idx, w.T_KABI);
    const b = f.body;
    const box = () => {
      b.u8(w.CALL);
      b.lebU(em.ix.fBox);
    };
    switch (name) {
      case "+": {
        const a = f.anyref(), bv = f.anyref();
        f.slot(0);
        b.localSet(a);
        f.slot(1);
        b.localSet(bv);
        b.localGet(a);
        b.refTest(0, false);
        b.localGet(bv);
        b.refTest(0, false);
        b.u8(w.AND);
        b.u8(w.IF);
        b.u8(0x6e); // result anyref
        b.localGet(a);
        b.refCast(0, false);
        b.structGet(0, 0);
        b.localGet(bv);
        b.refCast(0, false);
        b.structGet(0, 0);
        b.u8(w.FADD);
        box();
        b.u8(w.ELSE);
        b.localGet(a);
        b.refTest(2, false);
        b.localGet(bv);
        b.refTest(2, false);
        b.u8(w.AND);
        b.u8(w.IF);
        b.u8(0x6e);
        f.emitStrCat(a, bv);
        b.u8(w.ELSE);
        b.refNull(w.ANYREF);
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
          // $F32 arm, then $I32/$U32 arms (same bit ops, unsigned compares);
          // anything else falls to the f64 plane below.
          b.localGet(a);
          b.refTest(11, false);
          b.localGet(bv);
          b.refTest(11, false);
          b.u8(w.AND);
          b.u8(w.IF);
          b.u8(0x6e);
          const fx = f.f32(), fy = f.f32();
          b.localGet(a);
          b.refCast(11, false);
          b.structGet(11, 0);
          b.localSet(fx);
          b.localGet(bv);
          b.refCast(11, false);
          b.structGet(11, 0);
          b.localSet(fy);
          if (name === "%") {
            // JS fmod: a - b * trunc(a/b)
            const ft = f.f32();
            b.localGet(fx);
            b.localGet(fy);
            b.u8(w.F32_DIV);
            b.u8(w.F32_TRUNC);
            b.localSet(ft);
            b.localGet(fx);
            b.localGet(fy);
            b.localGet(ft);
            b.u8(w.F32_MUL);
            b.u8(w.F32_SUB);
          } else {
            b.localGet(fx);
            b.localGet(fy);
            b.u8(name === "-" ? w.F32_SUB : name === "*" ? w.F32_MUL : name === "<" ? w.F32_LT : name === ">" ? w.F32_GT : name === "<=" ? w.F32_LE : w.F32_GE);
          }
          if (name === "<" || name === ">" || name === "<=" || name === ">=") {
            // i32 bool on the stack → i31 bool anyref
            selectBool(em, f, () => {});
          } else {
            b.structNew(11);
          }
          b.u8(w.ELSE);
          b.localGet(a);
          b.refTest(7, false);
          b.localGet(bv);
          b.refTest(7, false);
          b.u8(w.AND);
          b.u8(w.IF);
          b.u8(0x6e);
          const ix32 = f.i32(), iy32 = f.i32();
          b.localGet(a);
          b.refCast(7, false);
          b.structGet(7, 0);
          b.localSet(ix32);
          b.localGet(bv);
          b.refCast(7, false);
          b.structGet(7, 0);
          b.localSet(iy32);
          if (name === "%") {
            const it = f.i32();
            b.localGet(ix32);
            b.localGet(iy32);
            b.u8(w.REMS);
            b.localSet(it);
            b.localGet(ix32);
            b.localGet(iy32);
            b.localGet(it);
            b.u8(w.MUL);
            b.u8(w.SUB);
          } else {
            b.localGet(ix32);
            b.localGet(iy32);
            b.u8(name === "-" ? w.SUB : name === "*" ? w.MUL : name === "<" ? w.LTS : name === ">" ? w.GTS : name === "<=" ? w.LES : w.GES);
          }
          if (name === "<" || name === ">" || name === "<=" || name === ">=") {
            selectBool(em, f, () => {});
          } else {
            b.structNew(7);
          }
          b.u8(w.ELSE);
          b.localGet(a);
          b.refTest(8, false);
          b.localGet(bv);
          b.refTest(8, false);
          b.u8(w.AND);
          b.u8(w.IF);
          b.u8(0x6e);
          const ux32 = f.i32(), uy32 = f.i32();
          b.localGet(a);
          b.refCast(8, false);
          b.structGet(8, 0);
          b.localSet(ux32);
          b.localGet(bv);
          b.refCast(8, false);
          b.structGet(8, 0);
          b.localSet(uy32);
          if (name === "%") {
            const ut = f.i32();
            b.localGet(ux32);
            b.localGet(uy32);
            b.u8(w.REMU);
            b.localSet(ut);
            b.localGet(ux32);
            b.localGet(uy32);
            b.localGet(ut);
            b.u8(w.MUL);
            b.u8(w.SUB);
          } else {
            b.localGet(ux32);
            b.localGet(uy32);
            b.u8(name === "-" ? w.SUB : name === "*" ? w.MUL : name === "<" ? w.LTU : name === ">" ? w.GTU : name === "<=" ? w.LEU : w.GEU);
          }
          if (name === "<" || name === ">" || name === "<=" || name === ">=") {
            selectBool(em, f, () => {});
          } else {
            b.structNew(8);
          }
          b.u8(w.ELSE);
        }
        if (name === "<" || name === ">" || name === "<=" || name === ">=") {
          const r = f.i32();
          {
            const x = f.slotF64(0), y = f.slotF64(1);
            const cmp = name === "<" ? w.FLT : name === ">" ? w.FGT : name === "<=" ? w.FLE : w.FGE;
            b.localGet(x);
            b.localGet(y);
            b.u8(cmp);
            b.localSet(r);
          }
          selectBool(em, f, () => {
            b.localGet(r);
          });
        } else {
          const x = f.slotF64(0), y = name === "neg" ? 0 : f.slotF64(1);
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
        b.u8(w.CALL);
        b.lebU(em.ix.fEq);
        break;
      }
      case "!=": {
        f.slot(0);
        f.slot(1);
        b.u8(w.CALL);
        b.lebU(em.ix.fEq);
        b.refCast(w.I31REF, false); // eq result's i31 bool payload
        b.i31Get();
        b.u8(w.EQZ); // 1 when $eq said false
        selectBool(em, f, () => {});
        break;
      }
      case "not": {
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.ix.fTruthy);
        b.u8(w.EQZ);
        selectBool(em, f, () => {});
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
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(blk);
        b.localGet(blk);
        b.refCast(1, true);
        b.arrayLen();
        b.u8(w.EQZ);
        b.u8(w.IF);
        b.u8(0x40);
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
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(blk);
        b.localGet(blk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(len);
        b.localGet(len);
        b.u8(w.EQZ);
        b.u8(w.IF);
        b.u8(0x7f);
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
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(aBlk);
        f.slot(1);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(bBlk);
        b.localGet(aBlk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(la);
        b.localGet(bBlk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(lb);
        b.localGet(la);
        b.localGet(lb);
        b.u8(w.ADD);
        b.localSet(n);
        const blk = f.allocArrBlk(n);
        f.loop(() => {
          b.localGet(la);
        }, i => {
          f.elemAddr(blk, i);
          f.elemAddr(aBlk, i);
          b.arrayGet(1);
          b.arraySet();
        });
        f.loop(() => {
          b.localGet(lb);
        }, i => {
          f.elemAddr(blk, i);
          b.localGet(la);
          b.u8(w.ADD);
          f.elemAddr(bBlk, i);
          b.arrayGet(1);
          b.arraySet();
        });
        f.boxArr(blk);
        break;
      }
      case "flat": {
        const xss = f.anyref(), n = f.i32(), total = f.i32();
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(xss);
        b.localGet(xss);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(n);
        b.i32Const(0);
        b.localSet(total);
        // JS Array.prototype.flat parity: non-array elements pass through
        // instead of being read as inner arrays (a resumed scalar flowing
        // back through a map-like land path lands exactly here).
        f.loop(() => {
          b.localGet(n);
        }, k => {
          const cell = f.anyref();
          f.elemAddr(xss, k);
          b.arrayGet(1);
          b.localSet(cell);
          b.localGet(cell);
          b.refTest(3, false); // is $ARR?
          b.u8(w.IF);
          b.u8(0x40);
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
        const blk = f.allocArrBlk(total);
        const ww = f.i32();
        b.i32Const(0);
        b.localSet(ww);
        f.loop(() => {
          b.localGet(n);
        }, k => {
          const cell = f.anyref(), xb = f.anyref(), xl = f.i32();
          f.elemAddr(xss, k);
          b.arrayGet(1);
          b.localSet(cell);
          b.localGet(cell);
          b.refTest(3, false);
          b.u8(w.IF);
          b.u8(0x40);
          b.localGet(cell);
          b.refCast(3, true);
          b.structGet(3, 0);
          b.localSet(xb);
          b.localGet(xb);
          b.refCast(1, true);
          b.arrayLen();
          b.localSet(xl);
          f.loop(() => {
            b.localGet(xl);
          }, j => {
            f.elemAddr(blk, ww);
            f.elemAddr(xb, j);
            b.arrayGet(1);
            b.arraySet();
            b.localGet(ww);
            b.i32Const(1);
            b.u8(w.ADD);
            b.localSet(ww);
          });
          b.u8(w.ELSE);
          f.elemAddr(blk, ww);
          b.localGet(cell);
          b.arraySet();
          b.localGet(ww);
          b.i32Const(1);
          b.u8(w.ADD);
          b.localSet(ww);
          b.u8(w.END);
        });
        f.boxArr(blk);
        break;
      }
      case "len": {
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.refCast(1, true);
        b.arrayLen();
        b.u8(w.CONV_I32);
        box();
        break;
      }
      case "strlen": {
        f.slot(0);
        b.refCast(2, true);
        b.arrayLen();
        b.u8(w.CONV_I32);
        box();
        break;
      }
      case "PI":
        b.globalGet(em.lay.piG);
        break;
      case "cos":
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_cos")!);
        break;
      case "sin":
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_sin")!);
        break;
      case "sqrt": {
        const x = f.f64();
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.ix.fNum64); // adaptive: an $F32 box promotes
        b.localSet(x);
        b.localGet(x);
        b.u8(w.FSQRT);
        box();
        break;
      }
      case "abs": {
        const x = f.f64();
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.ix.fNum64);
        b.localSet(x);
        b.localGet(x);
        b.u8(w.FABS);
        box();
        break;
      }
      case "round": {
        const x = f.slotF64(0);
        b.localGet(x);
        b.f64Const(0.5);
        b.u8(w.FADD);
        b.u8(w.FFLOOR);
        box();
        break;
      }
      case "range": {
        const s = f.slotF64(0), e = f.slotF64(1), stepv = f.slotF64(2);
        const n = f.i32();
        b.localGet(stepv);
        b.f64Const(0);
        b.u8(w.FEQ);
        b.u8(w.IF);
        b.u8(0x7f);
        b.i32Const(0);
        b.u8(w.ELSE);
        b.localGet(e);
        b.localGet(s);
        b.u8(w.FSUB);
        b.localGet(stepv);
        b.u8(w.FDIV);
        b.u8(w.FCEIL);
        b.f64Const(0);
        b.u8(w.FGT);
        b.u8(w.IF);
        b.u8(0x7f);
        b.localGet(e);
        b.localGet(s);
        b.u8(w.FSUB);
        b.localGet(stepv);
        b.u8(w.FDIV);
        b.u8(w.FCEIL);
        b.u8(w.TRUNC_F64);
        b.u8(w.ELSE);
        b.i32Const(0);
        b.u8(w.END);
        b.u8(w.END);
        b.localSet(n);
        const blk = f.allocArrBlk(n);
        f.loop(() => {
          b.localGet(n);
        }, k => {
          f.elemAddr(blk, k);
          b.localGet(s);
          b.localGet(k);
          b.u8(w.CONV_I32);
          b.localGet(stepv);
          b.u8(w.FMUL);
          b.u8(w.FADD);
          box();
          b.arraySet();
        });
        f.boxArr(blk);
        break;
      }
      case "char":
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_char")!);
        break;
      case "number":
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_number")!);
        break;
      case "args":
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_args")!);
        break;
      case "get": {
        const blk = f.anyref(), len = f.i32(), idx = f.i32();
        const idxF = f.slotF64(1);
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(blk);
        b.localGet(blk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(len);
        b.localGet(idxF);
        b.u8(w.TRUNC_F64);
        b.localSet(idx);
        b.localGet(idx);
        b.i32Const(0);
        b.u8(w.LTS); // idx < 0
        b.localGet(idx);
        b.localGet(len);
        b.u8(w.GEU); // idx >= len
        b.u8(w.OR);
        b.u8(w.IF);
        b.u8(0x40);
        emitFail(em, f, 1, null, () => {
          b.localGet(idxF);
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
        const idxF = f.slotF64(1);
        f.slot(0);
        b.localSet(xs);
        b.localGet(xs);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(blk);
        b.localGet(blk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(len);
        b.localGet(idxF);
        b.u8(w.TRUNC_F64);
        b.localSet(idx);
        f.slot(2);
        b.localSet(v);
        b.localGet(idx);
        b.localGet(len);
        b.u8(w.LTU); // idx < len → in-place
        b.u8(w.IF);
        b.u8(0x40);
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
          b.u8(w.IF);
          b.u8(0x6e); // result anyref
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
export function emitMapLike(em: Emit, f: Fn, name: string): void {
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
      tb.refCast(3, true);
      tb.structGet(3, 0);
      tb.localSet(blk);
      t.slot(iSlot);
      tb.refCast(0, false);
      tb.structGet(0, 0);
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
    tb.refCast(0, false);
    tb.structGet(0, 0);
    tb.f64Const(1);
    tb.u8(w.FADD);
    tb.u8(w.CALL);
    tb.lebU(em.ix.fBox);
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
    tb.refCast(3, true);
    tb.structGet(3, 0);
    tb.localSet(xb);
    tb.localGet(xb);
    tb.refCast(1, true);
    tb.arrayLen();
    tb.localSet(n);
    t.slot(iSlot);
    tb.refCast(0, false);
    tb.structGet(0, 0);
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
      tb.refCast(3, true);
      tb.structGet(3, 0);
      tb.localSet(res);
      t.boxArr(res);
    } else if (name === "each") {
      t.pushRef(em.lay.unitRef);
    } else {
      // flatmap: total = Σ per-element lengths; allocate; copy; box.
      const tmp = t.anyref(), total = t.i32();
      t.slot(resSlot);
      tb.refCast(3, true);
      tb.structGet(3, 0);
      tb.localSet(tmp);
      tb.i32Const(0);
      tb.localSet(total);
      t.loop(() => {
        tb.localGet(n);
      }, i => {
        // total += len of callback result i: elem → its backing array →
        // len (scalar elements count as 1 — the tag test, not the value).
        const cell = t.anyref();
        t.elemAddr(tmp, i);
        tb.arrayGet(1);
        tb.localSet(cell);
        tb.localGet(cell);
        tb.refTest(3, false);
        tb.u8(w.IF);
        tb.u8(0x40);
        tb.localGet(cell);
        tb.refCast(3, true);
        tb.structGet(3, 0);
        tb.refCast(1, true);
        tb.arrayLen();
        tb.localGet(total);
        tb.u8(w.ADD);
        tb.localSet(total);
        tb.u8(w.ELSE);
        tb.localGet(total);
        tb.i32Const(1);
        tb.u8(w.ADD);
        tb.localSet(total);
        tb.u8(w.END);
      });
      const res = t.allocArrBlk(total);
      const ww = t.i32();
      tb.i32Const(0);
      tb.localSet(ww);
      t.loop(() => {
        tb.localGet(n);
      }, i => {
        const xb2 = t.anyref(), xl = t.i32();
        const cell = t.anyref();
        t.elemAddr(tmp, i);
        tb.arrayGet(1);
        tb.localSet(cell);
        tb.localGet(cell);
        tb.refTest(3, false);
        tb.u8(w.IF);
        tb.u8(0x40);
        tb.localGet(cell);
        tb.refCast(3, true);
        tb.structGet(3, 0);
        tb.localSet(xb2);
        tb.localGet(xb2);
        tb.refCast(1, true);
        tb.arrayLen();
        tb.localSet(xl);
        t.loop(() => {
          tb.localGet(xl);
        }, j => {
          // dst = res[w], src = xb2[j] (element values, same layout the
          // box/collect path reads back).
          t.elemAddr(res, ww);
          t.elemAddr(xb2, j);
          tb.arrayGet(1);
          tb.arraySet();
          tb.localGet(ww);
          tb.i32Const(1);
          tb.u8(w.ADD);
          tb.localSet(ww);
        });
        tb.u8(w.ELSE);
        t.elemAddr(res, ww);
        tb.localGet(cell);
        tb.arraySet();
        tb.localGet(ww);
        tb.i32Const(1);
        tb.u8(w.ADD);
        tb.localSet(ww);
        tb.u8(w.END);
      });
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
        tb.u8(w.CALL);
        tb.lebU(em.ix.fBox);
      }
      tb.arraySet();
    }, false, true, 2, true, iterLand.idx);
    tb.u8(w.UNREACHABLE); // the callback always tails into iterLand
    tb.u8(w.END);
    tb.u8(w.UNREACHABLE); // both if arms diverge; keep the implicit end typed
  }
  // Entry (this builtin Fn): allocate the result array, init the counter,
  // tail-call the loop entry.
  const xb = f.anyref(), n = f.i32();
  f.slot(1);
  b.refCast(3, true);
  b.structGet(3, 0);
  b.localSet(xb);
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
  b.u8(w.CALL);
  b.lebU(em.ix.fBox);
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
    b.localGet(0);
    b.u8(0xd1);
    b.u8(w.IF);
    b.u8(0x7f);
    b.i32Const(0);
    b.u8(w.ELSE);
    const tag = (ht: number, t: number) => {
      b.localGet(0);
      b.refTest(ht, false);
      b.u8(w.IF);
      b.u8(0x7f);
      b.i32Const(t);
      b.u8(w.ELSE);
    };
    tag(w.I31REF, 2);
    tag(0, 1); // $F64
    tag(2, 3); // $STR
    tag(3, 4); // $ARR
    b.localGet(0);
    b.refTest(6, false); // $CLO
    b.u8(w.IF);
    b.u8(0x7f);
    b.i32Const(5);
    b.u8(w.ELSE);
    const tagNum = (ht: number, t: number) => {
      b.localGet(0);
      b.refTest(ht, false);
      b.u8(w.IF);
      b.u8(0x7f);
      b.i32Const(t);
      b.u8(w.ELSE);
    };
    tagNum(7, 6); // $I32
    tagNum(8, 7); // $U32
    tagNum(9, 8); // $I64
    tagNum(10, 9); // $U64
    tagNum(11, 10); // $F32
    b.u8(w.UNREACHABLE);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
  });
  // __num(v) -> f64
  acc(1, 19, (b) => {
    b.localGet(0);
    b.refCast(0, false);
    b.structGet(0, 0);
  });
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
    b.refCast(3, false);
    b.structGet(3, 0);
    b.arrayLen();
  });
  // __arr_get(v, i) -> anyref
  acc(2, 22, (b) => {
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 0);
    b.localGet(1);
    b.arrayGet(1);
  });
  // __mk_num(x) -> anyref
  acc(1, 13, (b) => {
    b.localGet(0);
    b.structNew(0);
  });
  // __mk_f32(x: f32) -> anyref (typed-widths step 2)
  acc(1, w.T_MKF32, (b) => {
    b.localGet(0);
    b.structNew(11);
  });
  // __f32(v) -> f32: $F32 payload (typed-widths step 2)
  acc(1, w.T_F32, (b) => {
    b.localGet(0);
    b.refCast(11, false);
    b.structGet(11, 0);
  });
  // __mk_i32/__mk_u32(x: i32) -> anyref (typed-widths step 3)
  acc(1, w.T_MKI32, (b) => {
    b.localGet(0);
    b.structNew(7);
  });
  acc(1, w.T_MKI32, (b) => {
    b.localGet(0);
    b.structNew(8);
  });
  // __i32/__u32(v) -> i32: the box payload raw (two's complement bits; the
  // HOST masks __u32 with >>> 0)
  acc(1, w.T_GETI32, (b) => {
    b.localGet(0);
    b.refCast(7, false);
    b.structGet(7, 0);
  });
  acc(1, w.T_GETI32, (b) => {
    b.localGet(0);
    b.refCast(8, false);
    b.structGet(8, 0);
  });
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
    b.refCast(3, false);
    b.structGet(3, 0);
    b.localGet(1);
    b.localGet(2);
    b.arraySet();
  });
}
