// Backend stamps: the runtime-emission metadata the checker writes onto the
// AST — numeric widths (`numKind`), division width (`div`), suspension
// classification (`sus`), array/tuple shape (`arrKind`), and the lambda
// width-ambiguity bookkeeping (`unannParams`/`numTouched`). The evaluator
// normalizes every producing node's value to its stamped width (i32/u32/
// f32/f64: JS number, i64/u64: BigInt; f32 nodes fround) and the wasm
// backend reads the same stamps for typed boxes, statics, and fround
// round-trips, so the stamps are backend ABI. A node variant that can carry
// a numeric width must classify its stamping here: stampSuspension switches
// exhaustively over `e.t` and ends in assertNever, so a new variant fails
// to compile until its call-site status is declared. Numeric widths are NOT
// decided here: unify binds literal widths in place and resolveWilds
// (unify.ts) leaves every wildcard concrete before stampNumKinds reads the
// resolved types.
//
// The module needs nothing from types.ts's checking internals: it reads the
// unifier (types resolve here) and the parser's node slice. The checking
// pass (types.ts) calls these emitters at its stamp sites; lamStack — the
// lambda width-tracking stack — is module state here because the whole
// push/pop/mark discipline lives with it.

import {NATIVE_BUILTINS} from "./builtin_table.ts";
import {assertNever} from "./assert.ts";
import {STAMPED_OPS} from "./ops.ts";
import {TypeError_} from "./frontend/type_display.ts";
import {
  FLOAT_NAMES, INT_NAMES, Unifier, widthOf,
  type NumName, type Type,
} from "./frontend/unify.ts";
import type {Expr, ExprID} from "./frontend/parser.ts";

// Runtime shape stamp (mirrors numKind): the evaluator builds a slice for
// homogeneous literals and a tuple record otherwise.
export function stampArrKind(e: Expr & {t: "arr"}, kind: "arr" | "tup"): void {
  e.arrKind = kind;
}

// Width-ambiguity tracking (strict-width rule): while a lambda body is being
// inferred, its unannotated params' type-var ids are registered on the
// innermost active context; numeric ops mark the vars they see. At the `let`
// that binds the lambda, a param that a numeric op touched but whose width
// never resolved concrete is rejected: the body already fixed ONE width while
// the generalized type would let each instantiation pick another.
// Per-checkProgram lambda-width frame. The stack is empty outside lambda
// bodies by construction: inference is a synchronous single pass — `infer` is
// module-private and `checkProgram` the only entry — so no second pass can
// share this state concurrently.
type LamCtx = { unann: Set<number>, touched: Set<number> };
// One entry per lambda whose params include unannotated numerics, pushed for
// the body's inference and popped at its end. Module state, not per-call:
// inference is a single synchronous pass, so the stack is empty outside a
// lambda body by construction.
const lamStack: LamCtx[] = [];

// Register the lambda's unannotated param vars for the body's numeric ops.
// Returns null when there is nothing to track (every param annotated) — the
// caller's finally then skips the bookkeeping.
export function beginLamWidths(unann: {id: number}[]): LamCtx | null {
  if (unann.length === 0) return null;
  const ctx: LamCtx = {unann: new Set(unann.map(p => p.id)), touched: new Set()};
  lamStack.push(ctx);
  return ctx;
}

// Pop the tracking context and record the body's results on the lambda node
// for checkLamWidths at the binding `let`.
export function endLamWidths(
  ctx: LamCtx | null,
  lam: Expr & {unannParams?: {name: string, id: number}[], numTouched?: Set<number>},
  unann: {name: string, id: number}[],
): void {
  if (ctx === null) return;
  lamStack.pop();
  lam.unannParams = unann;
  lam.numTouched = ctx.touched;
}

// Numeric ops mark the unannotated param vars they see.
export function touchNumericVar(u: Unifier, t: Type): void {
  if (lamStack.length === 0) return;
  const r = u.res(t);
  if (r.tag !== "var") return;
  const root = u.find(r.id);
  for (const c of lamStack) if (c.unann.has(root)) c.touched.add(root);
}

// Strict-width rejection for let-bound lambdas (runs at every let whose RHS
// is a lambda, annotation or not — the body's width stamps are fixed either
// way): an unannotated param is rejected when (a) numeric ops touched its var
// but the width never resolved concrete (the generalized type would flex per
// instantiation while the body fixed one width), or (b) it was pinned to an
// untyped-literal wildcard (int/float) by anything — numeric ops, `==`, or an
// int-wildcard builtin param. Truly polymorphic params (unbound vars, `any`)
// and non-numeric pins (string, arrays, functions) pass. Directly-passed
// lambdas never reach here: their params get concrete types from the
// instantiation.
export function checkLamWidths(u: Unifier, lam: Expr & {unannParams?: {name: string, id: number}[], numTouched?: Set<number>}): void {
  if (lam.unannParams === undefined) return;
  const touched = new Set<number>();
  if (lam.numTouched !== undefined)
    for (const r of lam.numTouched) touched.add(u.find(r)); // unions after a touch may have re-rooted
  for (const p of lam.unannParams) {
    const rt = u.res({tag: "var", id: p.id});
    if (rt.tag === "prim" && (rt.name === "int" || rt.name === "float"))
      throw new TypeError_(`ambiguous numeric width — annotate the parameter (e.g. ${p.name}: i64)`);
    if (rt.tag === "var" && touched.has(u.find(rt.id)))
      throw new TypeError_(`ambiguous numeric width — annotate the parameter (e.g. ${p.name}: i64)`);
  }
}

