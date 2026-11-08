import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, unlinkSync, existsSync, writeFileSync} from "node:fs";
import {execSync} from "node:child_process";
import {run, newCtx, exec} from "./eval.ts";
import {checkProgram, showT} from "./types.ts";
import {show, type Value} from "./env.ts";
import {Parser} from "./parser.ts";

// typeOf: return the inferred type of the last expression, as a string.
// Surfaces effect sets in function signatures, e.g. `(i64) -> i64 ! { Emit }`.
export function typeOf(src: string): string {
  const prog = new Parser(src).parseProgram();
  return showT(checkProgram(prog).lastType);
}

const tmpPath = (n: string) => join(tmpdir(), `ef-test-${process.pid}-${n}.txt`);

test("exec drives a REPL session: bindings persist, lastType resolved", () => {
  const ctx = newCtx();
  const l1 = exec(new Parser("let add = fn(a: i64, b: i64): i64 { a + b };").parseProgram(), ctx);
  const l2 = exec(new Parser("add(1, 2)").parseProgram(), ctx);
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
  let x = Choose!([1, 2, 3]);
  let y = Choose!([10, 20]);
  [x, y]
} case Return(v) => k { [v] }
  case Choose(opts) => k { flat(map(k, opts)) }
`))).toBe("[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]");
});

test("Exception — non-resuming handler aborts", () => {
expect(show(run(`
effect Div(a: i64, b: i64): i64;
handle {
  let r = Div!(10, 0);
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
let fact = fn(n: i64): i64 {
  if (n == 0) { 1 } else { n * fact(n - 1) }
};
fact(5)
`))).toBe("120");
});

test("Short-circuit && / || and infix arithmetic", () => {
expect(show(run(`
let guard = fn(x: i64): string {
  if (x > 0 && x < 10) { "in" } else { "out" }
};
[guard(5), guard(50)]
`))).toBe("[\"in\", \"out\"]");
});

test("Type annotations on let", () => {
expect(show(run(`
let x: i64 = 5;
let y: i64 = x + 3;
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
    expect(typeOf("let f = fn(): unit ! { Wait } { Wait!(0) };")).toBe("unit");
  });

  test("inferred `any` warns; an explicit `: any` annotation is silent", () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (s: string) => { warned.push(s); };
    try {
      typeOf("let f = list; f");            // inferred (any) -> [any]  -> warn
      typeOf("let f: (any) -> [any] = list; f"); // explicit annotation -> silent
      typeOf("let xs = [1, 2, 3]; xs");     // array literal -> [i64]   -> silent
    } finally {
      console.warn = orig;
    }
    expect(warned.length).toBe(1);
    expect(warned[0]).toMatch(/`f` inferred as .*\(any\) -> \[any\]/);
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
    expect(typeOf(`let p: [x: f64, y: f64] = [1.0, 2.0]; p`)).toBe("[x: f64, y: f64]");
  });
  test("dot access on a tuple by name", () => {
    expect(show(run(`let p: [x: f64, y: f64] = [1.0, 2.0]; p.x`))).toBe("1");
  });
  test("dot access on a tuple by index", () => {
    expect(show(run(`let p: [i64, string] = [1, "a"]; p.1`))).toBe("\"a\"");
  });
  test("dot access on an array by index", () => {
    expect(show(run(`let xs = [10, 20, 30]; xs.0`))).toBe("10");
  });
  test("destructuring let binds tuple fields", () => {
    expect(show(run(`let p: [i64, string] = [1, "a"]; let [n, s] = p; s`))).toBe("\"a\"");
  });
  test("destructuring let on an array", () => {
    expect(show(run(`let xs = [10, 20]; let [a, b] = xs; a + b`))).toBe("30");
  });
  test("parametric type alias instantiates", () => {
    expect(typeOf(`type Pair(a, b) = [a, b]; let p: Pair[i64, string] = [1, "a"]; p`)).toBe("[i64, string]");
  });
  test("alias used in a function signature", () => {
    expect(typeOf(`type Pair(a, b) = [a, b]; let fst = fn(p: Pair[i64, string]): i64 { p.0 }; fst`)).toBe("([i64, string]) -> i64");
  });
});

