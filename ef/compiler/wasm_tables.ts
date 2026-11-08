// Shared tables of the wasm backend: host-import layout, function
// signatures, valtype decoding and the binaryen module binding. The §-numbered
// design doc for the whole backend lives at the top of wasm.ts.
import binaryen from "binaryen";
import {WasmError, _T} from "./wasm_types.ts";
import * as w from "./wasm_consts.ts";

// map/each/flatmap invoke user callbacks, so they are called land-style: a
// map-like call site is a landCalls split site (§3) and the builtin loops
// through per-iteration thunks instead of an inline wasm loop.
export const MAP_LIKE = new Set(["map", "each", "flatmap"]);
// Extra entry-frame words a map-like builtin needs beyond its args: the
// result/tmp array (except each) and the iteration counter.
export const mapLikeFrameWords = (name: string): number => name === "each" ? 1 : MAP_LIKE.has(name) ? 2 : 0;

// Operators compile inline at call sites (like the checker-stamped `/`):
// operands unbox to f64 (or dispatch to $eq/$truthy) right in the caller,
// no call, no frame. A trampoline exists only for operators referenced as
// values (e.g. passed to foldl) — see treeShakeBuiltins.
export const OPERATOR_OPS = new Set(["+", "-", "*", "%", "neg", "<", ">", "<=", ">=", "==", "!=", "not"]);

// Import names that serve exactly one builtin each (import → builtin).
export const BUILTIN_IMPORTS: Record<string, string> = {
  ef_char: "char", ef_number: "number", ef_args: "args",
  ef_cos: "cos", ef_sin: "sin",
};

export const HOST_IMPORTS = [
  "ef_perform", "ef_fail",
  ...Object.keys(BUILTIN_IMPORTS),
];

// debug emitter tracing: run with DBGEMIT=1 to log split/thunk internals
// during compile; off (and free) otherwise.
export const DBGEMIT = process.env["DBGEMIT"] === "1";
// Func signatures by type index (§1 func types 7..23). Valtype spellings
// mirror the emitter's byte language: 0x7f i32, 0x7c f64, 0x6e anyref,
// [0x63, n] = (ref null $n). Consumed by Buf's call handling and by
// buildModule's addFunction calls.
export const SIGS: Record<number, {p: (number | number[])[], r: number | number[] | null}> = {
  [w.T_RUN]: {p: [], r: w.ANYREF},                    // run, ef_args
  [w.T_PERFORM]: {p: [0x7f, w.ANYREF], r: w.ANYREF},    // ef_perform
  [w.T_FAIL]: {p: [0x7f, w.ANYREF, 0x7c, 0x7c], r: null}, // ef_fail
  [w.T_STRNUM]: {p: [w.ANYREF], r: w.ANYREF},           // ef_char/number/cos/sin
  [12]: {p: [0x7f], r: w.ANYREF},                   // __mk_bool/__str_new/__arr_new
  [w.T_BOX]: {p: [0x7c], r: w.ANYREF},                // fBox, __mk_num
  [w.T_TRUTHY]: {p: [w.ANYREF], r: 0x7f},             // fTruthy, __tag/__str_len/__arr_len
  [w.T_EQ]: {p: [w.ANYREF, w.ANYREF], r: w.ANYREF},       // fEq
  [w.T_CAPTURE]: {p: [[0x63, 5], [0x63, 5]], r: [0x63, 5]}, // fCapture
  [w.T_KABI]: {p: [[0x63, 4], [0x63, 5]], r: w.ANYREF},       // (frame, k) program fns
  [w.T_III_I]: {p: [[0x63, 4], w.ANYREF, [0x63, 5]], r: w.ANYREF}, // land thunks
  [19]: {p: [w.ANYREF], r: 0x7c},                   // __num/fNum64
  [20]: {p: [w.ANYREF, 0x7f], r: 0x7f},             // __str_get
  [21]: {p: [w.ANYREF, 0x7f, 0x7f], r: null},       // __str_set
  [22]: {p: [w.ANYREF, 0x7f], r: w.ANYREF},           // __arr_get
  [23]: {p: [w.ANYREF, 0x7f, w.ANYREF], r: null},     // __arr_set
  [w.T_MKF32]: {p: [0x7d], r: w.ANYREF},              // __mk_f32 (step 2)
  [w.T_F32]: {p: [w.ANYREF], r: 0x7d},                // __f32/fF32of (step 2)
  [w.T_MKI32]: {p: [0x7f], r: w.ANYREF},              // __mk_i32/__mk_u32 (step 3)
  [w.T_GETI32]: {p: [w.ANYREF], r: 0x7f},             // __i32/__u32/fI32of/fU32of (step 3)
};

// Valtype byte (or [0x63, idx] pair) → binaryen Type. 0x40 → none (void).
export function vt(t: number | number[] | null): binaryen.Type {
  if (t === null || t === 0x40) return binaryen.none;
  if (typeof t === "number") {
    if (t === 0x7f) return binaryen.i32;
    if (t === 0x7e) return binaryen.i64;
    if (t === 0x7d) return binaryen.f32;
    if (t === 0x7c) return binaryen.f64;
    if (t === w.ANYREF) return binaryen.anyref;
    if (t === w.EQREF) return binaryen.eqref;
    if (t === w.I31REF) return binaryen.i31ref;
  } else return _T.RF[t[1]];
  throw new WasmError(`internal: bad valtype ${JSON.stringify(t)}`);
}

// One compile at a time runs in-process, so the module under construction
// lives in a module-level binding (Buf emitters construct binaryen
// expressions through it without threading it through every call). The
// owning Emit context travels on each Fn instead (Fn.em).
export let MOD: binaryen.Module;

// compileWithOps (wasm.ts) binds the module for the current compile — one
// compile at a time runs in-process. Imported bindings are read-only in TS,
// so the bind goes through this setter.
export function bindMOD(m: binaryen.Module): void { MOD = m; }
// Struct field valtypes by type index (struct.new pops fields in reverse
// declaration order — the last field pushed is the first popped).
export const STRUCT_FIELDS: Record<number, (number | number[])[]> = {
  [0]: [0x7c],                       // $F64: f64
  [3]: [[0x63, 1]],                  // $ARR: (ref null $ELEMS)
  [4]: [[0x63, 4], [0x63, 1]],       // $FRAME
  [5]: [w.I31REF, w.ANYREF, w.ANYREF, [0x63, 5]], // $K
  [6]: [w.I31REF, [0x63, 4], w.I31REF],  // $CLO
  [7]: [0x7f],                       // $I32: i32
  [8]: [0x7f],                       // $U32: i32
  [9]: [0x7e],                       // $I64: i64
  [10]: [0x7e],                      // $U64: i64
  [11]: [0x7d],                      // $F32: f32
};
