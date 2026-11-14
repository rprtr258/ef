// Shared tables of the wasm backend: host-import layout, function
// signatures, valtype decoding and the binaryen module binding. The
// design doc for the whole backend lives at the top of wasm.ts.
import binaryen from "binaryen";
import {NATIVE_BUILTINS} from "../../frontend/analysis.ts";
import {WasmError, _T} from "./wasm_types.ts";
import * as w from "./wasm_consts.ts";

// The native builtins invoke user callbacks, so they are called land-style:
// the builtin loops through per-iteration thunks instead of an inline wasm
// loop. The name set is builtin_table.ts's `kind: "native"` rows.
// Extra entry-frame words a map-like builtin needs beyond its args: the
// result/tmp array (except each). The loop index does not live here — each
// iteration's land cell carries a fresh frame holding it (emitMapLike), so
// a captured cell stays a complete resume acc.
// Every native builtin except each currently is map-like, so the NATIVE_BUILTINS
// key matches the map-like set; a new non-map-like native (e.g. a callback-taking
// sortWith) must re-key this, not reuse it.
export const mapLikeFrameWords = (name: string): number => name === "each" ? 0 : NATIVE_BUILTINS.has(name) ? 1 : 0;

// Operators compile inline at call sites stamped with a concrete width (like
// the checker-stamped `/`): operands unbox to their width right in the
// caller, no call, no frame. Unstamped (polymorphic) sites and sites
// referenced as values (e.g. passed to foldl) use the dynamic trampolines —
// see treeShakeBuiltins and emitOperatorInline.
export {OPERATOR_OPS} from "../../frontend/analysis.ts";

// Import names that serve exactly one builtin each (import → builtin).
export const BUILTIN_IMPORTS: Record<string, string> = {
  ef_char: "char", ef_number: "number", ef_args: "args",
  ef_cos: "cos", ef_sin: "sin",
};

export const HOST_IMPORTS = [
  "ef_perform", "ef_fail",
  ...Object.keys(BUILTIN_IMPORTS),
  "ef_trace",
  // operator values (checker-unstamped sites: string `+`, comparisons)
  "ef_binop",
];

// debug emitter tracing: run with DBGEMIT=1 to log split/thunk internals
// during compile; off (and free) otherwise.
export const DBGEMIT = process.env["DBGEMIT"] === "1";
// Runtime tracing (EFTRACE=1): the emitter inserts an ef_trace(site, val)
// host call at key points; the host keeps a ring buffer of (site, val) and
// prints it when a runtime trap escapes (a trap otherwise loses all
// location info).
export const DBGTRACE = process.env["EFTRACE"] === "1";
// Emission-site descriptions, indexed by the site id the emitter passes to
// ef_trace. Lives in this leaf module so the emitter and the host share it
// without an import cycle.
export const TRACE_SITES: string[] = [];
// Func signatures by type index. Valtype spellings
// mirror the emitter's byte language: 0x7f i32, 0x7c f64, 0x6e anyref,
// [0x63, n] = (ref null $n). Consumed by Buf's call handling and by
// buildModule's addFunction calls.
export const SIGS: Record<number, {p: (number | number[])[], r: number | number[] | null}> = {
  [w.T_RUN]: {p: [], r: w.ANYREF},                    // run, ef_args
  [w.T_PERFORM]: {p: [0x7f, w.ANYREF], r: w.ANYREF},    // ef_perform
  [w.T_FAIL]: {p: [0x7f, w.ANYREF, 0x7c, 0x7c, 0x7c], r: null}, // ef_fail
  [w.T_STRNUM]: {p: [w.ANYREF], r: w.ANYREF},           // ef_char/number/cos/sin
  [w.T_BINOP]: {p: [0x7f, w.ANYREF, w.ANYREF], r: w.ANYREF}, // ef_binop
  [12]: {p: [0x7f], r: w.ANYREF},                   // __mk_bool/__str_new/__arr_new/__tup_new
  [w.T_BOX]: {p: [0x7c], r: w.ANYREF},                // fBox, __mk_num
  [w.T_TRUTHY]: {p: [w.ANYREF], r: 0x7f},             // fTruthy, __tag/__str_len/__arr_len/__tup_len
  [w.T_EQ]: {p: [w.ANYREF, w.ANYREF], r: w.ANYREF},       // fEq
  [w.T_KABI]: {p: [[0x63, 4], [0x63, 5]], r: w.ANYREF},       // (frame, k) program fns
  [w.T_III_I]: {p: [[0x63, 4], w.ANYREF, [0x63, 5]], r: w.ANYREF}, // land thunks
  [w.T_DABI]: {p: [[0x63, 4]], r: w.ANYREF},                   // (frame) direct fns
  [w.T_NUM64]: {p: [w.ANYREF], r: 0x7c},                   // __num/fNum64: (anyref) -> f64
  [20]: {p: [w.ANYREF, 0x7f], r: 0x7f},             // __str_get
  [21]: {p: [w.ANYREF, 0x7f, 0x7f], r: null},       // __str_set
  [22]: {p: [w.ANYREF, 0x7f], r: w.ANYREF},           // __arr_get
  [23]: {p: [w.ANYREF, 0x7f, w.ANYREF], r: null},     // __arr_set
  [w.T_MKF32]: {p: [0x7d], r: w.ANYREF},              // __mk_f32
  [w.T_F32]: {p: [w.ANYREF], r: 0x7d},                // __f32/fF32of
  [w.T_MKI32]: {p: [0x7f], r: w.ANYREF},              // __mk_i32/__mk_u32
  [w.T_GETI32]: {p: [w.ANYREF], r: 0x7f},             // __i32/__u32/fI32of/fU32of
  [w.T_MKI64]: {p: [0x7e], r: w.ANYREF},              // __mk_i64/__mk_u64 (BigInt at the host)
  [w.T_GETI64]: {p: [w.ANYREF], r: 0x7e},             // __i64/__u64/fI64of/fU64of
  [w.T_TRACE]: {p: [0x7f, 0x7f], r: null},             // ef_trace(site, val) — EFTRACE only
};

