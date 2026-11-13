# Plan: ef compiler — composable/separated design (all 7 candidates)

Date: 2026-11-13 · Repo: `/home/rprtr258/pr/lish` (colocated jj+git; project under `ef/`)
Gate for every chunk: `cd ef && bun run ci` clean (typecheck + eslint + runtime-deps + knip + full test suite, including wasm/examples/docs/vscode LSP tests).
Commit per chunk via `jj commit -m "<area>: <message>"` from `ef/` (repo style: no `ef:` prefix — see git log), only after both reviews pass.

## Ordering rationale

1. **Builtins leaf** breaks the import cycles first — every later seam reads the real table, not a copy.
2. **Pipeline** next — one front door all later refactors and their tests go through.
3. **Ops vocabulary** — single source for operators/traps/errors before the checker and wasm re-cuts.
4. **AST walker** — analysis/lint/lsp/consumers stop restating child order before checker surgery.
5. **Checker deepening** — now isolated: unifier → display → token recorder → stamps.
6. **Wasm index registrar** — biggest wasm entanglement, parity risk isolated to wasm tests.
7. **Frame-plan owner** — last, builds on the registrar's Emit discipline.

Steps are strictly sequential (same cwd, sequential commits). No parallel implementation.

---

## Step 1 — Builtins table becomes a leaf module (candidate 7)

**Context brief.** `ef/compiler/builtins.ts` (216 lines) is the single builtin table but it imports
`env.ts` (Value/Env/runtime closures) and is read back from `eval.ts` via a documented runtime-only
import cycle (`builtinInterps`). `analysis.ts` (260 lines) hand-copies `BUILTINS`/`EFFECT_OPS`
surface tables, synced only by `analysis.test.ts`. `types.ts` already imports `builtins` from
builtins.ts directly (line 4) but guards the read at types.ts:1367 because of an **init-order
hazard** ("builtins.ts may be mid-init"); there is no types⇄builtins import cycle to break. Module
init order must become order-independent (see AGENTS.md note on `analysis.ts`).
 knip (`knip.json`, `exports: error`) rejects re-exports that lose their last importer — any compat
re-export added here must either keep every consumer migrated in the same chunk or be tagged
`@public`.

**Chunk 1.1 — split table from impls.** ✅ commit 81369be4
- [x] Create `compiler/builtin_table.ts`: a leaf module (imports nothing from compiler/) holding the
      declarative builtin table — names, kinds, checker `sig`s, effect declarations, default-host
      descriptions — as pure data. Derive static surface exports here: `BUILTINS`, `EFFECT_OPS`
      (order-pinned), `builtinRefs` seed list.
- [x] `builtins.ts` keeps the runtime construction (closures, native CPS impls, `builtinInterps`,
      `builtinEffectHosts`) and imports the table from `builtin_table.ts`.
- [x] `analysis.ts` drops its hand-copied tables and re-exports/derives from `builtin_table.ts`;
      the "module init order is order-independent" comment contract now holds by construction.
- [x] `types.ts` imports the surface directly from `builtin_table.ts`; delete the lazy-read guard
      and any "mid-init" comments.
- [x] `analysis.test.ts`: replace table-sync assertions with type-level/static checks that remain
      meaningful (e.g. every effect op in the table has a declared ret type; order stability).

**Verification:** `bun run ci`; `bun compiler/cli.ts run examples/star.ef` output unchanged;
`ef types` line unchanged for one effectful example.
**Exit criteria:** no import cycle touching `builtin_table.ts`; hand-copied tables gone;
no compat re-export without remaining importers (knip green). **Commit:** `builtins: split table into leaf builtin_table.ts`

**Chunk 1.2 — derive both effect-host shapes from one table.** ✅ commit (see log)
Scope note: also carries two controller-directed additions from the chunk-1.1 quality review —
NATIVE_BUILTINS single-sourced from the table (wasm_devirt/wasm_tables consume it) and tFun/tArr
moved to prims.ts (shared leaf constructors).
- [x] `builtinInterps` (eval-side) and `builtinEffectHosts` (wasm-side) become derived exports of
      the table/impls pair so a new builtin effect cannot forget a host; the "k called exactly once"
      soundness comment moves to the one derivation point.
