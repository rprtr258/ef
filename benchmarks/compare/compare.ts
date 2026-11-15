#!/usr/bin/env bun
// compare.ts — ef vs effect-handlers-bench (OCaml/Koka/Effekt) benchmark harness.
//
// Reproduces the 2026-11-15 comparison from the repo: builds the suite's
// docker images and compiled binaries, generates ef's scaled benchmark
// sources (ef files hardcode inputs), precompiles ef wasm modules, runs
// hyperfine, and prints the comparison tables.
//
// Usage:
//   compare.ts                 # full run: Table B (same inputs) + Table A (suite inputs)
//   compare.ts --quick         # 3 runs instead of 10, Table B only
//   compare.ts --no-docker     # skip compiled systems; ef backends only
//   compare.ts --std           # Table A only
//   compare.ts --bench a b ..  # subset of benchmarks
//
// Environment:
//   EFBENCH_HOME  work dir for clone/images/builds (default /tmp/efbench)
//
// Notes:
//   - Effekt's Dockerfile installs openjdk-19-jre, which Ubuntu 22.04 never
//     shipped (apt exits 100) — auto-patched to openjdk-17-jre on clone.
//   - Koka's resume_nontail at n=20000 segfaults under an 8 MB stack; std
//     runs execute hyperfine under `ulimit -s unlimited`.
//   - Suite benchmark names differ: ef's fib_recursive is the suite's
//     fibonacci_recursive. Effekt lacks generator/handler_sieve.
//   - ef-int runs at smaller "interp" inputs; report.ts rescales its column
//     using ocaml's measured scaling factor between the two input levels.
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const REPO = join(import.meta.dir, "../..");
const EB = process.env["EFBENCH_HOME"] ?? "/tmp/efbench";
const HF_VERSION = "1.19.0";
const IMG = "effecthandlers/effect-handlers";

const ALL_BENCHES = ["countdown", "fib_recursive", "product_early", "iterator",
  "nqueens", "generator", "tree_explore", "triples",
  "parsing_dollars", "resume_nontail", "handler_sieve"];

let runs = 10;
let mode: "full" | "quick" | "std" = "full";
let docker = true;
let benches: string[] = ALL_BENCHES;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--quick") { runs = 3; mode = "quick"; } 
  else if (a === "--std") mode = "std";
  else if (a === "--no-docker") docker = false;
  else if (a === "--bench") {
    benches = [];
    for (i++; i < argv.length && !argv[i].startsWith("--"); i++) benches.push(argv[i]);
    i--;
  } else if (a === "-h" || a === "--help") {
    console.log(readFileSync(import.meta.path, "utf8").match(/\/\/ Usage:[\s\S]*?(?=\nimport )/)![0]);
    process.exit(0);
  } else { console.error(`unknown option: ${a}`); process.exit(2); }
}

const log = (m: string) => console.log(`== ${m}`);
const die = (m: string): never => { console.error(`error: ${m}`); process.exit(1); };

