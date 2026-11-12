# Fix multishot-resume divergence in HOF loops (map/each/flatmap)

## Objective

Make multi-shot resume over the HOF loop builtins (`map`/`each`/`flatmap`) type-safe
at the resume boundary and backend-consistent, in two serial PRs:

- **PR-A — spine-gated resume typing + `show` cycle guard**: reject the
  named unsound multishot-resume shapes at compile time, make `show` cycle-safe,
  and document the rule and its residual holes (AGENTS.md, README, spec —
  including the `+`-delayed-constraint hole and perform-spined bodies, which stay
  unchecked). No backend changes.
- **PR-B — wasm per-element land state**: the wasm map-like trampolines must derive
  their element index from per-capture state, not the shared counter frame slot, so
  wasm multi-shot behavior matches the interpreter exactly (aliasing included) for
  every program that survives PR-A's checker.

## Diagnosis (verified by repro + code reading, 2026-11-12)

Repro programs (all typecheck and run today):

```ef
# 1. terminates, but the result is a CYCLIC array; the crash is show() recursing
#    on it (interp: "Maximum call stack size exceeded"), wasm: "ref.cast failed".
effect Op(): i64;
cb :: fn(x: i64): i64 { Op!() };
handle { map(cb, [1, 2]) } case Op() => k { k(k(10)) }

# 2. interp prints [11, 11] (shared-state aliasing); wasm crashes
#    "Out of bounds array.set"
effect Op(): i64;
cb :: fn(x: i64): i64 { Op!() };
r := handle { map(cb, [1, 2]) } case Op() => k {
  q := k(10);
  k(11);
  q
};
r
```

PR-A turns repro 1 into a compile error and gives repro 2's handle the precise type
`[i64]`; repro 2's wasm crash is Step 2's target. Three stacked defects:

1. **The op-case resume binder is mistyped for HOF bodies** (fixed in Step 1). The
   binder is `k : (opRet) -> R` with `R` unified only with the case body's type
   (`compiler/types.ts:1026-1040`). Dynamically, `k(v)` runs the captured rest and
   delivers *the value the body's continuation receives from this resumption*
   (interp `compiler/eval.ts:162-165`): at the `k(v)` call site that value is the
   rest's completion — the handled body's boundary value (typed `bodyT`) — **or**,
   when the rest re-performs and a nested case body completes without resuming,
   that nested case body's completion (typed `resultT`). For bodies whose performs
   all hide behind callbacks (the HOF class — `map(cb, xs)` with a performing
   `cb`), `R ~ resultT` alone lets `k(k(10))` over a `map` body typecheck while
   dynamically re-driving the loop with a wrongly-typed value: the interp stores
   the map result (a slice) into the result array (`compiler/builtins.ts` map land
   `v => { out[i] = v; return go(i + 1); }`), producing the cyclic structure; wasm
   stores a non-element anyref into the res window and traps.
2. **Wasm shared-counter loop state** (`compiler/wasm_module.ts:751` `emitMapLike`).
   The generic trampolines keep the element counter in the entry builtin frame slot
   (`iSlot`: map/flatmap 3, each 2 — `compiler/wasm_tables.ts:14`
   `mapLikeFrameWords`); both `loopEntry` and `iterLand` read it. The interpreter's
   land continuation instead closes over its own `i` per element (a fresh JS closure
   per iteration). Under multi-shot resume the captured cell chain is copied
   (`$captureSlice`) but frames are shared, so a second resume reads the counter
   already advanced past the window → out-of-bounds `array.set` (map/flatmap) or
   wrong callback `i` values (`each` — silent divergence, no crash).
3. **No cycle guard in `show`** (`compiler/env.ts:97`). Any cyclic `Value` hangs the
   REPL/test printer with a stack overflow instead of printing something readable.

## Decisions (interview + adversarial review, 2026-11-12)

