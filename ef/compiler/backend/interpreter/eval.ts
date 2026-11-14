// A tiny interpreted language with algebraic effects, C/Go-flavoured syntax.
// Two passes: a static type checker (bidirectional + union-find unification,
// with monomorphic effect tracking), then CPS conversion (cps.ts) to the
// cps_ir.ts term, interpreted here with continuations as plain JS functions —
// giving true multi-shot `resume`. The IR's continuation names resolve at
// runtime (jump/call/perform k operands), which is what makes recursive letk
// loops and handler re-entry work; the interpreter threads the ambient
// continuation for value delivery, and the term's explicit continuations are
// what the wasm backend defunctionalizes in stage 2.

import type {Checked} from "../../frontend/types.ts";
import type {Type} from "../../frontend/unify.ts";
import {Env, show, asSlice, mkSlice, mkTup, sliceElems, type Cont, type Native, type Outcome, type Value, num, seedBuiltins, type Closure} from "../../env.ts";
import {builtinRefs} from "../../frontend/analysis.ts";
import type {Program} from "../../frontend/parser.ts";
import {prepare, newCtx, rejectUnhandled, type Ctx, type EffectInterp} from "../../frontend/pipeline.ts";
import {toCps, RET} from "../../frontend/cps.ts";
import type {CAtom, CIr, CPrim, CTerm} from "../../frontend/cps_ir.ts";
import {assertNever} from "../../assert.ts";
import {errDivByZero, errIndexOOB, errIntOverflow, errUnhandled, OP_ADD, OP_DIV, OP_EQ, OP_GE, OP_GT, OP_LE, OP_LT, OP_MUL, OP_NE, OP_NEG, OP_REM, OP_SUB} from "../../ops.ts";
import {builtinInterps} from "../../builtins.ts";

function isNative(v: Value): v is Native {
  return v !== null && typeof v === "object" && v.tag === "native";
}
function isClosure(v: Value): v is Closure {
  return v !== null && typeof v === "object" && v.tag === "fn";
}

export function apply(f: Value, args: Value[], k: Cont): Outcome {
  if (isNative(f))
    return f.fn(args, k);
  if (isClosure(f)) {
    const n = f.env.extend();
    for (let i = 0; i < f.params.length; i++)
      n.vars.set(f.params[i], args[i] ?? null);
    // The body's tails jump `$ret` — the caller's continuation, reified.
    n.vars.set(RET, {tag: "cont", fn: k});
    return evalTerm(f.ir.funcs[f.fun].body, f.ir, n, k);
  }
  throw new Error("Not callable: " + show(f));
}

