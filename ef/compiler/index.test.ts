import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, unlinkSync, existsSync, writeFileSync} from "node:fs";
import {execSync} from "node:child_process";
import {run, newCtx, exec, type Ctx} from "./eval.ts";
import {prepare} from "./pipeline.ts";
import {showT, showErr, TypeError_} from "./types.ts";
import {show, sliceElems, mkSlice, mkTup, type Slice, type Value} from "./env.ts";
import {Parser} from "./parser.ts";
import {toCps} from "./cps.ts";
import type {CIr, CTerm} from "./cps_ir.ts";

// typeOf: return the inferred type of the last expression, as a string.
// Surfaces effect sets in function signatures, e.g. `(i64) -> i64 ! { Emit }`.
export function typeOf(src: string): string {
  return showT(prepare(src).checked.lastType);
}

// The REPL line protocol the exec tests share: prepare against ctx's
// accumulator, then exec (repl.ts wraps the same two steps around its echo
// rule).
const execLine = (ctx: Ctx, src: string) => {
  const {prog, checked} = prepare(src, ctx.checked);
  return exec(prog, ctx, checked);
};

const tmpPath = (n: string) => join(tmpdir(), `ef-test-${process.pid}-${n}.txt`);

test("exec drives a REPL session: bindings persist, lastType resolved", () => {
  const ctx = newCtx();
  const l1 = execLine(ctx, "add :: fn(a: i64, b: i64): i64 { a + b };");
  const l2 = execLine(ctx, "add(1, 2)");
  expect(l1.value).toBe(null);
  expect(l1.lastIsExpr).toBe(false);
  expect(l2.value).toBe(3n);
  expect(l2.lastIsExpr).toBe(true);
  expect(showT(l2.lastType)).toBe("i64");
});

test("run accepts a custom effect interpreter (fakes Read, no fs touched)", () => {
  expect(run("Read!(\"missing.txt\")", {Read: (_a, k) => k("faked")}))
    .toBe("faked");
});

test("Nondeterminism — multi-shot resume, declared effect + return type", () => {
expect(show(run(`
effect Choose(opts: [i64]): i64;
handle {
  x :: Choose!([1, 2, 3]);
  y :: Choose!([10, 20]);
  [x, y]
} case Return(v) => k { [v] }
  case Choose(opts) => k { flat(map(k, opts)) }
`))).toBe("[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]");
});

test("Exception — non-resuming handler aborts", () => {
expect(show(run(`
effect Div(a: i64, b: i64): i64;
handle {
  r :: Div!(10, 0);
  [r]
} case Div(a, b) => k {
  if (b == 0) { ["div by zero"] } else { k(a / b) }
}
`))).toBe("[\"div by zero\"]");
});

test("Deep handler threading a log across resumes", () => {
expect(show(run(`
effect Log(msg: string): unit;
effect Result(v: string): unit;
handle {
  Log!("a");
  Log!("b");
  Result!("42")
} case Log(msg) => k { concat([msg], k(unit)) }
  case Result(v) => k { [v] }
`))).toBe("[\"a\", \"b\", \"42\"]");
});

test("Effect propagation through an inner handler to an outer one", () => {
expect(show(run(`
effect Emit(m: string): unit;
effect Other(m: string): unit;
handle {
  handle { Emit!("hi") } case Other(m) => k { ["should-not-match"] }
} case Emit(m) => k { [m] }
`))).toBe("[\"hi\"]");
});

test("Typed recursive function with annotation", () => {
expect(show(run(`
fact :: fn(n: i64): i64 {
  if (n == 0) { 1 } else { n * fact(n - 1) }
};
fact(5)
`))).toBe("120");
});

test("Short-circuit && / || and infix arithmetic", () => {
expect(show(run(`
guard :: fn(x: i64): string {
  if (x > 0 && x < 10) { "in" } else { "out" }
};
[guard(5), guard(50)]
`))).toBe("[\"in\", \"out\"]");
});

test("Type annotations on let", () => {
expect(show(run(`
x: i64 :: 5;
y: i64 :: x + 3;
y
`))).toBe("8");
});

describe("Equality, Exit/Wait effects, inferred-any warning", () => {
  test("== / != require same type (literals flex, widths are strict)", () => {
    expect(show(run(`1 == 2`))).toBe("false");
    expect(show(run(`1 != 2.5`))).toBe("true");
    expect(show(run(`"a" == "b"`))).toBe("false");
  });

  test("Exit is an interceptable effect (handler can abort instead of resuming)", () => {
    // The handler returns the exit code without resuming, so `Exit!(42)`
    // yields 42 and the code after it ("post") never runs — proving Exit is an
    // ordinary effect, not a magic builtin that always kills the process.
    expect(show(run(`
handle {
  Out!("pre");
  Exit!(42);
  Out!("post")
} case Exit(c) => k { c }
  case Out(s) => k { Println!(s); k(unit) }
`))).toBe("42");
  });

  test("Wait is an effect with a pure-looking unit type", () => {
    expect(typeOf("f :: fn(): unit ! { Wait } { Wait!(0) };"))
    .toBe("unit");
    // The default interpretation runs for real: sleepSync(0) returns
    // immediately, then resumes with unit.
    expect(run("Wait!(0)")).toBe(null);
  });

  test("inferred `any` warns; an explicit `: any` annotation is silent", () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (s: string) => { warned.push(s); };
    try {
      typeOf("g :: fn(x: any): any { x };");            // inferred (any) -> any  -> warn
      typeOf("g: (any) -> any :: fn(x: any): any { x };"); // explicit annotation -> silent
      typeOf("xs :: [1, 2, 3]; xs");     // array literal -> [i64]   -> silent
    } finally {
      console.warn = orig;
    }
    expect(warned.length).toBe(1);
    expect(warned[0]).toMatch(/`g` inferred as .*\(any\) -> any/);
  });
});

describe("Declarations: consts vs mutable bindings", () => {
  test(":: binds a const; := binds a mutable variable", () => {
    expect(show(run(`c :: 41; inc :: fn(n: i64): i64 { n + 1 }; inc(c)`))).toBe("42");
    expect(show(run(`x := 1; x = x + 1; x`))).toBe("2");
  });
  test("assignment to a const is a compile-time error", () => {
    expect(() => run(`c :: 1; c = 2;`)).toThrow("cannot assign to const 'c'");
  });
  test("assignment to a const destructured field is a compile-time error", () => {
    expect(() => run(`[a, b] :: [1.0, 2.0]; a = 3.0;`)).toThrow("cannot assign to const 'a'");
  });
  test("assignment inside a const's own initializer closure is rejected", () => {
    expect(() => run(`c :: fn(): i64 { c = 1; 0 }; c();`)).toThrow("cannot assign to const 'c'");
  });
  test("typed forms: x: T = e (mutable) and x: T :: e (const)", () => {
    expect(typeOf(`m: [f64, f64] = [1.0, 2.0]; m`)).toBe("[f64, f64]");
    expect(typeOf(`k: i32 :: 1; k`)).toBe("i32");
    expect(show(run(`g: i64 = 5; g = g * 2; g`))).toBe("10");
    expect(() => run(`k: i32 :: 1; k = 2;`)).toThrow("cannot assign to const 'k'");
  });
  test("typed mutable destructuring [a: T, b] := e", () => {
    expect(show(run(`p: [i64, i64] = [3, 4]; [a: i64, b: i64] := p; a = a + b; a`))).toBe("7");
  });
  test("shadowing is prohibited: redeclaration, inner scopes, params, builtins", () => {
    // Same frame: a later binding never replaces an earlier one, in either
    // mutability direction.
    expect(() => run(`x := 1; x :: 2;`)).toThrow("cannot redeclare 'x'");
    expect(() => run(`x :: 1; x := 2;`)).toThrow("cannot redeclare 'x'");
    // Child frames (lambda bodies, handler cases) may not hide outer bindings.
    expect(() => run(`x :: 1; g :: fn(): i64 { x :: 2; x }; g()`)).toThrow("cannot shadow 'x'");
    // Parameters may not shadow outer bindings, their own function's name, or
    // each other.
    expect(() => run(`x :: 1; f :: fn(x: i64): i64 { x }; f(1)`)).toThrow("cannot shadow 'x'");
    expect(() => run(`f :: fn(f: i64): i64 { f };`)).toThrow("cannot shadow 'f'");
    expect(() => run(`f :: fn(x: i64, x: i64): i64 { x };`)).toThrow("cannot redeclare 'x'");
    // Destructure fields follow the same rule, within the pattern too.
    expect(() => run(`[a, a] := [1, 2];`)).toThrow("cannot redeclare 'a'");
    expect(() => run(`a :: 1; [a, b] := [1, 2];`)).toThrow("cannot redeclare 'a'");
    expect(() => run(`x :: 1; g :: fn(): i64 { [x] := [2]; x }; g()`)).toThrow("cannot shadow 'x'");
    // Builtin names (incl. operators like `neg`) are reserved everywhere.
    expect(() => run(`len :: 1;`)).toThrow("cannot shadow builtin 'len'");
    expect(() => run(`f :: fn(len: i64): i64 { len };`)).toThrow("cannot shadow builtin 'len'");
    expect(() => run(`effect T(n: i64): i64; handle { T!(1) } case T(len) => k { len }`))
      .toThrow("cannot shadow builtin 'len'");
    // `_` is the discard wildcard: repeatable, rebindable, shadowing-free.
    expect(show(run(`[_, x] := [1, 2]; [_, y] := [3, 4]; [x, y]`))).toBe("[2, 4]");
    expect(show(run(`each(fn(_, _) { 0 }, [1]); 5`))).toBe("5");
    // Effect declarations are a separate namespace: a binding may share an
    // effect op's name (`Out!` is unaffected).
    expect(show(run(`Out :: 1; Out`))).toBe("1");
  });
  test("lambda parameters are mutable", () => {
    expect(show(run(`halve :: fn(n: i64): i64 { n = n / 2; n }; halve(10)`))).toBe("5");
  });
  test("an annotation requires = or :: (no := after :)", () => {
    expect(() => run(`x: i32 := 1;`)).toThrow("Expected \"=\"");
  });
});

