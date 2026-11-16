// wasm.ts — WebAssembly backend for ef.
//
// Pipeline: parse → typecheck (types.ts; stamps the runtime markers the
// phases read) → frontend analysis
// (analysis.ts: builtin tree-shaking, op discovery, live imports) → CPS
// conversion (cps.ts) → devirtualization analysis (wasm_devirt.ts: slot
// provenance + per-CFn purity + numeric-entry eligibility, consumed by the
// term emitters) → IR term
// emission over the shared value plane
// (wasm_term.ts/wasm_emit.ts: a binary .wasm module, WasmGC value plane,
// no linear memory) → binaryen shrink pass (optimizeBinary: in-process
// npm `binaryen`, no external tools) → imports and run. No types needed at
// emission time: the only checker output the backend consumes is the
// stamp side-table `Checked.stamps` (`div` for division; `idx` is a
// parser field on the node) plus the deep-resolved checker types the
// numeric-entry eligibility resolves.
//
// Effects: every `perform` (builtin or user-declared op) boxes its args
// into an $ELEMS carrier, resolves the k-operand cell (the reified
// continuation — the CPS IR already holds every "rest of computation" as
// a named `letk` continuation), and walks the hctx boundary stack for a
// handler (O(1) for the innermost; forwarding follows outer pointers, one
// step per handler boundary — never the K-cell chain, so recursion depth
// is invisible). With no handler the effect reaches the host (which
// interprets it via the op table `compileWithOps` returns) and the
// resumed value dispatches through the k cell. `handle` pushes a $HDLCTX
// boundary {case table, hframe, outer, kret} onto the hctx global —
// handler boundaries never sit in K-cell chains; the handled body's
// cells chain to the K_BND sentinel, which dispatch resolves through
// hctx at that moment. Performed ops dispatch to per-case T_KABI
// functions running over the handler's invocation hframe. Resume as a
// value: the
// resume binder is a $CLO closure over the shared resume fn plus a
// per-perform-site capture record {the live perform-site k cell (the
// shared slice head), the matched case table, the invocation's hframe
// copy, the matched boundary, and the reversed chain of forwarded
// boundaries}; every resume conses a fresh $HDLCTX entry (the paper's
// resumption re-arming the handler on the resumer's context), re-chains
// the forwarded boundaries above it, and dispatches the resumed value
// into the captured chain — no slice copy, no splice, no off-chain
// rewrite, O(1) per resume in recursion depth.
//
// Representation (WasmGC — every wasm operand value is an anyref):
// - unit = ref.null any; bool = i31ref 0/1; number = $NUM {f64} (immutable
//   struct); string = $STR (mut i16 array, UTF-16 code units, matches JS
//   strlen/char/Out); array = $ARR slice fat pointer {(ref null
//   $ELEMS) data, i32 off, i32 len} (immutable — views share the backing,
//   only elements mutate); tuple = immutable $TUP {(ref null $ELEMS)};
//   closure = immutable $CLO {i31 fnIdx, (ref null $FRAME) env, i31
//   fsize, i31 direct flag}.
// - Every call frame is a $FRAME {mut (ref null $FRAME) parent, mut (ref
//   null $ELEMS) slots} with slot array length max(fsize, argc); closures
//   capture their defining frame, so escaping/mutable capture works exactly
//   like the interpreter's env chain. Variables resolve statically to
//   (frame depth, slot); a slot read is struct.get $FRAME 1 + array.get.
// - Continuations are $K cells {mut i31 kind, mut a, mut b, mut (ref null
//   $K) next}: K_RET{a = i31
//   thunk funcref index, b = frame}, K_BND = the handler-boundary
//   sentinel (a dead-end cell dispatch resolves through hctx). k =
//   ref.null $K is the final return; the terminal cell —
//   a shared K_RET whose fragment just returns its param — stands in for
//   a direct-boundary function's never-set $ret wherever a synthesized
//   cell would otherwise chain to null.
// - Dual call ABI, one funcref table: classified-pure functions (empty
//   effect row and no tail call to a suspending callee — cps.ts) compile
//   to T_DABI ((ref null $FRAME)) -> anyref with no continuation operand;
//   everything that can suspend keeps T_KABI ((ref null $FRAME), (ref
//   null $K)) -> anyref. dcall sites check the $CLO's direct flag at
//   runtime — static knowledge is only a hint, never a bypass (a
//   pure-typed slot can hold a resume binder or an any-smuggled closure,
//   which take the T_KABI arm through a synthesized land cell chaining to
//   the terminal one inside a direct body). Tail positions keep
//   return_call/return_call_indirect.
// - Mixed functions — row {} with internal handles — keep the direct
//   boundary: their islands run over the ambient chain like any CPS
//   region. A tail handle's kret is the terminal cell instead of the
//   never-set $ret, so a case fn's completion returns, delivering the
//   island's value out of the direct entry.
// - Static literals (nums, strings, bools, unit, builtin closures, PI,
//   per-handle case tables) are immutable anyref globals, each initialized
//   by a GC constant expression at instantiation; run() builds the global
//   frame, then calls main.
// - JS cannot read GC struct fields directly, so the host boundary is 12
//   exported accessor functions (__tag, __num, __str_len, __str_get,
//   __arr_len, __arr_get, __mk_num, __mk_bool, __str_new, __str_set,
//   __arr_new, __arr_set); wasm_run.ts rebuilds interpreter Values
//   through them. Host imports (7): ef_perform, ef_char, ef_number,
//   ef_args, ef_cos, ef_sin, ef_fail — tree-shaken to the live set
//   (ef_fail always live); effects reaching the host flow back through
//   ef_perform and are interpreted there (wasm_run.ts, via builtins.ts's
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
import {prepare, rejectUnhandled, type EffectInterp} from "../../frontend/pipeline.ts";
import {toCps} from "../../frontend/cps.ts";
import {bindMOD} from "./wasm_tables.ts";
import {buildModule, discover, layoutStatics, optimize, assignIndices, type Discovery, type Indices, type Layout, type Opt} from "./wasm_pipeline.ts";
import {emitCfns, emitCaseFns, emitRetResumes, emitResumeFn, emitTerminalRet, emitMain} from "./wasm_term.ts";
import {Fn} from "./wasm_body.ts";
import {type Emit, emitHelpers} from "./wasm_emit.ts";
import {emitBuiltins, emitInits, emitTightMaps} from "./wasm_module.ts";
import {type CIr} from "../../frontend/cps_ir.ts";
import {planIr, type Plan} from "./wasm_plan.ts";
import {OP_SECTION} from "./wasm_run.ts";
// The binary format layer is gone: Buf's emit methods build binaryen AST
// directly (wasm_body.ts); opcode constants survive only as the data keys
// of the numeric-op tables (BIN_OPS/UN_OPS, CMP_OPS, ladder defOps). Buf's
// scope contract: operands never park across a block/loop/if boundary — a
// parked expression would silently move to its consumer's position after
// the scope — so emitters spill to explicit locals instead (localSet
// before the scope, localGet after); Buf throws on violations.
//
// Module map (strictly layered, no import cycles):
// - wasm_types.ts   — WasmGC shape types, ValueRef/StaticDesc (leaf)
// - wasm_tables.ts  — signatures, host-import layout, binaryen module binding
// - wasm_body.ts    — Buf + Fn: per-function body emission primitives
// - cps.ts/cps_ir.ts— the CPS IR conversion (stage 1; shared by both backends)
// - wasm_pipeline.ts— discover/optimize/register/layoutStatics/buildModule:
//                      the registration hub — it runtime-imports the emit
//                      modules' register* functions; their pipeline imports
//                      are type-only, so the runtime graph stays one-way
// - wasm_devirt.ts  — devirtualization analysis: slot provenance + per-CFn
//                     purity fixpoint (leaf, over the CPS IR; consumed by
//                     the plan module)
// - wasm_plan.ts    — frame/slot planning + devirt classification (planIr:
//                     TLevel/TScope, per-node annotations, typed-slot/
//                     elision flags) and the published Plan
// - wasm_emit.ts    — shared value plane: helpers, dispatch, call ABI, pooling
// - wasm_term.ts    — the IR term emitters (CFns, letk thunks, perform/handle,
//                     case functions, main)
// - wasm_module.ts  — builtin trampolines, run/accessor init fns
// - wasm.ts         — this entry: compile/compileWithOps + emit() orchestration

