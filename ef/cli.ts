// ef CLI. `ef run <file>` typechecks then evaluates a source file.
// `ef types <file>` prints every top-level symbol and its inferred type.
// `ef repl` starts an interactive REPL with persistent bindings.
import {readFileSync} from "fs";
import { show, run, types, repl } from "./index.ts";

function main(cmd: string, args: string[]) {
  switch (cmd) {
  case "repl":
    repl();
    return;
  case "run": {
    if (args.length == 0) {
      break;
    }

    const src = readFileSync(args[0]!).toString();
    const result = run(src);
    if (result !== undefined) console.log(show(result));
    return;
  }
  case "types": {
    if (args.length == 0) {
      break;
    }
    const src = readFileSync(args[0]!).toString();
    console.log(types(src));
    return;
  }
  }
  console.error("Usage: ef run <file> [args...] | ef types <file> | ef repl");
  process.exit(2);
}

const [, , cmd, ...rest] = process.argv;
main(cmd!, rest);
