# ef — a tiny language with algebraic effects

## What this is

A single-file TypeScript implementation of a small statically-typed language
with **algebraic effects and effect handlers**, C/Go-flavored syntax, and a
Hindley-Milner-flavoured type system with effect tracking.

- One source file: `index.ts` (~900 lines).
- Tests: `index.test.ts` (uses `bun:test`).
- Run the interpreter: `bun run index.ts` (runs the self-check demos).
- Run tests: `bun test`.
- Typecheck the host TS: `bunx tsc --noEmit` (must stay clean).

## Architecture (top to bottom of `index.ts`)

1. **Values** — runtime values: `null`, `boolean`, `number`, `string`, arrays,
   `{ tag: "fn", params, body, env }` closures.
2. **Types** — `Prim | ArrT | FunT | Var | AnyT`. Union-find (`Uni`) for type
   variables, side-map (`binds`) for substitutions. `any` is absorbing.
3. **AST** — `Expr` discriminated union + `Param`, `HandlerCase`, `Item`,
   `EffectSig`.
4. **Lexer** — whitespace/newline-insensitive token stream. `KEYWORDS`,
   `ONE`/`TWO` char tables.
5. **Parser** — Pratt for infix (precedence table `Parser.PREC`), recursive
   descent for the rest. `&&`/`||` desugar to `if` (free short-circuit).
   Array literals `[a, b]` desugar to `list(a, b)`.
6. **Type checker** — `infer(e, env, effs, effects)` returns a `Type` and
   side-effects a `Set<string>` of performed effects. `unify` does the
   union-find thing. `checkProgram` wires builtins + effect decls.
7. **Evaluator** — CPS (`evalE(e, env, k)`), multi-shot resume via plain JS
   functions. `handle` installs a handler map; `perform` walks up to a matching
   handler and calls its `resume` (the captured continuation `k`).
8. **Builtins** — arithmetic/comparison binops, `head`/`tail`/`concat`/`flat`/
   `len`/`map`/`list`. `map` and the array ops are polymorphic (fresh
   type vars per use via scheme thunks in the type env). Console output is via
   the `Println`/`Out` builtin effects, not functions.
9. **`run` / `show` / `typeOf`** — `run` typechecks then evaluates; `show`
   pretty-prints a value; `typeOf` returns the inferred type of the last
   expression as a string (surfaces effect sets).

## Working rules

- **Single file.** Everything lives in `index.ts`. Do not split it.
- **`tsc --noEmit` must pass clean.** No `any` host types leaking, no unused.
- **Tests are the spec's executable form.** When you change the language,
  update `index.test.ts` to match. Self-checks there must stay green.
- **`bun test` must pass** (currently 14 tests) and `bun run index.ts` must
  print all `OK`.

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
  hatch for effect demos without row polymorphism. `list` uses it
  intentionally; `Println` takes `any` for the same reason.
- **Effect declarations required for `perform`.** `effect Op(args): ret` — the
  checker rejects `perform` of an undeclared effect. `ret` is the type
  `perform Op(...)` evaluates to (i.e. what `resume` injects).
- **Function effect signatures.** `fn f(p: T): R ! { Effs } { ... }` — the
  declared set must cover what the body performs; it becomes the function
  type's effect set, shown as `(T) -> R ! { Effs }`.
- **No-Return handle rule.** When the handled body has effects, the result
  type `R` is NOT unified with the body type (handlers transform results).
  When the body is pure, `R ~ bodyType`.
- **resume `k` type.** `k : (effectRetType) -> R` where `R` is the handle
  result type, not the body type.
- **Monomorphic user bindings, polymorphic builtins.** `let` does not
  generalize. Builtins `map`/`head`/`tail`/`concat`/`flat`/`len` get fresh type
  vars per use via scheme thunks.
- **Homogeneous arrays.** `[1, "a"]` is a type error; `list` is special-cased
  in inference to unify all elements to a common `T`.

## Quick orientation

```
bun test              # run the test suite
bun run index.ts      # run self-check demos
bunx tsc --noEmit     # host typecheck
```
