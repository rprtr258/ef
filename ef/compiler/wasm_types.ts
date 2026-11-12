import binaryen from "binaryen";

class WasmError extends Error {}
export {WasmError};

// WasmGC types: one rec group of 13 struct/array shapes. binaryen types
// are process-global interned ids, so they build once and are reused by every
// compiled module. HT[i] = bare heap type (the immediate GC instruction
// builders take); RF[i] = (ref null $i) (params, fields, ref.null);
// RN[i] = (ref $i) (non-null casts). $STR packs i16 over an i32 element type.
// Shapes 0–6 are the base plane ($F64 is the f64-backed number box); 7–11
// are the per-width number boxes; 12 is $TUP.
export const _T: {
  HT: binaryen.HeapType[],
  RF: binaryen.Type[],
  RN: binaryen.Type[],
} = (() => {
  const tb = new binaryen.TypeBuilder(21);
  tb.createRecGroup(0, 21);
  const fld = (ty: binaryen.Type, mutable: boolean) => ({type: ty, packedType: binaryen.notPacked, mutable});
  tb.setStructType(0, [fld(binaryen.f64, false)]);                       // 0 $F64 (f64 plane)
  tb.setArrayType(1, binaryen.anyref, binaryen.notPacked, true);         // 1 $ELEMS
  tb.setArrayType(2, binaryen.i32, binaryen.i16, true);                  // 2 $STR
  tb.setStructType(3, [                                                  // 3 $ARR — the slice
    // fat pointer {data, off, len}: immutable fields, views (sub) share the
    // backing; only the backing's elements mutate.
    fld(tb.getTempRefType(tb.getTempHeapType(1), true), false),
    fld(binaryen.i32, false),
    fld(binaryen.i32, false),
  ]);
  tb.setStructType(4, [                                                  // 4 $FRAME
    fld(tb.getTempRefType(tb.getTempHeapType(4), true), true),
    fld(tb.getTempRefType(tb.getTempHeapType(1), true), true),
  ]);
  tb.setStructType(5, [                                                  // 5 $K
    fld(binaryen.i31ref, true), fld(binaryen.anyref, true),
    fld(binaryen.anyref, true),
    fld(tb.getTempRefType(tb.getTempHeapType(5), true), true),
  ]);
  tb.setStructType(6, [                                                  // 6 $CLO
    fld(binaryen.i31ref, false),
    fld(tb.getTempRefType(tb.getTempHeapType(4), true), false),
    fld(binaryen.i31ref, false),
    // direct flag (i31 1/0): 1 = the entry has the direct ABI ((frame) ->
    // anyref); 0 = T_KABI (CPS closures, builtin trampolines, resume
    // binders). Call sites of unknown callee kind check this at runtime —
    // static type knowledge is only a hint, never a bypass (a pure-typed
    // slot can hold a resume binder or an any-smuggled closure).
    fld(binaryen.i31ref, false),
  ]);
  tb.setStructType(7, [fld(binaryen.i32, false)]);                       // 7 $I32
  tb.setStructType(8, [fld(binaryen.i32, false)]);                       // 8 $U32
  tb.setStructType(9, [fld(binaryen.i64, false)]);                       // 9 $I64
  tb.setStructType(10, [fld(binaryen.i64, false)]);                      // 10 $U64
  tb.setStructType(11, [fld(binaryen.f32, false)]);                      // 11 $F32
  tb.setStructType(12, [fld(tb.getTempRefType(tb.getTempHeapType(1), true), false)]); // 12 $TUP
  tb.setStructType(13, [
    fld(tb.getTempRefType(tb.getTempHeapType(4), true), true),
    fld(tb.getTempRefType(tb.getTempHeapType(17), true), true),
  ]);
  tb.setStructType(14, [
    fld(tb.getTempRefType(tb.getTempHeapType(4), true), true),
    fld(tb.getTempRefType(tb.getTempHeapType(18), true), true),
  ]);
  tb.setStructType(15, [
    fld(tb.getTempRefType(tb.getTempHeapType(4), true), true),
    fld(tb.getTempRefType(tb.getTempHeapType(19), true), true),
  ]);
  tb.setStructType(16, [
    fld(tb.getTempRefType(tb.getTempHeapType(4), true), true),
    fld(tb.getTempRefType(tb.getTempHeapType(20), true), true),
  ]);
  tb.setArrayType(17, binaryen.i32, binaryen.notPacked, true);
  tb.setArrayType(18, binaryen.i64, binaryen.notPacked, true);
  tb.setArrayType(19, binaryen.f32, binaryen.notPacked, true);
  tb.setArrayType(20, binaryen.f64, binaryen.notPacked, true);
  const HT = tb.buildAndDispose();
  return {
    HT,
    RF: HT.map(h => binaryen.getTypeFromHeapType(h, true)),
    RN: HT.map(h => binaryen.getTypeFromHeapType(h, false)),
  };
})();

// One operand-stack value reference the emitters pass around: a
// materializable anyref source consumed at its use site.
export type ValueRef =
  | {k: "g", gi: number}   // static anyref global
  | {k: "bool", v: 0 | 1}  // i31 bool
  | {k: "local", l: number}   // anyref local (single-use)
  | {k: "slot", i: number};    // frame slot i of local 0's frame

// Initializer descriptor of one static global: the data buildModule
// turns into a GC constant expression. Statics are immutable, so
// instantiation itself builds the value — no runtime fill.
export type StaticDesc =
  | {t: "null"}                       // unit
  | {t: "i31", v: number}             // true/false
  | {t: "num", w: string, v: number, big?: bigint} // number box: w = the
                                      // value's width (per-width const form;
                                      // big carries the exact lexeme for
                                      // i64/u64, which exceed f64 precision)
  | {t: "str", s: string}             // $STR code-unit array
  | {t: "clo", fni: number, fsize: number, direct?: 1} // builtin $CLO (direct
                                      // is unset: builtin trampolines are T_KABI)
  | {t: "elems", ws: number[]}        // handler case table ($ELEMS i31s)
  | {t: "kret", fni: number};         // terminal K_RET cell {0, fni, null, null}
