import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, unlinkSync, existsSync} from "node:fs";
import {execSync} from "node:child_process";
import {run} from "./eval.ts";
import {checkProgram, res, showT} from "./types.ts";
import {show} from "./env.ts";
import {Parser} from "./parser.ts";

// typeOf: return the inferred type of the last expression, as a string.
// Surfaces effect sets in function signatures, e.g. `(int) -> int ! { Emit }`.
export function typeOf(src: string): string {
  const items = new Parser(src).parseProgram();
  return showT(res(checkProgram(items).lastType));
}

const tmpPath = (n: string) => join(tmpdir(), `ef-test-${process.pid}-${n}.txt`);

test("Nondeterminism — multi-shot resume, declared effect + return type", () => {
expect(show(run(`
effect Choose(opts: [int]): int;
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
effect Div(a: int, b: int): int;
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
let fact = fn(n: int): int {
  if (n == 0) { 1 } else { n * fact(n - 1) }
};
fact(5)
`))).toBe("120");
});

test("Short-circuit && / || and infix arithmetic", () => {
expect(show(run(`
let guard = fn(x: int): string {
  if (x > 0 && x < 10) { "in" } else { "out" }
};
[guard(5), guard(50)]
`))).toBe("[\"in\", \"out\"]");
});

test("Type annotations on let", () => {
expect(show(run(`
let x: int = 5;
let y: int = x + 3;
y
`))).toBe("8");
});

describe("Equality, Exit/Wait effects, inferred-any warning", () => {
  test("== / != require same type (numeric widening lets int ~ float)", () => {
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
      typeOf("let xs = [1, 2, 3]; xs");     // array literal -> [int]   -> silent
    } finally {
      console.warn = orig;
    }
    expect(warned.length).toBe(1);
    expect(warned[0]).toMatch(/`f` inferred as .*\(any\) -> \[any\]/);
  });
});

describe("Tuples, aliases, and field access", () => {
  test("homogeneous literal is still an array", () => {
    expect(typeOf(`[1, 2, 3]`)).toBe("[int]");
  });
  test("heterogeneous literal is a tuple", () => {
    expect(typeOf(`[1, "a", true]`)).toBe("[int, string, bool]");
  });
  test("named tuple via annotation", () => {
    expect(typeOf(`let p: [x: float, y: float] = [1.0, 2.0]; p`)).toBe("[x: float, y: float]");
  });
  test("dot access on a tuple by name", () => {
    expect(show(run(`let p: [x: float, y: float] = [1.0, 2.0]; p.x`))).toBe("1");
  });
  test("dot access on a tuple by index", () => {
    expect(show(run(`let p: [int, string] = [1, "a"]; p.1`))).toBe("\"a\"");
  });
  test("dot access on an array by index", () => {
    expect(show(run(`let xs = [10, 20, 30]; xs.0`))).toBe("10");
  });
  test("destructuring let binds tuple fields", () => {
    expect(show(run(`let p: [int, string] = [1, "a"]; let [n, s] = p; s`))).toBe("\"a\"");
  });
  test("destructuring let on an array", () => {
    expect(show(run(`let xs = [10, 20]; let [a, b] = xs; a + b`))).toBe("30");
  });
  test("parametric type alias instantiates", () => {
    expect(typeOf(`type Pair(a, b) = [a, b]; let p: Pair[int, string] = [1, "a"]; p`)).toBe("[int, string]");
  });
  test("alias used in a function signature", () => {
    expect(typeOf(`type Pair(a, b) = [a, b]; let fst = fn(p: Pair[int, string]): int { p.0 }; fst`)).toBe("([int, string]) -> int");
  });
});

