// A tiny interpreted language with algebraic effects, C/Go-flavoured syntax.
// Two passes: a static type checker (bidirectional + union-find unification,
// with monomorphic effect tracking), then a CPS evaluator whose continuation
// is a plain JS function — giving true multi-shot `resume`.

import {checkProgram, type Checked, type Type} from "./types.ts";
import {Env, show, type Cont, type Native, type Outcome, type Value, num, globalEnv, seedBuiltins, type Closure} from "./env.ts";
import {builtinRefs} from "./analysis.ts";
import {Parser, type Expr, type ExprID, type HandlerCase, type Program} from "./parser.ts";
import {assertNever} from "./assert.ts";
import {builtinInterps} from "./builtins.ts";

function isNative(v: Value): v is Native {
  return v !== null && typeof v === "object" && !Array.isArray(v) && v.tag === "native";
}
function isClosure(v: Value): v is Closure {
  return v !== null && typeof v === "object" && !Array.isArray(v) && v.tag === "fn";
}

export function apply(f: Value, args: Value[], k: Cont): Outcome {
  if (isNative(f))
    return f.fn(args, k);
  if (isClosure(f)) {
    const n = f.env.extend();
    for (let i = 0; i < f.params.length; i++)
      n.vars.set(f.params[i], args[i] ?? null);
    return evalE(f.body, f.nodes, n, k);
  }
  throw new Error("Not callable: " + show(f));
}

// Evaluator (CPS). `id` indexes into the program's flat node slice `nodes`.
function evalE(id: ExprID, nodes: Expr[], env: Env, k: Cont): Outcome {
  // Width normalization: the checker stamps every node whose type is a
  // numeric width (concrete widths as-is, untyped literals defaulted to
  // i64/f64); the node's value is normalized to that width's runtime
  // representation exactly like the wasm backend's per-width ops. Unstamped
  // nodes (polymorphic uses) pass values through — operators then dispatch
  // on the value's runtime representation.
  const nk = (nodes[id] as Expr & { numKind?: string }).numKind;
  if (nk === undefined) return evalEInner(id, nodes, env, k);
  return evalEInner(id, nodes, env, (v) => k(normWidth(v, nk)));
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
// mathematical result — evalE's normWidth wraps it to the width (i32 |0,
// u32 >>>0, f32 fround, i64/u64 asIntN/asUintN). Comparisons return bool.
// Integer / and % trap on ÷0 and INT_MIN÷-1 like wasm's div_s/rem ops;
// BigInt division truncates toward zero natively, so no Math.trunc needed.
const NUM_OPS = new Set(["+", "-", "*", "<", ">", "<=", ">=", "==", "!=", "neg"]);

function widthOp(op: string, a: Value, b: Value | undefined, nk: string): Value {
  const big = nk === "i64" || nk === "u64";
  if (op === "/" || op === "%") {
    if (big || nk === "i32" || nk === "u32") {
      const ba = toBig(a), bb = toBig(b!);
      if (bb === 0n) throw new Error("integer divide by zero");
      if (op === "/" && bb === -1n) {
        // Signed-width overflow: INT_MIN ÷ -1 has no in-width result (wasm
        // div_s traps). Unsigned widths can't hold INT_MIN — no trap.
        const min = nk === "i32" ? -(1n << 31n) : nk === "i64" ? -(1n << 63n) : null;
        if (min !== null && ba === min) throw new Error("integer overflow");
      }
      return op === "/" ? ba / bb : ba % bb;
    }
    const na = Number(a), nb = Number(b);
    return op === "/" ? na / nb : na % nb;
  }
  if (op === "==" || op === "!=") {
    const eq = big ? toBig(a) === toBig(b!) : Number(a) === Number(b);
    return op === "==" ? eq : !eq;
  }
  if (big) {
    const ba = toBig(a);
    if (op === "neg") return -ba;
    const bb = toBig(b!);
    switch (op) {
      case "+": return ba + bb;
      case "-": return ba - bb;
      case "*": return ba * bb;
      case "<": return ba < bb;
      case ">": return ba > bb;
      case "<=": return ba <= bb;
      case ">=": return ba >= bb;
      default: return assertNever(op as never); // unreachable
    }
  }
  const x = Number(a);
  if (op === "neg") return -x;
  const y = Number(b);
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "<": return x < y;
    case ">": return x > y;
    case "<=": return x <= y;
    default: return x >= y; // >=
  }
}

