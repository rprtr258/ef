# Parser

`new Parser(src).parseProgram(): Program` where
`Program = {nodes: Expr[], items: Item[]}`. Recursive descent for structure,
**Pratt parsing for infix** (precedence table below).

## The flat node slice

The AST is not a tree of embedded nodes. Every expression is one element of
`Program.nodes`; children are referenced by `ExprID` — a plain index into that
array. Parsing `x :: 41 + 1;` produces:

<svg class="dgm" viewBox="0 0 720 170" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="flat node slice">
  <defs>
    <marker id="arrp" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>
  <text x="16" y="24" class="faint">Program.nodes</text>
  <rect class="box" x="16"  y="34" width="100" height="52" rx="8"/>
  <text x="66"  y="55" text-anchor="middle">let x</text>
  <text x="66"  y="71" text-anchor="middle" class="faint">val: 4</text>
  <rect class="box" x="142" y="34" width="100" height="52" rx="8"/>
  <text x="192" y="55" text-anchor="middle">num 41</text>
  <rect class="box" x="268" y="34" width="100" height="52" rx="8"/>
  <text x="318" y="55" text-anchor="middle">num 1</text>
  <rect class="box" x="394" y="34" width="100" height="52" rx="8"/>
  <text x="444" y="55" text-anchor="middle">sym +</text>
  <rect class="box acc" x="520" y="34" width="100" height="52" rx="8"/>
  <text x="570" y="55" text-anchor="middle">app +</text>
  <text x="570" y="71" text-anchor="middle" class="faint">fn:3 args:1,2</text>
  <text x="16"  y="27" class="faint">0</text>
  <text x="142" y="27" class="faint">1</text>
  <text x="268" y="27" class="faint">2</text>
  <text x="394" y="27" class="faint">3</text>
  <text x="520" y="27" class="faint">4</text>
  <path class="arrow" marker-end="url(#arrp)" d="M490 86 V104 H444 V90"/>
  <path class="arrow" marker-end="url(#arrp)" d="M506 86 V122 H318 V90"/>
  <path class="arrow" marker-end="url(#arrp)" d="M522 86 V140 H192 V90"/>
  <text x="16" y="162" class="faint">a node is just an index — children live in the same array</text>
</svg>

Why flat instead of embedded:

| Consumer | What the `ExprID` buys |
|----------|------------------------|
| Type checker | stamps types on nodes after the fact (`nodeTypes`, `numKind`, `div`, `idx`, `asKind`) — impossible in an immutable tree |
| Wasm backend | scopes, code labels and split sites keyed by `ExprID` |
| Closures | a closure carries its own `nodes` slice, so it stays valid across REPL lines and separate programs |
| Walks | `exprChildren(id, nodes)` gives uniform traversal for every pass (checker, analysis, lint, wasm) |

## Grammar strategy

| Construct | Strategy |
|-----------|----------|
| Binary operators | Pratt loop over the `PREC` table, left-associative |
| Unary `-` / `!` | desugar to calls: `-e` → `app(sym neg, [e])`, `!e` → `app(sym not, [e])` — the checker sees ordinary calls of builtins named `neg`/`not` |
| `&&` / `\|\|` | desugar to `if` — short-circuit falls out for free |
| Calls, field access | postfix loop: `f(a)(b).x.0` parses as successive accesses |
| Everything else | recursive descent |

## Node kinds

| Variant | Source | Notes |
|---------|--------|-------|
| `num` | `1`, `1.5` | `isFloat` decides the untyped int/float wildcard; checker stamps `numKind` with the resolved width |
| `str` · `bool` · `unit` | literals | escapes decoded here (`parseStr`) |
| `sym` | names | variable references and desugared operator names |
| `lambda` | `fn (p) { … }` | optional `: R` / `! { Effs }` annotations; checker adds `unannParams`/`numTouched` for the width-ambiguity rule |
| `let` | `x := e;` `x :: e;` `x: T = e;` | `mut` distinguishes `:=` from `::` |
| `dlet` | `[a, b] := e;` | destructuring bind with optional per-field annotations |
| `assign` | `x = e;` | mutation of an existing mutable binding |
| `if` · `while` · `block` | control flow | `&&`/`\|\|` desugar into `if` |
| `perform` | `Op!(args)` | name + arg nodes |
| `handle` | `handle { … } case …` | body + `HandlerCase[]` (`op`, `params`, `resume`, `body`) |
| `app` | `f(x)` | checker stamps `div`/`numKind` on operator applications |
| `as` | `@as(e, T)` | checker stamps `asKind` (`trunc` vs `boolnum`) |
| `arr` | `[a, b, c]` | array if homogeneous, tuple if heterogeneous — decided by the *checker* |
| `field` | `e.x` / `e.0` | checker resolves `idx` |

## Items

| Item | Source | Notes |
|------|--------|-------|
| `{e}` | expression statement | the program's value is the last one |
| `{effect, sig}` | `effect Op(p): ret;` | the only way `Op!` becomes legal (see [Type checker](types.md)) |
| `{alias}` | `type Pair(a, b) = [a, b];` | parametric type alias |

## Aliases and parser-allocated type variables

Aliases are registered top-down as `type` items are parsed; a
`typeParamStack` lets an alias body reference its own parameters as type
variables (`type Pair(a, b) = [a, b]`).

Type variables allocated by the *parser* (alias parameters, and arguments
omitted from a parametric alias use) live in a **negative id space**, so they
never collide with a checker `Unifier`'s ids — the unifier treats unknown ids
as their own root, so such variables behave as ordinary unbound variables.
Alias instantiation (`instantiateAlias`) is pure substitution — no unifier
involved. Recursive aliases are not supported (a recursive alias would
stack-loop the substitution).

## Errors

Parsing throws `Error` with messages like `` Expected ";", got "}" `` — token
positions come from the lexer, so later phases can attach real line/col
information.

Next: [Type checker](types.md).
