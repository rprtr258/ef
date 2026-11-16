import {describe, expect, test} from "bun:test";
import {parseProgram} from "./parser.ts";
import {toCps} from "./cps.ts";
import {runLine, newCtx} from "../backend/interpreter/eval.ts";
import {prepare} from "./pipeline.ts";
import {type Value} from "../env.ts";
import type {CAtom, CIr, CTerm} from "./cps_ir.ts";

// The suite's value harness: runLine through a fresh ctx, unwrapped to the
// value. run() itself is the unit-gated file-entrypoint seam (pipeline.ts's
// requireUnitEntry); these tests assert values, so they go through the
// ungated REPL line protocol.
const run = (src: string): Value => runLine(newCtx(), src).value;

// toCps applies the cps_opt passes as its final stage: every test here sees
// the optimized term and would catch a pass regression as leftover redex.
const conv = (src: string): CIr => toCps(parseProgram(src));

function walk(t: CTerm, f: (t: CTerm) => void): void {
  f(t);
  switch (t.t) {
    case "letk": walk(t.body, f); walk(t.rest, f); return;
    case "let": case "bind": case "mkfn": case "dlet": case "assign": case "scope":
      walk(t.rest, f); return;
    case "dcall": walk(t.rest, f); return;
    case "if": walk(t.a, f); walk(t.b, f); return;
    case "handle": walk(t.body, f); for (const c of t.cases) walk(c.body, f); return;
    default: return;
  }
}

function terms(ir: CIr): CTerm[] {
  return [ir.term, ...ir.funcs.map(fn => fn.body)];
}

function countNode(ir: CIr, pred: (t: CTerm) => boolean): number {
  let n = 0;
  for (const t of terms(ir)) walk(t, (x) => { if (pred(x)) n++; });
  return n;
}

// Binds whose value reads `name` (the converter's read-temp shape).
const bindsReading = (ir: CIr, name: string): number =>
  countNode(ir, (t) => t.t === "bind" && t.val.t === "var" && t.val.name === name);

const freezeNames = (ir: CIr): Set<string> => {
  const s = new Set<string>();
  for (const t of terms(ir))
    walk(t, (n) => {
      if (n.t === "letk" && n.freeze !== undefined)
        for (const fr of n.freeze) s.add(fr.name);
    });
  return s;
};

// References to `name` anywhere in the subtree: value atoms, continuation
// operands, freeze entry names and vals.
const refsIn = (root: CTerm, name: string): number => {
  let n = 0;
  const atom = (a: CAtom): void => { if (a.t === "var" && a.name === name) n++; };
  const rec = (t: CTerm): void => {
    if (t.t === "letk" && t.freeze !== undefined) {
      for (const fr of t.freeze) {
        if (fr.name === name) n++;
        atom(fr.val);
      }
    }
    switch (t.t) {
      case "bind": case "dlet": case "assign": atom(t.val); break;
      case "let": {
        const p = t.rhs;
        if (p.t === "op" || p.t === "arr") for (const a of p.args) atom(a);
        else if (p.t === "as") atom(p.arg);
        else atom(p.obj);
        break;
      }
      case "call": atom(t.fn); for (const a of t.args) atom(a); atom(t.k); break;
      case "perform": for (const a of t.args) atom(a); atom(t.k); break;
      case "jump": atom(t.k); atom(t.arg); break;
      case "halt": atom(t.v); break;
      case "if": atom(t.c); break;
      case "handle": atom(t.k); break;
      default: break;
    }
    if (t.t === "letk") { rec(t.body); rec(t.rest); }
    else if ("rest" in t) rec(t.rest);
    if (t.t === "if") { rec(t.a); rec(t.b); }
    if (t.t === "handle") { rec(t.body); for (const c of t.cases) rec(c.body); }
  };
  rec(root);
  return n;
};

// Jumps to `name` in the subtree.
const jumpsTo = (root: CTerm, name: string): number => {
  let n = 0;
  walk(root, (t) => {
    if (t.t === "jump" && t.k.t === "var" && t.k.name === name) n++;
  });
  return n;
};

