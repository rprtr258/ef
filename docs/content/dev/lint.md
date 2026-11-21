# Linter internals

`lint(src): LintIssue[]` — parse the program once, typecheck best-effort, run
the passes, report. Passes receive the parse result and — when the program
checked cleanly — its `Checked` (per-node inferred types); a program that
fails to check still gets its AST-level passes. Each finding carries the
source position from the [lexer](lexer.md), so every consumer (CLI,
playground problems pane) prints real line/col information.

```ts
const LINT_PASSES = {
  "unused-arg": lintUnusedArgs,
  "derived-any": lintDerivedAny,
};
```

That record is the whole registration mechanism: an entry maps the rule name
to its pass. A pass is a pure function over the whole program — the node
slice plus, for type-aware rules, the checker's per-node types — a generator
yielding its findings without the rule name; `index.ts` owns the names and
tags every issue, so a pass never knows what it is called. The `LintIssue`
union is derived from the passes' generator yield types.

## Adding a pass

1. Write the pass as `function*(prog, checked): Generator<Issue>` —
   findings without a rule field, yielded one by one. Child traversal over
   the node slice comes from the parser's `exprChildren`
   ([parser](parser.md)). Type-aware rules guard on `checked === undefined`
   (the program didn't check) and return early.
2. Add an entry to `LINT_PASSES`. Nothing else registers passes.
3. If the rule needs scope information, follow `unused-arg`'s approach: walk
   binding structure explicitly instead of matching names textually — a
   shadowing inner lambda parameter, a `:=`/`::` binding, or a handler-case
   parameter / `resume` must not count as a use of an outer binding.
4. `bun run ci` — add a test pinning the new finding.

The user-facing description of the current rules lives in the
[spec section](../spec/lint.md).
