# Interpreter (CPS)

The CPS evaluator plus the execution pipeline shared by `ef run`
and the REPL.

## Why CPS

The continuation is a **plain JS function**, so `resume` is genuinely
multi-shot: the handler may call `k` zero, one, or many times, and each call
re-runs the rest of the computation. Generators can't do this — they are
single-use; CPS makes nondeterminism (`Choose`-style search, backtracking) a
plain loop over `k`.

Because everything is tail-call structured, JSC's TCO keeps the JS stack O(1)
for tail calls; non-tail recursion allocates heap frames instead of stack
frames (slow, but no stack overflow).

The conversion is **selective**: a function whose resolved effect row is empty
and whose body has no suspending call in its tail chain converts
direct-style — its boundary delivers with `dret` instead of jumping `$ret`,
and calls to classified-pure callees are `dcall`s that bind results in-frame.
A mixed function — empty row with internal handlers — keeps the direct
boundary: its handler islands run over the ambient chain like any CPS region,
and the tail handler's continuation resolves to the caller's continuation at
runtime.

## Core shapes

| Shape | Meaning |
|-------|---------|
| `Value` | `null · number · bigint · string · boolean · Value[] · Closure · Native` |
| `Closure` | `{params, fun, ir, env, typ?}` — `fun` indexes the closure's **own CPS IR** function table, so closures stay valid across REPL lines and programs |
| `Native` | `{fn: (args, k) => Outcome}` — CPS builtins |
| `Cont` | `(Value) => Outcome` |
| `Outcome` | `{tag: "done", value}` or `{tag: "eff", op, args, k}` — a trapped effect |

`evalTerm(t, ir, env, k)` dispatches over the CPS IR term;
`apply(f, args, k)` dispatches native vs closure (a `dcall` whose callee is a
direct closure applies it inline at the site instead).

## Width normalization

The checker stamps every numeric node with its width (`numKind`); the CPS IR
carries those stamps as `norm` marks on the bind sites (prim results, `bind`s,
continuation parameters, dcall results). `normWidth` normalizes the produced
value exactly like the wasm backend's per-width ops:

| Stamp | Normalization |
|-------|---------------|
| `i32` | `v \| 0` (BigInt input: `Number(BigInt.asIntN(32, v))`) |
| `u32` | `v >>> 0` / `asUintN` |
| `f32` | `Math.fround(v)` |
| `f64` | plain number |
| `i64` / `u64` | `BigInt.asIntN/asUintN(64, …)` — exact beyond 2^53 |

Unstamped nodes (polymorphic uses) pass values through; operators then
dispatch on the runtime representation. `widthOp` itself never converts
between widths: the checker resolves literal widths per site, so a stamped
operator's operands arrive already in its representation (divergent reads
— one untyped binding read at several widths — carry `adaptFrom` and are
adapted at the read, not the op).

## Effects and handlers

`handle(body, cases, env, k)` evaluates the body with a terminal continuation;
every `Outcome` it produces flows into `run(out, kOuter)`:

- **`done`** → the `Return` case binds the value (and a `resume` that just
  re-returns it) and evaluates the case body under `kOuter`; with no `Return`
  case, the value passes to `kOuter` unchanged.
- **`eff` with a matching case** → the case body runs with the effect's
  params bound and `resume` bound to
  `run(out.k(args[0]), k2)` — *the captured continuation is the resume*.
  Because `out.k` is a plain closure, calling it repeatedly is multi-shot
  resume.
- **`eff` with no matching case** → the outcome is re-thrown **outward with a
  wrapped continuation**: `k: (v) => run(out.k(v), kOuter)`. When an outer
  handler eventually resumes, the wrap re-enters this frame's chain — deep
  handlers, with lookup resolved outward at bubble time.

<svg class="dgm" viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="effect handling walk">
  <defs>
    <marker id="arre" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>
  <rect class="box acc" x="170" y="20" width="380" height="46" rx="8"/>
  <text x="360" y="40" text-anchor="middle" class="acc">run — handler frame</text>
  <text x="360" y="56" text-anchor="middle" class="faint">handle { body } case Choose(lo, hi) => k { … }</text>
  <rect class="box" x="170" y="96" width="380" height="38" rx="8"/>
  <text x="360" y="120" text-anchor="middle" class="faint">k — continuation frames (plain JS closures)</text>
  <rect class="box" x="170" y="152" width="380" height="38" rx="8"/>
  <text x="360" y="176" text-anchor="middle" class="faint">k — …</text>
  <rect class="box" x="170" y="208" width="380" height="38" rx="8"/>
  <text x="360" y="232" text-anchor="middle">Choose!(1, n) — perform</text>
  <path class="arrow acc" marker-end="url(#arre)" d="M558 227 H640 V43 H554"/>
  <text x="566" y="150" class="acc">eff {op, args, k}</text>
  <text x="566" y="164" class="acc">bubbles up as the Outcome</text>
  <path class="arrow acc" marker-end="url(#arre)" d="M182 43 H100 V227 H166"/>
  <text x="30" y="130" class="acc">resume(v)</text>
  <text x="30" y="144" class="acc">= run(k(v), kOuter)</text>
  <text x="30" y="158" class="acc">— call k many times</text>
</svg>

Case bodies run **outside** their handler (under `kOuter`), so an effect
performed inside a case body propagates to the next enclosing handler.

## `runTop` and interpretation

`runTop(out, interp?)` loops over a trapped outcome: an `interp` override is
checked first (tests inject fake fs/time/randomness there), then
`builtinInterps` (the builtin table's default interpretations — real I/O),
else `throw new Error("Unhandled effect: …")`.

## The `exec` pipeline

`newCtx(interp?)` → fresh pipeline state; `exec(prog, ctx, checked)` — the
program is checked by the caller *before* the interpreter runs (`run`
checks once after parsing; a REPL line checks against
`ctx.checked`):

1. **Fail fast** on statically unhandled ops (`rejectUnhandled` in
   frontend/pipeline.ts — the one gate both backends call right after prepare; the
   wasm pipeline applies it before any codegen): any op in
   `checked.unhandled` that is neither a builtin effect nor covered by
   `ctx.interp` throws *before evaluation begins* — a program that would die
   mid-run after side effects dies before its first side effect.
   `ctx.checked` is assigned only after the check passes, so a rejected REPL
   line leaves the accumulator untouched (like a type error does).
2. `seedBuiltins(ctx.env, builtinRefs(prog))` — bind exactly the builtins this
   program references (the checker's no-shadowing rule keeps user bindings
   off builtin names, so seeding never overwrites anything).
3. Evaluate each item: `runTop(evalE(item, …))`. Returns
   `{value, lastType, lastIsExpr}` — `lastIsExpr` implements the REPL echo
   rule (declarations print nothing).

`run(src, interp?)` = one-shot parse → `exec`. The REPL calls `newCtx` once
and `exec` per line, so bindings accumulate.

The evaluator and the builtin table reference each other only at runtime
(`apply` is called from builtin closures; unhandled effects read the table's
default interpretations) — safe from any entry point because the defaults
are derived together with the table itself.

Next: [Wasm backend](wasm/index.md).
