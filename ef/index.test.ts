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
effect Log(msg: string): null;
effect Result(v: string): null;
handle {
  perform Log("a");
  perform Log("b");
  perform Result("42")
} case Log(msg) => k { concat([msg], k(null)) }
  case Result(v) => k { [v] }
`))).toBe('["a", "b", "42"]');
});

test("Effect propagation through an inner handler to an outer one", () => {
expect(show(run(`
effect Emit(m: string): null;
effect Other(m: string): null;
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
});

test("string escapes: \\xHH and \\n", () => {
  // \x1B (ESC, 27) then "[" — char code of first char is 27.
  expect(show(run(`"\x1B["`))).toBe('"\u001b["');
  expect(show(run(`"a\nb"`))).toBe('"a\nb"');
});
