# Language spec

This is the complete specification of the ef language: lexical structure,
syntax, types, builtins, and semantics. Every part of it is enforced by
self-checks and tests — the test suite is the executable form of this spec.
CLI usage lives in [CLI & REPL](cli.md); linting in [Linter](lint.md).

**Contents:** [1. Lexical structure](#1-lexical-structure) ·
[2. Syntax](#2-syntax) · [3. Types](#3-types) · [4. Builtins](#4-builtins) ·
[5. Semantics](#5-semantics) · [6. Examples](#6-examples) ·
[7. Examples on disk](#7-examples-on-disk)

## 1. Lexical structure

- **Whitespace** (space, tab, CR, LF) is insignificant.
- **Line comments** with `#` run to end of line.
- **String literals** are `"..."` with `\` escapes: `\n \t \r \" \\ \xHH` (byte),
  `\uHHHH` (code point). Unknown `\c` yields `c`.
- **Number literals** are non-negative integer/decimal digit runs (e.g. `42`,
  `3.14`). A literal containing a `.` is an untyped float; otherwise an
  untyped int. Untyped literals take on whatever numeric context demands and
  default to `f64` / `i64` (see §3.1). Unary minus is parsed as the unary
  `-` operator in `parseUnary`.
- **Identifiers** start with a letter or `_`, continue with letters/digits/`_`.
- **Keywords:** `fn if else while handle case true false unit effect`.
- **Two-char tokens:** `:: := == != <= >= && || =>` (`::`/`:=` are the declaration operators, lexed before `:`).
- **One-char tokens:** `( ) [ ] { } , ; < > + - * / ! = : % @`.
- `->` is lexed as two tokens `-` `>` and reassembled by the type parser.

## 2. Syntax

### 2.1 Programs

A program is a sequence of **items**, each an expression statement, an
effect declaration, or a type alias:

```
program  ::= item*
item     ::= effect-decl | type-alias | stmt
effect-decl ::= "effect" name params ":" type ";"
type-alias ::= name "::" type ";"
             | name "::" "fn" "(" (name ":" "type" ("," name ":" "type")*)? ")"
                 ":" "type" "{" type "}" ";"    -- see §3.1
type     ::= ...                               -- "type" is the type of types
stmt     ::= decl | assign | expr (";" | blocky)
```

The value of a program is the value of its last expression statement. Type
aliases and effect declarations are not expressions and produce no value.

### 2.2 Declarations

```
decl      ::= name (":=" expr | "::" expr | ":" type ("=" expr | "::" expr)) ";"
            | tuple-pattern (":=" | "::") expr ";"
tuple-pattern ::= "[" (name (":" type)? ("," name (":" type)?)*)? "]"
params    ::= "(" (name (":" type)? ("," name (":" type)?)* )? ")"
eff-annot ::= "!" "{" name ("," name)* "}"
block     ::= "{" stmt* "}"
```

There are two binding kinds:

- `name := e;` — a **mutable variable** (inferred type).
- `name :: e;` — a **const** (inferred type). Function declarations are
  consts: `f :: fn(...) { ... }`.
- An optional `: T` annotation precedes the initializer operator:
  `name: T = e;` is a mutable variable of type `T`, `name: T :: e;` a const
  of type `T`.
- Destructuring: `[a, b] := e;` / `[a, b] :: e;` binds each name to the
  corresponding tuple/array element, with optional per-field `: type`
  annotations.
- Consts are immutable: `name = e;` on a `::` binding is a compile-time type
  error (`cannot assign to const 'name'`). Mutable bindings and lambda
  parameters can be assigned.
- Bindings are recursive: the name is in scope in its own value, so
  `f :: fn(...) { ... }` can call itself.
- **No shadowing**: every name is bound exactly once in its visible scope
  chain. A compile-time type error results from redeclaring a name in the
  same frame (`x := 1; x :: 2;`), hiding an enclosing binding from an inner
  frame (lambda body, handler case, or parameter list), or binding any
  builtin name (`len`, `map`, `PI`, the operator `neg`, ...). Lambda
  parameters, destructure fields, and handler binders follow the same rule,
  duplicates within one list included. The wildcard `_` is exempt (it
  discards and may repeat). Effect declarations are a separate namespace, so
  a binding named like an effect op (`Out`) is legal and `Out!` is
  unaffected. The REPL checks each line against everything bound so far.
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
           | name | "(" expr ")" | array | lambda | if | handle | as-expr
as-expr  ::= "@as" "(" expr "," type ")"    # numeric cast, see §3.1
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
  **type annotation** on the binding (`p: [f64, f64] = [1.0, 2.0]`)
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

  | Prec | Operators |
  |------|-----------|
  | 1    | `\|\|`    |
  | 2    | `&&`      |
  | 3    | `== !=`   |
  | 4    | `< > <= >=` |
  | 5    | `+ -`     |
  | 6    | `* / %`   |

  All operators are left-associative.

### 2.4 Effects and handlers

A **statement** is an expression used for its side effect. Inside a block, a
bare `name = expr` is an **assignment**: it updates the nearest enclosing
binding of `name` (which must already exist and be mutable — a `:=`/`: T =`
declaration or a lambda parameter; assigning to a `::` const is rejected at
check time) and yields `unit` — the mutation primitive that makes `while`
useful.

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
         | name ("(" type ("," type)* ")")?    -- alias instantiation
         | "i32" | "i64" | "u32" | "u64" | "f32" | "f64"
         | "string" | "bool" | "unit" | "any"
tup-field ::= (name ":")? type               -- named (`x: f64`) or unnamed
```

- `i32 i64 u32 u64 f32 f64` — the six **numeric widths**. `string`, `bool`,
  `unit` are the other primitives.
  - **Arithmetic is strict per width**: both operands of a numeric op must
    have the same width; `i32 + i64` is a type error. Comparisons and
    equality likewise require equal widths.
  - **Untyped literals flex**: a num literal (`1`, `1.5`) carries an
    internal untyped-int / untyped-float type that accepts any numeric (resp.
    float) context; unconstrained it defaults to `i64` / `f64`. So
    `x: i32 = 1` works, `sqrt(100)` works, but `x: i32 = 1.5` is
    rejected (a float literal never narrows to an int width).
  - **@as(expr, T)** is the one explicit conversion between widths (and from
    `bool`): float → int truncates toward zero, bool → numeric gives `0/1`,
    every other conversion preserves the value. `@as` targets must be one of
    the six widths.
  - **Runtime semantics (width-exact in both backends)**: `f32` values round
    to f32 precision after every producing step
    (`0.1f32 + 0.2f32 == 0.30000001192092896`); integer widths **wrap around**
    like wasm's arithmetic (`i32`/`u32` mod 2^32, `i64`/`u64` mod 2^64 —
    `2147483647i32 + 1 == -2147483648`, `u32`/`u64` hold unsigned ranges);
    `i64`/`u64` values are **exact beyond 2^53** — the interpreter represents
    them as BigInt (and BigInt values flowing through the wasm host boundary
    are exact too). Integer `/` and `%` **trap** on division by zero, and `/`
    additionally traps on `INT_MIN / -1` (signed overflow), matching wasm's
    `div_s`/`div_u` traps; float division by zero is not a trap
    (`1.0 / 0.0 == Infinity`).
  - **Widths must be static where values are computed**: arithmetic on
    `any`-typed operands is a type error (`any is not a numeric width`) —
    pin the width with `@as` first. Equality (`==`/`!=`) on `any` stays
    allowed. A generalized lambda (a `::`/`:=` binding whose value is a
    lambda) whose body performs numeric ops on an
    **unannotated** parameter is rejected (`ambiguous numeric width —
    annotate the parameter (e.g. n: i64)`): the lambda is generalized, so the
    width would flex per call site while the body fixed one. Directly-passed
    lambdas are exempt — their parameter types come from the instantiation
    (`map(fn(x) { x * x }, range(0, 4, 1))` needs no annotation).
- `[T]` — array of `T` (homogeneous). At runtime a `[T]` value is a **slice**
  — a fat pointer `{backing, offset, length}` over a shared backing array
  (§4.2); `sub` carves zero-copy views out of it.
- `[T1, ..., Tn]` — **tuple**: fixed arity, positional field types. Fields
  may be named (`[x: f64, y: f64]`) or unnamed (`[i64, string]`); names
  are for access only and ignored by unification, which compares arity and
  positional types. `[T]` (one element, no comma) is an array, not a 1-tuple.
- Aliases are declared without a keyword, in two forms (both are top-level
  items, not statements):
  - `Name :: T;` — a **nullary alias**: `V2 :: [f32, f32];` or `s32 :: i32;`.
  - `Name :: fn(p1: type, ..., pn: type): type { T };` — a **parametric type
    alias**: a type-level function over its parameters. Use it as
    `Name(A1, ..., An)`; the body `T` is substituted with the arguments at
    parse time. Alias params are type variables scoped to the body (their
    annotation is `type`, the type of types — nothing inhabits `type` at
    term level, so a type-level fn is never a callable value). Recursive
    aliases are not supported.
  Disambiguation from the `name :: expr;` const binding is type-first: a
  top-level `name :: X;` is an alias iff `X` parses as a type up to the
  `;` (brackets, fn types, bare names that resolve as types, alias
  applications). Anything else stays a const binding — `y :: x;` over a
  value variable binds the value. A name that is both a value variable and
  an alias: `y :: V2;` declares an alias; copy the value with `y := V2;`. A
  term lambda all of whose params and return are `: type` is claimed as an
  alias, since no such term function could ever be called.
- `(T1, ..., Tn) -> R` — function type. The optional `! { E1, ..., En }` is
  its **effect set**: the effects the function may perform. Empty/omitted =
  pure.
- `any` — absorbing type. Unifies with anything and stays `any`. Because `any`
  is an escape hatch, the checker **warns** when a binding's
  *inferred* type contains `any` (e.g. `f :: list` infers `(any) -> [any]`);
  writing an explicit annotation (`f: (any) -> [any] :: list`) silences the
  warning. Array literals like `[1,2,3]` are special-cased to `[i64]` and do
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

- `num` : untyped int / untyped float (by whether the literal has a `.`); each accepts any numeric (resp. float) context and defaults to `i64`/`f64`. `str : string`, `bool : bool`, `unit : unit`.
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
- `x := e` / `x :: e` — `e`'s type (with an optional `: T` annotation:
  `T` unifies with `infer(e)`). When `T` is a tuple and `e` is a bracket
  literal, the literal is typed as that tuple.
- `[a, b] := e` — `e : [Ta, Tb]` (tuple) or `[T]` (array, each field `: T`);
  binds `a, b` to the element types.
- `e.x` / `e.0` — `e` must be a tuple (`[x: T, ...]` or `[T, ...]`) or an array.
  For a named tuple field, `.name` resolves to its position; `.N` indexes by
  position. For an array, `.N` indexes element `N`.
- `if c { a } else { b } : T` where `c : bool` and `a, b : T` (branches must
  agree). `if` with no `else` has an implicit `unit` else branch.
- `f(a1, ..., an)` — `f : (T1,...,Tn) -> R ! {E}`, each `ai : Ti`, the call has type `R` and adds `E` to the caller's effects. Mismatched arity or argument types are errors.
- **Effect rows are unified, not just propagated.** A function's `! { ... }` is a row: a concrete set of effect names, or an unbound *effect variable*. Two function types unify their effect rows by union-find: variable+variable unions, variable+set binds, set+set requires equality. The empty set `∅` is the polymorphic bottom — a function typed `... ! ∅` may be used wherever any effect set is expected (it is refined to the other set) — so unannotated higher-order parameters stay flexible without let-generalization.
- **Higher-order builtins are effect-polymorphic.** `map : ((a) -> b ! e, [a]) -> [b] ! e`, `each : ((a, i64) -> b ! e, [a]) -> unit ! e`, `flatmap : ((a, i64) -> [b] ! e, [a]) -> [b] ! e` — each with a fresh effect variable `e` per instantiation, shared between the callback's effect row and the call's performed effects. So `map(pureF, xs)` performs `∅` while `map(fn(x){ Out!(x); x }, xs)` performs exactly `{ Out }` — neither over- nor under-approximated.
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

- User `::`/`:=` bindings of a **lambda value** are **generalized** (HM
  let-generalization, value-restricted): type/effect variables not free in the
  surrounding environment are abstracted, and each use instantiates fresh
  copies. So `apply :: fn (f, x) { f(x) }` gets `apply : ((a) -> b ! e, a) -> b ! e`
  and one definition works at many types in the same program.
- **Value restriction:** only lambda RHS are generalized. Literals carry no
  type variables (generalization is a no-op), and bracket literals are typed
  directly (arrays via homogenization, tuples positionally — non-values), so
  they stay monomorphic — this keeps mutable arrays (`set`) and mutable
  variables (`assign`) sound (no `xs := []` typed `[a]` that any element type
  could flow into).
- Bindings with an explicit `: type` annotation are monomorphic (the
  annotation fixes the type).
- Builtins `map`, `sub`, `concat`, `flat`, `len` are polymorphic via
  **scheme thunks** in the type environment: each lookup produces a fresh copy
  with fresh type variables.

## 4. Builtins

### 4.1 Operators (binary)

| Operator | Type | Notes |
|----------|------|-------|
| `- * / %` | `(T, T) -> T` for each width `T` | strict same-width; `@as` converts. |
| `+` | `(T, T) -> T` / `(string, string) -> string` | overloaded: numeric (strict same-width, untyped literals flex), or string concatenation. Mixed `"a" + 1` is a type error. |
| `< > <= >=` | `(T, T) -> bool` per numeric width `T` | strict same-width operands. |
| `== !=` | `(T, T) -> bool` | Both operands must share a type `T` (untyped literals flex, concrete widths are strict — `i32 == i64` is an error); cross-type comparisons like `"a" == 1` are rejected. Not first-class — cannot be passed as a function value. |

Unary `-` (neg) : numeric, width-preserving (`i32` in → `i32` out). Unary `!` (not) : `(bool) -> bool`.

`/` is **type-preserving and truncates toward zero** for integer widths (`7 / 2 == 3`, `-7 / 2 == -3`); float division is exact (`7.0 / 2.0 == 3.5`).
The type checker stamps each `/` node as integer or float division at check time, and every numeric node with its result width — the runtime computes per width (BigInt for `i64`/`u64`, wrap/round per width otherwise) and traps on integer division by zero and `INT_MIN / -1` (§3.1 runtime semantics).

### 4.2 Functions

| Name | Type (schematic) | Notes |
|------|------------------|-------|
| `list` | `(any) -> [any]` | Variadic array constructor. Explicit `list(1,2,3)` is `[i64]`; bracket literals `[1,2,3]` are typed directly (array if homogeneous, else tuple). |
| `sub` | `([A], i64, i64) -> [A]` | Zero-copy view of `[from, to)`: shares the operand's backing. Errors (`sub: range [from, to) out of bounds [0, len)`) unless `0 ≤ from ≤ to ≤ len`. |
| `concat` | `([A], [A]) -> [A]` | Append; allocates a fresh backing, never aliases its operands — the only way a slice grows. |
| `flat` | `([[A]]) -> [A]` | Flatten one level. |
| `len` | `([A]) -> i64` | Array length. |
| `strlen` | `(string) -> i64` | String length. |
| `map` | `((A) -> B, [A]) -> [B]` | Apply; fresh `A`/`B` per use. |
| `get` | `([A], i64) -> A` | Array index through the view's window; indices are `i64` (untyped int literals flex). Out of bounds → `get: index i out of bounds [0, len)` (reported against the view's length). |
| `set` | `([A], i64, A) -> unit` | Index assignment: writes through the view into the shared backing — every view over the same window (and the original) sees it. Strictly in-window: it never grows (`set: index i out of bounds [0, len)` otherwise); growth is `concat`'s job only. |

**Slices.** A `[T]` value is a fat pointer `{backing array, offset, length}`
— not a plain array. Literals, `list`, `range`, `concat`, and `map`-like
builtins allocate a fresh backing (offset 0); `sub` returns a **view**
sharing the operand's backing with a shifted offset and shorter length
(zero-copy). Reads and writes go through the view's window; `==`/`!=` on
slices is reference identity. Aliasing example:

```ef
s :: [1, 2, 3, 4];
v :: sub(s, 1, 3);   # [2, 3] — shares s's backing
set(s, 1, 99);       # writes through to the shared backing
v                    # [99, 3] — the view sees the write
```
| `each` | `((A, i64) -> B, [A]) -> unit` | Iterate with index; result discarded. |
| `flatmap` | `((A, i64) -> [B], [A]) -> [B]` | Map-then-concat. |

### 4.3 Math, I/O

Console output is via the `Println`/`Out` effects (§4.4), not functions;
process control is via the `Exit`/`Wait` effects (§4.4), not functions.

| Name | Type (schematic) | Notes |
|------|------------------|-------|
| `PI` | `f64` | `Math.PI`. |
| `cos` | `(f64) -> f64` | Cosine (radians). |
| `sin` | `(f64) -> f64` | Sine (radians). |
| `abs` | `(f64) -> f64` | Absolute value. |
| `round` | `(f64) -> i64` | Round to nearest int. |
| `sqrt` | `(f64) -> f64` | Square root. |
| `range` | `(i64, i64, i64) -> [i64]` | `range(start, end, step)`: half-open; `step` may be negative. |
| `char` | `(i64) -> string` | Code point → single-char string. |
| `number` | `(string) -> f64` | Parse a string to a number. |
| `args` | `() -> [string]` | CLI args after the source file. |

`each`/`flatmap`/`map` take the function **first**, matching `map`.
(Formerly `exit`/`wait` builtins existed; they are now the `Exit`/`Wait` effects in §4.4.)

### 4.4 Builtin effects

These are pre-declared like user effects and invoked with the `!` postfix. With no user handler, the runtime interprets them at the top level (real I/O); a user `handle` can intercept any of them.

| Effect | Signature | Default behaviour |
|--------|-----------|-------------------|
| `Read` | `(path: string): string` | `readFileSync` the path. |
| `Write` | `(path: string, content: string): unit` | `writeFileSync` the path. |
| `Println` | `(v: any): unit` | `console.log(show(v))` — print a value + newline. |
| `Out` | `(s: string): unit` | `process.stdout.write(s)` — raw string, no newline. |
| `Exit` | `(code: i64): unit` | `process.exit(code)` — terminates without resuming. |
| `Wait` | `(secs: i64): unit` | Busy-wait `secs` seconds then resume with unit (synchronous evaluator). |
| `Random` | `(): f64` | Resume with a random number in [0, 1) (`Math.random()`). |

```ef
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
- **Multi-shot resume.** `k` is an ordinary JS function, so it can be invoked many times — each call re-runs the continuation from the point. This enables nondeterminism, backtracking, etc.
- **Deep handlers.** The `Return` case sees the body's final value; effect cases see the site and can resume or not. Effects performed inside a handler case propagate outward to the next handler.

## 6. Examples

### Nondeterminism (multi-shot resume)

```ef
effect Choose(opts: [i64]): i64;
handle {
  x :: Choose!([1, 2, 3]);
  y :: Choose!([10, 20]);
  [x, y]
} case Return(v) => k { [v] }
  case Choose(opts) => k { flat(map(k, opts)) }
# [[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]
```

### Tuples, aliases, and field access

```ef
Point :: fn(a: type): type {[x: a, y: a]};
p: Point(f64) = [1.0, 2.0];
[x, y] := p;
[x, p.x + p.y]
# [1, 3]
```

`Point :: fn(a: type): type {[x: a, y: a]};` declares a parametric alias;
`Point(f64)` substitutes `a = f64`. The literal `[1.0, 2.0]` is typed
against the annotated tuple `[x: f64, y: f64]`, so `p.x` and `p.y` are
`f64`. Nullary aliases skip the parameters: `V2 :: [f32, f32];` or
`s32 :: i32;`.

### Exceptions (non-resuming handler)

```ef
effect Div(a: i64, b: i64): i64;
handle {
  r :: Div!(10, 0);
  [r]
} case Div(a, b) => k {
  if (b == 0) { ["div by zero"] } else { k(a / b) }
}
# ["div by zero"]
```

### Threading a log across resumes

```ef
effect Log(msg: i64): unit;
effect Result(v: i64): unit;
handle {
  Log!(1);
  Log!(2);
  Result!(42)
} case Log(msg) => k { concat([msg], k(unit)) }
  case Result(v) => k { [v] }
# [1, 2, 42]
```

### Effect propagation through nested handlers

```ef
effect Emit(m: string): unit;
effect Other(m: string): unit;
handle {
  handle { Emit!("hi") } case Other(m) => k { ["should-not-match"] }
} case Emit(m) => k { [m] }
# ["hi"]
```

### Recursion with a typed signature

```ef
fact :: fn(n: i64): i64 {
  if (n == 0) { 1 } else { n * fact(n - 1) }
};
fact(5)
# 120
```

### Short-circuit and an effectful signature

```ef
effect Emit(m: i64): i64;
ask :: fn(n: i64): i64 ! { Emit } { Emit!(n) };
ask
# inferred type: "(i64) -> i64 ! { Emit }"
```

### Builtin effects (default handler does real I/O)

```ef
# Write then read; with no user handler, the runtime performs real I/O.
Write!("hello.txt", "hello ef");
Read!("hello.txt")
# → "hello ef"
```

```ef
# A user handler can intercept Read to mock the filesystem.
handle {
  Read!("anything")
} case Return(v) => k { [v] }
  case Read(path) => k { ["mocked"] }
# → ["mocked"]
```

## 7. Examples on disk

- `examples/newton.ef` — Newton's method square root (`while` + assignment).
- `examples/tco.ef` — recursion probe. The CPS evaluator is fully tail-call-structured, so Bun/JSC's TCO keeps the stack O(1) for both tail and non-tail calls; non-tail recursion costs heap allocation (linear time), not stack overflow. The wasm target also runs it: calls in tail position compile to `return_call_indirect` (O(1) wasm stack); each call still allocates a frame block, but the host GC reclaims them (the old linear-memory backend exhausted the heap at ~100M depth).
- `examples/star.ef` — rotating 3D star polygon (port of `ink/samples/star.ink`).
  Run: `ef run examples/star.ef <vertices> <step>` where `0 < step < vertices/2`.
- `examples/widths.ef` — the numeric-widths end-to-end probe: f32 precision at
  every producing step, per-width `@as` conversions, truncating `/`, i32/u32
  and i64/u64 wraparound (exact beyond 2^53 via BigInt), signed vs unsigned
  ordering, and the division guards. Every line prints identically under
  `ef run` and `ef runwasm` — the parity harness in the test suite pins that.
  pins it line for line.
