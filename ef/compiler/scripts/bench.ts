// In-process benchmark for the wasm backend: compile each program once,
// run the module many times, report min/median wall time and the computed
// value (values must match across revisions — they pin correctness of the
// comparison). Usage:
//   bun compiler/scripts/bench.ts [--runs N] [--warmup N] [--dir DIR] [--json]
//
// Compare two revisions by running this script in a workspace of each and
// diffing the JSON outputs.
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {compileWithOps} from "../wasm.ts";
import {runModule} from "../wasm_host.ts";
import {show} from "../env.ts";

const args = Bun.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const RUNS = Number(opt("--runs", "7"));
const WARMUP = Number(opt("--warmup", "2"));
const DIR = join(import.meta.dir, "..", "..", opt("--dir", "benchmarks"));
const JSON_OUT = args.includes("--json");

const files = readdirSync(DIR).filter(f => f.endsWith(".ef")).sort();
if (files.length === 0)
  throw new Error(`no .ef programs in ${DIR}`);

const rows: {name: string, min: number, median: number, value: string}[] = [];
for (const file of files) {
  const src = readFileSync(join(DIR, file), "utf8");
  const {bytes, ops} = compileWithOps(src);
  const value = show(runModule(bytes, ops));
  for (let i = 0; i < WARMUP; i++)
    runModule(bytes, ops);
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    Bun.gc(true);
    const t0 = performance.now();
    runModule(bytes, ops);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const min = samples[0];
  const median = samples[Math.floor(samples.length / 2)];
  rows.push({name: file, min, median, value});
  if (!JSON_OUT)
    console.log(`${file.padEnd(14)} min ${min.toFixed(1).padStart(8)} ms  median ${median.toFixed(1).padStart(8)} ms  = ${value}`);
}
if (JSON_OUT)
  console.log(JSON.stringify(rows, null, 2));
