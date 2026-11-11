# VS Code extension

Syntax highlighting, checker diagnostics, and hover types for `.ef` files,
from the `vscode/` workspace. The extension bundles the language server —
built from the compiler's `lsp.ts`, the same server `ef lsp` serves — so there
is nothing to install beyond VS Code itself (≥ 1.91, matching the bundled
client/server pair).

The checker is fail-fast: diagnostics show **one error at a time**. Fix it and
the next one, if any, appears on the next edit.

## Install

The extension is not published to a marketplace. Two ways to run it from the
repository (build first either way):

```sh
cd vscode && bun run build     # emits dist/extension.cjs + dist/server.cjs
```

- **Try it in a dev host** — from the `ef/` root:
  `code --extensionDevelopmentPath="$PWD/vscode"` opens a VS Code window with
  the extension loaded.
- **Install it** — package a `.vsix` and install it through the Extensions
  view (*Install from VSIX…*):
  `cd vscode && bunx @vscode/vsce package`

## What you get

| Feature | Behaviour |
|---------|-----------|
| Highlighting | TextMate grammar (keywords, `::`/`:=` bindings, `#` comments, strings, numbers) plus **semantic tokens** from the language server: user-defined type names (`Pair :: …`), type parameters, builtin prims, effect names (decls, `! { … }` rows, `Op!` performs, case labels), and **value identifiers coloured by their inferred type** — `collect` in function colour, variables in variable colour |
| Diagnostics | the whole document is re-parsed and typechecked on every change; a type error shows at its position with the checker's message |
| Hover | the inferred type of the innermost checked subexpression under the cursor — sym references as `name : Type` at their instantiated type, effect names anywhere (decls, `! { … }` rows, performs, handler case labels) as the op's declared signature function-style (`Choose : () -> bool`), binder sites as the bound value's type, everything else (literals, operators, calls, lambdas, `handle` blocks) as the bare type, including `! { … }` effect rows on function types — rendered as markdown in an `ef` code fence, so it's syntax-highlighted with the same grammar as the editor (user-defined type names stay uncoloured there: semantic tokens don't apply inside hover markdown) |

## Behaviour and limits

- **One diagnostic at a time.** `checkProgram` throws on the first error, so
  each pass reports at most one; a clean check publishes an empty list.
- **Not every error lands on its position.** Unification mismatches anchor at
  the offending expression; operator/width errors and parse errors carry no
  position and anchor at the document start.
- **Hover needs a clean check.** `checkProgram` throws on the first error, so
  a document with a parse or type error has no hover types at all. Keywords
  aren't expressions and have no type to show.
- **Unhandled top-level effects are not errors.** A program may leave effects
  for the runner to interpret; diagnostics only cover parse and type errors.

## Other editors

`ef lsp` runs the same server over stdio — point any LSP-speaking editor at
`bun compiler/cli.ts lsp`. See [CLI & REPL](cli.md#commands).

## Where to go

- [Language spec](index.md) — what the types and diagnostics mean.
- [CLI & REPL](cli.md) — `ef lsp`, plus every other subcommand.
