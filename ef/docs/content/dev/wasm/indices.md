# Index assignment

Third phase of the [backend pipeline](index.md#pipeline): assign every
function its slot in the module's single funcref table, in a deterministic
order (stable across runs):

1. live host imports (from [optimize](optimize.md)),
2. runtime helpers,
3. lambdas, in AST order,
4. handler case functions,
5. builtin trampolines, then land thunks,
6. main.

All ef functions share one uniform signature, so every table slot has the
same type and every dynamic call is a `call_indirect` through this table.
A side map records each index's concrete signature so direct calls resolve
their signature when emitting (see [emit](emit.md)).

This phase also assigns the **spill slots** the suspension machinery needs:
each perform's args cell, each handle's installed continuation cell, and the
already-computed values of impure sibling operands that ran before a split
deeper in the same expression. Spill slots are appended after a function's
named slots and folded into its frame size.

Next: [Statics layout](layout.md).