describe("Negative tests (static type checker rejects)", () => {
  function assertTypeError(src: string, needle: string) {
    expect(() => run(src)).toThrow(needle);
  }

  test("Adding a string to an i64", () => {
    assertTypeError(`let s: string = "hi"; s + 1`, "i64");
  });

  test("Calling a function with the wrong argument type", () => {
    assertTypeError(`let f = fn(n: i64): i64 { n + 1 }; f("x")`, "i64");
  });

  test("Heterogeneous array literal is now a tuple", () => {
    expect(typeOf(`[1, "a", true]`)).toBe("[i64, string, bool]");
  });

  test("Tuple arity mismatch is rejected", () => {
    assertTypeError(`let p: [i64, string] = [1, "a", true];`, "arity");
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

  test("exit/wait are no longer builtins (use Exit!/Wait)", () => {
    assertTypeError(`exit(1)`, "Unbound: exit");
    assertTypeError(`wait(1)`, "Unbound: wait");
  });
});

test("Effectful function signature carries its effect set", () => {
  // ask echoes its arg via the Emit effect and returns it; the signature
  // declares `! { Emit }`, which the checker verifies against the body.
  expect(typeOf(`
effect Emit(m: i64): i64;
let ask = fn(n: i64): i64 ! { Emit } { Emit!(n) };
ask
`)).toBe("(i64) -> i64 ! { Emit }");
});

test("Declaring an effect set rejects effects not listed", () => {
  // Body performs Emit but the signature only declares Log.
  expect(() => run(`
effect Emit(m: i64): i64;
effect Log(m: i64): i64;
let f = fn(n: i64): i64 ! { Log } { Emit!(n) };
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
let firstRead = fn(path: string): string ! { Read } { Read!(path) };
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
  expect(typeOf(`let x: i32 = 1; x`)).toBe("i32");
  expect(typeOf(`let x: u64 = 1; x + 1`)).toBe("u64");
  expect(typeOf(`let x: f32 = 1.5; x`)).toBe("f32");
  expect(typeOf(`let x: i32 = 1; x + 2`)).toBe("i32");       // literal flexes down
  expect(typeOf(`sqrt(100)`)).toBe("f64");                    // literal flexes up
  expect(() => typeOf(`let x: i32 = 1; let y: i64 = 2; x + y`)).toThrow(/different numeric widths/);
  expect(typeOf(`let x: f32 = 1; x + 1.5`)).toBe("f32");      // float literal flexes to f32
  expect(() => typeOf(`let x: i32 = 1.5`)).toThrow();         // float literal never narrows
  expect(() => typeOf(`get([10, 20], 1.5)`)).toThrow();       // indices are i64, not f64
});

test("@as: the explicit numeric cast", () => {
  expect(typeOf(`@as(1, i32)`)).toBe("i32");
  expect(show(run(`@as(3.7, i32)`))).toBe("3");               // truncates toward zero
  expect(show(run(`@as(-3.7, i32)`))).toBe("-3");
  expect(show(run(`@as(true, i32)`))).toBe("1");
  expect(show(run(`@as(false, i32)`))).toBe("0");
  expect(show(run(`let x: i64 = 5; @as(x, f32) + @as(x, f32)`))).toBe("10");
  expect(() => typeOf(`@as(1, [i64])`)).toThrow(/numeric width/);
  expect(typeOf(`@as(true, i32) + 1`)).toBe("i32");
});

test("f32 arithmetic rounds to f32 precision (interp and wasm agree)", () => {
  expect(show(run(`let a: f32 = 0.1; let b: f32 = 0.2; a + b`))).toBe("0.30000001192092896");
  expect(show(run(`let a: f32 = 0.1; a * 10.0`))).toBe("1");
  expect(show(run(`let a: f64 = 0.1; let b: f64 = 0.2; a + b`))).toBe("0.30000000000000004");
  expect(show(run(`let a: f32 = 0.1; a / 3.0`))).toBe("0.03333333507180214");
});

test("u32/u64 hold unsigned ranges; i64 goes past i32", () => {
  expect(show(run(`let x: u32 = 4294967295; x`))).toBe("4294967295");
  expect(show(run(`let x: u64 = 9007199254740992; x`))).toBe("9007199254740992");
  expect(show(run(`let x: i64 = 9999999999; x * 2`))).toBe("19999999998");
  expect(show(run(`let x: u32 = 3; let y: u32 = 5; x < y`))).toBe("true");
});

test("an untyped int literal flows into a f64-typed parameter", () => {
  // f(1) passes an untyped literal where a f64 param is expected — it flexes.
  expect(show(run(`
let f = fn(x: f64): f64 { x + 0.5 };
f(1)
`))).toBe("1.5");
});

test("while loop with assignment", () => {
  // Sum 1..5 with a mutable accumulator.
  expect(show(run(`
let i = 1;
let acc = 0;
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
  expect(show(run(`let s = "x"; s + s`))).toBe("\"xx\"");
  // mixed string/number is a type error in either order.
  expect(() => run(`"a" + 1`)).toThrow(/string/);
  expect(() => run(`1 + "a"`)).toThrow(/string/);
  // mixed string/bool is a type error.
  expect(() => run(`"a" + true`)).toThrow(/string/);
});

test("builtins added for the star port: range/get/set/each/flatmap/modulo", () => {
  // range + each + set: build [0,1,2,3] via mutation, sum with each.
  expect(show(run(`
let a = [0, 0, 0, 0];
let s = 0;
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

test("head/get fail loudly on empty/out-of-bounds", () => {
  // No silent null: empty array and OOB index raise instead of returning unit.
  expect(() => run(`head([])`)).toThrow(/head of empty array/);
  expect(() => run(`get([1, 2], 5)`)).toThrow(/out of bounds/);
  expect(() => run(`get([1, 2], -1)`)).toThrow(/out of bounds/);
  // In-bounds still works.
  expect(show(run(`head([1, 2, 3])`))).toBe("1");
  expect(show(run(`get([1, 2, 3], 2)`))).toBe("3");
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
  expect(show(run(`let f = fn(): i64 { 1 + 2 };\nf`))).toBe("[fn: () -> i64]");
  // Effectful body, annotation present and covering: fine.
  expect(show(run(`let g = fn(): unit ! { Out } { Out!("x") };\ng`))).toBe("[fn: () -> unit ! { Out }]");
  // Effectful body, no annotation: derived from body, accepted.
  expect(show(run(`let h = fn(): unit { Out!("x") };\nh`))).toBe("[fn: () -> unit ! { Out }]");
  // Anonymous lambda too: effectful without annotation is derived.
  expect(show(run(`let k = fn(): unit { Out!("x") }; k`))).toBe("[fn: () -> unit ! { Out }]");
  // Anonymous lambda with annotation: accepted.
  expect(show(run(`let k = fn(): unit ! { Out } { Out!("x") }; k`))).toBe("[fn: () -> unit ! { Out }]");
  // Annotation that underspecifies is still rejected.
  expect(() => run(`let p = fn(): unit ! { } { Out!("x") };\np`)).toThrow(/not declared in signature/);
});

test("higher-order builtins are effect-polymorphic", () => {
  // Pure callback: the map call performs no effects.
  expect(typeOf(`let usePure = fn(): [i64] { map(fn(x: i64): i64 { x + 1 }, [1, 2, 3]) };
usePure`)).toBe("() -> [i64]");
  // Effectful callback: exactly { Out } propagates, not over-approximated.
  expect(typeOf(`let useEffectful = fn(): [i64] { map(fn(x: i64): i64 { Out!("x"); x }, [1, 2, 3]) };
useEffectful`)).toBe("() -> [i64] ! { Out }");
  // each with an effectful body callback propagates too.
  expect(typeOf(`let eachOut = fn(): unit { each(fn(x: i64, _: i64) { Out!("x") }, [1, 2, 3]) };
eachOut`)).toBe("() -> unit ! { Out }");
  // Pure each stays pure.
  expect(typeOf(`let eachPure = fn(): unit { each(fn(x: i64, _: i64) { unit }, [1, 2, 3]) };
eachPure`)).toBe("() -> unit");
});

test("user-defined polymorphic functions via let-generalization", () => {
  // `apply` is a lambda RHS, so it's generalized: one definition instantiates
  // fresh type vars per call and works at i64 and string in the same program.
  expect(typeOf(`let apply = fn (f, x) { f(x) };
apply(fn (n: i64) { n + 1 }, 41)`)).toBe("i64");
  expect(typeOf(`let apply = fn (f, x) { f(x) };
apply(fn (n: i64) { "n=" + char(48 + n) }, 7)`)).toBe("string");
  // Both instantiations coexist in one program.
  expect(show(run(`let apply = fn (f, x) { f(x) };
let a = apply(fn (n: i64) { n + 1 }, 41);
let b = apply(fn (n: i64) { "n=" + char(48 + n) }, 7);
a`))).toBe("42");
  expect(show(run(`let apply = fn (f, x) { f(x) };
let b = apply(fn (n: i64) { "n=" + char(48 + n) }, 7);
b`))).toBe("\"n=7\"");
  // Value restriction: a non-lambda RHS is NOT generalized, so a returned
  // function used at two types is a type error (stays monomorphic).
  // (Sanity: a lambda-typed `let` with an explicit annotation is monomorphic.)
  expect(() => run(`let id: (i64) -> i64 = fn (x) { x };
let s = id("hi")`)).toThrow();
});

test("show prints function arity and type, natives stay [fn]", () => {
  expect(show(run(`let add = fn(a: i64, b: i64): i64 { a + b };\nadd`))).toBe("[fn: (i64, i64) -> i64]");
  expect(show(run(`let id = fn(x: i64): i64 { x };\nid`))).toBe("[fn: (i64) -> i64]");
  // Builtins (natives) carry no inferred type here: stay [fn].
  expect(show(run(`head`))).toBe("[fn]");
});

test("nested tuple field access chains (m.0.0)", () => {
  // The lexer reads `0.0` as one f64 token; the parser splits it so
  // `m.0.0` is two field accesses, not one.
  expect(run(`let m: [[i64,i64,i64],[i64,i64,i64],[i64,i64,i64]] = [[1,2,3],[4,5,6],[7,8,9]]; m.0.0`)).toBe(1n);
  expect(run(`let m: [[i64,i64,i64],[i64,i64,i64],[i64,i64,i64]] = [[1,2,3],[4,5,6],[7,8,9]]; m.2.1`)).toBe(8n);
});

test("array literal infers as tuple against a tuple-typed context", () => {
  // Return type: a `[x, y, z]` body literal conforms to `[i64,i64,i64]`.
  expect(run(`let f = fn(): [i64,i64,i64] { [1, 2, 3] }; f().1`)).toBe(2n);
  // Argument: an `[...]` literal passed to a tuple parameter becomes a tuple.
  expect(run(`let f = fn(p: [i64,i64,i64]): i64 { p.2 }; f([1,2,3])`)).toBe(3n);
  // Nested: `[[...],[...]]` argument against a tuple-of-tuples parameter.
  expect(run(`let f = fn(m: [[i64,i64,i64],[i64,i64,i64]]): i64 { m.1.0 }; f([[1,2,3],[4,5,6]])`)).toBe(4n);
});

test("REPL: bindings persist across lines", () => {
  const out = execSync(
    "bun run cli.ts repl",
    {input: "let a = 6\nlet b = 7\na * b\n:q\n", encoding: "utf8", timeout: 20000, cwd: import.meta.dir},
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
    expect(run(`effect T(x: i64): i64; let f = fn(y: i64): i64 ! { T } { T!(y) }; handle { f(5) } case T(n) => k { n + 1 }`)).toBe(6n);
  });

  test("an unhandled op through a call is caught statically, not just a bare perform", () => {
    expect(() => run(`effect T(x: i64): i64; let f = fn(y: i64): i64 ! { T } { T!(y) }; f(1)`))
      .toThrow("Unhandled effect: T");
  });

  test("case bodies run outside their handler: ops they perform must be handled too", () => {
    expect(() => run(`effect T(x: i64): i64; effect U(x: i64): i64; handle { T!(1) } case T(n) => k { U!(2) }`))
      .toThrow("Unhandled effect: U");
    expect(run(`effect T(x: i64): i64; effect U(x: i64): i64; handle { T!(1) } case T(n) => k { U!(2) }`,
      {U: (_args, k) => k(7)})).toBe(7n);
  });

  test("builtin effects are never flagged", () => {
    expect(typeof run(`Random!()`)).toBe("number");
  });
});

describe("Env seeding (exec binds referenced builtins per line)", () => {
  test("a later REPL line can reference a previously-unused builtin", () => {
    const ctx = newCtx();
    exec(new Parser(`let x = 1;`).parseProgram(), ctx);
    expect(ctx.env.vars.has("len")).toBe(false); // not referenced yet -> not bound
    expect(exec(new Parser(`len([1, 2]);`).parseProgram(), ctx).value).toBe(2n);
    expect(ctx.env.vars.has("len")).toBe(true);
  });

  test("seeded bindings never overwrite a user shadow", () => {
    const ctx = newCtx();
    exec(new Parser(`let len = fn(a, b) { 42 };`).parseProgram(), ctx);
    expect(exec(new Parser(`len([1], [2])`).parseProgram(), ctx).value).toBe(42n);
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

// Numeric widths (typed-widths plan): the interpreter is width-exact —
// i32/u32/f32/f64 values are JS numbers, i64/u64 values are BigInt (exact
// beyond 2^53) — and integer division/remainder trap on ÷0 and INT_MIN÷-1
// like wasm's div/rem ops. The f32 and i32/u32 slices have graduated to
// full two-backend parity (wasm.test.ts); the i64/u64 cases here stay
// interp-only until step 4 gives the wasm backend typed 64-bit ops.
describe("numeric widths", () => {
  test("i32 sign-wraps", () => {
    expect(show(run(`let x: i32 = 2147483647; x + 1`))).toBe("-2147483648");
    expect(show(run(`let x: i32 = 2147483647; x * 2`))).toBe("-2");
    expect(show(run(`let x: i32 = -2147483648; x - 1`))).toBe("2147483647");
  });

  test("u32 wraps mod 2^32", () => {
    expect(show(run(`let u: u32 = 4294967295; u + 1`))).toBe("0");
    expect(show(run(`let u: u32 = 4294967295; u * 2`))).toBe("4294967294");
    expect(show(run(`let u: u32 = 1; u - 2`))).toBe("4294967295");
  });

  test("i64 is exact beyond 2^53 (BigInt values)", () => {
    expect(run(`let big: i64 = 9007199254740993; big + 1`)).toBe(9007199254740994n);
    expect(run(`let big: i64 = 9007199254740993; big * 2`)).toBe(18014398509481986n);
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
    expect(show(run(`let u: u64 = 18446744073709551615; u + 1`))).toBe("0");
    expect(show(run(`let u: u64 = 18446744073709551615; u * 2`))).toBe("18446744073709551614");
  });

  test("integer division/remainder traps: ÷0 and INT_MIN ÷ -1 (wasm div/rem parity)", () => {
    expect(() => run(`1 / 0`)).toThrow(/integer divide by zero/);
    expect(() => run(`17 % 0`)).toThrow(/integer divide by zero/);
    expect(() => run(`let b: i64 = 0 - 9223372036854775807 - 1; b / -1`)).toThrow(/integer overflow/);
    expect(() => run(`let x: i32 = 0 - 2147483648; x / -1`)).toThrow(/integer overflow/);
    // INT_MIN % -1 does NOT trap (wasm rem has no overflow case).
    expect(show(run(`let b: i64 = 0 - 9223372036854775807 - 1; b % -1`))).toBe("0");
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

  test("builtins return concrete widths (D7)", () => {
    expect(typeOf(`range(0, 4, 1)`)).toBe("[i64]");
    expect(typeOf(`len([1, 2])`)).toBe("i64");
    expect(typeOf(`strlen("ab")`)).toBe("i64");
    expect(typeOf(`round(2.7)`)).toBe("i64");
    expect(run(`len([1, 2, 3])`)).toBe(3n);
    expect(run(`round(2.7)`)).toBe(3n);
    expect(typeOf(`PI`)).toBe("f64");
  });

  test("ambiguous numeric width in a let-generalized lambda is a static error", () => {
    expect(() => run(`let inc = fn(n) { n + 1 }; inc(1)`))
      .toThrow(/ambiguous numeric width — annotate the parameter \(e\.g\. n: i64\)/);
    expect(() => run(`let add = fn(x, y) { x + y }; add(1, 2)`))
      .toThrow(/ambiguous numeric width — annotate the parameter/);
    // Annotating fixes it; directly-passed lambdas are exempt (their param
    // types come from the instantiation); numeric-free bodies stay polymorphic.
    expect(run(`let inc = fn(n: i64) { n + 1 }; inc(41)`)).toBe(42n);
    expect(run(`map(fn(x) { x * x }, range(0, 4, 1))`)).toEqual([0n, 1n, 4n, 9n]);
    expect(showT(checkProgram(new Parser(`let id = fn(x) { x }; id`).parseProgram()).lastType)).toBe("(a) -> a");
  });

  test("arithmetic on any is a static error (use @as to pin a width)", () => {
    expect(() => run(`let a: any = 1; a + 1`))
      .toThrow(/any is not a numeric width/);
    expect(() => run(`let a: any = 1; a < 1`))
      .toThrow(/any is not a numeric width/);
    expect(() => run(`let a: any = "s"; a + "!"`))
      .toThrow(/any is not a numeric width/);
    // equality on any stays allowed.
    expect(run(`let a: any = 1; a == 1`)).toBe(true);
  });
});