- [x] Tests keep interpreter↔wasm parity (`examples.test.ts`) green unchanged.

**Verification:** `bun run ci`. **Exit criteria:** adding a builtin = one entry + (if effectful) one
row; grep shows no second hand-maintained op list. **Commit:** `builtins: derive effect hosts`

---

## Step 2 — One pipeline module (candidate 1)

**Context brief.** The `parse → checkProgram → analysis` prefix is rewritten at 8 sites:
`eval.ts` `newCtx`/`exec`, `wasm.ts` pipeline entry, `cli.ts` `types`, `lsp.ts` (3 sites: lines 63,
84, 191), `repl.ts`, and the hand-copied REPL protocol in `index.test.ts` (cli repl merely
delegates to repl.ts). Unhandled-op checking exists twice with divergent timing (eval fail-fasts
statically via `checked.unhandled`; wasm throws mid-run). Two same-named incompatible
`EffectInterp` types are exported (`eval.ts:321` `(args, k) => Outcome` vs `wasm_host.ts:139`
`(args) => Value`). The REPL line protocol (seed refs, exec, print lastType/lastIsExpr) is
duplicated between `repl.ts` and `index.test.ts`. Note: `compiler/scripts/bench.ts:58` is a 9th
non-test `checkProgram` site (a knip entry file — must migrate, not ignore).
 knip flags exports that lose their last importer — migrate all consumers of moved exports within
the same chunk or tag them `@public`.

**Chunk 2.1 — extract program preparation.** ✅ commit (see log)
Landed shape (controller-acked, supersedes the sketch below): `prepare(src, acc?) -> {prog,
checked}` is pure-frontend; `Ctx`/`newCtx` moved into pipeline.ts (eval re-exports); builtinRefs
seeding stays in exec so rejected lines leave the accumulator untouched and REPL env persists.
- [x] New `compiler/pipeline.ts` exporting `prepare(src, acc?)` → `{ prog, checked, ctx }`:
      parse, `checkProgram`, `builtinRefs` seeding, residual-row collection. All 9 sites route
      through it (the 8 product sites + `compiler/scripts/bench.ts:58`); no site composes
      parse+check itself anymore.
- [x] `eval.ts` `newCtx`/`exec`/`run` become thin wrappers over pipeline; `wasm.ts` pipeline entry
      consumes `prepare` output. `cli.ts types` and `lsp.ts` use it.

**Verification:** `bun run ci`; CLI smoke: `run`, `types`, `lint`, `buildwasm` on `examples/`.
**Exit criteria:** `grep -rn "checkProgram(" ef/compiler --include='*.ts'` returns only
`pipeline.ts` and `types.ts` (the definition). **Commit:** `pipeline: one prepare seam`

**Chunk 2.2 — one EffectInterp interface.** ✅ commit (see log)
Landed shape (controller-acked): type-only import edges resolved by holding the definition in
pipeline.ts and the hostFor adapter in wasm_host.ts; bridge.ts migrated where it is a pure
import/behavior re-point (4/7 sites; problems/outline/buildWasm keep local composition — the
plan's chunk 2.4 now includes a staged-prepare variant and the remaining bridge sites).
- [x] Canonical `EffectInterp`
- [x] `wasm_host.ts`'s direct-style hosts get an internal adapter (wrap the
      returned `Value` delivery into the k/Outcome plumbing) — the wasm host's public surface
      changes only internally; `builtinEffectHosts` wiring is updated to produce adapted hosts.
- [x] Delete the second same-named type; `wasm.test.ts` injected overrides are the at-risk call
      sites — they are part of the verification net for this chunk.
- [x] `examples.test.ts` seeded `Random!`/`Exit!` overrides keep passing unchanged.

**Verification:** `bun run ci`. **Commit:** `pipeline: one EffectInterp interface`

**Chunk 2.3 — one unhandled-op decision point.**
- [ ] `pipeline.ts` owns the fail-fast check from `checked.unhandled`; `eval.exec` calls it
      unchanged. Give the wasm entry the same static check (matching message via the vocabulary
      from Step 3 if available, else current wording) — flip wasm's behavior to fail-fast before
      execution; update `wasm.test.ts` where mid-run throws become static diagnostics.