// letks that still match the exit-beta pattern: nothing should survive
// toCps in a state the pass would reduce.
const betaRemovable = (ir: CIr): number => {
  let n = 0;
  for (const t of terms(ir))
    walk(t, (node) => {
      if (node.t !== "letk" || node.norm !== undefined) return;
      if (refsIn(node.body, node.name) !== 0 || refsIn(node.rest, node.name) !== 1) return;
      if (jumpsTo(node.rest, node.name) !== 1) return;
      n++;
    });
  return n;
};

describe("cps_opt via toCps: read-temp substitution", () => {
  test("drops never-assigned var reads", () => {
    const ir = conv("x :: 1; y :: x + 2; y");
    expect(bindsReading(ir, "x")).toBe(0);
    expect(bindsReading(ir, "y")).toBe(0);
    expect(run("x :: 1; y :: x + 2; y")).toBe(3n);
  });

  test("keeps temps of assigned vars", () => {
    const src = "x := 1; y :: x + 2; x = 3; y";
    expect(bindsReading(conv(src), "x")).toBeGreaterThan(0);
    expect(run(src)).toBe(3n);
  });

  test("frozen read temps snapshot the source var across a resume", () => {
    const src = "F :: effect(): i64;\nx :: 10;\nh :: handle { x + F!() } case F() => k { k(5) };\nh";
    const ir = conv(src);
    // the read of x crosses the perform suspension: the freeze list names x
    // itself now, and the resume restores x's slot with its snapshot
    expect(freezeNames(ir).has("x")).toBe(true);
    expect(run(src)).toBe(15n);
  });

  test("an unchecked @as converts as a pure pass-through", () => {
    // toCps without a prior checkProgram sees no numKind stamp and no
    // asKind, so the @as prim is skipped — the operand flows straight on.
    const ir = conv("@as(1, i64)");
    expect(JSON.stringify(terms(ir)).includes("\"t\":\"as\"")).toBe(false);
  });

  test("closure-delivered temps resolve to the mkfn slot", () => {
    const src = "f :: fn(n: i64): i64 { n * 2 };\ng :: f;\ng(21)";
    const ir = conv(src);
    // the read temp of f is gone; g's own source bind (g := f) stays
    expect(countNode(ir, (n) => n.t === "bind" && n.name.startsWith("$")
        && n.val.t === "var" && n.val.name === "f")).toBe(0);
    expect(run(src)).toBe(42n);
  });
});

describe("cps_opt via toCps: prim-let fusion", () => {
  test("binds the source name directly", () => {
    const src = "u :: [1, 2]; v :: u.0; v";
    const ir = conv(src);
    expect(countNode(ir, (n) => n.t === "let" && n.name === "u")).toBe(1);
    expect(countNode(ir, (n) => n.t === "let" && n.name === "v")).toBe(1);
    expect(countNode(ir, (n) => n.t === "bind" && n.name === "v")).toBe(0);
    expect(run(src)).toBe(1n);
  });
});

describe("cps_opt via toCps: exit-continuation beta", () => {
  test("removes the while loop's exit letk", () => {
    const src = "i := 0; while (i < 3) { i = i + 1 }; i";
    expect(betaRemovable(conv(src))).toBe(0);
    expect(run(src)).toBe(3n);
  });

  test("resume still drives a loop with a reduced exit", () => {
    const src = "F :: effect(): i64;\nn := 0;\nh :: handle { while (n < 2) { n = n + F!() } } case F() => k { k(1) } case Return(v) => k { v };\nh; n";
    expect(run(src)).toBe(2n);
  });

  test("call continuations are never beta-reduced", () => {
    const src = "f :: fn(n: i64): i64 { n + 1 };\nf(1) + f(2)";
    const ir = conv(src);
    // call/perform sites need resolvable named continuations
    expect(countNode(ir, (n) => n.t === "letk")).toBeGreaterThan(0);
    expect(run(src)).toBe(5n);
  });
});

describe("cps_opt via toCps: dead binding drop", () => {
  test("drops dead read temps and throw-free prims, keeps trapping ones", () => {
    const deadRead = conv("x := 1; x; 7");
    expect(bindsReading(deadRead, "x")).toBe(0);
    expect(run("x := 1; x; 7")).toBe(7n);

    expect(countNode(conv("[1, 2]; 7"), (n) => n.t === "let")).toBe(0);
    expect(run("[1, 2]; 7")).toBe(7n);

    // a discarded field access may throw out-of-bounds: the prim survives
    const kept = conv("u :: [1]; u.0; 7");
    expect(countNode(kept, (n) => n.t === "let" && n.rhs.t === "field")).toBe(1);
    expect(run("u :: [1]; u.0; 7")).toBe(7n);
    expect(() => run("u :: [1]; u.5; 7")).toThrow(/out of bounds/);
  });
});

