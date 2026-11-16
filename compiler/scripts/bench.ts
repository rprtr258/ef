// In-process benchmark for both backends: the wasm module (compile once, run
// the module many times) and the CPS interpreter (exec per run in a fresh
// context). exec re-runs toCps per call, so toCps is timed separately and the
// reported eval time is exec − cps — the interpreter drive only, matching the
// wasm side's compile-outside-timing protocol. Reports min/median wall time
// and the computed value per backend; values must match across revisions AND
// backends (enforced) — they pin correctness of the comparison. Usage:
//   bun compiler/scripts/bench.ts [--runs N] [--warmup N] [--dir DIR] [--json]
//
// Compare two revisions by running this script in a workspace of each and
// diffing the JSON outputs.
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {compileWithOps} from "../backend/wasm/wasm.ts";
import {runModule} from "../backend/wasm/wasm_run.ts";
import {prepare} from "../frontend/pipeline.ts";
import {toCps} from "../frontend/cps.ts";
import {newCtx, exec} from "../backend/interpreter/eval.ts";
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

const time = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const stats = (samples: number[]): {min: number, median: number} => {
  samples.sort((a, b) => a - b);
  return {min: samples[0], median: samples[Math.floor(samples.length / 2)]};
};

type Row = {
  name: string,
  value: string,
  wasm: {min: number, median: number},
  interp: {execMin: number, execMedian: number, cpsMedian: number, evalMedian: number},
};
const rows: Row[] = [];
for (const file of files) {
  const src = readFileSync(join(DIR, file), "utf8");
  const pre = prepare(src);
  const {bytes, ops} = compileWithOps(pre);
  const value = show(runModule(bytes, ops));
  toCps(pre.prog, pre.checked.stamps);
  const interpValue = show(exec(pre.prog, newCtx(), pre.checked).value);
  if (interpValue !== value)
    throw new Error(`${file}: backend value mismatch: wasm ${value}, interp ${interpValue}`);
  for (let i = 0; i < WARMUP; i++) {
    runModule(bytes, ops);
    exec(pre.prog, newCtx(), pre.checked);
    toCps(pre.prog, pre.checked.stamps);
  }
  const wasmSamples: number[] = [];
  const execSamples: number[] = [];
  const cpsSamples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    Bun.gc(true);
    wasmSamples.push(time(() => runModule(bytes, ops)));
    Bun.gc(true);
    execSamples.push(time(() => exec(pre.prog, newCtx(), pre.checked)));
    Bun.gc(true);
    cpsSamples.push(time(() => toCps(pre.prog, pre.checked.stamps)));
  }
  const wasm = stats(wasmSamples);
  const execStats = stats(execSamples);
  const cps = stats(cpsSamples);
  const row: Row = {
    name: file,
    value,
    wasm: {min: wasm.min, median: wasm.median},
    interp: {
      execMin: execStats.min,
      execMedian: execStats.median,
      cpsMedian: cps.median,
      evalMedian: execStats.median - cps.median,
    },
  };
  rows.push(row);
  if (!JSON_OUT) {
    console.log(`${file.padEnd(14)} wasm   min ${wasm.min.toFixed(1).padStart(9)} ms  median ${wasm.median.toFixed(1).padStart(9)} ms  = ${value}`);
    console.log(`${"".padEnd(14)} interp min ${row.interp.execMin.toFixed(1).padStart(9)} ms  median ${row.interp.execMedian.toFixed(1).padStart(9)} ms  eval ${row.interp.evalMedian.toFixed(1).padStart(9)} ms`);
  }
}
if (JSON_OUT)
  console.log(JSON.stringify(rows, null, 2));
