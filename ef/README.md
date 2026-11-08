# ef

A tiny statically-typed language with **algebraic effects and effect handlers**, C/Go-flavored syntax, and a Hindley-Milner-flavoured type system that tracks effects. Implemented in a single TypeScript file (~900 lines).

```bash
bun test        # test suite (demos live in it, no self-check block)
bun compiler/cli.ts run examples/star.ef # run a program
bun check       # host typecheck (stays clean)
```

## In one paragraph

`ef` is a small expression language. You write `let`, `fn`, `if`, and blocks like in C/Go. Functions can **perform** abstract *effects* instead of throwing or returning, and `handle` blocks install *handlers* that catch those effects and receive the suspended computation as a resumable continuation `k` — which can be called zero, one, or many times. A static type checker rejects ill-typed programs before evaluation and infers the effect set of every function (shown as `(int) -> int ! { Emit }`).

A taste:

```js
effect Choose(opts: [int]): int;            # Choose yields an int
handle {
  let x = Choose!([1, 2, 3]);        # pause, ask the handler
  let y = Choose!([10, 20]);
  [x, y]
} case Return(v) => k { [v] }               # what to do with the final value
  case Choose(opts) => k { flat(map(k, opts)) }  # try every option, resume each
# → [[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]
```

The handler calls `k` once per option, so the computation branches into all paths — nondeterminism built from ordinary multi-shot resumption.

## Highlights

- **Algebraic effects** as first-class, statically-tracked operations.
- **Deep handlers** with a `Return` case for the body's result value.
- **Multi-shot resume** — the continuation `k` is a plain callable, so it can run zero, one, or many times (nondeterminism, backtracking, etc.).
- **Effect propagation** through nested handlers: an unhandled effect walks outward to the nearest matching handler.
- **Static typing** with type inference, union-find unification, and an absorbing `any` escape hatch.
- **Tuples** — named `[x: float, y: float]` and unnamed `[int, string]`, with `.x`/`.0` field access and `let [a, b] = p` destructuring. Bracket literals are arrays when homogeneous, tuples when not.
- **Parametric type aliases** — `type Pair(a, b) = [a, b];`, instantiated as `Pair[int, string]`.
- **Function effect signatures** `let f = fn(p: T): R ! { Effs } { ... }` the checker verifies against the body.
- **Polymorphic builtins** (`map : (A)->B, [A] -> [B]`, etc.).

## Layout

Bun workspace: the compiler is the `compiler/` package; examples, configs and
the README stay at the workspace root.

| Path                | Contents                                       |
|---------------------|------------------------------------------------|
| `compiler/`         | The whole language: lexer, parser, type checker, CPS evaluator, builtins, wasm backend, `run`/`show`/`typeOf`. `compiler/*.test.ts` is the executable spec (`bun:test`); `compiler/scripts/` holds dev scripts (runtime-deps CI gate, raytracer output renderers). |
| `compiler/cli.ts`   | Frontend: `ef run <file> \| ef buildwasm <file> [out] \| ef runwasm <file> \| ef types <file> \| ef lint <file> \| ef repl`. |
| `playground/`       | In-browser studio (see below).                 |
| `examples/`         | Example `.ef` programs, exercised by the test suite. |
| `AGENTS.md`         | Notes for AI agents working on this repo.      |

---

## Playground

`playground/` is a browser studio for ef: a multi-file ef IDE
served as a static bundle. The compiler's TypeScript frontend runs natively in
the browser — parse/check/lint are live as you type, **Run** (⌘↩) compiles the
project through the wasm backend and executes it in the browser's
WebAssembly (streaming `Out!`/`Println!` into the output pane; wasm tail
calls make the stack O(1) in every engine, unlike the CPS interpreter, which
relies on JSC tail calls), and **Build** (⌘B) emits the same WasmGC
`main.wasm` (binaryen shrink pass, lazily loaded) for download. Files are one
compilation unit (concatenated in order); the entry file — the one holding the
last top-level expression — is marked in the tree.

