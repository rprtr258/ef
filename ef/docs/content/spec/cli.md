# CLI & REPL

Thin frontends over the [compiler pipeline](../dev/index.md) — none contains
language logic. Run from the repository root:

```sh
bun compiler/cli.ts run examples/star.ef
```

## Commands

| Command | Behaviour |
|---------|-----------|
| `ef run <file> [args...]` | Typecheck, then evaluate on the interpreter. Extra args reach the program via `args()`. The last expression's value is printed unless the program calls `Exit!` itself. |
| `ef buildwasm <file> [out]` | Compile to a binary `.wasm` module (default out: `<file>.ef` → `<file>.wasm`). |
| `ef runwasm <file>` | Compile and run on the embedded wasm host — same observable output as `ef run`. |
| `ef types <file>` | Print every top-level symbol with its inferred type, then the program's result type with its **residual effect row** (below). |
| `ef lint <file>` | Run the [linter](lint.md); exit 1 on findings. |
| `ef lsp` | Start the [language server](vscode.md) over stdio for LSP-speaking editors (VS Code and others). |
| `ef repl` | Interactive REPL. |

## Interpreter

`ef run` typechecks, then evaluates. Programs that loop forever (animations)
run until killed. Effects with no matching handler in the chain are
interpreted by the builtin table (or an injected override); a statically
unhandled op with nothing to interpret it is rejected before evaluation
starts — the same shared gate `ef runwasm` and `ef buildwasm` apply before
compilation.

## WebAssembly target

`ef runwasm` compiles the whole program to a binary WebAssembly module (no
external toolchain) and executes it in the host's WebAssembly engine. Output
matches `ef run` for the supported subset: values, control flow, closures,
arrays/strings, `handle` with multi-shot `resume`, and user effect ops.

An effect with no matching handler in the chain — builtin or user — reaches
the host and is interpreted by the same builtin host table `ef run` uses
(optionally overridden via the runner's effect-interpretation argument), so
`Exit!` behaves identically in both backends: it terminates the process.
The static gate `ef run` applies gates the wasm commands too: `ef runwasm`
and `ef buildwasm` reject a program whose residual ops neither the builtin
table nor the runner's interpreter override covers — before any module is
compiled, with the same message and nonzero exit.

Not supported: a perform or handle site inside an `if` branch or `while`
body — suspension across those control-flow blocks is rejected at compile
time (see [the wasm backend](../dev/wasm/index.md#continuations-and-effects)).

## Type info

`ef types <file>` prints each top-level symbol with its inferred type. The
final `_ : T ! { ops }` line is the whole program's residual effect row —
exactly the ops that would reach the runner unhandled; a run rejects on
precisely this set when nothing interprets it. See
[Analysis](../dev/analysis.md#two-kinds-of-which-ops) for how that differs from
syntactic op discovery.

## Language server

`ef lsp` runs the language server: syntax highlighting lives in the
[VS Code extension](vscode.md), while the server supplies its diagnostics
(the fail-fast checker, one error per change) and hover types. It is the same
process the extension bundles; running it from the CLI makes it available to
any LSP-speaking editor.

## REPL

One session, one accumulating context; each line is parsed and executed as a
complete program (ef is newline-insensitive, so multi-statement blocks fit
on one line):

| Behaviour | Detail |
|-----------|--------|
| Bindings accumulate | both the runtime env and the type env persist across lines; rebinding a name (or binding a builtin's name) is an error — ef has no shadowing |
| Echo rule | a bare expression prints `value : type` (e.g. `1 + 2` → `3 : i64`); declarations print nothing |
| Rejected lines | a type error or unhandled-effect rejection leaves the accumulator untouched — the session continues with the last good state |
| Late builtins | a later line may reference a builtin it never mentioned before — it is seeded into the env on that line |
| `:q` / `:quit` | exits |
| Error display | the error's message is printed, the loop continues |
