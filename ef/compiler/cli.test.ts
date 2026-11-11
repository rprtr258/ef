// CLI integration smoke tests: the executable surface the in-process tests
// (examples.test.ts, wasm.test.ts) cannot see — argv handling, exit codes,
// stdout/stderr formatting, and the usage / type-error / missing-file paths.
// repl/lsp are intentionally untested here: repl is interactive, and lsp is
// exercised by vscode/test/lsp.test.ts over raw stdio.
import {test, expect, describe} from "bun:test";
import {spawnSync} from "node:child_process";
import {readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const compilerDir = import.meta.dir;

type CliResult = {code: number, stdout: string, stderr: string};

// spawnSync (not execFileSync): the error paths ARE the tested behavior, so
// non-zero exits must come back as data instead of exceptions.
function cli(...args: string[]): CliResult {
  // FORCE_COLOR=0 pins the child's styling off: under a TTY, bun test
  // --parallel injects FORCE_COLOR=1 into its worker processes, the
  // inherited env reaches this child, and cli.ts's styleText honors
  // FORCE_COLOR even over a piped stdout — the exact-match assertions
  // below would then fail only when the suite runs in a terminal.
  // (NO_COLOR does not override FORCE_COLOR in bun's styleText.)
  const r = spawnSync("bun", ["run", "cli.ts", ...args], {
    encoding: "utf8",
    cwd: compilerDir,
    env: {...process.env, FORCE_COLOR: "0"},
  });
  return {code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr};
}

describe("cli", () => {
  test("run: executes an example and prints the result", () => {
    const r = cli("run", join(compilerDir, "..", "examples", "simple_add.ef"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\nunit\n");
  });

  test("runwasm: same stdout as the interpreter for the same example", () => {
    const file = join(compilerDir, "..", "examples", "two_prints.ef");
    expect(cli("runwasm", file).stdout).toBe(cli("run", file).stdout);
  }, 15000); // two spawns + wasm compile; the 5s default flakes under parallel load

  test("run: passes program args through to the program", () => {
    // No examples/*.ef takes args deterministically (approx_pi needs the
    // Random! seed pin, star loops forever), so argv plumbing is probed
    // with a throwaway program. Its argv counts the `run` subcommand —
    // the quirk examples/approx_pi.ef relies on — hence len 4 for two
    // program args, with index 2 holding the first of them.
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-args.ef`);
    writeFileSync(file, "argv :: args();\nPrintln!(len(argv));\nPrintln!(get(argv, 2));\n");
    try {
      const r = cli("run", file, "1", "2");
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("4\n\"1\"\nunit\n");
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("run: the example's own usage check exits 1 with its message", () => {
    // approx_pi exits 1 via Exit! when argv lacks <n>; the message reaches
    // stdout through Out!, the code through the process exit status.
    const r = cli("run", join(compilerDir, "..", "examples", "approx_pi.ef"));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("Usage: ef run examples/approx_pi.ef <n>\n");
  });

  test("buildwasm: writes a valid .wasm module to the requested path", () => {
    const out = join(tmpdir(), `ef-cli-test-${process.pid}.wasm`);
    try {
      const r = cli("buildwasm", join(compilerDir, "..", "examples", "squares_sum.ef"), out);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^wrote .* \(\d+ bytes\)\n$/);
      expect(WebAssembly.validate(readFileSync(out))).toBe(true);
    } finally {
      rmSync(out, {force: true});
    }
  });

  test("types: prints top-level bindings and the program type", () => {
    const r = cli("types", join(compilerDir, "..", "examples", "simple_add.ef"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "id : (a) -> a\n" +
      "x : (i64, i64) -> i64\n" +
      "q : ((a) -> b, (c) -> a) -> (c) -> b\n" +
      "_ : unit ! { Println }\n",
    );
  });

  test("lint: reports no issues on a clean example", () => {
    const r = cli("lint", join(compilerDir, "..", "examples", "simple_add.ef"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no issues\n");
  });

  test("lint: unused argument exits 1 and names the offender", () => {
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-unused.ef`);
    writeFileSync(file, "f :: fn(x: i64): i64 { 1 };\nf(2)\n");
    try {
      const r = cli("lint", file);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("unused-arg");
      expect(r.stdout).toContain("has unused argument x");
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("run: a missing file exits 1 with diagnostics on stderr", () => {
    const r = cli("run", "/nonexistent/ef-cli-test-missing.ef");
    expect(r.code).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("run: a type error exits 1 without stdout, located on stderr", () => {
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-typeerr.ef`);
    writeFileSync(file, "1 + true\n");
    try {
      const r = cli("run", file);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      // The `+` app starts at its left operand — line 1, col 1; the line
      // is quoted with a caret under the column, then the located message.
      expect(r.stderr).toBe(
        "1 | 1 + true\n" +
        "  | ^\n" +
        "at line 1, col 1: +: i64 and bool are not both numeric or both string\n");
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("run: a parse error exits 1 with the offending token's position", () => {
    const file = join(tmpdir(), `ef-cli-test-${process.pid}-parseerr.ef`);
    writeFileSync(file, "x :: 1\ny :: 2;\n");
    try {
      const r = cli("run", file);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      // The missing `;` is discovered at `y` — line 2, col 1.
      expect(r.stderr).toBe(
        `2 | y :: 2;\n` +
        `  | ^\n` +
        `at line 2, col 1: Expected ";", got "y"\n`);
    } finally {
      rmSync(file, {force: true});
    }
  });

  test("no/unknown subcommand: usage on stderr, exit 2", () => {
    expect(cli().code).toBe(2);
    expect(cli().stderr).toContain("Usage: ef run <file>");
    expect(cli("bogus").code).toBe(2);
    expect(cli("bogus").stderr).toContain("Usage: ef run <file>");
  }, 15000); // two spawns
});
