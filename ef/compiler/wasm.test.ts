import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import binaryen from "binaryen";
import {run} from "./eval.ts";
import {BIN_FEATURES, compile} from "./wasm.ts";
import {checkProgram} from "./types.ts";
import {discover, optimize, assignIndices, layoutStatics} from "./wasm_pipeline.ts";
import {toCps} from "./cps.ts";
import {planIr} from "./wasm_term.ts";
import {Parser} from "./parser.ts";
import {runWasm} from "./wasm_host.ts";
import {show} from "./env.ts";

// binaryen's typings lag its runtime (see wasm.ts RawBinaryen): readBinary's features argument is untyped in the .d.ts.
const bin = binaryen as typeof binaryen & {
  readBinary(bytes: Uint8Array, features: number): ReturnType<typeof binaryen.wrapModule>,
};

const workspaceDir = import.meta.dir;

// The wasm target must be observationally equivalent to the interpreter:
// for every program below, `run(src)` and `runWasm(src)` produce the same
// `show()` rendering (values AND error messages).
function parity(src: string) {
  const interp = ((): string => {
    try {
      return show(run(src));
    } catch (e) {
      return "ERR: " + (e as Error).message;
    }
  })();
  const wasm = ((): string => {
    try {
      return show(runWasm(src));
    } catch (e) {
      return "ERR: " + (e as Error).message;
    }
  })();
  expect(wasm).toBe(interp);
  return interp;
}

// Health check for every compiled module in this file: the module must
// validate, and no function may have an empty body (root expression Nop —
// in the binary, just `locals decl + end`) while declaring a result: such
// a body is an orphaned rest thunk that cannot return its result type.
// Empty VOID bodies are legitimate (the backend emits them as terminal
// rest thunks, e.g. for `args()`), so they pass.
function assertModule(bytes: Uint8Array): void {
  const mod = bin.readBinary(bytes, BIN_FEATURES);
  try {
    expect(mod.validate()).toBe(1);
    const nopId: number = bin.NopId; // getExpressionId returns a plain number
    const fns = Array.from({length: mod.getNumFunctions()}, (_, i) =>
      bin.getFunctionInfo(mod.getFunctionByIndex(i)));
    expect(fns.filter(info =>
      bin.getExpressionId(info.body) === nopId && info.results !== bin.none)).toBeEmpty();
  } finally {
    mod.dispose();
  }
}

// Host import names of the module compile(src) declares, in order.
function importsOf(src: string): string[] {
  const bytes = compile(src);
  assertModule(bytes);
  return WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map(i => i.name);
}

