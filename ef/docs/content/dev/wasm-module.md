# Wasm phase: module & host

Last stage of the [backend pipeline](wasm.md#pipeline): assemble the bytes,
shrink them, and run them.

## Module assembly

All artifacts — op table, [indices](wasm-indices.md), [statics](wasm-layout.md),
function bodies from [emit](wasm-emit.md) — are assembled into the module
through the binaryen API: type, global, table and element sections, the
exported `run` entry point, and the accessor functions the host needs. The
same build runs the in-process binaryen shrink pass (optimization level 2 —
matches `-Oz` size at about a third of the cost).

`EF_SKIP_WASM_OPT=1` bypasses the shrink pass: a binaryen abort is total
(every later compile fails until process exit), so there must be an escape
hatch.

Feature set: MVP + reference-types + GC + tail-call + sign-ext +
mutable-globals — exactly what the emitter emits, nothing more.

## Host runtime

JavaScript cannot read GC struct fields directly, so the module exports an
**accessor ABI** — the only way the host touches GC structs. Accessors come
in fixed groups; each group is one shape, initialized once at instantiation
and reused for every instance of that shape:

| Group | Accesses |
|-------|----------|
| `any` tagged values | tag check, untag, box a JS value |
| closures | fn slot, captured environment |
| frames | slots, frame pointer, return slot |
| numbers | unbox per width, box 64-bit ints |
| f32 / i32 / u32 / i64 / u64 casts | narrowing conversions |

64-bit integers cross the boundary as `BigInt` (JS numbers lose precision
past 2⁵³; ef's 64-bit ints are exact).

### Host imports

`ef_perform`, `ef_char`, `ef_number`, `ef_args`, `ef_cos`, `ef_sin`,
`ef_fail` — tree-shaken to the live set by [optimize](wasm-optimize.md);
`ef_fail` always stays.

Effects with no matching handler in the chain flow back through `ef_perform`
and are interpreted by the same builtin host table the interpreter uses
(optionally overridden via the runner's effect-interpretation argument), so
`Exit!` behaves identically in both backends: it terminates the process.
