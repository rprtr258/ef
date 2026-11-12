# ef — a tiny language with algebraic effects

## What this is

A TypeScript implementation of a small statically-typed language
with **algebraic effects and effect handlers**, C/Go-flavored syntax, and a
Hindley-Milner-flavoured type system with effect tracking.

- Modules (all under `compiler/`, a bun workspace package): `lexer.ts`, `parser.ts`, `types.ts` (checker), `env.ts` (runtime
  values), `builtins.ts` (the one builtin table), `analysis.ts` (frontend
  passes: builtin surface, op discovery, builtin-ref tree-shaking — shared
  by the wasm backend, parser-types-only leaf module), `cps.ts` (CPS
  converter: checked AST → the shared CPS IR), `cps_ir.ts` (the CPS IR node
  set + the multi-shot ANF/freeze discipline comments; leaf module),
  `cps_opt.ts` (optimization passes applied as the final stage of CPS
  conversion),
  `eval.ts` (CPS IR interpreter + pipeline), `wasm.ts` (wasm backend entry:
  CPS IR → wasm codegen, binaryen
  shrink pass; split into `wasm_types.ts`/`wasm_tables.ts`/`wasm_body.ts`/
  `wasm_pipeline.ts`/`wasm_devirt.ts` (devirtualization analysis: per-slot
  closure provenance + per-CFn purity fixpoint, leaf over the CPS IR)/
  `wasm_emit.ts`/`wasm_module.ts` — see item 10),
  `wasm_host.ts` (wasm host runtime: instantiation, GC↔JS boxing,
  effect interpretation), `lint.ts`, `prims.ts`, `assert.ts` (the
  `assertNever` exhaustive-switch guard — every switch over `Expr` ends in
  it, so a new node variant fails typecheck in each walker that forgets it),
  frontends `cli.ts`/`repl.ts`.
- Tests (under `compiler/`): `index.test.ts` + `lint.test.ts` + `wasm.test.ts` +
  `analysis.test.ts` + `examples.test.ts` (in-process: per-example interpreter↔wasm
  parity, `Exit!` sentinel + seeded `Random!` override) + `cli.test.ts` (CLI
  integration smoke: argv, exit codes, stdout/stderr) (`bun:test`).
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

1. **`lexer.ts`** — whitespace/newline-insensitive token stream. `KEYWORDS`,
   `ONE`/`TWO` char tables. `Pos` (1-indexed line/col) lives here.
2. **`parser.ts`** — Pratt for infix (precedence table `Parser.PREC`),
   recursive descent for the rest. `&&`/`||` desugar to `if` (free
   short-circuit). The AST is a flat node slice: expressions reference
   children by `ExprID` (an index into `Program.nodes`), not by embedding
   child nodes. Parsing also records `Program.typeToks` — every type/effect
   name occurrence (alias decls/uses, type params, effect decls, `! { … }`
   rows, `Op!` performs, case labels) — the LSP's semantic-tokens source;
   failed alias attempts truncate their recordings on rewind.
3. **`types.ts`** — the checker. `Type` union, the `Unifier` class (one instance per check: all
   union-find/binding state lives there, carried in `Checked`; also records
   `semToks` — value-identifier semantic tokens for the LSP, kind `function`/
   `variable` by resolved type),
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
5. **`builtins.ts`** — the single table of builtins; adding a builtin means
   adding one entry here. Three kinds: `fn` (plain, lifted to a native),
   `native` (CPS — calls ef closures: `map`/`each`/`flatmap`), `effect`
   (checker `sig` + default host interpretation for
   `Read`/`Write`/`Println`/`Out`/`Exit`/`Wait`/`Random`). Operators
   (`+ - * / % == neg` ...) stay in `env.ts`: the checker special-cases them
   structurally, and no honest type signature exists for them.
6. **`analysis.ts`** — frontend analysis passes over a parsed program, a
   parser-types-only leaf module importable by both backends (module init
   order is order-independent — see the eval⇄builtins note under
   `eval.ts`): `BUILTINS`/`EFFECT_OPS` surface
   tables (static, sync enforced by `analysis.test.ts`), `performsAnyOp`,
   `collectEffectOps` (op discovery in wasm op-table order), `builtinRefs`
   (shadowing-correct builtin references; binding order mirrors the
   checker). Consumed by wasm_pipeline.ts's OPT_PASSES and eval.ts's exec (fail-fast
   unhandled-op check + per-call env seeding); the rows also surface via
   `ef types`'s result line.