// --- compiler ---------------------------------------------------------------

export function compile(src: string): Uint8Array<ArrayBuffer> {
  // No interp: the shipped module's only runner is the default host table,
  // so the static gate rejects ops nothing interprets — buildwasm fails
  // with the same message `ef run` fails with, before a module is emitted.
  return compileWithOps(src).bytes;
}

// compile + the effect op table (opid → name) the host needs to interpret
// ef_perform calls. The table is built by the same discovery pass that emits
// the code, so the wasm module and the host agree on op numbering.
// `interp` feeds only the static unhandled-op gate (the runner's effect
// interpretation — see pipeline.ts's rejectUnhandled); codegen is
// interp-independent.
// Parse → check → CPS → binaryen function bodies: everything both emissions
// share, so the WAT text the playground shows is built by the same pipeline
// as the shipped bytes.
function pipeline(src: string, interp?: EffectInterp): {mod: binaryen.Module, ops: string[], o: Opt, lay: Layout, funcs: Fn[]} {
  // prepare: parse + check before the backend runs — rejects ill-typed
  // programs and fills the Checked.stamps side-table the phases read
  // (`numKind` on literals, `div` on applications of `/`; `idx` is a
  // parser field on the node). The
  // Checked result rides into the wasm pipeline as the numeric-entry
  // eligibility's type resolver (uni.deepRes resolves bound vars;
  // quantified vars stay unbound).
  const {prog, checked} = prepare(src);
  // The static unhandled-op gate (pipeline.ts's rejectUnhandled — the same
  // one exec applies right after prepare): residual ops that neither the
  // builtin table nor the runner's interp covers are rejected here, before
  // any codegen — not as a mid-run host trap.
  rejectUnhandled(checked, interp);
  // Stage 2: the CPS IR — the single conversion both backends consume. The
  // checker's stamps side-table (Checked.stamps) feeds the converter.
  const ir = toCps(prog, checked.stamps);
  // One compile at a time runs in-process; bind the module for the Buf
  // emitters (they construct binaryen expressions without threading it
  // through every call).
  const mod = new binaryen.Module();
  mod.setFeatures(BIN_FEATURES);
  bindMOD(mod);
  // Phase pipeline (free functions over plain artifact records),
  // then emission (one local Emit context) and assembly.
  const d = discover(ir, prog);
  const o = optimize(prog, checked.stamps);
  const plan = planIr(ir, (t) => checked.uni.deepRes(t));
  const ix = assignIndices(ir, plan, o);
  const lay = layoutStatics(d, ix, o, plan);
  const funcs = emit(ir, d, o, ix, lay, plan);
  return {mod, ops: [...d.effOpIds.keys()], o, lay, funcs};
}