- **D1 — Per-case spine-gated resume typing (final, empirically validated)**.
  The delivery at a resume call site is the rest's completion (`bodyT`) or a
  nested case body's completion (`resultT`); no single type captures both in
  general (no unions), so the sound move is to force the two arms together where
  the body's own completion is the dominant arm. **Rule**: for a handle with NO
  Return case whose handled body contains no `perform` node outside lambda
  bodies, unify `resumeT.ret` with `res(bodyT)` **in addition to** the existing
  `unify(resumeT.ret, ct)` — but only for op cases whose case body lexically
  references `k`: a case body that never mentions `k` makes no delivery through
  that resumption, so its `ret ~ ct` alone stays sound and the abort idiom
  (`case Op() => k { 42 }`) keeps typechecking. The perform walk skips lambda
  bodies (callbacks run dynamically — named and inline callbacks are equally
  opaque), so the force fires precisely on the HOF-multishot class; canon bodies
  perform in their let binders or tails (Choose binders, `Log!`, `Exit!`,
  `T!()`, `Tock!`), so they keep today's typing. History: the unconditional
  `ret ~ res(bodyT)` variant (originally approved) was falsified by the round-1
  review gate — 11 existing tests fail (the README front-page Choose example,
  the spec's log-threading and Exit/Out idioms, flat passthrough); a
  replace-not-add variant was caught during validation (it re-admits
  `case Op() => k { len(k(10)) }`, whose nested completion then flows into the
  `[i64]`-typed position unchecked — checker `i64`, runtime `unit`); the
  round-2 review caught the unconditional force rejecting sound abort and
  observing handlers over HOF bodies, and the per-case k-reference gate was
  adopted (round-2 decision: the abort idiom stays valid; observing handlers
  are rejected by design — the escape is to return the delivery from the case
  body and observe outside the handle). The additive force variant of the rule
  was validated on a throwaway copy before this plan: 358/358 tests pass, every
  example and benchmark still typechecks, amb/example.ef run unchanged, and the
  target repros behave as specified in Step 1's exit criteria (the per-case
  gate is a pure widening on top — it only stops the force for k-unreferenced
  case bodies). Residual holes (documented, same philosophy as the any-callee
  hole): perform-spined bodies keep today's unchecked boundary; observing
  handlers over forced bodies are rejected by design; `k(1) + k(2)` over a map
  body still typechecks through the pre-existing delayed-constraint hole (`+`
  constrains an unbound var only at use time) and crashes at runtime on both
  backends — pre-existing, baseline-identical, pinned as a known hole.
- **D2 — Wasm fix shape**: per-element land state, mirroring the interp's
  per-element closures; NOT snapshot/restore in the resume splice (touches all
  resumes) and NOT documenting the crash (violates parity).
- **D3 — `show` cycle guard**: included; a repeated object prints `#cycle`.
- **D4 — Packaging**: two serial PRs. PR-A (spine-gated typing + show guard +
  docs) first; PR-B (wasm land state) builds on it because its parity tests need
  the cycle-safe `show` and the checker's rejections in place.
- **D5 — Aliasing semantics**: the shared result window under multi-shot resume
  (interp behavior, e.g. `[11, 11]` for repro 2) is the defined language semantics
  and gets documented; copy-on-resume persistent semantics are a non-goal.

## Dependency graph

```
Step 1 (PR-A)  ──serial──>  Step 2 (PR-B)
```

No parallel steps. Each step is one jj commit on top of the previous; rollback =
`jj abandon` the step's commit.

---

## Step 1 (PR-A): spine-gated resume typing + show cycle guard + documentation

### Context brief

A fresh agent needs:

- Repo: ef at the workspace root; gate is `bun run ci` (typecheck + eslint incl. the
  comment-hygiene rule + runtime-deps check + tests). `bun runtime does not
  typecheck` — always run `bun run typecheck` explicitly. The `plans/` directory is
  excluded from the md lint (`eslint.config.ts`, the `**/*.md` block has
  `ignores: ["plans/**"]`).
- The resume boundary ground truth: `compiler/eval.ts` `evalHandle`'s resume native
  (eval.ts:162-165) runs the captured rest and feeds its completion into the case
  body's k-call-site continuation; the delivered value is the rest's completion —
  the handled body's boundary value — or, when the rest re-performs, a nested case
  body's completion. The checker currently types the op-case resume binder as
  `k : (opRet) -> R` with `R` unified only with the case body's type
  (`compiler/types.ts:1026-1040`) — that is what Step 1 fixes. Both backends'
  resume machinery is type-erased (anyref), so no runtime/emitter changes belong
  to this step.
