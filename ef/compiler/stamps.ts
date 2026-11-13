// Backend stamps: the runtime-emission metadata the checker writes onto the
// AST — numeric widths (`numKind`), division width (`div`), suspension
// classification (`sus`), array/tuple shape (`arrKind`), and the lambda
// width-ambiguity bookkeeping (`unannParams`/`numTouched`). The evaluator
// normalizes every producing node's value to its stamped width (i32/u32/
// f32/f64: JS number, i64/u64: BigInt; f32 nodes fround) and the wasm
// backend reads the same stamps for typed boxes, statics, and fround
// round-trips, so the stamps are backend ABI. A node variant that can carry
// a numeric width must classify its stamping here: selfBoxedWidth and
// stampSuspension switch exhaustively over `e.t` and end in assertNever, so
// a new variant fails to compile until its box provenance and call-site
// status are declared.
//
// The module needs nothing from types.ts's checking internals: it reads the
// unifier (types resolve here), the parser's node slice, and the checker's
// recorder through the narrow StampRecorder port below. The checking pass
// (types.ts) calls these emitters at its stamp sites; lamStack — the lambda
// width-tracking stack — is module state here because the whole
// push/pop/mark discipline lives with it.

import {NATIVE_BUILTINS} from "./builtin_table.ts";
import {assertNever} from "./assert.ts";
import {ARITH_OPS, OP_ADD, OP_NEG, STAMPED_OPS} from "./ops.ts";
import {TI32, TI64, TU32, TU64, TF32, TF64, TUNIT} from "./prims.ts";
import {TypeError_} from "./type_display.ts";
import {
  FLOAT_NAMES, INT_NAMES, Unifier, widthOf,
  type NumName, type Prim, type Type,
} from "./unify.ts";
import type {Expr, ExprID} from "./parser.ts";

// The slice of the checker's recorder the stamps read and write: the checked
// node slice and the per-node recorded types (width pins overwrite entries —
// the map holds each node's final stamp). TokenRecorder (types.ts) satisfies
// this structurally, so stamps.ts stays decoupled from the checking
// internals.
export type StampRecorder = {
  readonly nodes: Expr[],
  recordType(id: ExprID, t: Type): void,
  typeOf(id: ExprID): Type | undefined,
};

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

// Concrete width name -> its prim type (the width pins record these).
const WIDTH_PRIMS: Record<string, Prim> = {
  i32: TI32, u32: TU32, i64: TI64, u64: TU64, f32: TF32, f64: TF64,
};

// Nodes whose runtime box is produced BY their own stamp — pinnable: untyped
// literals (fresh wildcards; statics key on the stamp), @as (boxes at its
// target), and operator/neg sites (boxW reads the site's stamp). A call/sym/
// field node's box comes from its own production — relabeling it would desync
// the stamp from the box (e.g. a builtin's TFLOAT return read through a call).
// Compile-time coverage: every Expr variant is classified explicitly, so a
// new variant fails here (assertNever) until its box provenance is declared —
// a self-boxing variant missing from the true arm would silently keep its
// wildcard unpinned and box at the default i64/f64 width.
function selfBoxedWidth(nodes: Expr[], id: ExprID): boolean {
  const n = nodes[id];
  switch (n.t) {
    case "num":
    case "as":
      return true;
    case "app": {
      const fn = nodes[n.fn];
      return fn.t === "sym" && (ARITH_OPS.has(fn.v) || fn.v === OP_NEG || fn.v === OP_ADD);
    }
    case "str": case "bool": case "unit": case "sym": case "lambda":
    case "let": case "dlet": case "assign": case "if": case "while":
    case "block": case "perform": case "handle": case "arr": case "field":
      return false;
    default:
      return assertNever(n);
  }
}

// Pin a wildcard-typed operand node's recorded type to the op's compute
// width: the operand's type only reached this width by flexing, so its
// runtime representation is the op's width (the wasm backend boxes pinned
// literals as statics of this shape; the interpreter normalizes at the
// node). Concrete-typed operands keep their own stamps.
function pinWildcard(u: Unifier, rec: StampRecorder, argId: ExprID, at: Type, widened: Type): void {
  const rt = u.res(at);
  if (rt.tag !== "prim" || (rt.name !== "int" && rt.name !== "float")) return;
  // Fresh wildcard instances (untyped literals) always box at their stamp.
  // A shared wildcard (e.g. a builtin signature's TFLOAT, or an operator's
  // TINT result) is pinnable only when the node boxes at its own stamp.
  if (!u.wilds.has(rt) && !selfBoxedWidth(rec.nodes, argId)) return;
  const w = widthOf(u.res(widened));
  if (w !== null) rec.recordType(argId, u.res(widened));
}

