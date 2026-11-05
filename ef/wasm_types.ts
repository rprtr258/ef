import binaryen from "binaryen";
import {type ExprID} from "./parser.ts";

export type Scope = {
  frame: {slots: number}, // frame identity: changes only at lambda boundaries
  parent: Scope | null,
  map: Map<string, number>,
};

export class WasmError extends Error {}

// WasmGC types (§1): one rec group of 7 struct/array shapes. binaryen types
// are process-global interned ids, so they build once and are reused by every
// compiled module. HT[i] = bare heap type (the immediate GC instruction
// builders take); RF[i] = (ref null $i) (params, fields, ref.null);
// RN[i] = (ref $i) (non-null casts). $STR packs i16 over an i32 element type.
export const _T: {
  HT: binaryen.HeapType[],
  RF: binaryen.Type[],
  RN: binaryen.Type[],
} = (() => {
  const tb = new binaryen.TypeBuilder(7);
  tb.createRecGroup(0, 7);
  const fld = (ty: binaryen.Type, mutable: boolean) => ({type: ty, packedType: binaryen.notPacked, mutable});
  tb.setStructType(0, [fld(binaryen.f64, false)]);                       // 0 $NUM
  tb.setArrayType(1, binaryen.anyref, binaryen.notPacked, true);         // 1 $ELEMS
  tb.setArrayType(2, binaryen.i32, binaryen.i16, true);                  // 2 $STR
  tb.setStructType(3, [fld(tb.getTempRefType(tb.getTempHeapType(1), true), true)]); // 3 $ARR
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
  ]);
  const HT = tb.buildAndDispose();
  return {
    HT,
    RF: HT.map(h => binaryen.getTypeFromHeapType(h, true)),
    RN: HT.map(h => binaryen.getTypeFromHeapType(h, false)),
  };
})();

// Emission context: which local holds the ambient continuation cell (1 = a
// T_KABI function's k param, 2 = a rest-of-site fragment's kNext param, any
// other local = a handle's K_HDL cell), plus the not-yet-executed cut path
// when re-emitting a fragment: cut[0] is the child of the current node on
// the path to the split site; an empty array marks the split site itself
// (its value is the fragment's v param). `snap` is the wasm local holding
// the fragment's frozen frame-image pointer (the K_SPILL cell's a): pre-cut
// siblings reload from it instead of the live frame, matching the
// interpreter's frozen CPS accs under multi-shot resume.
export type Ctx = {
  kL: number,
  cut?: ExprID[],
  snap?: number,
};
export const INLINE: Ctx = {kL: 1};
