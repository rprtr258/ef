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
git clone https://github.com/rprtr258/ef.git && cd ef && bun install

bun compiler/cli.ts run examples/factorial.ef       # 120 — run on the interpreter
bun compiler/cli.ts runwasm examples/factorial.ef   # 120 — same, compiled to WebAssembly
bun compiler/cli.ts repl                            # interactive REPL; bindings persist across lines
```

`ef run` typechecks first, then evaluates; the last expression's value is
printed. Full command table (`buildwasm`, `types`, `lint`), the wasm target,
and REPL details: [CLI & REPL](docs/content/spec/cli.md). To open ef in the
browser: `cd playground && bun run dev`.

## Benchmarks

Run against [effect-handlers-bench](https://github.com/effect-handlers/effect-handlers-bench)
(OCaml 5.3 + multicont, Koka 2.4, Effekt 0.2.1/mlton) at identical inputs per
row — mean seconds over 10 hyperfine runs on one x86_64 Linux host, 2026-11-15.
ef's wasm backend is precompiled ahead of time (only instantiation + execution
timed, ~0.65 s bun host startup included); ef-interp ran a smaller input per row,
rescaled to the same workload via OCaml's measured scaling factor (values marked
`~`). ef's startup is a nontrivial share of each ef number; subtracting it
lowers the wasm-vs-OCaml geometric mean from ~31× to ~21×.

| benchmark | ocaml | koka | effekt | ef-wasm | ef-interp |
|---|---|---|---|---|---|
| countdown (10M) | 0.120 | 0.111 | 0.005 | 6.09 | ~15.6 |
| fibonacci_recursive (36) | 0.087 | 0.141 | 0.143 | 5.47 | ~52.6 |
| product_early (20k) | 0.044 | 0.806 | 0.104 | 5.47 | ~33.1 |
| iterator (8M) | 0.094 | 0.532 | 0.029 | 3.51 | ~19.3 |
| nqueens (10) | 0.050 | 0.178 | 0.007 | 1.74 | ~26 |
| generator (23) | 0.362 | 5.504 | — | 4.39 | ~85.3 |
| tree_explore (12) | 0.020 | 0.037 | 0.021 | 0.75 | ~6.4 |
| triples (300, 300) | 0.650 | 5.792 | 0.062 | 5.67 | ~29.8 |
| parsing_dollars (5000) | 0.209 | 0.614 | 0.014 | 5.80 | ~48.0 |
| resume_nontail (2000) | 0.078 | 0.768 | 0.029 | 1.74 | ~11.7 |
| handler_sieve (20000) | 0.647 | 0.810 | — | 11.16 | ~44.5 |

ef-wasm is ~21–31× slower than OCaml on geometric mean; the gap is smallest on
multi-resume benchmarks (triples 8.7×, generator 12×) where ef actually beats
Koka, and largest on per-iteration overhead (product_early ~124×, fibonacci
~63×). Effekt/mlton — which inlines handlers into tight loops via whole-program
optimization — is in a league of its own here.

## Documentation

- [Language spec](docs/content/spec/index.md) — the complete spec: syntax, typing
  rules, builtins, semantics, examples on disk. **The source of truth.**
- [CLI & REPL](docs/content/spec/cli.md) · [Linter](docs/content/spec/lint.md)
- [Compiler internals](docs/content/dev/index.md) — per-phase walkthrough:
  lexer → parser → checker → interpreter / wasm backend.

> **⚠ When the language changes**, update [the spec](docs/content/spec/index.md)
> (and this README's opening if the change is user-visible).