// Term interpreter. `k` is the ambient continuation, consumed only by halt
// (the program boundary); every other value delivery resolves a named
// continuation (jump/call/perform k operands), which the converter guarantees
// to denote the ambient one at that point.
function evalTerm(t: CTerm, ir: CIr, env: Env, k: Cont): Outcome {
  switch (t.t) {
    case "letk": {
      const n = env.extend();
      // Frozen accs: cross-suspension temps are captured NOW (pre-perform)
      // and restored on every entry — a resume must never see a later
      // activation's re-binding of the same temp. Source named variables
      // stay live (frame-shared), matching the wasm backend's letk-freeze
      // (frozen operand image) vs $FRAME (live named slots) split.
      const frozen = t.freeze?.map(fr => [fr.name, evalAtom(fr.val, env)] as const);
      n.vars.set(t.name, {tag: "cont", fn: (v) => {
        const nb = n.extend();
        if (frozen !== undefined)
          for (const [nm, val] of frozen) nb.vars.set(nm, val);
        nb.vars.set(t.param, t.norm !== undefined ? normWidth(v, t.norm) : v);
        return evalTerm(t.body, ir, nb, k);
      }});
      return evalTerm(t.rest, ir, n, k);
    }
    case "let":
      env.vars.set(t.name, evalPrim(t.rhs, env));
      return evalTerm(t.rest, ir, env, k);
    case "bind":
      env.vars.set(t.name, evalAtom(t.val, env));
      return evalTerm(t.rest, ir, env, k);
    case "mkfn":
      env.vars.set(t.name, {tag: "fn", params: t.params, fun: t.fun, ir, env, typ: ir.funcs[t.fun].typ, direct: ir.funcs[t.fun].direct === true || undefined});
      return evalTerm(t.rest, ir, env, k);
    case "call": {
      const f = evalAtom(t.fn, env);
      const args = t.args.map(a => evalAtom(a, env));
      return apply(f, args, resolveCont(t.k, env));
    }
    case "dcall": {
      // A classified-pure callee never yields {tag: "eff"} (the selection
      // invariant), so its continuation fires before any other code runs —
      // binding into the ambient env here matches the let case.
      const f = evalAtom(t.fn, env);
      const args = t.args.map(a => evalAtom(a, env));
      if (isClosure(f) && f.direct === true) {
        // Direct boundary: apply the closure here — no apply frame, and the
        // site's continuation serves as both the ambient k (dret) and $ret
        // (handle islands resolve their k operand through the env).
        const n = f.env.extend();
        for (let i = 0; i < f.params.length; i++)
          n.vars.set(f.params[i], args[i] ?? null);
        const adhocK: Cont = (v) => {
          env.vars.set(t.name, t.norm !== undefined ? normWidth(v, t.norm) : v);
          return evalTerm(t.rest, ir, env, k);
        };
        n.vars.set(RET, {tag: "cont", fn: adhocK});
        return evalTerm(f.ir.funcs[f.fun].body, f.ir, n, adhocK);
      }
      return apply(f, args, (v) => {
        env.vars.set(t.name, t.norm !== undefined ? normWidth(v, t.norm) : v);
        return evalTerm(t.rest, ir, env, k);
      });
    }
    case "perform": {
      const args = t.args.map(a => evalAtom(a, env));
      return {tag: "eff", op: t.op, args, k: resolveCont(t.k, env)};
    }
    case "handle":
      return evalHandle(t, ir, env);
    case "if": {
      const c = evalAtom(t.c, env);
      return evalTerm(c !== false && c !== null ? t.a : t.b, ir, env, k);
    }
    case "scope":
      return evalTerm(t.rest, ir, env.extend(), k);
    case "dlet": {
      const v = evalAtom(t.val, env);
      // Tuples carry their fields directly; arrays destructure through the
      // view's window (the checker statically picks which shape `v` has).
      const a = v !== null && typeof v === "object" && v.tag === "tup" ? v.elems : sliceElems(asSlice(v));
      for (let i = 0; i < t.fields.length; i++) env.vars.set(t.fields[i], a[i]);
      return evalTerm(t.rest, ir, env, k);
    }
    case "assign":
      env.assignVar(t.name, evalAtom(t.val, env));
      return evalTerm(t.rest, ir, env, k);
    case "jump":
      return resolveCont(t.k, env)(evalAtom(t.arg, env));
    case "dret":
      return k(evalAtom(t.v, env));
    case "halt":
      return k(evalAtom(t.v, env));
    default:
      return assertNever(t);
  }
}