function evalEInner(id: ExprID, nodes: Expr[], env: Env, k: Cont): Outcome {
  const e = nodes[id];
  switch (e.t) {
    case "num": {
      // i64/u64-stamped integer literals evaluate to BigInt from the raw
      // lexeme — JS numbers lose the low bits beyond 2^53. The width stamp
      // normalizes (asIntN/asUintN), as does every read of the value at an
      // i64/u64-typed site.
      if (!e.isFloat && (e.numKind === "i64" || e.numKind === "u64"))
        return k(BigInt(e.raw ?? String(e.v)));
      return k(e.v);
    }
    case "str":
    case "bool":
      return k(e.v);
    case "unit":
      return k(null);
    case "sym":
      return k(env.lookup(e.v));
    case "lambda":
      return k({tag: "fn", params: e.params.map(p => p.name), body: e.body, nodes, env, typ: e.typ});
    case "let":
      env.vars.set(e.name, null);
      return evalE(e.val, nodes, env, (v) => {
        env.vars.set(e.name, v);
        return k(null);
      });
    case "if":
      return evalE(e.c, nodes, env, (c) =>
        evalE(c !== false && c !== null ? e.a : e.b, nodes, env, k),
      );
    case "while": {
      const loop = (): Outcome =>
        evalE(e.c, nodes, env, (c) =>
          c !== false && c !== null
            ? evalE(e.body, nodes, env, () => loop())
            : k(null),
        );
      return loop();
    }
    case "assign":
      return evalE(e.val, nodes, env, (v) => {
        env.assignVar(e.name, v);
        return k(null);
      });
    case "block": {
      const n = env.extend();
      return evalSeq(e.stmts, 0, nodes, n, k);
    }
    case "perform":
      return evalArgs(e.args, nodes, env, [], (args) => ({tag: "eff", op: e.op, args, k}));
    case "handle":
      return handle(e.body, nodes, e.cases, env, k);
    case "as":
      // @as conversion: float -> int truncates toward zero, bool -> numeric
      // gives 0/1; an f32 target rounds via evalE's generic f32 stamp.
      return evalE(e.e, nodes, env, (v) => {
        if (e.asKind === "trunc") return k(Math.trunc(num(v)));
        if (e.asKind === "boolnum") return k(v === true ? 1 : 0);
        return k(v);
      });
    case "arr":
      return evalArgs(e.elems, nodes, env, [], (vals) => k(vals));
    case "field":
      return evalE(e.obj, nodes, env, (o) => {
        const a = o as Value[];
        const idx = e.idx!;
        if (idx < 0 || idx >= a.length || !Number.isInteger(idx))
          throw new Error(`.${e.name}: index ${idx} out of bounds [0, ${a.length})`);
        return k(a[idx]);
      });
    case "dlet":
      return evalE(e.val, nodes, env, (v) => {
        const a = v as Value[];
        for (let i = 0; i < e.fields.length; i++) env.vars.set(e.fields[i].name, a[i]);
        return k(null);
      });
    case "app": {
      // Operator application dispatches on the app node's width stamp (the
      // checker stamps the result width; operands are strict same-width or
      // untyped literals that defaulted). The stamp decides the operand
      // representation — BigInt for i64/u64, JS number otherwise — which
      // value dispatch alone can't (an i64-stamped literal 100 in an f64
      // context must coerce DOWN, not truncate the f64 up). `/` and `%` add
      // the int/float division stamp: integer division truncates and traps
      // on ÷0 and INT_MIN÷-1 exactly like wasm's div/rem ops; unstamped
      // (polymorphic) operator apps fall through to the value-dispatch
      // natives in env.ts (string +, polymorphic ==, untyped / %).
      const fn = nodes[e.fn];
      if (fn.t === "sym") {
        const op = fn.v;
        const nk = e.numKind;
        if (op === "/" || op === "%") {
          const wnk = nk ?? e.div ?? "f64";
          return evalArgs(e.args, nodes, env, [], (args) => k(widthOp(op, args[0], args[1], wnk)));
        }
        if (nk !== undefined && NUM_OPS.has(op))
          return evalArgs(e.args, nodes, env, [], (args) => k(widthOp(op, args[0], args[1], nk)));
      }
      return evalE(e.fn, nodes, env, (f) =>
        evalArgs(e.args, nodes, env, [], (args) => apply(f, args, k)),
      );
    }
    default:
      return assertNever(e);
  }
}

function evalArgs(args: ExprID[], nodes: Expr[], env: Env, acc: Value[], k: (vals: Value[]) => Outcome): Outcome {
  if (acc.length === args.length)
    return k(acc);
  return evalE(args[acc.length], nodes, env, (v) => evalArgs(args, nodes, env, [...acc, v], k));
}

function evalSeq(stmts: ExprID[], i: number, nodes: Expr[], env: Env, k: Cont): Outcome {
  if (i >= stmts.length)
    return k(null);
  if (i === stmts.length - 1)
    return evalE(stmts[i], nodes, env, k);
  return evalE(stmts[i], nodes, env, () => evalSeq(stmts, i + 1, nodes, env, k));
}