describe("wasm backend", () => {
  test("emits a valid module", () => {
    assertModule(compile("1 + 2"));
    assertModule(compile("f :: fn(x: i64): i64 { x }; f(1)"));
  });

  test("pipeline phases run standalone (init-order/TDZ guard)", () => {
    // Drive each exported phase directly so an init-order bug fails here,
    // named by phase, instead of as a generic compile() error. The program
    // touches every layoutStatics branch: number + string literals, a PI
    // reference, and a value-referenced builtin (closure static).
    const prog = new Parser("x :: 1;\ns :: \"a\";\npi :: PI;\nl :: len;\nx;").parseProgram();
    checkProgram(prog); // discover reads the runtime markers the check stamps
    const ir = toCps(prog);
    const d = discover(ir, prog);
    const o = optimize(prog);
    const plan = planIr(ir);
    const ix = assignIndices(ir, plan, o);
    const lay = layoutStatics(d, ix, o, plan); // the batch-A TDZ site
    expect(lay.statics.length).toBeGreaterThan(3);
    expect(lay.unitRef.k).toBe("g");
    expect(lay.piG).toBeGreaterThanOrEqual(0); // PI referenced → static
  });

  test("every example compiles to a valid module with no empty function bodies", () => {
    // The invariant holds for any compiled program, so it runs over every
    // .ef file in examples/. Compiling all examples takes ~11s (star.ef
    // alone ~3s), well over the 5s default timeout.
    const dir = join(workspaceDir, "..", "examples");
    for (const bin of readdirSync(dir)
      .filter(file => file.endsWith(".ef"))
      .map(file => join(dir, file))
      .map(f => readFileSync(f).toString())
      .map(compile)) 
      assertModule(bin);
  }, 30000);

  test("arithmetic: i64 / f64 division, neg, mod", () => {
    expect(parity("7 / 2")).toBe("3"); // i64 division truncates
    expect(parity("7.0 / 2")).toBe("3.5");
    expect(parity("-5 + 3")).toBe("-2");
    expect(parity("17 % 5")).toBe("2");
    // Integer division by zero traps instead of producing Infinity.
    expect(() => run("1 / 0")).toThrow(/integer divide by zero/);
  });

  test("arithmetic on non-numbers traps via ref.cast (frozen documented deviation)", () => {
    // Known deviation (wasm.ts): the checker rejects statically-ill-typed
    // arithmetic, but a
    // dynamically non-number operand (e.g. through `any`) traps at the
    // wasm ref.cast instead of throwing a host-side ef error — the GC
    // plane's frozen deviation from the interpreter's TypeError.
    expect(() => runWasm("(fn(x: any): any { x * 1 })(\"s\")")).toThrow(); // "*" is always numeric: slotF64 traps on the cast
  });

  test("comparisons and equality", () => {
    expect(parity("if (3 < 5) { 10 } else { 20 }")).toBe("10");
    expect(parity("\"ab\" == \"ab\"")).toBe("true");
    expect(parity("\"a\" != \"b\"")).toBe("true");
    expect(parity("[1,2] == [1,2]")).toBe("false"); // arrays by identity
    expect(parity("1 != 2")).toBe("true");
  });

  test("any-typed equality is value-based across all six widths", () => {
    // The $eq helper matches the interpreter's JS === on values exactly:
    // same-representation numbers compare by value (f32 promotes, i32/u32
    // convert), BigInt is never === a Number, and mixed i64/u64 compares
    // the BigInt values (not the bits).
    const eq = "eq :: fn(a: any, b: any) { a == b }; ";
    expect(parity(eq + "eq(1.5, 1.5)")).toBe("true");
    expect(parity(eq + "eq(@as(1.5, f32), @as(1.5, f32))")).toBe("true");
    expect(parity(eq + "eq(@as(5, i32), @as(5, u32))")).toBe("true");
    expect(parity(eq + "eq(@as(5, i32), @as(5, i32))")).toBe("true");
    expect(parity(eq + "eq(@as(5, i64), @as(5, u64))")).toBe("true");
    // Same bits, different BigInt values.
    expect(parity(eq + "eq(@as(-1, i64), @as(18446744073709551615, u64))")).toBe("false");
    expect(parity(eq + "eq(@as(5, i64), 5.0)")).toBe("false"); // BigInt vs Number
    expect(parity(eq + "eq(@as(5, i32), @as(5, i64))")).toBe("false");
    expect(parity(eq + "eq(true, true)")).toBe("true");
    expect(parity(eq + "eq(\"x\", \"x\")")).toBe("true");
    expect(parity(eq + "eq(1, 2)")).toBe("false");
  });

  test("tail operator after a land call dispatches through the RET cell", () => {
    // The inlined operators share the fixed shape: the tail value returns
    // to the enclosing wrapper, which dispatches it through the
    // continuation.
    expect(parity(`f :: fn(x: i64): i64 { x / 2 };
      y :: f(10);
      y + 1`)).toBe("6");
    expect(parity(`f :: fn(x: i64): i64 { x + 1 };
      y :: f(10);
      y * 2`)).toBe("22");
    // Tail operator with a performing operand: the resumed value must
    // dispatch through the real handler chain, not just a RET cell.
    expect(parity(`effect Op(): i64;
      handle { f :: fn(x: i64): i64 { x / 2 }; f(Op!()) + 1 }
      case Op() => k { k(10) }`)).toBe("6");
  });

  test("strings: concat, len", () => {
    expect(parity("\"ab\" + \"cd\"")).toBe("\"abcd\"");
    parity("len(\"héllo\")"); // len is array-only: both reject identically
    expect(parity("strlen(\"héllo\")")).toBe("5");
  });

  test("control flow: if / while / blocks", () => {
    expect(parity("i := 0; s := 0; while (i < 5) { s = s + i; i = i + 1 }; s")).toBe("10");
    // blocks with inner lets (lambda body = block sharing the frame)
    expect(parity("f :: fn() { a :: 2; b :: 3; a * b }; f()")).toBe("6");
  });

  test("arrays: get/set/sub views, strict set, flat, concat, map", () => {
    expect(parity("get([10,20,30], 1)")).toBe("20");
    // set is strictly in-window: no growth past the end, identical error.
    expect(parity("a :: [1]; set(a, 3, 9)")).toBe("ERR: set: index 3 out of bounds [0, 1)");
    // sub returns a zero-copy view: writes through the original show up.
    expect(parity("s :: [1, 2, 3, 4]; v :: sub(s, 1, 3); set(s, 1, 99); v")).toBe("[99, 3]");
    expect(parity("s :: [1, 2, 3]; sub(s, 5, 6)")).toBe("ERR: sub: range [5, 6) out of bounds [0, 3)");
    // A huge i64 index must not wrap to a small in-bounds i32 (wasm parity).
    expect(parity("get([1, 2, 3], 4294967296)")).toBe("ERR: get: index 4294967296 out of bounds [0, 3)");
    expect(parity("len(flat([[1,2],[3]]))")).toBe("3");
    expect(parity("concat([1], [2,3])")).toBe("[1, 2, 3]");
    expect(parity("map(fn(x) { x * x }, range(0, 4, 1))")).toBe("[0, 1, 4, 9]");
    expect(parity("get(get([[1,2],[3,4]], 1), 0)")).toBe("3");
  });

  test("closures: creation, capture, immediate call of a returned closure", () => {
    expect(parity("addn :: fn(n: i64) { fn(x) { x + n } }; addn(10)(5)")).toBe("15");
    expect(parity("mk :: fn() { c := 0; fn() { c = c + 1; c } }; f :: mk(); f(); f(); f()")).toBe("3");
    expect(parity("f :: fn(a: i64) { fn(b: i64) { fn(c: i64) { a + b + c } } }; f(1)(2)(3)")).toBe("6");
    expect(parity("id :: fn(x) { x }; id(id)(3)")).toBe("3");
  });

  test("recursion: non-tail and tail (return_call_indirect, O(1) wasm stack)", () => {
    expect(parity("fib :: fn(n: i64) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(15)")).toBe("610");
    expect(parity("lp :: fn(n: i64, acc: i64) { if (n == 0) { acc } else { lp(n - 1, acc + n) } }; lp(100000, 0)")).toBe("5000050000");
  });

  test("math builtins", () => {
    expect(parity("round(sqrt(2) * 100) + abs(0 - 3)")).toBe("144");
    expect(parity("round(cos(0) * 10) + round(sin(0) * 10)")).toBe("10");
    // PI is a f64 value per the checker; the interpreter's runtime binds a
    // fn for it (interpreter quirk), so no parity here — pinned value instead.
    expect(show(runWasm("round(PI * 100)"))).toBe("314");
  });

  test("f32 precision: typed f32 ops, $F32 boxes and @as conversions", () => {
    // Graduated from the step-1 interp-only block: every case now runs
    // through BOTH backends (parity) — f32 values are real $F32 boxes
    // computed with the f32 opcode family.
    expect(parity("@as(0.1, f32) + @as(0.2, f32)")).toBe("0.30000001192092896");
    expect(parity("@as(0.1 + 0.2, f32)")).toBe("0.30000001192092896");
    expect(parity("@as(1.0 / 3.0, f32)")).toBe("0.3333333432674408");
    expect(parity("@as(0.1, f32) + @as(0.2, f32) == @as(0.3, f32)")).toBe("true");
    // f64 stays f64: the same sum differs in the last digits.
    expect(parity("0.1 + 0.2")).toBe("0.30000000000000004");
    // f32 literals flowing through f32-typed positions (lets, params,
    // arrays) keep their box: the wildcard sources adapt at the unbox.
    expect(parity("a: f32 :: 0.1; b: f32 :: 0.2; a + b")).toBe("0.30000001192092896");
    expect(parity("add :: fn(x: f32, y: f32): f32 { x + y }; add(3.34, 2.71)")).toBe("6.050000190734863");
    expect(parity("x: f32 :: 1; x + 1")).toBe("2");
    expect(parity("map(fn(v: f32): f32 { v * v }, [@as(0.5, f32)]).0")).toBe("0.25");
    expect(parity("sqrt(@as(4.0, f32))")).toBe("2");
    expect(parity("neg(@as(1.5, f32))")).toBe("-1.5");
    expect(parity("@as(3.34, f32) * @as(2.71, f32)")).toBe("9.051400184631348");
    // f32 -> f64 promotes exactly; f64 -> f32 demotes (@as only).
    expect(parity("@as(@as(0.1, f32), f64)")).toBe("0.10000000149011612");
    expect(parity("@as(@as(0.1, f64), f32)")).toBe("0.10000000149011612");
    // Comparisons dispatch on the f32 stamp.
    expect(parity("@as(0.5, f32) < @as(0.7, f32)")).toBe("true");
    // f32 division is f32-precision (no int truncation).
    expect(parity("@as(1.0, f32) / @as(3.0, f32)")).toBe("0.3333333432674408");
  });

  test("i32/u32 wraparound: native mod-2^32 ops, comparisons, @as", () => {
    // i32/u32 sites compute with i32.add/sub/mul (the wrap IS the
    // semantics) and the interpreter wraps through BigInt.asIntN/asUintN —
    // parity.
    expect(parity("x: i32 :: 2147483647; x + 1")).toBe("-2147483648");
    expect(parity("x: i32 :: -2147483648; x - 1")).toBe("2147483647");
    expect(parity("x: i32 :: 2147483647; x * 2")).toBe("-2");
    expect(parity("x: u32 :: 4294967295; x + 1")).toBe("0");
    expect(parity("x: u32 :: 0; x - 1")).toBe("4294967295");
    expect(parity("x: u32 :: 3000000000; x * 3")).toBe("410065408");
    // Signed vs unsigned comparison of the same bits (0xFFFFFFFF).
    expect(parity("@as(-1, i32) < @as(1, i32)")).toBe("true");
    expect(parity("@as(4294967295, u32) > @as(1, u32)")).toBe("true");
    // Strict same-width ops (D6): a mixed-width compare is a static type
    // error in both backends — the messages must match exactly.
    expect(parity("@as(-1, i32) < @as(4294967295, u32)")).toBe(
      "ERR: <: i32 and u32 are different numeric widths (use @as to convert)");
    // @as wrap: i64 -> i32 truncates mod 2^32 (asIntN), i64 -> u32 via asUintN.
    expect(parity("@as(4294967297, i32)")).toBe("1");
    expect(parity("@as(4294967297, u32)")).toBe("1");
    expect(parity("@as(-1, i32)")).toBe("-1");
    expect(parity("@as(-1, u32)")).toBe("4294967295");
    expect(parity("@as(@as(5, i32), i64)")).toBe("5");
    expect(parity("@as(@as(-5, i32), i64)")).toBe("-5");
    expect(parity("@as(@as(4294967295, u32), i64)")).toBe("4294967295");
    // Equality on the narrow widths compares the payload bits.
    expect(parity("@as(-1, i32) == @as(4294967295, i32)")).toBe("true");
    expect(parity("@as(-1, i32) == @as(1, i32)")).toBe("false");
  });

  test("i32 division guards: divide by zero and INT_MIN / -1 fail identically", () => {
    // The wasm side routes both through ef_fail (not native traps), so the
    // error message and exit code match the interpreter exactly.
    expect(parity("x: i32 :: 1; x / 0")).toBe("ERR: integer divide by zero");
    expect(parity("x: i32 :: 1; x % 0")).toBe("ERR: integer divide by zero");
    expect(parity("x: u32 :: 1; x / 0")).toBe("ERR: integer divide by zero");
    expect(parity("x: i32 :: -2147483648; x / -1")).toBe("ERR: integer overflow");
    expect(parity("x: i32 :: -2147483648; x % -1")).toBe("0"); // rem_i32_s of INT_MIN by -1 is 0, no overflow
    // Untyped literals default to the i64 plane: native integer division,
    // trunc toward zero.
    expect(parity("7 / 2")).toBe("3");
    expect(parity("-7 / 2")).toBe("-3");
  });

  test("i64/u64 wraparound: exact 64-bit BigInt arithmetic, comparisons, @as", () => {
    // i64/u64 sites compute with i64.add/sub/mul (the wrap IS the
    // semantics) and the interpreter wraps through BigInt.asIntN/asUintN —
    // parity, exact to 2^63 and beyond 2^53.
    expect(parity("x: i64 :: 9223372036854775807; x + 1")).toBe("-9223372036854775808");
    expect(parity("x: i64 :: -9223372036854775808; x - 1")).toBe("9223372036854775807");
    expect(parity("x: i64 :: 4611686018427387904; x * 2")).toBe("-9223372036854775808"); // 2^62 * 2 wraps to INT64_MIN
    expect(parity("x: i64 :: 4294967296; x * x")).toBe("0"); // 2^64 wraps to 0
    expect(parity("x: u64 :: 18446744073709551615; x + 1")).toBe("0");
    expect(parity("x: u64 :: 0; x - 1")).toBe("18446744073709551615");
    expect(parity("9007199254740993 + 0")).toBe("9007199254740993"); // 2^53 + 1 is exact
    // Signed vs unsigned comparison of the same bits (2^63 - 1 vs 2^63).
    expect(parity("x: i64 :: 9223372036854775807; x > 0")).toBe("true");
    expect(parity("@as(9223372036854775808, i64) < 0")).toBe("true");
    expect(parity("@as(9223372036854775808, u64) > 0")).toBe("true");
    // Strict same-width ops (D6) on the wide widths too.
    expect(parity("@as(1, i64) < @as(2, u64)")).toBe(
      "ERR: <: i64 and u64 are different numeric widths (use @as to convert)");
    // @as wrap: i64 -> i32 truncates mod 2^32 (asIntN), u64 -> u32 via asUintN.
    expect(parity("@as(4294967297, i64)")).toBe("4294967297"); // no truncation i64 -> i64
    expect(parity("@as(4294967297, i32)")).toBe("1");
    expect(parity("@as(18446744073709551615, u32)")).toBe("4294967295");
    expect(parity("@as(@as(5, i64), u64)")).toBe("5");
    // Equality on the wide widths compares the payload bits.
    expect(parity("@as(-1, i64) == @as(18446744073709551615, i64)")).toBe("true");
    expect(parity("9007199254740993 == 9007199254740993")).toBe("true");
    expect(parity("9007199254740993 == 9007199254740992")).toBe("false");
    // Division guards on the wide widths route through ef_fail identically.
    expect(parity("x: i64 :: 1; x / 0")).toBe("ERR: integer divide by zero");
    expect(parity("x: u64 :: 1; x % 0")).toBe("ERR: integer divide by zero");
    expect(parity("@as(-9223372036854775808, i64) / @as(-1, i64)")).toBe("ERR: integer overflow");
  });

  test("builtin shadowing is rejected before codegen", () => {
    // No shadowing: a user binding can never take a builtin's name, so
    // tree-shaking never sees an occluded builtin. compile()'s checkProgram
    // rejects these before any module is emitted.
    expect(() => compile("len :: fn(xs: [i64]): i64 { 42 }; len([1, 2, 3])"))
      .toThrow("cannot shadow builtin 'len'");
    expect(parity("len :: fn(xs: [i64]): i64 { 42 }; len([1, 2, 3])"))
      .toBe("ERR: cannot shadow builtin 'len'");
    // Parameter shadowing a builtin name.
    expect(() => compile("f :: fn(len: i64): i64 { len * 2 }; f(21)"))
      .toThrow("cannot shadow builtin 'len'");
    // Inner shadow of an outer builtin use.
    expect(() => compile(`g :: fn() {
  len :: fn(xs: [i64]): i64 { 0 };
  len([1])
};
g() + len([9, 9])`)).toThrow("cannot shadow builtin 'len'");
  });

  test("builtins as values: references beyond call sites keep them emitted", () => {
    // A builtin passed as an argument still needs its closure cell.
    expect(parity("apply1 :: fn(f, x) { f(x) }; apply1(round, 2.6)")).toBe("3");
    // Multiple builtins-as-values, referenced inside lambdas.
    expect(parity(`f :: fn(g, x) { g(x) };
a :: f(round, 2.6);
b :: f(len, [1, 2, 3]);
a + b`)).toBe("6");
    // A builtin returned from a lambda and called at the site.
    expect(parity("mk :: fn() { len }; mk()([7, 8, 9])")).toBe("3");
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
    parity("effect Foo(n: i64): i64; Foo!(1) + 2");
    // One-shot interp injection overrides the default interpretation.
    // i64 args unbox to BigInt at the host boundary.
    expect(show(runWasm("effect Foo(n: i64): i64; Foo!(21) * 2", {Foo: args => Number(args[0]) + 1}))).toBe("44");
  });

  test("handlers: user ops, resume, deep nesting, multi-shot", () => {
    // Single op, constant result.
    expect(parity("effect Op(): i64; handle { 1 + Op!() } case Op() => k { 7 }")).toBe("7");
    // Resume with different values.
    expect(parity("effect Op(): i64; handle { Op!() + Op!() } case Op() => k { k(3) }")).toBe("6");
    // Perform inside a lambda called twice; non-resuming case discards the rest.
    expect(parity("effect Op(): i64; handle { f :: fn() { Op!() }; f() + f() } case Op() => k { 1 }")).toBe("1");
    // Return case.
    expect(parity("effect Op(): i64; handle { 5 } case Op() => k { 0 }")).toBe("5");
    // Unhandled effect propagates past a non-matching inner handler.
    expect(parity("effect A(): i64; effect B(): i64; handle { handle { A!() } case B() => k { 99 } } case A() => k { 5 }")).toBe("5");
    // Matching inner handler fires first.
    expect(parity("effect A(): i64; handle { handle { A!() } case A() => k { 10 } } case A() => k { 20 }")).toBe("10");
    // Multi-shot resume via map: cross-product of two choices (the plan target).
    expect(parity(`effect Choose(opts: [i64]): i64;
      handle { x :: Choose!([1,2,3]); y :: Choose!([10,20]); [x, y] }
      case Return(v) => k { [v] }
      case Choose(opts) => k { flat(map(k, opts)) }`)).toBe("[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]");
    // Non-resuming case aborts the rest of the body.
    expect(parity(`effect Div(a: i64, b: i64): i64;
      handle { r :: Div!(10, 0); [r] }
      case Div(a, b) => k { if (b == 0) { ["div by zero"] } else { k(a / b) } }`)).toBe("[\"div by zero\"]");
    // Deep handlers: a log threaded through nested resumes (resume in a
    // non-tail position inside concat).
    expect(parity(`effect Log(msg: string): unit;
      effect Result(v: string): unit;
      handle { Log!("a"); Log!("b"); Result!("42") }
      case Log(msg) => k { concat([msg], k(unit)) }
      case Result(v) => k { [v] }`)).toBe("[\"a\", \"b\", \"42\"]");
    // Propagation from inside a case body to the next handler.
    expect(parity(`effect Emit(m: string): unit;
      effect Other(m: string): unit;
      handle { handle { Emit!("hi") } case Other(m) => k { ["should-not-match"] } }
      case Emit(m) => k { [m] }`)).toBe("[\"hi\"]");
    // Inner handler with a Return case stays live around the resumed segment:
    // outer case resumes 3, segment yields 4, inner Return case wraps it.
    expect(parity(`effect A(): i64;
      handle { handle { A!() + 1 } case Return(v) => k { [v] } } case A() => k { k(3) }`)).toBe("[4]");
    // Builtin effect intercepted by a user handler.
    expect(parity("effect Read(): i64; handle { Read!() + 1 } case Read() => k { 41 }")).toBe("41");
    // Exit! intercepted without resuming: the code after it never runs.
    expect(parity(`handle { Out!("pre"); Exit!(42); Out!("post") }
      case Exit(c) => k { c }
      case Out(s) => k { Println!(s); k(unit) }`)).toBe("42");
    // Perform inside call arguments: two invocations get independent frames.
    expect(parity(`effect Op(): i64;
      handle { f :: fn(a: i64, b: i64): i64 { a + b }; f(Op!(), Op!()) }
      case Op() => k { k(3) }`)).toBe("6");
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
    expect(parity("effect T(a: i64, b: i64): i64; handle { T!(1, 2) } case T(a, b) => k { x :: k(a); y :: k(b); x + y }")).toBe("3");
  });

  test("single-param op: two-shot resume, no call_indirect trap", () => {
    expect(parity("effect T(n: i64): i64; handle { T!(5) } case T(n) => k { x :: k(n); y :: k(n); x + y }")).toBe("10");
  });

  test("flat: scalar passthrough under a resuming handler", () => {
    // k resumes to a plain scalar; flat must pass scalars through instead of
    // treating them as single-element arrays (broke every flatmap before).
    expect(parity("effect T(): i64; handle { T!() } case T() => k { flat(map(k, [7, 8])) }")).toBe("[7, 8]");
  });

  test("flatmap over ints under no handler", () => {
    expect(parity("flat(map(fn(x: i64): [i64] { [x, x * 10] }, [1, 2, 3]))")).toBe("[1, 10, 2, 20, 3, 30]");
  });

  test("array literal elements survive suspension", () => {
    // Elements emitted before/after a perform inside the same array literal.
    expect(parity("effect Op(): i64; handle { [Op!(), Op!()] } case Op() => k { k(7) }")).toBe("[7, 7]");
    expect(parity("effect Op(): i64; handle { [1, 2, Op!(), Op!()] } case Op() => k { k(7) }")).toBe("[1, 2, 7, 7]");
    expect(parity("effect Op(): i64; handle { [[Op!(), 1], [2, [Op!()]]] } case Op() => k { k(7) }")).toBe("[[7, 1], [2, [7]]]");
  });

  test("handle as an operator operand compiles to a valid module", () => {
    const src = "effect Op(): i64; 1 + handle { Op!() } case Op() => k { 7 }";
    assertModule(compile(src));
    expect(parity(src)).toBe("8");
  });

  test("div cut modes: performs in both div operand positions", () => {
    // The divisor's cut mode was mis-emitted, silently yielding wrong values.
    expect(parity("effect P(): f64; effect Q(): f64; handle { (7.0 / P!()) / Q!() } case P() => k { k(2.0) } case Q() => k { k(7.0) }")).toBe("0.5");
    expect(parity("effect P(): i64; effect Q(): i64; handle { (7 + P!()) / Q!() } case P() => k { k(2) } case Q() => k { k(7) }")).toBe("1");
  });

  test("perform inside a while condition", () => {
    // Split-mode while: the cond is a legal cut position (the cond-cut path
    // re-runs one pass with the resumed value).
    // A resuming handler drives the loop: the case body returns the live i,
    // so the cond sees 0,1,2 then 3 and the loop exits.
    expect(parity("effect Op(): i64; i := 0; handle { while (Op!() < 3) { i = i + 1 }; i } case Op() => k { k(i) }")).toBe("3");
    // A non-resuming case body abandons the loop: its value is the handle
    // block's value (the continuation is discarded).
    expect(parity("effect Op(): i64; i := 0; handle { while (Op!() < 3) { i = i + 1 }; i } case Op() => k { i }")).toBe("0");
    // Perform in the cond AND a body perform whose case body abandons the
    // continuation (finite: the cond resumes with the live i via the Op arm).
    expect(parity("effect Op(): i64; effect Twice(): i64; i := 0; handle { s := 0; while (Op!() < 3) { s = s + Twice!(); i = i + 1 }; s } case Op() => k { k(i) } case Twice() => k { 7 }")).toBe("7");
    expect(parity("effect Op(): i64; handle { s := 0; i := 0; while (i < 2) { s = s + Op!(); i = i + 1 }; s } case Op() => k { k(2) }")).toBe("4");
  });

  test("handle as a statement inside a while body", () => {
    expect(parity("effect Op(): i64; handle { s := 0; i := 0; while (i < 2) { s = s + handle { Op!() } case Op() => k2 { k2(10) }; i = i + 1 }; s } case Op() => k { k(3) }")).toBe("20");
  });

  test("dlet destructuring whose bound expressions perform", () => {
    // Two performs inside dlet bindings, one resumed non-trivially (k(k(4))).
    expect(parity("effect Op(): i64; handle { [x, y, z] :: [1, Op!(), 3]; [w] :: [x + z + Op!()]; w + y } case Op() => k { k(k(4)) }")).toBe("52");
  });

  test("loop operands reload from the frozen freeze across resumes", () => {
    // A loop-carried operand of a performing app must reload from the
    // letk's frozen freeze, never the live frame: a later loop pass
    // re-stores the temp while an older continuation of the same site is
    // still pending.
    expect(parity("effect Op(): i64; handle { s := 0; i := 0; while (i < 2) { s = s + i + Op!(); i = i + 1 }; s } case Op() => k { k(k(7)) }")).toBe("23");
    // Same reload behind an @as on the expression.
    expect(parity("effect Op(): i64; handle { s := 0; i := 0; while (i < 2) { s = s + @as(i + Op!(), i64); i = i + 1 }; s } case Op() => k { k(k(7)) }")).toBe("23");
  });
});

