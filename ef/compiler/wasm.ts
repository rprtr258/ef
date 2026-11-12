// wasm.ts — WebAssembly backend for ef.
//
// Pipeline: parse → typecheck (types.ts; stamps the runtime markers the
// phases read) → frontend analysis
// (analysis.ts: builtin tree-shaking, op discovery, live imports) → CPS
// conversion (cps.ts) → IR term emission over the shared value plane
// (wasm_term.ts/wasm_emit.ts: a binary .wasm module, WasmGC value plane,
// no linear memory) → binaryen shrink pass (optimizeBinary: in-process
// npm `binaryen`, no external tools) → imports and run. No types needed at
// emission time: the only checker output the backend consumes is the
// runtime stamps the checker leaves on nodes (`e.div` for division,
// `e.idx` for field access).
//
// Effects: every `perform` (builtin or user-declared op) boxes its args
// into an $ELEMS carrier, resolves the k-operand cell (the reified
// continuation — the CPS IR already holds every "rest of computation" as
// a named `letk` continuation), and walks the continuation chain for a
// handler. With no handler in the chain the effect reaches the host
// (which interprets it via the op table `compileWithOps` returns) and the
// resumed value dispatches through the k cell. `handle` installs a K_HDL
// continuation cell whose case table dispatches performed ops to per-case
// T_KABI functions running over the handler's shared hframe. Resume as a
// value: the
// resume binder is a $CLO closure over the shared resume fn plus a
// per-perform-site capture record {self-contained slice — its bottom's
// next is null, so the record never reaches into the live chain or
// earlier generations' records, which would retain every per-perform
// O(depth) slice (O(n²) live cells over n performs); plus the matched
// case table, the invocation's hframe copy and the slice length}; every
// call copies the captured slice afresh, splices a fresh HDL {case table,
// hframe, next = the k the closure was invoked with} onto the copy's
// bottom by position, and dispatches the resumed value through that
// chain (terminating at the caller's continuation).
//
// Representation (WasmGC — every wasm operand value is an anyref):
// - unit = ref.null any; bool = i31ref 0/1; number = $NUM {f64} (immutable
//   struct); string = $STR (mut i16 array, UTF-16 code units, matches JS
//   strlen/char/Out); array/list = $ARR slice fat pointer {(ref null
//   $ELEMS) data, i32 off, i32 len} (immutable — views share the backing,
//   only elements mutate); tuple = immutable $TUP {(ref null $ELEMS)};
//   closure = immutable $CLO {i31 fnIdx, (ref null $FRAME) env, i31 fsize}.
// - Every call frame is a $FRAME {mut (ref null $FRAME) parent, mut (ref
//   null $ELEMS) slots} with slot array length max(fsize, argc); closures
//   capture their defining frame, so escaping/mutable capture works exactly
//   like the interpreter's env chain. Variables resolve statically to
//   (frame depth, slot); a slot read is struct.get $FRAME 1 + array.get.
// - Continuations are $K cells {mut i31 kind, mut a, mut b, mut (ref null
//   $K) next}: K_RET{a = i31
//   thunk funcref index, b = frame}, K_HDL{a = $ELEMS case table of flat
//   [opid, fnIdx, fsize, nparams] i31 quadruples (Return case = opid -1),
//   b = hframe}. k = ref.null $K is the final return.
// - All ef functions have uniform T_KABI signature ((ref null $FRAME),
//   (ref null $K)) -> anyref and dispatch through one funcref table via
//   call_indirect. Builtins are trampolines; map/each/flatmap are compiled
//   CPS loops calling callbacks the same way; tail positions keep
//   return_call/return_call_indirect.
// - dcall (selective CPS, interim generic shape): classified-pure callees are
//   still T_KABI functions, but a dcall site tails into the callee with a
//   synthesized RET cell whose thunk stores the result and runs the rest —
//   no wrapper letk in the IR, no freeze at the site. dret dispatches the
//   return value through the ambient chain head. Direct functions therefore
//   still pay the T_KABI boundary here; the dual-ABI work gives them a
//   plain value-returning signature.
// - Static literals (nums, strings, bools, unit, builtin closures, PI,
//   per-handle case tables) are immutable anyref globals, each initialized
//   by a GC constant expression at instantiation; run() builds the global
//   frame, then calls main.
// - JS cannot read GC struct fields directly, so the host boundary is 12
//   exported accessor functions (__tag, __num, __str_len, __str_get,
//   __arr_len, __arr_get, __mk_num, __mk_bool, __str_new, __str_set,
//   __arr_new, __arr_set); wasm_host.ts rebuilds interpreter Values
//   through them. Host imports (7): ef_perform, ef_char, ef_number,
//   ef_args, ef_cos, ef_sin, ef_fail — tree-shaken to the live set
//   (ef_fail always live); effects reaching the host flow back through
//   ef_perform and are interpreted there (wasm_host.ts, via builtins.ts's
//   builtinEffectHosts).
//
// Known deviations vs the interpreter (degenerate programs only):
// - Arithmetic/comparison on non-numbers traps (ref.cast failure) instead
//   of producing a garbage number — frozen decision, pinned by a
//   wasm.test.ts test; the checker rejects non-num arithmetic statically,
//   so well-typed programs never hit it.
// - Closures always display as [fn] (interpreter may show an inferred type).
// - Stack overflow surfaces as a wasm RuntimeError, not a JS RangeError.
// - Heap reclamation is the host GC's job: recursion depth costs only
//   GC-reclaimed frame blocks.

