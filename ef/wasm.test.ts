import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, writeFileSync} from "node:fs";
import {run} from "./eval.ts";
import {compile, runWasm, WasmError} from "./wasm.ts";
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

  test("builtin shadowing: a user binding keeps the builtin unreferenced", () => {
    // A `let` shadowing a builtin name must resolve to the user binding,
    // not reach the builtin's closure.
    expect(parity("let len = fn(xs: [int]): int { 42 }; len([1, 2, 3])")).toBe("42");
    // Parameter shadowing a builtin name.
    expect(parity("let f = fn(len: int): int { len * 2 }; f(21)")).toBe("42");
    // Inner shadow, outer builtin use: only the outer reference is reachable.
    expect(parity(`let g = fn() {
  let len = fn(xs: [int]): int { 0 };
  len([1])
};
g() + len([9, 9])`)).toBe("2");
  });

  test("builtins as values: references beyond call sites keep them emitted", () => {
    // A builtin passed as an argument still needs its closure cell.
    expect(parity("let apply1 = fn(f, x) { f(x) }; apply1(round, 2.6)")).toBe("3");
    // Multiple builtins-as-values, referenced inside lambdas.
    expect(parity(`let f = fn(f, x) { f(x) };
let a = f(round, 2.6);
let b = f(len, [1, 2, 3]);
a + b`)).toBe("6");
    // A builtin returned from a lambda and called at the site.
    expect(parity("let mk = fn() { len }; mk()([7, 8, 9])")).toBe("3");
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

  test("user effects compile and escape to the host", () => {
    // Same unhandled-effect error message as the interpreter.
    parity("effect Foo(n: int): int; Foo!(1) + 2");
    // One-shot interp injection overrides the default interpretation.
    expect(show(runWasm("effect Foo(n: int): int; Foo!(21) * 2", {Foo: args => (args[0] as number) + 1})))
      .toBe("44");
  });

  test("handlers: user ops, resume, deep nesting, multi-shot", () => {
    // Single op, constant result.
    expect(parity("effect Op(): int; handle { 1 + Op!() } case Op() => k { 7 }")).toBe("7");
    // Resume with different values.
    expect(parity("effect Op(): int; handle { Op!() + Op!() } case Op() => k { k(3) }")).toBe("6");
    // Perform inside a lambda called twice; non-resuming case discards the rest.
    expect(parity("effect Op(): int; handle { let f = fn() { Op!() }; f() + f() } case Op() => k { 1 }")).toBe("1");
    // Return case.
    expect(parity("effect Op(): int; handle { 5 } case Op() => k { 0 }")).toBe("5");
    // Unhandled effect propagates past a non-matching inner handler.
    expect(parity("effect A(): int; effect B(): int; handle { handle { A!() } case B() => k { 99 } } case A() => k { 5 }")).toBe("5");
    // Matching inner handler fires first.
    expect(parity("effect A(): int; handle { handle { A!() } case A() => k { 10 } } case A() => k { 20 }")).toBe("10");
    // Multi-shot resume via map: cross-product of two choices (the plan target).
    expect(parity(`effect Choose(opts: [int]): int;
      handle { let x = Choose!([1,2,3]); let y = Choose!([10,20]); [x, y] }
      case Return(v) => k { [v] }
      case Choose(opts) => k { flat(map(k, opts)) }`))
      .toBe("[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]");
    // Non-resuming case aborts the rest of the body.
    expect(parity(`effect Div(a: int, b: int): int;
      handle { let r = Div!(10, 0); [r] }
      case Div(a, b) => k { if (b == 0) { ["div by zero"] } else { k(a / b) } }`))
      .toBe("[\"div by zero\"]");
    // Deep handlers: a log threaded through nested resumes (resume in a
    // non-tail position inside concat).
    expect(parity(`effect Log(msg: string): unit;
      effect Result(v: string): unit;
      handle { Log!("a"); Log!("b"); Result!("42") }
      case Log(msg) => k { concat([msg], k(unit)) }
      case Result(v) => k { [v] }`))
      .toBe("[\"a\", \"b\", \"42\"]");
    // Propagation from inside a case body to the next handler.
    expect(parity(`effect Emit(m: string): unit;
      effect Other(m: string): unit;
      handle { handle { Emit!("hi") } case Other(m) => k { ["should-not-match"] } }
      case Emit(m) => k { [m] }`))
      .toBe("[\"hi\"]");
    // Inner handler with a Return case stays live around the resumed segment:
    // outer case resumes 3, segment yields 4, inner Return case wraps it.
    expect(parity(`effect A(): int;
      handle { handle { A!() + 1 } case Return(v) => k { [v] } } case A() => k { k(3) }`))
      .toBe("[4]");
    // Builtin effect intercepted by a user handler.
    expect(parity("effect Read(): int; handle { Read!() + 1 } case Read() => k { 41 }")).toBe("41");
    // Exit! intercepted without resuming: the code after it never runs.
    expect(parity(`handle { Out!("pre"); Exit!(42); Out!("post") }
      case Exit(c) => k { c }
      case Out(s) => k { Println!(s); k(unit) }`))
      .toBe("42");
    // Perform inside call arguments: two invocations get independent frames.
    expect(parity(`effect Op(): int;
      handle { let f = fn(a: int, b: int): int { a + b }; f(Op!(), Op!()) }
      case Op() => k { k(3) }`))
      .toBe("6");
  });

  test("interp injection overrides builtin effects (Read mock)", () => {
    const p = join(tmpdir(), `ef-wasm-mock-${process.pid}.txt`);
    const src = `Read!("${p}")`;
    // Interpreter interp entries are CPS (they resume a continuation); the
    // wasm host boundary is direct style (it returns the resumed value).
    expect(show(run(src, {Read: (_args, k) => k("mocked")}))).toBe("\"mocked\"");
    expect(show(runWasm(src, {Read: () => "mocked"}))).toBe("\"mocked\"");
  });
});

