# Optimize

Second phase of the [backend pipeline](index.md#pipeline): a fixed pass list
over the program, each pass reading the program and the
[discovery](discover.md) record and producing its own artifact.

| Pass | Job |
|------|-----|
| Tree-shake builtins | keep only the builtins the program actually references — collected shadowing-correctly by [analysis](../analysis.md), in binding order mirroring the checker. Call-only builtins are emitted as plain table entries; builtins referenced *as values* (passed around, not just called) additionally get closure pools. |
| Drop dead host imports | compute the live host-import set: only host functions for surviving builtins stay (the always-present fail import excepted). |

## Order is load-bearing

Funcref [index assignment](indices.md) depends on both artifacts: table
layout starts with the live imports, and the builtin trampolines cover the
surviving builtins — so both passes must run before any index exists.

Next: [Index assignment](indices.md).