// Stamp an operator site's COMPUTE width (the operand width; the result type
// would be bool for comparisons). The operands' widths were resolved by
// unification itself (flexWild/resolveWilds), so nothing is pinned here.
// No-op when the op's result carries no width (string `+`).
export function stampComputeWidth(uni: Unifier, e: Expr & {t: "app"}, widened: Type): void {
  const wo = widthOf(uni.res(widened));
  if (wo !== null) e.numKind = wo.w;
}

// Numeric equality is stamped with the compute width too (concrete side
// wins between a width and a wildcard literal; float beats int between two
// wildcards) — the result type is bool, so the operand width is not
// derivable from the node's type. The operands' widths were resolved by the
// eq site's own unify (flexWild/resolveWilds); the fallback pick only
// covers shared wildcard singletons (e.g. `PI == 3` → f64).
export function stampEqWidth(uni: Unifier, e: Expr & {t: "app"}, at: Type, bt: Type): void {
  const ea = widthOf(uni.res(at)), eb = widthOf(uni.res(bt));
  if (ea !== null && eb !== null)
    e.numKind = ea.concrete ? ea.w : eb.concrete ? eb.w : (ea.w === "f64" || eb.w === "f64") ? "f64" : "i64";
}

// The division's WIDTH goes on the node so the evaluator and the emitters
// pick truncation and the signed/unsigned op variants.
export function stampDivWidth(uni: Unifier, e: Expr & {t: "app"}, widened: Type): void {
  const rw = widthOf(uni.res(widened));
  e.div = rw !== null ? rw.w : "f64";
}

// Width stamps: after resolveWilds has left every wildcard concrete, stamp
// every node whose type resolved to a numeric width with `numKind`. The
// "int"/"float" branch only covers the SHARED TINT/TFLOAT singletons
// (builtin signature wildcards), defaulting to i64/f64; fresh literal
// wildcards never reach it. Unstamped nodes (type still an unbound var —
// polymorphic uses) compute by value-based dispatch at runtime.
export function stampNumKinds(nodes: Expr[], uni: Unifier, nodeTypes: Map<ExprID, Type>): void {
  for (const [id, t] of nodeTypes) {
    const rt = uni.res(t);
    let w: NumName | null = null;
    if (rt.tag === "prim") {
      const n = rt.name as NumName;
      if (INT_NAMES.has(n) || FLOAT_NAMES.has(n)) w = n;
      else if (n === "int") w = "i64";
      else if (n === "float") w = "f64";
    }
    if (w !== null) (nodes[id] as Expr & {numKind?: string}).numKind = w;
  }
}

// Suspension stamps: after all items are checked, classify every generic
// call site by its callee's resolved FunT. `sus: false` — a dcall — requires
// positive evidence: a FunT with neither marker and a concrete empty row.
// Everything else (nonempty row, unbound row var, non-FunT callee including
// `any`, anyTaint, contCall) stays a suspending `call`; a callee with no
// recorded type defaults to suspending. Effect-polymorphic native builtins
// (map/each/flatmap) have effect-variable rows by construction, so the row
// test alone already keeps them suspending — the NATIVE_BUILTINS test below
// is a belt-and-braces guard. Operator apps the checker dispatched
// structurally (STAMPED_OPS, hosted in ops.ts) skip the callee lookup: their
// callees never reach `infer`, so they carry no callee type in nodeTypes and
// never get a suspension stamp — the converter's own fast paths dispatch
// them.
export function stampSuspension(nodes: Expr[], uni: Unifier, nodeTypes: Map<ExprID, Type>): void {
  for (const [id] of nodeTypes) {
    const e = nodes[id];
    // Compile-time coverage: `app` is the only call-site form; every other
    // variant is explicitly not-a-call-site, and a NEW variant fails here
    // (assertNever) until its suspension stamping is declared — a call-like
    // variant skipped by mistake would silently default to suspending.
    switch (e.t) {
      case "app":
        break;
      case "num": case "str": case "bool": case "unit": case "sym":
      case "lambda": case "let": case "dlet": case "assign": case "if":
      case "while": case "block": case "perform": case "handle":
      case "arr": case "as": case "field":
        continue;
      default:
        return assertNever(e);
    }
    const fn = nodes[e.fn];
    if (fn.t === "sym" && STAMPED_OPS.has(fn.v)) continue;
    let sus = true;
    const ct = nodeTypes.get(e.fn);
    if (ct !== undefined) {
      const rt = uni.res(ct);
      if (rt.tag === "fun" && rt.contCall !== true && rt.anyTaint !== true &&
        !(fn.t === "sym" && NATIVE_BUILTINS.has(fn.v))) {
        // resRow, not resEff: rows can carry effect variables (propagated
        // from polymorphic callees) and self-referential bindings (a direct
        // recursion's row equation) — a resolved empty row means the call
        // cannot suspend; an unresolved variable or leftover op means it can.
        if (uni.resRow(rt.effs).size === 0) sus = false;
      }
    }
    e.sus = sus;
  }
}
