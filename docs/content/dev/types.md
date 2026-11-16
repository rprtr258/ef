# Type checker

`checkProgram(prog, acc?): Checked` — Hindley-Milner-flavoured inference with
**effect tracking**: every function type carries an effect row, and effects
performed without a matching handler surface in the program's residual row.

## Inputs and outputs

| | |
|--|--|
| in | `Program` (items + flat node slice from the [Parser](parser.md)) |
| in | `acc` — the previous `Checked`, passed back to accumulate bindings (**the REPL protocol**) |
| out | `Checked` — bindings, resolved types, effect rows, per-node stamps |

### `Checked`, field by field

| Field | Holds | Consumed by |
|-------|-------|-------------|
| `env` | checker `Env`; values are `Scheme` thunks (polymorphism); `lookupResolved` gives fully-resolved types | REPL continuation, `ef types` |
| `lastType` | the last expression's type, fully resolved | value printing, `ef types` |
| `unhandled` | residual top-level effect rows: performed ops with no matching handler in their subtree | `exec`'s fail-fast check ([Interpreter](eval.md)), the `_ : T ! { ops }` line of `ef types` |
| node stamps | `nodeTypes` (type per `ExprID`), `stamps` (`NodeStamps` per `ExprID`: `numKind` width, `div` int/float division, `sus` suspension, lambda `typ`, `arrKind` literal shape, `fieldIdx` resolved field index, `asKind` conversion kind), `semToks` (value-identifier semantic tokens: `function` for fn-typed identifiers, `variable` otherwise — recorded at sym uses and binder sites for the [VS Code extension](../spec/vscode.md)) | the CPS converter (frontend/cps.ts), the evaluator's width normalization, the wasm emitter's per-node codegen |

## The type universe

| Variant | Written as | Notes |
|---------|-----------|-------|
| `Prim` | `i32 i64 u32 u64 f32 f64 string bool unit` | six numeric widths — arithmetic is strict per width |
| untyped num types | *(internal)* `int` / `float` | produced **only** by literals; flex to any numeric (resp. float) context, default `i64` / `f64`; never writable in source |
| `ArrT` | `[T]` | homogeneous array |
| `TupT` | `[x: f64, y: f64]` / `[i64, string]` | fixed arity; field names are for access only — unification compares arity + positional types, not names |
| `FunT` | `(T) -> R ! { E }` | params, return, and an **effect row** |
| `Var` | *(internal)* | type variable |
| `EffVar` | *(internal)* | unbound effect row — row polymorphism |
| `AnyT` | `any` | absorbing: unifies with everything, stays `any` |

## The `Unifier`

One instance per checking session; **all** mutable unification state lives in
it, carried inside `Checked` across REPL lines. `Type` values themselves are
plain data — and so is the unifier: free functions over it (`uniRes`,
`uniUnify`, …) thread the state explicitly, so independent `checkProgram`
calls (in tests!) never share state.

<svg class="dgm" viewBox="0 0 720 190" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="unifier state">
  <defs>
    <marker id="arrt" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>
  <rect class="box" x="16"  y="30" width="216" height="130" rx="10"/>
  <text x="124" y="52" text-anchor="middle">type variables</text>
  <text x="32"  y="76">v1 ≡ v2 ≡ v3   (union-find)</text>
  <text x="32"  y="96" class="faint">binds[v3] = i64</text>
  <text x="32"  y="116" class="faint">occurs-check rejects recursive types</text>
  <text x="32"  y="140" class="faint">num types: untyped literals flex to</text>
  <text x="32"  y="154" class="faint">the context they unify with</text>
  <rect class="box" x="252" y="30" width="216" height="130" rx="10"/>
  <text x="360" y="52" text-anchor="middle">effect rows</text>
  <text x="268" y="76">e1 ≡ e2      (eff union-find)</text>
  <text x="268" y="96" class="faint">effBinds[e2] = { Out }</text>
  <text x="268" y="116" class="faint">var + set → bind</text>
  <text x="268" y="130" class="faint">set + set → equality</text>
  <text x="268" y="150" class="faint">∅ is the polymorphic bottom</text>
  <rect class="box" x="488" y="30" width="216" height="130" rx="10"/>
  <text x="596" y="52" text-anchor="middle">per-call bookkeeping</text>
  <text x="504" y="76">nodeTypes[7] = i32</text>
  <text x="504" y="96" class="faint">reset per checkProgram call:</text>
  <text x="504" y="110" class="faint">REPL lines share the unifier</text>
  <text x="504" y="124" class="faint">but not the node slice — types</text>
  <text x="504" y="138" class="faint">must not leak across lines</text>
