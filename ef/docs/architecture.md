# STL Compiler Architecture

This document describes the architecture of the STL (Simply Typed Language) compiler, which translates STL source code into WebAssembly Text (WAT). The compiler is implemented in TypeScript and runs on Bun.

## Overview

The compiler is organized as a pipeline of sequential passes, each transforming the representation of the program:

```
Source Code → Lexer → Tokens → Parser → Parser AST → Type Checker → Typed AST → Desugar → Desugared AST → Compiler → WAT
```

Each pass is implemented as a separate module, with distinct AST definitions for the output of each phase.

## Pass Details

### 1. Lexer (`lexer.ts`)

**Responsibility**: Convert source code string into a stream of tokens.

**Key functions**:
- `scanTokens(source: string, filename: string): Token[]`

**Token types** (defined in `token.ts`):
- Keywords: `fn`, `if`, `else`, `while`, `break`, `continue`, `return`
- Types: `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `bool`
- Literals: `int`, `bin`, `hex`, `float`, `true`, `false`
- Operators: `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `!`, `=`, `&`, `|`, `^`, `<<`, `>>`
- Punctuation: `(`, `)`, `{`, `}`, `[`, `]`, `,`, `;`, `:`, `::`, `.`

**Features**:
- Handles binary (`0b1010`) and hexadecimal (`0xdead`) literals with optional type suffixes (`i32`, `i64`, etc.)
- Supports floating‑point literals with optional exponent (`1.2e3`)
- Single‑line comments starting with `#`
- Tracks source location (filename, line, column) for error reporting

### 2. Parser (`parser.ts`)

**Responsibility**: Transform token stream into an abstract syntax tree (AST).

**Key functions**:
- `parse(tokens: Token[]): Program` (returns `Program` from `parser_ast.ts`)

**Parsing strategy**:
- Recursive descent for statements and declarations
- Pratt parser for expressions with configurable operator precedence
- Handles modules, function definitions, tuple types, named tuples, tuple literals, tuple access, and the built‑in `@as` cast

**AST definitions** (`parser_ast.ts`):
- `Program`: contains `modules: ModuleDecl[]` and `functions: FunctionDecl[]`
- `ModuleDecl`: describes an external module with a list of function signatures
- `FunctionDecl`: function name, argument names, type signature, and body (list of statements)
- Statements: `DeclStmt`, `AssignStmt`, `IfStmt`, `WhileStmt`, `BreakStmt`, `ContinueStmt`, `ReturnStmt`, `ExprStmt`
- Expressions: `UnaryExpr`, `BinaryExpr`, `CallExpr`, `LiteralExpr`, `IdentExpr`, `ParenExpr`, `TypeLiteralExpr`, `TupleLiteralExpr`, `TupleAccessExpr`

All nodes include a `location` field (filename, line, column) for error messages.

### 3. Type Checker (`type_checker.ts`)

**Responsibility**: Validate the program’s static semantics and annotate each expression with its type.

**Key functions**:
- `check(program: Program): Program` (returns `Program` from `type_checker_ast.ts`)

**Tasks**:
- Verifies that all variables are declared before use
- Ensures function calls match the expected signature (argument count and types)
- Checks that operators are applied to compatible types (e.g., arithmetic only on numeric types)
- Validates that `break`/`continue` appear only inside loops
- Ensures the `main` function exists, has no parameters, and returns `i32`
- Resolves named tuple field names to numeric indices
- Annotates every expression with a `type` field (from `types.ts`)

**Type definitions** (`types.ts`):
- `PrimitiveType`: `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `bool`
- `TupleType`: heterogeneous fixed‑length list of types
- `NamedTupleType`: tuple with field names (order‑insensitive)
- `FunctionType`: argument‑type list and return type

**Output AST** (`type_checker_ast.ts`):
Same structure as the parser AST, but with a `type` field added to every expression node.

### 4. Desugar (`desugar.ts`)

**Responsibility**: Simplify the typed AST by removing high‑level constructs that are not directly representable in WebAssembly.

**Key functions**:
- `desugar(program: Program): Program` (returns `Program` from `desugar_ast.ts`)

**Transformations**:
- Strips field names from named tuples, converting them to plain tuples
- Flattens nested tuple types into a flat list of primitive types (e.g., `[i32, [f64, bool]]` becomes `[i32, f64, bool]`)
- Resolves all tuple accesses to numeric indices

**Rationale**:
WebAssembly does not have a built‑in tuple type; tuples are represented as multiple stack values. Flattening simplifies code generation and ensures each value is individually addressable.

**Output AST** (`desugar_ast.ts`):
- `TupleType` only contains primitive elements (no nested tuples)
- Named tuples and field names are eliminated
- `TupleAccessExpr.index` is always a number

### 5. Compiler (`compiler.ts`)

**Responsibility**: Generate WebAssembly Text (WAT) from the desugared AST.

**Key functions**:
- `compile(program: Program): string` (returns a complete WAT module as a string)

**Type mapping**:
- `i32` → `i32`
- `u32` → `i32` (same representation, different semantics)
- `i64` → `i64`
- `u64` → `i64`
- `f32` → `f32`
- `f64` → `f64`
- `bool` → `i32` (`0`/`1`)
- Tuples are flattened; each element becomes a separate WASM value (multiple `result`/`param`/`local` entries)

**Code generation**:
- Functions become `(func …)` definitions; `main` is exported as `"main"`
- External module functions become `(func … (import …))`
- Local variables are mapped to WASM locals (tuples become multiple locals)
- Control‑flow constructs map directly to WASM `if`/`else`, `loop`, `block`, `br`
- Binary/unary operators map to the corresponding WASM instructions (e.g., `i32.add`, `f64.eq`)
- The `@as` built‑in generates appropriate conversion instructions (`i32.wrap_i64`, `f64.promote_f32`, etc.)

**Output**: A valid WAT module that can be assembled to WebAssembly bytecode with tools like `wat2wasm`.

## Supporting Files

### `errors.ts`
Custom error classes (`LexerError`, `ParserError`, `TypeCheckerError`, `CompilerError`) that carry location information for user‑friendly error reporting.

### `utils.ts`
Utility functions, notably `assertNever` for exhaustive switch‑case checks.

### `cli.ts` & `main.ts`
Command‑line interface built with `citty`. Supports `compile` (STL → WAT) and `run` (STL → WASM → execution).

### `playground/`
Vue.js web application that embeds the compiler and provides an interactive editing environment. Uses CodeMirror for code editing and displays the generated WAT.

## Build and Test

- **Build**: `bun run build` (compiles TypeScript in the `compiler/` directory)
- **Test**: `bun test` (runs all unit tests)
- **Lint**: `bun run lint` (runs ESLint)
- **CI**: `bun run ci` (build + lint + test)

Tests are co‑located with source files (`*.test.ts`) and use Bun’s built‑in test runner. Test data (`.stl` and `.wat` files) resides in `compiler/src/compiler.testdata/`.

## Future Extensions

The multi‑pass architecture makes it straightforward to add new transformations or optimizations. Possible extensions include:

- An interpreter (additional pass that evaluates the AST directly)
- More sophisticated type inference (e.g., generic functions)
- Intermediate representation (IR) for optimizations
- Additional backends (e.g., native code via LLVM)

Each new pass can be inserted into the pipeline without disrupting existing functionality.