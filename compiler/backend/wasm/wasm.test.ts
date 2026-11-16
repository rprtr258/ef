import {test, expect, describe} from "bun:test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import binaryen from "binaryen";
import {runLine, newCtx} from "../interpreter/eval.ts";
import {BIN_FEATURES, compile as compilePrepared, compileWithOps as compileWithOpsPrepared} from "./wasm.ts";
import {prepare, type EffectInterp} from "../../frontend/pipeline.ts";
import {discover, optimize, assignIndices, layoutStatics} from "./wasm_pipeline.ts";
import {toCps} from "../../frontend/cps.ts";
import {planIr, classifySlots, type TLevel, letkP, scopeP, dcallP} from "./wasm_plan.ts";
import {runModule} from "./wasm_run.ts";
import {mkSlice, mkTup, show, type Value} from "../../env.ts";

// The suite's value harness: runLine through a fresh ctx, unwrapped to the
// value. run() itself is the unit-gated file-entrypoint seam (pipeline.ts's
// requireUnitEntry); these tests assert values, so they go through the
// ungated REPL line protocol.
const run = (src: string, interp?: EffectInterp): Value => runLine(newCtx(interp), src).value;

// The suite's runners: prepare + the artifact-in compile seams — compile /
// compileWithOps consume pipeline.ts's Prepared {prog, checked} so
// gate-holding callers (runWasm, `ef wasm`) prepare once; these tests have
// no gate, so the wrappers exist to keep call sites src-shaped.
const compile = (src: string) => compilePrepared(prepare(src));

// runWasm mirrors wasm_host.ts's runWasm minus the unit gate: these tests
// exercise host behavior (boxing, effect delivery, the static gate) over
// value-returning programs.
const runWasm = (src: string, interp?: EffectInterp, args?: string[]): Value => {
  const {bytes, ops} = compileWithOpsPrepared(prepare(src), interp);
  return runModule(bytes, ops, interp, args);
};

// binaryen's typings lag its runtime (see wasm.ts RawBinaryen): readBinary's features argument is untyped in the .d.ts.
const bin = binaryen as typeof binaryen & {
  readBinary(bytes: Uint8Array, features: number): ReturnType<typeof binaryen.wrapModule>,
};

const workspaceDir = import.meta.dir;

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
    // The check stamps the runtime markers discover reads (Checked.stamps).
    const {prog, checked} = prepare("x :: 1;\ns :: \"a\";\npi :: PI;\nl :: len;\nx;");
    const ir = toCps(prog, checked.stamps);
    const d = discover(ir, prog);
    const o = optimize(prog, checked.stamps);
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
    const dir = join(workspaceDir, "..", "..", "..", "examples");
    for (const bin of readdirSync(dir)
      .filter(file => file.endsWith(".ef"))
      .map(file => join(dir, file))
      .map(f => readFileSync(f).toString())
      .map(compile)) 
      assertModule(bin);
  }, 90000);

test("arithmetic on non-numbers traps via ref.cast (frozen documented deviation)", () => {
    // Known deviation (wasm.ts): the checker rejects statically-ill-typed
    // arithmetic, but a
    // dynamically non-number operand (e.g. through `any`) traps at the
    // wasm ref.cast instead of throwing a host-side ef error — the GC
    // plane's frozen deviation from the interpreter's TypeError.
    expect(() => runWasm("(fn(x: any): any { x * 1 })(\"s\")")).toThrow(); // "*" is always numeric: slotF64 traps on the cast
  });

test("builtin shadowing is rejected before codegen", () => {
    // No shadowing: a user binding can never take a builtin's name, so
    // tree-shaking never sees an occluded builtin. compile()'s check
    // rejects these before any module is emitted.
    expect(() => compile("len :: fn(xs: [i64]): i64 { 42 }; len([1, 2, 3])"))
      .toThrow("cannot shadow builtin 'len'");
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
    // The `ef wasm` entry has no runner: the static gate rejects the same
    // ops `ef run` rejects, before a module is emitted.
    expect(() => compile("Foo :: effect(n: i64): i64; Foo!(1) + 2")).toThrow("Unhandled effect: Foo");
    // One-shot interp injection overrides the default interpretation — an
    // op the interp covers passes the gate and runs.
    // i64 args unbox to BigInt at the host boundary.
    expect(show(runWasm("Foo :: effect(n: i64): i64; Foo!(21) * 2", {Foo: (args, k) => k(Number(args[0]) + 1)}))).toBe("44");
  });

