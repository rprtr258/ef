// One program-preparation seam for the frontend's consumers in compiler/ —
// both backends, the CLI's types view, the LSP, the REPL, and the tests
// (the playground consumes it too, except its buildWasm path, which parses
// once for ops collection): parse, then typecheck against an optional
// accumulator (the REPL accumulate protocol) — prepare throws,
// prepareStaged reports the failing stage, runLine composes prepare + exec
// into the one REPL line protocol. Consumers add their own passes on top of
// the returned pair: eval seeds referenced builtins and drives the CPS term;
// wasm tree-shakes and emits code.
import {Parser, type Program} from "./parser.ts";
import {checkProgram, type Checked} from "./types.ts";
import {globalEnv, type Cont, type Env, type Outcome, type Value} from "../env.ts";
import {EFFECT_OPS} from "../builtin_table.ts";
import {errUnhandled} from "../ops.ts";

// An effect interpreter: ops it knows map to host actions; unknown ops fall
// through to the builtin table's default interpretation. The one interface
// for both backends' runners — eval.ts's runTop consumes it directly; the
// wasm host (wasm_host.ts) adapts builtins.ts's builtinEffectHosts — each a
// sync Value delivery — to it at its boundary.
export type EffectInterp = Partial<Record<string, (args: Value[], k: Cont) => Outcome>>;

// Pipeline state for incremental execution (REPL): runtime env, checker
// accumulator, an optional effect-interpretation override, and the program
// args the `args` builtin / ef_args host import report (everything after the
// source path on the CLI; [] for the REPL and direct runner calls).
export type Ctx = {
  env: Env,
  checked: Checked,
  interp?: EffectInterp,
  args: string[],
};

// newCtx: fresh pipeline state, seeded with the builtins.
export function newCtx(interp?: EffectInterp, args: string[] = []): Ctx {
  return {
    // Seeded empty: exec binds exactly the builtins each program references
    // (builtinRefs), matching the wasm module's tree-shaken builtin table.
    env: globalEnv(new Set()),
    checked: checkProgram({nodes: [], locs: [], items: [], typeToks: []}),
    interp,
    args,
  };
}

// prepareStaged: prepare's non-throwing twin — the same two steps, but a
// failure reports its stage instead of throwing. Consumers that need the
// parse/check split use it (the playground's problems pane distinguishes the
// two stages; its outline still lists names when checking fails). A check
// failure still carries the parsed program (parse succeeded); a parse
// failure has none.
type Staged =
  | {ok: true, prog: Program, checked: Checked}
  | {ok: false, stage: "parse", error: unknown}
  | {ok: false, stage: "check", error: unknown, prog: Program};

export function prepareStaged(src: string, acc?: Checked): Staged {
  let prog: Program;
  try {
    prog = new Parser(src).parseProgram();
  } catch (error) {
    return {ok: false, stage: "parse", error};
  }
  try {
    return {ok: true, prog, checked: checkProgram(prog, acc)};
  } catch (error) {
    return {ok: false, stage: "check", error, prog};
  }
}

// prepare: parse + typecheck, throwing on the first failure (the staged
// variant's error rethrown). `acc` is the previous Checked for incremental
// checking (REPL lines re-check against ctx.checked); a type error throws
// here and leaves acc untouched. checked.unhandled carries the residual
// top-level effect rows (the ops that reach the runner).
export function prepare(src: string, acc?: Checked): {prog: Program, checked: Checked} {
  const staged = prepareStaged(src, acc);
  if (!staged.ok) throw staged.error;
  return {prog: staged.prog, checked: staged.checked};
}

// The builtin effect surface (builtin_table.ts's effect rows — the same set
// the runtime table derives its default interpretations from, pinned by
// analysis.test.ts).
const BUILTIN_EFFECTS = new Set(EFFECT_OPS);

// rejectUnhandled: the one fail-fast gate over checked.unhandled, applied by
// both backends at their entry right after prepare (eval.ts's exec — before
// it seeds builtins; wasm.ts's pipeline — before any codegen). An op with no
// matching handler in its subtree (the checker's residual row: ops-minus-
// handled matching through calls) that is neither a builtin effect nor
// covered by the runner's interp override would only surface mid-run, after
// earlier side effects. The message is ops.ts's errUnhandled — the same
// constructor the runners' runtime backstops throw (runTop / wasm_host's
// hostFor).
export function rejectUnhandled(checked: Checked, interp?: EffectInterp): void {
  for (const op of checked.unhandled)
    if (!BUILTIN_EFFECTS.has(op) && interp?.[op] === undefined)
      throw new Error(errUnhandled(op));
}
