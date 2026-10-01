import {res, showT, type FunT} from "./types.ts";
import type {Expr, ExprID} from "./parser.ts";
import {apply} from "./eval.ts";

// --- Values (runtime) ---
export type Closure = {
  tag: "fn",
  params: string[],
  body: ExprID,
  // The flat node slice the body's ExprIDs index into; closures carry their
  // own arena so they stay valid across REPL lines and separate programs.
  nodes: Expr[],
  env: Env,
  typ?: FunT,
};

export type Native = {
  tag: "native",
  fn: (args: Value[], k: Cont) => Outcome,
};

export type Value =
  | null
  | number
  | string
  | boolean
  | Value[]
  | Closure
  | Native;

function lift(fn: (...a: Value[]) => Value): Native {
  return {tag: "native", fn: (args, k) => k(fn(...args))};
}

export function num(v: Value): number {
  if (typeof v !== "number")
    throw new Error("Expected number, got " + show(v));
  return v;
}

export function show(v: Value): string {
  if (v === null) return "unit";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return "\"" + v + "\"";
  if (Array.isArray(v))
    return "[" + v.map(show).join(", ") + "]";
  if (typeof v === "object" && !Array.isArray(v) && v.tag === "fn")
    return v.typ !== undefined ? "[fn: " + showT(res(v.typ)) + "]" : "[fn]";
  return "[fn]";
}

export type Outcome =
  | { tag: "done", value: Value }
  | { tag: "eff", op: string, args: Value[], k: Cont };

export type Cont = (v: Value) => Outcome;

export class Env {
  vars = new Map<string, Value>();
  constructor(public parent: Env | null) {}
  lookup(name: string): Value {
    if (this.vars.has(name))
      return this.vars.get(name) as Value;
    let e = this.parent;
    while (e !== null) {
      if (e.vars.has(name))
        return e.vars.get(name) as Value;
      e = e.parent;
    }
    throw new Error("Unbound symbol: " + name);
  }
  // Assign to the nearest enclosing scope that already binds `name`.
  assignVar(name: string, v: Value): void {
    if (this.vars.has(name)) {
      this.vars.set(name, v);
      return;
    }
    let e = this.parent;
    while (e !== null) {
      if (e.vars.has(name)) {
        e.vars.set(name, v);
        return;
      }
      e = e.parent;
    }
    throw new Error("Assignment to unbound symbol: " + name);
  }
  extend(): Env {
    return new Env(this);
  }
}

export function globalEnv(): Env {
  const g = new Env(null);
  const bin = (s: string, f: (a: Value, b: Value) => Value) => g.vars.set(s, lift(f));
  bin("+",  (a, b) =>
    typeof a === "string" && typeof b === "string" ? a + b :
    typeof a === "number" && typeof b === "number" ? num(a) + num(b) :
    undefined);
  bin("-",  (a, b) => num(a) - num(b));
  bin("*",  (a, b) => num(a) * num(b));
  bin("%",  (a, b) => num(a) % num(b));
  bin("==", (a, b) => a === b);
  bin("!=", (a, b) => a !== b);
  bin("<",  (a, b) => num(a) <  num(b));
  bin(">",  (a, b) => num(a) >  num(b));
  bin("<=", (a, b) => num(a) <= num(b));
  bin(">=", (a, b) => num(a) >= num(b));
  g.vars.set("neg", lift(a => -num(a)));
  g.vars.set("not", lift(a => (a === false || a === null ? true : false)));
  g.vars.set("list", lift((...xs) => xs));
  g.vars.set("head", lift(xs => {
    const a = xs as Value[];
    if (a.length === 0) throw new Error("head of empty array");
    return a[0]!;
  }));
  g.vars.set("tail", lift(xs => (xs as Value[]).slice(1)));
  g.vars.set("concat", lift((a, b) => (a as Value[]).concat(b as Value[])));
  g.vars.set("flat", lift(xs => (xs as Value[]).flat()));
  g.vars.set("len", lift(xs => (xs as Value[]).length));
  g.vars.set("strlen", lift(s => (s as string).length));
  g.vars.set("map", {
    tag: "native",
    fn: (args, k) => {
      const f = args[0]!;
      const xs = args[1] as Value[];
      const out = new Array<Value>(xs.length);
      function go(i: number): Outcome {
        if (i >= xs.length)
          return k(out);
        return apply(f, [xs[i]!], v => { out[i] = v; return go(i + 1); });
      }
      return go(0);
    },
  });
  // --- builtins added for the star.ink port ---
  g.vars.set("PI", Math.PI);
  g.vars.set("cos",    lift(a => Math.cos(num(a))));
  g.vars.set("sin",    lift(a => Math.sin(num(a))));
  g.vars.set("abs",    lift(a => Math.abs(num(a))));
  g.vars.set("round",  lift(a => Math.round(num(a))));
  g.vars.set("sqrt",   lift(a => Math.sqrt(num(a))));
  g.vars.set("char",   lift(a => String.fromCodePoint(num(a) | 0)));
  g.vars.set("number", lift(a => parseFloat(a as string)));
  g.vars.set("args",   lift(() => process.argv.slice(2)));
  g.vars.set("range",  lift((a, b, c) => {
    const s = num(a), e = num(b), st = num(c);
    const n = st === 0 ? 0 : Math.max(0, Math.ceil((e - s) / st));
    return Array.from({length: n}, (_, k) => s + k * st);
  }));
  g.vars.set("get", lift((xs, i) => {
    const a = xs as Value[];
    const idx = num(i);
    if (idx < 0 || idx >= a.length || !Number.isInteger(idx))
      throw new Error(`get: index ${idx} out of bounds [0, ${a.length})`);
    return a[idx]!;
  }));
  g.vars.set("set", lift((xs, i, v) => { (xs as Value[])[num(i)] = v; return null; }));
  g.vars.set("each", {
    tag: "native",
    fn: (args, k) => {
      const f = args[0]!, xs = args[1] as Value[];
      function go(i: number): Outcome {
        if (i >= xs.length)
          return k(null);
        return apply(f, [xs[i]!, i], () => go(i + 1));
      }
      return go(0);
    },
  });
  g.vars.set("flatmap", {
    tag: "native",
    fn: (args, k) => {
      const f = args[0]!, xs = args[1] as Value[];
      const acc: Value[] = [];
      function go(i: number): Outcome {
        if (i >= xs.length) return k(acc);
        return apply(f, [xs[i]!, i], (v) => { acc.push(...(v as Value[])); return go(i + 1); });
      }
      return go(0);
    },
  });
  return g;
}
