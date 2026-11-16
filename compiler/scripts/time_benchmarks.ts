#!/usr/bin/env bun
// Benchmark timing over benchmarks/*.ef at the parity-test inputs, through
// the CLI (run + runwasm), one measured repetition each.
import {readdirSync} from "node:fs";
import {join} from "node:path";

const dir = process.argv[2] ?? "benchmarks";
const cli = join(import.meta.dir, "../cli.ts");
const root = process.cwd();

// Parity-test inputs (parity.test.ts's BENCHMARKS table) — the bench-sized
// defaults are far too slow for quick A/B passes.
const INPUTS: Record<string, string[]> = {
  "boy.ef": [], "countdown.ef": ["1000"], "fib.ef": [], "fib_recursive.ef": ["15"],
  "forward.ef": [], "generator.ef": ["10"], "handler_sieve.ef": ["500"],
  "handlers.ef": [], "iterator.ef": ["1000"], "loop.ef": ["100000"],
  "nqueens.ef": ["6"], "parsing_dollars.ef": ["100"], "product_early.ef": ["100"],
  "ray.ef": [], "resume_nontail.ef": ["50"], "sieve.ef": [],
  "tree_explore.ef": ["8"], "triples.ef": ["50", "50"],
};

function time(args: string[]): number {
  const t0 = performance.now();
  const p = Bun.spawnSync(["bun", cli, ...args], {cwd: root, stdout: "ignore", stderr: "ignore"});
  const dt = performance.now() - t0;
  return p.exitCode === 0 ? dt : -1;
}

for (const f of readdirSync(dir).sort()) {
  if (!f.endsWith(".ef")) continue;
  const args = INPUTS[f] ?? [];
  const path = join(dir, f);
  const tR = time(["run", path, ...args]);
  const tW = time(["runwasm", path, ...args]);
  console.log(`${f}\tinterp=${tR.toFixed(0)}ms\twasm=${tW.toFixed(0)}ms`);
}
