# Selective CPS transform for ef — construction plan

**Status:** draft v1 · **Created:** 2026-11-12 · **Mode:** multi-session (3 PRs, strictly serial)

## Objective

Stop compiling the whole program in CPS. Today every function and every call
pays the continuation tax (explicit `k` operands, heap frame arrays, wrapper
letks, freeze snapshots) even when nothing in its dynamic extent can suspend.
Convert ef to a **selective** scheme:

- A function whose effect row resolves to exactly `{}` (nothing can escape its
  frame) compiles **direct-style**: `dcall` calls bind results in-frame, `dret`
  tails return values, no continuation machinery at its boundary.
- Everything else stays CPS exactly as today: `perform`, `handle`, calls to
  non-empty-row callees.
- Mixed functions (empty row but containing internally-handled effects) keep a
  direct boundary with CPS islands inside.

**Goal:** both backends benefit. Wasm is the main winner (plain wasm calls, no
frame alloc, no k plumbing for pure code); the interpreter loses continuation
reification at direct call sites.

**The selection predicate already exists:** effect rows (`FunT.effs`) propagate
through calls and unify (compiler/types.ts:1132), handlers subtract handled ops,
and `lam.typ` is stamped resolved (compiler/types.ts:836). A call site may be
direct iff the callee's resolved row is exactly the empty set.

## Dependency graph

```
Step 1 (selection + IR + eval + opts + wasm generic path)
  └─> Step 2 (wasm dual ABI)
        └─> Step 3 (mixed functions + interp trampoline + bench + docs)
```

No parallel steps: all three touch `compiler/cps*.ts` and the wasm term
emitters, and each builds on the previous IR shape.

## Invariants (re-checked after every step)

- `bun run ci` green (typecheck + eslint incl. comment-hygiene + runtime-deps +
  full test suite).
- `examples.test.ts` interpreter↔wasm parity green — this is the semantic
  safety net for every IR change.
- No behavior change: same outputs on all examples and tests.
- Multi-shot resume stays correct: only continuations captured at `perform`
  sites are multi-shot; they live entirely in CPS regions. Direct regions
  contain no suspension points, so the freeze discipline is untouched.

---

## Step 1 — Suspension stamps, `dcall`/`dret` IR nodes, converter selection, eval, opts, wasm generic path

Semantics-neutral: wasm still compiles every function as `T_KABI` and emits
`dcall` through the existing generic land-cell path. All gates green at the end.

### Context brief

A fresh agent needs:

- Module map and rules: `AGENTS.md` at repo root (architecture §, working
  rules). Gates: `bun run ci`. Tests are the spec: `compiler/index.test.ts`,
  `compiler/cps_opt.test.ts`, `compiler/examples.test.ts` (interp↔wasm parity).
- IR node set: `compiler/cps_ir.ts:50-91` (`CTerm` union; `CAtom` at :34-37).
  Multi-shot freeze discipline pinned in the header comment.
- Converter: `compiler/cps.ts` — `toCps` at :309, `callTail` at :95 (wrapper
  letk for numKind norm), `case "app"` at :255 (generic call emission
  ~:278-287), `case "lambda"` at :149.
- Checker facts: `Effs` rows = concrete `Set<string>` | unbound row var
  (compiler/types.ts:23-30); callee rows unify at call sites (types.ts:1129-1135);
  `lam.typ` stamped resolved (types.ts:836); post-check stamping pattern =
  `stampNumKinds(prog.nodes, uni)` in `checkProgram` (called at types.ts:1314)
  reading `uni.nodeTypes` — recorded for every checked subexpr including app
  callees (`infer` sets it at types.ts:693; the app case infers the callee at
  types.ts:1116); checker-stamped
  node fields precedent: `numKind`, `div`, `idx`, `asKind`, `arrKind`
  (compiler/parser.ts:73-94). **`unify` is a no-op when either side is
  `any`** — an `any` value flowing into a function-typed position does NOT
  taint the FunT's row; Task 1's markers exist because of this.
