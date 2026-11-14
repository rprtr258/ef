# Lexer

`lex(src: string): Tok[]` — a single pass from characters to a flat token
stream. Each token is `{v, pos}` where `pos` is a 1-indexed `{line, col}`.

The lexer is **newline-insensitive**: whitespace means nothing anywhere, so no
downstream phase ever needs layout information. Statements end with `;`.

## Rules, in scan order

| Order | Input | Token | Notes |
|-------|-------|-------|-------|
| 1 | space · tab · CR · LF | — | skipped |
| 2 | `#` … end of line | — | line comment, skipped |
| 3 | `"..."` | string | one token, raw text incl. quotes; escapes decoded later by the parser |
| 4 | two-char table | one token | `:: := == != <= >= && \|\| =>` — tried **before** the one-char table, so `::`/`:=` win over `:` and `==` wins over `=` |
| 5 | one-char table | one token | `( ) [ ] { } , ; < > + - * / ! = : % @` |
| 6 | `[0-9.]` run | number | digits and dots; `1.5` is one token, but so is the malformed `1.2.3` — the parser rejects that |
| 7 | `[A-Za-z_][A-Za-z0-9_]*` | identifier/keyword | keywords recognized by the parser against the `KEYWORDS` set (`fn if else while handle case true false unit effect type`) |
| 8 | anything else | — | `throw new Error("Bad char: …")` |

Order matters most at step 4/5: the declaration operators `::` and `:=` must
lex atomically **before** `:` (annotation), or `x :: f` would lex as
`x : : f`. Both tables are shared with the playground's line tokenizer — one
source of lexical truth for editor highlighting.

## Positions without counters

`lex` precomputes `lineStarts` (the index of every `\n`) once, then maps any
character offset to `{line, col}` by binary search. Threading counters through
the scanner loop would be easy to break with backtracking; a precomputed index
needs no per-token state.

```ts
const posAt = (i: number): Pos => {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; ... }
  return {line: lo + 1, col: i - lineStarts[lo] + 1};
};
```

Lexing is the only phase that looks at raw text, so every diagnostic downstream
(type errors, lint findings) carries a real 1-indexed position from here.

## A deliberate quirk: `->`

`->` is **not** a two-char token — it lexes as `-` then `>`, and the *type
parser* reassembles it when reading function types. Types
are parsed out of the same token stream, and reserving `->` would not help the
expression grammar, which never uses it.

## Output

```ef
x :: 41 + 1;
# → [sym x] [::] [num 41] [+] [num 1] [;]
```

Next: [Parser](parser.md).