describe("wasm host-import elimination (OPT_PASSES: dropDeadHostImports)", () => {
  test("effect-free program with no served builtins: no host imports", () => {
    const src = "x := 1; i := 0; while (i < 5) { x = x + i; i = i + 1 }; x";
    assertModule(compile(src));
    const imp = importsOf(src);
    expect(imp.length).toBeLessThan(7);
    expect(imp).not.toContain("ef_perform");
    expect(imp).not.toContain("ef_char");
    // ef_fail is live at our pass level (dropDeadHostImports), but with
    // operators compiled inline this program contains no bounds check that
    // could call it and no call_indirect/table, so the binaryen shrink pass
    // proves it unreferenced and drops the import.
    expect(imp).toEqual([]);
  });

  test("ef_fail stays live when a trapping builtin is used", () => {
    // get/set/sub trap through ef_fail; len only reads a struct field and
    // set on a fresh array literal is in-bounds-eliminable — none of those
    // reference ef_fail, so binaryen may drop the import.
    expect(importsOf("sub([1], 0, 9)")).toContain("ef_fail");
    expect(importsOf("get([1], 0)")).toContain("ef_fail");
  });

  test("an effect use keeps ef_perform imported (any op, even under a handler)", () => {
    expect(importsOf("Println!(1)")).toContain("ef_perform");
    expect(importsOf("effect Op(): i64; handle { Op!() } case Op() => k { 7 }"))
      .toContain("ef_perform");
  });

  test("live served builtins keep their imports, with interpreter parity", () => {
    expect(importsOf("char(97)")).toContain("ef_char");
    expect(importsOf("round(cos(0) * 100)")).toContain("ef_cos");
    expect(importsOf("args()")).toContain("ef_args");
    expect(parity("char(97)")).toBe("\"a\"");
    expect(parity("round(cos(0) * 100)")).toBe("100");
    expect(parity("len(args())")).toBe(String(process.argv.slice(2).length));
  });

  test("shadowing a served builtin is rejected before codegen", () => {
    const src = "char :: fn(x: i64): i64 { x }; char(97)";
    expect(() => importsOf(src)).toThrow("cannot shadow builtin 'char'");
    expect(parity(src)).toBe("ERR: cannot shadow builtin 'char'");
  });

  test("a program using everything keeps all 7 imports in original order", () => {
    const src = "x :: round(cos(0) * 10) + round(sin(0) * 10) + strlen(char(97)) + number(\"2\") + len(args()); Println!(x); x";
    expect(importsOf(src).toSorted()).toEqual(["ef_args", "ef_char", "ef_cos", "ef_fail", "ef_number", "ef_perform", "ef_sin"]);
    parity(src);
  });
});