// (The eval⇄builtins import cycle is runtime-only on both sides — apply is
// called from builtin closures, eval reads the effect interps lazily — so
// module init order is free; no entry-order breaker import needed.)
import binaryen from "binaryen";
import {Parser} from "./parser.ts";
import {checkProgram} from "./types.ts";
import {toCps} from "./cps.ts";
import {bindMOD} from "./wasm_tables.ts";
import {buildModule, discover, layoutStatics, optimize, assignIndices, type Discovery, type Indices, type Layout, type Opt} from "./wasm_pipeline.ts";
import {planIr, emitCfns, emitCaseFns, emitRetResumes, emitResumeFn, emitTerminalRet, emitMain as emitMainTerm} from "./wasm_term.ts";
import {Fn} from "./wasm_body.ts";
import {type Emit, emitHelpers} from "./wasm_emit.ts";
import {emitBuiltins, emitInits} from "./wasm_module.ts";
import {type CIr} from "./cps_ir.ts";
import {type TermPlan} from "./wasm_term.ts";

// The binary format layer is gone: Buf interprets the emitters' stack-machine
// instruction stream directly into binaryen AST (wasm_body.ts).
//
// Module map (strictly layered, no import cycles):
// - wasm_types.ts   — WasmGC shape types, ValueRef/StaticDesc (leaf)
// - wasm_tables.ts  — signatures, host-import layout, binaryen module binding
// - wasm_body.ts    — Buf + Fn: per-function body emission primitives
// - cps.ts/cps_ir.ts— the CPS IR conversion (stage 1; shared by both backends)
// - wasm_pipeline.ts— discover/optimize/assignIndices/layoutStatics/buildModule
// - wasm_emit.ts    — shared value plane: helpers, dispatch, call ABI, pooling
// - wasm_term.ts    — the IR term emitters (CFns, letk thunks, perform/handle,
//                     case functions, main)
// - wasm_module.ts  — builtin trampolines, run/accessor init fns
// - wasm.ts         — this entry: compile/compileWithOps + emit() orchestration

// --- compiler ---------------------------------------------------------------

export function compile(src: string): Uint8Array<ArrayBuffer> {
  return compileWithOps(src).bytes;
}