describe("Tuples, aliases, and field access", () => {
  test("homogeneous literal is still an array", () => {
    expect(typeOf(`[1, 2, 3]`)).toBe("[i64]");
  });
  test("heterogeneous literal is a tuple", () => {
    expect(typeOf(`[1, "a", true]`)).toBe("[i64, string, bool]");
  });
  test("named tuple via annotation", () => {
    expect(typeOf(`p: [x: f64, y: f64] :: [1.0, 2.0]; p`)).toBe("[x: f64, y: f64]");
  });
  // Field names are type-position-only, so a named-field literal must fail
  // at parse time.
  test("named-field expression literal is rejected at parse time", () => {
    expect(() => run(`p: [x: i64, y: i64] :: [x: 1, y: 2]; p`)).toThrow("Expected \",\" or \"]\", got \":\"");
  });
  test("stray punctuation in expression position fails as a parse error, not a sym node", () => {
    expect(() => run(`f(:)`)).toThrow("Unexpected token \":\"");
  });
  test("characters outside the token grammar fail in the lexer", () => {
    for (const [src, c] of [
      ["`x`", "`"],
      ["1 ? 2", "?"],
    ] as [string, string][]) {
      expect(() => run(src)).toThrow(`Bad char: ${c}`);
    }
  });

  test("string escapes: \\u and unknown escapes", () => {
    for (const [src, expected] of [
      ["\"\\u0041\"", "A"],
      ["\"a\\qb\"", "aqb"],
    ] as [string, string][]) {
      expect(show(run(src))).toBe(`"${expected}"`);
    }
  });

  test("array types reject named elements", () => {
    expect(() => run(`p: [x: i64] :: [1]; p`)).toThrow("array type cannot have a named element");
  });

  test("a backtracked array-literal statement still demands a semicolon", () => {
    expect(() => run(`[1] 2`)).toThrow("Expected \";\", got \"2\"");
  });
  // Comma-separated lists require the separator; only the trailing comma is
  // optional (every list site shares Parser.listSep).
  test("bracket literals demand commas between elements", () => {
    expect(() => typeOf(`[1 2]`)).toThrow("Expected \",\" or \"]\", got \"2\"");
    expect(() => typeOf(`[1, 2 3]`)).toThrow("Expected \",\" or \"]\", got \"3\"");
    expect(typeOf(`[1, 2,]`)).toBe("[i64]");
  });
  test("destructure patterns demand commas between fields", () => {
    expect(() => run(`[a b] := [1, 2];`)).toThrow("Expected \",\" or \"]\", got \"b\"");
    expect(show(run(`[a, b,] := [1, 2]; a + b`))).toBe("3");
  });
  test("call args, fn params, and fn types demand commas", () => {
    expect(() => typeOf(`f :: fn(a: i64 b: i64): i64 { a + b };`)).toThrow("Expected \",\" or \")\", got \"b\"");
    expect(() => typeOf(`f: (i64 i64) -> i64 :: 1;`)).toThrow("Expected \",\" or \")\", got \"i64\"");
    expect(show(run(`f :: fn(a: i64, b: i64,): i64 { a + b }; f(1, 2,)`))).toBe("3");
  });
  test("effect rows demand commas", () => {
    expect(() => typeOf(`effect A(): i64; effect B(): i64; f :: fn(): i64 ! { A B } { A!() };`))
      .toThrow("Expected \",\" or \"}\", got \"B\"");
    expect(typeOf(`effect A(): i64; f :: fn(): i64 ! { A, } { A!() }; f()`)).toBe("i64");
  });
  test("dot access on a tuple by name", () => {
    expect(show(run(`p: [x: f64, y: f64] :: [1.0, 2.0]; p.x`))).toBe("1");
  });
  test("dot access on a tuple by index", () => {
    expect(show(run(`p: [i64, string] :: [1, "a"]; p.1`))).toBe("\"a\"");
  });
  test("dot access on an array by index", () => {
    expect(show(run(`xs :: [10, 20, 30]; xs.0`))).toBe("10");
  });
  test("destructuring bind holds tuple fields", () => {
    expect(show(run(`p: [i64, string] :: [1, "a"]; [n, s] :: p; s`))).toBe("\"a\"");
  });
  test("destructuring bind on an array", () => {
    expect(show(run(`xs :: [10, 20]; [a, b] :: xs; a + b`))).toBe("30");
  });
  test("parametric type alias instantiates", () => {
    expect(typeOf(`Pair :: fn(a: type, b: type): type {[a, b]}; p: Pair(i64, string) :: [1, "a"]; p`)).toBe("[i64, string]");
  });
  test("alias used in a function signature", () => {
    expect(typeOf(`Pair :: fn(a: type, b: type): type {[a, b]}; fst :: fn(p: Pair(i64, string)): i64 { p.0 }; fst`)).toBe("([i64, string]) -> i64");
  });
  test("nullary alias sugar: name :: [T, T]", () => {
    expect(typeOf(`V2 :: [f32, f32]; v: V2 :: [1.0, 2.0]; v`)).toBe("[f32, f32]");
  });
  test("nullary alias to a bare type name", () => {
    expect(typeOf(`s32 :: i32; f :: fn(n: s32): i32 { n }; f`)).toBe("(i32) -> i32");
  });
  test("alias to an alias application", () => {
    expect(typeOf(`Pair :: fn(a: type, b: type): type {[a, b]}; P2 :: Pair(i64, string); p: P2 :: [1, "a"]; p`)).toBe("[i64, string]");
  });
  test("type-annotated term lambda (ret not type) stays a term function", () => {
    expect(typeOf(`f :: fn(a: type): i64 { 0 }; f`)).toBe("(type) -> i64");
  });
  test("parametric alias refuses bracket syntax in type position", () => {
    expect(() => typeOf(`Pair :: fn(a: type, b: type): type {[a, b]}; p: Pair[i64, string] :: [1, "a"]; p`)).toThrow("Expected");
  });
  test("the `type` keyword form is gone", () => {
    expect(() => typeOf(`type V = i64;`)).toThrow();
  });
  test("alias sugar with named fields and fn-type body", () => {
    expect(typeOf(`P :: [x: f64, y: f64]; F :: (i64) -> i64; f: F :: fn(n: i64): i64 { n }; p: P :: [1.0, 2.0]; p.x`)).toBe("f64");
  });
  test("alias sugar chains with earlier aliases", () => {
    expect(typeOf(`A :: [i64, i64]; B :: [A, A]; b: B :: [[1, 2], [3, 4]]; b`)).toBe("[[i64, i64], [i64, i64]]");
  });
  test("bracket RHS over value variables is still a const binding, not sugar", () => {
    expect(show(run(`a :: 1; b :: 2; pair :: [a, b]; pair.1`))).toBe("2");
  });
  test("bare-name RHS is still a const binding, not sugar", () => {
    expect(show(run(`x :: 5; y :: x; y`))).toBe("5");
  });
  test("sugar is top-level only: in a body the bracket stays a binding", () => {
    expect(() => run(`f :: fn() { v :: [f32, f32]; v }; f()`)).toThrow("Unbound: f32");
  });
});

describe("Negative tests (static type checker rejects)", () => {
  function assertTypeError(src: string, needle: string) {
    expect(() => run(src)).toThrow(needle);
  }

  test("Adding a string to an i64", () => {
    assertTypeError(`s: string :: "hi"; s + 1`, "i64");
  });

  test("Calling a function with the wrong argument type", () => {
    assertTypeError(`f :: fn(n: i64): i64 { n + 1 }; f("x")`, "i64");
  });

  test("Heterogeneous array literal is now a tuple", () => {
    expect(typeOf(`[1, "a", true]`)).toBe("[i64, string, bool]");
  });

  test("Tuple arity mismatch is rejected", () => {
    assertTypeError(`p: [i64, string] :: [1, "a", true];`, "arity");
  });

  test("If branches with mismatched types", () => {
    assertTypeError(`if (1 < 2) { 1 } else { "x" }`, "i64");
  });

  test("Using an undeclared effect", () => {
    assertTypeError(`Nope!(1)`, "Unknown effect");
  });

  test("== / != reject cross-type operands", () => {
    assertTypeError(`"a" == 1`, "Type mismatch");
    assertTypeError(`"x" != 1`, "Type mismatch");
  });

  test("exit/wait are not builtins (use Exit!/Wait)", () => {
    assertTypeError(`exit(1)`, "Unbound: exit");
    assertTypeError(`wait(1)`, "Unbound: wait");
  });
});

test("Effectful function signature carries its effect set", () => {
  // ask echoes its arg via the Emit effect and returns it; the signature
  // declares `! { Emit }`, which the checker verifies against the body.
  expect(typeOf(`
effect Emit(m: i64): i64;
ask :: fn(n: i64): i64 ! { Emit } { Emit!(n) };
ask
`)).toBe("(i64) -> i64 ! { Emit }");
});

test("Declaring an effect set rejects effects not listed", () => {
  // Body performs Emit but the signature only declares Log.
  expect(() => run(`
effect Emit(m: i64): i64;
effect Log(m: i64): i64;
f :: fn(n: i64): i64 ! { Log } { Emit!(n) };
f(1)
`)).toThrow("not declared");
});

test("Builtin Read/Write round-trip through real files", () => {
  const p = tmpPath("rw");
  if (existsSync(p)) unlinkSync(p);
  // Write then Read via the builtin default handler (no user handler).
  expect(show(run(`
Write!(${JSON.stringify(p)}, "hello ef");
Read!(${JSON.stringify(p)})
`))).toBe("\"hello ef\"");
  // The file really exists on disk.
  expect(readFileSync(p, "utf8")).toBe("hello ef");
  unlinkSync(p);
});

test("A user handler can intercept builtin Read (effects stay abstract)", () => {
  const p = tmpPath("mock");
  // The handler mocks Read and never touches the filesystem.
  expect(show(run(`
handle {
  Read!(${JSON.stringify(p)})
} case Return(v) => k { [v] }
  case Read(path) => k { ["mocked"] }
`))).toBe("[\"mocked\"]");
});

