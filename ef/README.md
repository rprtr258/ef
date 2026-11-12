# ef

A tiny statically-typed language with **algebraic effects and effect
handlers**, C/Go-flavored syntax, and a Hindley-Milner-flavoured type system
that tracks effects — nondeterminism, backtracking, and generators are
ordinary code, and the compiler still rejects every ill-typed or
unhandled-effect program before it runs.

- **Algebraic effects.** Functions *perform* abstract operations instead of
  returning or throwing; `handle` blocks catch them and get the suspended
  computation as a resumable continuation `k` — callable zero, one, or many
  times.
- **Statically tracked.** Every function type carries its inferred effect set
  (`(i64) -> i64 ! { Emit }`); statically unhandled effects are rejected
  before evaluation starts. Handler resumes are checked too — over a body
  with no `Return` case and no perform on its spine, `k` must deliver the
  body's result type (so a double resume over a `map` loop is a compile
  error, not a corrupt array).
- **Two backends, one frontend.** A CPS interpreter and a WebAssembly (WasmGC)
  backend — no external toolchain — with identical observable output. Selective
  CPS conversion: functions with empty effect rows convert direct-style; mixed
  functions (internal handlers) keep the direct boundary.
- **Browser playground.** A multi-file ef studio: live parse/check/lint as
  you type, runs the wasm build in the browser's WebAssembly engine.
- **VS Code extension.** Syntax highlighting, checker diagnostics, hover
  types, and go-to-definition for `.ef` files (`vscode/` workspace; the
  language server also runs standalone via `ef lsp`).

```ef
effect Choose(opts: [i64]): i64;    # Choose yields an i64

handle {
  x :: Choose!([1, 2, 3]);          # pause, ask the handler
  y :: Choose!([10, 20]);
  [x, y]
} case Return(v) => k { [v] }       # what to do with the final value
  case Choose(opts) => k { flat(map(k, opts)) }  # try every option, resume each
# [[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]
```

The handler calls `k` once per option, so the computation branches into every
path — nondeterminism built from ordinary multi-shot resumption.

## Basic CLI usage

```sh
git clone https://github.com/rprtr258/lish.git && cd lish/ef && bun install

bun compiler/cli.ts run examples/factorial.ef       # 120 — run on the interpreter
bun compiler/cli.ts runwasm examples/factorial.ef   # 120 — same, compiled to WebAssembly
bun compiler/cli.ts repl                            # interactive REPL; bindings persist across lines
```

`ef run` typechecks first, then evaluates; the last expression's value is
printed. Full command table (`buildwasm`, `types`, `lint`), the wasm target,
and REPL details: [CLI & REPL](docs/content/cli.md). To open ef in the
browser: `cd playground && bun run dev`.

## Documentation

- [Language spec](docs/content/spec/index.md) — the complete spec: syntax, typing
  rules, builtins, semantics, examples on disk. **The source of truth.**
- [CLI & REPL](docs/content/cli.md) · [Linter](docs/content/lint.md)
- [Compiler internals](docs/content/dev/pipeline.md) — per-phase walkthrough:
  lexer → parser → checker → interpreter / wasm backend.

> **⚠ When the language changes**, update [the spec](docs/content/spec.md)
> (and this README's opening if the change is user-visible).


