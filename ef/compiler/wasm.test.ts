import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import binaryen from "binaryen";
import {run} from "./eval.ts";
import {BIN_FEATURES, compile} from "./wasm.ts";
import {prepare, type EffectInterp} from "./pipeline.ts";
import {discover, optimize, assignIndices, layoutStatics} from "./wasm_pipeline.ts";
import {toCps} from "./cps.ts";
import {planIr, classifySlots, type TLevel, letkP, scopeP, dcallP} from "./wasm_plan.ts";
import {runWasm} from "./wasm_host.ts";
import {mkSlice, mkTup, show, type Value} from "./env.ts";

// binaryen's typings lag its runtime (see wasm.ts RawBinaryen): readBinary's features argument is untyped in the .d.ts.
const bin = binaryen as typeof binaryen & {
  readBinary(bytes: Uint8Array, features: number): ReturnType<typeof binaryen.wrapModule>,
};

const workspaceDir = import.meta.dir;

// The wasm target must be observationally equivalent to the interpreter:
// for every program below, `run(src)` and `runWasm(src)` produce the same
// `show()` rendering (values AND error messages).
function parity(src: string) {
  const interpOut = ((): string => {
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
  expect(wasm).toBe(interpOut);
  return interpOut;
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
    // The check stamps the runtime markers discover reads.
    const {prog} = prepare("x :: 1;\ns :: \"a\";\npi :: PI;\nl :: len;\nx;");
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
  }, 90000);

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

  test("unstamped operator sites apply the interpreter's own operators via ef_binop", () => {
    // Sites the checker leaves unstamped — string `+` and string
    // comparisons — call the operator's trampoline, which routes through
    // the ef_binop host import: the interpreter's own operator closure
    // runs, so value- and error-parity hold by construction.
    expect(parity("\"a\" + \"b\"")).toBe("\"ab\"");
    expect(parity("Println!(\"a\" < \"b\")")).toBe("ERR: Expected number, got \"a\"");
    expect(parity("Println!(\"z\" > \"b\")")).toBe("ERR: Expected number, got \"z\"");
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
    // tree-shaking never sees an occluded builtin. compile()'s check
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
    parity("1 + \"a\""); // type error from the check
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
    // Same unhandled-effect error message as the interpreter, and the same
    // timing: both runners reject statically at their entry (exec / the wasm
    // pipeline) before anything runs.
    parity("effect Foo(n: i64): i64; Foo!(1) + 2");
    // The buildwasm entry has no runner: the static gate rejects the same
    // ops `ef run` rejects, before a module is emitted.
    expect(() => compile("effect Foo(n: i64): i64; Foo!(1) + 2")).toThrow("Unhandled effect: Foo");
    // One-shot interp injection overrides the default interpretation — an
    // op the interp covers passes the gate and runs.
    // i64 args unbox to BigInt at the host boundary.
    expect(show(runWasm("effect Foo(n: i64): i64; Foo!(21) * 2", {Foo: (args, k) => k(Number(args[0]) + 1)}))).toBe("44");
  });

  test("static gate rejects before any side effect (same timing as exec)", () => {
    // Mirror of the eval-side test (index.test.ts): a Println before the
    // unhandled op must not run — rejectUnhandled fires at the pipeline
    // entry, before evaluation or codegen.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      expect(() => runWasm(`effect T(x: i64): i64; Println!("boom"); T!(1)`))
        .toThrow("Unhandled effect: T");
    } finally {
      console.log = orig;
    }
    expect(logs).toEqual([]); // Println never ran: rejection precedes evaluation
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
  }, 20000); // parity() spawns both runners per assertion; tips over the 5s default under suite load

  test("mixed functions: row-{} body with an internal handle (direct boundary)", () => {
    // Island mid-body, result flows through the dret boundary to a pure call site.
    expect(parity(`effect Tick(n: i64): i64;
      mix :: fn(x: i64): i64 {
        handle { Tick!(x) + 1 } case Tick(n) => k { k(n * 10) }
      };
      mix(3) + mix(4)`)).toBe("72");
    // Tail handle: the HDL's next is the never-set $ret — the emitted cell
    // chains to the terminal return-cell, the case completion returns.
    expect(parity(`effect Tick(n: i64): i64;
      mix :: fn(x: i64): i64 {
        handle { Tick!(x) } case Tick(n) => k { n * 2 }
      };
      mix(21)`)).toBe("42");
    // Mixed callee inside another handler's island (generic-call context).
    expect(parity(`effect Tick(n: i64): i64;
      effect Tock(n: i64): i64;
      mix :: fn(x: i64): i64 {
        handle { Tick!(x) } case Tick(n) => k { n + 100 }
      };
      handle { mix(1) + Tock!(7) } case Tock(n) => k { k(n) }`)).toBe("108");
    // Multi-shot resume inside a mixed function (the amb shape): each Choose
    // resume re-enters the spine through the resume lambda's tail contCall;
    // propagating performs must reach the Emit island across the boundary.
    expect(parity(`effect Choose(lo: i64, hi: i64): i64;
      effect Emit(t: [i64]): unit;
      inner :: fn(n: i64): unit ! { Choose, Emit } {
        a :: Choose!(1, n);
        Emit!([a])
      };
      middle :: fn(n: i64): unit ! { Emit } {
        handle { inner(n) } case Choose(lo, hi) => k {
          each(fn(x, _) { k(x) }, range(lo, hi + 1, 1))
        }
      };
      outer :: fn(n: i64): [[i64]] {
        handle { middle(n) } case Emit(t) => k {
          concat([t], k(unit))
        } case Return(v) => k { [] }
      };
      outer(2)`)).toBe("[[1], [2]]");
  });

  test("interp injection overrides builtin effects (Read mock)", () => {
    const p = join(tmpdir(), `ef-wasm-mock-${process.pid}.txt`);
    const src = `Read!("${p}")`;
    // Both runners take the canonical CPS interp: k delivers the resumed
    // value (the wasm host adapts its delivery to the perform site).
    expect(show(run(src, {Read: (_args, k) => k("mocked")}))).toBe("\"mocked\"");
    expect(show(runWasm(src, {Read: (_args, k) => k("mocked")}))).toBe("\"mocked\"");
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

describe("spine-gated resume typing: multi-shot resume over HOF loops", () => {
  test("abort idiom: a k-free case body skips the delivery constraint", () => {
    expect(parity(`effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
      handle { map(cb, [1, 2]) } case Op() => k { 42 }`)).toBe("42");
  });

  test("transforming handler: len outside, k(10) inside", () => {
    expect(parity(`effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
      len(handle { map(cb, [1, 2]) } case Op() => k { k(10) })`)).toBe("2");
  });

  test("multi-shot delivery over map: both deliveries land at their own element", () => {
    // Per-element land state: each iteration's land cell freezes its own
    // index, so re-delivery of a captured chain re-enters its own slot
    // instead of double-advancing a shared counter (plan repro 2 — a
    // shared-counter land double-advances here and misindexes the stores).
    expect(parity(`effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
      handle { map(cb, [1, 2]) } case Op() => k { q := k(10); k(11); q }`)).toBe("[11, 11]");
  });

  test("each multi-shot: the callback i argument tracks per-element land state", () => {
    // set()'s index is the callback's i: a shared land state would
    // double-advance past the element and misindex the stores.
    expect(parity(`effect Op(): unit; a := [0, 0, 0];
      cb :: fn(x: i64, i: i64): unit { Op!(); set(a, i, x); unit };
      handle { each(cb, [7, 8, 9]) } case Op() => k { q := k(unit); k(unit); q };
      a`)).toBe("[7, 8, 9]");
  });

  test("flatmap multi-shot: per-element land state (same land structure as map)", () => {
    expect(parity(`effect Op(): i64; cb :: fn(x: i64, i: i64): [i64] { [x + Op!(), i] };
      handle { flatmap(cb, [1, 2]) } case Op() => k { q := k(10); k(20); q }`)).toBe("[11, 0, 12, 1]");
  });

  test("each multi-shot unit shape: a delivery per resume", () => {
    expect(parity(`effect Op(): i64; acc := 0;
      cb :: fn(x: i64, i: i64): unit { acc = acc + x * 10 + i + Op!(); unit };
      handle { each(cb, [1, 2]) } case Op() => k { q := k(1); k(2); q };
      acc`)).toBe("35");
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

describe("wasm devirtualization (wasm_devirt.ts: static direct calls, inline rests, tight map loops)", () => {
  // Collect dcall nodes from a term subtree.
  const dcalls = (t: unknown, out: unknown[] = []): unknown[] => {
    const n = t as {t: string, [k: string]: unknown};
    if (n.t === "dcall") out.push(n);
    for (const k of ["rest", "body", "a", "b"]) {
      const sub = n[k];
      if (sub !== undefined && sub !== null && typeof sub === "object") dcalls(sub, out);
    }
    if (Array.isArray(n["cases"])) for (const c of n["cases"] as {body: unknown}[]) dcalls(c.body, out);
    return out;
  };

  test("purity fixpoint + dcall devirt/inlineRest annotations", () => {
    // fib: self-recursive, no perform/handle/call — pure; every dcall site
    // gets a devirt annotation; the non-tail rests (n-1 + n-2 joins) inline.
    const src = `fib :: fn(n: i64): i64 {
  if (n < 2) { n } else { fib(n - 1) + fib(n - 2) }
};
fib(28)`;
    const {prog} = prepare(src);
    const ir = toCps(prog);
    const plan = planIr(ir);
    expect(plan.cfnPure).toEqual([true]);
    const sites = dcalls(ir.funcs[0].body) as Parameters<typeof dcallP>[0][];
    expect(sites.length).toBe(2);
    for (const s of sites) {
      expect(dcallP(s)?.devirt?.fun).toBe(0);
      expect(dcallP(s)?.inlineRest).toBe(true);
    }
  });

  test("mixed fn (row {} with an internal handle) reached by dcall: devirt keeps the cell path", () => {
    // mixed is direct-classified but impure (its island performs): the dcall
    // still devirtualizes (static T_DABI call — mixed's entry ABI), but the
    // rest must NOT inline (an escaped perform would lose it).
    const src = `effect Op(): i64;
mixed :: fn(x: i64): i64 { handle { x + Op!() } case Op() => k2 { k2(100) } };
caller :: fn(x: i64): i64 { mixed(x) + 1 };
[caller(1), caller(2)]`;
    const {prog} = prepare(src);
    const ir = toCps(prog);
    const plan = planIr(ir);
    expect(plan.cfnPure[0]).toBe(false); // mixed: internal handle
    expect(plan.cfnPure[1]).toBe(false); // caller: dcall to an impure fn
    expect(parity(src)).toBe("[102, 103]");
  });

  test("mutual recursion through nested closures: devirt with capts (env path) + inline rests", () => {
    // up captures down (capts non-empty): the static call still reads the
    // closure's env; down/up's rests inline. down(9) recurses 18 levels.
    const src = `down :: fn(n: i64): i64 {
  up :: fn(m: i64): i64 { if (m == 0) { 100 } else { 1 + down(m - 1) } };
  if (n == 0) { 0 } else { up(n) }
};
[down(4), down(0), down(9)]`;
    expect(parity(src)).toBe("[4, 0, 9]");
  });

  test("inline rest with nesting: while body dcalls, rest jumps back to the loop head", () => {
    const src = `id :: fn(x: i64): i64 { x + 1 };
s := 0;
i := 0;
while (i < 5) { s = s + id(i); i = i + 1 };
s`;
    expect(parity(src)).toBe("15");
  });

  test("dcall site on a resumed path: inline rest runs after a multi-shot resume", () => {
    // The dcall sits inside the continuation the handler resumes into; its
    // rest (`* 2` + boundary) runs inline on that path.
    const src = `effect Op(): i64;
id :: fn(x: i64): i64 { x + 1 };
handle { s := Op!(); id(s) * 2 } case Op() => k { k(1) }`;
    expect(parity(src)).toBe("4");
  });

  test("assign to a captured var after a dcalled pure fn returns (env path sees the write)", () => {
    // g captures k: the static call loads the closure and chains the callee
    // frame through its env; a later assign to k is visible through it.
    const src = `id :: fn(x: i64): i64 { x };
k := 7;
g :: fn(x: i64): i64 { x + k };
k = 42;
[g(1), id(k)]`;
    expect(parity(src)).toBe("[43, 42]");
  });

  test("tight map loop: pure direct callback specializes; performing callback stays generic", () => {
    // inc is pure+direct: map(inc, ...) emits a per-site tight loop fn.
    expect(parity("inc :: fn(x: i64): i64 { x + 1 }; map(inc, [1, 2, 3])")).toBe("[2, 3, 4]");
    expect(parity("inc2 :: fn(x: i64, i: i64): i64 { x + 1 }; each(inc2, [1, 2, 3])")).toBe("unit");
    // flatmap with a pure direct callback takes the tight loop too.
    expect(parity("dup :: fn(x: i64, i: i64): [i64] { [x, x] }; flatmap(dup, [1, 2])")).toBe("[1, 1, 2, 2]");
    // A performing callback: generic loop path under a resuming handler.
    const src = `effect Op(): i64;
performer :: fn(x: i64, i: i64): i64 { Op!() };
handle { each(performer, [1, 2, 3]) } case Op() => k { k(0) }`;
    expect(parity(src)).toBe("unit");
    // each's multi-shot resume re-enters the same land cell per element.
    const srcEach = `effect Op(): i64;
cb :: fn(x: i64, i: i64): i64 { Op!() };
handle { each(cb, [1, 2, 3]); Op!() } case Op() => k { k(k(0)) }`;
    expect(parity(srcEach)).toBe("0");
    // map with a single resume per perform: results collected across them.
    const src2 = `effect Op(): i64;
cb :: fn(x: i64): i64 { Op!() };
handle { map(cb, [1, 2]) } case Op() => k { k(10) }`;
    expect(parity(src2)).toBe("[10, 10]");
  });

  test("any-callee impure chain: stays on the generic path (known pre-existing wasm divergence)", () => {
    // h is direct-classified but impure through the any hole (g's body has a
    // generic call whose callee performs at runtime). The fixpoint keeps h
    // and every gate off this chain; the wasm op-discovery miss behind the
    // any-call is a pre-existing known limitation (see plan Non-goals) —
    // pinned here as an interp/wasm divergence smoke test.
    const src = `effect Op(): i64;
g :: fn(a: any): i64 { a(0) };
h :: fn(f: any): i64 { g(f) };
performer :: fn(x: i64): i64 { Op!() };
handle { h(performer) } case Op() => k { 43 }`;
    const interp = ((): string => {
      try {
        return show(run(src));
      } catch (e) {
        return "ERR: " + (e as Error).message;
      }
    })();
    expect(interp).toBe("43");
    expect(() => compile(src)).not.toThrow();
    const wasm = ((): string => {
      try {
        return show(runWasm(src));
      } catch (e) {
        return "ERR: " + (e as Error).message;
      }
    })();
    expect(wasm).not.toBe("43"); // the known divergence: the op never reaches the handler
  });
});

describe("wasm numeric entry ABI (wasm_devirt.ts numericEntries: unboxed direct calls, shape-tag dispatch)", () => {
  test("specialized calls at all six widths", () => {
    expect(parity("inc :: fn(n: i32): i32 { n + 1 }; inc(41)")).toBe("42");
    expect(parity("inc :: fn(n: u32): u32 { n + 1 }; inc(41)")).toBe("42");
    expect(parity("inc :: fn(n: i64): i64 { n + 1 }; inc(41)")).toBe("42");
    expect(parity("inc :: fn(n: u64): u64 { n + 1 }; inc(41)")).toBe("42");
    // f32 exercises the fround-at-producing-nodes discipline.
    expect(parity("dbl :: fn(n: f32): f32 { n * 2.0 }; dbl(1.5)")).toBe("3");
    expect(parity("dbl :: fn(n: f64): f64 { n * 2.0 }; dbl(1.5)")).toBe("3");
    // Multi-arg + division (traps and truncation stay interpreter-exact).
    expect(parity("f :: fn(a: i64, b: i64): i64 { a / b }; f(7, 2)")).toBe("3");
    expect(parity("f :: fn(a: i64, b: i64): i64 { a / b }; f(7, 0)")).toBe("ERR: integer divide by zero");
    // u64 keeps the unsigned op selection exact through the raw entry.
    expect(parity("f :: fn(a: u64, b: u64): u64 { a / b }; f(18446744073709551615, 2)")).toBe("9223372036854775807");
  });

  test("mixed-signature fn (one boxed param) stays on the boxed static call", () => {
    // A string param makes the signature non-numeric: no numeric entry, the
    // site takes the boxed T_DABI call — values and effects identical.
    expect(parity("f :: fn(n: i64, s: string): i64 { n + strlen(s) }; f(40, \"ab\")")).toBe("42");
  });

  test("polymorphic direct fn gets no numeric entry (boxed static call)", () => {
    // id's checker type keeps quantified type vars: deepRes leaves them
    // unbound, so no entry exists and both instantiations stay boxed.
    expect(parity("id :: fn(x) { x }; id(7)")).toBe("7");
    expect(parity("id :: fn(x) { x }; id(2.5)")).toBe("2.5");
    expect(parity("id :: fn(x) { x }; id(\"s\")")).toBe(String.raw`"s"`);
  });

  test("escaping numeric fn called generically rides the shape tag", () => {
    // A static site first (the plan's entry criterion: ≥1 devirt site with a
    // matching numeric signature), then the same closure escapes through an
    // apply-typed value slot: the generic site's stamps shape-match the
    // entry, so the runtime tag check dispatches the raw entry; a
    // mismatching closure would fail the tag and take the boxed path (same
    // values either way).
    const src = `apply :: fn(f: (i64) -> i64, x: i64): i64 { f(x) };
inc :: fn(n: i64): i64 { n + 1 };
dec :: fn(n: i64): i64 { n - 1 };
a :: inc(41);
apply(inc, 1) + apply(dec, 2) + a`;
    expect(parity(src)).toBe("45");
    // Structural lock-in: the numeric entry (frame, i64) -> i64 exists and
    // the generic site dispatches it through a call_indirect.
    const mod = bin.readBinary(compile(src), BIN_FEATURES);
    try {
      const text = mod.emitText();
      expect(text).toContain("(param (ref null $4) i64) (result i64)");
      expect(text).toContain("call_indirect");
    } finally {
      mod.dispose();
    }
  });

  test("numeric fn inside a handler island", () => {
    // The handler island performs across the numeric call: the entry stays
    // boxed-free (the callee is handler-free) and the island machinery is
    // untouched.
    expect(parity(`effect Op(): i64;
h :: fn(x: i64): i64 { handle { Op!() + x } case Op() => k { k(2) } };
g :: fn(n: i64): i64 { n * 3 };
h(g(5))`)).toBe("17");
  });

  test("numeric entries carry the closure env for capts", () => {
    // The callee's body reads its captured env through the frame chain
    // (the entry's frame operand is the closure env).
    expect(parity(`k :: 100;
addk :: fn(n: i64): i64 { n + k };
addk(1) + addk(2)`)).toBe("203");
  });
});

describe("wasm typed slots + scope-frame elision (wasm_plan.ts classifySlots + wasm_term.ts emission)", () => {
  // A planned level as the audit sees it: slot map, surviving typed map,
  // elision flag.
  type Lv = {slots: Map<string, number>, typed?: Map<string, string>, elided?: boolean};

  // Every TLevel planIr creates for `src`: scope nodes carry their level
  // directly; letk/dcall annotations carry fnLvl plus the entry/rest scope
  // snapshots (shared level objects, so the Set dedups).
  const audit = (src: string): Lv[] => {
    const {prog} = prepare(src);
    const ir = toCps(prog);
    const plan = planIr(ir);
    const out: Lv[] = [];
    const seen = new Set<object>();
    const pushL = (l: unknown): void => {
      if (l !== null && l !== undefined && typeof l === "object" && !seen.has(l)) {
        seen.add(l);
        out.push(l as Lv);
      }
    };
    pushL(plan.globalLvl); // top-level bindings type on the global level
    const walk = (t: unknown): void => {
      if (t === null || t === undefined || typeof t !== "object") return;
      const n = t as {[k: string]: unknown};
      const sp = scopeP(t as Parameters<typeof scopeP>[0]);
      if (sp !== undefined) pushL(sp);
      const lp = letkP(t as Parameters<typeof letkP>[0]);
      if (lp !== undefined) {
        pushL(lp.fnLvl);
        for (const l of lp.entryScope ?? []) pushL(l);
        for (const l of lp.restScope ?? []) pushL(l);
      }
      const dp = dcallP(t as Parameters<typeof dcallP>[0]);
      if (dp !== undefined) {
        pushL(dp.fnLvl);
        for (const l of dp.entryScope ?? []) pushL(l);
      }
      for (const k of ["body", "rest", "a", "b"]) if (n[k] !== undefined) walk(n[k]);
      if (Array.isArray(n["cases"])) for (const c of n["cases"] as {body: unknown}[]) walk(c.body);
    };
    walk(ir.term);
    for (const f of ir.funcs) walk(f.body);
    return out;
  };

  // No planned level may type `name` (every path to it was poisoned).
  const assertUntyped = (levels: Lv[], name: string): void => {
    for (const l of levels) {
      expect(l.typed?.has(name) ?? false).toBe(false);
    }
  };

  test("classifySlots: xread poisoning, elision only for fully-typed elideOk scopes", () => {
    const lvl = (names: string[], elideOk = false): TLevel => {
      const slots = new Map<string, number>();
      for (const n of names) slots.set(n, slots.size);
      const l: TLevel = {slots, size: names.length, locals: null};
      if (elideOk) l.elideOk = true;
      return l;
    };
    // All-typed candidate set on a scope level: typed + elided.
    const a = lvl(["x", "y"], true);
    classifySlots(new Map([[a, new Map([["x", "i64"], ["y", "i64"]])]]), new Map());
    expect(a.typed?.get("x")).toBe("i64");
    expect(a.typed?.get("y")).toBe("i64");
    expect(a.elided).toBe(true);
    // A cross-fn read poisons the name: it loses typing, the scope stays
    // materialized.
    const b = lvl(["x", "y"], true);
    classifySlots(new Map([[b, new Map([["x", "i64"], ["y", "i64"]])]]),
      new Map([[b, new Set(["x"])]]));
    expect(b.typed?.has("x")).toBe(false);
    expect(b.typed?.get("y")).toBe("i64");
    expect(b.elided ?? false).toBe(false);
    // Partial typing never elides (the frame still carries the holes).
    const c = lvl(["x", "y"], true);
    classifySlots(new Map([[c, new Map([["x", "f64"]])]]), new Map());
    expect(c.typed?.get("x")).toBe("f64");
    expect(c.elided ?? false).toBe(false);
    // Non-scope levels (elideOk unset) type but never elide: chain anchors
    // must keep allocating their frame.
    const d = lvl(["x"]);
    classifySlots(new Map([[d, new Map([["x", "i32"]])]]), new Map());
    expect(d.typed?.get("x")).toBe("i32");
    expect(d.elided ?? false).toBe(false);
  });

  test("while-body i64 assign exactness: typed op temps, cells stay boxed", () => {
    const src = `x := 9007199254740993;
i := 0;
while (i < 2) { x = x + 1; i = i + 1; Println!(i); }
x`;
    // 2^53+1 stays exact through the typed op temps and the boxed cells.
    expect(parity(src)).toBe("9007199254740995");
    const levels = audit(src);
    assertUntyped(levels, "x"); // assigned with an unstamped val: poisoned
    assertUntyped(levels, "i");
    // The arithmetic joins did classify.
    expect(levels.some(l => [...(l.typed?.values() ?? [])].includes("i64"))).toBe(true);
  });

  test("scope-frame elision: a fully-typed while body's extend is skipped, hops stay right", () => {
    // The perform sits inside the loop body scope: its continuation thunk
    // re-enters through the elided level, so the resume-side frame walk
    // must skip the elided hop together with the skipped extend.
    const src = `effect Op(): i64;
s := 0;
handle { while (s < 3) { s = s + Op!() }; s } case Op() => k { k(3) }`;
    expect(parity(src)).toBe("3");
    const levels = audit(src);
    expect(levels.some(l => l.elided === true && l.slots.size > 0 && l.typed?.size === l.slots.size)).toBe(true);
  });

  test("multi-shot rest-thunk read after resume: the read is cross-fn, the slot stays boxed", () => {
    const src = `effect Op(): i64;
x: i64 :: 10;
handle { Op!() } case Op() => k { k(1); k(2) } + x`;
    expect(parity(src)).toBe("12");
    assertUntyped(audit(src), "x");
  });

  test("escaping-closure capture: the captured slot stays boxed (env path)", () => {
    const src = `mk :: fn() { x: i64 :: 7; fn() { x } };
mk()()`;
    expect(parity(src)).toBe("7");
    assertUntyped(audit(src), "x");
  });

  test("case-fn depth>0 read: cross-fn reach keeps the site slot boxed", () => {
    const src = `effect Op(): i64;
y: i64 :: 5;
handle { y + Op!() } case Op() => k { k(y + 1) }`;
    expect(parity(src)).toBe("11");
    assertUntyped(audit(src), "y");
  });

  test("top-level captured assign: cross-fn writes poison candidacy, env path sees them", () => {
    const src = `acc := 0;
bump :: fn(v: i64): i64 { acc = acc + v; acc };
[bump(1), bump(2), acc]`;
    expect(parity(src)).toBe("[1, 3, 3]");
    assertUntyped(audit(src), "acc");
  });

  test("f32 slots type and round at every producing node (fround parity)", () => {
    const src = `a: f32 :: 0.1;
b: f32 :: 0.2;
a + b == @as(0.3, f32)`;
    expect(parity(src)).toBe("true");
    const levels = audit(src);
    // The literal binds survived classification as f32 typed slots.
    expect(levels.some(l => [...(l.typed?.values() ?? [])].includes("f32"))).toBe(true);
  });

  test("numeric entry over typed joins: the dcall result lands typed at the site", () => {
    const src = `add3 :: fn(a: i32, b: i32, c: i32): i32 { a + b + c };
add3(1, 2, 3)`;
    expect(parity(src)).toBe("6");
    const levels = audit(src);
    expect(levels.some(l => [...(l.typed?.values() ?? [])].includes("i32"))).toBe(true);
  });
});

describe("wasm host boundary (wasm_host.ts)", () => {
  test("value crossings box/unbox through every host branch", () => {
    for (const [src, expected, interp] of [
      // Custom interps returning tuples/slices exercise the tup and arr box
      // branches; the results unbox back through the matching arms.
      ["effect Make(): [i64, i64]; f :: fn(): i64 { t: [i64, i64] :: Make!(); t.0 + t.1 }; f()", "3", {Make: (_args, k) => k(mkTup([1, 2]))}],
      ["effect Roll(): [i64]; Roll!()", "[5, 6]", {Roll: (_args, k) => k(mkSlice([5, 6]))}],
      // The typed slot forces the $U32 box; a bare @as at top level rides
      // the unstamped pass-through and crosses as an f64 num box instead.
      ["u: u32 :: 4000000000; u", "4000000000", undefined],
      ["\"hi there\"", "\"hi there\"", undefined],
      ["id :: fn(x: i64): i64 { x }; id", "[fn]", undefined],
    ] as [string, string, EffectInterp | undefined][]) {
      expect(show(runWasm(src, interp))).toBe(expected);
    }
  });

  test("unboxable interp results are rejected with the box error", () => {
    expect(() => runWasm("effect Foo(n: i64): i64; Foo!(1)", {Foo: (_args, k) => k({tag: "fn"} as Value)}))
    .toThrow(/cannot box value \[fn\]/);
  });

  test("array window OOB carries the field name through the fail channel", () => {
    expect(parity(`xs: [i64] :: [1, 2];
xs.5`)).toBe("ERR: .5: index 5 out of bounds [0, 2)");
  });
});
