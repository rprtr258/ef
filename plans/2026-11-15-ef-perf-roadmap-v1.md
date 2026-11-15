# ef performance roadmap — staged optimization plan

**Mode:** multi-session construction plan (8 steps, each = one PR, executed and verified separately)
**Created:** 2026-11-15
**Status:** step 1 complete (harness committed, baseline + verification CSVs in-repo); steps 2–8 pending
**Baseline report:** `/tmp/efbench/REPORT.md` (key numbers embedded below so no step needs it)

## Objective

Narrow the measured gap between ef's backends and the compiled effect systems
(OCaml 5.3/multicont, Koka 2.4, Effekt 0.2.1/mlton) from the
effect-handlers-bench comparison, while adding the tooling (argv, runnable
prebuilt binaries, in-repo bench harness) that makes every later step
measurable. Each step is small, independently verifiable, and must leave
`bun run ci` green and no benchmark regressed.

## Baseline (2026-11-15, host x86_64, hyperfine 1.19, 10 runs)

Same-input comparison (Table B of the report), mean seconds, ×ocaml in parens:

| benchmark | ocaml | koka | effekt | ef-wasm | ef-int† |
|---|---|---|---|---|---|
| countdown 10M | 0.120 | 0.111 | 0.005 | 6.09 (51×) | 15.6 |
| fibonacci 36 | 0.087 | 0.141 | 0.143 | 5.47 (63×) | 52.6 |
| product_early 20k | 0.044 | 0.806 | 0.104 | 5.47 (124×) | 33.1 |
| iterator 8M | 0.094 | 0.532 | 0.029 | 3.51 (37×) | 19.3 |
| nqueens 10 | 0.050 | 0.178 | 0.007 | 1.74 (35×) | ~26 |
| generator 23 | 0.362 | 5.504 | — | 4.39 (12×) | 85.3 |
| tree_explore 12 | 0.020 | 0.037 | 0.021 | 0.75 (37×) | 6.4 |
| triples 300 | 0.650 | 5.792 | 0.062 | 5.67 (8.7×) | 29.8 |
| parsing_dollars 5k | 0.209 | 0.614 | 0.014 | 5.80 (28×) | 48.0 |
| resume_nontail 2k | 0.078 | 0.768 | 0.029 | 1.74 (22×) | 11.7 |
| handler_sieve 20k | 0.647 | 0.810 | — | 11.16 (17×) | 44.5 |

ef-wasm geometric mean ≈ 31× ocaml raw, ≈ 21× net of ef's fixed startup
(0.30–0.65 s). ef-int† is rescaled to the wasm input via ocaml's measured
scaling factor. Diagnosis (see report §Observations): (a) ~0.4 s of every ef
run is binaryen module init loaded even on execute-only paths; (b) hot
recursive/looping code reboxes numerics through adaptive unbox ladders at
frame-slot boundaries because typed (raw) slot classification is poisoned by
cross-fn reads; (c) every perform/resume materializes heap continuation frames
even when the resume is used at most once.

## Global invariants (checked after every step)

- `bun run ci` passes (typecheck + eslint incl. comment hygiene + runtime-deps + tests).
- `backend/parity.test.ts` and `backend/interpreter/index.test.ts` stay green —
  behavior is unchanged unless a step explicitly says otherwise.
- `benchmarks/compare/compare.ts` before/after: **no benchmark's mean regresses
  by more than 10%**, and the step's target metric improves (per-step gate below).
- Layout docs stay in step: any module move/rename updates `AGENTS.md`'s module
  list and `docs/content/dev/` in the same change.

## Steps

### Step 1 — In-repo benchmark harness `benchmarks/compare/` *(complete)*

