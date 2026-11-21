# ef Language Support

Syntax highlighting, checker diagnostics, hover types, and go-to-definition for
[ef](https://github.com/rprtr258/ef) — a tiny statically-typed
language with algebraic effects and effect handlers.

- **Highlighting** — a TextMate grammar for `.ef`: keywords, `::`/`:=`
  bindings, numeric widths, `#` comments, strings, numbers, effect ops (`Op!`).
- **Diagnostics** — the document is parsed and typechecked on every change;
  the checker is fail-fast, so at most one error shows at a time. On a clean
  check, lint warnings (unused-arg, derived-any) underline the offending
  binder.
- **Hover types** — inferred types of top-level bindings and builtins.
- **Go-to-definition** — value names jump to their unique binding, effect
  names to their `effect` declaration, alias names to their alias item.

The language server is bundled (built from the compiler's `lsp.ts`); nothing
else to install. The same server also runs standalone as `ef lsp` for other
editors.
