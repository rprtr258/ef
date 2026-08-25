# ef

A tiny statically-typed language with **algebraic effects and effect handlers**,
C/Go-flavored syntax, and a Hindley-Milner-flavoured type system that tracks
effects. Implemented in a single TypeScript file (~900 lines), evaluated with
[Bun](https://bun.sh).

```bash
bun test              # test suite (14 tests)
bun run index.ts      # self-check demos
bunx tsc --noEmit     # host typecheck (stays clean)
```

## In one paragraph

`ef` is a small expression language. You write `let`, `fn`, `if`, and blocks
like in C/Go. Functions can **perform** abstract *effects* instead of throwing
or returning, and `handle` blocks install *handlers* that catch those effects
and receive the suspended computation as a resumable continuation `k` — which
can be called zero, one, or many times. A static type checker rejects
ill-typed programs before evaluation and infers the effect set of every
function (shown as `(int) -> int ! { Emit }`).

A taste:

```js
effect Choose(opts: [int]): int;            // Choose yields an int
handle {
  let x = perform Choose([1, 2, 3]);        // pause, ask the handler
  let y = perform Choose([10, 20]);
  [x, y]
} case Return(v) => k { [v] }               // what to do with the final value
  case Choose(opts) => k { flat(map(k, opts)) }  // try every option, resume each
// → [[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]
```

The handler calls `k` once per option, so the computation branches into all
paths — nondeterminism built from ordinary multi-shot resumption.

## Highlights

- **Algebraic effects** as first-class, statically-tracked operations.
- **Deep handlers** with a `Return` case for the body's result value.
- **Multi-shot resume** — the continuation `k` is a plain callable, so it can
  run zero, one, or many times (nondeterminism, backtracking, etc.).
- **Effect propagation** through nested handlers: an unhandled effect walks
  outward to the nearest matching handler.
- **Static typing** with type inference, union-find unification, and an
  absorbing `any` escape hatch.
- **Function effect signatures** `fn f(p: T): R ! { Effs } { ... }` the
  checker verifies against the body.
- **Polymorphic builtins** (`map : (A)->B, [A] -> [B]`, etc.).

## Layout

| File            | Contents                                       |
|-----------------|------------------------------------------------|
| `index.ts`      | The whole language: lexer, parser, type checker, CPS evaluator, builtins, `run`/`show`/`typeOf`. |
| `index.test.ts` | The executable spec — positive and negative tests via `bun:test`. |
| `AGENTS.md`     | Notes for AI agents working on this repo.      |

---

> **⚠ When the language changes, update this README.**
> The "Full spec" below is the source of truth for syntax, typing rules, and
> builtins. Any change to the language surface must be reflected here.

---

# Full spec

## 1. Lexical structure

- **Whitespace** (space, tab, CR, LF) is insignificant.
- **Line comments** with `//` run to end of line.
- **String literals** are `"..."` with `\` escapes: `\n \t \r \" \\ \xHH` (byte),
  `\uHHHH` (code point). Unknown `\c` yields `c`.
- **Number literals** are non-negative integer/decimal digit runs (e.g. `42`,
  `3.14`). A literal containing a `.` is typed `float`; otherwise `int`.
  Unary minus is parsed as the unary `-` operator in `parseUnary`.
- **Identifiers** start with a letter or `_`, continue with letters/digits/`_`.
- **Keywords:** `let letrec fn if else while perform handle case true false unit effect`.
- **Two-char tokens:** `== != <= >= && || =>`.
- **One-char tokens:** `( ) [ ] { } , ; < > + - * / ! = : %`.
- `->` is lexed as two tokens `-` `>` and reassembled by the type parser.

## 2. Syntax

### 2.1 Programs

A program is a sequence of **items**, each either an expression statement or
an effect declaration:

```
program ::= item*
item    ::= effect-decl | stmt
effect-decl ::= "effect" name params ":" type ";"
stmt    ::= let | letrec | fn-decl | expr (";" | blocky)
```

The value of a program is the value of its last expression statement.

### 2.2 Declarations

```
let       ::= "let" name (":" type)? "=" expr ";"
letrec    ::= "letrec" name (":" type)? "=" expr ";"
fn-decl   ::= "fn" name params (":" type)? eff-annot? block
params    ::= "(" (name (":" type)? ("," name (":" type)?)* )? ")"
eff-annot ::= "!" "{" name ("," name)* "}"
block     ::= "{" stmt* "}"
```

- `let` binds non-recursively; `letrec` binds recursively (the name is in scope
  in its own value).
- `fn name(params): T ! { Effs } { body }` is sugar for a `letrec` whose value
  is a lambda carrying the return type and declared effect set. The checker
  verifies the body's performed effects ⊆ the declared set.
- Anonymous lambdas: `fn (p: T) { body }` (no name); may carry optional `: R`
  and `! { Effs }` annotations like named functions.

### 2.3 Expressions

```
expr     ::= binary
binary   ::= unary (binop unary)*        -- Pratt, see precedence below
unary    ::= ("-" | "!") unary | postfix
postfix  ::= primary ("(" args ")")*     -- call
primary  ::= num | str | "true" | "false" | "unit"
           | name | "(" expr ")" | array | lambda | if | perform | handle
array    ::= "[" (expr ("," expr)*)? "]"
lambda   ::= "fn" params block
if       ::= "if" "(" expr ")" block ("else" (if | block))?
perform  ::= "perform" name "(" args ")"
handle   ::= "handle" block case+
case     ::= "case" name params "=>" name block
args     ::= "(" (expr ("," expr)*)? ")"
```

- **Array literals** `[a, b, c]` desugar to `list(a, b, c)`.
- **`&&` / `||`** desugar to `if`: `a && b` → `if a { b } else { false }`,
  `a || b` → `if a { true } else { b }`. Short-circuit falls out for free.
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
  `perform Op(...)` evaluates to — equivalently, the type the continuation
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
type  ::= "[" type "]"
        | "(" type ("," type)* ")" "->" type ("!" "{" name ("," name)* "}")?
        | "int" | "float" | "string" | "bool" | "unit" | "any"
```

- `int`, `float`, `string`, `bool`, `unit` — primitives. `int` and `float`
  are distinct but **numeric-widen** together: an `int` may be used where a
  `float` is expected and vice versa, and any numeric op on two ints yields
  `int`, while a mix of `int`/`float` (or two `float`s) yields `float`.
- `[T]` — array of `T` (homogeneous).
- `(T1, ..., Tn) -> R` — function type. The optional `! { E1, ..., En }` is
  its **effect set**: the effects the function may perform. Empty/omitted =
  pure.
- `any` — absorbing type. Unifies with anything and stays `any`.

### 3.2 Type variables and unification

- Type variables use **union-find** equivalence with a side-map of
  substitutions. `res(t)` resolves a type; occurs-check prevents recursive
  types.
- `unify(a, b)` either makes the two types equal or throws a `TypeError` of
  the form `X ≠ Y` (or `arity m ≠ n`).

### 3.3 Inference rules

- `num : int`/`float` (by whether the literal has a `.`), `str : string`,
  `bool : bool`, `unit : unit`.
- `name : Γ(name)` (or a fresh instantiation if `Γ(name)` is a polymorphic
  scheme).
- `[a, b, c] : [T]` where all elements unify with a single fresh `T`
  (homogeneous arrays; `list` is special-cased in inference).
- `fn (p1:T1,...): R ! {E} { body } : (T1,...) -> R ! {E}`. Untyped params get
  fresh vars; the body is inferred under their bindings; if a return type
  annotation is present it unifies with the inferred body type. **Effect
  annotations are mandatory for effectful bodies**: if the body performs any
  effect, a `! { ... }` annotation listing a superset of those effects is
  required (a pure body may omit it). When present, the body's performed
  effects must be ⊆ the annotation, and the annotation becomes the function's
  effect set (otherwise the inferred set is used). Anonymous lambdas may also
  carry `: T` and `! { ... }` annotations: `fn(p): unit ! { Out } { ... }`.
- `let x : T = e` — `T` (if present) unifies with `infer(e)`; `x : T`.
- `if c { a } else { b } : T` where `c : bool` and `a, b : T` (branches must
  agree). `if` with no `else` has an implicit `unit` else branch.
- `f(a1, ..., an)` — `f : (T1,...,Tn) -> R ! {E}`, each `ai : Ti`, the call
  has type `R` and adds `E` to the caller's effects. Mismatched arity or
  argument types are errors.
- `perform Op(a1, ..., an)` — requires a declared `effect Op(p1,...): ret`;
  each `ai : pi`; the expression has type `ret` and adds `Op` to the effects.
- `handle { body } case Return(v) => k { rb } case Op(pi) => k { ob } ...`
  - The body is inferred with its own effect set `B`.
  - `Return(v)`: `v : bodyType`; the result type `R` unifies with
    `infer(rb)` (no `k` used).
  - `Op(pi) => k`: `pi` are the effect's declared param types, `k : (ret) -> R`
    where `ret` is `Op`'s declared return type and `R` is the handle result
    type; `infer(ob)` unifies with `R`.
  - **No-Return rule:** when `B` is non-empty, `R` is *not* unified with
    `bodyType` (handlers transform results). When `B` is empty, `R ~ bodyType`.
  - Handled ops are removed from the body's effect set; any remaining (unhandled)
    ops propagate to the caller.
- **Top-level effect policy:** effects left over at the top level are either
  interpreted by a builtin handler (for `Read`/`Write`/`Println`/`Out`) or
  reported as unhandled.

### 3.4 Polymorphism

- User `let`/`letrec` bindings are **monomorphic** (no let-generalization).
- Builtins `map`, `head`, `tail`, `concat`, `flat`, `len` are polymorphic via
  **scheme thunks** in the type environment: each lookup produces a fresh copy
  with fresh type variables.

## 4. Builtins

### 4.1 Operators (binary)

| Operator | Type                              |
|----------|-----------------------------------|
| `+ - * / %` | `(int, int) -> int` / `(float, _) -> float` | numeric widening; unary `-` (neg) shares this rule. |
| `< > <= >=` | `(_num, _num) -> bool`        | numeric widening on operands. |
| `== !=`  | `(any, any) -> bool`              |

Unary `-` (neg) : numeric, shares the widening rule (`int` in → `int` out,
`float` in → `float` out). Unary `!` (not) : `(bool) -> bool`.

`/` is **type-preserving and truncates toward zero** for `int / int`
(`7 / 2 == 3`, `-7 / 2 == -3`); `float / float` is exact (`7.0 / 2.0 == 3.5`).
The type checker stamps each `/` node as int or float division at check time
(the runtime sees untyped JS numbers and cannot tell `7` from `7.0`).

### 4.2 Functions

| Name       | Type (schematic)                                | Notes |
|------------|-------------------------------------------------|-------|
| `list`     | `(any) -> [any]`                                | Variadic array constructor; special-cased in inference so `[1,2,3]` is `[int]`. |
| `head`     | `([A]) -> A`                                    | First element. |
| `tail`     | `([A]) -> [A]`                                  | All but first. |
| `concat`   | `([A], [A]) -> [A]`                             | Append; both arrays share element type `A`. |
| `flat`     | `([[A]]) -> [A]`                                | Flatten one level. |
| `len`      | `([A]) -> int`                                  | Length. |
| `map`      | `((A) -> B, [A]) -> [B]`                        | Apply; fresh `A`/`B` per use. |

### 4.3 Math, I/O, and array helpers

Added for the `star.ink` port (see `examples/star.ef`). All are pure except
`exit`/`wait` (process control). Console output is via the `Println`/`Out`
effects (§4.4), not functions.

| Name      | Type (schematic)                  | Notes |
|-----------|-----------------------------------|-------|
| `PI`      | `float`                           | `Math.PI`. |
| `cos`     | `(float) -> float`                | Cosine (radians). |
| `sin`     | `(float) -> float`                | Sine (radians). |
| `abs`     | `(float) -> float`                | Absolute value. |
| `round`   | `(float) -> int`                  | Round to nearest int. |
| `range`   | `(int, int, int) -> [int]`        | `range(start, end, step)`: half-open; `step` may be negative. |
| `get`     | `([A], int) -> A`                 | Array index. |
| `set`     | `([A], int, A) -> unit`           | Array index assignment (mutates). |
| `each`    | `((A, int) -> B, [A]) -> unit`    | Iterate with index; result discarded. |
| `flatmap` | `((A, int) -> [B], [A]) -> [B]`   | Map-then-concat. |
| `char`    | `(int) -> string`                 | Code point → single-char string. |
| `number`  | `(string) -> float`               | Parse a string to a number. |
| `args`    | `() -> [string]`                  | CLI args after the source file. |
| `exit`    | `(int) -> unit`                   | Exit the process with a code. |
| `wait`    | `(int) -> unit`                   | Busy-wait `n` seconds (synchronous evaluator). |

`each`/`flatmap`/`map` take the function **first**, matching `map`.

### 4.4 Builtin effects

These are pre-declared like user effects and invoked with `perform`. With no
user handler, the runtime interprets them at the top level (real I/O); a user
`handle` can intercept any of them.

| Effect     | Signature                  | Default behaviour |
|------------|----------------------------|--------------------|
| `Read`     | `(path: string): string`   | `readFileSync` the path. |
| `Write`    | `(path: string, content: string): unit` | `writeFileSync` the path. |
| `Println`  | `(v: any): unit`           | `console.log(show(v))` — print a value + newline. |
| `Out`      | `(s: string): unit`        | `process.stdout.write(s)` — raw string, no newline. |

```js
// Println is an ordinary effect: a handler can capture it instead of printing.
handle {
  perform Println(42);
  perform Println("hi");
  0
} case Return(v) => k { [v] }
  case Println(x) => k { concat([x], k(unit)) }
// [42, "hi", 0]
```

## 5. Semantics

- **Evaluation is in continuation-passing style.** `evalE(e, env, k)` either
  calls `k(v)` with a value or produces an `Outcome` describing a trapped
  effect.
- **Effects.** `perform Op(args)` searches outward for a handler whose cases
  include `Op`. On a match, the handler runs with the effect's arguments bound
  and `k` set to a closure capturing the suspended computation; calling
  `k(v)` resumes the body with `v`. On no match, evaluation fails.
- **Multi-shot resume.** `k` is an ordinary JS function, so it can be invoked
  many times — each call re-runs the continuation from the perform point.
  This enables nondeterminism, backtracking, etc.
- **Deep handlers.** The `Return` case sees the body's final value; effect
  cases see the perform site and can resume or not. Effects performed inside a
  handler case propagate outward to the next handler.

## 6. The `run` / `show` / `typeOf` API

`index.ts` exports three functions:

```ts
function run(src: string): Value;      // typecheck then evaluate; throws on type error
function show(v: Value): string;       // pretty-print a value
function typeOf(src: string): string;  // inferred type of the last expression, e.g. "(int) -> int ! { Emit }"
```

A type error is a thrown `Error` whose message contains the mismatch (e.g.
`int ≠ string`, `arity 1 ≠ 2`, `Unknown effect Nope`, `effect Emit not
declared in signature`).

## 7. Examples

### Nondeterminism (multi-shot resume)

```js
effect Choose(opts: [int]): int;
handle {
  let x = perform Choose([1, 2, 3]);
  let y = perform Choose([10, 20]);
  [x, y]
} case Return(v) => k { [v] }
  case Choose(opts) => k { flat(map(k, opts)) }
// [[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]
```

### Exceptions (non-resuming handler)

```js
effect Div(a: int, b: int): int;
handle {
  let r = perform Div(10, 0);
  [r]
} case Div(a, b) => k {
  if (b == 0) { ["div by zero"] } else { k(a / b) }
}
// ["div by zero"]
```

### Threading a log across resumes

```js
effect Log(msg: int): unit;
effect Result(v: int): unit;
handle {
  perform Log(1);
  perform Log(2);
  perform Result(42)
} case Log(msg) => k { concat([msg], k(unit)) }
  case Result(v) => k { [v] }
// [1, 2, 42]
```

### Effect propagation through nested handlers

```js
effect Emit(m: string): unit;
effect Other(m: string): unit;
handle {
  handle { perform Emit("hi") } case Other(m) => k { ["should-not-match"] }
} case Emit(m) => k { [m] }
// ["hi"]
```

### Recursion with a typed signature

```js
fn fact(n: int): int {
  if (n == 0) { 1 } else { n * fact(n - 1) }
}
fact(5)
// 120
```

### Short-circuit and an effectful signature

```js
effect Emit(m: int): int;
fn ask(n: int): int ! { Emit } { perform Emit(n) }
ask
// typeOf → "(int) -> int ! { Emit }"
```

### Builtin effects (default handler does real I/O)

```js
// Write then read; with no user handler, the runtime performs real I/O.
perform Write("hello.txt", "hello ef");
perform Read("hello.txt")
// → "hello ef"
```

```js
// A user handler can intercept Read to mock the filesystem.
handle {
  perform Read("anything")
} case Return(v) => k { [v] }
  case Read(path) => k { ["mocked"] }
// → ["mocked"]
```

## 8. CLI

`cli.ts` is a thin runner:

```
ef run <file> [args...]   # typecheck then evaluate; extra args reach `args()`
```

The result of the last expression is printed via `show` unless the program
calls `exit` itself. Programs that loop forever (animations) run until killed.

## 9. Examples on disk

- `examples/newton.ef` — Newton's method square root (`while` + assignment).
- `examples/tco.ef` — tail vs. non-tail recursion depth probe.
- `examples/star.ef` — rotating 3D star polygon (port of `ink/samples/star.ink`).
  Run: `ef run examples/star.ef <vertices> <step>` where `0 < step < vertices/2`.
