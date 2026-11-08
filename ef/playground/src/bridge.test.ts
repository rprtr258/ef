import {describe, expect, test} from "bun:test";
import {showT} from "../../compiler/types.ts";

import {
  buildWasm, browserInterp, concatProject, entryFile, interpret, isEntryFile,
  outline, problems, runWasmProgram, tokenize, ExitSignal,
} from "./bridge.ts";

describe("bridge", () => {
  test("interpret streams Println!/Out! and returns the program value", () => {
    let buf = "";
    const r = interpret("Println!([1, 2]);\nOut!(\"raw\");\n1 + 2", (s) => {
      buf += s;
    });
    expect(buf).toBe("[1, 2]\nraw");
    expect(r.value).toBe(3);
    // ops are a typecheck byproduct, reported without a build
    expect(r.ops).toEqual(["Println", "Out"]);
  });

  test("custom effects are interpreted by handlers, not the host", () => {
    let buf = "";
    const src = [
      "effect Ask(who: string): string;",
      "let hi = handle { \"hi, \" + Ask!(\"ef\") } case Ask(w) => k { k(w) };",
      "Println!(hi);",
    ].join("\n");
    interpret(src, (s) => {
      buf += s;
    });
    expect(buf).toBe("\"hi, ef\"\n");
  });

  test("Exit! unwinds with an ExitSignal", () => {
    let buf = "";
    expect(() => interpret("Out!(\"a\");\nExit!(3);", (s) => {
      buf += s;
    })).toThrow(ExitSignal);
    expect(buf).toBe("a");
  });

  test("parse and type errors surface as problems", () => {
    expect(problems("let x = ;")[0]?.stage).toBe("parse");
    expect(problems("1 + true")[0]?.stage).toBe("check");
    expect(problems("let f = fn(x: int): int { x }; f(2)")).toEqual([]);
    // lint: unused argument, with a line number
    const p = problems("let f = fn(unused: int): int { 1 };\nf(2)");
    expect(p[0]?.stage).toBe("lint");
    expect(p[0]?.line).toBe(1);
  });

  test("wasm backend emits bytes and reports performed ops (typecheck byproduct)", async () => {
    const {bytes, ops} = await buildWasm("Println!(1 + 2)");
    expect(bytes.length).toBeGreaterThan(0);
    expect(ops).toEqual(["Println"]);
  });

  test("outline, entry detection and project concat", () => {
    const src = [
      "effect Tick(): int;",
      "type Pair = [int, int];",
      "let f = fn(x: int): int ! { Tick } { Tick!(x) };",
      "f(1)",
    ].join("\n");
    const ol = outline(src);
    expect(ol.map((o) => `${o.kind}:${o.name}`)).toEqual([
      "effect:Tick", "type:Pair", "fn:f",
    ]);
    expect(ol[0]?.line).toBe(1);
    expect(ol[1]?.line).toBe(2);
    expect(ol[2]?.line).toBe(3);
    expect(ol[2]?.effs).toBe("{ Tick }");
    expect(isEntryFile(src)).toBe(true);
    expect(isEntryFile("let x = 1;")).toBe(false);
    expect(entryFile(["let a = 1;", "2 + 2"])).toBe(1);
    expect(concatProject(["a", " b "])).toBe("a\nb");
  });

  test("browser interp works standalone", () => {
    let buf = "";
    const interp = browserInterp((s) => {
      buf += s;
    });
    const out = interp["Out"]!(["x"], () => ({tag: "done", value: null}));
    expect(out).toEqual({tag: "done", value: null});
    expect(buf).toBe("x");
  });

  test("wasm run streams Println!/Out! and returns the program value", () => {
    let buf = "";
    const r = runWasmProgram("Out!(\"raw\");\nPrintln!(1 + 2);\n7", (s) => {
      buf += s;
    });
    expect(buf).toBe("raw3\n");
    expect(r.value).toBe(7);
    expect(showT(r.type)).toBe("int");
    expect(r.ops).toEqual(["Out", "Println"]);
  });

  test("wasm run handles deep recursion (the CPS interpreter overflows V8)", () => {
    const r = runWasmProgram([
      "let fib = fn(n: int): int {",
      "  if (n < 2) { n } else { fib(n - 1) + fib(n - 2) }",
      "};",
      "Println!(fib(27));",
      "0",
    ].join("\n"), () => {});
    expect(r.value).toBe(0);
  });

  test("wasm run: Exit! unwinds with an ExitSignal", () => {
    let buf = "";
    expect(() => runWasmProgram("Out!(\"a\");\nExit!(3);", (s) => {
      buf += s;
    })).toThrow(ExitSignal);
    expect(buf).toBe("a");
  });

  test("wasm run: Wait! busy-waits, Random! goes through the interp", () => {
    const real = Math.random;
    Math.random = () => 0.42;
    try {
      expect(runWasmProgram("Wait!(1); Random!()", () => {}).value).toBe(0.42);
    } finally {
      Math.random = real;
    }
  });

  test("tokenize scopes keywords, strings, tags and comments", () => {
    const toks = tokenize("let s = \"a#b\";  # note\nTick!()");
    expect(toks[0].map((t) => t.scope)).toEqual([
      "keyword", "identifier", "operator", "string", "delimiter", "comment",
    ]);
    expect(toks[1][0].scope).toBe("tag");
  });
});
