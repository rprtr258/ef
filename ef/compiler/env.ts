import {showT} from "./frontend/type_display.ts";
import {type FunT} from "./frontend/unify.ts";
import type {CIr} from "./frontend/cps_ir.ts";
import {builtins} from "./builtins.ts";
import {
  OP_ADD, OP_SUB, OP_MUL, OP_REM,
  OP_EQ, OP_NE, OP_LT, OP_GT, OP_LE, OP_GE, OP_NEG,
} from "./ops.ts";

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
  // Direct-classified function (no suspension in its own subtree; its body
  // delivers with dret). Callers may use this to skip continuation
  // reification at the call site.
  direct?: boolean,
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
  return showVal(v, new Set());
}

// `active` is the set of objects on the current recursion path: a cycle
// prints `#cycle` in its place instead of recursing forever. Shared
// (aliased) objects print fully each time — only re-entering an ancestor is
// a cycle.
function showVal(v: Value, active: Set<object>): string {
  if (v === null) return "unit";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return "\"" + v + "\"";
  if (typeof v === "object") {
    if (active.has(v)) return "#cycle";
    if (v.tag === "slice") {
      active.add(v);
      const s = "[" + sliceElems(v).map(e => showVal(e, active)).join(", ") + "]";
      active.delete(v);
      return s;
    }
    if (v.tag === "tup") {
      active.add(v);
      const s = "[" + v.elems.map(e => showVal(e, active)).join(", ") + "]";
      active.delete(v);
      return s;
    }
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

// The arithmetic/comparison operators as data: globalEnv lifts them into
// the runtime env, and the wasm host's ef_binop import calls the same
// closures, so an operator reached as a value (a checker-unstamped site —
// string `+`, string comparisons) has identical semantics in both
// backends. (==/!= stay out of the wasm route: the wasm $eq helper
// content-compares boxed strings, which JS `===` on Values cannot see.)
export const OPS: [string, (a: Value, b: Value) => Value][] = [
  [OP_ADD,  (a, b) =>
    typeof a === "string" && typeof b === "string" ? a + b :
    eitherBig(a, b) ? asBig(a) + asBig(b) :
    typeof a === "number" && typeof b === "number" ? num(a) + num(b) :
    null],
  [OP_SUB,  (a, b) => eitherBig(a, b) ? asBig(a) - asBig(b) : num(a) - num(b)],
  [OP_MUL,  (a, b) => eitherBig(a, b) ? asBig(a) * asBig(b) : num(a) * num(b)],
  // `%` handles only unstamped (polymorphic) app nodes — width-stamped ones
  // are intercepted in eval.ts's widthOp with the ÷0 trap.
  [OP_REM,  (a, b) => eitherBig(a, b) ? asBig(a) % asBig(b) : num(a) % num(b)],
  [OP_EQ, (a, b) => a === b],
  [OP_NE, (a, b) => a !== b],
  [OP_LT,  (a, b) => eitherBig(a, b) ? asBig(a) <  asBig(b) : num(a) <  num(b)],
  [OP_GT,  (a, b) => eitherBig(a, b) ? asBig(a) >  asBig(b) : num(a) >  num(b)],
  [OP_LE, (a, b) => eitherBig(a, b) ? asBig(a) <= asBig(b) : num(a) <= num(b)],
  [OP_GE, (a, b) => eitherBig(a, b) ? asBig(a) >= asBig(b) : num(a) >= num(b)],
];

export function globalEnv(refs?: Set<string>): Env {
  const g = new Env(null);
  for (const [s, f] of OPS) g.vars.set(s, lift(f));
  g.vars.set(OP_NEG, lift(a => typeof a === "bigint" ? -a : -num(a)));
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