describe("wasm effect codegen regressions", () => {
  test("multi-param op: two-shot resume of a 2-param continuation", () => {
    // Return slots for a multi-param op must not alias across resumes.
    expect(parity(
      "effect T(a: int, b: int): int; handle { T!(1, 2) } case T(a, b) => k { let x = k(a); let y = k(b); x + y }",
    )).toBe("3");
  });

  test("single-param op: two-shot resume, no call_indirect trap", () => {
    expect(parity(
      "effect T(n: int): int; handle { T!(5) } case T(n) => k { let x = k(n); let y = k(n); x + y }",
    )).toBe("10");
  });

  test("flat: scalar passthrough under a resuming handler", () => {
    // k resumes to a plain scalar; flat must pass scalars through instead of
    // treating them as single-element arrays (broke every flatmap before).
    expect(parity(
      "effect T(): int; handle { T!() } case T() => k { flat(map(k, [7, 8])) }",
    )).toBe("[7, 8]");
  });

  test("flatmap over ints under no handler", () => {
    expect(parity(
      "flat(map(fn(x: int): [int] { [x, x * 10] }, [1, 2, 3]))",
    )).toBe("[1, 10, 2, 20, 3, 30]");
  });

  test("array literal elements survive suspension", () => {
    // Elements emitted before/after a perform inside the same array literal.
    expect(parity("effect Op(): int; handle { [Op!(), Op!()] } case Op() => k { k(7) }"))
      .toBe("[7, 7]");
    expect(parity("effect Op(): int; handle { [1, 2, Op!(), Op!()] } case Op() => k { k(7) }"))
      .toBe("[1, 2, 7, 7]");
    expect(parity("effect Op(): int; handle { [[Op!(), 1], [2, [Op!()]]] } case Op() => k { k(7) }"))
      .toBe("[[7, 1], [2, [7]]]");
  });

  test("handle as an operator operand compiles to a valid module", () => {
    const src = "effect Op(): int; 1 + handle { Op!() } case Op() => k { 7 }";
    expect(WebAssembly.validate(compile(src))).toBe(true);
    expect(parity(src)).toBe("8");
  });

  test("div cut modes: performs in both div operand positions", () => {
    // The divisor's cut mode was mis-emitted, silently yielding wrong values.
    expect(parity(
      "effect P(): float; effect Q(): float; handle { (7.0 / P!()) / Q!() } case P() => k { k(2.0) } case Q() => k { k(7.0) }",
    )).toBe("0.5");
    expect(parity(
      "effect P(): int; effect Q(): int; handle { (7 + P!()) / Q!() } case P() => k { k(2) } case Q() => k { k(7) }",
    )).toBe("1");
  });

  test("perform inside a while condition", () => {
    // Split-mode while: the cond is a legal cut position (the cond-cut path
    // re-runs one pass with the resumed value).
    // A resuming handler drives the loop: the case body returns the live i,
    // so the cond sees 0,1,2 then 3 and the loop exits.
    expect(parity(
      "effect Op(): int; let i = 0; handle { while (Op!() < 3) { i = i + 1 }; i } case Op() => k { k(i) }",
    )).toBe("3");
    // A non-resuming case body abandons the loop: its value is the handle
    // block's value (the continuation is discarded).
    expect(parity(
      "effect Op(): int; let i = 0; handle { while (Op!() < 3) { i = i + 1 }; i } case Op() => k { i }",
    )).toBe("0");
    // Perform in the cond AND a body perform whose case body abandons the
    // continuation (finite: the cond resumes with the live i via the Op arm).
    expect(parity(
      "effect Op(): int; effect Twice(): int; let i = 0; handle { let s = 0; while (Op!() < 3) { s = s + Twice!(); i = i + 1 }; s } case Op() => k { k(i) } case Twice() => k { 7 }",
    )).toBe("7");
    expect(parity(
      "effect Op(): int; handle { let s = 0; let i = 0; while (i < 2) { s = s + Op!(); i = i + 1 }; s } case Op() => k { k(2) }",
    )).toBe("4");
  });

  test("handle as a statement inside a while body", () => {
    expect(parity(
      "effect Op(): int; handle { let s = 0; let i = 0; while (i < 2) { s = s + handle { Op!() } case Op() => k2 { k2(10) }; i = i + 1 }; s } case Op() => k { k(3) }",
    )).toBe("20");
  });

  test("dlet destructuring whose bound expressions perform", () => {
    // Two performs inside dlet bindings, one resumed non-trivially (k(k(4))).
    expect(parity(
      "effect Op(): int; handle { let [x, y, z] = [1, Op!(), 3]; let [w] = [x + z + Op!()]; w + y } case Op() => k { k(k(4)) }",
    )).toBe("52");
  });
});