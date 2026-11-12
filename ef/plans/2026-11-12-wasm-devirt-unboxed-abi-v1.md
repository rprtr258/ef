# Wasm call specialization: devirtualization, unboxed numeric ABI, slot typing, binaryen gating

**Created:** 2026-11-12 · **Status:** approved (grilled + adversarially reviewed) · **Mode:** multi-session, 4 sequential PRs, fully serial
**Repo:** ef (`/home/rprtr258/pr/lish/ef`), bun workspace, gates: `bun run ci` must stay green at every step.

## Objective

Make the wasm backend stop paying dynamic-dispatch and boxing costs on statically-known direct→direct calls, so `benchmarks/fib.ef` (naive doubly-recursive fib(28), ~832k calls) approaches hand-compiled wasm speed, and in-process wasm compiles stop paying binaryen's 55–75 ms shrink cost when it buys nothing.

**Measured baseline** (min-of-5, bun, this machine, rev b42ad18a):

| metric | value |
| --- | --- |
| fib wasm run | ~115–175 ms (~140–210 ns/call) |
| fib interp exec | ~510–780 ms (parity baseline, untouched by this plan) |
| fib wasm compile | ~68 ms, of which binaryen shrink L2 = ~55–75 ms; without shrink ~12 ms |
| shrink effect on run time | 114.2 ms with vs 115.5 ms without (zero) |

**Root causes (from CPS-IR + codegen inspection of `benchmarks/fib.ef`):** the IR is already `direct: true` with `dcall` sites and `dret` boundary — selective CPS did its job. What remains per call in wasm: (1) `$CLO` flag dispatch — `refCast`×3, `structGet`×3, `i31Get` + `if`, then `call_indirect` (`compiler/wasm_emit.ts:620` `emitDirectEntryCall`, `compiler/wasm_term.ts:1390-1425`); (2) non-tail direct arm builds `extendFrame` + `retCell` + rest thunk + `emitDispatch` for a rest that could run inline (the interpreter already does: `compiler/eval.ts:78-105` "binding into the ambient env here matches the let case"); (3) every value crosses calls boxed `anyref` (i64 = `$I64` struct per op result, `compiler/wasm_tables.ts:113`); (4) binaryen shrink L2 on every compile (`compiler/wasm_pipeline.ts:497`), zero benefit measured.

**Progressive floors (gates per PR, min-of-7 `compiler/scripts/bench.ts`):** PR1 fib wasm ≤ 77 ms (≥1.5×) · PR2 ≤ 52 ms (≥1.5× further) · PR3 ≤ 26 ms (≥2× further) · PR4 compile −≥50% for in-process callers, zero run-time delta. Every PR: `bun run ci` green, all 6 benchmarks keep interp↔wasm value parity, no other benchmark's wasm run time regresses >5%. A PR that misses its floor but is semantically correct gets the floor re-negotiated in review, not silently skipped.

**Sequencing decided in grilling:** 4 PRs. PR1 devirtualization (static calls, inline rest, generic-call specialization, tight map loops) → PR2 unboxed entry ABI (all-numeric signatures; shape-tag dispatch at generic sites) → PR3 slot width typing + scope-frame elision (needs its own grilling before implementation) → PR4 binaryen opt-out flag.

**Non-goals:** interpreter performance (BigInt i64, tree-walk costs — separate concern); changing the language, checker, or CPS IR semantics; parallelizing bench runs; wasm linear-memory models; inlining function bodies.

**Known pre-existing limitation (out of scope — file a separate issue):** an `any`-callee `call` that reaches a performing closure diverges between backends: the interpreter round-trips the effect correctly, but wasm's static op discovery misses the op (an any-callee site contributes no statically-known ops), so at runtime the host resolves the perform by name into the *builtin* `Read` (`compiler/builtins.ts:162`) and throws (`readFileSync(0)`). Reproduced 2026-11-12 with the `/tmp/anyhole.ef` construct: `g :: fn(a: any): i64 { a(0) }` invoked with a performing closure under a `case Read()` handler — interp prints 43, wasm throws. This plan's purity fixpoint keeps every new gate clear of the hole (any-callee bodies are impure → generic paths), but the underlying op-discovery divergence remains and should be fixed independently (root cause: op discovery should include ops reachable through any-tailed call bodies, or the wasm host should reject unknown op names instead of colliding with builtins).

