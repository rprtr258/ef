# Overview

ef is a tiny statically-typed language with **algebraic effects and effect
handlers**, C/Go-flavoured syntax, and a Hindley-Milner-flavoured type system
that tracks effects.

```ef
effect Choose(opts: [i64]): i64;

handle {
  x :: Choose!([1, 2, 3]);
  y :: Choose!([10, 20]);
  [x, y]
} case Return(v) => k {
  [v]
} case Choose(opts) => k {
  flat(map(k, opts))
}
# [[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]
```

The `Choose` handler calls `k` — the captured continuation — once per option,
so the computation branches into every path. Nondeterminism falls out of
ordinary multi-shot resumption.

## Where to go

| If you want to… | Read |
|---|---|
| Learn the language or look something up | [Language spec](spec/index.md) |
| Run the compiler | [CLI & REPL](spec/cli.md) — commands, the wasm target, the REPL, [linting](spec/lint.md) |
| Use ef in an editor | [VS Code extension](spec/vscode.md) — highlighting, diagnostics, hover types |
| Understand how the compiler works | [Compiler pipeline](dev/index.md), then the per-phase pages in the sidebar (wasm phases sit under [Wasm backend](dev/wasm/index.md)) |
| Add a builtin | [Builtins](dev/builtins.md) |
| Hack on the compiler | the page for the phase you are touching, starting from [Compiler pipeline](dev/index.md) |

## The shape of the project

- One compiler, two backends: a **CPS interpreter** (`ef run`) and a
  **WebAssembly backend** (`ef buildwasm` / `ef runwasm`), sharing the same
  frontend — lexer, parser, checker, analysis.
- The test suite is the executable form of the spec.
- [playground](spec/cli.md) — a browser studio for ef; this site reuses its theme.

Run ef from the repository root:

```sh
bun compiler/cli.ts run examples/star.ef   # interpreter
bun compiler/cli.ts repl                   # REPL
```
