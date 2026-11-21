// REPL integration tests over piped stdin: readline behaves the same over a
// pipe as over a TTY, so the per-line pipeline (normalization, runLine, echo)
// is testable without a terminal. Prompt redraws and :commands are out of
// scope here.
import {test, expect, describe} from "bun:test";
import {spawnSync} from "node:child_process";
import {lineSrc} from "./repl.ts";

const compilerDir = import.meta.dir;

describe("repl line normalization", () => {
  test("a bare line takes the item-terminating `;`", () => {
    expect(lineSrc("x := 1")).toBe("x := 1;");
    expect(lineSrc("x")).toBe("x;");
  });

  test("a line already ending in `;` is kept", () => {
    expect(lineSrc("x := 1;")).toBe("x := 1;");
  });

  test("a line still inside an open `{` gets no `;` (block entry)", () => {
    expect(lineSrc("f := fn(): i64 {")).toBe("f := fn(): i64 {");
  });

  test("a balanced trailing `}` is a complete item: it takes the `;`", () => {
    expect(lineSrc("y := { 40 + 2 }")).toBe("y := { 40 + 2 };");
    expect(lineSrc("while (i < 1) { i = i + 1 }")).toBe("while (i < 1) { i = i + 1 };");
  });
});

function replStdin(input: string): string {
  const r = spawnSync("bun", ["run", "cli.ts", "repl"], {
    encoding: "utf8",
    cwd: compilerDir,
    input,
    // FORCE_COLOR=0 pins the child's styling off (see cli.test.ts's cliIn).
    env: {...process.env, FORCE_COLOR: "0"},
  });
  return r.stdout;
}

describe("repl over piped stdin", () => {
  test("braced-RHS binding persists to the next line", () => {
    const out = replStdin("y := { 40 + 2 }\ny\n");
    expect(out).toContain("42 : int");
    expect(out).not.toContain("Unbound");
  });

  test("braced while body still binds through the fix (normalization guard)", () => {
    const out = replStdin("i := 0\nwhile (i < 3) { i = i + 1 }\ni\n");
    expect(out).toContain("3 : int");
    expect(out).not.toContain("Unbound");
  });
});
