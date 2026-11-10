# Wasm phase: discover

First phase of the [backend pipeline](wasm.md#pipeline). One walk over the
checked program that produces the discovery record every later phase builds
on.

## What it collects

1. **Types.** The checker runs once more on the program (the interpreter may
   have run earlier in the same process); the `Checked` result is reused
   as-is — the backend never re-derives types.
2. **Effect ops.** The builtin effects are pre-seeded into the module's op
   table in table order; the program's performed and handled ops are then
   interned in first-appearance order, program ops following the builtins.
   The final op list is handed to the host so both sides agree on op
   numbering when an effect crosses the boundary. Discovery is *syntactic* —
   "which op names does the text mention", handled ops included (see
   [Analysis](analysis.md#two-kinds-of-which-ops) for the semantic
   counterpart).
3. **Handler presence.** A pre-scan records whether the program has handlers
   at all: handler-free programs get continuation chains with no case-table
   scan in dispatch.
4. **Scopes and slots.** Lexical scopes per lambda, `handle` case, and block,
   each mapping names to frame slots; lambda parameters first, then
   declarations and tuple fields in order.
5. **Literals.** Every number literal with its checker-stamped width (the
   key carries both — the f64 `0.1` and the f32 `0.1` are distinct statics)
   and every string literal.
6. **Split sites.** Every perform/handle site and every non-builtin call
   site — the places where emission must suspend (see
   [emit](wasm-emit.md#the-split-protocol)).

Next: [Optimize](wasm-optimize.md).
