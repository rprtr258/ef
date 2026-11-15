# ef — a tiny language with algebraic effects

## What this is

A TypeScript implementation of a small statically-typed language
with **algebraic effects and effect handlers**, C/Go-flavored syntax, and a
Hindley-Milner-flavoured type system with effect tracking.

- Modules (under `compiler/`, a bun workspace package; the frontend lives
  under `compiler/frontend/` and the two backends under
  `compiler/backend/` — `backend/interpreter/` and `backend/wasm/`):
  `frontend/lexer.ts`, `frontend/parser.ts`, `frontend/walk.ts`
  (the shared AST traversal — `exprChildren` child order + `forEachBinder` binder sites —
  consumed by analysis, the checker's scanners, lint, and the LSP), `frontend/types.ts` (checker), `env.ts` (runtime
  values), `builtin_table.ts` (the declarative builtin table — pure rows
  (name, kind, checker sig); leaf module), `builtins.ts` (runtime impls for
  those rows; a new builtin is one row in builtin_table.ts plus one impl
  row here — and for fn/native/value kinds reachable from wasm code, a
  case in backend/wasm/wasm_module.ts's `emitBuiltins` switch, whose default throws
  `internal: builtin <name> not implemented`), `frontend/analysis.ts` (frontend passes: op discovery, builtin-ref
  tree-shaking; re-exports the builtin surface declared in builtin_table.ts
  — shared by the wasm backend, parser-types-only leaf module), `frontend/pipeline.ts`
  (the preparation seam: prepare + the staged prepareStaged, Ctx/newCtx, the
  REPL's one-line runLine (prepare against the accumulator + exec, owned by
  eval.ts), shared
  unhandled-op gate; consumed by both backends and the frontends), `frontend/cps.ts` (CPS
  converter: checked AST → the shared CPS IR)), `frontend/cps_ir.ts` (the CPS IR node
  set + the multi-shot ANF/freeze discipline comments; leaf module),
  `frontend/cps_opt.ts` (optimization passes applied as the final stage of CPS
  conversion),
  `backend/interpreter/eval.ts` (CPS IR interpreter + pipeline),
  `backend/wasm/wasm.ts` (wasm backend entry: CPS IR → wasm codegen, binaryen
  shrink pass; sub-modules all in `backend/wasm/`:
  `wasm_types.ts`/`wasm_tables.ts`/`wasm_body.ts`/
  `wasm_pipeline.ts`/`wasm_devirt.ts` (devirtualization analysis: per-slot
  closure provenance + per-CFn purity fixpoint + numeric-entry eligibility,
  leaf over the CPS IR)/`wasm_plan.ts` (the frame/slot planner: one
  traversal assigning every binding a slot, publishing the immutable Plan
  and owning the `__p` annotations consumed via accessors)/
  `wasm_emit.ts`/`wasm_module.ts` — see item 11),
  `backend/wasm/wasm_host.ts` (wasm host runtime: instantiation, GC↔JS boxing,
  effect interpretation), `stamps.ts` (the one backend-stamp concern: width/
suspension/arrKind emission over an exhaustive `Expr` switch — widths come
  from the checker's resolved types, not decided here; width/suspension/
  lambda-type stamps land in `Checked.stamps` (keyed by ExprID), which
  `toCps(prog, checked.stamps)` consumes — the AST stays pure parse output),
`frontend/lint.ts`, `prims.ts`, `assert.ts` (the
  `assertNever` exhaustive-switch guard — every switch over `Expr` ends in
  it, so a new node variant fails typecheck in each walker that forgets it),
  frontends `cli.ts`/`repl.ts`.
- Tests (under `compiler/`, backends' suites co-located with them under
  `compiler/backend/`): `frontend/lint.test.ts` + `frontend/analysis.test.ts` + `ops.test.ts` +
  `frontend/cps_opt.test.ts` (shared stages) + `backend/interpreter/index.test.ts` (the
  language suite run through the interpreter) + `backend/wasm/wasm.test.ts` +
  `backend/parity.test.ts` (table-driven interpreter↔wasm parity over
  `examples/*.ef` and the fine-grained fixtures in `compiler/backend/testdata/*.ef` —
  two tables, one runner asserting backend agreement on stdout effects, exit
  codes and errors, plus exact expected output per row; `Exit!` sentinel +
  seeded `Random!` override; wasm.test.ts keeps only wasm-internal assertions —
  module structure, host imports, plan/slot annotations, ABI, host
  injections) + `cli.test.ts` (CLI integration smoke: argv, exit codes, stdout/stderr),
  with the shared runner (`runOnce`) defined in parity.test.ts (`bun:test`).