// Width name -> valtype byte. numSig's inputs are only the six widths.
function widthByte(name: string): number {
  switch (name) {
    case "i32": case "u32": return 0x7f;
    case "i64": case "u64": return 0x7e;
    case "f32": return 0x7d;
    case "f64": return 0x7c;
    default: throw new WasmError(`internal: no valtype for width ${name}`);
  }
}

const numSigs = new Map<string, number>();

// Intern the numeric direct-ABI signature ((ref null $FRAME), ws...) -> r
// and return its type index. The frame param rides every entry (the
// closure env is the scope-chain base), params and the result are raw
// valtypes. Emitters and $CLO tag checks derive indices only through this
// function, so a site's stamp-derived key and a callee's typ-derived key
// land on the same entry iff the valtype shapes match (i32/u32 share the
// i32 valtype — raw bits are width-agnostic; signedness lives in each
// body's op stamps).
export function numSig(ws: string[], r: string): number {
  const key = `${ws.map(widthByte).join(",")}>${widthByte(r)}`;
  const found = numSigs.get(key);
  if (found !== undefined) return found;
  const idx = w.T_DABI_NUM + numSigs.size;
  SIGS[idx] = {p: [[0x63, 4], ...ws.map(widthByte)], r: widthByte(r)};
  numSigs.set(key, idx);
  return idx;
}

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
  [3]: [[0x63, 1], 0x7f, 0x7f],      // $ARR slice: (ref null $ELEMS), i32 off, i32 len
  [4]: [[0x63, 4], [0x63, 1]],       // $FRAME
  [5]: [w.I31REF, w.ANYREF, w.ANYREF, [0x63, 5]], // $K
  [6]: [w.I31REF, [0x63, 4], w.I31REF, w.I31REF, w.I31REF, w.I31REF], // $CLO {idx, env, fsize, direct, numfn, numsig}
  [7]: [0x7f],                       // $I32: i32
  [8]: [0x7f],                       // $U32: i32
  [9]: [0x7e],                       // $I64: i64
  [10]: [0x7e],                      // $U64: i64
  [11]: [0x7d],                      // $F32: f32
  [12]: [[0x63, 1]],                 // $TUP: (ref null $ELEMS)
  [13]: [[0x63, 4], [0x63, 17]],     // $UF_I32
  [14]: [[0x63, 4], [0x63, 18]],     // $UF_I64
  [15]: [[0x63, 4], [0x63, 19]],     // $UF_F32
  [16]: [[0x63, 4], [0x63, 20]],     // $UF_F64
  [21]: [w.I31REF, w.ANYREF, w.ANYREF, [0x63, 21], [0x63, 5]], // $HDLCTX
};
