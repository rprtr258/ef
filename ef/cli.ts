// ef CLI. `ef run <file>` typechecks then evaluates a source file.
// `ef types <file>` prints every top-level symbol and its inferred type.
// `ef repl` starts an interactive REPL with persistent bindings.
import {readFileSync} from "fs";
import {styleText} from "util";
import {run} from "./eval.ts";
import {type Type, showT, checkProgram, res} from "./types.ts";
import {lint} from "./lint.ts";
import {repl} from "./repl.ts";
import {show} from "./env.ts";
import {Parser, type Expr} from "./parser.ts";

// types: typecheck a source file and print every top-level symbol (let)
// along with its inferred type, one per line as `name : type`.
export function types(src: string): {name: string, type: Type}[] {
  const items = new Parser(src).parseProgram();
  const {env} = checkProgram(items);
  const names: string[] = items
    .filter((it): it is {e: Expr & {t: "let"}} => "e" in it && it.e.t === "let")
    .map(it => it.e.name);
  return names.map(n => {
    const t = env.lookup(n);
    return {name: n, type: res(typeof t === "function" ? t() : t!)};
  });
}

function main(cmd: string, args: string[]) {
  switch (cmd) {
  case "repl":
    repl();
    return;
  case "run": {
    if (args.length === 0) {
      break;
    }

    const src = readFileSync(args[0]).toString();
    const result = run(src);
    console.log(show(result));
    return;
  }
  case "types": {
    if (args.length === 0) {
      break;
    }
    const src = readFileSync(args[0]).toString();
    console.log(types(src).map(({name, type}) => styleText("gray", name) + " : " + showT(type)).join("\n"));
    return;
  }
  case "lint": {
    if (args.length === 0) {
      break;
    }
    const src = readFileSync(args[0]).toString();
    const issues = lint(src);
    if (issues.length === 0) {
      console.log("no issues");
      return;
    }
    for (const i of issues) {
      const loc = i.pos !== undefined ? `${args[0]}:${i.pos.line}:${i.pos.col}: ` : "";
      console.log(`${loc}${styleText("yellow", i.rule)}: ${i.who} has unused argument ${styleText("red", i.argname)}`);
    }
    process.exit(1);
  }
  }
  console.error("Usage: ef run <file> [args...] | ef types <file> | ef lint <file> | ef repl");
  process.exit(2);
}

const [, , cmd, ...rest] = process.argv;
main(cmd, rest);