```sh
cd playground && bun run dev     # build + watch + serve on http://localhost:8917 (rebuilds on source change, tabs live-reload)
bun run build                    # rebuild dist/ only
```

---

> **⚠ When the language changes, update this README.**
> The "Full spec" below is the source of truth for syntax, typing rules, and
> builtins. Any change to the language surface must be reflected here.

---

# Full spec

## 1. Lexical structure

- **Whitespace** (space, tab, CR, LF) is insignificant.
- **Line comments** with `#` run to end of line.
- **String literals** are `"..."` with `\` escapes: `\n \t \r \" \\ \xHH` (byte),
  `\uHHHH` (code point). Unknown `\c` yields `c`.
- **Number literals** are non-negative integer/decimal digit runs (e.g. `42`,
  `3.14`). A literal containing a `.` is typed `float`; otherwise `int`.
  Unary minus is parsed as the unary `-` operator in `parseUnary`.
- **Identifiers** start with a letter or `_`, continue with letters/digits/`_`.
- **Keywords:** `let fn if else while handle case true false unit effect`.
- **Two-char tokens:** `== != <= >= && || =>`.
- **One-char tokens:** `( ) [ ] { } , ; < > + - * / ! = : %`.
- `->` is lexed as two tokens `-` `>` and reassembled by the type parser.

## 2. Syntax

### 2.1 Programs

A program is a sequence of **items**, each an expression statement, an
effect declaration, or a type alias:

```
program  ::= item*
item     ::= effect-decl | type-alias | stmt
effect-decl ::= "effect" name params ":" type ";"
type-alias ::= "type" name ("(" name ("," name)* ")")? "=" type ";"
stmt     ::= let | expr (";" | blocky)
```

The value of a program is the value of its last expression statement. Type
aliases and effect declarations are not expressions and produce no value.

### 2.2 Declarations

```
let       ::= "let" (name (":" type)? "=" expr | tuple-pattern "=" expr) ";"
tuple-pattern ::= "[" (name (":" type)? ("," name (":" type)?)*)? "]"
params    ::= "(" (name (":" type)? ("," name (":" type)?)* )? ")"
eff-annot ::= "!" "{" name ("," name)* "}"
block     ::= "{" stmt* "}"
```

- `let` binds recursively: the name is in scope in its own value, so
  `let f = fn(...) { ... }` can call itself.
- `let [a, b] = e;` **destructures** a tuple (or array): each name is bound
  to the corresponding element. Optional per-field `: type` annotations
  constrain the element type.
- Lambdas `fn (p: T): R ! { Effs } { body }` may carry optional `: R` and
  `! { Effs }` annotations; the checker verifies the body's performed effects
  ⊆ the declared set (or derives the set when `! { ... }` is omitted).

### 2.3 Expressions

```
expr     ::= binary
binary   ::= unary (binop unary)*        -- Pratt, see precedence below
unary    ::= ("-" | "!") unary | postfix
postfix  ::= primary ("(" args ")")* ("." name)*   -- call, then field access
primary  ::= num | str | "true" | "false" | "unit"
           | name | "(" expr ")" | array | lambda | if | handle
array    ::= "[" (expr ("," expr)*)? "]"
lambda   ::= "fn" params block
if       ::= "if" "(" expr ")" block ("else" (if | block))?
perform  ::= name "!" "(" args ")"        # `Op!(args)`
handle   ::= "handle" block case+
case     ::= "case" name params "=>" name block
args     ::= "(" (expr ("," expr)*)? ")"
```

- **Bracket literals** `[a, b, c]` are **arrays if all element types unify**
  (homogeneous → `[T]`), otherwise **tuples** (`[T1, ..., Tn]`). A tuple
  **type annotation** on the binding (`let p: [float, float] = [1.0, 2.0]`)
  forces a tuple even when the elements would unify. The same expectation
  flows from a tuple **return type** into a `[...]` body literal, and from a
  tuple **parameter type** into an `[...]` argument literal (including
  nested tuples, e.g. `[[f,f,f],...]`). Explicit `list(...)` always builds
  an array.