---

## Step 1 — PR1: Devirtualization + inline rest + tight map loops

**Depends on:** nothing. **Rollback:** revert the PR; no data/format migrations involved.

### Context brief (cold start)

- Read `compiler/cps_ir.ts` header comment (ANF/freeze discipline) and `compiler/cps.ts` header (selective CPS, `direct` classification).
- Read `compiler/wasm_term.ts`: header design note; `planIr` (~line 408) — the planning pass whose traversal mirrors `emitTerm` exactly; `__p` annotation pattern (`ADcall.__p`, handle entries at ~341); `emitCfns` (~2230) — direct CFn entry = `Fn(1)` typed `T_DABI`, signature `(frame: (ref $FRAME)) -> anyref`, emitted per CFn, funcref idx `lambda0 + i`; dcall emitter (~1327-1432): `directBuiltin` fast path, `tailDret` case, direct arm (raw kind) building `extendFrame` + `makeRestThunk` + `retCell` + `emitDispatch`, CPS arm (flag test → `emitCallClosure` with k cell); generic `call` emitter (~1180-1226).
- Read `compiler/wasm_emit.ts`: `emitDirectEntryCall` (~620) — closure dispatch (`refCast(6)`, `structGet(6, {0: fun idx i31, 1: env, 2: size})`, flag `i31Get` + `if`), slots `arrayNew`, frame `structNew(4)`, `argEmit` boxing, `call_indirect`/`return_call_indirect` `T_DABI`, deliver kinds `k | land | tail | raw`.
- Read `compiler/wasm_module.ts`: `emitMapLike` (~735) — map/each/flatmap builtins are *emitted wasm fns* with per-site `loopEntry`/`iterLand` thunks; the generic callback invocation happens inside `loopEntry` via `emitCallClosure` with a RET cell.
- Ef semantics that make the analysis exact: **no shadowing** (checker `checkBind` — no same-frame redeclaration, no rebinding across frames) and **ANF** (`bind`/`let` RHS is an atom, never a term) ⇒ every slot has exactly one binding node and no value-merging join points. `assign` exists (`env.assignVar`) — track it as a re-binding.
- Soundness gates for inline rest + tight loops (⚠ the naive claim "a direct fn can only reach pure callees" is **false**): a direct-classified fn can reach a performing callee through an `any`-typed callee — the checker's app case for an `any` callee contributes no ops to the row (`compiler/types.ts` ~1177 `if (fr.tag === "any") return TANY;`) and such call sites stay `sus: true` generic `call` nodes. Additionally, mixed functions (row {} with internal handles) keep the direct boundary and their islands perform (`compiler/cps.ts:53-55`). Therefore every gate in this PR consumes a **per-CFn purity classification computed to a fixpoint** (task 1), never the checker's row alone. Repro of the any-hole divergence (pre-existing, interpreter handles it but wasm throws — see "Known pre-existing limitation" in Non-goals): `/tmp/anyhole.ef` construct — `g :: fn(a: any): i64 { a(0) }` called with a performing closure under a handler.

### Task list