- Run a file: `bun compiler/cli.ts run <file>` (subcommands: `run`, `buildwasm`,
  `runwasm`, `types`, `lint`, `repl`, `lsp`).
- Gates: `bun run ci` = typecheck + eslint + runtime-deps check + tests; all must stay clean.
- `playground/` workspace: browser studio (multi-file ef IDE). Bundles the
  compiler frontend for the browser; `cd playground && bun
  run dev` serves it. `typecheck` covers all package tsconfigs; its tests run under
  the root suite.
- `docs/` workspace: this documentation site (markdown in `docs/content/` →
  static HTML via `docs/build.ts`; theme tokens are lifted from
  `playground/studio.css` at build time). `cd docs && bun run dev` serves it
  with live reload; `docs/build.test.ts` (link integrity) runs under the root
  suite. Published to the `gh-pages` branch by the monorepo's
  `.github/workflows/docs.yml` on pushes to master.
- `benchmarks/` workspace: the performance-benchmark harness
  (`compare/compare.ts`, `compare/precompile.ts`, `compare/report.ts` — see
  `compare/BASELINE.md`); a package.json exists mainly so knip tracks the
  scripts as workspace entry points.
- `vscode/` workspace: VS Code extension for ef — TextMate grammar for `.ef`,
  and a language client that spawns the LSP server from `compiler/lsp.ts`
  (diagnostics, hover types, go-to-definition, semantic tokens for type/effect
  highlighting;
  bundled by `vscode/scripts/build.ts` into `vscode/dist/`; esbuild with a
  stub for builtins.ts's `sleepSync` since the server never evaluates). The
  server speaks full-text sync diagnostics (fail-fast, one per change) and
  hover types for every checked subexpression; also runnable standalone as
  `ef lsp`. `vscode/test/lsp.test.ts` spawns the built bundle and speaks raw
  LSP over stdio.

## Architecture (top to bottom, dependency order)

1. **`frontend/lexer.ts`** — whitespace/newline-insensitive token stream. `KEYWORDS`,
   `ONE`/`TWO` char tables. `Pos` (1-indexed line/col) lives here.
2. **`frontend/parser.ts`** — Pratt for infix (precedence table `Parser.PREC`),
   recursive descent for the rest. `&&`/`||` desugar to `if` (free
   short-circuit). The AST is a flat node slice: expressions reference
   children by `ExprID` (an index into `Program.nodes`), not by embedding
   child nodes. Parsing also records `Program.typeToks` — every type/effect
   name occurrence (alias decls/uses, type params, effect decls, `! { … }`
   rows, `Op!` performs, case labels) — the LSP's semantic-tokens source;
   failed alias attempts truncate their recordings on rewind.
3. **`frontend/types.ts`** — the checker. `Type` union, the `Unifier` class (one instance per check: all
   union-find/binding state lives there, carried in `Checked`), and a per-call `TokenRecorder`
   threaded through checking that records `semToks` — value-identifier semantic tokens for the LSP,
   kind `function`/`variable` by resolved type — plus per-node types and effect sigs, all carried
   out on `Checked`.
   `unify`, `infer`, `infer`, and a checker `Env` whose values may be `Scheme` thunks
   (polymorphism). `checkProgram(prog, acc?): Checked` — `acc` is the
   previous result passed back to accumulate bindings (the REPL protocol);
   `lastType` is returned fully resolved, as is `Env.lookupResolved`;
   `Checked.unhandled` carries the items' residual top-level effect rows
   (performed ops with no matching handler in their subtree) for exec's
   fail-fast check.
4. **`env.ts`** — runtime `Value`s, `Outcome`/`Cont` (CPS plumbing), runtime
   `Env`, `globalEnv(refs?)` / `seedBuiltins(env, refs)` (operator natives
   + builtin bindings, optionally scoped to referenced builtins), `show`.
5. **`builtins.ts`** — runtime impls for the declarative rows in
   `builtin_table.ts` (kind-keyed impl records; `builtins()` derives fresh
   per-program entries and throws at module init on a table row with no
   impl row). Three kinds: `fn` (plain, lifted to a native), `native`
   (CPS — calls ef closures: `map`/`each`/`flatmap`), `effect` (checker
   `sig` + default host interpretation for
   `Read`/`Write`/`Println`/`Out`/`Exit`/`Wait`/`Random`). Operators
   (`+ - * / % == neg` ...) stay in `env.ts`: the checker special-cases
   them structurally, and no honest type signature exists for them.
6. **`frontend/analysis.ts`** — frontend analysis passes over a parsed program, a
   parser-types-only leaf module importable by both backends (module init
   order is order-independent — see the eval⇄builtins note under
   `eval.ts`): `BUILTINS`/`EFFECT_OPS` surface
   tables (static, sync enforced by `analysis.test.ts`), `performsAnyOp`,
   `collectEffectOps` (op discovery in wasm op-table order), `builtinRefs`
   (shadowing-correct builtin references; binding order mirrors the
   checker). Consumed by backend/wasm/wasm_pipeline.ts's OPT_PASSES and eval.ts's exec
   (per-call env seeding); the rows also surface via `ef types`'s result
   line.
7. **`frontend/cps_ir.ts`** — the higher-order CPS IR, the single intermediate
   representation both backends consume: explicit continuations (`letk`
   binds a continuation λv.body; tail positions name their continuation as
   a var reference), `perform`/`handle` naming the reified handler
   continuations, and the multi-shot ANF discipline pinned once in its
   header comment — operands computed before a possible suspension are
   let-bound before it, so continuation parameters and in-scope `let`
   bindings are exactly the frozen accs a resume must honor, while named
   variables stay live in the shared, mutable frame. `$`-prefixed converter
   names can never collide with source identifiers.
8. **`frontend/cps.ts`** — CPS conversion (checked AST → `frontend/cps_ir.ts` term): the one
   conversion both backends consume, so effect/resume/multi-shot semantics
   live in one place, not per backend. ANF-style: every compound value
   binds a fresh `$`-temp before flowing on; the converter's continuation
   K is either a meta function (builds the rest term from the value's
   atom — the administrative reductions) or a tail position naming an
   existing continuation (no wrapper). Selective: a lambda whose resolved
   effect row is empty and whose body has no suspending call in its tail
   chain converts direct-style (dret boundary, dcall sites); row {} with
   an internal handle — a mixed function — keeps the direct boundary, its
   islands running over the ambient chain like any CPS region. Wrapper
   letks are emitted for call/perform sites whose node carries a numKind
   stamp: the resumed/returned value must normalize to that width at the
   site.
9. **`frontend/cps_opt.ts`** — optimization passes over the CPS IR (`optimizeCps`,
   applied by `toCps` as its final stage — consumers of `toCps` only ever
   see optimized IR). Four
   sound-by-construction rewrites, iterated to a fixpoint (every firing
   strictly shrinks the term): read-temp substitution (drops `bind $t = x`
   read temps unless the temp is frozen or the source var is assigned;
   frozen temps of never-assigned vars are rewritten to snapshot the var),
   prim-let fusion (`let $t = prim; bind x = $t` → `let x = prim`),
   exit-continuation beta (a letk referenced exactly once via a `jump` node
   — the while loop's exit — is spliced into that jump; call/perform k
   operands are runtime reifications and never fire), and dead binding drop
   (zero-use temps; dead trapping prims — field, div/rem — keep their
   binding so the throw survives). Source-named binds are never dropped:
   top-level bindings must land in the caller's frame for the REPL
   accumulator. Soundness conditions are checked against the whole IR
   (assigned names, capts); regions (spine, closure bodies) are optimized
   independently.
10. **`backend/interpreter/eval.ts`** — CPS IR interpreter (`evalTerm`; `apply` dispatches
   calls): continuations are plain JS closures, re-invoked on resume.
   A dcall whose callee is a direct closure applies it inline at the site
   (frame over the closure's env, the site's continuation serving as both
   the ambient k and `$ret`) instead of going through `apply`.
   `runTop(out, interp?)`
   interprets unhandled effects; `interp` optionally overrides builtin
   interpretations (tests inject fake fs/time/randomness there). The
   eval⇄builtins import cycle is runtime-only on eval's side (`apply` is
   called from builtin closures; unhandled effects read builtins.ts's
   top-level `builtinInterps`, which is entry-order safe because it is
   derived in the same module as the `builtins` array), so every module
   initializes cleanly regardless of entry point. This module
   also owns the REPL's one-line protocol the frontends share (`runLine`: prepare
   against ctx's accumulator, then exec) alongside `run`: `newCtx(interp?)`
   seeds state (empty runtime env), `exec(prog, ctx, checked)` evaluates an
   already-checked program (`checked = checkProgram(prog, ctx.checked)`, so
   checking happens before the interpreter runs, once per line), applies
   the shared pipeline gate (frontend/pipeline.ts's rejectUnhandled) that fails
   fast on statically unhandled non-builtin ops not covered by
   `ctx.interp` (via `checked.unhandled` — the checker's residual
   top-level effect rows, which do ops-minus-handled matching through
   calls), seeds
   `builtinRefs(prog)` into the runtime env (so a later REPL line can
   reference a previously-unused builtin; the no-shadowing checker rule
   keeps collisions impossible), then evaluates and returns `{value,
   lastType, lastIsExpr}`; `run(src, interp?)` is a one-shot `exec`.
11. **`backend/wasm/wasm.ts`** — WebAssembly backend: CPS IR → wasm codegen (defunctionalizing
   the same term eval.ts interprets), OPT_PASSES seam (tree-shaking, dead host-import
   elimination), in-process binaryen shrink pass. Split into strictly-layered
   sub-modules in the same directory (no import cycles; design doc at the top of
   `wasm.ts`): **`wasm_types.ts`** (GC shape types, Ctx, ValueRef/StaticDesc
   leaf), **`wasm_tables.ts`** (signatures — dual call ABI T_KABI/T_DABI —
   host-import layout, binaryen module binding),
   **`wasm_body.ts`** (Buf + Fn body-emission primitives),
   **`wasm_pipeline.ts`** (discover/optimize/assignIndices/layoutStatics/
   buildModule + OPT_PASSES), **`wasm_term.ts`** (the IR-term emitters:
   per-node walks, the resume splice, case fns, direct/dual entries),
   **`wasm_emit.ts`** (expr() + statement/effect
   emitters, split protocol), **`wasm_module.ts`** (builtin trampolines, main,
   run/accessor init fns); `wasm.ts` itself is the entry: compile/
   compileWithOps + the emit() orchestration. Its host runtime lives in
   **`wasm_host.ts`** (direct-style: instantiation, GC↔JS boxing through the
   §4 accessor ABI, `runWasm`; effect interpretation comes from builtins.ts's
   `builtinEffectHosts`).
12. **`frontend/lint.ts`** — lint passes over a parsed program (`LINT_PASSES`);
   rules: `unused-arg`, and `derived-any` (typecheck-backed — `lint` runs
   `checkProgram` best-effort, type-aware passes skip unchecked programs).
13. **Frontends** — `cli.ts` (`ef run|buildwasm|runwasm|types|lint <file>`,
    `ef repl`, `ef lsp`) and `repl.ts`
   (line loop over eval.ts's `runLine`; bindings accumulate across lines).
## Working rules

- **Keep the layout docs in step.** When moving, renaming, or adding compiler
  modules, update this file's module list and Architecture section and any
  affected `docs/content/dev/` pages **in the same change**.
- **`bun run ci` must pass** — host typecheck (`bun check`), eslint (which
  includes the comment-hygiene custom rule `eslint/rules/comment-hygiene.ts`:
  comments and prose must describe the present — no dead provenance,
  removed-backend references, off-repo decision-log labels, or
  resolved-transition wording; git history is the archive), the
  runtime-deps check (`compiler/scripts/check-runtime-deps.ts`: every bare package import
  reachable from the runtime entries must be a `dependency`, not a
  `devDependency`), and the test suite all clean.
- **Tests are the spec's executable form.** When you change the language,
  update `backend/interpreter/index.test.ts` to match. Self-checks there must stay green.
- **The single builtins table.** A new builtin is one row in
  `builtin_table.ts` (declarative: name, kind, checker sig) plus one impl
  row in `builtins.ts`; never seed it ad hoc into `checkProgram` or
  `globalEnv`.

## When the language changes

**⚠ Update the docs to match.** The language spec lives at
`docs/content/spec/index.md` (README links to it as **the source of
truth**): syntax, types, semantics, and the §4 builtins tables — a new or
changed builtin needs its row there. Any user-visible change also updates
the README's opening, and compiler-internal changes update
`docs/content/dev/`.

## Key design decisions (don't accidentally undo)

- **Six numeric widths, strict arithmetic.** `i32 i64 u32 u64 f32 f64`
  replace int/float. Operands of a numeric op must share a width (`i32 +
  i64` is a type error); `@as(expr, T)` is the one conversion (float→int
  truncates, bool→numeric gives 0/1). Untyped literals (`1`, `1.5`) check
  as internal untyped const (num) types — `int`/`float` — that flex to any
  numeric (resp. float) context — each read/operation resolves its own copy in the unifier, and
  `checkProgram` finishes with `resolveNums`: propagation over op-linked
  num types. Num types stay valid through checking — the REPL acc keeps
  them (a read copies a fresh num type, so `x := 42; x` echoes `42 : int`
  and later uses can flex to other widths), while backends lower them to
  the defaults (i64/f64) via `widthOf` at every stamp site, so the
  evaluator never coerces operands (after typecheck they are already in
  the op's width). Never let them widen to concrete types
  at parse time. f32 values round to f32 precision at every producing node (checker
  stamps `f32`; interp frounds, wasm emits a demote/promote round-trip);
  i64/u64 are exact to 2^53, no wraparound.
- **Every `Expr` switch is exhaustive.** Walkers end in `default:` +
  `assertNever` (assert.ts); adding a node type must update all of them —
  `bun check` fails otherwise.
- **CPS evaluator, not generators.** Generators are single-use; CPS gives
  genuine multi-shot resume via callable JS closures.
- **`any` is absorbing.** Unifies with everything and stays `any`. Escape
  hatch for type demos. `list` uses it
  intentionally; `Println` takes `any` for the same reason.
- **Effect declarations required for `Op!`.** `effect Op(args): ret` — the
  checker rejects `Op!` of an undeclared effect. `ret` is the type
  `Op!(...)` evaluates to (i.e. what `resume` injects).
- **No shadowing.** Every binding site (`let`, destructure field, lambda
  parameter, handler binder/resume) goes through the checker's `checkBind`:
  no same-frame redeclaration, no hiding an enclosing binding, no colliding
  with a builtin/operator name (frontend/analysis.ts's `BUILTINS` surface). The REPL
  acc reuses the top frame, so rebinding across lines errors too. `_` is
  the exempt discard wildcard; effect names are a separate namespace.
- **Function effect signatures.** `f :: fn(p: T): R ! { Effs } { ... }` —
  **mandatory for effectful bodies**: if the body performs any effect, a
  `! { ... }` annotation listing a superset must be present (pure bodies may
  omit it). The declared set must cover what the body performs; it is the
  function type's exact effect set, shown as `(T) -> R ! { Effs }`: an
  unannotated parameter's effect variable is pinned to the declared set (a
  callee outside it fails at the call site), and an empty declaration rejects
  a body whose unannotated parameter performs. Functions are
  defined via a `::` const + an anonymous lambda; the lambda carries the same
  `: R` and `! { Effs }` annotations.
- **No-Return handle rule.** When the handled body has effects, the result
  type `R` is NOT unified with the body type (handlers transform results).
  When the body is pure, `R ~ bodyType`.
- **resume `k` type.** `k : (effectRetType) -> R` where `R` is the handle
  result type, not the body type. For a Return-less handle whose body
  performs no op outside lambda bodies, an op case whose body references
  `k` also unifies the resume's return with the body's type — every
  resumption then runs the body to completion, so the delivery is the
  body's completion value (nested case-body completions agree through the
  same var). Residual holes: perform-spined bodies keep the unchecked
  boundary; observing handlers over forced bodies are rejected by design
  (escape: return the delivery from the case body and observe outside); the
  `+` delayed constraint lets `k(1) + k(2)` shapes through unchecked.
- **Value restriction.** `::`/`:=` with a lambda RHS is generalized
  (user-defined polymorphic functions); a non-lambda RHS is not. Builtins
  get fresh type vars per use via scheme thunks.
- **Bracket literals.** Homogeneous → array; heterogeneous → tuple (named
  fields, `.x`/`.0` access, destructuring). `list` is the variadic array
  constructor.
- **Fresh builtins per program.** `builtins()` returns a fresh array per
  call; polymorphic thunks/closures are never shared between programs.
- **Injectable effect interpretation.** `runTop`/`run`/`newCtx` accept an
  `EffectInterp` override checked before the builtin defaults; the defaults
  (fs, console, busy-wait, `Math.random`) live in `builtins.ts`.

## Quick orientation

```
bun run ci                # typecheck + lint + deps check + tests
bun test                  # test suite only
bun compiler/cli.ts run examples/star.ef
bun compiler/cli.ts repl       # interactive REPL
bun compiler/cli.ts buildwasm examples/squares_sum.ef  # emit examples/squares_sum.wasm
wasm-tools print|validate <file.wasm>  # inspect wasm output (WasmGC) — wabt's wasm2wat can't parse it at any version
```
