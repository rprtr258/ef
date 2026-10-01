// A tiny interpreted language with algebraic effects, C/Go-flavoured syntax.
// Two passes: a static type checker (bidirectional + union-find unification,
// with monomorphic effect tracking), then a CPS evaluator whose continuation
// is a plain JS function — giving true multi-shot `resume`.

import {readFileSync, writeFileSync} from "node:fs";
import {checkProgram} from "./types.ts";
import {Env, show, type Cont, type Native, type Outcome, type Value, num, globalEnv, type Closure} from "./env.ts";
import {Parser, type Expr, type ExprID, type HandlerCase} from "./parser.ts";

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
export function evalE(id: ExprID, nodes: Expr[], env: Env, k: Cont): Outcome {
  const e = nodes[id];
  switch (e.t) {
    case "num":
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
      // `/` is stamped by the checker with int vs float division (the runtime
      // can't tell, since JS erases 7 and 7.0 to the same value).
      const fn = nodes[e.fn];
      if (fn.t === "sym" && fn.v === "/") {
        return evalArgs(e.args, nodes, env, [], (args) => {
          const a = args[0]!, b = args[1]!;
          const r = num(a) / num(b);
          return k(e.div === "int" ? Math.trunc(r) : r);
        });
      }
      return evalE(e.fn, nodes, env, (f) =>
        evalArgs(e.args, nodes, env, [], (args) => apply(f, args, k)),
      );
    }
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

export function runTop(out: Outcome): Value {
  while (true) {
    if (out.tag === "done")
      return out.value;
    // Builtin effect interpretation: when Read/Write/Println/Out reach the
    // top unhandled, perform real I/O and resume the continuation.
    switch (out.op) {
      case "Read": out = out.k(readFileSync(out.args[0] as string, "utf8")); break;
      case "Write": writeFileSync(out.args[0] as string, out.args[1] as string); out = out.k(null); break;
      case "Println": console.log(show(out.args[0] ?? null)); out = out.k(null); break;
      case "Out": process.stdout.write(out.args[0] as string); out = out.k(null); break;
      // Exit terminates the process without resuming; Wait blocks then resumes
      // with unit. Both are ordinary effects a handler can intercept.
      case "Exit": { process.exit(num(out.args[0])); }
      case "Wait": {
        const end = Date.now() + num(out.args[0]) * 1000;
        while (Date.now() < end) { /* busy-wait: synchronous CPS evaluator */ }
        out = out.k(null);
        break;
      }
      case "Random": out = out.k(Math.random()); break;
      default: throw new Error("Unhandled effect: " + out.op);
    }
  }
}

// run: typecheck first, then evaluate. Throws on type error.
export function run(src: string): Value {
  const prog = new Parser(src).parseProgram();
  checkProgram(prog);
  let last: Value = null;
  const g = globalEnv();
  for (const it of prog.items) {
    if ("e" in it)
      last = runTop(evalE(it.e, prog.nodes, g, (v) => ({tag: "done", value: v})));
  }
  return last;
}
