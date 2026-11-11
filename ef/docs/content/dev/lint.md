# Linter internals

`lint(src): LintIssue[]` — parse the program once, run the passes over the
parse result, report. Each finding carries the source position from the
[lexer](lexer.md), so every consumer (CLI, playground problems pane) prints
real line/col information.

```ts
const LINT_PASSES: ((items: Item[], nodes: Expr[]) => LintIssue[])[] = [lintUnusedArgs];
```

That array is the whole registration mechanism: a pass is a pure function
over the whole program — the item list plus the flat node slice — returning
its issues.

## Adding a pass

1. Write the pass as `(items, nodes) => LintIssue[]`. Child traversal over
   the node slice comes from the parser's `exprChildren`
   ([parser](parser.md)).
2. Append it to `LINT_PASSES`. Nothing else registers passes.
3. If the rule needs scope information, follow `unused-arg`'s approach: walk
   binding structure explicitly instead of matching names textually — a
   shadowing inner lambda parameter, a `:=`/`::` binding, or a handler-case
   parameter / `resume` must not count as a use of an outer binding.
4. `bun run ci` — add a test pinning the new finding.

The user-facing description of the current rules lives in the
[spec section](../spec/lint.md).