// Handler installation: the run() loop driving the CPS term. `ret` is
// bound once to the done-wrapper (the handled body's
// tails jump it); `exit` is rebound per run() to the current continuation —
// resume re-entries pass a different kOuter than the first run did.
function evalHandle(t: CTerm & {t: "handle"}, ir: CIr, env: Env): Outcome {
  const handlers = new Map(t.cases.map(c => [c.op, c]));
  const retC = handlers.get("Return");
  // The handle's own continuation, resolved from its explicit k operand.
  const kHandle = resolveCont(t.k, env);
  const nBody = env.extend();
  nBody.vars.set(t.ret, {tag: "cont", fn: (v) => ({tag: "done", value: v})});
  function run(out: Outcome, kOuter: Cont): Outcome {
    if (out.tag === "done") {
      if (retC !== undefined) {
        const n = env.extend();
        n.vars.set(retC.params[0], out.value);
        n.vars.set(retC.resume, {tag: "native", fn: (_a, k2) => k2(out.value)});
        n.vars.set(t.exit, {tag: "cont", fn: kOuter});
        return evalTerm(retC.body, ir, n, kOuter);
      }
      return kOuter(out.value);
    }
    const h = handlers.get(out.op);
    if (h === undefined)
      return {tag: "eff", op: out.op, args: out.args, k: (v) => run(out.k(v), kOuter)};
    const resume: Native = {
      tag: "native",
      fn: (args, k2) => run(out.k(args[0] ?? null), k2),
    };
    const n = env.extend();
    n.vars.set(h.resume, resume);
    for (let i = 0; i < h.params.length; i++) n.vars.set(h.params[i], out.args[i] ?? null);
    n.vars.set(t.exit, {tag: "cont", fn: kOuter});
    return evalTerm(h.body, ir, n, kOuter);
  }
  return run(evalTerm(t.body, ir, nBody, kHandle), kHandle);
}

function resolveCont(a: CAtom, env: Env): Cont {
  if (a.t !== "var")
    throw new Error("internal: continuation operand must be a var");
  const v = env.lookup(a.name);
  if (v !== null && typeof v === "object" && v.tag === "cont") return v.fn;
  throw new Error("internal: not a continuation: " + a.name);
}

// Atoms materialize with their width stamp: i64/u64 literals from the raw
// lexeme (a JS number loses bits beyond 2^53), everything normalized exactly
// like the wasm backend's per-width values. Unstamped atoms pass through —
// operators then dispatch on the value's runtime representation.
function evalAtom(a: CAtom, env: Env): Value {
  if (a.t === "lit") {
    let v: Value = a.v;
    if (a.raw !== undefined && (a.stamp === "i64" || a.stamp === "u64")) v = BigInt(a.raw);
    return a.stamp !== undefined ? normWidth(v, a.stamp) : v;
  }
  const v = env.lookup(a.name);
  return a.stamp !== undefined ? normWidth(v, a.stamp) : v;
}

// Prims never suspend; they may throw (÷0, index out of bounds) — the throw
// propagates out of evalTerm like any runtime error did pre-CPS-IR.
function evalPrim(p: CPrim, env: Env): Value {
  switch (p.t) {
    case "op": {
      const a = evalAtom(p.args[0], env);
      const b = p.args.length > 1 ? evalAtom(p.args[1], env) : undefined;
      const v = widthOp(p.op, a, b, p.stamp);
      return p.norm !== undefined ? normWidth(v, p.norm) : v;
    }
    case "arr": {
      const vals = p.args.map(a => evalAtom(a, env));
      return p.kind === "tup" ? mkTup(vals) : mkSlice(vals);
    }
    case "as": {
      const v = evalAtom(p.arg, env);
      // @as conversion: float -> int truncates toward zero, bool -> numeric
      // gives 0/1; an f32 target rounds via the generic f32 stamp.
      let out: Value = v;
      if (p.asKind === "trunc") out = Math.trunc(num(v));
      else if (p.asKind === "boolnum") out = v === true ? 1 : 0;
      return p.stamp !== undefined ? normWidth(out, p.stamp) : out;
    }
    case "field": {
      const o = evalAtom(p.obj, env);
      const idx = p.idx;
      // Tuples index their fields; arrays index through the view's window.
      // Tuple indices are range-checked statically (types.ts's field case),
      // so only the runtime-sized slice window needs a bounds check here.
      if (o !== null && typeof o === "object" && o.tag === "tup")
        return o.elems[idx];
      const s = asSlice(o);
      if (idx < 0 || idx >= s.len || !Number.isInteger(idx))
        throw new Error(errIndexOOB("." + p.name, idx, s.len));
      return s.data[s.off + idx];
    }
    default:
      return assertNever(p);
  }
}

