// ef CLI. Usage: `ef run <file>` — typecheck then evaluate the source file.
import {readFileSync} from "fs";
import { show, run } from "./index.ts";

const [, , cmd, ...rest] = process.argv;

if (cmd !== "run" || rest.length !== 1) {
  console.error("Usage: ef run <file>");
  process.exit(2);
}

const src = readFileSync(rest[0]!).toString();
console.log(show(run(src)));
