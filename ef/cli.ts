// ef CLI. Usage: `ef run <file>` — typecheck then evaluate the source file.
import {readFileSync} from "fs";
import { show, run } from "./index.ts";

const [, , cmd, ...rest] = process.argv;

if (cmd !== "run" || rest.length < 1) {
  console.error("Usage: ef run <file> [args...]");
  process.exit(2);
}

const src = readFileSync(rest[0]!).toString();
const result = run(src);
if (result !== undefined) console.log(show(result));
