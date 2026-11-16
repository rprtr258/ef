// Backend stamps: the runtime-emission metadata the checker writes into a
// per-check side table (Checked.stamps, keyed by ExprID) — numeric widths
// (`numKind`), division width (`div`), suspension classification (`sus`),
// the lambda's resolved FunT (`typ`), array/tuple literal shape (`arrKind`),
// resolved field index (`fieldIdx`), and the @as conversion kind (`asKind`).
// The evaluator
// normalizes every producing node's value to its stamped width (i32/u32/
// f32/f64: JS number, i64/u64: BigInt; f32 nodes fround) and the wasm
// backend reads the same stamps for typed boxes, statics, and fround
// round-trips, so the stamps are backend ABI. The AST itself stays
// read-only after construction: every checker-discovered field rides this
// table, and the lambda width-ambiguity bookkeeping lives in the module map
// `lamWidths` below. A node variant that can carry
// a numeric width must classify its stamping here: stampSuspension switches
// exhaustively over `e.t` and ends in assertNever, so a new variant fails
// to compile until its call-site status is declared. Numeric widths are NOT
// decided here: unify binds literal widths in place; unresolved num types
// ("int"/"float") lower to the defaults (i64/f64) via widthOf — stampNumKinds
// reads the lowered width off the resolved types.
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
  FLOAT_NAMES, INT_NAMES, type Unifier, widthOf,
  uniFind, uniRes, uniResRow,
  type FunT, type NumName, type Type,
} from "./frontend/unify.ts";
import type {Expr, ExprID} from "./frontend/parser.ts";

// Per-node stamp slot (Checked.stamps, indexed by ExprID). `typ` carries the
// lambda's FunT (deep-resolved at its binding `let`) for the converter's
// direct-style decision and the IR's func.typ.
export type NodeStamps = {
  numKind?: string,
  div?: NumName,
  sus?: boolean,
  typ?: FunT,
  arrKind?: "arr" | "tup",
  fieldIdx?: number,
  asKind?: "trunc" | "boolnum",
};

// The node's stamp slot, created on first write (the table stays sparse).
function slot(stamps: (NodeStamps | undefined)[], id: ExprID): NodeStamps {
  return stamps[id] ?? (stamps[id] = {});
}