**Context.** The 2026-11-15 comparison ran from throwaway scripts in /tmp
(now `/tmp/efbench`, may vanish). This step makes the comparison reproducible
from the repo. Files: `benchmarks/compare/compare.ts` (one-command driver:
deps → suite clone → docker images → compiled binaries → scaled ef sources →
precompiled wasm → hyperfine → report), `benchmarks/compare/precompile.ts`
(build/run precompiled ef wasm modules + `.ops.json` sidecars),
`benchmarks/compare/report.ts` (aggregate CSVs into Table B / Table A).
Scaled-input replacement mappings for the 11 benchmarks are encoded in `compare.ts`
(wasm-level and interp-level inputs). Suite names differ (`fib_recursive` →
`fibonacci_recursive`); effekt has 9 of 11 (no generator/handler_sieve);
koka's resume_nontail at n=20000 needs `ulimit -s unlimited`.

**Tasks.**
- [x] Landed files; smoke: `bun benchmarks/compare/compare.ts --help` exits 0.
- [x] `report.ts` reproduces the baseline tables; do not depend on /tmp:
      commit the baseline CSVs and printed tables as
      `benchmarks/compare/baseline/` (CSVs + BASELINE.md).
      (report.ts's PREFIXES fixed to match the CSVs' actual commands:
      `run_precompiled.ts`, `benchmarks/effekt/`; compare.ts's CSV names
      fixed to the suite name `fibonacci_recursive`, matching report.ts's
      BENCHES and the baseline files.)
- [x] `compare.ts --quick --no-docker` (ef-only, 3 runs) completes end-to-end.
- [x] Full `compare.ts` run reproduces baseline within noise; commit the
      full-run CSVs next to the quick ones. (First full run exposed two
      landed-file bugs, both fixed: std/Table-B command lists pushed
      `effekt-generator`/`effekt-handler_sieve` even though effekt has no
      binary for them — the build loop already skipped them — so hyperfine
      aborted those groups with exit 127; and the suite-name CSV fix above.
      Re-run of the affected benches + all others reproduced baseline:
      ef-wasm −13%…+26%, biggest deltas a uniform host slowdown with ocaml
      +40%, ×ocaml ratios preserved. Full-run CSVs committed under
      `benchmarks/compare/baseline/full-run/`.)

**Verification.** `bun benchmarks/compare/compare.ts --quick --no-docker --bench fib_recursive` exits 0 and prints tables; CSVs land in `${EFBENCH_HOME:-/tmp/efbench}/results/`.

**Exit criteria.** One command from the repo root reproduces the full
comparison; baseline CSVs + BASELINE.md committed under
`benchmarks/compare/baseline/` (verification never depends on /tmp). No
compiler changes.

**Rollback.** Delete `benchmarks/compare/` (no shared code touched).

### Step 2 — argv support for ef programs *(complete)*

**Context.** The `args` builtin **already exists end-to-end** — table row
`compiler/frontend/builtin_table.ts` (~line 78, `{kind: "fn", name: "args",
t: tFun([], tArr(TSTR), rowOf())}` — an array of strings, not a list), impl
`compiler/builtins.ts` (~line 91, `process.argv.slice(2)`), wasm
`emitBuiltins` case in `backend/wasm/wasm_module.ts` (~line 426), host import
`ef_args` in `backend/wasm/wasm_host.ts` (~line 179), asserted in
`backend/wasm/wasm.test.ts` (~line 207). The defect is upstream: cli.ts passes
nothing, so `args()` sees the raw `process.argv.slice(2)` — for `ef run f.ef a
b` that is `["run", "f.ef", "a", "b"]` (subcommand + source path pollute it),
and `runwasm`/`buildwasm` behave the same. The work is plumbing, not a new
builtin.

