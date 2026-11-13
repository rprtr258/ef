// One program-preparation seam for the frontend's consumers in compiler/ —
// both backends, the CLI's types view, the LSP, the REPL, and the tests
// (the playground still composes parse+check itself; see plan chunk 2.4): parse,
// then typecheck against an optional accumulator (the REPL accumulate
// protocol). Consumers add their own passes on top of the returned pair:
// eval seeds referenced builtins and drives the CPS term; wasm tree-shakes
// and emits code.
import {Parser, type Program} from "./parser.ts";
import {checkProgram, type Checked} from "./types.ts";
import {globalEnv, type Env} from "./env.ts";
import type {EffectInterp} from "./eval.ts";

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
