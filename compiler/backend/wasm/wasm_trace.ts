// wasm_trace.ts — EFTRACE=1 debug-trace state: wasm_emit.ts records each
// emission site's label here, wasm_run.ts names the last entered sites when
// a runtime trap escapes. Leaf module because the split is real: wasm_run.ts
// must stay binaryen-free, and every other wasm_* module links binaryen.
export const DBGTRACE = process.env["EFTRACE"] === "1";
export const TRACE_SITES: string[] = [];
