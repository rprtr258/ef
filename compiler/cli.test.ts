// CLI integration smoke tests: the executable surface the in-process tests
// (examples.test.ts, wasm.test.ts) cannot see — argv handling, exit codes,
// stdout/stderr formatting, and the usage / type-error / missing-file paths.
// repl/lsp are intentionally untested here: repl is interactive, and lsp is
// exercised by vscode/test/lsp.test.ts over raw stdio.
import {test, expect, describe} from "bun:test";
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const compilerDir = import.meta.dir;

type CliResult = {code: number, stdout: string, stderr: string};

// Bun types the asymmetric matchers as `any`, which trips eslint's
// no-unsafe-assignment rule inside toEqual object literals; these aliases
// pin them to string so the literals typecheck cleanly.
const anyStr = expect.any(String) as string;
const containing = (s: string): string => expect.stringContaining(s) as string;
const matching = (re: RegExp): string => expect.stringMatching(re) as string;

// spawnSync (not execFileSync): the error paths ARE the tested behavior, so
// non-zero exits must come back as data instead of exceptions.
function cli(...args: string[]): CliResult {
  return cliIn({}, ...args);
}

function cliIn(extraEnv: Record<string, string>, ...args: string[]): CliResult {
  // FORCE_COLOR=0 pins the child's styling off: under a TTY, bun test
  // --parallel injects FORCE_COLOR=1 into its worker processes, the
  // inherited env reaches this child, and cli.ts's styleText honors
  // FORCE_COLOR even over a piped stdout — the exact-match assertions
  // below would then fail only when the suite runs in a terminal.
  // (NO_COLOR does not override FORCE_COLOR in bun's styleText.)
  const r = spawnSync("bun", ["run", "cli.ts", ...args], {
    encoding: "utf8",
    cwd: compilerDir,
    env: {...process.env, FORCE_COLOR: "0", ...extraEnv},
  });
  return {code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr};
}

