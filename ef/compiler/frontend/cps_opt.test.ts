import {describe, expect, test} from "bun:test";
import {Parser} from "./parser.ts";
import {toCps} from "./cps.ts";
import {run} from "../backend/interpreter/eval.ts";
import {prepare} from "./pipeline.ts";
import type {CAtom, CIr, CTerm} from "./cps_ir.ts";

// toCps applies the cps_opt passes as its final stage: every test here sees
// the optimized term and would catch a pass regression as leftover redex.
const conv = (src: string): CIr => toCps(new Parser(src).parseProgram());

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
    const src = "effect F(): i64;\nx :: 10;\nh :: handle { x + F!() } case F() => k { k(5) };\nh";
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
    const src = "effect F(): i64;\nn := 0;\nh :: handle { while (n < 2) { n = n + F!() } } case F() => k { k(1) } case Return(v) => k { v };\nh; n";
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
  const convC = (src: string): CIr => toCps(prepare(src).prog);

  // A pure callee: the dcall's operand read-temps substitute away like call
  // args, and the direct boundary is a dret tail (never a jump to $ret).
  test("read-temp substitution reaches dcall operands; dret replaces the $ret jump", () => {
    const src = "add1 :: fn(x: i64): i64 { x + 1 };\ndbl :: fn(n: i64): i64 { add1(n) * 2 };\ndbl(20)";
    const ir = convC(src);
    expect(run(src)).toBe(42n);
    // The dcall's fn/args read the source names directly — no read temps.
    expect(countNode(ir, (n) => n.t === "dcall")).toBe(2); // add1(n) + top-level dbl(20)
    const dcalls: (CTerm & {t: "dcall"})[] = [];
    for (const t of terms(ir))
      walk(t, (n) => { if (n.t === "dcall") dcalls.push(n); });
    for (const d of dcalls) {
      expect(d.fn.t === "var" && !d.fn.name.startsWith("$")).toBe(true);
      for (const a of d.args) if (a.t === "var") expect(!a.name.startsWith("$")).toBe(true);
    }
    // Direct boundaries deliver with dret; $ret is never jumped in a direct
    // body (the converter never emits it there).
    expect(countNode(ir, (n) => n.t === "dret")).toBe(2); // add1 + dbl boundaries
    expect(countNode(ir, (n) => n.t === "jump" && n.k.t === "var" && n.k.name === "$ret")).toBe(0);
  });

  test("a dead dcall binding survives (the callee may trap)", () => {
    const src = "add1 :: fn(x: i64): i64 { x + 1 };\nf :: fn(n: i64): i64 { add1(5); n };\nf(1)";
    const ir = convC(src);
    expect(run(src)).toBe(1n);
    expect(countNode(ir, (n) => n.t === "dcall")).toBe(2); // add1(5) kept + f(1)
  });

  test("dcall result frozen across a later suspension in the same body", () => {
    const src = `effect F(n: i64): i64;
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