test("Builtin effects appear in inferred signatures", () => {
  expect(typeOf(`
firstRead :: fn(path: string): string ! { Read } { Read!(path) };
firstRead
`)).toBe("(string) -> string ! { Read }");
});

test("Untyped literals flex and default to i64 / f64", () => {
  expect(typeOf(`2.5`)).toBe("f64");
  expect(typeOf(`2`)).toBe("i64");
  expect(typeOf(`1 + 2`)).toBe("i64");
  expect(typeOf(`1 + 2.5`)).toBe("f64");
  expect(typeOf(`1.5 * 2`)).toBe("f64");
  expect(typeOf(`2 < 3`)).toBe("bool");
  expect(typeOf(`2.0 < 3`)).toBe("bool");
  expect(typeOf(`2.0`)).toBe("f64");
});

test("Numeric widths: six primitives, strict same-width arithmetic", () => {
  // Untyped literals flex to any numeric context and default to i64 / f64.
  expect(typeOf(`1`)).toBe("i64");
  expect(typeOf(`1.5`)).toBe("f64");
  expect(typeOf(`x: i32 :: 1; x`)).toBe("i32");
  expect(typeOf(`x: u64 :: 1; x + 1`)).toBe("u64");
  expect(typeOf(`x: f32 :: 1.5; x`)).toBe("f32");
  expect(typeOf(`x: i32 :: 1; x + 2`)).toBe("i32");       // literal flexes down
  expect(typeOf(`sqrt(100)`)).toBe("f64");                    // literal flexes up
  expect(() => typeOf(`x: i32 :: 1; y: i64 :: 2; x + y`)).toThrow(/different numeric widths/);
  expect(typeOf(`x: f32 :: 1; x + 1.5`)).toBe("f32");      // float literal flexes to f32
  expect(() => typeOf(`x: i32 :: 1.5`)).toThrow();         // float literal never narrows
  expect(() => typeOf(`get([10, 20], 1.5)`)).toThrow();       // indices are i64, not f64
});

test("@as: the explicit numeric cast", () => {
  expect(typeOf(`@as(1, i32)`)).toBe("i32");
  expect(show(run(`@as(3.7, i32)`))).toBe("3");               // truncates toward zero
  expect(show(run(`@as(-3.7, i32)`))).toBe("-3");
  expect(show(run(`@as(true, i32)`))).toBe("1");
  expect(show(run(`@as(false, i32)`))).toBe("0");
  expect(show(run(`x: i64 :: 5; @as(x, f32) + @as(x, f32)`))).toBe("10");
  expect(() => typeOf(`@as(1, [i64])`)).toThrow(/numeric width/);
  expect(typeOf(`@as(true, i32) + 1`)).toBe("i32");
});

test("f32 arithmetic rounds to f32 precision (interp and wasm agree)", () => {
  expect(show(run(`a: f32 :: 0.1; b: f32 :: 0.2; a + b`))).toBe("0.30000001192092896");
  expect(show(run(`a: f32 :: 0.1; a * 10.0`))).toBe("1");
  expect(show(run(`a: f64 :: 0.1; b: f64 :: 0.2; a + b`))).toBe("0.30000000000000004");
  expect(show(run(`a: f32 :: 0.1; a / 3.0`))).toBe("0.03333333507180214");
});

test("u32/u64 hold unsigned ranges; i64 goes past i32", () => {
  expect(show(run(`x: u32 :: 4294967295; x`))).toBe("4294967295");
  expect(show(run(`x: u64 :: 9007199254740992; x`))).toBe("9007199254740992");
  expect(show(run(`x: i64 :: 9999999999; x * 2`))).toBe("19999999998");
  expect(show(run(`x: u32 :: 3; y: u32 :: 5; x < y`))).toBe("true");
});

test("an untyped int literal flows into a f64-typed parameter", () => {
  // f(1) passes an untyped literal where a f64 param is expected — it flexes.
  expect(show(run(`
f :: fn(x: f64): f64 { x + 0.5 };
f(1)
`))).toBe("1.5");
});

test("while loop with assignment", () => {
  // Sum 1..5 with a mutable accumulator.
  expect(show(run(`
i := 1;
acc := 0;
while (i <= 5) { acc = acc + i; i = i + 1 }
acc
`))).toBe("15");
});

test("+ is overloaded: numeric arithmetic or string concatenation", () => {
  // numeric still works.
  expect(typeOf(`1 + 2`)).toBe("i64");
  expect(typeOf(`1 + 2.5`)).toBe("f64");
  expect(show(run(`1 + 2`))).toBe("3");
  // string + string.
  expect(typeOf(`"a" + "b"`)).toBe("string");
  expect(show(run(`"foo" + "bar"`))).toBe("\"foobar\"");
  expect(show(run(`"" + "x"`))).toBe("\"x\"");
  expect(show(run(`"" + ""`))).toBe("\"\"");
  // three-way chaining is left-associative string concat.
  expect(show(run(`"a" + "b" + "c"`))).toBe("\"abc\"");
  // string concat with values via let bindings.
  expect(show(run(`s :: "x"; s + s`))).toBe("\"xx\"");
  // mixed string/number is a type error in either order.
  expect(() => run(`"a" + 1`)).toThrow(/string/);
  expect(() => run(`1 + "a"`)).toThrow(/string/);
  // mixed string/bool is a type error.
  expect(() => run(`"a" + true`)).toThrow(/string/);
});

test("builtins added for the star port: range/get/set/each/flatmap/modulo", () => {
  // range + each + set: build [0,1,2,3] via mutation, sum with each.
  expect(show(run(`
a :: [0, 0, 0, 0];
s := 0;
each(fn(i, _) { set(a, i, i) }, range(0, 4, 1));
each(fn(v, _) { s = s + v }, a);
s
`))).toBe("6");
  // flatmap + modulo: [[0],[0,1],[0,1,2]] flattened.
  expect(show(run(`
flatmap(fn(i, _) { range(0, i + 1, 1) }, range(0, 3, 1))
`))).toBe("[0, 0, 1, 0, 1, 2]");
  // modulo.
  expect(show(run(`7 % 3`))).toBe("1");
});

test("math + string builtins: cos/sin/PI/round/abs/char", () => {
  // cos(0)=1, round(2.7)=3, abs(-4.5)=4.5, char(65)="A".
  expect(show(run(`round(cos(0.0))`))).toBe("1");
  expect(show(run(`round(2.7)`))).toBe("3");
  expect(show(run(`abs(-4.5)`))).toBe("4.5");
  expect(show(run(`char(65)`))).toBe("\"A\"");
  // char uses code points, not UTF-16 code units: 0x1F600 is a supplementary char.
  expect(show(run(`char(128512)`))).toBe("\"\ud83d\ude00\"");
  // PI is a value builtin: bound as its f64, not a fn — so bare use and
  // arithmetic/call arguments work at runtime, matching the checker's `f64`.
  expect(typeOf(`PI`)).toBe("f64");
  expect(show(run(`PI`))).toBe("3.141592653589793");
  expect(typeOf(`PI * 100`)).toBe("f64");
  expect(show(run(`PI * 100`))).toBe("314.1592653589793");
  expect(show(run(`cos(PI)`))).toBe("-1");
});

test("division is type-preserving: i64/i64 -> i64, f64/f64 -> f64", () => {
  // i64/i64 is truncated; the checker stamps the node so the runtime knows.
  expect(typeOf(`7 / 2`)).toBe("i64");
  expect(show(run(`7 / 2`))).toBe("3");
  expect(typeOf(`4 / 2`)).toBe("i64");
  expect(show(run(`4 / 2`))).toBe("2");
  // f64/f64 stays exact.
  expect(typeOf(`10.0 / 4.0`)).toBe("f64");
  expect(show(run(`10.0 / 4.0`))).toBe("2.5");
  // mixed i64/f64 widens to f64 (no truncation).
  expect(typeOf(`7 / 2.0`)).toBe("f64");
  expect(show(run(`7 / 2.0`))).toBe("3.5");
  // negative i64 division truncates toward zero (Math.trunc).
  expect(show(run(`-7 / 2`))).toBe("-3");
});

test("get/sub/set fail loudly on empty/out-of-bounds", () => {
  // No silent null: OOB index and inverted sub range raise instead of
  // returning unit; set is strictly in-window (no growth past the end).
  expect(() => run(`get([], 0)`)).toThrow(/get: index 0 out of bounds \[0, 0\)/);
  expect(() => run(`get([1, 2], 5)`)).toThrow(/out of bounds/);
  expect(() => run(`get([1, 2], -1)`)).toThrow(/out of bounds/);
  expect(() => run(`set([1, 2], 2, 9)`)).toThrow(/set: index 2 out of bounds \[0, 2\)/);
  expect(() => run(`sub([1, 2, 3], 1, 4)`)).toThrow(/sub: range \[1, 4\) out of bounds \[0, 3\)/);
  expect(() => run(`sub([1, 2, 3], 2, 1)`)).toThrow(/sub: range/);
  // In-bounds still works.
  expect(show(run(`get([1, 2, 3], 2)`))).toBe("3");
  expect(show(run(`sub([1, 2, 3], 1, 3)`))).toBe("[2, 3]");
});

test("slices: views share the backing; concat never aliases", () => {
  // sub is zero-copy: a write through the original is visible in the view.
  expect(show(run(`s: [i64] = [1, 2, 3, 4]; v :: sub(s, 1, 3); set(s, 1, 99); v`))).toBe("[99, 3]");
  // ...and a write through the view is visible in the original.
  expect(show(run(`s: [i64] = [1, 2, 3]; v :: sub(s, 0, 2); set(v, 0, 42); s`))).toBe("[42, 2, 3]");
  // concat allocates a fresh backing: later writes don't leak either way.
  expect(show(run(`s: [i64] = [1, 2]; t :: concat(s, [3]); set(s, 0, 9); t`))).toBe("[1, 2, 3]");
  // Views compose: sub of a sub is a window of a window.
  expect(show(run(`s :: [0, 1, 2, 3, 4]; sub(sub(s, 1, 5), 1, 4)`))).toBe("[2, 3, 4]");
  // Equality stays reference identity.
  expect(run(`s :: [1, 2]; s == s`)).toBe(true);
  expect(run(`[1, 2] == [1, 2]`)).toBe(false);
  // Tuples are struct-like records, not slices: heterogeneous literal,
  // positional/named access, destructuring all still work.
  expect(show(run(`p: [i64, string] = [1, "a"]; p.0`))).toBe("1");
  expect(show(run(`p: [x: i64, y: i64] = [1, 2]; p.x + p.y`))).toBe("3");
  expect(run(`[a, b] := [1, "x"]; a`)).toBe(1n);
  // Array destructuring reads through the view's window.
  expect(run(`s :: [7, 8, 9]; [a, b] :: sub(s, 1, 3); a + b`)).toBe(17n);
});