- [ ] README spec section: state the unified timing; `docs/content` pages that describe it.

**Verification:** `bun run ci` (includes wasm.test.ts); manual `ef runwasm` on an unhandled-op
example fails with the static message. **Exit criteria:** one owner of the timing decision.
**Commit:** `pipeline: unify unhandled-op fail-fast`

**Chunk 2.4 — one line protocol.** ✅ landed
RunLine relocation (review MUST-FIX, controller decision): `runLine` lives in **eval.ts** next to
`exec`, which it wraps — killing the pipeline⇄eval cycle the pipeline placement would have opened;
repl.ts and index.test.ts consume it from eval.
- [x] `pipeline.ts` exports `runLine(ctx, src)` → `{value, lastType, lastIsExpr}` (seed + exec +
      print contract). `repl.ts` and the hand-copied protocol in `index.test.ts` use it; delete the
      duplicate. (`cli.ts` repl path is delegation-only — no change expected.)
- [x] Mutation (added after chunk 2.1 review): migrate the playground's two remaining composers —
      `playground/src/bridge.ts` (~8 sites) and `playground/src/cps_view.ts:16-17` — onto
      `pipeline.prepare`; smoke via the playground build. (bridge.ts also re-points its
      `EffectInterp` import in chunk 2.2.) Chunk-2.2 update: 4/7 sites migrated; the remaining
      problems/outline sites need prepare to expose stage info on failure — extend `prepare` with
      an additive staged variant (e.g. `prepare` keeps throwing; add a variant returning
      `{ok:false, stage:'parse'|'check', error}`) and finish the bridge migration in chunk 2.4.
      Landed shape: `pipeline.prepareStaged(src, acc?)` — `{ok:true, prog, checked} |
      {ok:false, stage:'parse', error} | {ok:false, stage:'check', error, prog}` (the check
      branch carries the parsed program so outline still renders); `prepare` delegates to it and
      rethrows. problems/outline/cps_view showCps consume the pipeline; buildWasm stays local
      (parse-once-for-ops, documented in chunk 2.2) — the only remaining bridge composition.

**Verification:** `bun run ci`; REPL session: define fn, use builtin, rebind error — behavior
unchanged. **Commit:** `pipeline: single REPL line protocol`

---

## Step 3 — Ops vocabulary single source (candidate 5)

**Context brief.** Operator names are magic strings across `parser.ts` (desugaring), `types.ts`
(structural dispatch), `analysis.ts` (OPERATOR_OPS mirror), `env.ts` (OPS table, `%` split-brain
keyed on checker stamp), `eval.ts` (`widthOp`). Trap knowledge (÷0, OOB, dead-trapping prims)
is smeared over `cps_opt.ts` `throwFree`, `cps_ir.ts` comments, `eval.ts`, `wasm_body.ts` shape
literals. `wasm_host.ts` `ef_fail` hardcodes the interpreter's exact throw strings for parity;
`%` semantics are split between `env.ts` and `eval.ts`.

**Chunk 3.1 — create `compiler/ops.ts` leaf; migrate declaration sites.**
- [ ] `ops.ts` (leaf): operator name/type constants, trapping-prim classification, runtime error
      message constructors (`errDivByZero()`, `errIndexOOB()`, `errUnhandled(...)`, …).
- [ ] Pre-decided `%` split-brain resolution (controller decision): `eval.ts` **keeps the numeric
      dispatch** (`widthOp`, eval.ts:269 — the checker stamp lands there); `ops.ts` hosts only the
      vocabulary it consults. `env.ts`'s OPS `%` entry (env.ts:203) and eval's widthOp both derive
      their names from `ops.ts`; delete the split.
- [ ] Migrate `analysis.ts`, `parser.ts`, `types.ts`, `env.ts` to import names from it (no behavior
      change; `OPERATOR_OPS` derived).

**Verification:** `bun run ci`.
**Exit criteria (scoped to this chunk):** `grep -rn '"neg"\|"not"' ef/compiler --include='*.ts'`
hits only `ops.ts` **plus** the remaining sites listed in chunk 3.3 (cps NUM_OPS, eval widthOp
internals, wasm case labels) — those close in 3.3.
**Commit:** `ops: single operator vocabulary (declarations)`

