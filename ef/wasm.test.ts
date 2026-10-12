import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, writeFileSync} from "node:fs";
import {run} from "./eval.ts";
import {compile, runWasm} from "./wasm.ts";
import {show} from "./env.ts";

// The wasm target must be observationally equivalent to the interpreter:
// for every program below, `run(src)` and `runWasm(src)` produce the same
// `show()` rendering (values AND error messages).
const both = (src: string): [string, string] => {
  let interp: string, wasm: string;
  try { interp = show(run(src)); } catch (e) { interp = "ERR: " + (e as Error).message; }
  try { wasm = show(runWasm(src)); } catch (e) { wasm = "ERR: " + (e as Error).message; }
  return [interp, wasm];
};

const parity = (src: string) => {
  const [interp, wasm] = both(src);
  expect(wasm).toBe(interp);
  return interp;
};

describe("wasm backend", () => {
  test("emits a valid module", () => {
    expect(WebAssembly.validate(compile("1 + 2"))).toBe(true);
    expect(WebAssembly.validate(compile("let f = fn(x: int): int { x }; f(1)"))).toBe(true);
  });

  test("arithmetic: int / float division, neg, mod", () => {
    expect(parity("7 / 2")).toBe("3"); // int division truncates
    expect(parity("7.0 / 2")).toBe("3.5");
    expect(parity("-5 + 3")).toBe("-2");
    expect(parity("17 % 5")).toBe("2");
    expect(parity("1 / 0")).toBe("Infinity");
  });

  test("comparisons and equality", () => {
    expect(parity("if (3 < 5) { 10 } else { 20 }")).toBe("10");
    expect(parity("\"ab\" == \"ab\"")).toBe("true");
    expect(parity("\"a\" != \"b\"")).toBe("true");
    expect(parity("[1,2] == [1,2]")).toBe("false"); // arrays by identity
    expect(parity("1 != 2")).toBe("true");
  });

  test("strings: concat, len", () => {
    expect(parity("\"ab\" + \"cd\"")).toBe("\"abcd\"");
    parity("len(\"héllo\")"); // len is array-only: both reject identically
    expect(parity("strlen(\"héllo\")")).toBe("5");
  });

  test("control flow: if / while / blocks", () => {
    expect(parity("let i = 0; let s = 0; while (i < 5) { s = s + i; i = i + 1 }; s")).toBe("10");
    // blocks with inner lets (lambda body = block sharing the frame)
    expect(parity("let f = fn() { let a = 2; let b = 3; a * b }; f()")).toBe("6");
  });

  test("arrays: get/set, grow, flat, concat, map", () => {
    expect(parity("get([10,20,30], 1)")).toBe("20");
    expect(parity("let a = [1]; set(a, 3, 9); len(a)")).toBe("4");
    expect(parity("len(flat([[1,2],[3]]))")).toBe("3");
    expect(parity("concat([1], [2,3])")).toBe("[1, 2, 3]");
    expect(parity("map(fn(x) { x * x }, range(0, 4, 1))")).toBe("[0, 1, 4, 9]");
    expect(parity("get(get([[1,2],[3,4]], 1), 0)")).toBe("3");
  });

  test("closures: creation, capture, immediate call of a returned closure", () => {
    expect(parity("let addn = fn(n) { fn(x) { x + n } }; addn(10)(5)")).toBe("15");
    expect(parity("let mk = fn() { let c = 0; fn() { c = c + 1; c } }; let f = mk(); f(); f(); f()")).toBe("3");
    expect(parity("let f = fn(a) { fn(b) { fn(c) { a + b + c } } }; f(1)(2)(3)")).toBe("6");
    expect(parity("let id = fn(x) { x }; id(id)(3)")).toBe("3");
  });

  test("recursion: non-tail and tail (return_call_indirect, O(1) wasm stack)", () => {
    expect(parity("let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(15)")).toBe("610");
    expect(parity("let lp = fn(n, acc) { if (n == 0) { acc } else { lp(n - 1, acc + n) } }; lp(100000, 0)"))
      .toBe("5000050000");
  });

  test("math builtins", () => {
    expect(parity("round(sqrt(2) * 100) + abs(0 - 3)")).toBe("144");
    expect(parity("round(cos(0) * 10) + round(sin(0) * 10)")).toBe("10");
    // PI is a float value per the checker; the interpreter's runtime binds a
    // fn for it (interpreter quirk), so no parity here — pinned value instead.
    expect(show(runWasm("round(PI * 100)"))).toBe("314");
  });

  test("errors surface identically (typecheck + runtime)", () => {
    parity("nope + 1"); // Unbound: nope
    parity("1 + \"a\""); // type error from checkProgram
    parity("get([1,2], 9)"); // get: index 9 out of bounds
    parity("head(1, 2, 3)"); // arity error
  });

  test("effects reach the host: Println output", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      expect(show(runWasm("Println!(1); Println!(2.5); Println!(true); 7"))).toBe("7");
    } finally {
      console.log = orig;
    }
    expect(lines).toEqual(["1", "2.5", "true"]);
  });

  test("effects reach the host: Read/Write files", () => {
    const p = join(tmpdir(), `ef-wasm-test-${process.pid}.txt`);
    writeFileSync(p, "hello wasm");
    expect(show(runWasm(`Read!("${p}")`))).toBe("\"hello wasm\"");
    expect(show(runWasm(`Write!("${p}", "rewritten")`))).toBe("unit");
    expect(readFileSync(p, "utf8")).toBe("rewritten");
  });
});