- The validated rule (D1) and its exact patch shape: two module-level helpers in
  `compiler/types.ts` — `hasPerformOutsideLambdas(nodes, root)` (descend every
  `Expr` kind except `lambda`; true iff any `perform` node is found — children:
  let/dlet/assign `.val`, as `.e`, if `.c/.a/.b`, while `.c/.body`, block
  `.stmts`, handle `.body`, app `.fn/.args`, arr `.elems`, field `.obj`; lint
  footgun: a bare `nodes[id]!` trips `no-unnecessary-type-assertion` — bind the
  node to a local first) and `caseReferencesK(nodes, name, root)` (lexical walk
  of the case body for var occurrences of the binder name — any textual
  occurrence counts, so it over-approximates referencing and can only fire
  more, never less), plus in the handle case: `const bodyCompletes =
  !e.cases.some(c => c.op === "Return") && !hasPerformOutsideLambdas(nodes,
  e.body);` and, per op case, after the existing `env.uni.unify(resumeT.ret,
  ct)`: `if (bodyCompletes && caseReferencesK(nodes, binderName, c.body))
  env.uni.unify(resumeT.ret, env.uni.res(bodyT));`. The additive force variant
  of this rule was applied to a throwaway copy and passed 358/358 tests, the
  examples/benchmarks typecheck sweep, and the repro behaviors in the exit
  criteria (the per-case gate is a pure widening on top: it only stops the
  force for k-unreferenced case bodies).
- The interp's map-like land closures live in `compiler/builtins.ts` (the `native`
  builtin CPS fns): map's land is `v => { out[i] = v; return go(i + 1); }` — fresh
  closure per element, shared `out` array. This is the runtime target Step 2
  mirrors; Step 1 changes nothing there.
- Docs rules: language-behavior documentation lives in `README.md`'s full-spec
  section and `docs/content/spec/index.md`; AGENTS.md's "Key design decisions"
  carries the resume-type decision line to amend: "**resume `k` type.** `k :
  (effectRetType) -> R` where `R` is the handle result type, not the body type."
- Tests are the spec's executable form: `compiler/index.test.ts` (checker/runtime
  behavior), `compiler/wasm.test.ts` (interp↔wasm parity). The README front-page
  example (index.test.ts:40) and the spec's log idiom (docs/content/spec/index.md)
  are canon — Step 1 must leave them compiling unchanged (they have perform-spined
  bodies or Return cases, so the force never fires for them).

### Tasks

- [ ] **1.1 Per-case spine-gated resume typing** (`compiler/types.ts`): implement
  the validated rule exactly as specified in the context brief (the
  `hasPerformOutsideLambdas` + `caseReferencesK` helpers + the `bodyCompletes`
  gate + the per-case additive `unify(resumeT.ret, env.uni.res(bodyT))`).
  Re-verify the reviewer-verified non-consumers on the current tree: the resume
  ret type var feeds only `stampSuspension`'s row marking
  (`compiler/types.ts:1287-1312`) and comments (`cps.ts:57`, `cps_ir.ts:32`);
  the CPS converter reads numKind stamps, never resume ret types.
- [ ] **1.2 `show` cycle guard** (`compiler/env.ts:97`): thread a seen set through
  show's recursion (internal helper parameter; the public entry allocates one). A
  repeated object prints `#cycle` — as a whole value, or in place of a repeated
  element inside slices/tuples. No behavior change for acyclic values. Unit test in
  `compiler/index.test.ts` constructing a cyclic slice `Value` by hand in TS.
- [ ] **1.3 Documentation**:
  - AGENTS.md: amend the "resume `k` type" decision line — for Return-less
    handles whose body performs no op outside lambdas, op cases whose body
    references `k` also unify the resume's return with the body's type (the
    delivery is the body's completion value; nested case-body completions are
    forced to agree through the same var); otherwise it is the handle's result
    type; the residual holes are documented (present tense, why-shaped):
    perform-spined bodies keep the unchecked boundary, observing handlers over
    forced bodies are rejected by design (escape: return the delivery from the
    case body and observe outside), and the `+`-delayed-constraint hole lets
    `k(1) + k(2)` shapes through unchecked.
  - README full-spec section + `docs/content/spec/index.md`: the same rule in the
    handler/resume typing section, plus one paragraph on multi-shot resume over
    `map`/`each`/`flatmap` — the loop continuation is re-entrant; the result
    window is shared (last write wins per element).
