import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, unlinkSync, existsSync} from "node:fs";
import {show, run, typeOf} from "./index.ts";

const tmpPath = (n: string) => join(tmpdir(), `ef-test-${process.pid}-${n}.txt`);

test("Nondeterminism — multi-shot resume, declared effect + return type", () => {
expect(show(run(`
effect Choose(opts: [int]): int;
handle {
  let x = perform Choose([1, 2, 3]);
  let y = perform Choose([10, 20]);
  [x, y]
} case Return(v) => k { [v] }
  case Choose(opts) => k { flat(map(k, opts)) }
`))).toBe("[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]");
});

test("Exception — non-resuming handler aborts", () => {
expect(show(run(`
effect Div(a: int, b: int): int;
handle {
  let r = perform Div(10, 0);
  [r]
} case Div(a, b) => k {
  if (b == 0) { ["div by zero"] } else { k(a / b) }
}
`))).toBe('["div by zero"]');
});

test("Deep handler threading a log across resumes", () => {
expect(show(run(`
effect Log(msg: string): unit;
effect Result(v: string): unit;
handle {
  perform Log("a");
  perform Log("b");
  perform Result("42")
} case Log(msg) => k { concat([msg], k(unit)) }
  case Result(v) => k { [v] }
`))).toBe('["a", "b", "42"]');
});

test("Effect propagation through an inner handler to an outer one", () => {
expect(show(run(`
effect Emit(m: string): unit;
effect Other(m: string): unit;
handle {
  handle { perform Emit("hi") } case Other(m) => k { ["should-not-match"] }
} case Emit(m) => k { [m] }
`))).toBe('["hi"]');
});

test("Typed recursive function with annotation", () => {
expect(show(run(`
fn fact(n: int): int {
  if (n == 0) { 1 } else { n * fact(n - 1) }
}
fact(5)
`))).toBe("120");
});