test("static gate rejects before any side effect (same timing as exec)", () => {
    // Mirror of the eval-side test (index.test.ts): a Println before the
    // unhandled op must not run — rejectUnhandled fires at the pipeline
    // entry, before evaluation or codegen.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      expect(() => runWasm(`T :: effect(x: i64): i64; Println!("boom"); T!(1)`))
        .toThrow("Unhandled effect: T");
    } finally {
      console.log = orig;
    }
    expect(logs).toEqual([]); // Println never ran: rejection precedes evaluation
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
  test("handle as an operator operand compiles to a valid module", () => {
    const src = "Op :: effect(): i64; 1 + handle { Op!() } case Op() => k { 7 }";
    assertModule(compile(src));
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
    expect(importsOf("Op :: effect(): i64; handle { Op!() } case Op() => k { 7 }"))
      .toContain("ef_perform");
  });

  test("live served builtins keep their imports", () => {
    expect(importsOf("char(97)")).toContain("ef_char");
    expect(importsOf("round(cos(0) * 100)")).toContain("ef_cos");
    expect(importsOf("args()")).toContain("ef_args");
  });

  test("ef_args reports the runModule args, not raw process.argv", () => {
    // The host import is seeded with the program args the runner passes —
    // everything after the source path on the CLI, [] when omitted — never
    // the raw argv (subcommand + source path would pollute it).
    expect(show(runWasm("args()", undefined, ["a", "b c"]))).toBe("[\"a\", \"b c\"]");
    expect(show(runWasm("args()"))).toBe("[]");
  });

  test("shadowing a served builtin is rejected before codegen", () => {
    const src = "char :: fn(x: i64): i64 { x }; char(97)";
    expect(() => importsOf(src)).toThrow("cannot shadow builtin 'char'");
  });

  test("a program using everything keeps all 7 imports in original order", () => {
    const src = "x :: round(cos(0) * 10) + round(sin(0) * 10) + strlen(char(97)) + number(\"2\") + len(args()); Println!(x); x";
    expect(importsOf(src).toSorted()).toEqual(["ef_args", "ef_char", "ef_cos", "ef_fail", "ef_number", "ef_perform", "ef_sin"]);
  });
});