describe("cps_opt via toCps: dcall/dret through the rewrites", () => {
  // Suspension stamps are checker-stamped: conversion sees them only after
  // the check (prepare).
  const convC = (src: string): CIr => {
    const {prog, checked} = prepare(src);
    return toCps(prog, checked.stamps);
  };

  // A pure callee: the dcall's operand read-temps substitute away like call
  // args, and the direct boundary is a dret tail (never a jump to $ret).
  // `sum` is deliberately outside every inlining rule (multi-use, loop body
  // over SMALL_BODY) so its dcall sites survive the pipeline.
  test("read-temp substitution reaches dcall operands; dret replaces the $ret jump", () => {
    const src = `sum :: fn(n: i64): i64 {
  acc := 0; i := 0;
  while (i < n) { acc = acc + i; i = i + 1 };
  acc
};
(fn(n: i64): i64 { sum(n) * 2 })(20) + sum(3)`;
    const ir = convC(src);
    expect(run(src)).toBe(383n); // 190*2 + 6
    // The dcall's fn/args read the source names directly — no read temps.
    expect(countNode(ir, (n) => n.t === "dcall")).toBe(2); // the two sum sites
    const dcalls: (CTerm & {t: "dcall"})[] = [];
    for (const t of terms(ir))
      walk(t, (n) => { if (n.t === "dcall") dcalls.push(n); });
    for (const d of dcalls) {
      expect(d.fn.t === "var" && !d.fn.name.startsWith("$")).toBe(true);
      // Splice rebinds ($il, from cps_inline.ts) legitimately read as args;
      // converter read temps ($t) must all have substituted away.
      for (const a of d.args) if (a.t === "var") expect(!a.name.startsWith("$t")).toBe(true);
    }
    // Direct boundaries deliver with dret; $ret is never jumped in a direct
    // body (the converter never emits it there).
    expect(countNode(ir, (n) => n.t === "dret")).toBe(1); // sum's boundary
    expect(countNode(ir, (n) => n.t === "jump" && n.k.t === "var" && n.k.name === "$ret")).toBe(0);
  });

  test("a dead dcall binding survives (the callee may trap)", () => {
    // `get` is a builtin — no provenance, so its dcall site stays; the
    // discarded result binding survives (dcall results are not bind nodes).
    // An IIFE callee leaves no closure object behind once inlined.
    const src = "(fn(n: i64): i64 { get([1, 2], n); n })(1)";
    const ir = convC(src);
    expect(run(src)).toBe(1n);
    expect(countNode(ir, (n) => n.t === "dcall")).toBe(1); // the get site (f(1) inlined)
  });

  test("dcall result frozen across a later suspension in the same body", () => {
    const src = `F :: effect(n: i64): i64;
add1 :: fn(x: i64): i64 { x + 1 };
f :: fn(a: i64): i64 { add1(1) + add1(F!(a)) };
h :: handle { f(10) } case F(n) => k { k(n) } case Return(v) => k { v };
h`;
    const ir = convC(src);
    // add1(1)'s result temp crosses the perform: frozen at the letk.
    expect(freezeNames(ir).size).toBeGreaterThan(0);
    expect(run(src)).toBe(13n); // add1(1)=2 + add1(resume 10)=11
  });
});