describe("cli", () => {
  test("run: executes an example; no result echo (entries are unit)", () => {
    expect(cli("run", join(compilerDir, "..", "examples", "simple_add.ef"))).toEqual({
      code: 0,
      stdout: "2\n",
      stderr: "",
    });
  });

  test("run: a non-unit entrypoint exits 1 with the gate message", () => {
    // pipeline.ts's requireUnitEntry — run/runWasm are file entrypoints, so
    // the last expression must be unit-typed (playground/src/bridge.ts's
    // isEntryFile applies the same rule to the studio's run/build actions).
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-entry.ef`);
    writeFileSync(file, "1 + 1\n");
    try {
      expect(cli("run", file)).toEqual({
        code: 1,
        stdout: "",
        stderr: containing("entrypoint must return unit"),
      });
      expect(cli("runwasm", file)).toEqual({
        code: 1,
        stdout: "",
        stderr: containing("entrypoint must return unit"),
      });
    } finally {
      rmSync(file, {force: true});
    }
  }, 15000); // two spawns + wasm compile; the 5s default flakes under parallel load

  test("runwasm: same full result as the interpreter for the same example", () => {
    const file = join(compilerDir, "..", "examples", "two_prints.ef");
    expect(cli("runwasm", file)).toEqual(cli("run", file));
  }, 15000); // two spawns + wasm compile; the 5s default flakes under parallel load

  test("runwasm: EFTRACE=1 dumps the traced-site ring to stderr", () => {
    // 5000 g-entries push the ring past its 4096 cap, exercising the shift.
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-trace.ef`);
    writeFileSync(file, `g :: fn(x: i64): i64 { x + 1 };
f :: fn(): i64 {
  i := 0;
  s := 0;
  while (i < 5000) { s = s + g(i); i = i + 1 };
  s
};
Println!(f())
`);
    try {
      // The trace-dump body and the program's result value are dynamic;
      // code and the trace header are pinned.
      expect(cliIn({EFTRACE: "1", EFTRACE_ALL: "1"}, "runwasm", file)).toEqual({
        code: 0,
        stdout: anyStr,
        stderr: containing("[EFTRACE] all sites:"),
      });
      expect(cliIn({EFTRACE: "1"}, "runwasm", file)).toEqual({
        code: 0,
        stdout: anyStr,
        stderr: containing("[EFTRACE] last sites:"),
      });
    } finally {
      rmSync(file, {force: true});
    }
  }, 15000); // two spawns + wasm compile; the 5s default flakes under parallel load

  test("run: passes program args through to the program", () => {
    // Program args are everything after the source path — the `run`
    // subcommand and the file never reach args(). No examples/*.ef takes
    // args deterministically (approx_pi needs the Random! seed pin, star
    // loops forever), so argv plumbing is probed with a throwaway program.
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-args.ef`);
    writeFileSync(file, "argv :: args();\nPrintln!(len(argv));\nPrintln!(get(argv, 0));\n");
    try {
      expect(cli("run", file, "1", "2")).toEqual({
        code: 0,
        stdout: "2\n\"1\"\n",
        stderr: "",
      });
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("run: the example's own usage check exits 1 with its message", () => {
    // approx_pi exits 1 via Exit! when argv lacks <n>; the message reaches
    // stdout through Out!, the code through the process exit status.
    expect(cli("run", join(compilerDir, "..", "examples", "approx_pi.ef"))).toEqual({
      code: 1,
      stdout: "Usage: ef run examples/approx_pi.ef <n>\n",
      stderr: "",
    });
  });

  test("wasm: writes a valid .wasm module to the requested path", () => {
    const out = join(tmpdir(), `ef-cli-test-${process.pid}.wasm`);
    try {
      expect(cli("wasm", join(compilerDir, "..", "examples", "squares_sum.ef"), out)).toEqual({
        code: 0,
        stdout: matching(/^wrote .* \(\d+ bytes\)\n$/),
        stderr: "",
      });
      expect(WebAssembly.validate(readFileSync(out))).toBe(true);
    } finally {
      rmSync(out, {force: true});
    }
  });

  test("runwasm/wasm: the unified unhandled-op gate exits 1 and emits nothing", () => {
    // The static gate (pipeline.ts's rejectUnhandled) covers both wasm
    // entries: runwasm rejects before running, wasm before emitting —
    // the same ops `ef run` rejects.
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-unhandled.ef`);
    const out = join(tmpdir(), `ef-cli-test-${process.pid}-unhandled.wasm`);
    writeFileSync(file, "effect T(x: i64): unit;\nT!(1)\n");
    try {
      expect(cli("runwasm", file)).toEqual({
        code: 1,
        stdout: "",
        stderr: containing("Unhandled effect: T"),
      });
      expect(cli("wasm", file, out)).toEqual({
        code: 1,
        stdout: "",
        stderr: containing("Unhandled effect: T"),
      });
      expect(existsSync(out)).toBe(false); // nothing emitted
    } finally {
      rmSync(file, {force: true});
      rmSync(out, {force: true});
    }
  }, 15000); // two spawns + wasm compile; the 5s default flakes under parallel load

  test("runwasm: a prebuilt .wasm produces the same stdout as compiling from source", () => {
    // build→run roundtrip: the module carries its own ops table (ef_ops
    // custom section), so the binaryen-free runModule path executes it with
    // nothing else on disk.
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-pre.ef`);
    const out = join(tmpdir(), `ef-cli-test-${process.pid}-pre.wasm`);
    writeFileSync(file, "f :: fn(n: i64): i64 { n * 2 };\nPrintln!(f(21))\n");
    try {
      expect(cli("wasm", file, out)).toEqual({
        code: 0,
        stdout: matching(/^wrote .* \(\d+ bytes\)\n$/),
        stderr: "",
      });
      expect(existsSync(out.replace(/\.wasm$/, "") + ".ops.json")).toBe(false); // self-contained: no sidecar
      expect(cli("runwasm", out)).toEqual(cli("runwasm", file));
    } finally {
      rmSync(file, {force: true});
      rmSync(out, {force: true});
    }
  }, 15000); // two spawns + wasm compile; the 5s default flakes under parallel load

  test("runwasm: a .wasm without an embedded ops table exits 1 with a rebuild hint", () => {
    // A bare module (no ef_ops custom section) cannot run: the wasm
    // pipeline tree-shakes builtin ops, so the module alone does not
    // determine the op table.
    const out = join(tmpdir(), `ef-cli-test-${process.pid}-noops.wasm`);
    writeFileSync(out, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0]));
    try {
      expect(cli("runwasm", out)).toEqual({
        code: 1,
        stdout: "",
        // The full rebuild-hint message (cli.ts throws it verbatim, with
        // the path prefix) — subsumes both former toContain probes.
        stderr: containing("no embedded ops table (ef_ops custom section) — rebuild with ef wasm"),
      });
    } finally {
      rmSync(out, {force: true});
    }
  });

  test("types: prints top-level bindings and the program type", () => {
    expect(cli("types", join(compilerDir, "..", "examples", "simple_add.ef"))).toEqual({
      code: 0,
      stdout:
        "id : (a) -> a\n" +
        "x : (i64, i64) -> i64\n" +
        "q : ((a) -> b ! { e1 }, (c) -> a ! { e2 }) -> (c) -> b ! { e1, e2 }\n" +
        "_ : unit ! { Println }\n",
      stderr: "",
    });
  });

  test("lint: reports no issues on a clean example", () => {
    expect(cli("lint", join(compilerDir, "..", "examples", "simple_add.ef"))).toEqual({
      code: 0,
      stdout: "no issues\n",
      stderr: "",
    });
  });

  test("lint: unused argument exits 1 and names the offender", () => {
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-unused.ef`);
    writeFileSync(file, "f :: fn(x: i64): i64 { 1 };\nf(2)\n");
    try {
      expect(cli("lint", file)).toEqual({
        code: 1,
        stdout: matching(/unused-arg: function `f` has unused argument x/),
        stderr: "",
      });
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("lint: derived-any binding exits 1 and names the binding", () => {
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-any.ef`);
    writeFileSync(file, "pull :: fn(x: any): any { x };\ny := pull(1);\n");
    try {
      expect(cli("lint", file)).toEqual({
        code: 1,
        stdout: matching(/derived-any: `y` is inferred as any/),
        stderr: "",
      });
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("run: a missing file exits 1 with diagnostics on stderr", () => {
    // Regression snapshot of the whole result: code, stdout and the full
    // diagnostic text (path interpolation included) are pinned; edits must
    // update the snapshot intentionally (bun test -u).
    expect(cli("run", "/nonexistent/ef-cli-test-missing.ef")).toMatchSnapshot();
  });

  test("run: a type error exits 1 without stdout, located on stderr", () => {
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-typeerr.ef`);
    writeFileSync(file, "1 + true\n");
    try {
      // The `+` app starts at its left operand — line 1, col 1; the line
      // is quoted with a caret under the column, then the located message.
      expect(cli("run", file)).toEqual({
        code: 1,
        stdout: "",
        stderr:
          "1 | 1 + true\n" +
          "  | ^\n" +
          "at line 1, col 1: +: i64 and bool are not both numeric or both string\n",
      });
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("run: a parse error exits 1 with the offending token's position", () => {
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-parseerr.ef`);
    writeFileSync(file, "x :: 1\ny :: 2;\n");
    try {
      // The missing `;` is discovered at `y` — line 2, col 1.
      expect(cli("run", file)).toEqual({
        code: 1,
        stdout: "",
        stderr:
          `2 | y :: 2;\n` +
          `  | ^\n` +
          `at line 2, col 1: Expected ";", got "y"\n`,
      });
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("no/unknown subcommand: usage on stderr, exit 2", () => {
    // Regression snapshot of the whole result (help text included): edits
    // to the command table must update the snapshot intentionally
    // (bun test -u), so an accidental reflow or dropped row fails CI. The
    // unknown-subcommand path must return the exact same result.
    expect(cli()).toMatchSnapshot();
    expect(cli("bogus")).toEqual(cli());
  }, 15000); // three spawns
});
