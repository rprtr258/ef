import {describe, expect, test} from "bun:test";
import {showT} from "../../compiler/frontend/type_display.ts";

import {
  buildWasm, browserInterp, interpret, isEntryFile, outline, problems,
  runWasmProgram, tokenize, topLevelEffs, ExitSignal,
} from "./bridge.ts";

describe("bridge", () => {
  test("interpret streams Println!/Out! and returns the program value", () => {
    let buf = "";
    const r = interpret("Println!([1, 2]);\nOut!(\"raw\");\n1 + 2", (s) => {
      buf += s;
    });
    expect(buf).toBe("[1, 2]\nraw");
    expect(r.value).toBe(3n);
    // ops are a typecheck byproduct, reported without a build
    expect(r.ops).toEqual(["Println", "Out"]);
  });

  test("custom effects are interpreted by handlers, not the host", () => {
    let buf = "";
    const src = [
      "effect Ask(who: string): string;",
      "hi :: handle { \"hi, \" + Ask!(\"ef\") } case Ask(w) => k { k(w) };",
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
    expect(problems("x :: ;")[0]?.stage).toBe("parse");
    expect(problems("1 + true")[0]?.stage).toBe("check");
    expect(problems("f :: fn(x: i64): i64 { x }; f(2)")).toEqual([]);
    // lint: unused argument, with a line number
    const p = problems("f :: fn(unused: i64): i64 { 1 };\nf(2)");
    expect(p[0]?.stage).toBe("lint");
    expect(p[0]?.line).toBe(1);
  });

  test("wasm backend emits bytes and reports performed ops (typecheck byproduct)", async () => {
    const {bytes, ops} = await buildWasm("Println!(1 + 2)");
    expect(bytes.length).toBeGreaterThan(0);
    expect(ops).toEqual(["Println"]);
  });

  test("topLevelEffs: the residual row `ef types` prints on its _ line", () => {
    expect(topLevelEffs("fib :: fn(n: i64): i64 { n };\nPrintln!(fib(27))")).toEqual(["Println"]);
    // lambdas defer their performs, and internally-handled ops don't escape
    expect(topLevelEffs("effect E(): unit;\nf :: fn() { E!() };\n1")).toEqual([]);
    expect(topLevelEffs("effect E(): unit;\nhandle { E!() } case E() => k { k(unit) }")).toEqual([]);
    expect(topLevelEffs("effect E(): unit;\nE!()")).toEqual(["E"]);
  });

  test("outline, entry detection and project concat", () => {
    const src = [
      "effect Tick(v: i64): i64;",
      "Pair :: [i64, i64];",
      "f :: fn(x: i64): i64 ! { Tick } { Tick!(x) };",
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
    // types: checker-resolved for bindings, written sig for effects, alias body
    expect(ol[0]?.typ).toBe("(i64) -> i64");
    expect(ol[1]?.typ).toBe("[i64, i64]");
    expect(ol[2]?.typ).toBe("(i64) -> i64 ! { Tick }");
    // a type error elsewhere leaves typs null — the outline still lists names
    expect(outline("x :: 1;\nx(2)").map((o) => o.typ)).toEqual([null]);
    // entry needs the last top-level expression's type to be unit — f(1) : i64
    expect(isEntryFile(src)).toBe(false);
    // effects don't matter: a unit-typed effectful expression is an entry
    expect(isEntryFile(`${src}; Println!(f(1))`)).toBe(true);
    // lets aren't; a check failure means the type can't be known
    expect(isEntryFile("x :: 1;")).toBe(false);
    expect(isEntryFile("1 + true")).toBe(false);
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
    // i64 values cross the wasm boundary as BigInt.
    expect(r.value).toBe(7n);
    expect(showT(r.type)).toBe("i64");
    expect(r.ops).toEqual(["Out", "Println"]);
  });

  test("wasm run handles deep recursion (the CPS interpreter overflows V8)", () => {
    const r = runWasmProgram([
      "fib :: fn(n: i64): i64 {",
      "  if (n < 2) { n } else { fib(n - 1) + fib(n - 2) }",
      "};",
      "Println!(fib(27));",
      "0",
    ].join("\n"), () => {});
    expect(r.value).toBe(0n);
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
    const toks = tokenize("s :: \"a#b\";  # note\nTick!()");
    expect(toks[0].map((t) => t.scope)).toEqual([
      "identifier", "operator", "string", "delimiter", "comment",
    ]);
    expect(toks[1][0].scope).toBe("tag");
  });

  test("tokenize scopes numbers, keywords and unscoped punctuation", () => {
    const toks = tokenize("f(x, 1.5) ? 2");
    const scopes = toks[0].map((t) => t.scope);
    expect(scopes).toContain("number");
    expect(scopes).toContain("identifier");
    // `?` is outside the ef token grammar: no token at all, still advances.
    expect(toks[0].map((t) => t.scope)).toEqual([
      "identifier", "delimiter", "identifier", "delimiter", "number",
      "delimiter", "number",
    ]);
  });

  test("alias outlines render every type shape with declared param names", () => {
    for (const [decl, typ] of [
      ["V :: fn(a: type): type {[a]};", "[a]"],
      ["F :: fn(a: type): type {(a) -> a};", "(a) -> a"],
      ["I :: fn(a: type): type {a};", "a"],
      ["A :: fn(): type {any};", "any"],
    ] as [string, string][]) {
      const [item] = outline(decl);
      expect(item.typ).toBe(typ);
    }
  });

  test("Wait! runs the bridge's busy-wait interpretation", () => {
    const r = interpret("Wait!(0)", () => {});
    expect(r.value).toBe(null);
  });

  test("unparseable files are simply not entry files", () => {
    expect(isEntryFile("f :: fn( {")).toBe(false);
  });
});