**Tasks.**
- [x] cli.ts: compute program args = argv after the source path for
      `run`/`runwasm`; thread them through `run(src)`/`runWasm(src)` (add an
      optional args parameter — `run`/`exec`/`newCtx` in
      `backend/interpreter/eval.ts`, and the wasm host instantiation) so the
      interpreter and the `ef_args` host import report identical values.
      REPL keeps `[]`. (Done: Ctx gains `args` in pipeline.ts's newCtx;
      exec publishes it to builtins.ts's `setProgramArgs` at the one runner
      boundary — the builtins table has no ctx access; runModule/runWasm
      take args and feed `ef_args` directly. Existing argv-dependent tests
      and examples updated to the trimmed semantics: approx_pi/star index
      from 0, parity fixtures' wants, cli args probe, wasm.test ef_args.)
- [x] Tests: interpreter suite (`index.test.ts`) — `args()` with trailing
      argv (exec-level: seed args and assert the program sees exactly them,
      without `run`/source path), empty case; shadowing rejection (`args` is
      a builtin name) if not already covered. Extend the wasm.test.ts
      `ef_args` host-import assertion for the trimmed args.
- [x] Docs: `docs/content/spec/index.md` §4 `args` row — fixed to describe
      program args (everything after the source path; `[]` in the REPL);
      README's CLI usage line unchanged.

**Verification.** `bun run ci` green. With `f.ef` = `args()`:
`bun compiler/cli.ts run f.ef a b c` prints `["a", "b", "c"]` (no
`run`/`f.ef` entries); the same file via `runwasm` prints identically; `ef
run f.ef` prints `[]`. All verified.

**Exit criteria.** Benchmarks can read inputs from argv; the harness (step 1)
gains a `--argv` mode that passes inputs to repo `benchmarks/*.ef` directly
(keep sed mode as fallback). Gate: no benchmark time change ≥10%.
Done: every `benchmarks/*.ef` reads its input from `args()` with the suite's
large input as the hardcoded default; `compare.ts` always compiles the repo
files directly and passes W_IN/I_IN as program args (the sed-scaled copies
and their `--argv` flag were removed — argv is the only mode),
`precompile.ts run <base> [args...]` threads them to the host.
Gate measured with hyperfine (10 runs, sed vs argv commands interleaved in
one invocation per benchmark, both backends): all deltas within ±6.2%, no
row at ≥10%. Earlier non-interleaved sessions showed ±10–30% swings in both
directions (documented run-to-run spread), which is why the interleaved
measurement is the one that counts.

**Rollback.** Revert the single PR; builtin rows are additive.

### Step 3 — Stop loading binaryen on execute-only paths

**Context.** `compiler/backend/wasm/wasm_host.ts` statically imports
`compileWithOps` from `wasm.ts` → binaryen. Measured: importing binaryen costs
~357–418 ms; `ef run` of a trivial program takes 0.30 s (≈ binaryen init +
bun), and precompiled runs spend ~0.4 s importing vs ~0.15 s executing.
cli.ts also statically imports `compile`/`runWasm` (lines 18–19), so every
subcommand pays it. Fix is pure plumbing; no semantics.

**Tasks.**
- [x] Split host runtime from compiler: move `runModule` (+ accessor/host
      imports) into a binaryen-free module (e.g. `backend/wasm/wasm_run.ts`)
      or make `wasm_host.ts` import `compileWithOps` lazily (`await import`).
      Pick the shape that keeps `wasm.ts`'s module docstring's layering true;
      update AGENTS.md + docs/content/dev in the same change.
      Done: `wasm_run.ts` holds the host runtime (binaryen-free); `wasm_host.ts`
      is the compile + run seam (`runWasm` = `compileWithOps` + `runModule`);
      `wasm_trace.ts` is the new EFTRACE leaf (wasm_tables.ts links binaryen,
      so the trace state couldn't stay there). AGENTS.md items updated.
- [x] cli.ts: dynamic-import `compile` only inside `buildwasm`, and the
      compile path of `runwasm`; `run`/`types`/`lint`/`repl` never load
      binaryen. Done: `main` is async; verified with a Bun onLoad plugin
      that replaces binaryen's entry with a throwing stub — run/types/lint/
      repl + `precompile.ts run` pass, runwasm/buildwasm/precompile build
      load binaryen as expected.
- [x] Measure: trivial `Out!("hi\n")` via `ef run` = 0.075 s mean (10 runs,
      target ≤ 0.12 s, was 0.30 s); `wasm_run.ts` import = 33 ms (target
      ≤ 0.15 s, was ~0.4 s for the old runtime path). Precompiled
      tree_explore total (import+exec) = 4.2 s (exec-dominated; the
      harness's timed rows are where the ~0.35 s/row drop shows: quick
      `--no-docker` gate green, e.g. product_early ef-wasm mean 0.046 s).
- [x] Update the harness's `precompile.ts run` path to the new module. Done:
      `runModule` import moved to `wasm_run.ts` and `compileWithOps` made a
      dynamic import inside the `build` branch, so `run` never loads
      binaryen either.

**Verification.** `bun run ci` green; timing measurements above printed in the PR; `compare.ts` gate: ef-int and ef-wasm Table B means drop by ~0.2–0.5 s on every row; no row regresses.

**Exit criteria.** Execute-only paths never instantiate binaryen's engine.

**Rollback.** Revert PR; import graph returns to previous shape.

### Step 4 — Prebuilt binaries: build once, run without compiling

**Context.** After step 3, `runwasm` still compiles on every invocation. `compile(src)` returns bare bytes; the op list needed by the host's effect
interpretation is only returned by `compileWithOps` — so a `.wasm` on disk
isn't runnable today (`ef runwasm x.wasm` fails with a parse error). Choose a
sidecar or embedded encoding for ops; keep `buildwasm`'s output
wasm-tools-valid.

**Tasks.**
- [ ] `buildwasm` persists the ops list next to the binary: `.ops.json`
      sidecar (simple) or a wasm custom section (cleaner; keeps one file).
      Implement one; document the choice in `AGENTS.md`.
- [ ] `runwasm` accepts `.ef` (compile + run, unchanged) or `.wasm` (+ sidecar
      if sidecar route) and executes via the step-3 binaryen-free path.
- [ ] Optional (same PR if small, else defer): `ef build <file>` →
      self-contained executable (`bun build --compile` of a tiny runner +
      embedded module) so short benchmarks skip bun startup entirely.
- [ ] cli.test.ts integration coverage: build→run roundtrip, missing-sidecar
      error, `.ef` passthrough.
- [ ] Update the harness for the new invocation shape: `compare.ts`'s
      cross-check and ef-wasm hyperfine commands switch from `precompile.ts
      run` to `ef runwasm <file>.wasm`, and `report.ts`'s PREFIXES gain an
      `ef-wasm` pattern for it — note `"cli.ts run"` substring-matches `cli.ts
      runwasm`, so the ef-wasm pattern must be matched before ef-int's
      (first-match-wins in report.ts).

**Verification.** `bun run ci` green; `ef buildwasm x.ef && ef runwasm x.wasm` prints the same result as `ef runwasm x.ef`; harness uses `ef buildwasm`+`ef runwasm` instead of the ad-hoc `precompile.ts` (keep precompile.ts as fallback).

**Exit criteria.** Compile cost fully amortized out of timed runs using repo CLI only.

**Rollback.** Revert; step-3 module layout is unaffected.

### Step 5 — Raw (unboxed) values across devirtualized calls

**Context.** The wasm backend already has unboxed *local* slots (`wasm_plan.ts`
PR3 slot classification: candidate widths from RHS prims, poisoned by
width-unstable or cross-fn assigns; raw param locals for numeric entries) and
dual call ABIs (T_KABI/T_DABI) plus `wasm_devirt.ts` per-slot closure
provenance + dcall eligibility. Hot recursive code (fib, countdown, nqueens)
still materializes frames with `anyref` fields and runs adaptive unbox ladders
(`wasm_emit.ts`) at every read — measured ~114 ns/call vs OCaml's ~1.8 ns.
Constraint: the multi-shot ANF freeze discipline (`frontend/cps_ir.ts` header,
`cps_opt.ts` frozen-temp rewrites) — anything a resumption reads later must be
snapshotted (boxed) at the freeze point; raw slots are only legal for values
not live across suspension.

**Tasks.**
- [ ] Extend slot classification: a slot may stay raw across a call when the
      callee is devirtualization-proven (dcall) *and* the value is not frozen
      at any perform site reachable in the callee's subtree. Poison otherwise.
- [ ] Emit dcall signatures carrying raw numeric params/returns (extend
      T_DABI specialization per width) — callee reads raw, no unbox ladder.
- [ ] Guard: numeric widths come from checker stamps only (`widthOf`), never
      decided in the backend.
- [ ] Tests: wasm.test.ts ABI/plan annotations for raw-across-dcall slots;
      add fixtures under `compiler/backend/testdata/` for deep
      pure-recursion and countdown/nqueens-style loops at modest inputs and
      add parity-table rows for them (parity runs over `examples/*.ef` +
      `testdata/*.ef`, not `benchmarks/*.ef`); a multi-shot test proving
      frozen values still box correctly (resume twice through a handler that
      re-reads a raw slot).

**Verification.** `bun run ci` green; `compare.ts` gate: fib_recursive,
countdown, nqueens ef-wasm means improve ≥ 25%; no row regresses ≥ 10%.
Soundness guard is caller-side: a slot may stay raw across a dcall only if
the value is not frozen/captured at any suspension point in the *caller*
region — dcall-eligible callees are already suspension-free by devirt's own
purity rule (`wasm_devirt.ts`: dcall requires a transitive suspension-free
rest subtree), so no callee-side check is needed; parent-chain/capt reads
must still poison.

**Exit criteria.** Devirtualized numeric-heavy call chains carry raw i64/f64
end-to-end; unbox ladders only at genuine boundaries.

**Rollback.** Feature-flagged poison rule (conservative default) — revert
flag to previous behavior without touching ABI emitters.

### Step 6 — Typed frame slots for surviving values

**Context.** Fallback of step 5: values that must cross virtual calls or
freeze points sit in frames as anyref. Frames are per-CFn structs
(`wasm_plan.ts` Plan/`__p` annotations); giving frame fields per-slot concrete
widths ($I64/$F64 instead of anyref) removes reboxing at frame materialization
for the remaining hot paths. Requires frame shapes to be per-slot-width
monomorphic and the freeze snapshot paths to box on write.

**Tasks.**
- [ ] Widen Plan: slot → width where classification succeeded; frame struct
      fields typed accordingly; boxing only at freeze/capture and virtual
      boundaries.
- [ ] Keep parent-chain access sound (slots reachable cross-frame stay anyref
      unless all readers classify to the same width).
- [ ] Tests as in step 5 (frame-shape assertions in wasm.test.ts; parity).

**Verification.** `bun run ci` green; `compare.ts` gate: product_early and
parsing_dollars improve ≥ 15% beyond step 5; no regression ≥ 10%.

**Exit criteria.** Hot-path frames carry typed numerics; unbox ladders only
at box-boundary sites.

**Rollback.** Width-assigning pass is additive over step 5's Plan; revert
leaves step-5 behavior.

### Step 7 — Evidence passing: static perform dispatch

**Context.** Today `perform` dispatches dynamically to the reified handler
continuation. Evidence/capability passing makes the active handler a passed
value; when handlers are statically known (the common benchmark case), the
perform site can call the case body directly (what mlton-compiled Effekt
effectively does — its countdown is ~100× faster than everything on pure
per-iteration overhead). Scope the first cut to: handler regions whose case
body is a bare `k(expr)` resume (or returns without resume), where the CPS IR
names the handler locally — inline the case body at the perform site, keeping
the dynamic path as fallback for anything not provable. This does not change
language semantics; multi-shot resumes still work (the inline only applies
where resume identity doesn't escape).

**Tasks.**
- [ ] Analysis in the converter/optimizer (`frontend/cps_opt.ts`): classify
      perform sites by handler provability (static handler, simple case body,
      k not captured/escaping, body not perform-spined in the unchecked-boundary
      sense the checker already tracks).
- [ ] Emission: direct call path for provable sites (`wasm_term.ts`/`wasm_emit.ts`);
      interpreter keeps dynamic path (parity harness compares stdout only).
- [ ] Tests: add `compiler/backend/testdata/` fixtures mixing provable and
      unprovable perform sites (early-exit handler, static multi-shot
      handler) and add parity-table rows for them; multi-shot cases must
      resume correctly (inline only when sound; when in doubt, keep
      dynamic).

**Verification.** `bun run ci` green; `compare.ts` gate: iterator and
product_early improve ≥ 30% over step 6; generator/handler_sieve ≥ 10%; no
regression ≥ 10%.

**Exit criteria.** Statically-handled perform sites dispatch without the
resume machinery; dynamic fallback covers the rest.

**Rollback.** Analysis flag: provable sites fall back to dynamic perform.

### Step 8 — One-shot demotion: multiplicity-directed frame allocation

**Context.** Every perform/resume materializes heap GC continuation frames.
When analysis proves a resume is used at most once (early-exit handlers like
product_early, Get/Set state like countdown) or never (returnless delivery),
frames can be stack-discipline allocations instead. The purity analysis that
selective CPS already runs (`frontend/cps.ts`: effect-row-empty lambdas
convert direct-style) is the model — extend it to a resume-multiplicity
analysis over the CPS IR. Multi-shot benchmarks (generator, tree_explore,
handler_sieve) are exempt — heap frames remain there.

**Tasks.**
- [ ] Multiplicity analysis over CPS IR: for each perform's k, prove ≤ 1
      invocation (count syntactic resume references through the fixpoint used
      by wasm_devirt's purity pass; `+` delayed-constraint shapes stay
      unproven).
- [ ] Backend: one-shot frames allocated without GC (linear scope / stack
      buffer), box-on-escape as in steps 5–6.
- [ ] Interpreter unchanged (correctness reference); parity must stay green on
      all 11 benchmark fixtures at suite test inputs.
- [ ] Tests: add `compiler/backend/testdata/` fixtures — one per
      multiplicity class (never-resumed, once-resumed, multi-shot) — and
      parity-table rows asserting both backends agree; wasm.test.ts
      frame-allocation assertions.

**Verification.** `bun run ci` green; `compare.ts` gate: countdown and
product_early improve ≥ 20% over step 7; resume_nontail ≥ 15%; no regression
≥ 10% on generator/tree_explore/handler_sieve (multi-shot, must not change).

**Exit criteria.** One-shot-proven regions allocate continuation state off the
GC heap; multi-shot behavior bit-identical.

**Rollback.** Analysis flag reverts all regions to heap frames.

## Dependency graph

```
1 (harness) ──► 2 (argv) ──► (harness --argv mode)
1 ──► 3 (binaryen split) ──► 4 (prebuilt run)
3 ──► 5 (raw dcalls) ──► 6 (typed frames) ──► 7 (evidence) ──► 8 (one-shot)
```
2 is independent of 3–8; 5–8 are strictly sequential (each reshapes the value
representation the next consumes). The user-listed order (evidence before
one-shot) is kept; if step 7's profiling shows resume-multiplicity dominating
first, swap 7↔8 via the mutation protocol below.

## Non-goals

- Interpreter throughput work (it stays the reference/reference-checking tier).
- Language/semantics changes (all steps are representation/dispatch only; argv
  is additive).
- Binaryen passes tuning, LLVM/alternative backends, threading/SIMD.
- Beating mlton-compiled Effekt on tight loops; target is closing most of the
  OCaml-multicont gap.

## Mutation protocol

Split/insert/skip/reorder steps by appending a dated note under the affected
step (what changed, why, verification impact). Completed steps are never
reopened; open a follow-up step instead. The global invariants section is
immutable.
