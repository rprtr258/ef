// walk.ts — the shared traversal layer over parser.ts's expression trees.
// Child order is single-sourced in parser.ts's exprChildren (re-exported
// here as the primitive every walker recurses through: a node is visited
// before its children, a handler's case bodies after its body); binder
// sites are single-sourced in forEachBinder, mirroring the checker's
// checkBind call sites in types.ts. A walker that needs per-variant logic
// (scopes, operand classification) keeps its own exhaustive switch and
// recurses through these helpers, so child order and binder positions are
// each stated exactly once.
//
// Leaf module: imports only parser.ts (the AST) and assert.ts.

import {exprChildren, type Expr, type ExprID, type Program} from "./parser.ts";
import {assertNever} from "./assert.ts";

export {exprChildren};

// Call fn(name) for every name a node binds, in the checker's checkBind
// order (types.ts): a lambda's params, a let's own name, a dlet's field
// names, and a handler case's params (Return has one) then its resume
// binder, case by case. Callers add the names to their scope before walking
// the node's children — a binding is in scope in its own value (the
// checker's recursive-let rule).
export function forEachBinder(e: Expr, fn: (name: string) => void): void {
  switch (e.t) {
    case "lambda":
      for (const p of e.params)
        fn(p.name);
      return;
    case "let":
      fn(e.name);
      return;
    case "dlet":
      for (const f of e.fields)
        fn(f.name);
      return;
    case "handle":
      for (const cse of e.cases) {
        for (const p of cse.params)
          fn(p.name);
        fn(cse.resume);
      }
      return;
    case "assign": case "block": case "if": case "while": case "app":
    case "arr": case "field": case "as": case "perform":
    case "sym": case "num": case "str": case "bool": case "unit":
      return; // no binders
    default:
      return assertNever(e);
  }
}

// Pre-order visitor over every top-level item's expression tree: visit runs
// on a node before its children (exprChildren order). visit returns whether
// to keep walking — returning false stops the whole walk: the node's
// children and all remaining nodes are skipped.
export function visitExprs(
  prog: Program,
  visit: (e: Expr, id: ExprID) => boolean,
): void {
  const go = (id: ExprID): boolean => {
    const e = prog.nodes[id];
    if (!visit(e, id)) return false;
    for (const k of exprChildren(e))
      if (!go(k)) return false;
    return true;
  };
  for (const it of prog.items)
    if ("e" in it && !go(it.e)) return;
}