// Runtime shape stamp (mirrors numKind): the evaluator builds a slice for
// homogeneous literals and a tuple record otherwise.
export function stampArrKind(id: ExprID, kind: "arr" | "tup", stamps: (NodeStamps | undefined)[]): void {
  slot(stamps, id).arrKind = kind;
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
type LamCtx = { unannIds: Set<number>, unann: {name: string, id: number}[], touched: Set<number> };
// One entry per lambda whose params include unannotated numerics, pushed for
// the body's inference and popped at its end. Module state, not per-call:
// inference is a single synchronous pass, so the stack is empty outside a
// lambda body by construction. Results land in `lamWidths` keyed by the
// lambda's ExprID for checkLamWidths at the binding `let`.
const lamStack: LamCtx[] = [];
// Keyed by ExprID: the node slice is per-parse, so the map must be reset per
// checkProgram — otherwise a stale entry (a lambda never let-bound) collides
// with the next program's ExprIDs.
const lamWidths = new Map<ExprID, LamCtx>();

// Drop any leftover entries from a previous check (see lamWidths). Called
// once per checkProgram before inference.
export function resetLamWidths(): void { lamWidths.clear(); }

// Register the lambda's unannotated param vars for the body's numeric ops.
// Returns null when there is nothing to track (every param annotated) — the
// caller's finally then skips the bookkeeping.
export function beginLamWidths(unann: {name: string, id: number}[]): LamCtx | null {
  if (unann.length === 0) return null;
  const ctx: LamCtx = {unannIds: new Set(unann.map(p => p.id)), unann: unann.slice(), touched: new Set()};
  lamStack.push(ctx);
  return ctx;
}

// Pop the tracking context and record the body's results under the lambda's
// ExprID for checkLamWidths at the binding `let`.
export function endLamWidths(ctx: LamCtx | null, lamId: ExprID): void {
  if (ctx === null) return;
  lamStack.pop();
  lamWidths.set(lamId, ctx);
}

// Numeric ops mark the unannotated param vars they see.
export function touchNumericVar(u: Unifier, t: Type): void {
  if (lamStack.length === 0) return;
  const r = uniRes(u, t);
  if (r.tag !== "var") return;
  const root = uniFind(u, r.id);
  for (const c of lamStack) if (c.unannIds.has(root)) c.touched.add(root);
}

// Strict-width rejection for let-bound lambdas (runs at every let whose RHS
// is a lambda, annotation or not — the body's width stamps are fixed either
// way): an unannotated param is rejected when (a) numeric ops touched its var
// but the width never resolved concrete (the generalized type would flex per
// instantiation while the body fixed one width), or (b) it was pinned to an
// untyped-literal num type (int/float) by anything — numeric ops, `==`, or an
// int-num builtin param. Truly polymorphic params (unbound vars, `any`)
// and non-numeric pins (string, arrays, functions) pass. Directly-passed
// lambdas never reach here: their params get concrete types from the
// instantiation.
export function checkLamWidths(u: Unifier, lamId: ExprID): void {
  const rec = lamWidths.get(lamId);
  if (rec === undefined) return;
  lamWidths.delete(lamId);
  const touched = new Set<number>();
  for (const r of rec.touched) touched.add(uniFind(u, r)); // unions after a touch may have re-rooted
  for (const p of rec.unann) {
    const rt = uniRes(u, {tag: "var", id: p.id});
    if (rt.tag === "prim" && (rt.name === "int" || rt.name === "float"))
      throw new TypeError_(`ambiguous numeric width — annotate the parameter (e.g. ${p.name}: i64)`);
    if (rt.tag === "var" && touched.has(uniFind(u, rt.id)))
      throw new TypeError_(`ambiguous numeric width — annotate the parameter (e.g. ${p.name}: i64)`);
  }
}

// Stamp an operator site's COMPUTE width (the operand width; the result type
// would be bool for comparisons). The operands' widths were resolved by
// unification itself (flexNum/resolveNums), so nothing is pinned here.
// No-op when the op's result carries no width (string `+`).
export function stampComputeWidth(uni: Unifier, id: ExprID, widened: Type, stamps: (NodeStamps | undefined)[]): void {
  const wo = widthOf(uniRes(uni, widened));
  if (wo !== null) slot(stamps, id).numKind = wo.w;
}

// Numeric equality is stamped with the compute width too (concrete side
// wins between a width and a num-type literal; float beats int between two
// num types) — the result type is bool, so the operand width is not
// derivable from the node's type. The operands' widths were resolved by the
// eq site's own unify (flexNum/resolveNums); the fallback pick only
// covers shared num-type singletons (e.g. `PI == 3` → f64).
export function stampEqWidth(uni: Unifier, id: ExprID, at: Type, bt: Type, stamps: (NodeStamps | undefined)[]): void {
  const ea = widthOf(uniRes(uni, at)), eb = widthOf(uniRes(uni, bt));
  if (ea !== null && eb !== null)
    slot(stamps, id).numKind = ea.concrete ? ea.w : eb.concrete ? eb.w : (ea.w === "f64" || eb.w === "f64") ? "f64" : "i64";
}

// The division's WIDTH goes on the node so the evaluator and the emitters
// pick truncation and the signed/unsigned op variants.
export function stampDivWidth(uni: Unifier, id: ExprID, widened: Type, stamps: (NodeStamps | undefined)[]): void {
  const rw = widthOf(uniRes(uni, widened));
  slot(stamps, id).div = rw !== null ? rw.w : "f64";
}

// Width stamps: stamp every node whose type resolved to a numeric width
// with `numKind`, lowering untyped num types to the defaults (int → i64,
// float → f64 — the branch covers fresh literal num types and the shared
// TINT/TFLOAT singletons alike). Unstamped nodes (type still an unbound var —
// polymorphic uses) compute by value-based dispatch at runtime.
export function stampNumKinds(uni: Unifier, nodeTypes: (Type | undefined)[], stamps: (NodeStamps | undefined)[]): void {
  for (let id = 0; id < nodeTypes.length; id++) {
    const t = nodeTypes[id];
    if (t === undefined) continue;
    const rt = uniRes(uni, t);
    let w: NumName | null = null;
    if (rt.tag === "prim") {
      const n = rt.name as NumName;
      if (INT_NAMES.has(n) || FLOAT_NAMES.has(n)) w = n;
      else if (n === "int") w = "i64";
      else if (n === "float") w = "f64";
    }
    if (w !== null) slot(stamps, id).numKind = w;
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
export function stampSuspension(nodes: Expr[], uni: Unifier, nodeTypes: (Type | undefined)[], stamps: (NodeStamps | undefined)[]): void {
  for (let id = 0; id < nodeTypes.length; id++) {
    if (nodeTypes[id] === undefined) continue;
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
    const ct = nodeTypes[e.fn];
    if (ct !== undefined) {
      const rt = uniRes(uni, ct);
      if (rt.tag === "fun" && rt.contCall !== true && rt.anyTaint !== true &&
        !(fn.t === "sym" && NATIVE_BUILTINS.has(fn.v))) {
        // resRow flattens bound effect variables (propagated from
        // polymorphic callees, or self-referential bindings from direct
        // recursion) — a resolved empty row means the call cannot suspend;
        // an unbound variable or leftover op means it can.
        const rr = uniResRow(uni, rt.effs);
        if (rr.ops.size === 0 && rr.vars.size === 0) sus = false;
      }
    }
    slot(stamps, id).sus = sus;
  }
}
