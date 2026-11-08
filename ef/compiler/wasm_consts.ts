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
// f32 arithmetic/comparison (typed-widths step 2)
export const F32_ABS = 0x8b, F32_NEG = 0x8c, F32_TRUNC = 0x8f, F32_SQRT = 0x91;
export const F32_ADD = 0x92, F32_SUB = 0x93, F32_MUL = 0x94, F32_DIV = 0x95;
export const F32_EQ = 0x5b, F32_NE = 0x5c, F32_LT = 0x5d, F32_GT = 0x5e, F32_LE = 0x5f, F32_GE = 0x60;
export const TRUNC_F64 = 0xaa, TRUNC_F64_U = 0xab, CONV_I32 = 0xb7, CONV_I32_U = 0xb8; // i32.trunc_f64_s/u, f64.convert_i32_s/u
export const CONV_F32_I32 = 0xb2, CONV_F32_U32 = 0xb3; // f32.convert_i32_s/u
export const CONV_F32_I64 = 0xb4, CONV_F32_U64 = 0xb5; // f32.convert_i64_s/u
export const CONV_F64_I64 = 0xb9, CONV_F64_U64 = 0xba; // f64.convert_i64_s/u
export const I64_TRUNC_F64 = 0xb0, I32_WRAP_I64 = 0xa7; // i64.trunc_f64_s, i32.wrap_i64 — the $F64-plane -> i32 adaptive unbox
// i64 family (typed-widths step 4): arithmetic, signed/unsigned compares.
export const I64_ADD = 0x7c, I64_SUB = 0x7d, I64_MUL = 0x7e, I64_DIVS = 0x7f, I64_DIVU = 0x80,
  I64_REMS = 0x81, I64_REMU = 0x82, I64_EQ = 0x51, I64_LTS = 0x53, I64_LTU = 0x54, I64_GTS = 0x55,
  I64_GT = 0x55, // alias: i64.gt_s == i64.gts opcode; kept for readability at plain-value compares
  I64_GTU = 0x56, I64_LES = 0x57, I64_LEU = 0x58, I64_GES = 0x59, I64_GEU = 0x5a;
export const I64_NE = 0x52, I64_XOR = 0x85; // i64.ne, i64.xor
export const I64_EXTEND_I32_S = 0xac, I64_EXTEND_I32_U = 0xad, I64_EQZ = 0x50; // pinned @as int conversions
export const F32_DEMOTE = 0xb6, F64_PROMOTE = 0xbb; // f32.demote_f64, f64.promote_f32 —
// the explicit f64 <-> f32 conversions (@as and the operand-width adaptation
// in $numf64/$f32of); no implicit per-node round-trip exists anymore.
export const CALL = 0x10, CALL_INDIRECT = 0x11, RETURN_CALL = 0x12, RETURN_CALL_INDIRECT = 0x13, SELECT = 0x1b;
export const BR = 0x0c, BR_IF = 0x0d, IF = 0x04, ELSE = 0x05, END = 0x0b, LOOP = 0x03, BLOCK = 0x02;
export const RETURN = 0x0f, UNREACHABLE = 0x00;


// --- WasmGC substrate (step 1, additive) -------------------------------------

// Abstract heap types are single valtype bytes, never passed through the sleb
// writer; a concrete (ref null $t) would be 0x63 <sleb $t> (not needed yet).
export const ANYREF = 0x6e, EQREF = 0x6d, I31REF = 0x6c;

// GC opcodes: 0xFB-prefixed instructions carry a sub-opcode (single byte for
// the values here) followed by typeidx/heaptype immediates. REF_NULL/REF_EQ/
// SELECT_TYPED are plain (unprefixed) opcodes; SELECT_TYPED takes a vec of
// valtypes instead of the untyped 0x1b form.
export const GC = 0xfb;

// --- module-level constants -------------------------------------------------


// k-cell kinds (i31 in the $K.kind field). K_RET: a = i31 thunk funcref
// index, b = the frame the thunk runs over. K_HDL: a = $ELEMS case table of
// flat [opid, fnIdx, fsize, nparams] i31 quadruples (the Return case is
// opid -1), b = the handler frame (hframe). K_SPILL: a = frozen $FRAME
// snapshot (per-capture operand snapshot), b unused; it sits between a
// split site's RET cell and the ambient chain so only that site's rest
// fragment sees it (its prologue loads a and skips the cell before
// dispatching).
export const K_RET = 0, K_HDL = 1, K_SPILL = 2;

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
// accessor/helper shapes named in assemble() (24/25 appended by the
// typed-widths plan: __mk_f32, __f32/fF32of).
export const T_RUN = 7, T_PERFORM = 9, T_FAIL = 10, T_STRNUM = 11,
  T_BOX = 13, T_TRUTHY = 14, T_EQ = 15, T_CAPTURE = 16, T_KABI = 17,
  T_III_I = 18, T_MKF32 = 24, T_F32 = 25, T_MKI32 = 26, T_GETI32 = 27,
  T_MKI64 = 28, T_GETI64 = 29;

export function impType(n: string): number {
  if (n === "ef_perform") return T_PERFORM;
  if (n === "ef_fail") return T_FAIL;
  if (n === "ef_args") return T_RUN;
  return T_STRNUM;
}

// Abstract heaptype bytes the emitters use (0x6c i31ref / 0x6d eqref /
// 0x6e anyref) plus type indices 0..6 — mapped to (bare heap type, nullable
// type). The d.ts's heap-type constants (binaryen.any/i31/eq) are undefined
// in this build, so abstract heap types derive from the nullable type
// constants via getHeapType. Concrete-type non-null forms share the bare
// heap type id, so both spellings of a cast target collapse onto HT[i].
export const absHeaps: {
  any: binaryen.HeapType,
  eq: binaryen.HeapType,
  i31: binaryen.HeapType,
} = {
  any: binaryen.getHeapType(binaryen.anyref),
  eq: binaryen.getHeapType(binaryen.eqref),
  i31: binaryen.getHeapType(binaryen.i31ref),
};

export function heapTypes(ht: number): {h: binaryen.HeapType, n: binaryen.Type} {
  if (ht === ANYREF) return {h: absHeaps.any, n: binaryen.anyref};
  if (ht === EQREF) return {h: absHeaps.eq, n: binaryen.eqref};
  if (ht === I31REF) return {h: absHeaps.i31, n: binaryen.i31ref};
  if (ht >= 0 && ht <= 11) return {h: _T.HT[ht], n: _T.RF[ht]};
  throw new WasmError(`internal: bad heaptype byte ${ht}`);
}
