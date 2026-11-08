// analysis.ts — frontend analysis passes over a parsed program, shared by
// the wasm backend (tree-shaking, dead host-import elimination, op-table
// seeding) and the interpreter (unhandled-op fail-fast, env seeding).
// Nothing here emits bytecode or touches backend state: pure AST walks plus
// the builtin-surface tables both backends agree on.
//
// Interpreter wiring (implemented):
// - Fail-fast unhandled ops: exec (eval.ts) rejects a program before
//   evaluating anything when a statically performed op has no matching
//   handler in its subtree, is not a builtin effect, and has no interp
//   override. The ops-minus-handled matching itself is NOT an AST walk
//   (one cannot see through `f()` performing an op) — it reuses the
//   checker's own bookkeeping: types.ts threads each top-level item's
//   residual effect row into Checked.unhandled, and exec filters it.
// - Env seeding: newCtx seeds an empty env; exec binds exactly
//   builtinRefs(prog) per call — a later REPL line referencing a previously
//   unused builtin gets it seeded on that line, and existing (user)
//   bindings are never overwritten. env.ts's globalEnv/seedBuiltins do the
//   binding.
// - CLI: `ef types <file>` prints the whole program's result type with the
//   residual top-level effect rows (types.ts Checked.unhandled) as its
//   final `_ : T ! { ops }` line — the same set exec's fail-fast
//   check rejects on, so it shows exactly what the runner must interpret
//   (or the run fails on).

import type {ExprID, Program} from "./parser.ts";
import {assertNever} from "./assert.ts";

// Builtin effect op names in op-table order (= builtins.ts table order).
// The wasm op table seeds these at opids 0..n-1; performed/handled program
// ops intern after them. Deliberately a static list: analysis.ts stays a
// leaf module (parser types only) so both backends can import it without
// pulling in the evaluator — analysis.test.ts asserts this stays in sync
// with builtins.ts.
export const EFFECT_OPS: string[] =
  ["Read", "Write", "Println", "Out", "Exit", "Wait", "Random"];

// Every builtin ef programs can name (the interpreter's global env): the
// checker's operators first (resolved structurally, no table entry), then
// the non-effect builtins in builtins.ts table order. `params` is the
// fixed-arity ABI both backends agree on: 0 for the variadic `list`, the
// value `PI`, and 0-arg `args`. analysis.test.ts asserts this stays in sync
// with builtins.ts/env.ts.
export const BUILTINS: {name: string, params: number}[] = [
  {name: "+", params: 2},
  {name: "-", params: 2},
  {name: "*", params: 2},
  {name: "%", params: 2},
  {name: "neg", params: 1},
  {name: "<", params: 2},
  {name: ">", params: 2},
  {name: "<=", params: 2},
  {name: ">=", params: 2},
  {name: "==", params: 2},
  {name: "!=", params: 2},
  {name: "not", params: 1},
  {name: "list", params: 0}, // variadic
  {name: "head", params: 1},
  {name: "tail", params: 1},
  {name: "concat", params: 2},
  {name: "flat", params: 1},
  {name: "len", params: 1},
  {name: "strlen", params: 1},
  {name: "PI", params: 0},
  {name: "cos", params: 1},
  {name: "sin", params: 1},
  {name: "abs", params: 1},
  {name: "round", params: 1},
  {name: "sqrt", params: 1},
  {name: "range", params: 3},
  {name: "char", params: 1},
  {name: "number", params: 1},
  {name: "args", params: 0},
  {name: "get", params: 2},
  {name: "set", params: 3},
  {name: "map", params: 2},
  {name: "each", params: 2},
  {name: "flatmap", params: 2},
];

// Whether any subtree of the program contains a perform node (any op, even
// inside a handler's body or a case body — handlers don't prove
// non-performance). The wasm backend decides the ef_perform import's
// liveness with this.
export function performsAnyOp(prog: Program): boolean {
  const walk = (id: ExprID): boolean => {
    const e = prog.nodes[id];
    switch (e.t) {
      case "perform":
        return true;
      case "lambda":
        return walk(e.body);
      case "block":
        return e.stmts.some(walk);
      case "let":
      case "dlet":
      case "assign":
        return walk(e.val);
      case "if":
        return walk(e.c) || walk(e.a) || walk(e.b);
      case "while":
        return walk(e.c) || walk(e.body);
      case "app":
        return walk(e.fn) || e.args.some(walk);
      case "arr":
        return e.elems.some(walk);
      case "field":
        return walk(e.obj);
      case "as":
        return walk(e.e);
      case "handle":
        return walk(e.body) || e.cases.some(cse => walk(cse.body));
      case "sym":
      case "num":
      case "str":
      case "bool":
      case "unit":
        return false;
      default:
        return assertNever(e);
    }
  };
  return prog.items.some(it => "e" in it && walk(it.e));
}

