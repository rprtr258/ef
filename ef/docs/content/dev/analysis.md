# Analysis

Frontend analysis passes over a parsed program, **shared by
both backends**: the wasm backend (tree-shaking, dead host-import elimination,
op-table seeding) and the interpreter (unhandled-op fail-fast, env seeding).
Nothing here emits bytecode or touches backend state — pure AST walks plus
the builtin-surface tables both backends agree on.

It is a **leaf in the dependency graph**: it depends only on parser types, so
both backends consume it without pulling in the evaluator, and initialization
order stays irrelevant. The test suite enforces that the surface tables here
stay in sync with the builtin table.

## What it exports, who eats it

| Export | Shape | Consumers | Job |
|--------|-------|-----------|-----|
| `OPERATOR_OPS` | set of op names | checker (stamping), wasm emitter | the operator surface (`+ - * % neg < > …`); sites the checker leaves unstamped fall back to the wasm dynamic trampoline |
| `EFFECT_OPS` | name list, op-table order | wasm op table | the 7 builtin effects, seeded at opids `0..n-1`; program ops intern after them |
| `BUILTINS` | `{name, params}` list | wasm builtins | the fixed-arity ABI both backends agree on |
| `performsAnyOp` | `Program → bool` | fast paths | does any subtree contain a `perform` |
| `collectEffectOps` | `Program → string[]` | wasm discovery | ops the program performs or handles, in first-appearance order (= wasm op-table order); **syntactic** — handled ops included |
| `builtinRefs` | `Program → Set<string>` | `exec` env seeding, wasm tree-shaking | shadowing-correct builtin references; binding order mirrors the checker |
| `builtinValueUses` | `Program → Set<string>` | wasm layout | builtins referenced as *values* (passed around, not called) |

<svg class="dgm" viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="analysis feeds both backends">
  <defs>
    <marker id="arra" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>
  <rect class="box acc" x="240" y="24" width="240" height="52" rx="8"/>
  <text x="360" y="45" text-anchor="middle" class="acc">analysis</text>
  <text x="360" y="63" text-anchor="middle" class="faint">leaf — parser types only</text>
  <rect class="box" x="32" y="120" width="300" height="52" rx="8"/>
  <text x="182" y="141" text-anchor="middle">interpreter</text>
  <text x="182" y="159" text-anchor="middle" class="faint">exec: fail-fast · seed builtinRefs</text>
  <rect class="box" x="388" y="120" width="300" height="52" rx="8"/>
  <text x="538" y="141" text-anchor="middle">wasm backend</text>
  <text x="538" y="159" text-anchor="middle" class="faint">OPT_PASSES: tree-shake · drop dead imports</text>
  <path class="arrow" marker-end="url(#arra)" d="M300 76 V96 H182 V116"/>
  <path class="arrow" marker-end="url(#arra)" d="M420 76 V96 H538 V116"/>
  <text x="32" y="190" class="faint">whole-program "which ops escape to the runner" is NOT here — that is the checker's Checked.unhandled</text>
</svg>

## Two kinds of "which ops?"

| Question | Answered by | Sees through calls? |
|----------|-------------|---------------------|
| Which op names does the program text mention (for the wasm op table)? | `collectEffectOps` — syntactic AST walk | no (doesn't need to: it interns names) |
| Which ops actually *escape* to the runner unhandled? | the checker's residual rows → `Checked.unhandled` ([Type checker](types.md)) | yes — ops-minus-handled matching through the type/effect tracking |

## Env seeding semantics

`exec` binds exactly `builtinRefs(prog)` into the runtime env per call:

- a later REPL line referencing a previously-unused builtin gets it seeded on
  that line;
- existing (user) bindings are **never** overwritten — shadowing-correct
  reference collection, binding order mirroring the checker's.

## CLI surface

The residual rows surface via `ef types` — the final `_ : T ! { ops }` line
shows exactly what the runner must interpret (or the run fails on).
See [CLI & REPL](../cli.md#type-info).

Next: [Builtins](builtins.md).