1. **Analysis pass: per-slot provenance + per-CFn purity fixpoint** (new function in `compiler/wasm_term.ts` alongside `planIr`, or new leaf `compiler/wasm_devirt.ts` if it exceeds ~150 lines — follow the wasm.ts header's layering rules and update that header + the module list in `AGENTS.md` item 11 either way). Two results:
   **(a) Per-slot provenance.** During the `planIr` traversal, track per-TLevel-slot provenance: `slot → {kind: "clo", fun: number} | {kind: "unknown"}`.
   - `mkfn` node binds its temp → provenance `{clo, t.fun}`.
   - `bind`/`let` with `var` RHS → copy source slot's provenance into the target slot.
   - `assign` to slot s with `var` RHS → intersect (if RHS provenance ≠ current, s → unknown). Assign targets resolve through the frame chain (`resolveT`) at any depth — invalidation must hit the actual target slot, and provenance reads at call sites must resolve through the site's `TScope` walk.
   - **`letk` param slots are always unknown** — they DO have join points (if-join merges, while loop params feed letk params), unlike binding slots.
   - Any other RHS (prim, call result, dcall result, field, atom non-var) → unknown.
   - Value uses do **not** invalidate (the slot still always holds that `$CLO`; static call sites just `refCast` it — sound). Uses matter only for map-callback eligibility: record per (dcall/call node, arg position) whether the arg atom's slot has singleton clo provenance — consume at emit time.
   - Store results as `__p` annotations on call nodes (`ADcall.__p.devirt?: {fun: number}` / `ACall.__p.devirt?`) — the established annotation pattern; no new global state.
   - **Do not build set-provenance/if-chain machinery.** Under single-assignment ANF, *binding* slots have exactly one binding node and no value-merge join points, so their provenance is singleton-or-unknown; the only set-valued positions would be letk params, which task 1 pins to unknown. If implementation suggests otherwise, stop and report instead of generalizing.
   **(b) Per-CFn purity fixpoint.** Over `ir.funcs`, compute `pure[i]` to a fixpoint: `pure[i] = false` iff body_i contains a `call` node, a `perform` node, or a `handle` node, OR any `dcall` to `pure[j] = false` (seed via direct scan, propagate along dcall edges until stable). A dcall to an unknown/direct-but-mixed CFn makes the caller impure — dcall targets are always direct-classified but may still suspend internally. Consume from tasks 3 and 5; store as `__p.pure?: boolean` per CFn alongside the annotations.
2. **Static direct→direct calls at `dcall` sites.** In the dcall emitter's direct arm: when `__p.devirt` is set, replace the closure reads + flag `if` + `call_indirect` with: build the callee frame exactly as today (`extendFrame`-equivalent for the callee's base frame), `argEmit` unchanged, then static `call`/`return_call` to funcref `lambda0 + fun` (same index the `$CLO` carries). The generic arm stays as fallback for unknown provenance.
3. **Inline the rest after a non-tail direct `dcall` — gated on a suspension-free rest AND callee purity.** ⚠ A direct fn's body CAN suspend two ways: (a) mixed functions (row {} with internal handles) keep the direct boundary and their islands perform (`compiler/cps.ts:53-55`); (b) an `any`-callee generic `call` inside the rest reaches a performing closure (checker app case, `types.ts` ~1177), and a `dcall` inside the rest can reach a mixed fn internally. A perform unwinds the wasm stack — an inline rest would be lost on resume, which is exactly what today's cell+thunk layout preserves. Therefore: mark `__p.inlineRest` on a direct dcall only when (i) the rest contains no `perform` and no `handle` node (conservative static walk in `planIr`), and (ii) every `dcall` inside the rest targets `__p.pure[fun] = true`. When marked, replace `extendFrame(fpN2)` + `makeRestThunk` + `retCell` + `emitDispatch` with: `call` (not tail), result into a local, bind `t.name` via the site's slot (`storeAt`), `norm` skipped when site and callee share the stamp (same rationale as the `tailDret` comment at `wasm_term.ts:1391`), then `emitTerm(wk, t.rest)` inline — the rest is re-walked in the **site's** TScope/esc (not the phantom child frame levels the cell path created). When unmarked, keep today's cell/thunk layout unchanged. Keep `wk.depth` bookkeeping correct for br targets (jumps to letks materialized before the dcall resolve via their k locals — verify with a nesting example). The CPS arm and generic-call path keep the cell/thunk protocol unchanged. Document the gate's rationale in a comment at the emission site (mirror of the interpreter's ambient-env binding, `eval.ts:78-105`; sound only because the rest cannot suspend).
4. **Specialize generic CPS `call` sites.** In the `call` emitter: when `__p.devirt` is set and the target CFn is direct, emit the static `T_DABI` entry call with the site's k as a land cell (`retCell` + `emitDispatch`, like today's CPS arm but without closure dispatch). Perform-capable callees (non-direct CFns, builtins, unknown provenance) unchanged.
5. **Tight map/each/flatmap loops.** In `emitMapLike`: when the callback argument at that builtin site has singleton clo provenance to a direct CFn that is `__p.pure` (no call/perform/handle in its body, all its dcalls target pure CFns), emit the tight variant — typed i32 counter local, plain `loop`/`br_if` over the view window, per-element: unbox `xs[i]`, static call to the callback's `T_DABI` entry (frame = callback closure's env), box result into `res[i]` (map/flatmap) — no `iterLand`/`loopEntry` thunks, no RET cells. Final result dispatch through the entry's k stays as today. The generic variant stays for escaping/unknown/pure-but-mixed callbacks. Document the gate's rationale (purity fixpoint, not `direct` classification) in a comment at the variant's emission site.
6. **Tests + examples** (`compiler/wasm.test.ts` behavioral, plus parity examples under `examples/` picked up automatically by `compiler/examples.test.ts` interp↔wasm parity):
   - example: recursive pure fn called only at dcall sites (devirt + inline rest — `benchmarks/fib.ef` shape).
   - example: fn value passed to another fn, stored in a local, called generically (provenance unknown → generic path must still work).
   - example: direct fn passed to `map` (tight loop) vs a performing callback fn (generic loop path).
   - example: generic `call` to a captured direct closure (call-node specialization).
   - `wasm.test.ts`: nesting torture — dcall whose rest jumps to a letk materialized before it; dcall inside if-arms inside a loop; multi-shot handler resume around a map with a direct callback (resume must not observe the tight loop's internals); **mixed callback torture** — direct callback containing an internal handle island that performs, driven by multi-shot resume through the generic loop path; **any-callee impure chain** — pure fn calling through an `any` hole into a performing fn (must stay on the generic path everywhere; also pins the pre-existing wasm divergence shape as a known-limitation smoke test, see Non-goals).
7. **Bench + doc updates.** Run the bench protocol below; update the wasm.ts header design doc for the new pass; AGENTS.md module list.

### Verification commands

```bash
bun run ci
bun compiler/scripts/bench.ts --runs 7 --json > /tmp/bench_pr1.json   # in this workspace
# in the baseline workspace:
bun compiler/scripts/bench.ts --runs 7 --json > /tmp/bench_base.json
# diff JSON rows: fib wasm min/median, all other rows within 5%
wasm-tools validate <(bun compiler/cli.ts buildwasm /tmp/any.ef 1>&2; cat /tmp/any.wasm)  # or on a file
```

### Exit criteria

- fib wasm run ≤ 77 ms min-of-7; other 5 benchmarks within 5% of baseline; parity intact on all benchmarks + new examples.
- `bun run ci` green. Provenance analysis has a unit test (escape/unknown cases) in `compiler/wasm.test.ts`.
- No new `letk`/freeze protocol changes — IR unchanged.

---

## Step 2 — PR2: unboxed numeric entry ABI + shape-tag dispatch

**Depends on:** Step 1 merged. **Rollback:** revert; Step 1's boxed static calls remain as fallback path.

### Context brief

- Step 1's static call sites know the callee CFn `fun` index. A CFn's checker type rides the IR: `CFn.typ?: FunT` (`compiler/cps_ir.ts:132`) — **optional and possibly non-concrete**. Numeric specialization is eligible only when `typ` is present, every `params[i]` and `ret` is a concrete numeric `Prim` width, and `anyTaint` is not set (`types.ts:30-42`); otherwise (missing `typ`, type `Var`s, polymorphic fn, `any` involvement) fall back to Step 1's boxed static call. `contCall` FunTs are resume-binder types and never appear on CFns.
- Signature table: `compiler/wasm_tables.ts` `SIGS` + type indices (`T_DABI`, `T_KABI`, …). WasmGC: raw i64/f64/f32/i32 are plain valtypes in function signatures — no GC boxing needed for params/results.
- **Inventory for the numeric ABI (all verified):** `$CLO` is constructed in **two** places — `mkfn` emission (`compiler/wasm_term.ts:1184`) and the resume binder (`compiler/wasm_term.ts:1714`) — and read at `compiler/wasm_emit.ts:522-534`; a `$CLO` layout change touches all of them. Numeric entries are new *functions*: they need funcref indices through `assignIndices`/the funcref table (`compiler/wasm_pipeline.ts`), not just new type indices. Tail dcall sites use `return_call`, which requires callee return type == caller return type exactly — with raw/boxed mismatch (e.g. boxed tail site → numeric entry) fall back to the boxed entry rather than emitting a conversion tail call. Rebox sites to audit when unboxing: generic arm's RETURN path (`compiler/wasm_term.ts:1224-1229`) and `emitDirectEntryCall` deliver kinds (`compiler/wasm_emit.ts:648-656`).
- Primitive for raw atom reads: `readBoxPayload` (used in `emitMapLike`) + `widthHelper`/`rebox` in `compiler/wasm_emit.ts`. i64 payloads are wasm `i64` inside the box struct — reading is a `structGet`, no BigInt involvement at the wasm level.
- Signedness: u64/u32 ops must select unsigned wasm ops — `emitOpPrim` already dispatches on operand stamps; raw locals preserve the stamp, so reuse that logic.
- **Width extraction gap:** `compileWithOps` discards `checkProgram`'s result (`compiler/wasm.ts:139-142`), and only let-bound lambdas get deep-resolved types (`compiler/types.ts:857`); directly-passed lambdas carry var-tagged params. Either thread `Checked` into the pipeline and `uni.deepRes` at plan time, or accept that directly-passed numeric lambdas don't specialize (conservative fallback is sound but weakens the map-callback payoff — decide in PR review, document the choice).

### Task list

1. **Numeric signature family.** In `wasm_tables.ts`: add `T_DABI_NUM`-family type indices for `(ref $FRAME, w₁…wₙ) -> wᵣ` where all w are numeric valtypes. Assign indices alongside existing ABI types (mind `assignIndices` in `compiler/wasm_pipeline.ts` — the funcref index layout is load-bearing).
2. **Numeric entry emission.** In `emitCfns` (`wasm_term.ts` ~2230): when a direct CFn has ≥1 Step-1 static call site whose provenance + all-numeric signature (from `CFn.typ`) match, emit a second entry `Fn(k+1)` typed with the numeric signature. Params become **typed wasm locals**; the entry's `TLevel` for params gains a locals map so `loadAt`/`storeAt` on depth-0 param slots emit `local.get/set` instead of frame `arrayGet/arraySet`. Frame param = the closure's captured env (scope chain base for capts) — no slots array, no arg boxing at the call. Body walk otherwise unchanged (scopes still `extendFrame` over the captured env).
3. **Specialized call-site emission.** Static dcall site with numeric match: frame operand = closure env (`refCast(6)` + `structGet(6,1)` — no allocation), args pushed **raw** (stamped lit → `i64Const/f64Const/f32Const/i32Const`; boxed var → `readBoxPayload`; typed param-local slot → `local.get`), `call`/`return_call` the numeric entry, raw result → `rebox` once into the bound slot (until PR3 types that slot). Site/callee stamp mismatch → fall back to the boxed static call from Step 1.
4. **Shape-tag dispatch at generic sites.** Extend the `$CLO` struct with the numeric entry's funcref (nullable; set only for direct CFns that got a numeric entry) — layout change goes in `wasm_tables.ts` (`$CLO` struct type) + every `mkfn` emission + `emitDirectEntryCall` field indices. In the direct arm of generic call sites (Step-1 fallback path and `call` specialization): if the closure advertises a numeric entry **and** the site's arg/result stamps are all numeric and shape-equal, take the numeric entry with raw args; else boxed path. This is what makes escaping numeric fns (e.g. through `map`) still benefit.
5. **Width coverage tests.** Parity examples: specialized calls at all six widths (i32/u32/i64/u64/f32/f64 — f32 exercises the fround-at-producing-nodes discipline, u64 the unsigned op selection); mixed-signature fn (one boxed param) → boxed static call; polymorphic direct fn (`id :: fn(x: 'a): 'a`) → boxed static call, no numeric entry; escaping numeric fn called generically → shape-tag dispatch; numeric fn inside a handler island.
6. **Bench + docs** (same protocol as Step 1; update wasm.ts header + AGENTS.md if a new module was added).

### Verification commands

```bash
bun run ci
bun compiler/scripts/bench.ts --runs 7 --json > /tmp/bench_pr2.json   # diff vs PR1
wasm-tools validate examples/<width-example>.wasm   # after buildwasm on each width example
```

### Exit criteria

- fib wasm run ≤ 52 ms min-of-7; other benchmarks within 5%; parity intact everywhere including new width examples.
- `bun run ci` green; binaryen `m.validate()` still passes on every module (it runs unconditionally in `buildModule`).

---

## Step 3 — PR3: slot width typing + scope-frame elision

**Depends on:** Step 2 merged. **⚠ This step gets its own grilling/planning pass before implementation** (capture + freeze discipline is the risky part). This entry records the agreed direction and constraints; the implementing session must run the plan-critique interview on the detailed design first.

### Context brief

- Frames are heap structs `{parent, slots: anyref[]}` (`extendFrame`, `wasm_term.ts:606`); direct fn bodies allocate a fresh frame per `scope` node (2 per fib call: body + if-arm) and every numeric op result is boxed into a slot (`rebox` at op sites).
- The multi-shot freeze discipline (`cps_ir.ts` header, plan's `freezeSlots`): values live across a possible suspension must be snapshotted. A `perform` inside a handle island unwinds to the host — **locals die, frames survive**. Therefore a slot may live in a wasm local only if no perform site reachable from its live range can suspend while it is live.
- Closures capture *frames*, not locals — any slot reachable from an escaping closure's `capts` must stay in a frame.

### Task list (direction, to be sharpened by the PR3 grilling)

1. Extend the Step-1 escape/provenance pass to classify, per slot: captured-by-escaping-closure? frozen-at-perform (reuse/extend `freezeSlots`)? statically numeric width (from binding-site stamp, `assign` RHS stamps intersected)? Only slots passing all three → typed wasm mutable locals; frame/slots allocation skipped for scopes whose every slot got elided (`scope`-frame elision). Capts resolution must transparently fall back to frame reads for non-typed slots (mixed frames).
2. Op-site unboxing: ops whose result slot is typed emit raw arithmetic with `local.set` — no `rebox` (this is where fib's per-op box allocs disappear).
3. Torture tests: handler island inside a direct fn that resumes multi-shot (frozen slots must still snapshot correctly); escaping closure capturing a frame whose sibling slots were elided; `assign` to typed slots; REPL-accumulator binding survival (top-level binds land in caller frames — `cps_opt.ts` guard "source-named binds are never dropped" is the analogous invariant).
4. Bench + docs as before.

### Verification commands

```bash
bun run ci
bun compiler/scripts/bench.ts --runs 7 --json > /tmp/bench_pr3.json
```

### Exit criteria

- fib wasm run ≤ 26 ms min-of-7; parity + ci green; freeze/capture invariants have explicit tests.

---

## Step 4 — PR4: binaryen shrink opt-out for in-process compiles

**Depends on:** nothing (can land before/parallel to Steps 2–3 if review capacity allows — but keep the serial plan). **Rollback:** revert flag default.

### Context brief

- `compiler/wasm_pipeline.ts` `buildModule` (~497): shrink L2 gated on `EF_SKIP_WASM_OPT !== "1"`; `m.validate()` runs unconditionally right after — validation must **never** be skipped. The env-var bypass already exists (measured 2026-11-12: zero run-time delta on fib) — this PR is the API option + caller flips + measurement, not new bypass machinery.
- Callers of `compileWithOps`: `compiler/cli.ts:79` (`buildwasm` artifact), `compiler/scripts/bench.ts:55`, `playground/src/bridge.ts:145,160` (in-browser studio — pays the 55–75 ms per compile), tests.

### Task list

1. Add `compileWithOps(src, opts?: {shrink?: boolean})` (and thread through `compile`), default `true` — no behavior change for existing callers.
2. Measurement task: bench all 6 benchmarks with shrink on/off; decision rule — if any run-time regresses >5% with shrink off, that caller keeps shrink on (record the table in the PR description).
3. Pass `shrink: false` at in-process compile-and-run callers: `playground/src/bridge.ts` and `bench.ts`. `buildwasm` keeps shrink (published artifact). Keep the `EF_SKIP_WASM_OPT=1` env override documented in `compiler/wasm.ts`.
4. Test: module compiled with `shrink: false` still passes `m.validate()` and `runModule` produces correct results (extend `compiler/wasm.test.ts`).

### Verification commands

```bash
bun run ci
EF_SKIP_WASM_OPT=1 bun /tmp/noop 2>/dev/null; bun compiler/scripts/bench.ts --runs 7  # compile-time column check
```

### Exit criteria

- In-process compile (fib-sized program) ≤ 15 ms; zero run-time regression on all benchmarks per the measurement table; ci green.

---

## Mutation protocol

- Steps may be split further only at PR boundaries; record splits in this file under the step with date + reason.
- If a progressive floor is missed: do not skip the gate — re-measure (min-of-7, both workspaces), and if the miss reproduces, renegotiate the floor in review with the measured table attached.
- If the PR3 grilling invalidates the slot-typing direction, rewrite Step 3 here before implementing (per plan-critique mutation rules).

## Parallelism summary

Fully serial: Step 1 → Step 2 → Step 3 → Step 4. No parallel steps (all touch `compiler/wasm_term.ts`/`wasm_emit.ts` hot paths; concurrent writers would collide).

## Review log

- 2026-11-12: adversarial review (reviewer subagent) — verdict FIX-FIRST; all CRITICAL/MAJOR findings fixed in place: (1) context-brief purity claim falsified by the `any`-callee hole (`types.ts` ~1177) → per-CFn purity fixpoint added (task 1b) and gates rewritten (tasks 3, 5); (2) tight-loop gate now excludes pure-but-mixed callbacks + multi-shot mixed-callback test added; (3) `letk` param slots pinned to unknown (join points exist); (4) assign/resolveT + TScope re-walk mechanics recorded; (5) numeric-ABI inventory added ($CLO dual constructors wasm_term.ts:1184/1714, funcref indices in assignIndices, tail `return_call` mismatch fallback, rebox audit sites, `Checked`/deepRes width-extraction gap); (6) PR4 reworded (mechanism exists); (7) any-hole backend divergence verified live (interp 43 vs wasm throws via builtin-`Read` name collision) and recorded as an out-of-scope known limitation. Verified sound: all file:line anchors, emitDirectEntryCall frame semantics, generic-call specialization delivery, CFn.typ feasibility.

## Step 2 implementation record (2026-11-12)

Implemented as specified, with three resolved design points beyond the brief:

- **Dispatch-free body gate.** Every dispatch tail inside an entry returns anyref (dispatch chains, rest thunks, handler case fns), so a raw-return entry requires a dispatch-free body: no `call`/`perform`/`handle` nodes, no materialized letks, every dcall devirt + inlineRest and non-tail (`wasm_devirt.ts` entrySafeBody). Tail dcalls keep the boxed `return_call` (PR1's O(1) guarantee); a raw tail would need callee-ret == caller-ret width matching — deferred to the PR3 grilling alongside slot typing.
- **Arg stamps at conversion.** Numeric-site matching reads per-arg stamps; computed args arrive as unstamped converter temps, so `cps.ts` convArgs now carries the arg node's numKind onto the atom — only when the node's own type is a concrete numeric prim (comparison nodes carry numKind for their OPERANDS; stamping the bool would misshape reads).
- **Shape tag = interned SIGS index.** `$CLO` gains `numfn` (funcref table index + 1, 0 = none) and `numsig`; generic arms compare numsig against their stamp-derived `numSig` key. i32/u32 share the i32 valtype — raw bits are width-agnostic, per-op signedness lives in each body's stamps.

**Floor measurement (min-of-7, `compiler/scripts/bench.ts`, this machine, PR1 baseline vs PR2):**

| bench | PR1 wasm min | PR2 wasm min | delta |
|---|---|---|---|
| fib.ef | 102.8 ms | 95.6–103 (best 69.9) | ~0–5%, best-run −32% |
| boy.ef | 0.9 | 0.9 | — |
| handlers.ef | 233–458 (noisy) | 238–299 | noise-bound |
| loop.ef | 1739 | 1728 | −0.7% |
| ray.ef | 331 | 333 | +0.5% |
| sieve.ef | 80.5 | 79.6 | −1.1% |

PR2's ≤ 52 ms floor is **missed** (PR1's ≤ 77 floor was already missed at ~103 on this machine): the unboxed ABI removes arg boxing + the slot-store round trip at numeric calls and computes params raw, but fib remains dominated by the per-call activation/scope frame allocations, the boxed dcall-result slots (arg box→unbox at each call), and the if-join slot round trips — exactly PR3's slot-typing/elision scope. Renegotiation requested in review with the table above; the mechanism is in place and PR3 builds directly on it (emitNumericEntryCall + pushRawAtom already produce/consume raw operands).