describe("cps_opt via toCps: cross-function inlining", () => {
  // Suspension stamps are checker-stamped: conversion sees them only after
  // the check (prepare).
  const convC = (src: string): CIr => {
    const {prog, checked} = prepare(src);
    return toCps(prog, checked.stamps);
  };
  const totalNodes = (ir: CIr): number =>
    terms(ir).reduce((n, t) => n + termSize(t), 0);
  const termSize = (t: CTerm): number => {
    let n = 1;
    walk(t, () => { n++; });
    return n;
  };

  test("single-use closure inlines, closure object stays bound", () => {
    const src = "add1 :: fn(x: i64): i64 { x + 1 };\nadd1(41)";
    const ir = convC(src);
    expect(run(src)).toBe(42n);
    // The call site spliced away (no dcall left); the closure object stays
    // referenced by its source bind — top-level binds never drop (the REPL
    // frame keeps them), so the dead-mkfn drop only fires for closure
    // temps read nowhere else (e.g. IIFEs — see the next test).
    expect(countNode(ir, (n) => n.t === "dcall")).toBe(0);
    expect(countNode(ir, (n) => n.t === "mkfn")).toBe(1);
  });

  test("IIFE inlines and the closure object disappears", () => {
    const src = "(fn(x: i64): i64 { x + 1 })(41)";
    const ir = convC(src);
    expect(run(src)).toBe(42n);
    expect(countNode(ir, (n) => n.t === "mkfn")).toBe(0);
    expect(ir.funcs.length).toBe(0);
  });

  test("multi-use small body inlines at every site, closure stays", () => {
    const src = "add1 :: fn(x: i64): i64 { x + 1 };\nadd1(1) + add1(2)";
    const ir = convC(src);
    expect(run(src)).toBe(5n);
    // Both call sites spliced (no call to the closure left); the closure
    // value itself stays referenced by its source bind.
    expect(countNode(ir, (n) => n.t === "mkfn")).toBe(1);
    expect(countNode(ir, (n) => n.t === "call" || n.t === "dcall")).toBe(0);
  });

  test("big multi-use body stays a call", () => {
    const src = `sum :: fn(n: i64): i64 {
  acc := 0; i := 0;
  while (i < n) { acc = acc + i; i = i + 1 };
  acc
};
sum(3) + sum(4)`;
    const ir = convC(src);
    expect(run(src)).toBe(9n); // 3 + 6
    expect(countNode(ir, (n) => n.t === "dcall")).toBe(2); // both sites kept
  });

  test("recursive small body unrolls bounded, stays correct", () => {
    const src = `fib :: fn(n: i64): i64 { if (n < 2) { n } else { fib(n - 1) + fib(n - 2) } };
fib(15)`;
    const ir = convC(src);
    expect(run(src)).toBe(610n);
    // MAX_DEPTH bounds the unrolling: the term stays small even though the
    // body is small enough to inline.
    expect(totalNodes(ir)).toBeLessThan(500);
  });

  test("splice into a closure body recomputes capts", () => {
    // adder's body splices into outer's loop body; the spliced read of g
    // (a top-level var) must land in outer's capts for both backends.
    // outer is multi-use and bigger than SMALL_BODY so it stays a closure.
    const src = `g := 5;
adder :: fn(x: i64): i64 { g + x };
outer :: fn(n: i64): i64 {
  acc := 0; i := 0;
  while (i < n) { acc = acc + adder(i); i = i + 1 };
  acc
};
outer(3) + outer(2) + adder(9)`;
    expect(run(src)).toBe(43n); // (5+6+7) + (5+6) + 14
  });

  test("spliced capt survives closure escape", () => {
    // adder splices into thunk's body; thunk escapes outer, so the
    // captured g slot must be captured by thunk's closure.
    const src = `g := 5;
adder :: fn(x: i64): i64 { g + x };
outer :: fn(): () -> i64 {
  acc := 0;
  while (acc < 3) { acc = acc + 1 };
  thunk :: fn(): i64 { adder(acc) };
  thunk
};
outer()()`;
    expect(run(src)).toBe(8n); // g + 3
  });

  test("callee with a nested closure clones the inner CFn", () => {
    // wrap's body creates a closure over its param; inlining wrap at its
    // single site must clone that closure (fresh fun), not share it.
    const src = `apply :: fn(f: () -> i64): i64 { f() };
wrap :: fn(n: i64): () -> i64 { fn() { n } };
apply(wrap(40)) + 2`;
    expect(run(src)).toBe(42n);
  });

  test("callee assigning its own param stays correct", () => {
    const src = "bump :: fn(x: i64): i64 { x = x + 1; x };\nbump(41) + bump(0)";
    expect(run(src)).toBe(43n);
  });

  test("non-direct callee performing through the splice keeps effect order", () => {
    const src = `F :: effect(n: i64): i64;
twice :: fn(n: i64): i64 { F!(n) + F!(n) };
h :: handle { twice(1) } case F(n) => k { k(n * 10) } case Return(v) => k { v };
h`;
    expect(run(src)).toBe(20n); // resume 10 twice, summed
  });
});