describe("Negative tests (static type checker rejects)", () => {
  function assertTypeError(src: string, needle: string) {
    expect(() => run(src)).toThrow(needle);
  }

  test("Adding a string to an int", () => {
    assertTypeError(`let s: string = "hi"; s + 1`, "int");
  });

  test("Calling a function with the wrong argument type", () => {
    assertTypeError(`let f = fn(n: int): int { n + 1 }; f("x")`, "int");
  });

  test("Heterogeneous array literal is now a tuple", () => {
    expect(typeOf(`[1, "a", true]`)).toBe("[int, string, bool]");
  });

  test("Tuple arity mismatch is rejected", () => {
    assertTypeError(`let p: [int, string] = [1, "a", true];`, "arity");
  });

  test("If branches with mismatched types", () => {
    assertTypeError(`if (1 < 2) { 1 } else { "x" }`, "int");
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
effect Emit(m: int): int;
let ask = fn(n: int): int ! { Emit } { Emit!(n) };
ask
`)).toBe("(int) -> int ! { Emit }");
});

test("Declaring an effect set rejects effects not listed", () => {
  // Body performs Emit but the signature only declares Log.
  expect(() => run(`
effect Emit(m: int): int;
effect Log(m: int): int;
let f = fn(n: int): int ! { Log } { Emit!(n) };
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

test("Float literals and numeric widening", () => {
  expect(typeOf(`2.5`)).toBe("float");
  expect(typeOf(`2`)).toBe("int");
  expect(typeOf(`1 + 2`)).toBe("int");
  expect(typeOf(`1 + 2.5`)).toBe("float");
  expect(typeOf(`1.5 * 2`)).toBe("float");
  expect(typeOf(`2 < 3`)).toBe("bool");
  expect(typeOf(`2.0 < 3`)).toBe("bool");
  expect(typeOf(`2.0`)).toBe("float");
});

test("int flows into a float-typed parameter", () => {
  // step(1) passes an int literal where a float param is expected.
  expect(show(run(`
let f = fn(x: float): float { x + 0.5 };
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

test("+ is overloaded: numeric widening or string concatenation", () => {
  // numeric still works.
  expect(typeOf(`1 + 2`)).toBe("int");
  expect(typeOf(`1 + 2.5`)).toBe("float");
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
});

test("division is type-preserving: int/int -> int, float/float -> float", () => {
  // int/int is truncated; the checker stamps the node so the runtime knows.
  expect(typeOf(`7 / 2`)).toBe("int");
  expect(show(run(`7 / 2`))).toBe("3");
  expect(typeOf(`4 / 2`)).toBe("int");
  expect(show(run(`4 / 2`))).toBe("2");
  // float/float stays exact.
  expect(typeOf(`10.0 / 4.0`)).toBe("float");
  expect(show(run(`10.0 / 4.0`))).toBe("2.5");
  // mixed int/float widens to float (no truncation).
  expect(typeOf(`7 / 2.0`)).toBe("float");
  expect(show(run(`7 / 2.0`))).toBe("3.5");
  // negative int division truncates toward zero (Math.trunc).
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
  expect(show(run(`let f = fn(): int { 1 + 2 };\nf`))).toBe("[fn: () -> int]");
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
  expect(typeOf(`let usePure = fn(): [int] { map(fn(x: int): int { x + 1 }, [1, 2, 3]) };
usePure`)).toBe("() -> [int]");
  // Effectful callback: exactly { Out } propagates, not over-approximated.
  expect(typeOf(`let useEffectful = fn(): [int] { map(fn(x: int): int { Out!("x"); x }, [1, 2, 3]) };
useEffectful`)).toBe("() -> [int] ! { Out }");
  // each with an effectful body callback propagates too.
  expect(typeOf(`let eachOut = fn(): unit { each(fn(x: int, _: int) { Out!("x") }, [1, 2, 3]) };
eachOut`)).toBe("() -> unit ! { Out }");
  // Pure each stays pure.
  expect(typeOf(`let eachPure = fn(): unit { each(fn(x: int, _: int) { unit }, [1, 2, 3]) };
eachPure`)).toBe("() -> unit");
});

test("user-defined polymorphic functions via let-generalization", () => {
  // `apply` is a lambda RHS, so it's generalized: one definition instantiates
  // fresh type vars per call and works at int and string in the same program.
  expect(typeOf(`let apply = fn (f, x) { f(x) };
apply(fn (n: int) { n + 1 }, 41)`)).toBe("int");
  expect(typeOf(`let apply = fn (f, x) { f(x) };
apply(fn (n: int) { "n=" + char(48 + n) }, 7)`)).toBe("string");
  // Both instantiations coexist in one program.
  expect(show(run(`let apply = fn (f, x) { f(x) };
let a = apply(fn (n: int) { n + 1 }, 41);
let b = apply(fn (n: int) { "n=" + char(48 + n) }, 7);
a`))).toBe("42");
  expect(show(run(`let apply = fn (f, x) { f(x) };
let b = apply(fn (n: int) { "n=" + char(48 + n) }, 7);
b`))).toBe("\"n=7\"");
  // Value restriction: a non-lambda RHS is NOT generalized, so a returned
  // function used at two types is a type error (stays monomorphic).
  // (Sanity: a lambda-typed `let` with an explicit annotation is monomorphic.)
  expect(() => run(`let id: (int) -> int = fn (x) { x };
let s = id("hi")`)).toThrow();
});

test("show prints function arity and type, natives stay [fn]", () => {
  expect(show(run(`let add = fn(a: int, b: int): int { a + b };\nadd`))).toBe("[fn: (int, int) -> int]");
  expect(show(run(`let id = fn(x: int): int { x };\nid`))).toBe("[fn: (int) -> int]");
  // Builtins (natives) carry no inferred type here: stay [fn].
  expect(show(run(`head`))).toBe("[fn]");
});

test("nested tuple field access chains (m.0.0)", () => {
  // The lexer reads `0.0` as one float token; the parser splits it so
  // `m.0.0` is two field accesses, not one.
  expect(run(`let m: [[int,int,int],[int,int,int],[int,int,int]] = [[1,2,3],[4,5,6],[7,8,9]]; m.0.0`)).toBe(1);
  expect(run(`let m: [[int,int,int],[int,int,int],[int,int,int]] = [[1,2,3],[4,5,6],[7,8,9]]; m.2.1`)).toBe(8);
});

test("array literal infers as tuple against a tuple-typed context", () => {
  // Return type: a `[x, y, z]` body literal conforms to `[int,int,int]`.
  expect(run(`let f = fn(): [int,int,int] { [1, 2, 3] }; f().1`)).toBe(2);
  // Argument: an `[...]` literal passed to a tuple parameter becomes a tuple.
  expect(run(`let f = fn(p: [int,int,int]): int { p.2 }; f([1,2,3])`)).toBe(3);
  // Nested: `[[...],[...]]` argument against a tuple-of-tuples parameter.
  expect(run(`let f = fn(m: [[int,int,int],[int,int,int]]): int { m.1.0 }; f([[1,2,3],[4,5,6]])`)).toBe(4);
});

test("REPL: bindings persist across lines", () => {
  const out = execSync(
    "bun run cli.ts repl",
    {input: "let a = 6\nlet b = 7\na * b\n:q\n", encoding: "utf8", timeout: 20000},
  );
  expect(out).toContain("42 : int");
});
