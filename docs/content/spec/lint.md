# Linter

`ef lint <file>` parses the program, runs the lint passes, and prints each
finding as `rule: message`; the command exits 1 when anything was found.

```sh
bun compiler/cli.ts lint examples/amb.ef
```

## Rules

| Rule | Finding |
|------|---------|
| `unused-arg` | a function parameter never referenced in its body. Scope-aware: a name shadowed by an inner lambda parameter, a `:=`/`::` binding, or a handler-case parameter / `resume` does not count as a use of the outer argument. |
| `derived-any` | a binding (let or destructure field) whose inferred type contains `any` without an explicit annotation — `any` propagated from an `any`-typed parameter, an `[any]` element, or a call through an `any`-typed function. An explicit type annotation on the binding, or the `_` discard, silences it; a lambda-valued `::` binding is skipped (its signature spells out the full type). |

Named functions (`::` of a `fn`) are reported as `` function `name` ``; bare
lambdas as `anonymous function`. Every finding carries a source position.

The playground runs the same passes and shows findings in its problems pane.

How passes work internally and how to add one:
[Linter internals](../dev/lint.md).
