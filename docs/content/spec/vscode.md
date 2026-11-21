# VS Code extension

Syntax highlighting, checker diagnostics, lint warnings, hover types, and
go-to-definition for `.ef` files, from the `vscode/` workspace. The extension bundles the
language server — built from the compiler's `lsp.ts`, the same server `ef lsp`
serves — so there is nothing to install beyond VS Code itself (≥ 1.91,
matching the bundled client/server pair).

The checker is fail-fast: diagnostics show **one error at a time**. Fix it and
the next one, if any, appears on the next edit. When the document checks,
lint warnings ([Linter](lint.md)) squiggle the binder each finding anchors at.

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
| Diagnostics | the whole document is re-parsed and typechecked on every change; a type error shows at its position with the checker's message; on a clean check, lint warnings (unused-arg, derived-any) underline the offending binder |
| Hover | the inferred type of the innermost checked subexpression under the cursor — sym references as `name : Type` at their instantiated type, effect names anywhere (decls, `! { … }` rows, performs, handler case labels) as the op's declared signature function-style with argument names (`Choose : () -> bool`, `Get : (v: i64) -> i64`), function names with their binder lambda's param names (builtins use the table's declared names, e.g. `map : (f: (a) -> b, xs: [a]) -> [b]`), alias names (decls, type uses) as their definition (`Point = [x: i64, y: i64]`, `Pair(a, b) = [fst: a, snd: b]`), binder sites as the bound value's type, everything else (literals, operators, calls, lambdas, `handle` blocks) as the bare type, including `! { … }` effect rows on function types — rendered as markdown in an `ef` code fence, so it's syntax-highlighted with the same grammar as the editor (user-defined type names stay uncoloured there: semantic tokens don't apply inside hover markdown) |
| Definition | the identifier under the cursor resolves per namespace: value names (sym uses, assign targets — and binder sites, which jump to themselves) to the unique binding (let name, destructuring field, lambda or handler-case param, resume binder); effect names (decls, `! { … }` rows, `Op!` performs, case labels) to their `effect` decl; alias names to their alias item |

## Behaviour and limits

- **One error at a time; warnings on clean checks.** `checkProgram` throws on
  the first error, so each pass reports at most one; lint warnings publish
  only when the document checks. A clean check publishes an empty list.
- **Not every error lands on its position.** Unification mismatches anchor at
  the offending expression; operator/width errors and parse errors carry no
  position and anchor at the document start.
- **Hover needs a clean check.** `checkProgram` throws on the first error, so
  a document with a parse or type error has no hover types at all. Keywords
  aren't expressions and have no type to show.
- **Definition is parse-only.** Unlike hover, go-to-definition works on
  documents that don't check: resolution is syntactic, leaning on the
  checker's no-shadowing rule (a non-`_` name has one binder document-wide).
  Builtins, operator names, and unknown identifiers resolve to nothing.
- **Unhandled top-level effects are not errors.** A program may leave effects
  for the runner to interpret; diagnostics only cover parse and type errors.

## Other editors

`ef lsp` runs the same server over stdio — point any LSP-speaking editor at
`bun compiler/cli.ts lsp`. See [CLI & REPL](cli.md#commands).

## Where to go

- [Language spec](index.md) — what the types and diagnostics mean.
- [CLI & REPL](cli.md) — `ef lsp`, plus every other subcommand.
