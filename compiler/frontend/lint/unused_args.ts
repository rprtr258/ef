import type {Loc} from "../lexer.ts";
import {type Expr, type ExprID, type Program} from "../parser.ts";
import {type Checked} from "../types.ts";
import {exprChildren, forEachBinder} from "../walk.ts";
import {assertNever} from "../../assert.ts";

type Issue = {who: string, argname: string, pos?: Loc};

// Visit every lambda in an expression, pre-order (exprChildren order).
// `fname` is the name of the enclosing binding when the lambda is the value
// of a `let`, else null.
function* visitLambdas(
  id: ExprID,
  prog: Program,
  fname: string | null,
): Generator<[lam: Expr & {t: "lambda"}, fname: string | null]> {
  const e = prog.nodes[id];
  if (e.t === "lambda") yield [e, fname];
  // A lambda's body opens a fresh anonymous scope; a let whose value is a
  // lambda names it; everything else descends nameless.
  const child = e.t === "lambda"
    ? null
    : e.t === "let" && prog.nodes[e.val].t === "lambda" ? e.name : null;
  for (const k of exprChildren(e))
    yield* visitLambdas(k, prog, child);
}

// Which of `watch` names are referenced (free) in `e`, accounting for shadowing
// by inner binders. `let` names bind only for following block siblings.
function freeUses(id: ExprID, prog: Program, watch: Set<string>): Set<string> {
  const out = new Set<string>();
  const go = (id: ExprID, w: Set<string>): void => {
    const e = prog.nodes[id];
    switch (e.t) {
    case "sym": if (w.has(e.v)) out.add(e.v); return;
    case "num": case "str": case "bool": case "unit": return;
    // The shadowing rules below are the rule's semantics, not child order —
    // each binder kind scopes differently (per-case for handles, siblings
    // for block lets) — so those variants stay hand-written; the binder sets
    // themselves come from forEachBinder.
    case "lambda": {
      const w2 = new Set(w);
      forEachBinder(e, prog.locs[id]?.start, n => w2.delete(n));
      go(e.body, w2);
      return;
    }
    case "let": {
      // The let's own name is watched inside its val (recursive-let rule).
      const w2 = new Set(w);
      forEachBinder(e, prog.locs[id]?.start, n => w2.add(n));
      go(e.val, w2);
      return;
    }
    case "dlet": {
      const w2 = new Set(w);
      forEachBinder(e, prog.locs[id]?.start, n => w2.delete(n));
      go(e.val, w2);
      return;
    }
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
      // dlet field names bind only inside the dlet's own val — they do not
      // shadow watched names for following siblings (checker-valid programs
      // can't produce that shape; only unchecked lint inputs see it).
      const w2 = new Set(w);
      for (const s of e.stmts) {
        go(s, w2);
        if (prog.nodes[s].t === "let") w2.delete(prog.nodes[s].name);
      }
      return;
    }
    // No binder-introducing variants: every child sees the same scope.
    case "assign": case "if": case "while": case "perform": case "app":
    case "arr": case "field": case "as":
      for (const k of exprChildren(e)) go(k, w);
      return;
    default:
      return assertNever(e);
    }
  };
  go(id, watch);
  return out;
}

// unused-arg: a function parameter never referenced in the body (scope-aware:
// inner lambda params, let bindings, dlet fields, and handler-case
// params/resume shadow the outer name and don't count as a use).
export default function*(prog: Program, _checked: Checked | undefined): Generator<Issue> {
  for (const [lam, fname] of prog.items.filter(it => "e" in it).flatMap(it => [...visitLambdas(it.e, prog, null)])) {
    const seen = new Set<string>();
    for (const p of lam.params) {
      if (seen.has(p.name) || p.name === "_")
        continue;
      seen.add(p.name);
      const used = freeUses(lam.body, prog, new Set([p.name]));
      if (used.size !== 0)
        continue;

      const who = fname !== null ? `function \`${fname}\`` : "anonymous function";
      yield {who, argname: p.name, pos: p.pos};
    }
  }
}