// Ops the program performs or handles, in first-appearance AST order: a
// perform's op interns before its args, a handler's case ops before its
// body — the same order the wasm op table uses. Includes builtin op names
// (consumers filter already-seeded ones); `Return` is a pseudo-case, never
// an op.
//
// Note this is a SYNTACTIC listing — performs inside a handler that catches
// them still appear. For whole-program semantics (which ops escape to the
// runner), see types.ts's Checked.unhandled, computed by the checker's own
// ops-minus-handled tracking; `ef ops` prints that instead.
export function collectEffectOps(prog: Program): string[] {
  const ops: string[] = [];
  const walk = (id: ExprID): void => {
    const e = prog.nodes[id];
    switch (e.t) {
      case "lambda":
        walk(e.body);
        break;
      case "block":
        for (const stmt of e.stmts)
          walk(stmt);
        break;
      case "let":
      case "dlet":
      case "assign":
        walk(e.val);
        break;
      case "if":
        walk(e.c);
        walk(e.a);
        walk(e.b);
        break;
      case "while":
        walk(e.c);
        walk(e.body);
        break;
      case "app":
        walk(e.fn);
        for (const a of e.args)
          walk(a);
        break;
      case "arr":
        for (const el of e.elems)
          walk(el);
        break;
      case "field":
        walk(e.obj);
        break;
      case "as":
        walk(e.e);
        break;
      case "perform":
        if (!ops.includes(e.op))
          ops.push(e.op);
        for (const a of e.args)
          walk(a);
        break;
      case "handle":
        for (const cse of e.cases)
          if (cse.op !== "Return" && !ops.includes(cse.op))
            ops.push(cse.op);
        walk(e.body);
        for (const cse of e.cases)
          walk(cse.body);
        break;
      case "sym":
      case "num":
      case "str":
      case "bool":
      case "unit":
        break;
      default:
        assertNever(e);
    }
  };
  for (const it of prog.items)
    if ("e" in it)
      walk(it.e);
  return ops;
}

// Every builtin the program references as a value: a bare sym that resolves
// to no user binding and names a BUILTINS entry. Scope handling mirrors the
// checker's binding order (types.ts `let` — the name is in scope in its own
// value, so `let len = len` reads the let's own binding, not the builtin;
// dlet fields bind before their value, mirroring the backend's discovery) —
// a user let shadowing a builtin name keeps that builtin unreferenced. Any
// reference (call site, argument, lambda body) marks it used; user code is
// not dead-code-eliminated here.
export function builtinRefs(prog: Program): Set<string> {
  return classifyBuiltinRefs(prog).refs;
}

// The subset of builtinRefs referenced as VALUES — anywhere except the
// callee position of an app (a callee sym that names a builtin is a direct
// call site, not a value reference). The wasm backend emits $CLO pool
// closures only for these, and operator trampolines only for these (direct
// operator call sites compile the computation inline instead).
export function builtinValueUses(prog: Program): Set<string> {
  return classifyBuiltinRefs(prog).values;
}

function classifyBuiltinRefs(prog: Program): {refs: Set<string>, values: Set<string>} {
  type Sc = {names: Set<string>, parent: Sc | null};
  const bound = (sc: Sc, name: string): boolean => {
    for (let s: Sc | null = sc; s !== null; s = s.parent)
      if (s.names.has(name)) return true;
    return false;
  };
  const used = new Set<string>();
  const values = new Set<string>();
  // inCallee: the sym sits in an app's callee position — a direct call
  // site, not a value reference. Only non-callee positions are value uses.
  const walk = (id: ExprID, sc: Sc, inCallee = false): void => {
    const e = prog.nodes[id];
    switch (e.t) {
      case "sym":
        if (!bound(sc, e.v) && BUILTINS.some(b => b.name === e.v)) {
          used.add(e.v);
          if (!inCallee) values.add(e.v);
        }
        break;
      case "lambda": {
        const s: Sc = {names: new Set(e.params.map(p => p.name)), parent: sc};
        walk(e.body, s);
        break;
      }
      case "block": {
        const s: Sc = {names: new Set(), parent: sc};
        for (const stmt of e.stmts)
          walk(stmt, s);
        break;
      }
      case "let":
        // The binding is already in sc before the value, mirroring emission:
        // `let len = len` reads the slot, not the builtin.
        sc.names.add(e.name);
        walk(e.val, sc);
        break;
      case "dlet":
        for (const fd of e.fields)
          sc.names.add(fd.name);
        walk(e.val, sc);
        break;
      case "assign":
        walk(e.val, sc);
        break;
      case "if":
        walk(e.c, sc);
        walk(e.a, sc);
        walk(e.b, sc);
        break;
      case "while":
        walk(e.c, sc);
        walk(e.body, sc);
        break;
      case "app": {
        // A builtin sym in callee position is a direct call, not a value
        // use; any other callee shape (lambda, app, ...) walks normally.
        const fn = prog.nodes[e.fn];
        if (fn.t === "sym") walk(e.fn, sc, true);
        else walk(e.fn, sc);
        for (const a of e.args)
          walk(a, sc);
        break;
      }
      case "arr":
        for (const el of e.elems)
          walk(el, sc);
        break;
      case "field":
        walk(e.obj, sc);
        break;
      case "as":
        walk(e.e, sc);
        break;
      case "perform":
        for (const a of e.args)
          walk(a, sc);
        break;
      case "handle": {
        walk(e.body, sc);
        // Case bodies run over the handler's hframe scope: case params and
        // the resume binder shadow outer bindings (Return has one param).
        const hs: Sc = {names: new Set(), parent: sc};
        for (const cse of e.cases) {
          if (cse.op === "Return") {
            hs.names.add(cse.params[0].name);
          } else {
            for (const p of cse.params)
              hs.names.add(p.name);
          }
          hs.names.add(cse.resume);
        }
        for (const cse of e.cases)
          walk(cse.body, hs);
        break;
      }
      case "num":
      case "str":
      case "bool":
      case "unit":
        break;
      default:
        assertNever(e);
    }
  };
  const root: Sc = {names: new Set(), parent: null};
  for (const it of prog.items)
    if ("e" in it)
      walk(it.e, root);
  return {refs: used, values};
}
