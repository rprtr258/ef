import binaryen from "binaryen";
import {type ExprID} from "./parser.ts";

export type Scope = {
  frame: {slots: number}, // frame identity: changes only at lambda boundaries
  parent: Scope | null,
  map: Map<string, number>,
};

export class WasmError extends Error {}

// WasmGC types (§1): one rec group of 12 struct/array shapes. binaryen types
// are process-global interned ids, so they build once and are reused by every
// compiled module. HT[i] = bare heap type (the immediate GC instruction
// builders take); RF[i] = (ref null $i) (params, fields, ref.null);
// RN[i] = (ref $i) (non-null casts). $STR packs i16 over an i32 element type.
// Shapes 0–6 are the original plane ($F64 was "$NUM" — one f64-backed number
// box); 7–11 are the per-width number boxes appended by the typed-widths plan
// (append-only: existing indices 0–6 untouched).
export const _T: {
  HT: binaryen.HeapType[],
  RF: binaryen.Type[],
  RN: binaryen.Type[],
} = (() => {
  const tb = new binaryen.TypeBuilder(12);
  tb.createRecGroup(0, 12);
  const fld = (ty: binaryen.Type, mutable: boolean) => ({type: ty, packedType: binaryen.notPacked, mutable});
  tb.setStructType(0, [fld(binaryen.f64, false)]);                       // 0 $F64 (f64 plane)
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
  tb.setStructType(7, [fld(binaryen.i32, false)]);                       // 7 $I32
  tb.setStructType(8, [fld(binaryen.i32, false)]);                       // 8 $U32
  tb.setStructType(9, [fld(binaryen.i64, false)]);                       // 9 $I64
  tb.setStructType(10, [fld(binaryen.i64, false)]);                      // 10 $U64
  tb.setStructType(11, [fld(binaryen.f32, false)]);                      // 11 $F32
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

// One operand-stack value reference the emitters pass around (§3): a
// materializable anyref source consumed at its use site.
export type ValueRef =
  | {k: "g", gi: number}   // static anyref global (§5)
  | {k: "bool", v: 0 | 1}  // i31 bool
  | {k: "local", l: number}   // anyref local (single-use)
  | {k: "slot", i: number}    // frame slot i of local 0's frame
  | {k: "snapSlot", snap: number, i: number}; // frozen-frame slot (fragment re-emission)

// Initializer descriptor of one static global (§5): the data buildModule
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
  | {t: "clo", fni: number, fsize: number} // builtin $CLO
  | {t: "elems", ws: number[]};       // handler case table ($ELEMS i31s)