**Chunk 3.2 — runtime messages derived, parity by construction.**
- [ ] `eval.ts` and `wasm_host.ts` both emit messages via `ops.ts` constructors; delete wasm_host's
      hardcoded copies. `wasm.test.ts` parity assertions unchanged.
- [ ] `cps_opt.ts` `throwFree` and `cps_ir.ts` comments reference the classification instead of
      restating which prims trap.

**Verification:** `bun run ci`; deliberately diff one interpreter/wasm error pair in a test run.
**Commit:** `ops: derived runtime error parity`

**Chunk 3.3 — close the vocabulary: remaining operator-name sites.** ✅ commit (see log)
Discovered during this chunk (pre-existing, out of scope): wasm f32 `%` codegen is broken —
the float-rem branch promotes only the first operand pair to f64, then feeds f32-plane locals to
f64.mul/f64.sub → binaryen validation failure (wasm_term.ts float-rem branch). Silent when the
call is tree-shaken away; interpreter is correct. Follow-up fix + reachable-call regression test
needed.
- [x] Migrate the remaining operator-name string sites onto `ops.ts`: `cps.ts` NUM_OPS (cps.ts:36),
      `eval.ts` `widthOp` name table (eval.ts:292,306), `wasm_term.ts` case labels (1303,1350),
      `wasm_module.ts` (157).

**Verification:** `bun run ci`.
**Exit criteria:** `grep -rn '"neg"\|"not"' ef/compiler --include='*.ts'` hits only `ops.ts` and
non-operator matches; knip green. **Commit:** `ops: close remaining operator-name sites`

---

## Step 4 — One AST walker (candidate 6)

**Context brief.** Child order and binder positions are restated by hand in 7+ exhaustive switches:
`types.ts` (3), `analysis.ts` (3), `lint.ts` (2), `lsp.ts` `binders()` (no guard). Scope/shadowing
semantics are encoded 4×. `parser.ts` `exprChildren` is the germ of the walker.

**Chunk 4.1 — walker module + analysis migration (pilot).** ✅ commit (see log)
- [x] New `compiler/walk.ts` (leaf over parser AST): `exprChildren` (re-exported from parser.ts —
      the canonical child order stays there; parser owns the AST), `forEachBinder` (binder sites
      matching the checker's `checkBind` order; assertNever-guarded), `visitExprs` (pre-order
      visitor, boolean continue/stop).
- [x] Migrate `analysis.ts`'s three walkers onto it: performsAnyOp/collectEffectOps via
      `visitExprs` (op-interning pre-order preserved — wasm op-table order untouched);
      classifyBuiltinRefs keeps its scope-threading recursion (per-variant scopes + callee
      classification, not expressible generically) with binder enumeration delegated to
      `forEachBinder`.

**Verification:** `bun run ci`. **Commit:** `walk: shared traversal, analysis migrated`

**Chunk 4.2 — checker walkers migrated.** ✅ landed (controller commits; log has the hash)
- [x] Migrate the three `types.ts` walkers (careful: inferNode's traversal order is semantics —
      preserve exactly; if a walker needs custom order, it keeps its own switch and the plan chunk
      notes why).
- Landed shape: `caseReferencesK` is a pure pre-order DFS through walk.ts's `exprChildren`
  (stop at the first matching sym — its visited set is exactly `exprChildren`'s, and the result
  is order-insensitive). `hasPerformOutsideLambdas` enumerates through `exprChildren` with two
  explicit scope exclusions that are semantics, not order: a lambda's body (its performs land on
  the lambda's own row) and a handle's case bodies (they run past the handler — only `body` is
  on the handled spine); `perform` stays an early `true`. `inferNode` keeps its own exhaustive
  switch: its per-variant logic interleaves unification, env extension, error anchoring, and
  semToks recording with child inference — visit order is semantics (R3), nothing there is a
  child-order restatement; types.ts's module comment records why it stays hand-written. Both
  migrated scanners lose their local `assertNever` arms — `exprChildren` is the exhaustiveness
  choke point for any new Expr variant.
