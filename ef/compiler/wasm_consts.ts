import binaryen from "binaryen";
import {_T, WasmError} from "./wasm_types.ts";

// --- opcodes ---------------------------------------------------------------

// i32 arithmetic/comparison
export const ADD = 0x6a, SUB = 0x6b, MUL = 0x6c;
export const DIVS = 0x6d, DIVU = 0x6e, REMS = 0x6f, REMU = 0x70;
export const EQZ = 0x45, EQ = 0x46, LTS = 0x48, LTU = 0x49, OR = 0x72, AND = 0x71;
export const GTS = 0x4a, GTU = 0x4b, LES = 0x4c, LEU = 0x4d, GES = 0x4e, GEU = 0x4f;
// f64 arithmetic/comparison
export const FABS = 0x99, FNEG = 0x9a, FCEIL = 0x9b, FFLOOR = 0x9c, FTRUNC = 0x9d, FSQRT = 0x9f;
export const FADD = 0xa0, FSUB = 0xa1, FMUL = 0xa2, FDIV = 0xa3;
export const FLT = 0x63, FGT = 0x64, FLE = 0x65, FGE = 0x66, FEQ = 0x61;
// f32 arithmetic/comparison
export const F32_ABS = 0x8b, F32_NEG = 0x8c, F32_TRUNC = 0x8f, F32_SQRT = 0x91;
export const F32_ADD = 0x92, F32_SUB = 0x93, F32_MUL = 0x94, F32_DIV = 0x95;
export const F32_EQ = 0x5b, F32_LT = 0x5d, F32_GT = 0x5e, F32_LE = 0x5f, F32_GE = 0x60;
export const TRUNC_F64 = 0xaa, TRUNC_F64_U = 0xab, CONV_I32 = 0xb7, CONV_I32_U = 0xb8; // i32.trunc_f64_s/u, f64.convert_i32_s/u
export const CONV_F32_I32 = 0xb2, CONV_F32_U32 = 0xb3; // f32.convert_i32_s/u
export const CONV_F32_I64 = 0xb4, CONV_F32_U64 = 0xb5; // f32.convert_i64_s/u
export const CONV_F64_I64 = 0xb9, CONV_F64_U64 = 0xba; // f64.convert_i64_s/u
export const I64_TRUNC_F64 = 0xb0, I32_WRAP_I64 = 0xa7; // i64.trunc_f64_s, i32.wrap_i64 — the $F64-plane -> i32 adaptive unbox
// i64 family: arithmetic, signed/unsigned compares.
export const I64_ADD = 0x7c, I64_SUB = 0x7d, I64_MUL = 0x7e, I64_DIVS = 0x7f, I64_DIVU = 0x80,
  I64_REMS = 0x81, I64_REMU = 0x82, I64_EQ = 0x51, I64_LTS = 0x53, I64_LTU = 0x54, I64_GTS = 0x55,
  I64_GTU = 0x56, I64_LES = 0x57, I64_LEU = 0x58, I64_GES = 0x59, I64_GEU = 0x5a;
export const I64_NE = 0x52, I64_XOR = 0x85; // i64.ne, i64.xor
export const I64_EXTEND_I32_S = 0xac, I64_EXTEND_I32_U = 0xad, I64_EQZ = 0x50; // pinned @as int conversions
export const F32_DEMOTE = 0xb6, F64_PROMOTE = 0xbb; // f32.demote_f64, f64.promote_f32 —
// the explicit f64 <-> f32 conversions (@as and the operand-width adaptation
// in $numf64/$f32of); no implicit per-node round-trip exists anymore.


// --- WasmGC substrate -------------------------------------------------------

// Abstract heap types are single valtype bytes, never passed through the sleb
// writer; a concrete (ref null $t) would be 0x63 <sleb $t> (not needed yet).
export const ANYREF = 0x6e, EQREF = 0x6d, I31REF = 0x6c;

// --- module-level constants -------------------------------------------------