// Normalize a value to its stamped width's representation: i32 wraps via |0,
// u32 via >>>0, f32 rounds via fround, f64 is a plain number, i64/u64 are
// BigInt (exact beyond 2^53) wrapped mod 2^64 signed/unsigned. Non-numeric
// values (unit/bool/string/array/fn) pass through — stamps only exist on
// numeric-typed nodes, so this only guards polymorphic flow.
function normWidth(v: Value, nk: string): Value {
  if (typeof v !== "number" && typeof v !== "bigint") return v;
  switch (nk) {
    // BigInt values wrap through their exact bits (asIntN/asUintN) — a
    // Number detour would round beyond 2^53 before the mod-2^32 wrap and
    // diverge from the wasm backend's i32.wrap_i64.
    case "i32": return typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : v | 0;
    case "u32": return typeof v === "bigint" ? Number(BigInt.asUintN(32, v)) : v >>> 0;
    case "f32": return Math.fround(Number(v));
    case "f64": return Number(v);
    case "i64": return BigInt.asIntN(64, toBig(v));
    case "u64": return BigInt.asUintN(64, toBig(v));
    default: return v;
  }
}

function toBig(v: Value): bigint {
  return typeof v === "bigint" ? v : BigInt(Math.trunc(num(v)));
}

// Stamped operator application (all numeric ops except string `+`): coerce
// both operands to the stamp's representation and compute the raw
// mathematical result — the prim's norm wraps it to the width (i32 |0,
// f32 fround, i64/u64 asIntN/asUintN). Comparisons return bool. Integer /
// and % trap on ÷0 and INT_MIN÷-1 like wasm's div_s/rem ops; BigInt division
// truncates toward zero natively, so no Math.trunc needed.
function widthOp(op: string, a: Value, b: Value | undefined, nk: string): Value {
  const big = nk === "i64" || nk === "u64";
  if (op === OP_DIV || op === OP_REM) {
    if (big || nk === "i32" || nk === "u32") {
      const ba = toBig(a), bb = toBig(b!);
      if (bb === 0n) throw new Error(errDivByZero());
      if (op === OP_DIV && bb === -1n) {
        // Signed-width overflow: INT_MIN ÷ -1 has no in-width result (wasm
        // div_s traps). Unsigned widths can't hold INT_MIN — no trap.
        const min = nk === "i32" ? -(1n << 31n) : nk === "i64" ? -(1n << 63n) : null;
        if (min !== null && ba === min) throw new Error(errIntOverflow());
      }
      return op === OP_DIV ? ba / bb : ba % bb;
    }
    const na = Number(a), nb = Number(b);
    return op === OP_DIV ? na / nb : na % nb;
  }
  if (op === OP_EQ || op === OP_NE) {
    const eq = big ? toBig(a) === toBig(b!) : Number(a) === Number(b);
    return op === OP_EQ ? eq : !eq;
  }
  if (big) {
    const ba = toBig(a);
    if (op === OP_NEG) return -ba;
    const bb = toBig(b!);
    switch (op) {
      case OP_ADD: return ba + bb;
      case OP_SUB: return ba - bb;
      case OP_MUL: return ba * bb;
      case OP_LT: return ba < bb;
      case OP_GT: return ba > bb;
      case OP_LE: return ba <= bb;
      case OP_GE: return ba >= bb;
      default: return assertNever(op as never); // unreachable
    }
  }
  const x = Number(a);
  if (op === OP_NEG) return -x;
  const y = Number(b);
  switch (op) {
    case OP_ADD: return x + y;
    case OP_SUB: return x - y;
    case OP_MUL: return x * y;
    case OP_LT: return x < y;
    case OP_GT: return x > y;
    case OP_LE: return x <= y;
    default: return x >= y; // >=
  }
}

