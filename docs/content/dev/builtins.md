# Builtins

The builtin table is **the one source of truth** describing every ef builtin.
Adding a builtin means adding one entry — never seed anything ad hoc into the
checker or the runtime env. The table drives the checker (signatures), the
interpreter (runtime bindings), and the wasm host (effect interpretation).

## Four kinds

| Kind | Checking | Runtime binding | Examples |
|------|----------|-----------------|----------|
| `fn` | `t: Type \| thunk` — a thunk gives fresh vars per use (polymorphic) | lifted to a native: `k(fn(...args))` | `len`, `sub`, `sqrt`, `range` |
| `value` | `t` | bound as the value itself (`fn()`), not a native fn | `PI` |
| `native` | `t` | CPS fn: `(args, k) => Outcome` — calls ef closures mid-flight | `map`, `each`, `flatmap` |
| `effect` | `sig` (declared to the checker like a user effect) | default host interpretation | `Read`, `Write`, `Println`, `Out`, `Exit`, `Wait`, `Random` |

**Operators (`+ - * / % == neg …`) are *not* in the table**: the checker
special-cases them structurally, because no honest type signature exists for
them — `+` is overloaded per numeric width *and* string, and numeric ops are
width-strict. The full operator/builtin surface is in the
[spec](../spec/index.md#4-builtins); the `{name, params}` ABI both backends agree on
lives in [Analysis](analysis.md).

## Builtin effects and their default interpretations

Every `effect`-kind entry carries an `interp: (args, k) => Outcome` — the
CPS interpretation used when the effect reaches the top unhandled. Two derived
views of the same table:

| View | Shape | Consumer |
|------|-------|----------|
| `builtinInterps` | CPS: `(args, k) => Outcome` | `runTop` — interpreter side ([Interpreter](eval.md)) |
| `builtinEffectHosts` | direct-style: `(args) => Value` (unwraps the single synchronous `k` call) | wasm_run.ts's `hostFor` adapter ([Module & host](wasm/module.md)) |

| Effect | Default behaviour | Knob |
|--------|-------------------|------|
| `Read(path)` | `readFileSync(path)` | — |
| `Write(path, s)` | `writeFileSync(path, s)` | — |
| `Println(v)` | `console.log(show(v))` | — |
| `Out(s)` | `process.stdout.write(s)` | — |
| `Exit(code)` | `process.exit(code)` — never resumes | — |
| `Wait(secs)` | busy-wait (synchronous evaluator) | — |
| `Random()` | `Math.random()` | both backends interpret `Random` through this host |

Injectability: `runTop`/`run`/`newCtx` (interpreter) and `runWasm` (host)
accept an `EffectInterp` override checked **before** the builtin defaults —
tests inject fake fs/time/randomness there.

## Freshness

`builtins` is a fresh array per program: polymorphic thunks and closures are
never shared between programs. Combined with the checker's scheme thunks
(fresh type vars per use), one process can check/eval many programs in
isolation — which the test suite and the REPL rely on.

## Adding a builtin — the checklist

1. One entry in the builtin table (pick the kind; give `t` or `sig`).
2. If it is an `effect`: the analysis surface tables
   (`EFFECT_OPS`/`BUILTINS`) must be extended — the sync test fails
   until they are in sync.
3. `bun run ci` — the test suite is the executable form of the spec.

Next: [Interpreter (CPS)](eval.md).