test("string escapes: \\xHH and \\n", () => {
  // \x1B (ESC, 27) then "[" — char code of first char is 27.
  expect(show(run(`"\x1B["`))).toBe("\"\u001b[\"");
  expect(show(run(`"a\nb"`))).toBe("\"a\nb\"");
});

test("Println/Out are interceptable algebraic effects", () => {
  // A handler captures Println's argument instead of letting it print.
  expect(show(run(`
handle {
  Println!(42);
  Println!("hi");
  0
} case Return(v) => k { [v] }
  case Println(x) => k { concat([x], k(unit)) }
`))).toBe("[42, \"hi\", 0]");
  // Out is an effect too: collect written strings.
  expect(show(run(`
handle {
  Out!("a");
  Out!("b");
  unit
} case Return(v) => k { [] }
  case Out(s) => k { concat([s], k(unit)) }
`))).toBe("[\"a\", \"b\"]");
});

test("effect annotations are optional and derived if missing", () => {
  // Pure body, no annotation: fine.
  expect(show(run(`f :: fn(): i64 { 1 + 2 };\nf`))).toBe("[fn: () -> i64]");
  // Effectful body, annotation present and covering: fine.
  expect(show(run(`g :: fn(): unit ! { Out } { Out!("x") };\ng`))).toBe("[fn: () -> unit ! { Out }]");
  // Effectful body, no annotation: derived from body, accepted.
  expect(show(run(`h :: fn(): unit { Out!("x") };\nh`))).toBe("[fn: () -> unit ! { Out }]");
  // Anonymous lambda too: effectful without annotation is derived.
  expect(show(run(`k :: fn(): unit { Out!("x") }; k`))).toBe("[fn: () -> unit ! { Out }]");
  // Anonymous lambda with annotation: accepted.
  expect(show(run(`k :: fn(): unit ! { Out } { Out!("x") }; k`))).toBe("[fn: () -> unit ! { Out }]");
  // Annotation that underspecifies is still rejected.
  expect(() => run(`p :: fn(): unit ! { } { Out!("x") };\np`)).toThrow(/not declared in signature/);
});

test("higher-order builtins are effect-polymorphic", () => {
  // Pure callback: the map call performs no effects.
  expect(typeOf(`usePure :: fn(): [i64] { map(fn(x: i64): i64 { x + 1 }, [1, 2, 3]) };
usePure`)).toBe("() -> [i64]");
  // Effectful callback: exactly { Out } propagates, not over-approximated.
  expect(typeOf(`useEffectful :: fn(): [i64] { map(fn(x: i64): i64 { Out!("x"); x }, [1, 2, 3]) };
useEffectful`)).toBe("() -> [i64] ! { Out }");
  // each with an effectful body callback propagates too.
  expect(typeOf(`eachOut :: fn(): unit { each(fn(x: i64, _: i64) { Out!("x") }, [1, 2, 3]) };
eachOut`)).toBe("() -> unit ! { Out }");
  // Pure each stays pure.
  expect(typeOf(`eachPure :: fn(): unit { each(fn(x: i64, _: i64) { unit }, [1, 2, 3]) };
eachPure`)).toBe("() -> unit");
});

test("user-defined polymorphic functions via let-generalization", () => {
  // `apply` is a lambda RHS, so it's generalized: one definition instantiates
  // fresh type vars per call and works at i64 and string in the same program.
  expect(typeOf(`apply :: fn (f, x) { f(x) };
apply(fn (n: i64) { n + 1 }, 41)`)).toBe("i64");
  expect(typeOf(`apply :: fn (f, x) { f(x) };
apply(fn (n: i64) { "n=" + char(48 + n) }, 7)`)).toBe("string");
  // Both instantiations coexist in one program.
  expect(show(run(`apply :: fn (f, x) { f(x) };
a :: apply(fn (n: i64) { n + 1 }, 41);
b :: apply(fn (n: i64) { "n=" + char(48 + n) }, 7);
a`))).toBe("42");
  expect(show(run(`apply :: fn (f, x) { f(x) };
b :: apply(fn (n: i64) { "n=" + char(48 + n) }, 7);
b`))).toBe("\"n=7\"");
  // Value restriction: a non-lambda RHS is NOT generalized, so a returned
  // function used at two types is a type error (stays monomorphic).
  // (Sanity: a lambda-typed `let` with an explicit annotation is monomorphic.)
  expect(() => run(`id: (i64) -> i64 :: fn (x) { x };
s :: id("hi")`)).toThrow();
});

test("show prints function arity and type, natives stay [fn]", () => {
  expect(show(run(`add :: fn(a: i64, b: i64): i64 { a + b };\nadd`))).toBe("[fn: (i64, i64) -> i64]");
  expect(show(run(`id :: fn(x: i64): i64 { x };\nid`))).toBe("[fn: (i64) -> i64]");
  // Builtins (natives) carry no inferred type here: stay [fn].
  expect(show(run(`len`))).toBe("[fn]");
});

test("nested tuple field access chains (m.0.0)", () => {
  // The lexer reads `0.0` as one f64 token; the parser splits it so
  // `m.0.0` is two field accesses, not one.
  expect(run(`m: [[i64,i64,i64],[i64,i64,i64],[i64,i64,i64]] :: [[1,2,3],[4,5,6],[7,8,9]]; m.0.0`)).toBe(1n);
  expect(run(`m: [[i64,i64,i64],[i64,i64,i64],[i64,i64,i64]] :: [[1,2,3],[4,5,6],[7,8,9]]; m.2.1`)).toBe(8n);
});

test("array literal infers as tuple against a tuple-typed context", () => {
  // Return type: a `[x, y, z]` body literal conforms to `[i64,i64,i64]`.
  expect(run(`f :: fn(): [i64,i64,i64] { [1, 2, 3] }; f().1`)).toBe(2n);
  // Argument: an `[...]` literal passed to a tuple parameter becomes a tuple.
  expect(run(`f :: fn(p: [i64,i64,i64]): i64 { p.2 }; f([1,2,3])`)).toBe(3n);
  // Nested: `[[...],[...]]` argument against a tuple-of-tuples parameter.
  expect(run(`f :: fn(m: [[i64,i64,i64],[i64,i64,i64]]): i64 { m.1.0 }; f([[1,2,3],[4,5,6]])`)).toBe(4n);
});

test("REPL: bindings persist across lines", () => {
  const out = execSync(
    "bun run cli.ts repl",
    {input: "a :: 6\nb :: 7\na * b\n:q\n", encoding: "utf8", timeout: 20000, cwd: import.meta.dir},
  );
  expect(out).toContain("42 : i64");
});