7. **`cps_ir.ts`** — the higher-order CPS IR, the single intermediate
   representation both backends consume: explicit continuations (`letk`
   binds a continuation λv.body; tail positions name their continuation as
   a var reference), `perform`/`handle` naming the reified handler
   continuations, and the multi-shot ANF discipline pinned once in its
   header comment — operands computed before a possible suspension are
   let-bound before it, so continuation parameters and in-scope `let`
   bindings are exactly the frozen accs a resume must honor, while named
   variables stay live in the shared, mutable frame. `$`-prefixed converter
   names can never collide with source identifiers.
8. **`cps.ts`** — CPS conversion (checked AST → `cps_ir.ts` term): the one
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
9. **`cps_opt.ts`** — optimization passes over the CPS IR (`optimizeCps`,
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
10. **`eval.ts`** — CPS IR interpreter (`evalTerm`; `apply` dispatches
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
   also owns the pipeline shared by the REPL and `run`: `newCtx(interp?)`
   seeds state (empty runtime env), `exec(prog, ctx, checked)` evaluates an
   already-checked program (`checked = checkProgram(prog, ctx.checked)`, so
   checking happens before the interpreter runs, once per line), fails fast
   on statically unhandled non-builtin ops not covered by `ctx.interp`
   (via `checked.unhandled` — the checker's residual top-level effect
   rows, which do ops-minus-handled matching through calls), seeds
   `builtinRefs(prog)` into the runtime env (so a later REPL line can
   reference a previously-unused builtin; the no-shadowing checker rule
   keeps collisions impossible), then evaluates and returns `{value,
   lastType, lastIsExpr}`; `run(src, interp?)` is a one-shot `exec`.
11. **`wasm.ts`** — WebAssembly backend: CPS IR → wasm codegen (defunctionalizing
   the same term eval.ts interprets), OPT_PASSES seam (tree-shaking, dead host-import
   elimination), in-process binaryen shrink pass. Split into strictly-layered
   sub-modules (no import cycles; design doc at the top of
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
12. **`lint.ts`** — lint passes over a parsed program (`LINT_PASSES`);
   currently one rule (`unused-arg`).
13. **Frontends** — `cli.ts` (`ef run|buildwasm|runwasm|types|lint <file>`,
    `ef repl`, `ef lsp`) and `repl.ts`
   (line loop over `newCtx`/`exec`; bindings accumulate across lines).
## Working rules

- **`bun run ci` must pass** — host typecheck (`bun check`), eslint (which
  includes the comment-hygiene custom rule `eslint/rules/comment-hygiene.ts`:
  comments and prose must describe the present — no dead provenance,
  removed-backend references, off-repo decision-log labels, or
  resolved-transition wording; git history is the archive), the
  runtime-deps check (`compiler/scripts/check-runtime-deps.ts`: every bare package import
  reachable from the runtime entries must be a `dependency`, not a
  `devDependency`), and the test suite all clean.
- **Tests are the spec's executable form.** When you change the language,
  update `index.test.ts` to match. Self-checks there must stay green.
- **The single builtins table.** A new builtin is one entry in
  `builtins.ts`; never seed it ad hoc into `checkProgram` or `globalEnv`.

## When the language changes

**⚠ Update `README.md` to match.** The README describes the language in general
terms followed by a full spec (syntax, types, semantics, builtins). Any change
to syntax, types, effects, handlers, or builtins must be reflected in the
README. Keep the "full spec" section the source of truth for grammar and
typing rules.

## Key design decisions (don't accidentally undo)

- **Six numeric widths, strict arithmetic.** `i32 i64 u32 u64 f32 f64`
  replace int/float. Operands of a numeric op must share a width (`i32 +
  i64` is a type error); `@as(expr, T)` is the one conversion (float→int
  truncates, bool→numeric gives 0/1). Untyped literals (`1`, `1.5`) are
  internal wildcard types that flex to any numeric (resp. float) context
  and default to i64/f64 — never let them widen to concrete types at parse
  time. f32 values round to f32 precision at every producing node (checker
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
  with a builtin/operator name (analysis.ts's `BUILTINS` surface). The REPL
  acc reuses the top frame, so rebinding across lines errors too. `_` is
  the exempt discard wildcard; effect names are a separate namespace.
- **Function effect signatures.** `f :: fn(p: T): R ! { Effs } { ... }` —
  **mandatory for effectful bodies**: if the body performs any effect, a
  `! { ... }` annotation listing a superset must be present (pure bodies may
  omit it). The declared set must cover what the body performs; it becomes the
  function type's effect set, shown as `(T) -> R ! { Effs }`. Functions are
  defined via a `::` const + an anonymous lambda; the lambda carries the same
  `: R` and `! { Effs }` annotations.
- **No-Return handle rule.** When the handled body has effects, the result
  type `R` is NOT unified with the body type (handlers transform results).
  When the body is pure, `R ~ bodyType`.
- **resume `k` type.** `k : (effectRetType) -> R` where `R` is the handle
  result type, not the body type.
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
