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
  before either backend runs. Handler resumes are checked too — over a body
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
Choose :: effect(opts: [i64]): i64;    # Choose yields an i64

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
git clone https://github.com/rprtr258/ef.git && cd ef && bun install

bun compiler/cli.ts run examples/factorial.ef       # 120 — run on the interpreter
bun compiler/cli.ts runwasm examples/factorial.ef   # 120 — same, compiled to WebAssembly
bun compiler/cli.ts repl                            # interactive REPL; bindings persist across lines
```

`ef run` typechecks first, then evaluates; a file is an entrypoint, so it
must end in a unit-typed expression (see the entrypoint rule in
[§2.1](spec/index.md#21-grammar-overview)) — print a result with `Println!`.
Full command table (`wasm`, `types`, `lint`), the wasm target,
and REPL details: [CLI & REPL](docs/content/spec/cli.md). To open ef in the
browser: `cd playground && bun run dev`.

## Benchmarks

Run against [effect-handlers-bench](https://github.com/effect-handlers/effect-handlers-bench)
(OCaml 5.3 + multicont, Koka 2.4, Effekt 0.2.1/mlton) at identical inputs per
row — mean seconds over 10 hyperfine runs on one x86_64 Linux host, 2026-11-16.
ef's wasm backend is precompiled ahead of time (only instantiation + execution
timed, ~0.1 s bun host startup included); ef-interp ran a smaller input per row,
rescaled to the same workload via OCaml's measured scaling factor (values marked
`~`).

| benchmark | ocaml | koka | effekt | ef-wasm | ef-interp |
|---|---|---|---|---|---|
| countdown (10M) | 0.227 | 0.226 | 0.008 | 8.03 | ~27.3 |
| fibonacci_recursive (36) | 0.146 | 0.155 | 0.152 | 7.43 | ~28.5 |
| product_early (20k) | 0.062 | 0.968 | 0.209 | 0.125 | ~50.9 |
| iterator (8M) | 0.099 | 0.605 | 0.031 | 4.15 | ~10.3 |
| nqueens (10) | 0.083 | 0.201 | 0.007 | 1.89 | ~22.3 |
| generator (23) | 0.414 | 6.618 | — | 7.03 | ~30.9 |
| tree_explore (12) | 0.021 | 0.035 | 0.020 | 0.297 | ~2.7 |
| triples (300, 300) | 0.692 | 5.886 | 0.057 | 7.02 | ~29.9 |
| parsing_dollars (5000) | 0.172 | 0.611 | 0.014 | 7.56 | ~38.7 |
| resume_nontail (2000) | 0.081 | 0.780 | 0.030 | 2.26 | ~11.3 |
| handler_sieve (20000) | 0.679 | 0.971 | — | 20.23 | ~52.4 |

ef-wasm is ~21× slower than OCaml on geometric mean (~16× subtracting the host
startup); the gap is smallest on multi-resume benchmarks (triples 10×,
generator 17×) and largest on per-iteration overhead (fibonacci ~51×,
parsing_dollars ~44×), while product_early — startup-dominated in earlier
rounds — now sits at 2× OCaml. Effekt/mlton — which inlines handlers into
tight loops via whole-program optimization — is in a league of its own here.

## Documentation

- [Language spec](docs/content/spec/index.md) — the complete spec: syntax, typing
  rules, builtins, semantics, examples on disk. **The source of truth.**
- [CLI & REPL](docs/content/spec/cli.md) · [Linter](docs/content/spec/lint.md)
- [Compiler internals](docs/content/dev/index.md) — per-phase walkthrough:
  lexer → parser → checker → interpreter / wasm backend.

> **⚠ When the language changes**, update [the spec](docs/content/spec/index.md)
> (and this README's opening if the change is user-visible).


