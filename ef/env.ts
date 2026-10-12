import {showT, type FunT} from "./types.ts";
import type {Expr, ExprID} from "./parser.ts";
import {builtins} from "./builtins.ts";

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
    return v.typ !== undefined ? "[fn: " + showT(v.typ) + "]" : "[fn]";
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
    null);
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
  // Named builtins and their impls come from the one table in builtins.ts.
  // Values (PI) bind as the value itself — `kind: "fn"` lifts to a CPS native,
  // `kind: "native"` is already CPS — so runtime binding matches the checker,
  // which binds every non-effect builtin by its `t`.
  for (const b of builtins) {
    if (b.kind === "effect") continue;
    if (b.kind === "value")
      g.vars.set(b.name, b.fn);
    else
      g.vars.set(b.name, b.kind === "fn" ? lift(b.fn) : {tag: "native", fn: b.fn});
  }
  return g;
}