- Verified: `bun run ci` green (481 pass, 0 fail); knip green (no new exports on walk.ts);
  `ef types` on examples/star.ef and examples/amb.ef byte-identical before/after, `ef run`
  likewise (star's infinite animation compared as a 100 KB deterministic output prefix).

**Verification:** `bun run ci`. **Commit:** `walk: checker walkers migrated`

**Chunk 4.3 — lint + lsp migrated.**
- [ ] Migrate `lint.ts`'s two walkers and `lsp.ts`'s `binders()` onto the walker (binder guard now
      inherited).

**Verification:** `bun run ci`. **Commit:** `walk: lint and lsp migrated`

---

## Step 5 — Checker deepening (candidate 4)

**Context brief.** `types.ts` (1450 lines) fuses: unification core, AST checking, LSP semantic-token
recording (5 inference sites: semToks kinds + nodeTypes + EffectSig.names), backend stamps
(numKind/arrKind/sus/div/checkLamWidths), and display (showT/showErr/caret renderer). `Unifier`
carries LSP fields today.

**Chunk 5.1 — extract unifier core.**
- [ ] New `compiler/unify.ts` (leaf): `Type` union, `Unifier` (no LSP/token fields), `unify`,
      generalization. `types.ts` re-exports for compatibility at this chunk.

**Verification:** `bun run ci`. **Commit:** `types: extract unification core`
- Compat re-export note: `types.ts` re-exports only if consumers still import from it; migrate all
  consumers in the same chunk instead (knip forbids orphan re-exports).

**Chunk 5.2 — extract display.**
- [ ] New `compiler/type_display.ts`: `showT`, `showErr`, source caret rendering. Checkers' error
      paths call it; output bytes identical (tests assert messages).

**Verification:** `bun run ci`. **Commit:** `types: extract display`

**Chunk 5.3 — structured semantic-token recording.**
- [ ] Introduce a `TokenRecorder` passed through checking with one emission interface; the 5
      inference sites become recorder calls; `Unifier` loses token fields. `lsp.ts` consumes the
      same output shape (semantic tokens unchanged — `lsp.test.ts`/`vscode` tests green).

**Verification:** `bun run ci` + vscode LSP test (already inside the gate). **Commit:** `types: recorder interface for LSP tokens`

**Chunk 5.4 — backend stamps behind one concern.**
- [ ] numKind/arrKind/sus/div/checkLamWidths emission funnels through one stamps module/section so
      new node variants fail loudly when a stamp is forgotten (pair with `assertNever`).

**Verification:** `bun run ci` (f32/i64 parity tests in examples.test.ts are the semantic net).
**Commit:** `types: stamps behind one concern`

---

## Step 6 — Wasm index registrar (candidate 2)

**Context brief.** `wasm_pipeline.ts` `assignIndices` encodes the push order of 6 functions defined
across `wasm_term.ts`/`wasm_emit.ts`/`wasm_module.ts`; `wasm_module.ts` runs a second index
convention (`f.idx`); `ix.funcRefTypes` has 4 writers; the `Emit` god-context (9 fields, defined in
`wasm_emit.ts:26`) is constructed at `wasm.ts:227` inside `emit()` with `mainFn: undefined!` and
its init order is the de-facto interface. Any reordering breaks silently.
 Controller pre-decision: the registrar lives **in `wasm_pipeline.ts`** (no new module — keep the
file count flat; extract later only if pipeline grows unwieldy).

**Chunk 6.1 — registrar owns index allocation.**
- [ ] In `wasm_pipeline.ts` (or new `wasm_indices.ts`): an `IndexRegistrar` with
      `register(slot, fn, sig)` → index; `assignIndices` replaced by explicit registration calls at
      the definition sites; delete the hardcoded push-order mapping and magic `19`.
- [ ] `funcRefTypes` written only by the registrar; emitters read.

**Verification:** `bun run ci` (wasm.test.ts full parity suite is the net); WAT structural diff —
recipe: save `wasm-tools print <example>.wasm > /tmp/before.wat` from a pre-chunk build, rebuild
after the chunk, `wasm-tools print > /tmp/after.wat`, normalize `funcref` index references (indices
may renumber; compare structure, not numbers), `diff /tmp/before.wat /tmp/after.wat`. If the diff
shows more than renumbering/renaming, stop and reassess before committing.
**Exit criteria:** one writer of index state. **Commit:** `wasm: index registrar`

**Chunk 6.2 — Emit context constructed once.**
- [ ] `Emit` fields are set at construction (wasm.ts:227 `emit()`) by the pipeline/registrar;
      `undefined!` deferred fields gone; init order no longer caller-visible. `wasm_module.ts`'s
      second index convention migrated to registrar calls.

**Verification:** `bun run ci`. **Commit:** `wasm: Emit constructed once`

---

## Step 7 — Frame-plan owner (candidate 3)

**Context brief.** Frame/slot planning lives in `wasm_term.ts` (`planIr`, `TLevel`, `__p`
annotations), is mutated by `wasm_devirt.ts` (`classifySlots` sets `TLevel.typed/elided`),
materialized by `wasm_body.ts` (raw shape 4/1 literals), sized by `wasm_module.ts`
(`mainFrameSize(em.plan)`), and read by `wasm_pipeline.ts` `layoutStatics` through `hdl.__p`
internals. Shared mutable state spans three modules.

**Chunk 7.1 — plan module with immutable output.**
- [ ] New `compiler/wasm_plan.ts` owning planning + devirt classification; publishes an immutable
      `Plan` (typed slots, frame sizes, static-layout inputs). `planIr`/devirt mutate only inside
      this module; emitters/body/module/pipeline consume `Plan` read-only.
- [ ] `__p` internal annotations stop crossing the seam; the header comment that claims nothing
      else reads them becomes true.

**Verification:** `bun run ci`; `examples.test.ts` interpreter↔wasm parity; WAT structural diff
per the chunk-6.1 recipe on an example with handlers.
**Exit criteria:** grep shows `__p` referenced only inside wasm_plan.ts (+its source module).
**Commit:** `wasm: frame plan module`

---

## Execution protocol (per chunk)

1. Dispatch implementer subagent with: chunk text (verbatim from this plan), context brief, file
   map, gate (`cd ef && bun run ci`), rule "no commit; report status DONE/DONE_WITH_CONCERNS/
   NEEDS_CONTEXT/BLOCKED + diff summary".
2. Spec-compliance reviewer subagent → gaps fixed by implementer (re-dispatch) until ✅.
3. Code-quality reviewer subagent → issues fixed by implementer until approved.
4. Controller verifies gate itself, `jj st` shows only intended files, then
   `jj commit -m "<area>: <message>"`.
5. Plan file: tick the chunk's checkboxes; mutation protocol for splits/skips (append a
   "Mutations" note with reason).

