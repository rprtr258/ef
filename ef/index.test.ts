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
