// wasm_host.ts — compile + run seam over the wasm backend: compiles ef
// source (wasm.ts's compileWithOps — binaryen included) and hands the
// binary to the binaryen-free host runtime in wasm_run.ts. Execute-only
// callers that compile separately from running import wasm_run.ts directly
// and never load binaryen.
import {prepare, requireUnitEntry, type EffectInterp} from "../../frontend/pipeline.ts";
import type {Value} from "../../env.ts";
import {compileWithOps} from "./wasm.ts";
import {runModule} from "./wasm_run.ts";

export function runWasm(src: string, interp?: EffectInterp, args?: string[]): Value {
  // The entrypoint gate (pipeline.ts's requireUnitEntry — the interpreter
  // run's twin): a module run from source is a file entrypoint, so its last
  // expression must be unit-typed. Applied here, not inside compile: the
  // compile seam consumes Prepared artifacts and re-parses nothing, so the
  // single prepare serves both the gate and the codegen.
  const pre = prepare(src);
  requireUnitEntry(pre.prog, pre.checked);
  // interp rides along for the static unhandled-op gate (pipeline.ts's
  // rejectUnhandled): a custom op the interp covers must compile.
  const {bytes, ops} = compileWithOps(pre, interp);
  return runModule(bytes, ops, interp, args);
}
