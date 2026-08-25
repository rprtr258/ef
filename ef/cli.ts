// ef CLI. `ef run <file>` typechecks then evaluates a source file.
// `ef repl` starts an interactive REPL with persistent bindings.
import {readFileSync} from "fs";
import { show, run, repl } from "./index.ts";

const [, , cmd, ...rest] = process.argv;

if (cmd === "repl") {
  repl();
} else if (cmd === "run" && rest.length >= 1) {
  const src = readFileSync(rest[0]!).toString();
  const result = run(src);
  if (result !== undefined) console.log(show(result));
} else {
  console.error("Usage: ef run <file> [args...] | ef repl");
  process.exit(2);
}