// k-cell kinds (i31 in the $K.kind field). K_RET: a = i31 thunk funcref
// index, b = the frame the thunk runs over. K_HDL: a = $ELEMS case table of
// flat [opid, fnIdx, fsize, nparams] i31 quadruples (the Return case is
// opid -1), b = the handler frame (hframe).
export const K_RET = 0, K_HDL = 1;

// Type section indices — assemble() emits exactly this order: structs/
// arrays 0..11 ($F64, $ELEMS, $STR, $ARR, $FRAME, $K, $CLO, $I32, $U32,
// $I64, $U64, $F32), then func types 7..25. Shared shapes dedupe by
// position: 7 () -> anyref (run + ef_args), 8 () -> (), 9 (i32, anyref) ->
// anyref (ef_perform), 10 (i32, anyref, f64, f64) -> () (ef_fail), 11
// (anyref) -> anyref (ef_char/number/cos/sin), 12 (i32) -> anyref
// (__mk_bool/__str_new/__arr_new), 13 (f64) -> anyref (fBox/__mk_num), 14
// (anyref) -> i32 (fTruthy/__tag/__str_len/__arr_len), 15 (anyref, anyref)
// -> anyref (fEq), 16 ((ref null $K), (ref null $K)) -> (ref null $K)
// (fCapture), 17 T_KABI ((ref null $FRAME), (ref null $K)) -> anyref, 18
// T_III_I ((ref null $FRAME), anyref, (ref null $K)) -> anyref; 19..25 are
// accessor/helper shapes named in assemble() (24/25: __mk_f32,
// __f32/fF32of).
export const T_RUN = 7, T_PERFORM = 9, T_FAIL = 10, T_STRNUM = 11,
  T_BOX = 13, T_TRUTHY = 14, T_EQ = 15, T_CAPTURE = 16, T_KABI = 17,
  T_III_I = 18, T_MKF32 = 24, T_F32 = 25, T_MKI32 = 26, T_GETI32 = 27,
  T_MKI64 = 28, T_GETI64 = 29;
// Direct ABI (selective CPS): ((ref null $FRAME)) -> anyref — direct
// functions take their activation frame (params + body binds over the
// captured env) and RETURN the boxed result; no continuation operand.
export const T_DABI = 30;
// Operator-value application: (i32 op id, anyref, anyref) -> anyref — the
// host import applies the interpreter's own operator closure (env.ts OPS).
export const T_BINOP = 31;
// Numeric direct-ABI signature base: ((ref null $FRAME), w1..wn) -> wr with
// every operand a plain valtype. Indices are interned on demand by
// wasm_tables.ts's numSig; emitters and $CLO tag checks derive them only
// through that function, so same-shape signatures share one index.
export const T_DABI_NUM = 100;
export const T_TRACE = 34; // (i32) -> () — the EFTRACE runtime-trace import

export function impType(n: string): number {
  if (n === "ef_perform") return T_PERFORM;
  if (n === "ef_fail") return T_FAIL;
  if (n === "ef_args") return T_RUN;
  if (n === "ef_trace") return T_TRACE;
  if (n === "ef_binop") return T_BINOP;
  return T_STRNUM;
}

// Abstract heaptype bytes the emitters use (0x6c i31ref / 0x6d eqref /
// 0x6e anyref) plus type indices 0..6 — mapped to (bare heap type, nullable
// type). The d.ts's heap-type constants (binaryen.any/i31/eq) are undefined
// in this build, so abstract heap types derive from the nullable type
// constants via getHeapType. Concrete-type non-null forms share the bare
// heap type id, so both spellings of a cast target collapse onto HT[i].
export function heapTypes(ht: number): {h: binaryen.HeapType, n: binaryen.Type} {
  if (ht === ANYREF) return {h: binaryen.getHeapType(binaryen.anyref), n: binaryen.anyref};
  if (ht === EQREF) return {h: binaryen.getHeapType(binaryen.eqref), n: binaryen.eqref};
  if (ht === I31REF) return {h: binaryen.getHeapType(binaryen.i31ref), n: binaryen.i31ref};
  if (ht >= 0 && ht <= 20) return {h: _T.HT[ht], n: _T.RF[ht]};
  throw new WasmError(`internal: bad heaptype byte ${ht}`);
}