- **`&&` / `||`** desugar to `if`: `a && b` → `if a { b } else { false }`, `a || b` → `if a { true } else { b }`. Short-circuit falls out for free.
- **Field access** `e.x` / `e.0`: reads a tuple field by name or position, or
  an array element by position (`xs.0`). The index is resolved at check time
  and the runtime indexes the underlying array. Chained access like `m.0.0`
  is parsed as successive accesses (the lexer would otherwise read `0.0` as
  one float token).
- **Binary operators** and precedence (lowest → highest):

  | Prec | Operators                |
  |------|--------------------------|
  | 1    | `\|\|`                   |
  | 2    | `&&`                     |
  | 3    | `== !=`                  |
  | 4    | `< > <= >=`              |
  | 5    | `+ -`                    |
  | 6    | `* / %`                  |

  All operators are left-associative.

### 2.4 Effects and handlers

A **statement** is an expression used for its side effect. Inside a block, a
bare `name = expr` is an **assignment**: it updates the nearest enclosing
binding of `name` (which must already exist) and yields `unit` — the mutation
primitive that makes `while` useful.

```
effect-decl ::= "effect" name "(" params ")" ":" type ";"
handle      ::= "handle" block case+
case        ::= "case" ("Return" | name) params "=>" name block
```

- An **effect declaration** `effect Op(args): ret` introduces a named operation
  with parameter types and a return type. `ret` is the type that
  `Op!(...)` evaluates to — equivalently, the type the continuation
  `k` expects to be resumed with.
- **Builtin effects.** Two effects are pre-declared and interpreted by the
  runtime when they reach the top level unhandled:
  - `Read(path: string): string` — reads a file, resumes with its contents.
  - `Write(path: string, content: string): unit` — writes a file, resumes
    with `unit`.
  They are still ordinary algebraic effects: a user `handle` can intercept
  either (e.g. to mock the filesystem) before the builtin interpretation
  applies.
- A **handler** has one body block and one or more `case` arms.
- `case Return(params) => k { ... }` handles the body's normal result value.
  `k` is not used here (the body is already done); the case computes the
  handler's overall result from the value.