function handle(body: ExprID, nodes: Expr[], cases: HandlerCase[], env: Env, k: Cont): Outcome {
  const handlers = new Map(cases.map(c => [c.op, c]));
  const ret = handlers.get("Return");
  function run(out: Outcome, kOuter: Cont): Outcome {
    if (out.tag === "done") {
      if (ret !== undefined) {
        const n = env.extend();
        n.vars.set(ret.params[0].name, out.value);
        n.vars.set(ret.resume, {tag: "native", fn: (_a, k2) => k2(out.value)});
        return evalE(ret.body, nodes, n, kOuter);
      }
      return kOuter(out.value);
    }
    const h = handlers.get(out.op);
    if (h === undefined) {
      return {tag: "eff", op: out.op, args: out.args, k: (v) => run(out.k(v), kOuter)};
    }
    const resume: Native = {
      tag: "native",
      fn: (args, k2) => run(out.k(args[0] ?? null), k2),
    };
    const n = env.extend();
    n.vars.set(h.resume, resume);
    for (let i = 0; i < h.params.length; i++) n.vars.set(h.params[i].name, out.args[i] ?? null);
    return evalE(h.body, nodes, n, kOuter);
  }
  return run(evalE(body, nodes, env, (v) => ({tag: "done", value: v})), k);
}

// An effect interpreter: ops it knows map to host actions; unknown ops fall
// through to the builtin table's default interpretation.
export type EffectInterp = Partial<Record<string, (args: Value[], k: Cont) => Outcome>>;

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
      throw new Error("Unhandled effect: " + out.op);
    out = builtinInterps[out.op](out.args, out.k);
  }
}

// Pipeline state for incremental execution (REPL): runtime env, checker
// accumulator, and an optional effect-interpretation override.
export type Ctx = {
  env: Env,
  checked: Checked,
  interp?: EffectInterp,
};

// newCtx: fresh pipeline state, seeded with the builtins.
export function newCtx(interp?: EffectInterp): Ctx {
  return {
    // Seeded empty: exec binds exactly the builtins each program references
    // (builtinRefs), matching the wasm module's tree-shaken builtin table.
    env: globalEnv(new Set()),
    checked: checkProgram({nodes: [], items: [], typeToks: [], ends: []}),
    interp,
  };
}

// exec: the pipeline the REPL and `run` share — evaluate an already-checked
// program (`checked = checkProgram(prog, ctx.checked)` for REPL lines) in
// ctx's runtime env. Returns the last item's value (null after a pure
// declaration), its resolved type, and whether the program ends in a bare
// expression (the REPL echo rule: declarations print nothing).
export function exec(prog: Program, ctx: Ctx, checked: Checked): {value: Value, lastType: Type, lastIsExpr: boolean} {
  // Fail fast on statically unhandled ops before evaluating anything: an op
  // in `checked.unhandled` (performed with no matching handler in its
  // subtree) that is neither a builtin effect nor covered by ctx.interp
  // would only surface in runTop mid-run, after earlier items' side
  // effects. Assign ctx.checked only after the check so a rejected line
  // leaves the REPL accumulator untouched, like a type error does.
  for (const op of checked.unhandled)
    if (!(op in builtinInterps) && ctx.interp?.[op] === undefined)
      throw new Error("Unhandled effect: " + op);
  ctx.checked = checked;
  // Bind builtins this program references that the env lacks yet (a later
  // REPL line can use a previously-unreferenced builtin; the checker's
  // no-shadowing rule keeps user bindings off builtin names, so seeding
  // never overwrites anything).
  seedBuiltins(ctx.env, builtinRefs(prog));
  let value: Value = null;
  let lastIsExpr = false;
  for (const it of prog.items) {
    if ("e" in it) {
      value = runTop(evalE(it.e, prog.nodes, ctx.env, v => ({tag: "done", value: v})), ctx.interp);
      lastIsExpr = prog.nodes[it.e].t !== "let";
    } else {
      lastIsExpr = false; // effect decl / alias: not an echoable expression
    }
  }
  return {value, lastType: ctx.checked.lastType, lastIsExpr};
}

// run: one-shot pipeline — parse, typecheck (before the interpreter runs),
// and evaluate a source string with fresh state. Throws on type error.
// `interp` optionally overrides the builtin interpretation of unhandled effects.
export function run(src: string, interp?: EffectInterp): Value {
  const prog = new Parser(src).parseProgram();
  return exec(prog, newCtx(interp), checkProgram(prog)).value;
}