</svg>

Effect rows deserve a second look: a row is a concrete set of performed ops
— op names plus possibly unbound `EffVar` members — or a bare unbound
`EffVar`. This makes higher-order builtins effect-polymorphic —
`map : ((a) -> b ! e, [a]) -> [b] ! e` with a fresh `e`
per instantiation: `map(pureFn, xs)` performs nothing,
`map(fn(x) { Out!(x); x }, xs)` performs exactly `{ Out }`. The variables
also propagate through user code: calling an unannotated parameter forces
it into a function type with a fresh row variable, and that variable joins
the enclosing function's row — so a polymorphic caller (`apply`, a
handler-delivered closure) stays effect-tracked, and a closure whose row
names an op cannot slip past the residual-row gate by escaping its handler.
A row variable that never unifies with anything concrete (a polymorphic
value passed around but never applied to an effectful callee) contributes
nothing — no constraint ever tied it to a perform. Recursion makes a row
variable self-referential (ρ = {ρ}): semantic consumers collapse that
circle to its non-cyclic contents (∅ for pure recursion), while display
keeps the variable — a never-constrained parameter's row shows as a
generic row on the argument type.

## Checking a program

1. Register `effect` items (unannotated params become fresh variables) and
   type aliases.
2. Infer each expression item; residual per-item effect rows land in
   `Checked.unhandled` (ops-minus-handled matching is done here — the checker
   can see through calls, which is exactly what a syntactic AST walk cannot).
3. **Num-type resolution + width-stamp post-pass** after *all* items:
   `resolveNums` propagates op-linked num-type widths to a fixpoint. Untyped
   num types stay valid through checking — the REPL acc keeps them (per-read
   copies flex per use), while backends lower them to the defaults
   (`int` → `i64`, `float` → `f64`) via `widthOf` at every stamp site.
   Divergent reads (one untyped binding read
   at several widths) are marked `adaptFrom` so the backends adapt the
   stored box's representation; stamps are then written from the resolved
   types (`nodeTypes`, `stamps.numKind`, …).

## Load-bearing rules

| Rule | Consequence |
|------|-------------|
| Strict widths | `i32 + i64` is a type error; `@as(expr, T)` is the one conversion (float→int truncates, bool→0/1) |
| Num-type literals | `1` flexes to any numeric width, `1.5` to any float width — each read flexes its own copy of the num type; backends lower unresolved num types to `i64`/`f64` via `widthOf`, never widened at parse time; the REPL alone echoes them as untyped num types (`42 : int`, `x := 42; x` → `42 : int`, `PI : float`) |
| f32 stamping | every producing node is stamped; interp frounds, wasm emits a demote/promote round-trip — f32 precision holds end to end |
| `any` is absorbing | escape hatch; inferred-`any` bindings warn (explicit annotation silences) |
| `Op!` needs a declaration | `effect Op(args): ret` — `ret` is what `Op!(…)` evaluates to, i.e. what `resume` injects |
| Effectful bodies need `! { … }` | a `::`/`fn` whose body performs effects must declare a superset; pure bodies may omit it; the declaration pins unannotated parameters' effect variables to the declared set (empty declaration + performing parameter → rejected) |
| No-Return handle rule | body effectful → result type is *not* unified with the body type (handlers transform results); body pure → `R ~ bodyType` |
| `resume` `k` type | `k : (effectRet) -> R` where `R` is the handle result type, not the body type |
| Value restriction | only lambda RHS are generalized; literals and bracket literals stay monomorphic — keeps mutation sound |
| Width ambiguity | a *generalized* lambda doing numeric ops on an unannotated parameter is rejected: the width would flex per call site while the body fixed one |

Next: [Analysis](analysis.md).