- [ ] **1.4 Tests** (`compiler/index.test.ts` + a small `compiler/wasm.test.ts`
  block):
  - compile errors (pin the messages): repro 1 (`k(k(10))` over `map(cb, [1, 2])`,
    named cb — "got i64, expected [i64]"); the inline-callback variant (`map(fn(x:
    i64): i64 { Op!() }, [1, 2])`); ms4 (`s := handle { map... } case Op() => k {
    k(10) }; s + 0` — the error surfaces at the `+` use: "`+`: [a] and i64 are not
    both numeric or both string", the delayed-constraint shape); the len-inside
    shape (`case Op() => k { len(k(10)) }` — rejected at the handle: the case
    body's `i64` conflicts with the body's `[i64]`, matching its garbage
    runtime); the observing handler (`case Op() => k { Println!(k(10)) }` —
    rejected by design: the case body completes `unit` but the delivery is
    `[i64]`; the escape is to return the delivery and observe outside).
  - accepted + behavior: the abort idiom `handle { map(cb, [1, 2]) } case Op()
    => k { 42 }` typechecks and prints `42` on both backends (`parity()` — the
    per-case gate preserves it); repro 2 typechecks (`r : [i64]`), interp
    prints `[11, 11]`, wasm crashes — pin the wasm side as a KNOWN DIVERGENCE
    with a comment pointing at Step 2 (flip to `parity()` there; do NOT add it
    to `parity()` yet); the transforming handler `len(handle { map(cb,[1,2]) }
    case Op() => k { k(10) })` → `2` on both backends as a `parity()` test;
    single-shot map `[10, 10]`, each multi-shot with trailing Op! `0`,
    each-under-handler `unit`, and the design-B shape `handle { Op!() } case
    Op() => k { k(1) + k(2) }` → `3` — all unchanged (note: `k(1) + k(2)` over
    a MAP body still typechecks via the delayed-constraint hole and crashes —
    pre-existing, baseline-identical; document, don't pin).
  - canon-unchanged (must still compile and pass): Choose (index.test.ts:40,
    wasm.test.ts:406), deep-log (:71/:417), Exit/Out (:126/:432), flat passthrough
    (:503), mix (:460), Div exception, propagation, Read+1, inner-Return, amb.ef +
    example.ef, every PR1 devirt-block test.

### Verification commands

```bash
# Recreate the repro files first (none exist in the tree) under /tmp/d1/ with the
# write tool, not shell redirection — sources:
#   repro1.ef: effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
#              handle { map(cb, [1, 2]) } case Op() => k { k(k(10)) }
#   repro4_inline.ef: effect Op(): i64;
#              handle { map(fn(x: i64): i64 { Op!() }, [1, 2]) } case Op() => k { k(k(10)) }
#   repro3_ms4.ef: effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
#              s := handle { map(cb, [1, 2]) } case Op() => k { k(10) };
#              s + 0
#   repro2.ef: effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
#              handle { map(cb, [1, 2]) } case Op() => k { q := k(10); k(11); q }
bun run typecheck
bun run lint
bun run check:deps
bun test --parallel
bun compiler/cli.ts types /tmp/d1/repro1.ef        # error: got i64, expected [i64]
bun compiler/cli.ts types /tmp/d1/repro4_inline.ef # error: got i64, expected [i64]
bun compiler/cli.ts types /tmp/d1/repro3_ms4.ef    # error at the + use: [a] and i64 not both numeric
bun compiler/cli.ts run /tmp/d1/repro2.ef          # [11, 11]
bun compiler/cli.ts runwasm /tmp/d1/repro2.ef      # known divergence until Step 2
for f in examples/*.ef benchmarks/*.ef; do bun compiler/cli.ts types "$f" >/dev/null 2>&1 || echo "ERR $f"; done  # no ERRs vs pre-change
```

### Exit criteria

- repro 1 (named + inline callback) and the len-inside shape are compile
  errors naming the resume/body mismatch; ms4 fails at its `+` use site; the
  observing handler is rejected by design; the abort idiom still typechecks.
- The transforming-handler test (`len` outside, `k(10)` case) passes `parity()` →
  `2`; repro 2 interp prints `[11, 11]` with `r : [i64]`.
- Every pre-existing test still passes and every example/benchmark still
  typechecks (the force fires only on the HOF-multishot class).
- `show` never hangs: cycles print `#cycle`.
- `bun run ci` green; AGENTS.md + README + spec document the rule, the
  shared-window semantics, and the perform-spined residual hole.
- wasm still crashes on repro 2 — pinned as a known divergence, owned by Step 2.

---

## Step 2 (PR-B): wasm per-element land state (interp-exact multishot HOF loops)

### Context brief

A fresh agent needs:

- PR-A is merged: the unsound multishot shapes are compile errors; `show` is
  cycle-safe. Remaining wasm-side work: repro 2 (`q := k(10); k(11); q` — still
  well-typed, `r : [i64]`) crashes on wasm while the interp prints `[11, 11]`;
  `each`'s callback `i` is wrong after a resume; well-typed multishot shapes that
  the spine rule accepts must behave identically on both backends. Target: wasm
  matches the interp's mechanics exactly — per-element index, shared result
  window (D5).
- `compiler/wasm_module.ts:751` `emitMapLike(em, f, name, cb?)` emits the generic
  map/each/flatmap trampolines: `resSlot` (map 2 / each none / flatmap 2) and
  `iSlot` (map/flatmap 3 / each 2) live in the **entry builtin frame**; the thunks
  `loopEntry` + `iterLand` are shared `Fn(3, T_III_I)` rest-thunks; `iterLand` reads
  the counter slot (`t.slot(iSlot)` → `readBoxPayload` → `TRUNC_F64`) for the store
  index and the callback `i`, bumps it (`FADD` via `fBox`), and `RETURN_CALL`s
  `loopEntry` over the entry frame with a unit `$I64` box arg; `loopEntry` reads the
  counter for the done check (`GEU` vs the view length) and the callback element.
- Structures: the `$K` cell is `{0: kind i31, 1: fnIdx/table, 2: frame anyref,
  3: next}` (`compiler/wasm_types.ts:36-40`; the shape table lives in
  `compiler/wasm_tables.ts:105`); the K_RET dispatch arm passes cell field 2 cast to
  `$FRAME` as the thunk's frame param (`compiler/wasm_emit.ts:68-77`, `754-763`) —
  the thunk **cannot read the cell itself**. `$captureSlice` copies cells; **frames
  are shared**. Therefore per-activation state must ride in a frame the loop stops
  mutating: a **fresh per-iteration `$FRAME`** installed as the land cell's frame
  field before each callback call — once the loop advances, that frame is never
  written again, so a captured cell copy freezes its index (exactly the interp's
  per-element JS closure).
- `mapLikeFrameWords` consumers to update when the counter slot dies:
  `compiler/wasm_tables.ts:14`, the builtin `$CLO` fsize statics (wasm_pipeline
  layoutStatics), `directBuiltin`'s fsize formula (`compiler/wasm_term.ts`), and the
  PR1 tight-map path's frame sizing (`mapTightDirect` + the tight arm in
  `emitMapLike` — their loop counter is a plain i32 local, not a frame slot, but
  their frame size consumes the same words).
- The ret-resume reference implementation is `emitRetResumeFn`
  (`compiler/wasm_term.ts:2177`). Tracing: build with `DBGEMIT=1 bun
  compiler/cli.ts buildwasm <file>` and grep the output for `THUNK`.
- Interp reference: `compiler/builtins.ts` native builtins — land closures close
  over their own `i`; `out` is shared. PR-B's exit bar is mechanic-level equality
  with these closures.
- Tests/conventions: `compiler/wasm.test.ts` `parity(src)` asserts interp == wasm
  `show()` output; `bun run ci` gate; `bun run typecheck` separately.

### Tasks

- [ ] **2.1 Layout confirmation (no code)**: re-verify the established facts above
  against the current tree (dispatch arm's frame field, capture copying cells not
  frames, `Buf.slot` flat addressing). Record in the PR description: the fresh
  per-iteration frame's slots (the index; optionally replicated refs — see 2.2),
  and how `iterLand` reaches the res window / callback closure (one parent hop via
  `structGet(4, 0)` vs replicating refs into the fresh frame — pick the simpler
  emit; do NOT extend `Buf.slot` with parent-walking).
- [ ] **2.2 Fresh per-iteration frame**: at each callback-call site in
  `emitMapLike`, allocate a fresh `$FRAME` `{parent: entryFrame, slots: [boxed
  index]}` (plus replicated refs if 2.1 picks replication), point the land cell's
  frame field at it, then call the callback. `iterLand` reads the index from its
  own frame slot 0 for (a) the res-window store index (map/flatmap), (b) the
  callback `i` argument (each/flatmap) — replacing both counter-slot reads.
- [ ] **2.3 Loop progression via the value argument**: `loopEntry` takes the next
  index as its value argument (a stamped `$I64` box — the same boxing discipline
  the unit arg already uses, so the thunk frame build reads it as a stamped i64)
  instead of reading the counter slot; `iterLand` passes its own index + 1. The
  counter frame slot dies: update `mapLikeFrameWords` (map/flatmap 2 → 1, each
  1 → 0) and every consumer listed in the context brief; renumber `iSlot`/`resSlot`
  carefully (the res window keeps its slot).
- [ ] **2.4 Parity tests** (`compiler/wasm.test.ts`):
  - flip the Step 1 pin: repro 2 → `parity()` → `[11, 11]`;
  - `each` multi-shot callback `i` correctness: a performing callback that records
    its `i` into a captured mutable var through the op's args, resumed multi-shot —
    interp and wasm agree on the recorded sequence;
  - `flatmap` multi-shot shape (same land structure as map);
  - well-typed multishot unit shapes that the spine rule accepts (e.g.
    `handle { each(cb, [1, 2, 3]) } case Op() => k { k(k(0)) }` — no trailing
    perform) — verify termination on the interp FIRST, pin only what terminates;
  - single-shot map/each/flatmap and all PR1 tight-loop tests unchanged;
  - the any-hole divergence smoke test unchanged.
- [ ] **2.5 Docs**: confirm the Step 1 README/spec paragraph matches the implemented
  mechanics (shared window, per-element index, last write wins); adjust wording if
  the implementation revealed a different observable.
- [ ] **2.6 Bench spot-check**: `benchmarks/sieve.ef` + `benchmarks/loop.ef` (pure
  callbacks → tight path) — expect byte-identical or noise-level deltas;
  `benchmarks/handlers.ef` (no HOFs) unchanged. No new bench floor (D4): the
  generic path gains one small frame alloc + one arg pass per element, off every
  benchmark's hot loop.

### Verification commands

```bash
bun run typecheck
bun run lint
bun run check:deps
bun test --parallel
bun compiler/cli.ts run /tmp/d1/repro2.ef && bun compiler/cli.ts runwasm /tmp/d1/repro2.ef   # both [11, 11]
for b in sieve loop handlers; do bun compiler/cli.ts buildwasm benchmarks/$b.ef; done
```

### Exit criteria

- All well-typed multi-shot HOF shapes pass `parity()` (repro 2, each-i sequence,
  flatmap, the terminating well-typed unit-multishot shapes).
- The counter slot is gone from the map-like frames; `mapLikeFrameWords` and all
  fsize consumers agree (typecheck + tests prove it).
- `bun run ci` green; sieve/loop/handlers show no regression beyond noise.
- README/spec document the implemented semantics.

## Non-goals

- Union types or deferred-constraint machinery for the resume boundary (the
  spine-gated force is the chosen sound rule; perform-spined bodies keep the
  documented unchecked boundary — same philosophy as the any-callee hole).
- Copy-on-resume (persistent) loop semantics — the shared-window aliasing (D5) is
  the defined behavior.
- The any-callee perform divergence (interp prints the handler's value, wasm throws
  "Unhandled effect") — pre-existing, tracked separately; the PR1 test pins it.
- Continuation performance under multi-shot resume (captured-slice copying costs).
- Interpreter-side changes (the interp is the semantic reference; its per-element
  closures already define the target behavior).

## Mutation protocol

Steps are serial; no splits anticipated. If the Step 1 suite validation shows the
force rejecting a sound canon shape, do not weaken the rule ad hoc — stop and
renegotiate in review, recording the decision here with a date; the force may only
ever narrow (it adds `ret ~ res(bodyT)` on top of today's `ret ~ ct`), never widen.
If Step 2's investigation (2.1) falsifies
any of its listed established facts (e.g. the dispatch arm reads a different field,
or captures copy frames too), do not improvise — stop and renegotiate the land-state
design in review, recording the decision here with a date. The one hard constraint:
per-activation state must live in a structure the loop stops mutating before any
capture can freeze it; a shared mutable counter slot recreates the bug.