describe("Fail-fast unhandled ops (exec rejects before evaluating)", () => {
  test("unhandled program op throws before any side effect", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      expect(() => run(`effect T(x: i64): i64; Println!("boom"); T!(1)`))
        .toThrow("Unhandled effect: T");
    } finally {
      console.log = orig;
    }
    expect(logs).toEqual([]); // Println never ran: rejection precedes evaluation
  });

  test("an interp override covers a program op (the same path runTop uses)", () => {
    const seen: Value[][] = [];
    expect(run(`effect T(x: i64): i64; 1 + T!(2)`, {
      T: (args, k) => { seen.push(args); return k(Number(args[0]) * 10); },
    })).toBe(21n);
    expect(seen).toEqual([[2n]]);
  });

  test("handled ops pass; performs inside lambdas are handled at the call site", () => {
    expect(run(`effect T(x: i64): i64; handle { T!(2) } case T(n) => k { n * 3 }`)).toBe(6n);
    expect(run(`effect T(x: i64): i64; f :: fn(y: i64): i64 ! { T } { T!(y) }; handle { f(5) } case T(n) => k { n + 1 }`)).toBe(6n);
  });

  test("an unhandled op through a call is caught statically, not just a bare perform", () => {
    expect(() => run(`effect T(x: i64): i64; f :: fn(y: i64): i64 ! { T } { T!(y) }; f(1)`))
      .toThrow("Unhandled effect: T");
  });

  test("case bodies run outside their handler: ops they perform must be handled too", () => {
    expect(() => run(`effect T(x: i64): i64; effect U(x: i64): i64; handle { T!(1) } case T(n) => k { U!(2) }`))
      .toThrow("Unhandled effect: U");
    expect(run(`effect T(x: i64): i64; effect U(x: i64): i64; handle { T!(1) } case T(n) => k { U!(2) }`,
      {U: (_args, k) => k(7)})).toBe(7n);
  });

  test("runtime backstops the static unhandled-op check misses", () => {
    // A case body re-performing its own op reads as handled statically (the
    // handler covers T), but the body runs outside the handler — only the
    // interpreter's unhandled-effect throw catches it.
    expect(() => run(`effect T(x: i64): i64; handle { T!(1) } case T(n) => k { T!(2) }`))
      .toThrow("Unhandled effect: T");
  });

  test("unstamped comparison sites run through the operator table", () => {
    // Two untyped literals leave the site unstamped (no concrete width),
    // so the comparison applies the env's own operator closure.
    for (const [src, expected] of [
      ["2 >= 1", true],
      ["2.5 >= 1.5", true],
      ["1 >= 2", false],
    ] as [string, boolean][]) {
      expect(run(src)).toBe(expected);
    }
  });

  describe("showErr (REPL/CLI diagnostics)", () => {
    const located = (msg: string, line: number, col: number) => {
      const e = new TypeError_(msg);
      e.pos = {line, col};
      return e;
    };
    for (const [label, err, src, expected] of [
      ["a plain Error has no position prefix", new Error("boom"), undefined, "boom"],
      ["a located error prefixes line/col", located("boom", 2, 3), undefined, "at line 2, col 3: boom"],
      ["with source, the offending line is quoted with a caret",
       located("boom", 2, 3), "a := 1;\nb := 23;\n", "2 | b := 23;\n  |   ^\nat line 2, col 3: boom"],
      ["a trailing \\r is stripped from the quoted line",
       located("boom", 1, 1), "a := 1;\r\nb := 2;\r\n", "1 | a := 1;\n  | ^\nat line 1, col 1: boom"],
    ] as [string, unknown, string | undefined, string][]) {
      test(label, () => {
        expect(showErr(err, src)).toBe(expected);
      });
    }
  });

  test("calling a non-closure any fails at the apply boundary", () => {
    expect(() => run(`f: any :: 1; f(2)`)).toThrow("Not callable: 1");
  });

  test("stamped comparisons coerce through widthOp", () => {
    // Concrete-typed operands stamp the site with their width, so the
    // comparison runs through widthOp's planes (i64 bigints, f64 numbers).
    for (const [src, expected] of [
      ["x: i64 :: 2; y: i64 :: 1; x >= y", true],
      ["x: f64 :: 2.5; y: f64 :: 1.5; x >= y", true],
      ["x: f64 :: 2.5; y: f64 :: 1.5; x > y", true],
      ["x: f64 :: 2.5; y: f64 :: 1.5; x <= y", false],
      ["x: i64 :: 2; y: i64 :: 1; x < y", false],
    ] as [string, boolean][]) {
      expect(run(src)).toBe(expected);
    }
  });

  test("a handler's escaping closure performs unhandled outside the handle", () => {
    // The checker tracks residual ops through calls, but a polymorphic
    // caller hides the escaped closure's row — only runTop's unhandled
    // throw catches the perform.
    expect(() => run(`
      effect E(): i64;
      call :: fn (f) { f() };
      escape :: fn (h) { handle { h() } case E(n) => k { h } };
      r :: escape(fn(): i64 ! { E } { E!() });
      call(r)
    `)).toThrow("Unhandled effect: E");
  });

  describe("checker diagnostics", () => {
    for (const [src, msg] of [
      ["[1] - 1", /-: \[i64\] and i64 are not numeric/],
      ["x := [];\nx = [x];", /recursive type/],
      ["if (true) { [1, \"a\"] } else { [1, \"a\", true] }", /tuple arity 2 ≠ 3/],
      ["if (true) { fn(x: i64): i64 { x } } else { fn(x: i64, y: i64): i64 { x } }", /arity 1 ≠ 2/],
      ["effect E(): i64; effect U(): i64; g1 :: fn(): i64 ! { E } { E!() }; g2 :: fn(): i64 ! { U } { U!() }; if (true) { g1 } else { g2 }", /effect mismatch: \{ E \} ≠ \{ U \}/],
      ["@as(\"a\", i64)", /@as: cannot cast string to i64/],
      ["xs: [i64] :: [1]; xs.foo", /arrays use \.N indexing, not \.foo/],
      ["p: [i64, i64] :: [1, 2]; p.5", /\.5 out of range for tuple of 2/],
      ["p: [x: i64, y: i64] :: [1, 2]; p.z", /tuple has no field \.z/],
      ["x: i64 :: 1; x.0", /field access on non-record type: i64/],
      ["p: [i64, i64] :: [1, 2]; [a, b, c] := p;", /destructure arity 3 ≠ tuple 2/],
      ["x: i64 :: 1; [a, b] := x;", /cannot destructure non-record type: i64/],
      ["effect E(x: i64): i64; E!()", /effect E: 1 args, got 0/],
      ["handle { 1 } case Nope(n) => k { n }", /Handler for unknown effect: Nope/],
      ["f :: fn(x: i64): i64 { x }; f(1, 2)", /arity 1 ≠ 2/],
      ["t: string :: \"x\"; t(1)", /Type mismatch/],
      ["s: string :: \"x\"; (if (true) { s } else { s })(1)", /Type mismatch/],
      ["(fn(x: i64): i64 { x })(\"s\")", /Type mismatch/],
      ["h :: fn(): [i64, i64] { fn(): [i64, i64] { [1, 2] } }; h()", /Type mismatch/],
    ] as [string, RegExp][]) {
      test(src.replace(/\s+/g, " ").slice(0, 60), () => {
        expect(() => run(src)).toThrow(msg);
      });
    }
  });

  describe("checker internals through public behavior", () => {
    for (const [label, src, expected] of [
      // Two map instances of the same shape unify: their effect variables
      // union in the unifier's effect union-find.
      ["effect vars union across same-shaped polymorphic instances",
       "pick :: fn (f, g) { if (true) { f } else { g } };\na :: pick(map, map);\na(fn(x: i64): i64 { x }, [1])", "[1]"],
      // Three same-shaped instances chain the effect union-find's parent
      // links, so find() walks and path-compresses.
      ["effect union-find chains three instances",
       "pick3 :: fn (f, g, h) { if (true) { if (true) { f } else { g } } else { h } };\na :: pick3(map, map, map);\na(fn(x: i64): i64 { x }, [1])", "[1]"],
      // A generalized scheme whose type nests the param var inside a tuple
      // instantiates a fresh copy per use.
      ["scheme instantiation copies tuples",
       "mk :: fn (x) { [[x, x], \"s\"] };\na :: mk(1);\nb :: mk(true);\nb", "[[true, true], \"s\"]"],
      // A scheme whose param resolved to a fun type carrying an effect
      // variable instantiates a fresh effect variable per use.
      ["scheme instantiation copies effect variables",
       "twice :: fn (f, xs) { map(f, map(f, xs)) };\ntwice(fn(x: string): string { x }, [\"a\"])", "[\"a\"]"],
      // hasPerformOutsideLambdas walks if/field spines inside handle bodies.
      ["handle body spine through if and field",
       "effect E(): i64; p: [i64, i64] :: [1, 2]; handle { if (true) { p.0 } else { E!() } } case E(n) => k { n }", "1"],
      // hasPerformOutsideLambdas's as/while arms on a handle body spine
      // (the while must not perform: .some() short-circuits the walk).
      ["handle body spine through while and as",
       "effect E(n: i64): i64; p: [i64, i64] :: [1, 2];\nf :: fn(): i64 {\n  handle {\n    while (false) { unit };\n    @as(if (true) { E!(p.0) } else { 2 }, i64)\n  } case E(n) => k { k(n) }\n};\nf()", "1"],
      // caseReferencesK walks as/if/while/app/arr/field/handle shapes in
      // case bodies that resume; the gate only runs over a perform-free body.
      ["k references through as/if/while/arr/field/nested handle",
       "effect E(n: i64): i64;\ng :: fn(): i64 ! { E } { E!(1) };\nf :: fn(): i64 {\n  handle {\n    g()\n  } case E(n) => k {\n    x := @as(n, i64);\n    if (x < 9) { x } else { 0 };\n    y := [x, x].1;\n    while (y < 1) { y = y + 1 };\n    h := handle { y } case Return(v) => r { k(v) };\n    k(h)\n  }\n};\nf()", "1"],
      // inferWith's lambda branch: a lambda body under a tuple return type.
      ["tuple expectation flows into a nested lambda body",
       "h :: fn(): [i64, i64] { fn(): [i64, i64] { [1, 2] } }; h()", "ERR"],
      // inferWith's block branch: non-final statements infer plainly.
      ["tuple expectation flows through a block tail",
       "p: [i64, i64] :: [1, 2];\nf :: fn(): [i64, i64] { a := 1; [a, 2] };\nf()", "[1, 2]"],
      // inferWith's sym fallback: a non-literal tail against a tuple type.
      ["tuple expectation applies to a sym tail",
       "p: [i64, i64] :: [1, 2];\nf :: fn(): [i64, i64] { p };\nf()", "[1, 2]"],
      // A dlet over an array window with annotated fields unifies each.
      ["annotated array destructure unifies the field types",
       "[a: i64, b: i64] := [1, 2];\na + b", "3"],
    ] as [string, string, string][]) {
      test(label, () => {
        if (expected === "ERR") {
          expect(() => run(src)).toThrow();
        } else {
          expect(show(run(src))).toBe(expected);
        }
      });
    }

    test("a polymorphic callee's arity failure names the parameter", () => {
      expect(() => run(`k :: fn (f, x) { f(x) }; k(1, 2)`)).toThrow();
    });

    test("a concrete non-callable argument is caught and named", () => {
      expect(() => run(`k :: fn (f, x) { f(x) };
s: string :: "x";
k(s, 1)`)).toThrow();
    });

    test("lookupResolved deep-resolves and instantiates schemes", () => {
      const c = prepare("m :: 5; m");
      expect(showT(c.checked.env.lookupResolved("m"))).toBe("i64");
      // The builtin's scheme instantiates fresh type and effect variables.
      const m = prepare("map");
      expect(showT(m.checked.env.lookupResolved("map")))
      .toMatch(/^\(\(a\) -> b ! \{ e\d+ \}, \[a\]\) -> \[b\] ! \{ e\d+ \}$/);
    });

    test("builtin operator rows display as polymorphic effect variables", () => {
      expect(typeOf("map")).toMatch(/^\(\(a\) -> b ! \{ e\d+ \}, \[a\]\) -> \[b\] ! \{ e\d+ \}$/);
    });
  });

  test("builtin effects are never flagged", () => {
    expect(typeof run(`Random!()`)).toBe("number");
  });
});