// compile + the effect op table (opid → name) the host needs to interpret
// ef_perform calls. The table is built by the same discovery pass that emits
// the code, so the wasm module and the host agree on op numbering.
export function compileWithOps(src: string): {bytes: Uint8Array<ArrayBuffer>, ops: string[]} {
  const prog = new Parser(src).parseProgram();
  // Check before the backend runs: rejects ill-typed programs and stamps the
  // runtime markers the phases read (`numKind` on literals, `div` on
  // applications of `/`, `idx` on field accesses).
  checkProgram(prog);
  // Stage 2: the CPS IR — the single conversion both backends consume. The
  // checker stamps the AST the converter reads (`numKind`/`div`/`idx`).
  const ir = toCps(prog);
  // One compile at a time runs in-process; bind the module for the Buf
  // emitters (they construct binaryen expressions without threading it
  // through every call).
  const mod = new binaryen.Module();
  mod.setFeatures(BIN_FEATURES);
  bindMOD(mod);
  // Phase pipeline (free functions over plain artifact records),
  // then emission (one local Emit context) and assembly.
  const d = discover(ir, prog);
  const o = optimize(prog);
  const plan = planIr(ir);
  const ix = assignIndices(ir, plan, o);
  const lay = layoutStatics(d, ix, o, plan);
  const funcs = emit(ir, d, o, ix, lay, plan);
  return {bytes: buildModule(mod, o, lay, funcs), ops: [...d.effOpIds.keys()]};
}

// The binaryen shrink pass runs inside buildModule (the module is built via
// binaryen's API, optimized in place at shrink level 2, then emitted).
// EF_SKIP_WASM_OPT=1 bypasses the shrink pass: a binaryen abort is total
// (every compile fails until process exit), so there must be an escape
// hatch from day one.

// Feature set to read with: exactly what the emitter emits — WasmGC value
// plane (structs/arrays/i31), funcref table (reference-types) +
// return_call_indirect (tail-call) + MVP basics.
export const BIN_FEATURES = binaryen.Features.MVP | binaryen.Features.ReferenceTypes |
  binaryen.Features.GC | binaryen.Features.TailCall |
  binaryen.Features.SignExt | binaryen.Features.MutableGlobals;

// Shrink every compiled module through binaryen (wasm-opt in-process; the
// emscripten module is sync-ready at import). Shrink level 2 alone matches
// -Oz output size on our modules at ~1/3 the cost of full -Oz. dispose/free
// per module keeps the binaryen heap flat across many compiles.
// Binaryen aborts (throws a raw emscripten object) on malformed input — e.g.
// the emitter's invalid-module bugs — so a failed pass is normalized into a
// WasmError. The aborted binaryen heap is not reusable in-process afterwards;
// every current caller either recovers by process exit or never hits this.
// extraFeatures extends the read mask without touching the production set
// (the GC probe test passes binaryen.Features.GC).


// Emission orchestration: one Emit context per compile, dropped at return.
// Lives here so the emit modules stay one-way (wasm_module imports
// wasm_emit/wasm_term; nothing imports back up).
function emit(ir: CIr, d: Discovery, o: Opt, ix: Indices, lay: Layout, plan: TermPlan): Fn[] {
  const em: Emit = {
    d, o, ix, lay, plan,
    funcs: [],
    thunks: [],
    mainFn: undefined!,
  };
  // Helpers (right after the live imports), CFns, case fns + ret resumes,
  // the shared resume fn, builtin trampolines, then main (last; run/
  // accessors follow in buildModule). Thunks (letk continuations + map-like
  // land cells) are appended after the builtins — makeRestThunk assigns
  // their indices from thunk0 at creation.
  em.funcs.push(...emitHelpers(em));
  emitCfns(em, ir, plan);
  emitCaseFns(em, plan);
  emitRetResumes(em, plan);
  emitResumeFn(em, ix.resumeFn);
  emitTerminalRet(em, ix.terminalRet);
  em.funcs.push(...emitBuiltins(em, ix.builtin0));
  emitMainTerm(em, ir, plan);
  em.funcs.push(...em.thunks);
  em.funcs.push(em.mainFn);
  emitInits(em);
  return em.funcs;
}
