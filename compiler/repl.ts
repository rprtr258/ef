import * as readline from "node:readline";
import {runLine, newCtx, type Ctx} from "./backend/interpreter/eval.ts";
import {show} from "./env.ts";
import {showErr, showT} from "./frontend/type_display.ts";
import {envLookupResolved} from "./frontend/unify.ts";
import {BUILTINS} from "./builtin_table.ts";

// repl: an interactive read-eval-print loop. Pipeline state (Ctx: runtime env
// + type env + effect signatures) persists across lines, so `let`/`effect`
// bindings accumulate. Each line is parsed and executed as a complete
// program; ef is newline-insensitive so multi-statement blocks fit on one
// line. Echoes the value and inferred type of a bare expression;
// declarations print nothing.
// :env prints the user bindings accumulated so far, then the builtins. The
// checker's env frame mixes builtins with user bindings (the REPL acc reuses
// the root frame), so user bindings are identified by the builtin-name
// filter — sound because the no-shadowing rule keeps user bindings off
// builtin/operator names.
function showEnv(ctx: Ctx): void {
  const builtins: string[] = [];
  let any = false;
  for (const name of ctx.checked.env.vars.keys()) {
    const entry = name + " : " + showT(envLookupResolved(ctx.checked.env, name));
    if (BUILTINS.some(b => b.name === name)) builtins.push(entry);
    else { any = true; console.log(entry); }
  }
  for (const entry of builtins) console.log(entry);
  if (!any && builtins.length === 0) console.log("(no bindings yet)");
}

// Line normalization: a bare line takes the item-terminating `;`. Lines
// already ending in `;` are kept; a line still inside an open `{`
// (multi-line block entry) gets no `;` so its error points at EOF rather
// than at an injected `;`. A trailing `}` is not exempt: balanced closes
// (`y := { 40 + 2 }`, `while (…) { … }`) are complete items and need the
// item-terminating `;`.
export function lineSrc(s: string): string {
  return /[;{]$/.test(s) ? s : s + ";";
}

export function repl(): void {
  const ctx = newCtx();
  const rl = readline.createInterface({input: process.stdin, output: process.stdout, prompt: "ef> "});
  const evalLine = (src: string): void => {
    // runLine prepares against ctx's accumulator (a type error throws and
    // leaves ctx.checked untouched) and execs; the echo rule prints here.
    const {value, lastType, lastIsExpr} = runLine(ctx, src);
    if (lastIsExpr && value !== null) {
      // Untyped constants echo as num types (int/float), not the width
      // backends lower them to — 42 : int, PI : float.
      const t = ctx.checked.lastNum ?? showT(lastType);
      console.log(show(value) + " : " + t);
    }
  };
  const HELP = [
    "Commands:",
    "  :help   show this help",
    "  :env    show bindings accumulated so far, plus builtins",
    "  :q      quit (also :quit)",
  ].join("\n");
  console.log("ef REPL — type :help for commands, :q to quit");
  rl.prompt();
  rl.on("line", (line) => {
    const s = line.trimEnd();
    if (s === ":q" || s === ":quit") {
      rl.close();
      return;
    }
    if (s === ":help") {
      console.log(HELP);
      rl.prompt();
      return;
    }
    if (s === ":env") {
      showEnv(ctx);
      rl.prompt();
      return;
    }
    if (s === "") {
      rl.prompt();
      return;
    }
    const src = lineSrc(s);
    try { evalLine(src); }
    catch (e) { console.log(showErr(e, src)); }
    rl.prompt();
  });
  rl.on("close", () => { process.stdout.write("\n"); process.exit(0); });
}
