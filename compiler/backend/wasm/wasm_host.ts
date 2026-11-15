// wasm_host.ts — compile + run seam over the wasm backend: compiles ef
// source (wasm.ts's compileWithOps — binaryen included) and hands the
// binary to the binaryen-free host runtime in wasm_run.ts. Execute-only
// callers that compile separately from running import wasm_run.ts directly
// and never load binaryen.
import type {EffectInterp} from "../../frontend/pipeline.ts";
import type {Value} from "../../env.ts";
import {compileWithOps} from "./wasm.ts";
import {runModule} from "./wasm_run.ts";

export function runWasm(src: string, interp?: EffectInterp, args?: string[]): Value {
  // interp rides along for the static unhandled-op gate (pipeline.ts's
  // rejectUnhandled): a custom op the interp covers must compile.
  const {bytes, ops} = compileWithOps(src, interp);
  return runModule(bytes, ops, interp, args);
}