describe("Env seeding (exec binds referenced builtins per line)", () => {
  test("a later REPL line can reference a previously-unused builtin", () => {
    const ctx = newCtx();
    execLine(ctx, `x :: 1;`);
    expect(ctx.env.vars.has("len")).toBe(false); // not referenced yet -> not bound
    expect(execLine(ctx, `len([1, 2]);`).value).toBe(2n);
    expect(ctx.env.vars.has("len")).toBe(true);
  });

  test("rebinding across REPL lines is an error (strict no-shadowing)", () => {
    // prepare's acc reuses one top-level frame, so earlier lines' names
    // (and builtins) collide exactly like same-frame redeclarations.
    const ctx = newCtx();
    execLine(ctx, `x :: 1;`);
    expect(() => prepare(`x := 2;`, ctx.checked)).toThrow("cannot redeclare 'x'");
    expect(() => prepare(`len :: 3;`, ctx.checked)).toThrow("cannot shadow builtin 'len'");
    // A rejected line leaves the accumulator untouched: x still reads as 1.
    expect(execLine(ctx, `x`).value).toBe(1n);
  });

  test("ef types prints symbols, then the program result type and effect row", () => {
    const f = join(tmpdir(), "ef-types-test.ef");
    writeFileSync(f, `effect T(x: i64): i64; Println!("a"); handle { T!(1) } case T(n) => k { n }`);
    try {
      const out = execSync(`bun run cli.ts types ${f}`, {
        encoding: "utf8",
        timeout: 20000,
        cwd: import.meta.dir,
        // styleText grays the `_` label; FORCE_COLOR=0 overrides any
        // inherited FORCE_COLOR so piped output stays unstyled (NO_COLOR
        // loses to an inherited FORCE_COLOR in bun).
        env: {...process.env, FORCE_COLOR: "0"},
      }).trim();
      // No lets -> only the result line. Println escapes to the runner; T is
      // handled internally, so the row lists only Println.
      expect(out.split("\n")).toEqual(["_ : i64 ! { Println }"]);
    } finally {
      unlinkSync(f);
    }
  });
});

// Regression: the converter inserts wrapper continuations (if-join, while
// exit, call/perform sites) as letks between top-level items, so bindings
// made after them land in a letk child frame instead of ctx.env — while
// prepare's acc still records the name. The next line therefore
// typechecks and then dies at runtime with "Unbound symbol".
describe("REPL acc regression: bindings after wrapper continuations", () => {
  const line = execLine;

  test("checker side keeps the binding (the divergence is runtime-only)", () => {
    const ctx = newCtx();
    line(ctx, "c := true; if (c) { 1 } else { 2 }; q :: 5;");
    expect(() => prepare("q;", ctx.checked)).not.toThrow();
  });

  // bun:test has no test.fails: this stand-in passes while the body throws
  // "Unbound symbol" (the open bug — a checker error would fail it) and
  // fails once the bug is fixed. Flip each call to a plain test then.
  const fails = (name: string, fn: () => void) =>
    test(name, () => expect(fn).toThrow(/Unbound symbol/));
  fails("after a top-level if", () => {
    const ctx = newCtx();
    line(ctx, "c := true; if (c) { 1 } else { 2 }; q :: 5;");
    expect(line(ctx, "q;").value).toBe(5n);
  });

  fails("after a top-level while", () => {
    const ctx = newCtx();
    line(ctx, "i := 0; while (i < 1) { i = i + 1 }; q :: 5;");
    expect(line(ctx, "q;").value).toBe(5n);
  });

  // Fixed on the interpreter: a classified-pure top-level call is a dcall —
  // its result binds in-frame with no wrapper letk, so the following
  // binding lands in the caller's frame (the REPL accumulator) as the other
  // shapes still expect wrapper-letk work.
  test("after a top-level call", () => {
    const ctx = newCtx();
    line(ctx, "f :: fn(): i64 { 1 }; f(); q :: 5;");
    expect(line(ctx, "q;").value).toBe(5n);
  });

  fails("after a top-level perform", () => {
    const ctx = newCtx();
    line(ctx, "Println!(1); q :: 5;");
    expect(line(ctx, "q;").value).toBe(5n);
  });
});

// Numeric widths: the interpreter is width-exact —
// i32/u32/f32/f64 values are JS numbers, i64/u64 values are BigInt (exact
// beyond 2^53) — and integer division/remainder trap on ÷0 and INT_MIN÷-1
// like wasm's div/rem ops. All six widths have graduated to full
// two-backend parity (wasm.test.ts); the i64/u64 cases here pin the
// interpreter-side semantics that parity builds on.
describe("numeric widths", () => {
  test("i32 sign-wraps", () => {
    expect(show(run(`x: i32 :: 2147483647; x + 1`))).toBe("-2147483648");
    expect(show(run(`x: i32 :: 2147483647; x * 2`))).toBe("-2");
    expect(show(run(`x: i32 :: -2147483648; x - 1`))).toBe("2147483647");
  });

  test("u32 wraps mod 2^32", () => {
    expect(show(run(`u: u32 :: 4294967295; u + 1`))).toBe("0");
    expect(show(run(`u: u32 :: 4294967295; u * 2`))).toBe("4294967294");
    expect(show(run(`u: u32 :: 1; u - 2`))).toBe("4294967295");
  });

  test("i64 is exact beyond 2^53 (BigInt values)", () => {
    expect(run(`big: i64 :: 9007199254740993; big + 1`)).toBe(9007199254740994n);
    expect(run(`big: i64 :: 9007199254740993; big * 2`)).toBe(18014398509481986n);
    expect(show(run(`9007199254740993 % 1000`))).toBe("993");
    expect(show(run(`9007199254740993 / 1000`))).toBe("9007199254740");
  });

  test("i64 division truncates toward zero; modulo takes the dividend's sign", () => {
    expect(show(run(`9007199254740993 / 1000000000000`))).toBe("9007");
    expect(show(run(`-7 / 2`))).toBe("-3");
    expect(show(run(`-7 % 2`))).toBe("-1");
    expect(show(run(`7 % -2`))).toBe("1");
  });

  test("u64 wraps mod 2^64", () => {
    expect(show(run(`u: u64 :: 18446744073709551615; u + 1`))).toBe("0");
    expect(show(run(`u: u64 :: 18446744073709551615; u * 2`))).toBe("18446744073709551614");
  });

  test("integer division/remainder traps: ÷0 and INT_MIN ÷ -1 (wasm div/rem parity)", () => {
    expect(() => run(`1 / 0`)).toThrow(/integer divide by zero/);
    expect(() => run(`17 % 0`)).toThrow(/integer divide by zero/);
    expect(() => run(`b: i64 :: 0 - 9223372036854775807 - 1; b / -1`)).toThrow(/integer overflow/);
    expect(() => run(`x: i32 :: 0 - 2147483648; x / -1`)).toThrow(/integer overflow/);
    // INT_MIN % -1 does NOT trap (wasm rem has no overflow case).
    expect(show(run(`b: i64 :: 0 - 9223372036854775807 - 1; b % -1`))).toBe("0");
    // float division by zero is not a trap.
    expect(show(run(`1.0 / 0.0`))).toBe("Infinity");
  });

  test("f32 rounds to f32 precision at every producing node", () => {
    expect(show(run(`@as(0.1 + 0.2, f32)`))).toBe("0.30000001192092896");
    expect(show(run(`@as(0.1, f32) + @as(0.2, f32)`))).toBe("0.30000001192092896");
    expect(show(run(`@as(1.0 / 3.0, f32)`))).toBe("0.3333333432674408");
    // f32 arithmetic is exact within f32: 0.1f32 + 0.2f32 == 0.3f32.
    expect(run(`@as(0.1, f32) + @as(0.2, f32) == @as(0.3, f32)`)).toBe(true);
  });

  test("untyped literals default to i64/f64 (literal defaulting, not conversion)", () => {
    expect(run(`2147483647 + 1`)).toBe(2147483648n); // i64: no i32 wrap
    expect(show(run(`1.5 + 1`))).toBe("2.5"); // f64 + i64-literal -> f64
    expect(typeOf(`1 + 2`)).toBe("i64");
    expect(typeOf(`1.5 + 1.5`)).toBe("f64");
  });

  test("wildcard-wide arithmetic runs unstamped through the operator table", () => {
    // Two untyped float literals leave the site unstamped (no concrete
    // width to pin), so the interpreter applies the env's own `+` closure.
    expect(run(`1.5 + 2.5`)).toBe(4);
  });

  test("builtins return concrete widths", () => {
    expect(typeOf(`range(0, 4, 1)`)).toBe("[i64]");
    expect(typeOf(`len([1, 2])`)).toBe("i64");
    expect(typeOf(`strlen("ab")`)).toBe("i64");
    expect(typeOf(`round(2.7)`)).toBe("i64");
    expect(run(`len([1, 2, 3])`)).toBe(3n);
    expect(run(`round(2.7)`)).toBe(3n);
    expect(typeOf(`PI`)).toBe("f64");
  });

  test("ambiguous numeric width in a let-generalized lambda is a static error", () => {
    expect(() => run(`inc :: fn(n) { n + 1 }; inc(1)`))
      .toThrow(/ambiguous numeric width — annotate the parameter \(e\.g\. n: i64\)/);
    expect(() => run(`add :: fn(x, y) { x + y }; add(1, 2)`))
      .toThrow(/ambiguous numeric width — annotate the parameter/);
    // Annotating fixes it; directly-passed lambdas are exempt (their param
    // types come from the instantiation); numeric-free bodies stay polymorphic.
    expect(run(`inc :: fn(n: i64) { n + 1 }; inc(41)`)).toBe(42n);
    expect(sliceElems(run(`map(fn(x) { x * x }, range(0, 4, 1))`) as Slice)).toEqual([0n, 1n, 4n, 9n]);
    expect(showT(prepare(`id :: fn(x) { x }; id`).checked.lastType)).toBe("(a) -> a");
  });

  test("arithmetic on any is a static error (use @as to pin a width)", () => {
    expect(() => run(`a: any :: 1; a + 1`))
      .toThrow(/any is not a numeric width/);
    expect(() => run(`a: any :: 1; a < 1`))
      .toThrow(/any is not a numeric width/);
    expect(() => run(`a: any :: "s"; a + "!"`))
      .toThrow(/any is not a numeric width/);
    // equality on any stays allowed.
    expect(run(`a: any :: 1; a == 1`)).toBe(true);
  });
});