- `case Op(params) => k { ... }` handles a performed `Op`. The `params` bind
  the effect's arguments; `k` is the captured continuation, callable as
  `k(value)` to resume the body with `value` (of the effect's return type). `k`
  may be called zero, one, or many times.
- **Propagation:** an effect performed inside a handler body that has no
  matching case walks outward to the next enclosing handler.

## 3. Types

### 3.1 Type grammar

```
type   ::= "[" type "]"                      -- array
         | "[" tup-field ("," tup-field)* "]"  -- tuple
         | "(" type ("," type)* ")" "->" type ("!" "{" name ("," name)* "}")?
         | name ("[" type ("," type)* "]")?    -- alias instantiation
         | "int" | "float" | "string" | "bool" | "unit" | "any"
tup-field ::= (name ":")? type               -- named (`x: float`) or unnamed
```

- `int`, `float`, `string`, `bool`, `unit` — primitives. `int` and `float`
  are distinct but **numeric-widen** together: an `int` may be used where a
  `float` is expected and vice versa, and any numeric op on two ints yields
  `int`, while a mix of `int`/`float` (or two `float`s) yields `float`.
- `[T]` — array of `T` (homogeneous).
- `[T1, ..., Tn]` — **tuple**: fixed arity, positional field types. Fields
  may be named (`[x: float, y: float]`) or unnamed (`[int, string]`); names
  are for access only and ignored by unification, which compares arity and
  positional types. `[T]` (one element, no comma) is an array, not a 1-tuple.
- `type Name(p1, ..., pn) = T;` declares a **parametric type alias**. Use it
  as `Name[A1, ..., An]`; the body `T` is substituted with the arguments at
  parse time (nullary `type V = ...;` needs no `[...]`). Alias params are
  type variables scoped to the body. Recursive aliases are not supported.
- `(T1, ..., Tn) -> R` — function type. The optional `! { E1, ..., En }` is
  its **effect set**: the effects the function may perform. Empty/omitted =
  pure.
- `any` — absorbing type. Unifies with anything and stays `any`. Because `any`
  is an escape hatch, the checker **warns** when a `let` binding's
  *inferred* type contains `any` (e.g. `let f = list` infers `(any) -> [any]`);
  writing an explicit annotation (`let f: (any) -> [any] = list`) silences the
  warning. Array literals like `[1,2,3]` are special-cased to `[int]` and do
  not trigger it.

### 3.2 Type variables and unification

- Type variables use **union-find** equivalence with a side-map of substitutions. `res(t)` resolves a type; occurs-check prevents recursive types.
- `unify(a, b)` either makes the two types equal or throws a `TypeError` of the form:
  ```
  at line L, col C: Type mismatch:
  got      : <actual>
  expected : <expected>
  ```
  The `at line L, col C:` prefix is the source position of the innermost
  expression being inferred when the mismatch surfaced (omitted when no
  position is available). A non-function call names the callee instead of
  `got`. Arity mismatches are reported as `arity m ≠ n`.

### 3.3 Inference rules

- `num : int`/`float` (by whether the literal has a `.`), `str : string`, `bool : bool`, `unit : unit`.
- `name : Γ(name)` (or a fresh instantiation if `Γ(name)` is a polymorphic scheme).
- `[a, b, c]` : `[T]` where all element types unify with a single fresh `T`
  (homogeneous → array). If they do **not** unify, the literal is a tuple
  `[Ta, Tb, Tc]` of the element types. Under a tuple type annotation it is
  checked against the declared field types directly.
- `fn (p1:T1,...): R ! {E} { body } : (T1,...) -> R ! {E}`. Untyped params get
  fresh vars; the body is inferred under their bindings; if a return type
  annotation is present it unifies with the inferred body type. **Effect
  annotations are optional and derived when missing**: if `! { ... }` is
  omitted, the function's effect set is inferred from the body's performed
  effects. When present, the annotation must be a superset of the body's
  effects (the body's performed effects must be ⊆ the annotation), and the
  annotation becomes the function's effect set. Anonymous lambdas may also
  carry `: T` and `! { ... }` annotations: `fn(p): unit ! { Out } { ... }`.
- `let x : T = e` — `T` (if present) unifies with `infer(e)`; `x : T`. When
  `T` is a tuple and `e` is a bracket literal, the literal is typed as that
  tuple.
- `let [a, b] = e` — `e : [Ta, Tb]` (tuple) or `[T]` (array, each field `: T`);
  binds `a, b` to the element types.
- `e.x` / `e.0` — `e` must be a tuple (`[x: T, ...]` or `[T, ...]`) or an array.
  For a named tuple field, `.name` resolves to its position; `.N` indexes by
  position. For an array, `.N` indexes element `N`.
- `if c { a } else { b } : T` where `c : bool` and `a, b : T` (branches must
  agree). `if` with no `else` has an implicit `unit` else branch.
- `f(a1, ..., an)` — `f : (T1,...,Tn) -> R ! {E}`, each `ai : Ti`, the call has type `R` and adds `E` to the caller's effects. Mismatched arity or argument types are errors.
- **Effect rows are unified, not just propagated.** A function's `! { ... }` is a row: a concrete set of effect names, or an unbound *effect variable*. Two function types unify their effect rows by union-find: variable+variable unions, variable+set binds, set+set requires equality. The empty set `∅` is the polymorphic bottom — a function typed `... ! ∅` may be used wherever any effect set is expected (it is refined to the other set) — so unannotated higher-order parameters stay flexible without let-generalization.
- **Higher-order builtins are effect-polymorphic.** `map : ((a) -> b ! e, [a]) -> [b] ! e`, `each : ((a, int) -> b ! e, [a]) -> unit ! e`, `flatmap : ((a, int) -> [b] ! e, [a]) -> [b] ! e` — each with a fresh effect variable `e` per instantiation, shared between the callback's effect row and the call's performed effects. So `map(pureF, xs)` performs `∅` while `map(fn(x){ Out!(x); x }, xs)` performs exactly `{ Out }` — neither over- nor under-approximated.
- `Op!(a1, ..., an)` — requires a declared `effect Op(p1,...): ret`; each `ai : pi`; the expression has type `ret` and adds `Op` to the effects.
- `handle { body } case Return(v) => k { rb } case Op(pi) => k { ob } ...`
  - The body is inferred with its own effect set `B`.
  - `Return(v)`: `v : bodyType`; the result type `R` unifies with `infer(rb)` (no `k` used).
  - `Op(pi) => k`: `pi` are the effect's declared param types, `k : (ret) -> R` where `ret` is `Op`'s declared return type and `R` is the handle result type; `infer(ob)` unifies with `R`.
  - **No-Return rule:** when `B` is non-empty, `R` is *not* unified with `bodyType` (handlers transform results). When `B` is empty, `R ~ bodyType`.
  - Handled ops are removed from the body's effect set; any remaining (unhandled) ops propagate to the caller.
  - Handler case bodies run *outside* their handler (a perform in a case body delegates outward), so effects a case body performs propagate to the caller too.
- **Top-level effect policy:** effects left over at the top level are either interpreted by a builtin handler (for `Read`/`Write`/`Println`/`Out`) or reported as unhandled. Reporting is fail-fast: before running anything, the pipeline rejects a program whose statically-performed residual ops (performed with no matching handler in their subtree, per the checker's effect tracking — including through calls) are neither builtin effects nor covered by an interpreter override. A program that would fail mid-run after side effects instead fails before evaluation begins. `ef types <file>` surfaces exactly these top-level-reaching ops: its final `_ : T ! { ... }` line shows the whole program's result type with the residual effect row (unhandled builtin effects included, internally-handled ops excluded).

### 3.4 Polymorphism

- User `let` bindings of a **lambda value** are **generalized** (HM
  let-generalization, value-restricted): type/effect variables not free in the
  surrounding environment are abstracted, and each use instantiates fresh
  copies. So `let apply = fn (f, x) { f(x) }` gets `apply : ((a) -> b ! e, a) -> b ! e`
  and one definition works at many types in the same program.
- **Value restriction:** only lambda RHS are generalized. Literals carry no
  type variables (generalization is a no-op), and bracket literals are typed
  directly (arrays via homogenization, tuples positionally — non-values), so
  they stay monomorphic — this keeps mutable arrays (`set`) and mutable
  variables (`assign`) sound (no `let xs = [] : [a]` that any element type
  could flow into).
- Bindings with an explicit `: type` annotation are monomorphic (the
  annotation fixes the type).
- Builtins `map`, `head`, `tail`, `concat`, `flat`, `len` are polymorphic via
  **scheme thunks** in the type environment: each lookup produces a fresh copy
  with fresh type variables.

## 4. Builtins

### 4.1 Operators (binary)

| Operator    | Type                              |
|-------------|-----------------------------------|
| `- * / %`   | `(int, int) -> int` / `(float, _) -> float` | numeric widening. |
| `+`         | `(int, int) -> int` / `(float, _) -> float` / `(string, string) -> string` | overloaded: numeric widening, or string concatenation. Mixed `"a" + 1` is a type error. |
| `< > <= >=` | `(_num, _num) -> bool`        | numeric widening on operands. |
| `== !=`     | `(T, T) -> bool`              | Both operands must share a type `T` (numeric widening still lets `int ~ float`); cross-type comparisons like `"a" == 1` are rejected. Not first-class — cannot be passed as a function value. |

Unary `-` (neg) : numeric, shares the widening rule (`int` in → `int` out, `float` in → `float` out). Unary `!` (not) : `(bool) -> bool`.

`/` is **type-preserving and truncates toward zero** for `int / int` (`7 / 2 == 3`, `-7 / 2 == -3`); `float / float` is exact (`7.0 / 2.0 == 3.5`).
The type checker stamps each `/` node as int or float division at check time (the runtime sees untyped JS numbers and cannot tell `7` from `7.0`).

### 4.2 Functions

| Name      | Type (schematic)                | Notes |
|-----------|---------------------------------|-------|
| `list`    | `(any) -> [any]`                | Variadic array constructor. Explicit `list(1,2,3)` is `[int]`; bracket literals `[1,2,3]` are typed directly (array if homogeneous, else tuple). |
| `head`    | `([A]) -> A`                    | First element. |
| `tail`    | `([A]) -> [A]`                  | All but first. |
| `concat`  | `([A], [A]) -> [A]`             | Append; both arrays share element type `A`. |
| `flat`    | `([[A]]) -> [A]`                | Flatten one level. |
| `len`     | `([A]) -> int`                  | Array length. |
| `strlen` | `(string) -> int`               | String length. |
| `map`     | `((A) -> B, [A]) -> [B]`        | Apply; fresh `A`/`B` per use. |
| `get`     | `([A], int) -> A`               | Array index. |
| `set`     | `([A], int, A) -> unit`         | Array index assignment (mutates). |
| `each`    | `((A, int) -> B, [A]) -> unit`  | Iterate with index; result discarded. |
| `flatmap` | `((A, int) -> [B], [A]) -> [B]` | Map-then-concat. |

### 4.3 Math, I/O

Console output is via the `Println`/`Out` effects (§4.4), not functions;
process control is via the `Exit`/`Wait` effects (§4.4), not functions.

| Name      | Type (schematic)                | Notes |
|-----------|---------------------------------|-------|
| `PI`      | `float`                         | `Math.PI`. |
| `cos`     | `(float) -> float`              | Cosine (radians). |
| `sin`     | `(float) -> float`              | Sine (radians). |
| `abs`     | `(float) -> float`              | Absolute value. |
| `round`   | `(float) -> int`                | Round to nearest int. |
| `sqrt`   | `(float) -> float`              | Square root. |
| `range`   | `(int, int, int) -> [int]`      | `range(start, end, step)`: half-open; `step` may be negative. |
| `char`    | `(int) -> string`               | Code point → single-char string. |
| `number`  | `(string) -> float`             | Parse a string to a number. |
| `args`    | `() -> [string]`                | CLI args after the source file. |

`each`/`flatmap`/`map` take the function **first**, matching `map`.
(Formerly `exit`/`wait` builtins existed; they are now the `Exit`/`Wait` effects in §4.4.)

### 4.4 Builtin effects

These are pre-declared like user effects and invoked with the `!` postfix. With no user handler, the runtime interprets them at the top level (real I/O); a user `handle` can intercept any of them.

| Effect    | Signature                  | Default behaviour |
|-----------|----------------------------|--------------------|
| `Read`    | `(path: string): string`   | `readFileSync` the path. |
| `Write`   | `(path: string, content: string): unit` | `writeFileSync` the path. |
| `Println` | `(v: any): unit`           | `console.log(show(v))` — print a value + newline. |
| `Out`     | `(s: string): unit`        | `process.stdout.write(s)` — raw string, no newline. |
| `Exit`    | `(code: int): unit`        | `process.exit(code)` — terminates without resuming. |
| `Wait`    | `(secs: int): unit`        | Busy-wait `secs` seconds then resume with unit (synchronous evaluator). |
| `Random`  | `(): float`                | Resume with a random number in [0, 1) (`Math.random()`; a seeded PRNG when the `EF_RANDOM_SEED` env var is set to an integer). |

```js
# Println is an ordinary effect: a handler can capture it instead of printing.
handle {
  Println!(42);
  Println!("hi");
  0
} case Return(v) => k { [v] }
  case Println(x) => k { concat([x], k(unit)) }
# [42, "hi", 0]
```

## 5. Semantics

- **Evaluation is in continuation-passing style.** `evalE(e, env, k)` either calls `k(v)` with a value or produces an `Outcome` describing a trapped effect.
- **Effects.** `Op!(args)` searches outward for a handler whose cases include `Op`. On a match, the handler runs with the effect's arguments bound and `k` set to a closure capturing the suspended computation; calling `k(v)` resumes the body with `v`. On no match, evaluation fails.
- **Multi-shot resume.** `k` is an ordinary JS function, so it can be invoked many times — each call re-runs the continuation from the point!.  This enables nondeterminism, backtracking, etc.
- **Deep handlers.** The `Return` case sees the body's final value; effect cases see the site! and can resume or not. Effects performed inside a handler case propagate outward to the next handler.

## 6. The `run` / `show` / `typeOf` API

`index.ts` exports three functions:

```ts
function run(src: string): Value;      // typecheck then evaluate; throws on type error
function show(v: Value): string;       // pretty-print a value; closures print as `[fn: <type>]`
function typeOf(src: string): string;  // inferred type of the last expression, e.g. "(int) -> int ! { Emit }"
function repl(): void;                 // interactive REPL with persistent bindings
```

A type error is a thrown `Error` whose message contains the mismatch (e.g.  `at line 1, col 1: Type mismatch:\ngot : int\nexpected : string`, `arity 1 ≠ 2`, `Unknown effect Nope`, `effect Emit not declared in signature`).

## 7. Examples

### Nondeterminism (multi-shot resume)

```js
effect Choose(opts: [int]): int;
handle {
  let x = Choose!([1, 2, 3]);
  let y = Choose!([10, 20]);
  [x, y]
} case Return(v) => k { [v] }
  case Choose(opts) => k { flat(map(k, opts)) }
# [[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]
```

### Tuples, aliases, and field access

```js
type Point(a) = [x: a, y: a];
let p: Point[float] = [1.0, 2.0];
let [x, y] = p;
[x, p.x + p.y]
# [1, 3]
```

`type Point(a) = [x: a, y: a];` declares a parametric alias; `Point[float]`
substitutes `a = float`. The literal `[1.0, 2.0]` is typed against the
annotated tuple `[x: float, y: float]`, so `p.x` and `p.y` are `float`.

### Exceptions (non-resuming handler)

```js
effect Div(a: int, b: int): int;
handle {
  let r = Div!(10, 0);
  [r]
} case Div(a, b) => k {
  if (b == 0) { ["div by zero"] } else { k(a / b) }
}
# ["div by zero"]
```

### Threading a log across resumes

```js
effect Log(msg: int): unit;
effect Result(v: int): unit;
handle {
  Log!(1);
  Log!(2);
  Result!(42)
} case Log(msg) => k { concat([msg], k(unit)) }
  case Result(v) => k { [v] }
# [1, 2, 42]
```

### Effect propagation through nested handlers

```js
effect Emit(m: string): unit;
effect Other(m: string): unit;
handle {
  handle { Emit!("hi") } case Other(m) => k { ["should-not-match"] }
} case Emit(m) => k { [m] }
# ["hi"]
```

### Recursion with a typed signature

```js
let fact = fn(n: int): int {
  if (n == 0) { 1 } else { n * fact(n - 1) }
};
fact(5)
# 120
```

### Short-circuit and an effectful signature

```js
effect Emit(m: int): int;
let ask = fn(n: int): int ! { Emit } { Emit!(n) };
ask
# typeOf → "(int) -> int ! { Emit }"
```

### Builtin effects (default handler does real I/O)

```js
# Write then read; with no user handler, the runtime performs real I/O.
Write!("hello.txt", "hello ef");
Read!("hello.txt")
# → "hello ef"
```

```js
# A user handler can intercept Read to mock the filesystem.
handle {
  Read!("anything")
} case Return(v) => k { [v] }
  case Read(path) => k { ["mocked"] }
# → ["mocked"]
```

## 8. CLI

`compiler/cli.ts` is a thin runner:

```
ef run <file> [args...]   # typecheck then evaluate; extra args reach `args()`
ef buildwasm <file> [out] # compile to a binary .wasm module and write it to `out`
ef runwasm <file>         # compile to WebAssembly and run on the embedded host runtime
ef types <file>           # print every top-level symbol and its inferred type
ef lint <file>            # run lint passes and report issues (exits 1 on findings)
ef repl                   # interactive REPL; bindings persist across lines
```

The result of the last expression is printed via `show` unless the program calls `Exit!(...)` itself. Programs that loop forever (animations) run until killed.

`ef buildwasm` writes the same module to disk (default: `<file>.ef` → `<file>.wasm`) instead of running it.

`ef runwasm` compiles the whole program to a binary `.wasm` module (the wasm backend: `wasm.ts` plus its `wasm_*.ts` sub-modules, no external toolchain) and executes it in the host's WebAssembly engine. Output matches `ef run` for the supported subset: values, control flow, closures, arrays/strings, `handle` with multi-shot `resume`, and user effect ops. An effect with no matching handler in the chain — builtin or user — reaches the host through the `ef_perform` import and is interpreted by the same builtin host table `ef run` uses (optionally overridden via `runWasm`'s `interp` argument), so `Exit!` behaves identically: it terminates the process. Not supported: a perform or handle site inside an `if` branch or `while` body (rejected at compile time — suspension across those control-flow blocks).

ABI: every value is a WasmGC `anyref` (unit = null ref, bool = i31, number/string/array/tuple/closure = structs/arrays). The module exports `run` plus 12 accessor functions — `__tag`, `__num`, `__str_len`, `__str_get`, `__arr_len`, `__arr_get`, `__mk_num`, `__mk_bool`, `__str_new`, `__str_set`, `__arr_new`, `__arr_set` — the only way JS touches GC structs. It imports 7 host functions — `ef_perform`, `ef_char`, `ef_number`, `ef_args`, `ef_cos`, `ef_sin`, `ef_fail` — tree-shaken down to the live set (`ef_fail` always stays).

`ef lint <file>` runs a sequence of lint passes over the parsed program and prints each finding as `rule: message`. The current passes are:

- `unused-arg` — a function parameter never referenced in the body. Scope-aware: a name shadowed by an inner lambda parameter or a `let` binding (or a handler-case parameter / `resume`) does not count as a use of the outer argument. Named functions (`let` of a `fn`) are reported as `function \`name\``; bare lambdas as `anonymous function`.

The REPL parses each line as a complete program; `let`/`effect` bindings accumulate across lines (both the runtime env and the type env persist). A bare expression prints both value and inferred type, e.g. `1 + 2` → `3 : int`.
Type `:q` to quit.

## 9. Examples on disk

- `examples/newton.ef` — Newton's method square root (`while` + assignment).
- `examples/tco.ef` — recursion probe. The CPS evaluator is fully tail-call-structured, so Bun/JSC's TCO keeps the stack O(1) for both tail and non-tail calls; non-tail recursion costs heap allocation (linear time), not stack overflow. The wasm target also runs it: calls in tail position compile to `return_call_indirect` (O(1) wasm stack); each call still allocates a frame block, but the host GC reclaims them (the old linear-memory backend exhausted the heap at ~100M depth).
- `examples/star.ef` — rotating 3D star polygon (port of `ink/samples/star.ink`).
  Run: `ef run examples/star.ef <vertices> <step>` where `0 < step < vertices/2`.