- Interpreter: `compiler/eval.ts` — `apply` :27 (binds `$ret`, enters body),
  `evalTerm` switch :45-107 (`call` case :73-77 resolves k and applies,
  returning an `Outcome`), `evalPrim` returns `Value` synchronously (`let`
  case :65, `evalPrim` :172) and cannot propagate Outcomes, `mkfn` closure
  construction :70-72.
- Optimizer: `compiler/cps_opt.ts` — walkers `mapAtoms` :56, `mapPrimAtoms`
  :74, `rewriteChildren` :83, `visitRefs` :101, helpers `varUseCounts` :137,
  `freezeNames` :151, `collectAssigned` :164, `collectCapts` :177; four
  passes from :185 (dead-binding drop :286 drops only throw-free prims). Every
  `CTerm` switch ends in
  `assertNever` (compiler/assert.ts) — adding nodes fails typecheck in every
  walker until updated.
- Wasm consumers that must accept the new nodes: `compiler/wasm_term.ts`
  `emitTerm` cases `letk` :988, `call` :1108, `perform` :1132, `jump` :1183,
  `halt` :1203; `directBuiltin` :1263 (existing static-direct seam for
  non-suspending builtins); `emitCallClosure` + `CallOpts` (`land` cells) at
  `compiler/wasm_emit.ts:510`.
- VCS: plain git, no jj directory at repo root. Direct commits to a feature
  branch; no gh workflow assumed.

### Task list

1. **Checker: FunT markers** — `compiler/types.ts`: two marker fields on
   `FunT` objects, carried through `deepRes`'s FunT reconstruction
   (types.ts:164-170 — reconstruction goes via `tFun`, so copy markers
   there):
   - `anyTaint?: true` — set at the `unify` site when a `FunT` unifies with
     `any` (unify is otherwise a no-op for `any`). An `any` value flowing
     into a function-typed position (`let a: any = f; run(a)`) must never
     stamp direct.
   - `contCall?: true` — set on the resume binder's FunT in the checker's
     handle case (resume is currently typed `tFun([sig.ret], fresh,
     new Set())` — an empty row by construction, yet invoking a reified
     continuation re-enters captured CPS machinery and can suspend,
     multi-shot). Invoking it must never stamp direct.
2. **Checker stamp** — `compiler/types.ts`: add `stampSuspension(prog.nodes,
   uni)` called next to `stampNumKinds` in `checkProgram`. For each `app`
   node: resolve the callee subexpr's type from `uni.nodeTypes` via
   `uni.deepRes`; stamp `e.sus?: boolean` on the app node:
   - `false` iff the callee type is a `FunT` carrying neither marker whose
     row `deepRes`olves to a concrete empty set — except `native` builtins
     (`map`/`each`/`flatmap`; detect via the `kind` field of the builtins
     table, which types.ts already imports for env seeding in
     `checkProgram` — do NOT extend `analysis.ts`'s `BUILTINS`, it is a
     parser-types-only leaf with no kind field): always `true`.
   - `true` for: nonempty row, unbound row variable, non-`FunT` (incl. a
     callee *typed* `any`), `anyTaint`, `contCall`.
   If a callee subexpr type is missing from `uni.nodeTypes`, default to
   suspending (safe; operators never reach this path — see Analysis notes).
