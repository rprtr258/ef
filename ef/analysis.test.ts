// analysis.ts — frontend passes shared by the wasm backend and (future)
// interpreter consumers. The sync tests below are the contract keeping this
// leaf module's static tables aligned with builtins.ts/env.ts; the behavior
// tests pin the binding order the wasm tree-shake relies on.
import {describe, expect, test} from "bun:test";
import {Parser} from "./parser.ts";
import {globalEnv} from "./env.ts";
import {builtins} from "./builtins.ts";
import {BUILTINS, EFFECT_OPS, builtinRefs, collectEffectOps, performsAnyOp} from "./analysis.ts";

const refs = (src: string) => builtinRefs(new Parser(src).parseProgram());
const ops = (src: string) => collectEffectOps(new Parser(src).parseProgram());
const anyOp = (src: string) => performsAnyOp(new Parser(src).parseProgram());

describe("analysis surface tables", () => {
  test("EFFECT_OPS matches the builtin effect table exactly (order included)", () => {
    expect(EFFECT_OPS).toEqual(builtins.filter(b => b.kind === "effect").map(b => b.name));
  });

  test("BUILTINS names == globalEnv bindings (operators + non-effect builtins)", () => {
    const surface = new Set(BUILTINS.map(b => b.name));
    const env = new Set(globalEnv().vars.keys());
    expect([...surface].sort()).toEqual([...env].sort());
  });

  test("BUILTINS arities spot checks", () => {
    const arity = (name: string) => BUILTINS.find(b => b.name === name)?.params;
    expect(arity("list")).toBe(0); // variadic
    expect(arity("args")).toBe(0);
    expect(arity("PI")).toBe(0);
    expect(arity("neg")).toBe(1);
    expect(arity("range")).toBe(3);
    expect(arity("map")).toBe(2);
  });
});

describe("builtinRefs (tree-shake pass)", () => {
  test("references in call position and as arguments", () => {
    expect(refs("len(map(fn(x) { x }, [1]))")).toEqual(new Set(["len", "map"]));
  });

  test("shadowing at top level keeps the builtin unreferenced", () => {
    expect(refs("let char = fn(x: int): int { x }; char(97)")).toEqual(new Set());
  });

  test("self-recursive let reads its own binding, not the builtin", () => {
    expect(refs("let len = len;")).toEqual(new Set());
  });

  test("block-scoped shadowing (nested lambda bodies as blocks)", () => {
    expect(refs("fn() { let len = 1; len }")).toEqual(new Set());
    expect(refs("let f = fn() { let len = 1; len }; len([1])"))
      .toEqual(new Set(["len"])); // only the outer use reaches the builtin
  });

  test("lambda params shadow", () => {
    expect(refs("fn(len: int): int { len }")).toEqual(new Set());
  });

  test("handler case params and resume binder shadow", () => {
    // The case param `len` shadows the builtin inside the case body; the
    // handle body's `len([1])` is a genuine builtin reference.
    expect(refs("effect Foo(n: int): int; handle { Foo!(len([1])) } case Foo(len) => k { len }"))
      .toEqual(new Set(["len"]));
    expect(refs("effect Foo(n: int): int; handle { Foo!(1) } case Foo(len) => k { len }"))
      .toEqual(new Set());
  });

  test("builtins inside never-called lambdas still count (no user-code DCE)", () => {
    expect(refs("fn() { sqrt(2) }")).toEqual(new Set(["sqrt"]));
  });
});

describe("collectEffectOps (op discovery)", () => {
  test("performed ops in first-appearance order, builtin names included", () => {
    expect(ops("effect A(): int; effect B(): int; A!(); B!(); A!()")).toEqual(["A", "B"]);
    expect(ops("Println!(1)")).toEqual(["Println"]);
  });

  test("a handler's case ops intern before ops in its body", () => {
    expect(ops("effect A(): int; effect B(): int; handle { A!() } case B() => k { 1 }"))
      .toEqual(["B", "A"]);
  });

  test("Return is a pseudo-case, never an op", () => {
    expect(ops("effect A(): int; handle { 7 } case Return(v) => k { v }")).toEqual([]);
  });

  test("ops inside nested lambdas/blocks/conditions are found", () => {
    expect(ops("effect A(): int; fn() { if (true) { while (false) { A!() } } }"))
      .toEqual(["A"]);
  });
});

describe("performsAnyOp (import liveness)", () => {
  test("handler without performs is perform-free", () => {
    expect(anyOp("effect A(): int; handle { 1 } case A() => k { 2 }")).toBe(false);
  });

  test("a perform anywhere (lambda body, call argument, condition) counts", () => {
    expect(anyOp("effect A(): int; fn() { A!() }")).toBe(true);
    expect(anyOp("effect A(): int; len([A!()])")).toBe(true);
    expect(anyOp("effect A(): int; if (A!() == 1) { 2 } else { 3 }")).toBe(true);
    expect(anyOp("effect A(): int; handle { 1 } case A() => k { 2 } case Return(v) => k { v }"))
      .toBe(false);
  });
});

describe("module init order", () => {
  // The eval⇄builtins import cycle is runtime-only on both sides (`apply`
  // is called from builtin closures; eval builds the effect interps lazily
  // on first unhandled effect), so every module must initialize cleanly
  // regardless of entry point. Regression guard: these entries used to TDZ
  // when eval.ts's builtinInterps was a top-level initializer.
  for (const entry of ["builtins.ts", "env.ts", "parser.ts", "types.ts", "eval.ts", "lint.ts"])
    test(`${entry} as entry point`, () => {
      const p = Bun.spawnSync(
        [process.execPath, "-e", `import './${entry}'; console.log("ok")`],
        {cwd: import.meta.dir});
      expect(p.exitCode).toBe(0);
    });
});
