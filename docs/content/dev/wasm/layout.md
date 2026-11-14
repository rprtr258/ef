# Statics layout

Fourth phase of the [backend pipeline](index.md#pipeline): give every static
value a module global, deduplicated by kind and value.

| Static | Dedup key |
|--------|-----------|
| number literals | width + value (the f64 `0.1` and the f32 `0.1` are distinct) |
| string literals | text |
| `true` / `false` / unit | one each |
| `PI` | one |
| per-handler case tables | one per handle site |
| builtins referenced as values | one funcref global per builtin (call-only builtins are called directly through the table instead) |

Every global is immutable and initialized by a GC constant expression at
instantiation — no runtime initialization code for statics. Emitted code
references statics through the descriptors recorded here.

Next: [Emit](emit.md).