export function compileWithOps(src: string, interp?: EffectInterp): {bytes: Uint8Array<ArrayBuffer>, ops: string[]} {
  const {mod, ops, o, lay, funcs} = pipeline(src, interp);
  // The ops table rides in the module itself (ef_ops custom section — see
  // wasm_run.ts), so the emitted binary is self-contained: no sidecar, and
  // `ef runwasm <out>.wasm` runs without recompiling.
  mod.addCustomSection(OP_SECTION, new TextEncoder().encode(JSON.stringify(ops)));
  return {bytes: buildModule(mod, o, lay, funcs), ops};
}

// The shipped module (post binaryen shrink, validated) as WAT text — the
// playground's wasm view prints what build emits, not a parallel build.
export function compileWat(src: string): string {
  const {mod, o, lay, funcs} = pipeline(src);
  return buildModule(mod, o, lay, funcs, true);
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
// wasm_emit/wasm_term; their imports of wasm_pipeline are type-only).
function emit(ir: CIr, d: Discovery, o: Opt, ix: Indices, lay: Layout, plan: Plan): Fn[] {
  const em: Emit = {
    d, o, ix, reg: ix.reg, lay, plan,
    funcs: [],
    thunks: [],
    tightMaps: [],
  };
  // Helpers (right after the live imports), CFns, case fns + ret resumes,
  // the shared resume fn, the terminal ret, builtin trampolines, tight-map
  // bodies, thunks, then main (last; run/accessors follow in buildModule).
  // Thunks (letk continuations + map-like land cells) are appended after the
  // builtins — makeRestThunk registers them at creation. funcs/thunks/
  // tightMaps are the emitters' mutable accumulators; every other field is
  // final at construction.
  em.funcs.push(...emitHelpers(em));
  emitCfns(em, ir);
  emitCaseFns(em);
  emitRetResumes(em);
  emitResumeFn(em, ix.resumeFn);
  emitTerminalRet(em, ix.terminalRet);
  em.funcs.push(...emitBuiltins(em));
  const mainFn = emitMain(em, ir);
  emitTightMaps(em);
  em.funcs.push(...em.thunks);
  em.funcs.push(mainFn);
  emitInits(em, mainFn);
  return em.funcs;
}
