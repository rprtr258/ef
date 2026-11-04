// analysis.ts — frontend analysis passes over a parsed program, shared by
// the wasm backend (tree-shaking, dead host-import elimination, op-table
// seeding) and available to interpreter-side consumers (static effect-op
// discovery, env seeding). Nothing here emits bytecode or touches backend
// state: pure AST walks plus the builtin-surface tables both backends agree
// on.
//
// Future interpreter wiring (extraction-only for now):
// - Fail-fast unhandled ops: `exec`/`run` could reject before running when a
//   statically performed op has no matching handler in its subtree, is not a
//   builtin effect, and has no interp override — instead of failing mid-run
//   in runTop after side effects. Needs ops-minus-handled matching per
//   subtree (handle cases shadow same-named performs), not just the flat
//   collectEffectOps list.
// - Env seeding: globalEnv() could take a builtinRefs(prog) set and bind
//   only referenced builtins. The REPL must recompute per line (bindings
//   accumulate, so a later line can reference a previously-unused builtin).
// - CLI: an `ef ops <file>` listing the effects a program may perform.

import type {ExprID, Program} from "./parser.ts";

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
      case "handle":
        return walk(e.body) || e.cases.some(cse => walk(cse.body));
      default:
        return false; // sym/num/str/bool/unit
    }
  };
  return prog.items.some(it => "e" in it && walk(it.e));
}

// Ops the program performs or handles, in first-appearance AST order: a
// perform's op interns before its args, a handler's case ops before its
// body — the same order the wasm op table uses. Includes builtin op names
// (consumers filter already-seeded ones); `Return` is a pseudo-case, never
// an op.
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
      default:
        break; // sym/num/str/bool/unit
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
  type Sc = {names: Set<string>, parent: Sc | null};
  const bound = (sc: Sc, name: string): boolean => {
    for (let s: Sc | null = sc; s !== null; s = s.parent)
      if (s.names.has(name)) return true;
    return false;
  };
  const used = new Set<string>();
  const walk = (id: ExprID, sc: Sc): void => {
    const e = prog.nodes[id];
    switch (e.t) {
      case "sym":
        if (!bound(sc, e.v) && BUILTINS.some(b => b.name === e.v))
          used.add(e.v);
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
      case "app":
        walk(e.fn, sc);
        for (const a of e.args)
          walk(a, sc);
        break;
      case "arr":
        for (const el of e.elems)
          walk(el, sc);
        break;
      case "field":
        walk(e.obj, sc);
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
    }
  };
  const root: Sc = {names: new Set(), parent: null};
  for (const it of prog.items)
    if ("e" in it)
      walk(it.e, root);
  return used;
}