// Stamp an operator site's COMPUTE width (the operand width; the result type
// would be bool for comparisons) — the evaluator's widthOp coerces both
// operands to this representation before operating — and pin the site's
// wildcard-typed operands (untyped literals, non-generalized bindings) to
// it: their recorded types flexed into this op, so their runtime
// representation is the op's width (the wasm backend boxes them as statics
// of this shape; a literal wider than the op width wraps here exactly like
// at the op). No-op when the op's result carries no width (string `+`).
export function stampComputeWidth(uni: Unifier, rec: StampRecorder, e: Expr & {t: "app"}, ats: Type[], widened: Type): void {
  const wo = widthOf(uni.res(widened));
  if (wo === null) return;
  e.numKind = wo.w;
  for (let i = 0; i < ats.length; i++)
    pinWildcard(uni, rec, e.args[i], ats[i], widened);
}

// Numeric equality is stamped with the compute width too (concrete side
// wins between a width and a wildcard literal; float beats int between two
// wildcards) so `PI == 3` and `1 == 1.0` coerce right, and the wildcard
// operands pin to the flexed concrete width (the same discipline as the
// arithmetic ops): an untyped literal compared against a concrete-width
// value takes that width's representation (the BigInt literal wraps at its
// own node, exactly like the wasm static's box shape).
export function stampEqWidth(uni: Unifier, rec: StampRecorder, e: Expr & {t: "app"}, at: Type, bt: Type): void {
  const ea = widthOf(uni.res(at)), eb = widthOf(uni.res(bt));
  if (ea !== null && eb !== null)
    e.numKind = ea.concrete ? ea.w : eb.concrete ? eb.w : (ea.w === "f64" || eb.w === "f64") ? "f64" : "i64";
  const flexW = ea !== null && ea.concrete ? ea.w : eb !== null && eb.concrete ? eb.w : null;
  if (flexW !== null) {
    const prim = WIDTH_PRIMS[flexW];
    pinWildcard(uni, rec, e.args[0], at, prim);
    pinWildcard(uni, rec, e.args[1], bt, prim);
  }
}

// The division's WIDTH goes on the node so the evaluator and the emitters
// pick truncation and the signed/unsigned op variants.
export function stampDivWidth(uni: Unifier, e: Expr & {t: "app"}, widened: Type): void {
  const rw = widthOf(uni.res(widened));
  e.div = rw !== null ? rw.w : "f64";
}

// Pin the body's tail root when a lambda's declared return width is concrete
// and the tail's type is a numeric wildcard: the tail boxes at its own stamp
// (num statics / operator boxW), so the stamp must carry the declared width
// for the caller's typed reads to match (`fn(): i32 { 8 / 2 }` boxes the
// tail $I32, not the wildcard-default $I64).
export function pinRetWidth(uni: Unifier, rec: StampRecorder, lam: Expr & {t: "lambda"}, ret: Type): void {
  if (lam.retTyp === null) return;
  const dt = uni.res(lam.retTyp);
  const dw = dt.tag === "prim" ? widthOf(dt) : null;
  const rt2 = uni.res(ret);
  if (dw !== null && dw.concrete && rt2.tag === "prim" &&
    (rt2.name === "int" || rt2.name === "float")) {
    const bodyE = rec.nodes[lam.body];
    const tail = bodyE.t === "block" ? bodyE.stmts[bodyE.stmts.length - 1] : lam.body;
    const tailT = uni.res(rec.typeOf(tail) ?? TUNIT);
    if (tailT.tag === "prim" && tailT.name === rt2.name && selfBoxedWidth(rec.nodes, tail))
      rec.recordType(tail, dt);
  }
}

// Pin a wildcard-typed value literal to the binding's concrete width:
// `x: i32 = 2147483647` boxes the literal as $I32 (wrapping at its own
// node, matching the interpreter's per-node normalization).
export function pinBindingWidth(uni: Unifier, rec: StampRecorder, valId: ExprID, rt: Type): void {
  const rw = widthOf(rt);
  if (rw === null || !rw.concrete || rec.nodes[valId].t !== "num") return;
  const vt = uni.res(rec.typeOf(valId) ?? TUNIT);
  if (vt.tag === "prim" && (vt.name === "int" || vt.name === "float"))
    rec.recordType(valId, rt);
}

// Width stamps: after all items are checked, stamp every node whose type
// resolved to a numeric width with `numKind` — concrete widths as-is, untyped
// int/float literals defaulted to i64/f64 (literal defaulting, not width
// conversion). Unstamped nodes (type still an unbound var — polymorphic
// uses) compute by value-based dispatch at runtime.
export function stampNumKinds(nodes: Expr[], uni: Unifier, nodeTypes: Map<ExprID, Type>): void {
  for (const [id, t] of nodeTypes) {
    const rt = uni.res(t);
    let w: NumName | null = null;
    if (rt.tag === "prim") {
      const n = rt.name as NumName;
      if (n === "int" || n === "float") {
        // Untyped literal: its recorded flex at unify time, else the
        // i64/f64 default (literal defaulting, not width conversion).
        w = uni.wildFlex.get(rt) ?? (n === "int" ? "i64" : "f64");
      } else if (INT_NAMES.has(n) || FLOAT_NAMES.has(n)) w = n;
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
        const er = uni.resEff(rt.effs);
        if (er instanceof Set && er.size === 0) sus = false;
      }
    }
    e.sus = sus;
  }
}
