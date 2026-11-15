// Aggregate compare.ts's hyperfine CSVs into comparison tables.
//
//   report.ts <results-dir>          (standalone)
//   or import { report } and call with the results dir.
//
// Table B (results/<bench>.csv): every system at the ef-wasm input.
// Table A (results/std-<bench>.csv): compiled systems at suite-standard inputs.
// results/interp-<bench>.csv holds ocaml at the ef-interp input, from which
// report.ts rescales the ef-int column to the wasm input (no linearity
// assumed).
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

type Rows = Record<string, number | undefined>;

// command-substring → system name; FIRST match wins, so ef-wasm's patterns
// precede ef-int's. ef-int's pattern carries a trailing space so it cannot
// match `cli.ts runwasm`, a wasm invocation.
const PREFIXES: [string, string[]][] = [
  ["ocaml", ["bin/ocaml-"]],
  ["koka", ["bin/koka-"]],
  ["effekt", ["bin/effekt-", "benchmarks/effekt/"]],
  ["ef-wasm", ["run_precompiled.ts", "precompile.ts run", "cli.ts runwasm"]],
  ["ef-int", ["cli.ts run "]],
];
const SYSTEMS = ["ocaml", "koka", "effekt", "ef-wasm", "ef-int"];
const STD_SYSTEMS = ["ocaml", "koka", "effekt"];

const BENCHES = ["countdown", "fibonacci_recursive", "product_early", "iterator",
  "nqueens", "generator", "tree_explore", "triples",
  "parsing_dollars", "resume_nontail", "handler_sieve"];
const STD_IN: Record<string, string> = {
  countdown: "200M", fibonacci_recursive: "42", product_early: "100000",
  iterator: "40000000", nqueens: "12", generator: "25",
  tree_explore: "16", triples: "300 300", parsing_dollars: "20000",
  resume_nontail: "20000", handler_sieve: "60000",
};

function load(path: string): Rows {
  const rows: Rows = {};
  const lines = readFileSync(path, "utf8").split("\n");
  const header = lines[0].split(",");
  const meanCol = header.indexOf("mean");
  if (meanCol < 0) return rows;
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const cells = line.split(",").map(c =>
      c.startsWith("\"") && c.endsWith("\"") ? c.slice(1, -1) : c);
    const cmd = cells[0];
    for (const [sysname, pats] of PREFIXES) {
      if (!(sysname in rows) && pats.some(p => cmd.includes(p))) {
        rows[sysname] = parseFloat(cells[meanCol]);
      }
    }
  }
  return rows;
}

export function report(RES: string): void {
  const interp_oc: Record<string, number | undefined> = {};
  if (existsSync(RES)) {
    for (const f of readdirSync(RES)) {
      const m = /^interp-(\w+)\.csv$/.exec(f);
      if (m !== null) interp_oc[m[1]] = load(join(RES, f))["ocaml"];
    }
  }

  const cell = (v: number | undefined, w = 11, dec = 3) =>
    v === undefined ? "—".padStart(w) : v.toFixed(dec).padStart(w);
  const ratio = (v: number | undefined, base: number | undefined) =>
    v === undefined || base === undefined ? "—".padStart(11)
      : `${(v / base).toFixed(1)}×`.padStart(11);

  console.log("benchmark".padEnd(22) + SYSTEMS.map(s => s.padStart(11)).join("") +
    "   (mean seconds; ef-int at its own smaller input)");
  for (const b of BENCHES) {
    const path = join(RES, `${b}.csv`);
    if (!existsSync(path)) continue;
    const rows = load(path);
    console.log(b.padEnd(22) + SYSTEMS.map(s => cell(rows[s])).join(""));
    const base = rows["ocaml"];
    const oc = interp_oc[b];
    if (base !== undefined) {
      console.log("  ×ocaml".padEnd(22) + SYSTEMS.map(s => ratio(rows[s], base)).join(""));
    }
    // oc === 0: hyperfine recorded 0 for too-fast-to-measure interp runs —
    // no usable scaling factor, skip the rescale line.
    if (rows["ef-int"] !== undefined && oc !== undefined && oc > 0 && base !== undefined) {
      const factor = base / oc;
      const norm = rows["ef-int"] * factor;
      console.log(`  ef-int†              ${norm.toFixed(3).padStart(9)} s` +
        `  (rescaled to wasm input ×${factor.toFixed(1)}; ${(norm / base).toFixed(1)}× ocaml)`);
    }
  }

  console.log("\nSuite-standard inputs (compiled systems only), mean seconds:");
  console.log("benchmark".padEnd(22) + "input".padStart(12) +
    STD_SYSTEMS.map(s => s.padStart(10)).join(""));
  for (const b of BENCHES) {
    const path = join(RES, `std-${b}.csv`);
    if (!existsSync(path)) continue;
    const rows = load(path);
    console.log(b.padEnd(22) + STD_IN[b].padStart(12) +
      STD_SYSTEMS.map(s => cell(rows[s], 10)).join(""));
  }
}

if (import.meta.main) {
  report(process.argv[2] ?? "results");
}
