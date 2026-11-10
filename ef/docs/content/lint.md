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

Named functions (`::` of a `fn`) are reported as `` function `name` ``; bare
lambdas as `anonymous function`. Every finding carries a source position.

The playground runs the same passes and shows findings in its problems pane.

How passes work internally and how to add one:
[Linter internals](dev/lint.md).
