# ef — a tiny language with algebraic effects

## What this is

A TypeScript implementation of a small statically-typed language
with **algebraic effects and effect handlers**, C/Go-flavored syntax, and a
Hindley-Milner-flavoured type system with effect tracking.

- Modules: `lexer.ts`, `parser.ts`, `types.ts` (checker), `env.ts` (runtime
  values), `builtins.ts` (the one builtin table), `analysis.ts` (frontend
  passes: builtin surface, op discovery, builtin-ref tree-shaking — shared
  by the wasm backend, parser-types-only leaf module), `eval.ts` (evaluator
  + pipeline), `wasm.ts` (wasm backend: CPS→wasm codegen, binaryen shrink
  pass, host runtime), `lint.ts`, `prims.ts`, frontends `cli.ts`/`repl.ts`.
- Tests: `index.test.ts` + `lint.test.ts` + `wasm.test.ts` +
  `analysis.test.ts` (`bun:test`).
- Run a file: `bun run cli.ts run <file>` (subcommands: `run`, `types`,
  `lint`, `repl`).
- Gates: `bun run ci` = typecheck + eslint + tests; all three must stay clean.

## Architecture (top to bottom, dependency order)

1. **`lexer.ts`** — whitespace/newline-insensitive token stream. `KEYWORDS`,
   `ONE`/`TWO` char tables. `Pos` (1-indexed line/col) lives here.
2. **`parser.ts`** — Pratt for infix (precedence table `Parser.PREC`),
   recursive descent for the rest. `&&`/`||` desugar to `if` (free
   short-circuit). The AST is a flat node slice: expressions reference
   children by `ExprID` (an index into `Program.nodes`), not by embedding
   child nodes.
3. **`types.ts`** — the checker. `Type` union, the `Unifier` class (one instance per check: all
   union-find/binding state lives there, carried in `Checked`),
   `unify`, `infer`, `infer`, and a checker `Env` whose values may be `Scheme` thunks
   (polymorphism). `checkProgram(prog, acc?): Checked` — `acc` is the
   previous result passed back to accumulate bindings (the REPL protocol);
   `lastType` is returned fully resolved, as is `Env.lookupResolved`.
4. **`env.ts`** — runtime `Value`s, `Outcome`/`Cont` (CPS plumbing), runtime
   `Env`, `globalEnv()` (the operator natives), `show`.
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
   checker). Consumed by wasm.ts's OPT_PASSES; future interpreter wiring
   ideas live in its header comment.
7. **`eval.ts`** — CPS evaluator (`evalE`/`apply`), multi-shot resume via
   plain JS functions; `Op!(...)` walks up to a matching handler and calls
   its `resume` (the captured continuation `k`). `runTop(out, interp?)`
   interprets unhandled effects; `interp` optionally overrides builtin
   interpretations (tests inject fake fs/time/randomness there). The
   eval⇄builtins import cycle is runtime-only on eval's side (`apply` is
   called from builtin closures; unhandled effects read builtins.ts's
   top-level `builtinInterps`, which is entry-order safe because it is
   derived in the same module as the `builtins` array), so every module
   initializes cleanly regardless of entry point. This module
   also owns the pipeline shared by the REPL and `run`: `newCtx(interp?)`
   seeds state, `exec(prog, ctx)` checks then evaluates and returns
   `{value, lastType, lastIsExpr}`; `run(src, interp?)` is a one-shot `exec`.
8. **`wasm.ts`** — WebAssembly backend: CPS→wasm codegen over the same
   parser/types output, OPT_PASSES seam (tree-shaking, dead host-import
   elimination), in-process binaryen shrink pass, direct-style host runtime
   (effect interpretation comes from builtins.ts's `builtinEffectHosts`).
9. **`lint.ts`** — lint passes over a parsed program (`LINT_PASSES`);
   currently one rule (`unused-arg`).
10. **Frontends** — `cli.ts` (`ef run|types|lint|repl <file>`) and `repl.ts`
   (line loop over `newCtx`/`exec`; bindings accumulate across lines).
## Working rules

- **`bun run ci` must pass** — host typecheck (`tsc --noEmit`), eslint, and
  the test suite all clean.
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

- **CPS evaluator, not generators.** Generators are single-use; CPS gives
  genuine multi-shot resume via callable JS closures.
- **`any` is absorbing.** Unifies with everything and stays `any`. Escape
  hatch for type demos. `list` uses it
  intentionally; `Println` takes `any` for the same reason.
- **Effect declarations required for `Op!`.** `effect Op(args): ret` — the
  checker rejects `Op!` of an undeclared effect. `ret` is the type
  `Op!(...)` evaluates to (i.e. what `resume` injects).
- **Function effect signatures.** `let f = fn(p: T): R ! { Effs } { ... }` —
  **mandatory for effectful bodies**: if the body performs any effect, a
  `! { ... }` annotation listing a superset must be present (pure bodies may
  omit it). The declared set must cover what the body performs; it becomes the
  function type's effect set, shown as `(T) -> R ! { Effs }`. Functions are
  defined via `let` + an anonymous lambda; the lambda carries the same
  `: R` and `! { Effs }` annotations.
- **No-Return handle rule.** When the handled body has effects, the result
  type `R` is NOT unified with the body type (handlers transform results).
  When the body is pure, `R ~ bodyType`.
- **resume `k` type.** `k : (effectRetType) -> R` where `R` is the handle
  result type, not the body type.
- **Value restriction.** `let` with a lambda RHS is generalized
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
bun run ci                # typecheck + lint + tests
bun test                  # test suite only
bun run cli.ts run examples/star.ef
bun run cli.ts repl       # interactive REPL
```