3. **IR nodes** — `compiler/cps_ir.ts`: add a CTerm node
   `{t: "dcall", fn: CAtom, args: CAtom[], name: string, rest: CTerm,
   norm?: string}` — a call that cannot suspend: the result binds to `name`
   and flows to `rest` in-frame (a CTerm, not a CPrim: the interpreter must
   be able to return an Outcome from it, and it is not throw-free), plus
   tail node
   `{t: "dret", v: CAtom}` (deliver the function's result to its caller).
   Rewrite the header's freeze-discipline comment for the selective regime,
   present tense: suspension happens only at `call`/`perform`/`handle`;
   `dcall` never suspends and therefore never freezes.
4. **Converter** — `compiler/cps.ts`:
   - Per-lambda classification walk (lambda's own body, not descending into
     nested lambdas): contains `perform`, `handle`, or an `app` with
     `sus: true` ⇒ CPS function; otherwise direct. Conservative for v1:
     any `handle` ⇒ CPS (mixed functions are Step 3).
   - Direct function conversion: the outermost K emits `dret` instead of
     `jump $ret`; `$ret` is never referenced in direct bodies.
   - App case (~cps.ts:278-287): `e.sus === false` ⇒ emit the `dcall` node
     (result bound to a fresh name, `norm` from the site's numKind) and
     continue `K(name)` — no wrapper letk, no freeze at the site.
5. **Interpreter** — `compiler/eval.ts`: `case "dcall"` in `evalTerm`,
   Outcome-safe: evaluate callee + args, then `apply(f, args, adhocK)` where
   `adhocK` stores the norm-normalized value into `t.name` and continues
   `evalTerm(t.rest, ir, env, k)` — the same Outcome-propagating machinery
   as the `call` case (:73-77), minus `resolveCont`. Correct only because a
   classified-direct callee never yields `{tag: "eff"}` (the selection
   invariant — Task 1's markers are what make it trustworthy). Do NOT put
   dcall in `evalPrim` (it returns `Value` synchronously and cannot
   propagate Outcomes). `case "dret"` delivers to the ambient `k`. Mark
   `mkfn` closures direct when `ir.funcs[t.fun]` is direct
   (field on the `fn` Value, :70-72) — `apply` may ignore it this step.
6. **Optimizer** — `compiler/cps_opt.ts`: thread `dcall`/`dret` through every
   walker and pass listed in the context brief. Semantics to preserve:
   - `dret` is a tail like `jump`; a dcall's result is an ordinary in-scope
     name (read-temp substitution applies to it).
   - dcall's atom reads flow through `freezeNames`/`visitRefs`/`mapAtoms`
     like call args — a dcall inside a letk body after a suspension still
     needs the freeze for pre-suspension temps.
   - Dead-binding drop must treat `dcall` as trapping (the callee can divide
     by zero / index out of range): never drop a dead dcall binding — do not
     add it to any throw-free list (dropDeadBinds's default is already safe;
     keep it that way).
7. **Wasm generic path** — `compiler/wasm_term.ts` `emitTerm`: `case "dcall"`
   = `emitCallClosure` with a synthesized land-style RET cell that stores the
   result and runs `rest` (no dual ABI yet — all funcs stay `T_KABI` with
   their `kL` local; `dret` = dispatch the value through `kL`, the same
   delivery `halt`/jump-to-`$ret` uses today). Note the temporary shape in
   the `wasm.ts` header design doc.
8. **Tests** — `compiler/index.test.ts`: (a) pure recursive function
   (self-call is `dcall`); (b) pure function passed to `map` (direct closure
   invoked through the generic path); (c) effectful function calling pure
   helpers (`dcall` inside a CPS body); (d) multi-shot `resume` whose captured
   continuation crosses bindings produced by `dcall` (freeze interaction);
   (e) `any`-typed callee and row-polymorphic higher-order callee stay
   suspending (program behaves identically — assertions are behavioral);
   (f) regression for `anyTaint`: a suspending function passed through an
   `any`-typed binding into a parameter typed `fn(): i64` (pure-typed
   position) must still suspend correctly;
   (g) regression for `contCall`: a case body returns its resume binder, the
   caller invokes it, and the resumed computation performs again
   (multi-shot) — must suspend at the invoke site, not miscompile.
   `compiler/cps_opt.test.ts`: dcall/dret through the rewrites.

### Verification commands

```bash
bun run ci
bun compiler/cli.ts run examples/star.ef
bun compiler/cli.ts buildwasm examples/squares_sum.ef && wasm-tools validate examples/squares_sum.wasm
```

### Exit criteria

- All gates green; parity suite green (both backends consume the new IR).
- Behavioral outputs identical to pre-change (tests unchanged except additions).
- Spot check (temporary `console.error` in the converter, removed before
  commit): pure-recursive example classifies its function direct; effectful
  example keeps CPS functions.

---

## Step 2 — Wasm dual ABI (the perf win)

Direct functions become real wasm functions returning values; direct calls
stop allocating frames and passing continuations. CPS machinery unchanged.

### Context brief

- Everything from Step 1 (IR now contains `dcall`/`dret`; classification
  stamps exist; conservative rule: `handle` ⇒ CPS function).
- Value plane and type table: `compiler/wasm_consts.ts:60-73` (arrays 0..11;
  named func-type constants run to T_GETI64=29 and `T_TRACE = 34` is taken
  — wasm_consts.ts:76 — so 30..33 are the free indices for the direct ABI),
  `T_KABI = ((ref null $FRAME), (ref null $K)) -> anyref`.
- Closure representation: `$CLO` struct 6 `{i31 idx, env frame, i31 fsize}`
  (`compiler/wasm_types.ts:40`); static builtin closures via
  `StaticDesc {t:"clo", fni, fsize}` (wasm_types.ts:98).
- Function emission: `emitCfns` (`compiler/wasm_term.ts:1895`, every CFn is a
  `T_KABI` fn with locals `[frame, k]` and a `$ret` local); `emitCallClosure`
  (`compiler/wasm_emit.ts:510`) — frame alloc (`arrayNew` + `structNew`),
  arg stores, k selection (`tail`/`land`/`direct` opts; `direct` today serves
  non-suspending builtins with a static funcref + fsize).
- Trampolines invoking user closures generically: `compiler/wasm_module.ts`
  map/each/flatmap (:733 area, land cells; `emitCallClosure` at :831).
- Case fns / ret-resumes / main stay `T_KABI` over the continuation chain
  (`emitCaseFns`, `emitRetResumes`, `emitMain` — wasm_term.ts:1895+).

### Task list

1. **Direct ABI type** — `compiler/wasm_consts.ts`: add
   `T_DABI = ((ref null $FRAME)) -> anyref` at index 30 (30..33 free;
   `T_TRACE = 34` taken); register
   in the type-building sequence (`wasm_types.ts`/`wasm_tables.ts` where func
   types are assembled).
2. **Closure flag** — extend `$CLO` with a direct marker (executor's choice:
   4th `i31` field, or dedicated i31 value range in `idx`; prefer an explicit
   field). Update every construction site: `mkfn` emission,
   `StaticDesc`-built builtin closures (`fn`-kind builtins are direct),
   trampoline-created closures. `wasm_types.ts` struct 6 and every
   `structGet(6, ...)` reader in `wasm_emit.ts`/`wasm_term.ts`.
3. **emitCfns split** — direct functions (no `handle`/`perform`/suspending
   site by classification): no `k` param/`$ret` local; `dret` emits
   `return <boxed v>`. CPS functions unchanged. Constraint: direct bodies
   may still contain **label-form letks** (if-joins — exit-continuation beta
   only splices single-jump exits, so shared joins survive) — the label path
   is k-free and fine, but the **materialized** letk path hard-codes `wk.kL`
   (wasm_term.ts:1014-1033). The converter must guarantee — asserted in wasm
   emission — that a direct function contains no materialized letk, which
   holds iff it has no `call`/`perform` k operands (all its callees are
   direct/builtin prims).
4. **dcall fast paths** — in `emitTerm`'s `dcall`. **The `$CLO` runtime flag
   decides the path — static type knowledge is only a hint, never a bypass**:
   a statically pure-typed callee value can be a resume-binder continuation
   (`contCall`) or an `any`-smuggled suspending closure.
   - Statically-known direct CFn callee (name bound by `mkfn` with known
     `fun` index AND that function classified direct): static direct `call`
     to `lambda0 + fun` (generalize the `directBuiltin` pattern), result
     bound into the frame slot; norm per the node's `norm`. A statically
     known CPS callee (mixed function under the v1 rule) takes the generic
     path.
   - Unknown callee: flag check on `$CLO` → direct entry call, result into
     slot; else the generic land-cell path from Step 1 (never suspends → the
     landing continuation fires at most once).
5. **Generic invokers consult the flag** — map/each/flatmap trampolines and
   any other site applying a closure of unknown kind: direct closure → call
   its direct entry and feed the value into the land/ambient continuation;
   CPS closure → today's path.
6. **Validate + shrink** — binaryen shrink pass must see the new calls;
   `wasm-tools validate` on built examples.

### Verification commands

```bash
bun run ci
bun compiler/cli.ts buildwasm examples/squares_sum.ef && wasm-tools validate examples/squares_sum.wasm
wasm-tools print examples/squares_sum.wasm | grep -c 'array.new'   # fewer frame allocs than Step 1 for pure examples
```

### Exit criteria

- All gates + parity green.
- A pure program (e.g. `squares_sum`) contains no `T_KABI` user functions and
  no frame allocation on its hot path (spot check via `wasm-tools print`).
- No interpreter behavior change (eval untouched this step).

---

## Step 3 — Mixed functions, interp trampoline, benchmarks, docs

### Context brief

- Everything from Steps 1-2. Dual ABI exists for pure-direct functions.
- Mixed function = row `{}` but body contains `handle` (its performs are all
  handled internally — otherwise its row would be nonempty; any suspending
  call site in it is necessarily lexically under a covering handler).
- Wasm dispatch machinery to study before designing the boundary:
  `emitDispatch` (`compiler/wasm_emit.ts:623`), `retCell`/land cells
  (`wasm_emit.ts:510+`), identity-ret fn (`compiler/wasm_term.ts:1661`,
  `emitIdRetFn`),
  `ladderBody`, perform chain-walk and `ef_perform` import
  (`compiler/wasm_module.ts`), header design doc at `compiler/wasm.ts:1-40`
  (prose sections Pipeline/Effects/Representation — no § markers).
- README wording: line ~16 "A CPS interpreter and a WebAssembly (WasmGC)"
  backend description (`README.md`).
- Benchmark skill reference: `~/.pi/agent/skills/dev-benchmark/SKILL.md`
  (methodology only; no repo benchmark harness exists yet).

### Task list

1. **Classification relaxation** — `compiler/cps.ts`: drop the conservative
   `handle ⇒ CPS` rule. A function is direct-boundary iff its row is `{}`.
   Mixed functions: outermost K emits `dret`; `handle` islands inside keep
   their existing shape (`handle` node, materialized letk for its
   continuation, case machinery unchanged). Direct spines inside them use
   `dcall` as usual.
2. **Wasm boundary protocol for mixed functions** — design task first: a
   mixed function's direct entry runs the term over a boundary continuation;
   island case fns (separate `T_KABI` fns over the chain) complete into
   cells whose thunks continue the spine, and the final value must return
   from the direct entry. Options to evaluate against `emitDispatch`/`land`:
   (a) terminal boundary marker that unwinds to a dispatch loop in the entry;
   (b) dual entry per mixed fn. **Fallback (document in the `wasm.ts` header
   design doc if chosen):
   mixed functions keep a `T_KABI` entry and are only invoked generically;
   only pure-direct functions get `T_DABI`.** Measure before deciding.
3. **Interp dcall trampoline** — `compiler/eval.ts`: interpret `dcall`
   without allocating the ad-hoc continuation when the callee is a direct
   closure (loop iteration instead of `apply` recursion). Guarded by the full
   parity suite; skip and record as future work if it complicates the
   `Outcome`/effect-bubbling protocol.
4. **Benchmarks** — `compiler/scripts/bench.ts`: time `run` (interpreter) and
   wasm execution over the existing `benchmarks/` corpus (`fib.ef`,
   `loop.ef`, `sieve.ef`, `ray.ef`, `handlers.ef`, `boy.ef` — no new corpus
   needed; add one pure-helper-heavy program only if coverage is thin). Record
   before/after numbers (Step-2-era wasm as the "before" for wasm; master for
   interpreter) in the PR description. No CI gating — informational.
5. **Docs** — `AGENTS.md` module bullets (`cps.ts`, `cps_ir.ts`, wasm split
   descriptions); `wasm.ts` header design doc (direct ABI, boundary protocol,
   `$CLO` layout); `cps_ir.ts` header (selective freeze discipline — final
   wording);
   `README.md` backend description line; the docs site's dev pages that
   describe CPS (`docs/content/dev/eval.md` "Why CPS",
   `docs/content/dev/wasm/index.md`, `docs/content/spec/index.md`,
   `docs/content/dev/builtins.md`) and playground prose if it claims
   whole-program CPS. `eslint` comment-hygiene must pass:
   present tense, no transition wording.

### Verification commands

```bash
bun run ci
bun compiler/cli.ts run examples/star.ef
bun compiler/cli.ts buildwasm examples/star.ef && wasm-tools validate examples/star.wasm
bun compiler/scripts/bench.ts
```

### Exit criteria

- All gates + parity green, including new mixed-function tests (effect handled
  internally while the function is called from pure and CPS contexts; resume
  inside a mixed function resumed multi-shot).
- Benchmark numbers recorded; wasm pure-path improvement quantified.
- Docs updated; no stale "everything is CPS" claims anywhere
  (`grep -rni "cps" compiler/ README.md AGENTS.md docs/content/
  playground/src` reviewed).

---

## Analysis notes (verified against the code, 2026-11-12 review)

Facts the executor should not re-litigate:

- Operators (`+ - * / % == neg` …) never reach the generic call path with a
  FunT callee — the checker's op fast path returns before `infer(e.fn)`
  (types.ts:1100-1115) — so a missing/non-`FunT` stamp defaulting to
  suspending is safe.
- User lambda rows are always concrete Sets (types.ts:791,
  `e.retEffs ?? innerEffs`); free effvars arise only from builtin schemes —
  the already-excluded `native` builtins. Recursive self-calls resolve
  against the concrete declared row (types.ts:797-799).
- Case bodies forward performed ops to the ambient row and body ops are
  subtracted — so in a row-`{}` function every suspending call site is
  lexically under a covering handler (Step 3's mixed-function claim).
- REPL: `uni.nodeTypes` is reassigned per `checkProgram` (types.ts:1283);
  stamps are recomputed per line — no accumulation interaction.
- `native` builtins are exactly `map`/`each`/`flatmap`
  (builtins.ts:80,129,141).

## Non-goals

- Per-instantiation specialization of row-polymorphic functions (stays CPS).
- Pure-callback fast path for `map`/`each`/`flatmap` (always generic in v1).
- Shrinking the wasm op table using internally-handled ops.
- Stack-allocating direct-function frames (closures may capture them; frames
  stay heap `$FRAME`s).
- Call-site inlining of direct callees.

## Risks

- **Freeze discipline vs `dcall`**: dcall never suspends, so its operands and
  results need no freezing; suspension-site freezing is unchanged. Covered by
  the multi-shot resume test in Step 1 task 8(d).
- **`$CLO` layout change** (Step 2) touches every construction/reader site —
  mechanical but wide; the parity suite catches misses.
- **Mixed-function boundary protocol** (Step 3) is the one genuinely open
  design point; the documented fallback (mixed fns stay `T_KABI` +
  generic-only) bounds the risk without losing the main win (pure-direct
  calls).
- **REPL accumulation**: stamps are recomputed per `checkProgram` call; no acc
  interaction expected — covered by `repl` tests if any behavior drifts.

## Rollback

Each step is an independently revertible PR; Step 2 can be reverted without
touching IR/eval (wasm re-enters the generic path); Step 3's interp
trampoline and boundary protocol are separately skippable tasks within its PR.
