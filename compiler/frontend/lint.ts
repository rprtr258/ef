// lint: run a sequence of lint passes over a parsed program and report issues.

import type {Loc} from "./lexer.ts";
import {Parser, type Expr, type ExprID, type Program} from "./parser.ts";
import {checkProgram, type Checked} from "./types.ts";
import {showT} from "./type_display.ts";
import type {Type} from "./unify.ts";
import {exprChildren, forEachBinder} from "./walk.ts";
import {assertNever} from "../assert.ts";

// Each pass is a (Program, Checked?) => LintIssue[]; add more passes to
// LINT_PASSES. `lint` typechecks best-effort first: a type-aware pass sees
// per-node inferred types, but a program that fails to check still gets its
// AST-level passes run (the unused-arg rules deliberately cover unchecked
// inputs like shadowing/duplicate params).
export type LintIssue =
  | {rule: "unused-arg", who: string, argname: string, pos?: Loc}
  | {rule: "derived-any", who: string, ty: string, pos?: Loc};

const LINT_PASSES: ((prog: Program, checked: Checked | undefined) => LintIssue[])[] =
  [lintUnusedArgs, lintDerivedAny];

export function lint(src: string): LintIssue[] {
  const prog = new Parser(src).parseProgram();
  let checked: Checked | undefined;
  try {
    checked = checkProgram(prog);
  } catch { /* unchecked programs still get their AST passes */ }
  return LINT_PASSES.flatMap(pass => pass(prog, checked));
}

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
function lintUnusedArgs(prog: Program, _checked: Checked | undefined): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const it of prog.items.filter(it => "e" in it))
    for (const [lam, fname] of visitLambdas(it.e, prog, null)) {
      const seen = new Set<string>();
      for (const p of lam.params) {
        if (seen.has(p.name) || p.name === "_")
          continue;
        seen.add(p.name);
        const used = freeUses(lam.body, prog, new Set([p.name]));
        if (used.size === 0) {
          const who = fname !== null ? `function \`${fname}\`` : "anonymous function";
          issues.push({rule: "unused-arg", who, argname: p.name, pos: p.pos});
        }
      }
    }
  return issues;
}

// derived-any: an unannotated binding whose inferred type contains `any` —
// the absorbing escape type propagating silently (from an `any`-typed param,
// an `[any]` element, a call through an `any`-typed function). An explicit
// annotation on the binding (or the `_` discard) silences it; a lambda-valued
// `::` binding is skipped too — its signature spells out the full type, so no
// any there is derived.
function lintDerivedAny(prog: Program, checked: Checked | undefined): LintIssue[] {
  if (checked === undefined) return [];
  const issues: LintIssue[] = [];
  // The inferred type of `id` when it contains `any`, displayed via
  // deepResAny (any-absorbed unbound vars render as any — a call through an
  // any-typed function leaves its result var unbound; see Unifier.anyVars).
  const anyTypeOf = (id: ExprID): Type | null => {
    const t = checked.nodeTypes[id];
    return t !== undefined && checked.uni.containsAny(t) ? checked.uni.deepResAny(t) : null;
  };
  for (let id = 0; id < prog.nodes.length; id++) {
    const e = prog.nodes[id];
    if (e.t === "let") {
      if (e.typ !== null || e.name === "_" || prog.nodes[e.val].t === "lambda")
        continue;
      const ty = anyTypeOf(e.val);
      if (ty !== null)
        issues.push({
          rule: "derived-any", who: `\`${e.name}\``, ty: showT(ty),
          pos: prog.locs[id]?.start,
        });
    } else if (e.t === "dlet") {
      const vt = anyTypeOf(e.val);
      if (vt === null) continue;
      for (const [i, f] of e.fields.entries()) {
        if (f.typ !== null || f.name === "_") continue;
        const ft = (vt.tag === "tup" ? vt.fields[i]?.type
          : vt.tag === "arr" ? vt.elem
          : null) ?? null;
        if (ft !== null && checked.uni.containsAny(ft))
          issues.push({
            rule: "derived-any", who: `field \`${f.name}\``, ty: showT(checked.uni.deepResAny(ft)),
            pos: f.pos,
          });
      }
    }
  }
  return issues;
}