describe("Semantic tokens (typeToks feed the LSP's type/effect highlighting)", () => {
  // Kind + source text at (pos, len) — asserts each token points at the right
  // characters without hand-counted columns. Position-sorted: push order is
  // checker traversal order, only the sorted result is contract (FR-008).
  const toks = (src: string): {kind: string, text: string}[] => {
    const lines = src.split("\n");
    const prog = new Parser(src).parseProgram();
    return [...prog.typeToks]
      .sort((a, b) => a.pos.line !== b.pos.line ? a.pos.line - b.pos.line : a.pos.col - b.pos.col)
      .map(t => ({
        kind: t.kind,
        text: (lines[t.pos.line - 1] ?? "").slice(t.pos.col - 1, t.pos.col - 1 + t.len),
      }));
  };

  // Same for the checker's value-identifier tokens (semToks).
  const vt = (src: string): {kind: string, text: string}[] => {
    const lines = src.split("\n");
    return [...prepare(src).checked.semToks]
      .sort((a, b) => a.pos.line !== b.pos.line ? a.pos.line - b.pos.line : a.pos.col - b.pos.col)
      .map(t => ({
        kind: t.kind,
        text: (lines[t.pos.line - 1] ?? "").slice(t.pos.col - 1, t.pos.col - 1 + t.len),
      }));
  };

  test("builtin prims record as `type` at their 1-based position", () => {
    const p = new Parser("x :: i32;").parseProgram();
    // `x :: i32;` declares an alias, so the decl name records too (FR-002).
    expect(p.typeToks).toEqual([
      {pos: {line: 1, col: 1}, len: 1, kind: "type", name: "x"},
      {pos: {line: 1, col: 6}, len: 3, kind: "type", name: "i32"},
    ]);
  });

  test("alias decl + use (spec AC-002); a nullary alias decl name records too", () => {
    expect(toks("Pair :: [i32, i32]; p :: Pair;")).toEqual([
      {kind: "type", text: "Pair"},
      {kind: "type", text: "i32"},
      {kind: "type", text: "i32"},
      {kind: "type", text: "p"},
      {kind: "type", text: "Pair"},
    ]);
  });

  test("type parameters record at binding and body uses; field labels skipped (spec AC-003)", () => {
    expect(toks("Box :: fn(a: type): type { [v: a, w: a] }; b :: Box(i32);")).toEqual([
      {kind: "type", text: "Box"},
      {kind: "typeParameter", text: "a"},
      {kind: "typeParameter", text: "a"},
      {kind: "typeParameter", text: "a"},
      {kind: "type", text: "b"},
      {kind: "type", text: "Box"},
      {kind: "type", text: "i32"},
    ]);
  });

  test("effect names record as macro: decl, rows, performs, case labels (spec AC-004)", () => {
    expect(toks(`effect Read(): i32;
f :: fn(): i32 ! { Read } { Read!() };
g :: (unit) -> i32 ! { Read };
h :: fn(): i32 ! { Read } { handle { Read!() } case Read(x) => k { x } case Return(v) => k { v } };`)).toEqual([
      {kind: "macro", text: "Read"},
      {kind: "type", text: "i32"},
      {kind: "type", text: "i32"},
      {kind: "macro", text: "Read"},
      {kind: "macro", text: "Read"},
      {kind: "type", text: "g"},
      {kind: "type", text: "unit"},
      {kind: "type", text: "i32"},
      {kind: "macro", text: "Read"},
      {kind: "type", text: "i32"},
      {kind: "macro", text: "Read"},
      {kind: "macro", text: "Read"},
      {kind: "macro", text: "Read"},
      {kind: "macro", text: "Return"},
    ]);
  });

  test("value identifiers: function vs variable, binder + use (spec AC-008)", () => {
    expect(vt(`collect :: fn(x: i64): [[i64]] { [[x]] };
collect(1);`)).toEqual([
      {kind: "function", text: "collect"}, // binder (let)
      {kind: "variable", text: "x"}, // binder (lambda param)
      {kind: "variable", text: "x"}, // use in body
      {kind: "function", text: "collect"}, // use (app)
    ]);
  });

  test("builtins: len function, PI variable (spec AC-009)", () => {
    expect(vt(`len([1, 2, 3]);\nPI;`)).toEqual([
      {kind: "function", text: "len"},
      {kind: "variable", text: "PI"},
    ]);
  });

  test("operator desugars record nothing (spec AC-010)", () => {
    expect(vt(`a: i64 :: 1;\nb: i64 :: 2;\np: bool :: true;\nq: bool :: false;\na + b;\n-a;\np && q;`)).toEqual([
      {kind: "variable", text: "a"}, // binder
      {kind: "variable", text: "b"}, // binder
      {kind: "variable", text: "p"}, // binder
      {kind: "variable", text: "q"}, // binder
      {kind: "variable", text: "a"}, // + lhs
      {kind: "variable", text: "b"}, // + rhs
      {kind: "variable", text: "a"}, // neg arg
      {kind: "variable", text: "p"}, // && cond
      {kind: "variable", text: "q"}, // && then
    ]);
  });

  test("handler case params bind with their effect-sig types (spec FR-007)", () => {
    // `k { v }` is resume-with syntax — k is never an expression identifier,
    // so only the case param (binder + use) and the handler binder record.
    expect(vt(`effect Read(): i64;\nh :: fn(): i64 ! { Read } { handle { Read!() } case Read(v) => k { v } };`)).toEqual([
      {kind: "function", text: "h"}, // binder
      {kind: "variable", text: "v"}, // case-param binder
      {kind: "variable", text: "v"}, // use (resumed value)
    ]);
  });

  test("rewound alias attempts truncate — no phantom tokens (spec AC-005/006)", () => {
    // `x :: Foo;` rewinds into a value binding; the failed attempt's tokens
    // (x, Foo) must not leak. The binding then fails the check.
    expect(toks("x :: Foo;")).toEqual([]);
    expect(() => prepare("x :: Foo;")).toThrow(/Unbound: Foo/);
    expect(toks("Pair :: [i32, i32]; counter :: 0;")).toEqual([
      {kind: "type", text: "Pair"},
      {kind: "type", text: "i32"},
      {kind: "type", text: "i32"},
    ]);
  });

  test("`any` and the type-of-types keyword record in type position", () => {
    expect(toks("x :: any; y :: type;")).toEqual([
      {kind: "type", text: "x"},
      {kind: "type", text: "any"},
      {kind: "type", text: "y"},
      {kind: "type", text: "type"},
    ]);
  });
});