// Unhandled builtin effects fall through to the one table's default
// interpretation, keyed by op name (builtins.ts `builtinInterps`). The map
// is a top-level const there — entry-order safe only same-module; deriving
// it here instead would read `builtins` during eval's own init and be TDZ-
// sensitive in the eval⇄builtins import cycle.
function runTop(out: Outcome, interp?: EffectInterp): Value {
  while (true) {
    if (out.tag === "done")
      return out.value;
    // Builtin effect interpretation: when Read/Write/Println/Out reach the
    // top unhandled, perform real I/O and resume the continuation.
    const custom = interp?.[out.op];
    if (custom !== undefined) {
      out = custom(out.args, out.k);
      continue;
    }
    if (!(out.op in builtinInterps))
      throw new Error(errUnhandled(out.op));
    out = builtinInterps[out.op](out.args, out.k);
  }
}

// The ctx seam lives in pipeline.ts (prepared programs + runtime state);
// re-exported for the tests, the playground bridge, and bench.ts.
export {newCtx, type Ctx};

// exec: the pipeline the REPL and `run` share — evaluate an already-prepared
// program (prepare(src, ctx.checked) for REPL lines) in ctx's runtime env. Returns the last item's value (null after a pure
// declaration), its resolved type, and whether the program ends in a bare
// expression (the REPL echo rule: declarations print nothing).
export function exec(prog: Program, ctx: Ctx, checked: Checked): {value: Value, lastType: Type, lastIsExpr: boolean} {
  // Fail fast on statically unhandled ops before evaluating anything —
  // pipeline.ts's rejectUnhandled, the gate both backends apply right after
  // prepare: an op in `checked.unhandled` (performed with no matching
  // handler in its subtree) that neither the builtin table nor ctx.interp
  // covers would only surface in runTop mid-run, after earlier items' side
  // effects. Assign ctx.checked only after the check so a rejected line
  // leaves the REPL accumulator untouched, like a type error does.
  rejectUnhandled(checked, ctx.interp);
  ctx.checked = checked;
  // Bind builtins this program references that the env lacks yet (a later
  // REPL line can use a previously-unreferenced builtin; the checker's
  // no-shadowing rule keeps user bindings off builtin names, so seeding
  // never overwrites anything).
  seedBuiltins(ctx.env, builtinRefs(prog));
  // One conversion, one term, one runTop drive: items chain inside the term,
  // so an interp-resumed effect continues into the next item. Top-level
  // binds land in ctx.env (the items bind in the caller's frame),
  // preserving the REPL accumulator protocol.
  const ir = toCps(prog);
  let lastIsExpr = false;
  for (const it of prog.items)
    lastIsExpr = "e" in it ? prog.nodes[it.e].t !== "let" : false; // effect decl / alias: not echoable
  const value = runTop(evalTerm(ir.term, ir, ctx.env, v => ({tag: "done", value: v})), ctx.interp);
  return {value, lastType: ctx.checked.lastType, lastIsExpr};
}

// run: one-shot pipeline — prepare (parse + typecheck, before the
// interpreter runs), then evaluate a source string with fresh state. Throws
// on type error. `interp` optionally overrides the builtin interpretation of
// unhandled effects.
export function run(src: string, interp?: EffectInterp): Value {
  const {prog, checked} = prepare(src);
  return exec(prog, newCtx(interp), checked).value;
}

// runLine: the REPL's one-line protocol — prepare against ctx's checked
// accumulator (a type error throws here and leaves ctx.checked untouched),
// then exec (which assigns the accumulator and seeds the referenced
// builtins). The caller applies the echo rule to the returned triple —
// declarations print nothing. repl.ts and index.test.ts's line-driven exec
// tests share it.
export function runLine(ctx: Ctx, src: string): {value: Value, lastType: Type, lastIsExpr: boolean} {
  const {prog, checked} = prepare(src, ctx.checked);
  return exec(prog, ctx, checked);
}
