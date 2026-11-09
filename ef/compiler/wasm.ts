// wasm.ts — WebAssembly backend for ef.
//
// Pipeline: parse → typecheck (types.ts, reused as-is) → frontend analysis
// (analysis.ts: builtin tree-shaking, op discovery, live imports) → emit a
// binary .wasm module (WasmGC value plane, no linear memory) → binaryen
// shrink pass (optimizeBinary: in-process npm `binaryen`, no external
// tools) → imports and run. No types needed at emission time: the only
// checker output the backend consumes is the runtime stamps the checker
// leaves on nodes (`e.div` for division, `e.idx` for field access).
//
// Subset: everything except suspension across `if`/`while` (a perform or
// handle site inside a branch or loop body is rejected at compile time).
// Every `perform` (builtin or user-declared op) boxes its args into an
// $ELEMS array, spills the args cell to a frame slot, and walks the
// continuation chain for a handler. With no handler in the chain the
// effect reaches the host (which interprets it via the op table
// `compileWithOps` returns) and the rest-of-site fragment continues with
// the resumed value. `handle` installs a K_HDL continuation cell whose
// case table dispatches performed ops to per-case T_KABI functions running
// over the handler's shared hframe (§4.4); every perform/handle site ends
// the inline body and reifies the code after it as a rest-of-site fragment
// via the compile-time split protocol below. Resume as a value (§4.6): the
// resume binder is a $CLO closure over the shared resume fn plus a
// per-perform-site capture record; every call copies the captured slice
// afresh, re-chains the copy's bottom to a fresh HDL whose next is the k
// the closure was invoked with, and dispatches the resumed value through
// that chain (terminating at the caller's continuation).
//
// Representation (WasmGC — every wasm operand value is an anyref):
// - unit = ref.null any; bool = i31ref 0/1; number = $NUM {f64} (immutable
//   struct); string = $STR (mut i16 array, UTF-16 code units, matches JS
//   strlen/char/Out); array/tuple/list = $ARR wrapper {mut (ref null
//   $ELEMS)} over a backing $ELEMS array (growth repoints the wrapper's
//   backing, so aliases share the wrapper and see growth); closure =
//   immutable $CLO {i31 fnIdx, (ref null $FRAME) env, i31 fsize}.
// - Every call frame is a $FRAME {mut (ref null $FRAME) parent, mut (ref
//   null $ELEMS) slots} with slot array length max(fsize, argc); closures
//   capture their defining frame, so escaping/mutable capture works exactly
//   like the interpreter's env chain. Variables resolve statically to
//   (frame depth, slot); a slot read is struct.get $FRAME 1 + array.get.
// - Continuations are $K cells {mut i31 kind, mut a, mut b, mut (ref null
//   $K) next}, mirroring the old 4-word k-cell layout: K_RET{a = i31
//   thunk funcref index, b = frame}, K_HDL{a = $ELEMS case table of flat
//   [opid, fnIdx, fsize, nparams] i31 quadruples (Return case = opid -1),
//   b = hframe}, K_SPILL{a = frozen $FRAME snapshot, b unused}. k = ref.null
//   $K is the final return.
// - All ef functions have uniform T_KABI signature ((ref null $FRAME),
//   (ref null $K)) -> anyref and dispatch through one funcref table via
//   call_indirect. Builtins are trampolines; map/each/flatmap are compiled
//   CPS loops calling callbacks the same way; tail positions keep
//   return_call/return_call_indirect.
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
// - `set` growing an array fills holes with unit (interpreter: undefined).
// - Closures always display as [fn] (interpreter may show an inferred type).
// - Stack overflow surfaces as a wasm RuntimeError, not a JS RangeError.
// - Heap reclamation is the host GC's job (the old bump heap was never
//   freed; recursion depth no longer costs O(N) unreclaimed bytes).

// (The eval⇄builtins import cycle is runtime-only on both sides — apply is
// called from builtin closures, eval reads the effect interps lazily — so
// module init order is free; no entry-order breaker import needed.)
import binaryen from "binaryen";
import {Parser, type Program} from "./parser.ts";
import {bindMOD} from "./wasm_tables.ts";
import {buildModule, discover, layoutStatics, optimize, assignIndices, type Discovery, type Indices, type Layout, type Opt} from "./wasm_pipeline.ts";
import {Fn} from "./wasm_body.ts";
import {type Emit, emitCaseFns, emitHelpers, emitLambdas} from "./wasm_emit.ts";
import {emitBuiltins, emitInits, emitMain} from "./wasm_module.ts";
// The binary format layer is gone: Buf interprets the emitters' stack-machine
// instruction stream directly into binaryen AST (wasm_body.ts).
//
// Module map (strictly layered, no import cycles):
// - wasm_types.ts   — WasmGC shape types, Ctx, ValueRef/StaticDesc (leaf)
// - wasm_tables.ts  — signatures, host-import layout, binaryen module binding
// - wasm_body.ts    — Buf + Fn: per-function body emission primitives
// - wasm_pipeline.ts— discover/optimize/assignIndices/layoutStatics/buildModule
// - wasm_emit.ts    — expr() + statement/effect emitters (split protocol)
// - wasm_module.ts  — builtin trampolines, main, run/accessor init fns
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
  // One compile at a time runs in-process; bind the module for the Buf
  // emitters (they construct binaryen expressions without threading it
  // through every call).
  const mod = new binaryen.Module();
  mod.setFeatures(BIN_FEATURES);
  bindMOD(mod);
  // Phase pipeline (free functions over plain artifact records),
  // then emission (one local Emit context) and assembly.
  const d = discover(prog);
  const o = optimize(prog);
  const ix = assignIndices(prog, d, o);
  const lay = layoutStatics(d, ix, o);
  const funcs = emit(prog, d, o, ix, lay);
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
// (the GC probe test passes binaryen.Features.GC; the rewrite flips the mask
// for real in step 2).


// Emission orchestration: one Emit context per compile, dropped at return.
// Lives here (not wasm_emit.ts) so the two emit modules stay one-way:
// wasm_module.ts imports wasm_emit.ts (Split/selectBool...), and
// nothing imports back up.
function emit(prog: Program, d: Discovery, o: Opt, ix: Indices, lay: Layout): Fn[] {
  const em: Emit = {
    prog,
    nodes: prog.nodes,
    d, o, ix, lay,
    funcs: [],
    thunks: [],
    sp: {
      cutStack: [],
      bodyRoots: [],
      filledRests: new Set(),
      restByChain: new Map(),
      restRoot: null,
      hdlRest: new Map(),
      ctlLoops: new Map(),
    },
  };
  // Helpers (right after the live imports), lambdas, builtin trampolines,
  // then main (last; run/accessors follow in buildModule).
  em.funcs.push(...emitHelpers(em));
  for (const it of prog.items) {
    if ("e" in it) emitLambdas(em, it.e);
  }
  emitCaseFns(em);
  em.funcs.push(...emitBuiltins(em, ix.builtin0));
  const main = new Fn(2, em);
  emitMain(em, main);
  // Thunks are appended after all emission (emitMain's top-level calls
  // create thunks too); main stays the last program function (exported
  // as run — the run wrapper is assembled after it).
  em.funcs.push(...em.thunks);
  em.funcs.push(main);
  emitInits(em);
  return em.funcs;
}
