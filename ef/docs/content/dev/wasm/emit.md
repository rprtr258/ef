# Emit

Fifth phase of the [backend pipeline](index.md#pipeline): turn every function
into instructions. One emission context; the expression dispatcher walks the
flat node slice, with statement and effect emitters alongside. Functions are
emitted in table order: helpers → lambdas → case fns → builtin trampolines →
main (+ thunks).

Tail positions keep tail calls (`return_call` / `return_call_indirect`) so
the continuation chain does not grow the native stack. f32 values round to
f32 precision at every producing node via a demote/promote round-trip.

## The split protocol

Every perform or handle site **ends the inline function body**: the code
after the site is reified as a separate rest-of-site fragment with its own
table slot. A perform boxes its arguments into the spill slot assigned by
[index assignment](indices.md), then walks the continuation chain for a
matching handler — dispatching to the case function — or escapes to the
host. When the effect resolves, the fragment runs with the resumed value;
the fragment is addressed through the continuation cell chain, so it is
*itself* resumable. The "rest of the program" is just another function.

Cell layout, frame pointers, and resume-as-value mechanics:
[Continuations and effects](index.md#continuations-and-effects).

Next: [Module & host](module.md).