test("Short-circuit && / || and infix arithmetic", () => {
expect(show(run(`
fn guard(x: int): string {
  if (x > 0 && x < 10) { "in" } else { "out" }
}
[guard(5), guard(50)]
`))).toBe('["in", "out"]');
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
    // The handler returns the exit code without resuming, so `perform Exit(42)`
    // yields 42 and the code after it ("post") never runs — proving Exit is an
    // ordinary effect, not a magic builtin that always kills the process.
    expect(show(run(`
handle {
  perform Out("pre");
  perform Exit(42);
  perform Out("post")
} case Exit(c) => k { c }
  case Out(s) => k { perform Println(s); k(unit) }
`))).toBe("42");
  });

  test("Wait is an effect with a pure-looking unit type", () => {
    expect(typeOf("fn f(): unit ! { Wait } { perform Wait(0) }")).toBe("unit");
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

describe("Negative tests (static type checker rejects)", () => {
  function assertTypeError(src: string, needle: string) {
    expect(() => run(src)).toThrow(needle);
  }

  test("Adding a string to an int", () => {
    assertTypeError(`let s: string = "hi"; s + 1`, "int");
  });

  test("Calling a function with the wrong argument type", () => {
    assertTypeError(`fn f(n: int): int { n + 1 } f("x")`, "int");
  });

  test("Heterogeneous array literal", () => {
    assertTypeError(`[1, "a", true]`, "≠");
  });

  test("If branches with mismatched types", () => {
    assertTypeError(`if (1 < 2) { 1 } else { "x" }`, "int");
  });

  test("Using an undeclared effect", () => {
    assertTypeError(`perform Nope(1)`, "Unknown effect");
  });

  test("== / != reject cross-type operands", () => {
    assertTypeError(`"a" == 1`, "≠");
    assertTypeError(`"x" != 1`, "≠");
  });

  test("exit/wait are no longer builtins (use perform Exit/Wait)", () => {
    assertTypeError(`exit(1)`, "Unbound: exit");
    assertTypeError(`wait(1)`, "Unbound: wait");
  });
});

test("Effectful function signature carries its effect set", () => {
  // ask echoes its arg via the Emit effect and returns it; the signature
  // declares `! { Emit }`, which the checker verifies against the body.
  expect(typeOf(`
effect Emit(m: int): int;
fn ask(n: int): int ! { Emit } { perform Emit(n) }
ask
`)).toBe("(int) -> int ! { Emit }");
});

test("Declaring an effect set rejects effects not listed", () => {
  // Body performs Emit but the signature only declares Log.
  expect(() => run(`
effect Emit(m: int): int;
effect Log(m: int): int;
fn f(n: int): int ! { Log } { perform Emit(n) }
f(1)
`)).toThrow("not declared");
});

test("Builtin Read/Write round-trip through real files", () => {
  const p = tmpPath("rw");
  if (existsSync(p)) unlinkSync(p);
  // Write then Read via the builtin default handler (no user handler).
  expect(show(run(`
perform Write(${JSON.stringify(p)}, "hello ef");
perform Read(${JSON.stringify(p)})
`))).toBe('"hello ef"');
  // The file really exists on disk.
  expect(readFileSync(p, "utf8")).toBe("hello ef");
  unlinkSync(p);
});

test("A user handler can intercept builtin Read (effects stay abstract)", () => {
  const p = tmpPath("mock");
  // The handler mocks Read and never touches the filesystem.
  expect(show(run(`
handle {
  perform Read(${JSON.stringify(p)})
} case Return(v) => k { [v] }
  case Read(path) => k { ["mocked"] }
`))).toBe('["mocked"]');
});

test("Builtin effects appear in inferred signatures", () => {
  expect(typeOf(`
fn firstRead(path: string): string ! { Read } { perform Read(path) }
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
fn f(x: float): float { x + 0.5 }
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
  expect(show(run(`char(65)`))).toBe('"A"');
  // char uses code points, not UTF-16 code units: 0x1F600 is a supplementary char.
  expect(show(run(`char(128512)`))).toBe('"\ud83d\ude00"');
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
  expect(show(run(`"\x1B["`))).toBe('"\u001b["');
  expect(show(run(`"a\nb"`))).toBe('"a\nb"');
});

test("Println/Out are interceptable algebraic effects", () => {
  // A handler captures Println's argument instead of letting it print.
  expect(show(run(`
handle {
  perform Println(42);
  perform Println("hi");
  0
} case Return(v) => k { [v] }
  case Println(x) => k { concat([x], k(unit)) }
`))).toBe("[42, \"hi\", 0]");
  // Out is an effect too: collect written strings.
  expect(show(run(`
handle {
  perform Out("a");
  perform Out("b");
  unit
} case Return(v) => k { [] }
  case Out(s) => k { concat([s], k(unit)) }
`))).toBe('["a", "b"]');
});

test("effect annotations are mandatory for effectful fns", () => {
  // Pure body, no annotation: fine.
  expect(show(run(`fn f(): int { 1 + 2 }\nf`))).toBe("[fn: () -> int]");
  // Effectful body, annotation present and covering: fine.
  expect(show(run(`fn g(): unit ! { Out } { perform Out("x") }\ng`))).toBe("[fn: () -> unit ! { Out }]");
  // Effectful body, no annotation: rejected.
  expect(() => run(`fn h(): unit { perform Out("x") }\nh`)).toThrow(/not declared in signature/);
  // Anonymous lambda too: effectful without annotation is rejected.
  expect(() => run(`let k = fn(): unit { perform Out("x") }; k`)).toThrow(/not declared in signature/);
  // Anonymous lambda with annotation: accepted.
  expect(show(run(`let k = fn(): unit ! { Out } { perform Out("x") }; k`))).toBe("[fn: () -> unit ! { Out }]");
});

test("show prints function arity and type, natives stay [fn]", () => {
  expect(show(run(`fn add(a: int, b: int): int { a + b }\nadd`))).toBe("[fn: (int, int) -> int]");
  expect(show(run(`fn id(x: int): int { x }\nid`))).toBe("[fn: (int) -> int]");
  // Builtins (natives) carry no inferred type here: stay [fn].
  expect(show(run(`head`))).toBe("[fn]");
});

test("REPL: bindings persist across lines", () => {
  const { execSync } = require("node:child_process");
  const out = execSync(
    'bun run cli.ts repl',
    { input: 'let a = 6\nlet b = 7\na * b\n:q\n', encoding: "utf8", timeout: 20000 },
  );
  expect(out).toContain("42 : int");
});