describe("wasm binaryen shrink pass (optimizeBinary)", () => {
  test("keeps host ABI exports/imports after the shrink pass", () => {
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
  });

  test("output is deterministic", () => {
    expect(Buffer.from(compile("len(range(1, 10, 1))")).equals(Buffer.from(compile("len(range(1, 10, 1))")))).toBe(true);
  });
});
// --- split re-emission ------------------------------------------------------
// After-if fragments always exist and fill exactly once per site, and
// arm-internal fragments root at the arm, not the body root.
describe("split re-emission regressions", () => {
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
    const {prog, checked} = prepare(src);
    const ir = toCps(prog, checked.stamps);
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
    const src = `Op :: effect(): i64;
mixed :: fn(x: i64): i64 { handle { x + Op!() } case Op() => k2 { k2(100) } };
caller :: fn(x: i64): i64 { mixed(x) + 1 };
[caller(1), caller(2)]`;
    const {prog, checked} = prepare(src);
    const ir = toCps(prog, checked.stamps);
    const plan = planIr(ir);
    expect(plan.cfnPure[0]).toBe(false); // mixed: internal handle
    expect(plan.cfnPure[1]).toBe(false); // caller: dcall to an impure fn
  });

  test("any-callee impure chain: stays on the generic path (known pre-existing wasm divergence)", () => {
    // h is direct-classified but impure through the any hole (g's body has a
    // generic call whose callee performs at runtime). The fixpoint keeps h
    // and every gate off this chain; the wasm op-discovery miss behind the
    // any-call is a pre-existing known limitation (see plan Non-goals) —
    // Inlining now routes the any-callee chain's handler reach correctly:
    // both backends agree on 43 (the op reaches the handler through the
    // inlined g body).
    const src = `Op :: effect(): i64;
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
    expect(wasm).toBe("43"); // wasm agrees with the interpreter
  });
});
describe("wasm numeric entry ABI (wasm_devirt.ts numericEntries: unboxed direct calls, shape-tag dispatch)", () => {
  test("escaping numeric fn called generically rides the shape tag", () => {
    // A static site first (the plan's entry criterion: ≥1 devirt site with a
    // matching numeric signature), then the same closure escapes through an
    // apply-typed value slot: the generic site's stamps shape-match the
    // entry, so the runtime tag check dispatches the raw entry; a
    // mismatching closure would fail the tag and take the boxed path (same
    // values either way).
    const src = `apply :: fn(f: (i64) -> i64, x: i64): i64 { f(x) };
inc :: fn(n: i64): i64 { acc := 0; i := 0; while (i < n) { acc = acc + 1; i = i + 1 }; acc };
dec :: fn(n: i64): i64 { acc := 0; i := 0; while (i < n) { acc = acc - 1; i = i + 1 }; acc };
a :: inc(41);
apply(inc, 1) + apply(dec, 2) + a`;
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

});
describe("wasm typed slots + scope-frame elision (wasm_plan.ts classifySlots + wasm_term.ts emission)", () => {
  // A planned level as the audit sees it: slot map, surviving typed map,
  // elision flag.
  type Lv = {slots: Map<string, number>, typed?: Map<string, string>, elided?: boolean};

  // Every TLevel planIr creates for `src`: scope nodes carry their level
  // directly; letk/dcall annotations carry fnLvl plus the entry/rest scope
  // snapshots (shared level objects, so the Set dedups).
  const audit = (src: string): Lv[] => {
    const {prog, checked} = prepare(src);
    const ir = toCps(prog, checked.stamps);
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
    const src = `Op :: effect(): i64;
s := 0;
handle { while (s < 3) { s = s + Op!() }; s } case Op() => k { k(3) }`;
    const levels = audit(src);
    expect(levels.some(l => l.elided === true && l.slots.size > 0 && l.typed?.size === l.slots.size)).toBe(true);
  });

  test("multi-shot rest-thunk read after resume: the read is cross-fn, the slot stays boxed", () => {
    const src = `Op :: effect(): i64;
x: i64 : 10;
handle { Op!() } case Op() => k { k(1); k(2) } + x`;
    assertUntyped(audit(src), "x");
  });

  test("escaping-closure capture: the captured slot stays boxed (env path)", () => {
    const src = `mk :: fn() { x: i64 : 7; fn() { x } };
mk()()`;
    assertUntyped(audit(src), "x");
  });

  test("case-fn depth>0 read: cross-fn reach keeps the site slot boxed", () => {
    const src = `Op :: effect(): i64;
y: i64 : 5;
handle { y + Op!() } case Op() => k { k(y + 1) }`;
    assertUntyped(audit(src), "y");
  });

  test("top-level captured assign: cross-fn writes poison candidacy, env path sees them", () => {
    const src = `acc := 0;
bump :: fn(v: i64): i64 { acc = acc + v; acc };
[bump(1), bump(2), acc]`;
    assertUntyped(audit(src), "acc");
  });

  test("f32 slots type and round at every producing node (fround parity)", () => {
    const src = `a: f32 : 0.1;
b: f32 : 0.2;
a + b == @as(0.3, f32)`;
    const levels = audit(src);
    // The literal binds survived classification as f32 typed slots.
    expect(levels.some(l => [...(l.typed?.values() ?? [])].includes("f32"))).toBe(true);
  });

  test("numeric entry over typed joins: the dcall result lands typed at the site", () => {
    const src = `add3 :: fn(a: i32, b: i32, c: i32): i32 { a + b + c };
add3(1, 2, 3)`;
    const levels = audit(src);
    expect(levels.some(l => [...(l.typed?.values() ?? [])].includes("i32"))).toBe(true);
  });
});

describe("wasm host boundary (wasm_host.ts)", () => {
  test("value crossings box/unbox through every host branch", () => {
    for (const [src, expected, interp] of [
      // Custom interps returning tuples/slices exercise the tup and arr box
      // branches; the results unbox back through the matching arms.
      ["Make :: effect(): [i64, i64]; f :: fn(): i64 { t: [i64, i64] : Make!(); t.0 + t.1 }; f()", "3", {Make: (_args, k) => k(mkTup([1, 2]))}],
      ["Roll :: effect(): [i64]; Roll!()", "[5, 6]", {Roll: (_args, k) => k(mkSlice([5, 6]))}],
      // The typed slot forces the $U32 box; a bare @as at top level rides
      // the unstamped pass-through and crosses as an f64 num box instead.
      ["u: u32 : 4000000000; u", "4000000000", undefined],
      ["\"hi there\"", "\"hi there\"", undefined],
      ["id :: fn(x: i64): i64 { x }; id", "[fn]", undefined],
    ] as [string, string, EffectInterp | undefined][]) {
      expect(show(runWasm(src, interp))).toBe(expected);
    }
  });

  test("unboxable interp results are rejected with the box error", () => {
    expect(() => runWasm("Foo :: effect(n: i64): i64; Foo!(1)", {Foo: (_args, k) => k({tag: "fn"} as Value)}))
    .toThrow(/cannot box value \[fn\]/);
  });

});
