// lint: run a sequence of lint passes over a parsed program and report issues.

import type {Pos} from "./lexer.ts";
import {Parser, type Expr, type Item} from "./parser.ts";

// Each pass is an (items) => LintIssue[]; add more passes to LINT_PASSES.
export type LintIssue =
  {rule: "unused-arg"; who: string, argname: string, pos?: Pos};

const LINT_PASSES: ((items: Item[]) => LintIssue[])[] = [lintUnusedArgs];

export function lint(src: string): LintIssue[] {
  const items = new Parser(src).parseProgram();
  return LINT_PASSES.flatMap(pass => pass(items));
}

// Visit every lambda in an expression. `fname` is the name of the enclosing
// binding when the lambda is the value of a `let`, else null.
function* visitLambdas(
  e: Expr,
  fname: string | null,
): Generator<[lam: Expr & {t: "lambda"}, fname: string | null]> {
  switch (e.t) {
  case "lambda":
    yield [e, fname];
    yield* visitLambdas(e.body, null);
    return;
  case "let":
    yield* visitLambdas(e.val, e.val.t === "lambda" ? e.name : null);
    return;
  case "assign":
    yield* visitLambdas(e.val, null);
    return;
  case "if":
    yield* visitLambdas(e.c, null);
    yield* visitLambdas(e.a, null);
    yield* visitLambdas(e.b, null);
    return;
  case "while":
    yield* visitLambdas(e.c, null);
    yield* visitLambdas(e.body, null);
    return;
  case "perform":
    for (const a of e.args)
      yield* visitLambdas(a, null);
    return;
  case "app":
    yield* visitLambdas(e.fn, null);
    for (const a of e.args)
      yield* visitLambdas(a, null);
    return;
  case "handle":
    yield* visitLambdas(e.body, null);
    for (const c of e.cases)
      yield* visitLambdas(c.body, null);
    return;
  case "block":
    for (const s of e.stmts)
      yield* visitLambdas(s, null);
    return;
  case "arr":
    for (const el of e.elems)
      yield* visitLambdas(el, null);
    return;
  case "field":
    yield* visitLambdas(e.obj, null);
    return;
  case "dlet":
    yield* visitLambdas(e.val, null);
    return;
  }
}

// Which of `watch` names are referenced (free) in `e`, accounting for shadowing
// by inner binders. `let` names bind only for following block siblings.
function freeUses(e: Expr, watch: Set<string>): Set<string> {
  const out = new Set<string>();
  const go = (e: Expr, w: Set<string>): void => {
    switch (e.t) {
    case "sym": if (w.has(e.v)) out.add(e.v); return;
    case "num": case "str": case "bool": case "unit": return;
    case "lambda": {
      const w2 = new Set(w);
      for (const p of e.params) w2.delete(p.name);
      go(e.body, w2);
      return;
    }
    case "let": { const w2 = new Set(w); w2.add(e.name); go(e.val, w2); return; }
    case "dlet": {
      const w2 = new Set(w);
      for (const f of e.fields) w2.delete(f.name);
      go(e.val, w2);
      return;
    }
    case "assign": go(e.val, w); return;
    case "if": go(e.c, w); go(e.a, w); go(e.b, w); return;
    case "while": go(e.c, w); go(e.body, w); return;
    case "perform": for (const a of e.args) go(a, w); return;
    case "app": go(e.fn, w); for (const a of e.args) go(a, w); return;
    case "arr": for (const el of e.elems) go(el, w); return;
    case "field": go(e.obj, w); return;
    case "handle":
      go(e.body, w);
      for (const c of e.cases) {
        const w2 = new Set(w);
        for (const p of c.params) w2.delete(p.name);
        w2.delete(c.resume);
        go(c.body, w2);
      }
      return;
    case "block": {
      const w2 = new Set(w);
      for (const s of e.stmts) {
        go(s, w2);
        if (s.t === "let") w2.delete(s.name);
      }
      return;
    }
    }
  };
  go(e, watch);
  return out;
}

// unused-arg: a function parameter never referenced in the body (scope-aware:
// inner lambda params, let bindings, and handler-case params/resume
// shadow the outer name and don't count as a use).
function lintUnusedArgs(items: Item[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const it of items.filter(it => "e" in it))
    for (const [lam, fname] of visitLambdas(it.e, null)) {
      const seen = new Set<string>();
      for (const p of lam.params) {
        if (seen.has(p.name) || p.name === "_")
          continue;
        seen.add(p.name);
        const used = freeUses(lam.body, new Set([p.name]));
        if (used.size === 0) {
          const who = fname ? `function \`${fname}\`` : "anonymous function";
          issues.push({rule: "unused-arg", who, argname: p.name, pos: p.pos});
        }
      }
    }
  return issues;
}
