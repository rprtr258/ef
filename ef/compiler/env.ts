import {showT, type FunT} from "./types.ts";
import type {CIr} from "./cps_ir.ts";
import {builtins} from "./builtins.ts";

// --- Values (runtime) ---
export type Closure = {
  tag: "fn",
  params: string[],
  // Index into the closure's CPS IR function table; `$ret` (the caller's
  // continuation) is bound in the call frame at entry.
  fun: number,
  // The IR the fun index resolves in; closures carry their own IR so they
  // stay valid across REPL lines and separate programs.
  ir: CIr,
  env: Env,
  typ?: FunT,
};

export type Native = {
  tag: "native",
  fn: (args: Value[], k: Cont) => Outcome,
};

// Reified continuation as a first-class runtime value: what letk names,
// function `$ret`s, and handle ret/exit bindings resolve to. Internal only —
// the checker never lets source code name one.
type ContVal = {
  tag: "cont",
  fn: Cont,
};

// Slice: the runtime form of every `[T]` value — a fat pointer over a shared
// backing array. Views (sub) share the backing with different off/len; only
// the backing's elements mutate. Slices themselves are immutable records.
export type Slice = {
  tag: "slice",
  data: Value[],
  off: number,
  len: number,
};

// Tuple: struct-like record with named/positional fields — deliberately not
// a slice (no offset/length), never exposed as a plain array.
export type Tup = {
  tag: "tup",
  elems: Value[],
};

export type Value =
  | null
  | number
  | bigint
  | string
  | boolean
  | Slice
  | Tup
  | Closure
  | Native
  | ContVal;

export const mkSlice = (data: Value[], off = 0, len = data.length - off): Slice =>
  ({tag: "slice", data, off, len});
export const mkTup = (elems: Value[]): Tup => ({tag: "tup", elems});
// Downcast for `[T]`-typed sites (builtins, destructuring) — the checker
// guarantees the value is a slice.
export const asSlice = (v: Value): Slice => v as Slice;

function lift(fn: (...a: Value[]) => Value): Native {
  return {tag: "native", fn: (args, k) => k(fn(...args))};
}

// Width dispatch for the interpreter's operator natives: i64/u64 values are
// BigInt, every other width a JS number — the operator computes on the
// representation it receives, and the app node's width stamp (evalE's norm)
// normalizes the result (i32 |0, u32 >>>0, f32 fround, i64/u64 asIntN/
// asUintN). Mixed number/bigint operands (possible only through polymorphic
// uses) compute as BigInt.
function asBig(v: Value): bigint {
  return typeof v === "bigint" ? v : BigInt(Math.trunc(num(v)));
}
const eitherBig = (a: Value, b: Value): boolean =>
  typeof a === "bigint" || typeof b === "bigint";

export function num(v: Value): number {
  // i64/u64 values are BigInt (exact beyond 2^53); coerce for the JS-number
  // consumers (indices, char codes, exit codes, ms delays).
  if (typeof v === "bigint") return Number(v);
  if (typeof v !== "number")
    throw new Error("Expected number, got " + show(v));
  return v;
}

export function show(v: Value): string {
  if (v === null) return "unit";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return "\"" + v + "\"";
  if (typeof v === "object") {
    if (v.tag === "slice")
      return "[" + sliceElems(v).map(show).join(", ") + "]";
    if (v.tag === "tup")
      return "[" + v.elems.map(show).join(", ") + "]";
    if (v.tag === "fn")
      return v.typ !== undefined ? "[fn: " + showT(v.typ) + "]" : "[fn]";
    if (v.tag === "cont") return "[cont]"; // unreachable from source code
  }
  return "[fn]";
}

// The view's window as a fresh JS array (reads only; never written back).
export function sliceElems(s: Slice): Value[] {
  return s.data.slice(s.off, s.off + s.len);
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

// The runtime value for one non-effect builtin: `kind: "value"` binds as
// the value itself (PI), `kind: "fn"` lifts to a CPS native, `kind:
// "native"` is already CPS — so runtime binding matches the checker, which
// binds every non-effect builtin by its `t`.
function builtinValue(b: Exclude<(typeof builtins)[number], {kind: "effect"}>): Value {
  if (b.kind === "value") return b.fn;
  return b.kind === "fn" ? lift(b.fn) : {tag: "native", fn: b.fn};
}

export function globalEnv(refs?: Set<string>): Env {
  const g = new Env(null);
  const bin = (s: string, f: (a: Value, b: Value) => Value) => g.vars.set(s, lift(f));
  bin("+",  (a, b) =>
    typeof a === "string" && typeof b === "string" ? a + b :
    eitherBig(a, b) ? asBig(a) + asBig(b) :
    typeof a === "number" && typeof b === "number" ? num(a) + num(b) :
    null);
  bin("-",  (a, b) => eitherBig(a, b) ? asBig(a) - asBig(b) : num(a) - num(b));
  bin("*",  (a, b) => eitherBig(a, b) ? asBig(a) * asBig(b) : num(a) * num(b));
  // `%` handles only unstamped (polymorphic) app nodes — width-stamped ones
  // are intercepted in eval.ts's widthOp with the ÷0 trap.
  bin("%",  (a, b) => eitherBig(a, b) ? asBig(a) % asBig(b) : num(a) % num(b));
  bin("==", (a, b) => a === b);
  bin("!=", (a, b) => a !== b);
  bin("<",  (a, b) => eitherBig(a, b) ? asBig(a) <  asBig(b) : num(a) <  num(b));
  bin(">",  (a, b) => eitherBig(a, b) ? asBig(a) >  asBig(b) : num(a) >  num(b));
  bin("<=", (a, b) => eitherBig(a, b) ? asBig(a) <= asBig(b) : num(a) <= num(b));
  bin(">=", (a, b) => eitherBig(a, b) ? asBig(a) >= asBig(b) : num(a) >= num(b));
  g.vars.set("neg", lift(a => typeof a === "bigint" ? -a : -num(a)));
  // Named builtins and their impls come from the one table in builtins.ts.
  // With `refs`, only referenced builtins bind — exec seeds missing ones
  // incrementally per call, matching the wasm module's tree-shaken builtin
  // table; without, all bind.
  for (const b of builtins) {
    if (b.kind === "effect" || (refs !== undefined && !refs.has(b.name))) continue;
    g.vars.set(b.name, builtinValue(b));
  }
  return g;
}

// seedBuiltins: bind builtin names in `refs` that `env` doesn't define yet.
// exec calls this per program/REPL line so a later line can reference a
// builtin no earlier line used; existing bindings are never overwritten (a
// user `let` shadows the builtin for its whole lifetime).
export function seedBuiltins(env: Env, refs: Set<string>): void {
  for (const b of builtins) {
    if (b.kind === "effect" || !refs.has(b.name) || env.vars.has(b.name)) continue;
    env.vars.set(b.name, builtinValue(b));
  }
}
