// One program-preparation seam for the frontend's consumers in compiler/ —
// both backends, the CLI's types view, the LSP, the REPL, and the tests
// (the playground consumes it too, except its problems/outline paths, which
// need the parse/check split prepare's single throw cannot express, and its
// buildWasm path, which parses once for ops collection): parse,
// then typecheck against an optional accumulator (the REPL accumulate
// protocol). Consumers add their own passes on top of the returned pair:
// eval seeds referenced builtins and drives the CPS term; wasm tree-shakes
// and emits code.
import {Parser, type Program} from "./parser.ts";
import {checkProgram, type Checked} from "./types.ts";
import {globalEnv, type Cont, type Env, type Outcome, type Value} from "./env.ts";

// An effect interpreter: ops it knows map to host actions; unknown ops fall
// through to the builtin table's default interpretation. The one interface
// for both backends' runners — eval.ts's runTop consumes it directly; the
// wasm host (wasm_host.ts) adapts builtins.ts's builtinEffectHosts — each a
// sync Value delivery — to it at its boundary.
export type EffectInterp = Partial<Record<string, (args: Value[], k: Cont) => Outcome>>;

// Pipeline state for incremental execution (REPL): runtime env, checker
// accumulator, and an optional effect-interpretation override.
export type Ctx = {
  env: Env,
  checked: Checked,
  interp?: EffectInterp,
};

// newCtx: fresh pipeline state, seeded with the builtins.
export function newCtx(interp?: EffectInterp): Ctx {
  return {
    // Seeded empty: exec binds exactly the builtins each program references
    // (builtinRefs), matching the wasm module's tree-shaken builtin table.
    env: globalEnv(new Set()),
    checked: checkProgram({nodes: [], items: [], typeToks: [], ends: []}),
    interp,
  };
}

// prepare: parse + typecheck. `acc` is the previous Checked for incremental
// checking (REPL lines re-check against ctx.checked); a type error throws
// here and leaves acc untouched. checked.unhandled carries the residual
// top-level effect rows (the ops that reach the runner).
export function prepare(src: string, acc?: Checked): {prog: Program, checked: Checked} {
  const prog = new Parser(src).parseProgram();
  return {prog, checked: checkProgram(prog, acc)};
}