## Risks

- **R1** Chunk 2.3 changes wasm timing for unhandled ops — mitigated by updating tests + README in
  the same commit; if a test depends on mid-run throw semantics, surface to user before flipping.
- **R2** Chunk 6.1 may renumber funcref indices — WAT structural diff gate; binaryen shrink makes
  byte-equality unlikely, so judge structurally.
- **R3** Chunk 4.2 traversal order in `inferNode` is semantics — preserve order; allow opt-out with
  justification.
- **R4** ESLint comment-hygiene rule will flag stale comments during moves — rewrite comments as
  present-tense at the new home; never copy history narrations.
- **R5** playground's worker bundle (knip entry `src/worker.ts`) pulls the compiler graph; `ci`
  typechecks but never builds it. After chunks 1.x and 2.x run a one-off
  `bun run --filter=playground build` smoke (the sleepSync stub at playground/scripts/build.ts:22
  covers the known bun-only API). The vscode LSP test already runs inside the gate.

## Risks (general)

- **R6 knip** (`exports: error`, `nsExports`, `includeEntryExports`): any moved export whose last
  importer migrates away hard-fails `bun run ci`. Rule for every chunk: migrate ALL consumers of a
  moved export within the same chunk; if a compat re-export is unavoidable, tag it `@public`.
- **R7 comment-hygiene** eslint rule flags stale comments during moves — covered in R4 above.

## Rollback

Each chunk is exactly one jj commit; `jj restore`/`jj abandon` per chunk if a gate fails after
commit; the next chunk always starts from a green tree.