// Selective CPS: classified-pure functions convert direct-style (dcall sites,
// dret boundary); everything that can suspend stays CPS. Structural
// assertions read the converted IR; behavioral ones pin both paths.
describe("selective CPS: dcall/dret classification", () => {
  const countNodes = (ir: CIr, pred: (t: CTerm) => boolean): number => {
    let n = 0;
    const walk = (t: CTerm): void => {
      if (pred(t)) n++;
      switch (t.t) {
        case "letk": walk(t.body); walk(t.rest); return;
        case "let": case "bind": case "mkfn": case "dlet": case "assign": case "scope":
          walk(t.rest); return;
        case "dcall": walk(t.rest); return;
        case "if": walk(t.a); walk(t.b); return;
        case "handle": walk(t.body); for (const c of t.cases) walk(c.body); return;
        default: return;
      }
    };
    walk(ir.term);
    for (const fn of ir.funcs) walk(fn.body);
    return n;
  };
  const ir = (src: string): CIr => {
    const {prog} = prepare(src); // the suspension stamps are checker-stamped
    return toCps(prog);
  };

  test("pure recursive function: self-call and top-level call are dcalls, boundary is dret", () => {
    const src = `
      fact :: fn(n: i64): i64 {
        if (n <= 1) { 1 } else { n * fact(n - 1) }
      };
      fact(5)
    `;
    expect(show(run(src))).toBe("120");
    const c = ir(src);
    expect(countNodes(c, t => t.t === "dcall")).toBe(2); // self-call + top-level
    expect(countNodes(c, t => t.t === "dret")).toBe(2); // one per tail arm of fact's if
    expect(countNodes(c, t => t.t === "call")).toBe(0);
  });

  test("pure closure passed to map: direct boundary, generic call for map itself", () => {
    const src = `
      double :: fn(x: i64): i64 { x * 2 };
      map(double, [1, 2, 3])
    `;
    expect(show(run(src))).toBe("[2, 4, 6]");
    const c = ir(src);
    expect(countNodes(c, t => t.t === "dcall")).toBe(0); // x * 2 is an op; map stays generic
    expect(countNodes(c, t => t.t === "dret")).toBe(1); // double's boundary
    expect(countNodes(c, t => t.t === "call")).toBe(1);
  });

  test("effectful function calling pure helpers: dcalls inside a CPS body", () => {
    const src = `
      effect Log(n: i64): i64;
      helper :: fn(x: i64): i64 { x + 1 };
      main :: fn(): i64 { Log!(helper(10)) };
      handle {
        main() + helper(100)
      } case Log(n) => k { k(n * 2) } case Return(v) => k { v }
    `;
    expect(show(run(src))).toBe("123"); // helper(10)=11 → Log resumes 22; 22 + helper(100)=101 → 123
    const c = ir(src);
    // helper calls classify direct (pure row); main() performs Log — its row
    // is {Log} — so it stays a generic call; the case body's resume call too.
    expect(countNodes(c, t => t.t === "dcall")).toBe(2); // helper(10), helper(100)
    expect(countNodes(c, t => t.t === "call")).toBe(2); // main(), k(n * 2)
    expect(countNodes(c, t => t.t === "dret")).toBe(1); // helper's boundary (main's tail is a perform — CPS)
    expect(countNodes(c, t => t.t === "perform")).toBe(1);
  });

  test("multi-shot resume crossing dcall-produced bindings", () => {
    expect(show(run(`
      effect Pick(opts: [i64]): i64;
      pure :: fn(x: i64): i64 { x * 10 };
      handle {
        a :: pure(1);
        b :: Pick!([1, 2]);
        c :: pure(b);
        [a, b, c]
      } case Return(v) => k { [v] }
        case Pick(opts) => k { flat(map(k, opts)) }
    `))).toBe("[[10, 1, 10], [10, 2, 20]]");
  });

  test("any-typed callee and row-polymorphic native callee stay suspending", () => {
    expect(show(run(`
      effect Ask(n: i64): i64;
      f :: fn(x: i64): i64 { Ask!(x) };
      a: any = f;
      handle { a(3) } case Ask(n) => k { k(n * 2) } case Return(v) => k { v }
    `))).toBe("6");
    expect(show(run(`
      effect Tick(n: i64): i64;
      cb :: fn(x: i64): i64 ! { Tick } { Tick!(x) };
      handle { map(cb, [1, 2]) } case Tick(n) => k { k(n + 100) } case Return(v) => k { v }
    `))).toBe("[101, 102]");
  });

  test("anyTaint: suspending function through an any binding into a pure-typed param still suspends", () => {
    const src = `
      effect Ask(n: i64): i64;
      run1 :: fn(f: (i64) -> i64): i64 { f(3) };
      susp :: fn(x: i64): i64 ! { Ask } { Ask!(x) };
      a: any = susp;
      handle { run1(a) } case Ask(n) => k { k(n * 2) } case Return(v) => k { v }
    `;
    expect(show(run(src))).toBe("6");
    const c = ir(src);
    // The outer run1(a) site classifies direct (run1's own FunT is pure —
    // the anyTaint landed on the param FunT), but the inner f(3) — typed by
    // that tainted param FunT — must stay a suspending call.
    expect(countNodes(c, t => t.t === "dcall")).toBe(1); // run1(a)
    expect(countNodes(c, t => t.t === "call")).toBe(2); // f(3) inside run1 + the case body's resume call
  });

  test("contCall: invoking a resume binder stays suspending and re-performs (multi-shot)", () => {
    const src = `
      effect Ask(n: i64): i64;
      handle {
        x :: Ask!(1);
        y :: Ask!(x);
        y
      } case Ask(n) => k { k(n * 2) } case Return(v) => k { v }
    `;
    expect(show(run(src))).toBe("4");
    const c = ir(src);
    // The case body invokes the resume binder: the binder's FunT carries
    // contCall, so the invoke site must be a call, never a dcall — resuming
    // re-enters captured CPS machinery and performs again.
    expect(countNodes(c, t => t.t === "call")).toBe(1);
    expect(countNodes(c, t => t.t === "dcall")).toBe(0);
  });

  test("mixed function: internal handle keeps the direct boundary (row {})", () => {
    const src = `
      effect Tick(n: i64): i64;
      mix :: fn(x: i64): i64 {
        handle { Tick!(x) + 1 } case Tick(n) => k { k(n * 10) }
      };
      mix(3) + mix(4)
    `;
    expect(show(run(src))).toBe("72"); // (30 + 1) + (40 + 1)
    const c = ir(src);
    // mix's row is {} — the island covers Tick — so the boundary stays
    // direct: both call sites are dcalls, and the handle's k operand is the
    // never-set $ret (the emitter resolves it to the terminal return-cell;
    // no dret node materializes under a tail handle).
    expect(countNodes(c, t => t.t === "dret")).toBe(0);
    expect(countNodes(c, t => t.t === "handle")).toBe(1);
    expect(countNodes(c, t => t.t === "dcall")).toBe(2);
    expect(countNodes(c, t => t.t === "call")).toBe(1); // the case body's k(n * 10) resume
    expect(c.funcs.filter(f => f.direct === true).length).toBe(1);
  });

  test("mixed function with a tail handle: boundary rides the terminal cell", () => {
    const src = `
      effect Tick(n: i64): i64;
      mix :: fn(x: i64): i64 {
        handle { Tick!(x) } case Tick(n) => k { n * 2 }
      };
      mix(21)
    `;
    expect(show(run(src))).toBe("42");
    const c = ir(src);
    // The handle IS the body: its k operand is the never-set $ret — the
    // emitted HDL chains to the terminal return-cell instead.
    expect(countNodes(c, t => t.t === "dret")).toBe(0);
    expect(countNodes(c, t => t.t === "handle")).toBe(1);
    expect(c.funcs.filter(f => f.direct === true).length).toBe(1);
  });

  test("multi-shot resume inside a mixed function (the amb shape)", () => {
    const src = `
      effect Choose(lo: i64, hi: i64): i64;
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
      outer(2)
    `;
    // middle is CPS (its row carries Emit); outer is mixed: row {} with an
    // internal handle, resumed multi-shot by the Choose handler inside
    // middle. Each Choose resume re-enters the spine through the resume
    // lambda's tail contCall — its performs must reach outer's Emit island
    // across the direct boundary.
    expect(show(run(src))).toBe("[[1], [2]]");
    const c = ir(src);
    expect(countNodes(c, t => t.t === "dret")).toBe(0); // outer's boundary is its tail handle's k operand
    expect(c.funcs.filter(f => f.direct === true).length).toBe(1); // outer only
  });
});

describe("Spine-gated resume typing (multi-shot resume over HOF loops)", () => {
  // Resuming the body of a Return-less, spine-perform-free handle runs it to
  // completion, so k delivers the body's completion value: op cases that
  // reference k must agree with the body's type.
  const cb = "cb :: fn(x: i64): i64 { Op!() }";

  test("double resume over map: delivery must match the body type (named callback)", () => {
    expect(() => run(`effect Op(): i64; ${cb};
      handle { map(cb, [1, 2]) } case Op() => k { k(k(10)) }`))
      .toThrow("expected : [i64]");
  });

  test("double resume over map: same rejection with an inline callback", () => {
    expect(() => run(`effect Op(): i64;
      handle { map(fn(x: i64): i64 { Op!() }, [1, 2]) } case Op() => k { k(k(10)) }`))
      .toThrow("expected : [i64]");
  });

  test("single resume over map: the delivery constraint surfaces at the use site", () => {
    // k(10)'s type stays a fresh var at the case body, so the mismatch is
    // not forced there — it surfaces where the handle's result is consumed.
    expect(() => run(`effect Op(): i64; ${cb};
      s := handle { map(cb, [1, 2]) } case Op() => k { k(10) };
      s + 0`))
      .toThrow("+: [a] and i64 are not both numeric or both string");
  });

  test("len-inside: the case body's completion conflicts with the delivery", () => {
    // k(10) flows into len's [a] param, binding k's return to [a]; the
    // body-completion boundary then rejects the case body's i64 — matching
    // the shape's garbage runtime (len of a delivery window).
    expect(() => run(`effect Op(): i64; ${cb};
      handle { map(cb, [1, 2]) } case Op() => k { len(k(10)) }`))
      .toThrow(/got\s+: \[a\]\nexpected : i64/);
  });

  test("observing handler: a case body completing without the delivery is rejected", () => {
    // The delivery is the body's completion; discarding it (Println!) would
    // misreport the body's result. Escape: return the delivery and observe
    // outside the handle.
    expect(() => run(`effect Op(): i64; ${cb};
      handle { map(cb, [1, 2]) } case Op() => k { Println!(k(10)) }`))
      .toThrow(/got\s+: unit\nexpected : \[i64\]/);
  });

  test("abort idiom: a k-free case body skips the delivery constraint", () => {
    expect(show(run(`effect Op(): i64; ${cb};
      handle { map(cb, [1, 2]) } case Op() => k { 42 }`))).toBe("42");
  });

  test("transforming handler: len outside, k(10) inside", () => {
    const src = `effect Op(): i64; ${cb};
      len(handle { map(cb, [1, 2]) } case Op() => k { k(10) })`;
    expect(typeOf(src)).toBe("i64");
    expect(show(run(src))).toBe("2");
  });

  test("multi-shot delivery over map is [i64]: interp aliases the shared result window", () => {
    // Each resume re-runs the body; map's land re-writes the shared window
    // (last write wins per element). The wasm backend diverges here —
    // pinned in wasm.test.ts until the per-element land state change.
    const src = `effect Op(): i64; ${cb};
      handle { map(cb, [1, 2]) } case Op() => k { q := k(10); k(11); q }`;
    expect(typeOf(src)).toBe("[i64]");
    expect(show(run(src))).toBe("[11, 11]");
  });

  test("single-shot resume over map is unchanged", () => {
    expect(show(run(`effect Op(): i64; ${cb};
      handle { map(cb, [1, 2]) } case Op() => k { k(10) }`))).toBe("[10, 10]");
  });

  test("each multi-shot with a trailing spine perform is unchanged", () => {
    // The trailing Op! puts a perform on the body's spine, so the delivery
    // constraint never fires — the looser boundary holds.
    expect(show(run(`effect Op(): i64; cb :: fn(x: i64, i: i64): i64 { Op!() };
      handle {
        each(cb, [1, 2]);
        Op!()
      } case Op() => k { k(k(0)) }`))).toBe("0");
  });

  test("each under a handler resumes single-shot: unit result", () => {
    expect(show(run(`effect Op(): i64; cb :: fn(x: i64, i: i64): i64 { Op!() };
      handle { each(cb, [1, 2]) } case Op() => k { k(0) }`))).toBe("unit");
  });

  test("design-B: k(1) + k(2) over a perform-spined body is unchanged", () => {
    expect(show(run(`effect Op(): i64;
      handle { Op!() } case Op() => k { k(1) + k(2) }`))).toBe("3");
  });

  test("show prints cyclic values as #cycle instead of recursing forever", () => {
    const cell: Value[] = [null]; // placeholder replaced by the cycle below
    const cyc = mkSlice(cell);
    cell[0] = cyc;
    expect(show(cyc)).toBe("[#cycle]");
    expect(show(mkSlice([cyc]))).toBe("[[#cycle]]");
    expect(show(mkTup([cyc]))).toBe("[[#cycle]]");
    // Shared (acyclic) objects still print in full at each occurrence.
    const shared = mkSlice([1n, 2n]);
    expect(show(mkSlice([shared, shared]))).toBe("[[1, 2], [1, 2]]");
  });
});