describe("wasm binaryen shrink pass (optimizeBinary)", () => {
  test("keeps host ABI exports/imports and semantics after the shrink pass", () => {
    // effectful program: ef_perform must survive the optimizer via the table
    const src = "Println!(\"hi\"); f :: fn(x: i64): i64 ! { Println } { Println!(x); x * 2 }; f(21)";
    const bytes = compile(src);
    assertModule(bytes);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod).map(e => e.name);
    // GC plane: no memory/$hp — run + the 12 accessors only.
    for (const e of [
      "run", "__tag", "__num", "__str_len", "__str_get",
      "__arr_len", "__arr_get", "__mk_num", "__mk_bool", "__str_new",
      "__str_set", "__arr_new", "__arr_set",
    ])
      expect(exports).toContain(e);
    expect(exports).not.toContain("mem");
    expect(exports).not.toContain("__hp");
    expect(importsOf(src)).toContain("ef_perform");
    parity(src);
  });

  test("output is deterministic", () => {
    expect(Buffer.from(compile("len(range(1, 10, 1))")).equals(Buffer.from(compile("len(range(1, 10, 1))")))).toBe(true);
  });
});
// --- split re-emission ------------------------------------------------------
// After-if fragments always exist and fill exactly once per site, and
// arm-internal fragments root at the arm, not the body root.
describe("split re-emission regressions", () => {
  test("if with split sites in both arms: parity", () => {
    parity(`if (1 < 0) {
  Println!("then-arm");
  Println!("after-then")
} else {
  Println!("else-arm");
  Println!("after-else")
};
Println!("after")`);
  });

  test("if with a split site in one arm and a suspended condition path: parity", () => {
    parity(`x :: 0;
if (x < 1) { Println!("then") } else { Println!("else") };
Println!("tail")`);
  });

  test("land calls in both branches of a nested if-else compile", () => {
    // Every non-builtin call is a land-call split site; its rest fragment
    // re-emits from the body root. Rest fragments are memoized by their
    // split chain: same site, same fragment fn.
    const src = `g :: fn(x: i64): i64 { x + 1 };
f :: fn(a: i64): i64 {
  if (a == 0) {
    if (g(a) == 1) { 1 } else { 2 }
  } else {
    if (g(a) == 1) { 3 } else { 4 }
  }
};
Println!(f(0))`;
    expect(() => compile(src)).not.toThrow();
    assertModule(compile(src));
    // And the compiled module computes the same value as the interpreter.
    expect(parity(src)).toBe("unit");
  });

  test("nested-operand land call plus a sibling land call in one body: parity", () => {
    // A land-call result consumed as a nested OPERAND of another expression
    // in the same body as a second (bare let-RHS) land call.
    const src = `vDot :: fn(a: [f64], b: [f64]): f64 { (a.0 * b.0) + ((a.1 * b.1) + (a.2 * b.2)) };
sphereT2 :: fn(d: [f64], c: [f64], r: f64): f64 {
  a :: vDot(d, d);
  b :: -2.0 * vDot(d, c);
  a + b
};
Println!(sphereT2([0.1, 0.0, -2.5], [0.0, 0.0, -5.0], 1.5))`;
    // Compiled output must match the interpreter's stdout, not just its value.
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    let interp: string;
    let wasm: string;
    try {
      interp = show(run(src));
      lines.length = 0;
      wasm = show(runWasm(src));
    } finally {
      console.log = orig;
    }
    expect(lines).toEqual(["-18.740000000000002"]);
    expect(wasm).toBe(interp);
    expect(wasm).toBe("unit");
  });

  test("fn-value selection through if branches stays correct (split-chain fix lock-in)", () => {
    // Lambdas picked by an if-else and called through the selection were
    // miscompiled before the split-chain memo (restByChain): the wrong arm's
    // function could run. The interpreter and the compiled module must agree
    // on both picks, and the printed output must be the picked results.
    const src = `f1 :: fn(a: f64): f64 { a * 2.0 };
f2 :: fn(a: f64): f64 { a + 1.0 };
pick :: fn(c: bool): (f64) -> f64 {
  if (c) { f1 } else { f2 }
};
Println!(pick(true)(1.5));
Println!(pick(false)(1.5))`;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      expect(show(runWasm(src))).toBe("unit");
    } finally {
      console.log = orig;
    }
    expect(lines).toEqual(["3", "2.5"]);
  });

});