function sh(cmd: string[], quiet = false): number {
  const r = Bun.spawnSync({cmd, stdout: quiet ? "pipe" : "inherit", stderr: quiet ? "pipe" : "inherit"});
  return r.exitCode;
}
const shOut = (cmd: string[]): string | null => {
  const r = Bun.spawnSync({cmd, stdout: "pipe", stderr: "pipe"});
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

// ---------------------------------------------------------------- deps
for (const tool of ["git", "python3"]) {
  if (shOut(["which", tool]) === null) die(`${tool} not found`);
}
if (docker && shOut(["which", "docker"]) === null) die("docker not found (or rerun with --no-docker)");
for (const d of ["bin", "src", "interp", "pre", "results"]) mkdirSync(join(EB, d), {recursive: true});

let HF: string;
if (shOut(["which", "hyperfine"]) !== null) {
  HF = "hyperfine";
} else {
  HF = join(EB, "hyperfine");
  if (!existsSync(HF)) {
    log(`downloading hyperfine ${HF_VERSION}`);
    sh(["bash", "-c",
      `curl -sL "https://github.com/sharkdp/hyperfine/releases/download/v${HF_VERSION}/hyperfine-v${HF_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar xz -C "${EB}" --strip-components=1 "hyperfine-v${HF_VERSION}-x86_64-unknown-linux-gnu/hyperfine"`]);
  }
  if (!existsSync(HF)) die("failed to obtain hyperfine");
}

// ---------------------------------------------------------------- suite clone
const EH = join(EB, "ehb");
if (!existsSync(join(EH, "systems"))) {
  log("cloning effect-handlers-bench");
  if (sh(["git", "clone", "--depth", "1", "https://github.com/effect-handlers/effect-handlers-bench", EH]) !== 0) {
    die("clone failed");
  }
}
const effektDockerfile = join(EH, "systems/effekt/Dockerfile");
if (existsSync(effektDockerfile)) {
  const df = readFileSync(effektDockerfile, "utf8");
  if (df.includes("openjdk-19-jre")) {
    writeFileSync(effektDockerfile, df.replaceAll("openjdk-19-jre", "openjdk-17-jre"));
    log("patched effekt Dockerfile (openjdk-19-jre is not in ubuntu 22.04)");
  }
}

const suiteName = (b: string) => (b === "fib_recursive" ? "fibonacci_recursive" : b);

// ---------------------------------------------------------------- docker images + binaries
const haveImg = (tag: string) => sh(["docker", "image", "inspect", tag], true) === 0;

if (docker) {
  if (!haveImg(`${IMG}:base`)) {
    log("building docker image base");
    sh(["docker", "build", "--build-arg", `UID=${process.getuid?.() ?? 1000}`,
        "--build-arg", `GID=${process.getgid?.() ?? 1000}`, "-t", `${IMG}:base`, join(EH, "systems")]);
  }
  for (const sys of ["ocaml", "koka", "effekt"]) {
    if (!haveImg(`${IMG}:${sys}`)) {
      log(`building docker image ${sys}`);
      sh(["docker", "build", "-t", `${IMG}:${sys}`, join(EH, "systems", sys)]);
    }
    for (const b of benches) {
      const sb = suiteName(b);
      if (sys === "effekt" && (sb === "generator" || sb === "handler_sieve")) continue;
      const dst = join(EB, "bin", `${sys}-${sb}`);
      if (!existsSync(dst)) {
        log(`building ${sys}/${sb}`);
        if (sh(["docker", "run", "--rm", "-v", `${EH}:/source`, `${IMG}:${sys}`,
                "make", "-C", `/source/benchmarks/${sys}/${sb}`, "build"]) !== 0) {
          die(`${sys}/${sb} build failed`);
        }
        copyFileSync(join(EH, "benchmarks", sys, sb, "main"), dst);
      }
    }
  }
}

// ---------------------------------------------------------------- ef sources + wasm
// ef benchmark files hardcode the suite's large inputs (too slow for ef); the
// input site is replaced down to two levels: wasm inputs (ef-wasm rows) and
// interp inputs (ef-int rows). A null pattern copies the source unchanged.
const SCALED: Record<string, {wasm: [string, string] | null, interp: [string, string]}> = {
  countdown:       {wasm: ["200000000", "10000000"],    interp: ["200000000", "1000000"]},
  fib_recursive:   {wasm: ["fib(42)", "fib(36)"],       interp: ["fib(42)", "fib(24)"]},
  product_early:   {wasm: ["i < 100000", "i < 20000"],  interp: ["i < 100000", "i < 1000"]},
  iterator:        {wasm: ["i <= 40000000", "i <= 8000000"], interp: ["i <= 40000000", "i <= 1000000"]},
  nqueens:         {wasm: ["run(12)", "run(10)"],       interp: ["run(12)", "run(8)"]},
  generator:       {wasm: ["gen(25)", "gen(23)"],       interp: ["gen(25)", "gen(17)"]},
  tree_explore:    {wasm: ["paths(16)", "paths(12)"],   interp: ["paths(16)", "paths(10)"]},
  triples:         {wasm: null,                         interp: ["triple(300, 300)", "triple(150, 150)"]},
  parsing_dollars: {wasm: ["fi > 20000", "fi > 5000"],  interp: ["fi > 20000", "fi > 1000"]},
  resume_nontail:  {wasm: ["run(10000, s)", "run(2000, s)"], interp: ["run(10000, s)", "run(400, s)"]},
  handler_sieve:   {wasm: ["sieve(2, 60000, 0)", "sieve(2, 20000, 0)"], interp: ["sieve(2, 60000, 0)", "sieve(2, 5000, 0)"]},
};

const W_IN: Record<string, string> = {
  countdown: "10000000", fib_recursive: "36", product_early: "20000",
  iterator: "8000000", nqueens: "10", generator: "23", tree_explore: "12",
  triples: "300 300", parsing_dollars: "5000", resume_nontail: "2000",
  handler_sieve: "20000",
};
const I_IN: Record<string, string> = {
  countdown: "1000000", fib_recursive: "24", product_early: "1000",
  iterator: "1000000", nqueens: "8", generator: "17", tree_explore: "10",
  triples: "150 150", parsing_dollars: "1000", resume_nontail: "400",
  handler_sieve: "5000",
};
const STD_IN: Record<string, string> = {
  countdown: "200000000", fib_recursive: "42", product_early: "100000",
  iterator: "40000000", nqueens: "12", generator: "25", tree_explore: "16",
  triples: "300 300", parsing_dollars: "20000", resume_nontail: "20000",
  handler_sieve: "60000",
};

function scaled(b: string, level: "wasm" | "interp"): string {
  const src = readFileSync(join(REPO, "benchmarks", `${b}.ef`), "utf8");
  const pat = SCALED[b][level];
  if (pat === null) return src;
  const [from, to] = pat;
  if (!src.includes(from)) die(`benchmarks/${b}.ef: input pattern '${from}' not found — file drifted, update SCALED`);
  return src.replaceAll(from, to);
}

for (const b of benches) {
  writeFileSync(join(EB, "src", `${b}.ef`), scaled(b, "wasm"));
  writeFileSync(join(EB, "interp", `${b}.ef`), scaled(b, "interp"));
}
log("precompiling ef wasm modules");
// The map's result is hoisted to a variable: bun's parser (1.4.4) chokes on a
// nested template literal in trailing position of a nested call argument.
const preSpecs = benches.map(b => `${b}=${join(EB, "src", `${b}.ef`)}`);
if (sh(["bun", join(REPO, "benchmarks/compare/precompile.ts"), "build", join(EB, "pre"),
        ...preSpecs]) !== 0) {
  die("precompile failed");
}

// Cross-check ef's output against the ocaml reference at the same input
// (skipped under --no-docker). Mismatch aborts the run.
if (docker) {
  for (const b of benches) {
    const oc = shOut([join(EB, "bin", `ocaml-${suiteName(b)}`), ...W_IN[b].split(" ")]);
    const ef = shOut(["bun", join(REPO, "benchmarks/compare/precompile.ts"), "run", join(EB, "pre", b)]);
    if (oc !== ef) die(`output mismatch on ${b}: ocaml='${oc}' ef='${ef}'`);
  }
  log("output cross-check vs ocaml: all match");
}

// ---------------------------------------------------------------- hyperfine
function hb(csv: string, cmds: string[], unlimitedStack = false): boolean {
  const args = ["--warmup", "1", "--runs", String(runs), "--style", "none", "--export-csv", csv, ...cmds];
  const r = unlimitedStack
    // koka's resume_nontail at n=20000 overflows an 8 MB stack
    ? Bun.spawnSync({cmd: ["bash", "-c", "ulimit -s unlimited 2>/dev/null || true; exec \"$0\" \"$@\"", HF, ...args],
                     stdout: "ignore", stderr: "inherit"})
    : Bun.spawnSync({cmd: [HF, ...args], stdout: "ignore", stderr: "inherit"});
  return r.exitCode === 0;
}

if (mode !== "std") {
  for (const b of benches) {
    const sb = suiteName(b);
    const w = W_IN[b];
    // effekt triples takes a single argument; effekt lacks generator/handler_sieve
    const effW = b === "triples" ? "300" : w;
    const hasEffekt = !(b === "generator" || b === "handler_sieve");
    const cmds: string[] = [];
    if (docker) {
      cmds.push(`${join(EB, "bin", `ocaml-${sb}`)} ${w}`,
                `${join(EB, "bin", `koka-${sb}`)} ${w}`);
      if (hasEffekt) cmds.push(`${join(EB, "bin", `effekt-${sb}`)} ${effW}`);
    }
    cmds.push(`bun ${join(REPO, "benchmarks/compare/precompile.ts")} run ${join(EB, "pre", b)}`,
              `bun ${join(REPO, "compiler/cli.ts")} run ${join(EB, "interp", `${b}.ef`)}`);
    log(`bench ${b} (wasm input: ${w})`);
    if (!hb(join(EB, "results", `${sb}.csv`), cmds)) {
      log(`WARN: ${b} partially failed (see results/${b}.csv rows)`);
    }
    if (docker) { // ocaml at the interp input, for rescaling ef-int
      hb(join(EB, "results", `interp-${sb}.csv`), [`${join(EB, "bin", `ocaml-${sb}`)} ${I_IN[b]}`]);
    }
  }
}

if (mode !== "quick") {
  if (!docker) {
    log("skipping Table A (--no-docker)");
  } else for (const b of benches) {
    const sb = suiteName(b);
    const s = STD_IN[b];
    const effS = b === "triples" ? "300" : s;
    log(`bench ${b} (suite input: ${s})`);
    if (!hb(join(EB, "results", `std-${sb}.csv`),
            [`${join(EB, "bin", `ocaml-${sb}`)} ${s}`,
             `${join(EB, "bin", `koka-${sb}`)} ${s}`,
             ...(b === "generator" || b === "handler_sieve" ? [] :
                 [`${join(EB, "bin", `effekt-${sb}`)} ${effS}`])], true)) {
      log(`WARN: std-${b} partially failed`);
    }
  }
}

// ---------------------------------------------------------------- report
console.log();
const {report} = await import("./report.ts");
report(join(EB, "results"));
console.log(`\nCSVs: ${join(EB, "results")}/`);
