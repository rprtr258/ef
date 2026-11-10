# Tuples in STL

## Overview
Tuples provide a way to group multiple values of different types into a single compound value. They are fixed-length, heterogeneous, and mutable via direct element access. Tuples enable multiple function return values and serve as the foundation for function types and other features. In WASM, tuples are compiled to structs for efficient storage and access.

## Syntax

### Tuple Types
- Empty tuple: `[]`
- Single-element tuple: `[T]`
- Multi-element tuple: `[T1, T2, ..., Tn]`
- Named tuple: `[fieldName: T, ...]` (all fields named or none)

Examples:
```
[]                      # Empty tuple type
[i32]                   # Single i32
[i32, f64]              # i32 and f64
[id: i64, name: string] # Named tuple with fields
```

### Tuple Literals
- Empty tuple: `[]`
- Single-element tuple: `[value]`
- Multi-element tuple: `[v1, v2, ..., vn]`
- Named tuple: `[fieldName = value, ...]` (all fields named or none)

Examples:
```
[]                             # Empty tuple
[42i32]                        # Single element
[42i32, 3.14f64]               # Multiple elements
[id = 42i64, name = "hello"]   # Named tuple literal
```

### Tuple Access
- Access by index: `tuple.0`, `tuple.1`, ..., `tuple.10`, etc.
- Access by field name: `tuple.fieldName` (for named tuples; numeric indices not allowed).
- Nested access: `tuple.0.1` for nested tuples.

Examples:
```
t : [i32, f64] = [42i32, 3.14f64];
x : i32 = t.0;     # 42
y : f64 = t.1;     # 3.14

user : [id: i64, name: string] = [id = 42i64, name = "hello"];
id : i64 = user.id;
name : string = user.name;
```

### Mutation
Tuples are mutable via direct assignment:
```
t.0 = 100i32;  # Assign to first element
```

## Semantics

### Type System
Tuples extend the type system with a new kind: `{kind: "tuple", elements: Type[]}`. Types must match exactly in element count and types. No subtyping or variance.

### Construction and Assignment
Literals construct tuples. Assignments to tuple variables require matching types.

### Access and Mutation
Index-based access (compile-time bounds checking). Mutation directly updates elements.

### Function Integration
- **Returns:** Tuples enable multiple values: `fn f(): [i32, f64] { return [1i32, 2.0f64]; }`. Nested tuples flatten to a flat list of WASM result types.
- **Types:** Function types as tuples: `f : [[i32, f64], [i32, f64]]` for `(i32, f64) -> (i32, f64)`.

### Edge Cases
- Empty tuples: Unit type.
- Bounds: Compile-time check for known indices; runtime error otherwise.
- Nesting: Full support with chained access.

## Compilation to WASM
Tuples are compiled by flattening: each tuple element becomes a separate WASM value. This means a tuple type `[T1, T2, ..., Tn]` is represented as `n` consecutive WASM parameters, locals, or results (each of the appropriate primitive type). Named tuples lose their field names after the type‑checking phase.

### Flattening
- Empty tuple: no WASM values.
- Single‑element tuple: a single value of the mapped primitive type.
- Multi‑element tuple: each element is mapped independently; nested tuples are flattened recursively.
- Function returns: a function returning a tuple yields multiple WASM `result` types.

### Access Compilation
- **Reading:** `tuple.0` loads the first flattened local (or parameter) corresponding to that element.
- **Writing:** `tuple.0 = val` stores to the appropriate flattened local.
- Nested accesses are resolved to the correct flattened index.

### Example
A tuple `[i32, f64]` is represented as two separate values (an `i32` and an `f64`). A variable `pair : [i32, f64]` becomes two locals `$pair_0` (i32) and `$pair_1` (f64). Access `pair.0` compiles to `(local.get $pair_0)`.

## Examples
```
pair : [i32, f64] = [1i32, 2.0f64];
pair.0 = 10i32;
x : i32 = pair.0;

fn swap(a : i32, b : i32): [i32, i32] {
  return [b, a];
}
res : [i32, i32] = swap(1i32, 2i32);
```

## Named Tuples (Structs)

Named tuples provide field names for tuple elements, enabling struct-like syntax.

### Named Tuple Types
- Syntax: `[fieldName: Type, ...]` where all fields must be named.
- Examples: `[id: i64, name: string]`, `[]` (empty), `[x: i32]` (single).
- Type equality is nominal: field names matter
  - `[id: i32]` and `[name: string]` are different types
  - `[id: i32, name: string]` and `[name: string]` are different types
  - `[id: i32, name: string]` and `[name: string, id: i32]` are same type (field order does not matter)

### Named Tuple Literals
- Syntax: `[fieldName = value, ...]` matching the field order of the type.
- Examples: `[id = 42i64, name = "hello"]`, `[x = 1i32]`.
- Mixing named and unnamed fields is not allowed.

### Field Access
- Dot syntax with field names: `user.id`, `user.name`, `user.address.city`.

### Lowering
Named tuples are lowered to regular tuples after type checking:
- Field names are stripped from tuple types and literals.
- Field name accesses are resolved to numeric indices.
- The resulting WAT output is identical to regular tuples.

## Implementation Notes
- **AST Changes:** Add `TupleType`, `TupleLiteral`, `TupleAccess` to AST.
- **Parser:** Extend for `[`, `]`, `.digit`.
- **Type Checker:** Add tuple validation.
- **Compiler:** Generate WASM flattening, get/set ops, flatten returns.
- **Tests:** Parsing, type checking, WAT output.
