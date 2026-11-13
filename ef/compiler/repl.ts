import * as readline from "node:readline";
import {newCtx, exec} from "./eval.ts";
import {prepare} from "./pipeline.ts";
import {show} from "./env.ts";
import {showErr, showT} from "./types.ts";

// repl: an interactive read-eval-print loop. Pipeline state (Ctx: runtime env
// + type env + effect signatures) persists across lines, so `let`/`effect`
// bindings accumulate. Each line is parsed and executed as a complete
// program; ef is newline-insensitive so multi-statement blocks fit on one
// line. Echoes the value and inferred type of a bare expression;
// declarations print nothing.
export function repl(): void {
  const ctx = newCtx();
  const rl = readline.createInterface({input: process.stdin, output: process.stdout, prompt: "ef> "});
  const evalLine = (src: string): void => {
    // prepare checks against ctx's accumulator; a type error throws here and
    // leaves ctx.checked untouched.
    const {prog, checked} = prepare(src, ctx.checked);
    const {value, lastType, lastIsExpr} = exec(prog, ctx, checked);
    if (lastIsExpr && value !== null)
      console.log(show(value) + " : " + showT(lastType));
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
    catch (e) { console.log(showErr(e, src)); }
    rl.prompt();
  });
  rl.on("close", () => { process.stdout.write("\n"); process.exit(0); });
}
