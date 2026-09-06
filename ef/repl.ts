import * as readline from "node:readline";
import {runTop, evalE} from "./eval.ts";
import {globalEnv, show, type Value} from "./env.ts";
import {checkProgram, res, showT} from "./types.ts";
import {Parser, type Expr} from "./parser.ts";

// repl: an interactive read-eval-print loop. State (runtime env + type env +
// effect signatures) persists across lines, so `let`/`effect` bindings
// accumulate. Each line is parsed and evaluated as a complete program; ef is
// newline-insensitive so multi-statement blocks fit on one line. Echoes the
// value and inferred type of a bare expression; declarations print nothing.
export function repl(): void {
  const g = globalEnv();
  const acc = checkProgram([]); // seeded with builtins; extended incrementally
  const rl = readline.createInterface({input: process.stdin, output: process.stdout, prompt: "ef> "});
  const evalLine = (src: string): void => {
    const items = new Parser(src).parseProgram();
    const {lastType} = checkProgram(items, acc);
    let last: Value = null;
    for (const it of items)
      if ("e" in it)
        last = runTop(evalE(it.e, g, (v) => ({tag: "done", value: v})));
    const tail = items[items.length - 1];
    const isExpr = tail && "e" in tail && tail.e.t !== "let";
    if (isExpr && last !== null)
      console.log(show(last) + " : " + showT(res(lastType)));
  };
  console.log("ef REPL — type :q to quit");
  rl.prompt();
  rl.on("line", (line) => {
    const s = line.trimEnd();
    if (s === ":q" || s === ":quit") {
      rl.close();
      return;
    }
    if (s === "") {
      rl.prompt();
      return;
    }
    const src = /[;{}]$/.test(s) ? s : s + ";";
    try { evalLine(src); }
    catch (e) { console.log(String((e as {message?: string}).message ?? e)); }
    rl.prompt();
  });
  rl.on("close", () => { process.stdout.write("\n"); process.exit(0); });
}
