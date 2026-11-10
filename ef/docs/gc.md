# **Complete STL Specification: GC-Based Memory Allocation**

## **1. Overview**

STL is extended with garbage-collected memory allocation using WebAssembly GC reference types. The language now uses **only the GC heap**; linear memory operations are removed entirely. Key features:

- **Heap-allocated structs** (named tuples become reference types)
- **GC slices** (abstraction over WASM `arrayref` with length and capacity)
- **Typed pointers** (`Ptr(T)`) representing references to GC objects
- **Reference equality** via `==` operator
- **Automatic garbage collection** via WASM GC instructions
- **No pointer arithmetic** (simplified semantics)
- **Expression-based indexing** via `.(expr)` syntax

## **2. Type System**

### **Core Types** (`types.ts` extensions)
PointerType: For primitive T, internal rep as i31ref (ints) or ref struct (others).

```typescript
type Type = PrimitiveType | TupleType | NamedTupleType | PointerType | SliceType;

type PointerType = {
  kind: "pointer";
  elementType: Type;  // T in Ptr(T)
};

type SliceType = {
  kind: "slice";
  elementType: Type;  // Element type T
};

// NamedTupleType is now a heap-allocated struct (reference type)
type NamedTupleType = {
  kind: "named_tuple";
  elements: Type[];
  fieldNames: string[];
  // Semantic: reference type (structref)
};
```

### **Type Constructors** (compile-time)

- `@Ptr(T)` - returns pointer type to `T`
- `@slice(T)` - returns slice of `T` elements

**Note**: `@RawPointer` is **removed**. No pointer arithmetic supported.

### **Nullability**

All pointer and reference types are nullable:
- `@null(T)` represents a null reference of type `Ptr(T)`
- Null checks use `ref.is_null` instruction

## **3. Semantic Changes**

### **Named Tuples → Heap-Allocated Structs**

**Breaking change**: All named tuples allocate on GC heap:
- Named tuple literal `[field: value, ...]` compiles to `struct.new`
- Field access `x.field` compiles to `struct.get`
- Assignment `x.field = value` compiles to `struct.set`
- **No flattening** in desugaring phase
- Allow .& on primitives via boxing.

### **No Linear Memory**

All memory operations use GC heap only:
- No `memory.grow`, `memory.size`, `memory.fill`, etc.
- No linear memory imports/exports
- All data lives in GC-managed objects

## **4. Slice Design**

### **Slice Internal Representation**

Internally (not user-visible), slices are represented as:
```typescript
// Internal structure (desugared representation)
type InternalSlice(T) = [
  data: arrayref T,  // WASM arrayref (not exposed)
  len: i32,
  cap: i32
]
```

### **User-Visible Slice Interface**

**Fields** (read-only, accessed via dot syntax):
- `slice.len: i32` - current length (number of elements)
- `slice.cap: i32` - capacity (allocated storage)
- **No `data` field** exposed to users (implementation detail)

**Element access** via extended tuple access syntax (see Section 5)

### **Slice Builtins**

| Builtin | Signature | Description |
|---------|-----------|-------------|
| `@slice.make(T)` | `→ @slice(T)` | Creates empty slice of type `T` with `len=0`, `cap=0`, `data=null` |
| `@slice.append(slice, element)` | `(@slice(T), T) → @slice(T)` | Appends element to slice, may reallocate using **doubling strategy** |
| `@slice.sub(slice, start, length)` | `(@slice(T), i32, i32) → @slice(T)` | Returns new subslice (shares underlying array) |

**Slice Growth Strategy**:
- When `@slice.append` is called and `len == cap`:
  - If `cap == 0`: allocate new array with capacity 1
  - Otherwise: allocate new array with capacity `max(1, 2 * cap)`
  - Copy existing elements to new array
  - Update slice's `data`, `len`, and `cap` fields

**Bounds Checking**:
- `@slice.sub` validates `0 ≤ start ≤ start+length ≤ slice.len`
- Element access `slice.(index)` validates `0 ≤ index < slice.len`

## **5. Extended Tuple/Access Syntax**

### **Current Syntax** (unchanged)
- `tuple.0` - numeric index (constant integer)
- `tuple.field` - field name (string)

### **New Expression-based Access**
```stl
// Constant integer (existing)
slice.3              // Access 3rd element

// Expression in parentheses (NEW)
slice.(i)            // Access i-th element (i: i32 expression)
slice.(x * height + width)  // Arbitrary expression returning i32

// Works for any tuple/struct/slice
point.(0) // Same as point.0
```

### **AST Changes**
```typescript
type TupleAccessExpr = {
  kind: "tuple_access",
  target: Expr,
  index: number | string | Expr,  // Extended to support Expr
  type: Type,
  location: Location,
};
```

### **Semantics**
- Expression must evaluate to `i32` (for numeric access) or string (for field access)
- **Runtime bounds checking** (traps on out-of-bounds)
- For slices: `slice.(index)` compiles to `array.get` on internal `arrayref`
- For structs: `struct.(field)` resolves at compile-time (field must exist)

## **6. Pointer Operations**

### **Pointer Types**
- `Ptr(T)` is a WASM reference (`ref T`)
- All pointer types are nullable (`@null(T)`)

### **Address-of Operator** (`.&`)
```stl
// On variables (reference types only)
point: Point = [x: 10, y: 20];
ptr: @Ptr(Point) = point.&;    // Reference to struct

// On slice elements
slice: @slice(i32) = ...;
elem_ptr: @Ptr(i32) = slice.(i).&;  // Reference to array element

// On primitives
field_ptr : @Ptr(i32) = point.x.&;
```
`.&` on primitive: Box to `i31ref` (ints) or `structref` (others).

**Restrictions**:
- `.&` only works on **reference types** (structs, slices, arrays)
- **Cannot take address of primitive fields** (e.g., `point.x.&` where `x: i32`)
- Rationale: WASM GC doesn't support references to primitive struct fields
- Restrictions: Removed for primitives; auto-box.

### **Dereference Operator** (`.*`)
```stl
ptr: @Ptr(i32) = ...;
value: i32 = ptr.*;  // Load from reference
```

**Semantics**:
- `ptr.*` requires `ptr: Ptr(T)`
- Returns `T` (loads value from reference)
- For struct references, returns the struct (reference)
- **Null dereference traps** (use `ref.is_null` check if needed)
- .* on Ptr(primitive int): i31.get_s/u.

### **Compilation**
- `x.&` → preserve reference (or `ref.addr` if available)
- `ptr.*` → `ref.deref` or appropriate load instruction
- **No pointer arithmetic** - `+` not allowed on pointers

## **7. Reference Equality**
- `==` and `!=` operators work for **all types**
- Compiles to appropriate equality check:
  - **Primitives**: existing WASM numeric/bool equality
  - **References**: WASM `ref.eq` (reference equality)
  - **Tuples**: element-wise equality (recursive)
- Returns `bool`
- Operands must have identical types

**Semantics**:
- **Reference equality** (same object), not structural equality
- Example: `point1 == point2` checks if they reference the same struct
- **Slice equality**: compares underlying array reference, length, and capacity

## **8. Type Checking Rules**

### **Binary Operators** (updated)
1. **Equality** (`==`, `!=`):
  - Allowed for any type
  - Returns `bool`
  - Operands must have identical types (`isTypeEqual`)

2. **Pointer arithmetic**: **removed**
  - `+` not allowed on pointer types
  - No `RawPointer` type

3. **Other operators** (`+`, `-`, `*`, `/`, `%`, `&`, `|`, `^`, `<<`, `>>`, `<`, `>`, `<=`, `>=`):
  - Unchanged (only work on primitive numeric/bool types)

### **Suffix Operators**
1. **Address-of** (`.&`):
  - Operand: expression of reference type (struct, slice, array)
  - Result: `Ptr(T)` where `T` is operand's type
  - **Error on primitive types**

2. **Dereference** (`.*`):
  - Operand: expression of type `Ptr(T)`
  - Result: `T`

### **Slice Operations Type Checking**
- `@slice.make(T)` → returns `@slice(T)`
- `@slice.append(slice, element)`:
  - `slice` must be `@slice(T)`
  - `element` must be `T`
  - Returns `@slice(T)` (may be new slice)
- `@slice.sub(slice, start, length)`:
  - `slice` must be `@slice(T)`
  - `start`, `length` must be `i32`
  - Returns `@slice(T)`

### **Tuple Access with Expression Indices**
- `tuple.(expr)` where `expr` evaluates to:
  - `i32` for numeric indexing (bounds checked at runtime)
  - `string` for field access (compile-time checked)
- For slices: index must be `i32`, bounds checked at runtime

## **9. Compilation to WASM**

### **Type Mapping**
| STL Type | WASM Type | Notes |
|----------|-----------|-------|
| `NamedTupleType` | `(struct (field type)...)` | Reference type (`structref`) |
| `@slice(T)` | `(struct (field (array T)) (field i32) (field i32))` | Internal struct with `arrayref` |
| `Ptr(T)` | `(ref T)` | Reference type |
| `@slice(T)` element | `(array T)` element | Via internal `arrayref` |

### **Instruction Generation**
| STL Construct | WASM Instruction |
|--------------|------------------|
| `[field: value, ...]` | `struct.new` |
| `x.field` | `struct.get` |
| `x.field = value` | `struct.set` |
| `x.& (int primitive)` | `i31.new` |
| `x.& (non-int primitive)` | `struct.new with field` |
| `ptr.* (Ptr(int))` | `i31.get_s / get_u` |
| `ptr.* (Ptr(non-int))` | `struct.get/ref.deref` |
| `ref1 == ref2` | `ref.eq` |
| `slice.(index)` | `array.get` (on internal arrayref) |
| `slice.(index) = value` | `array.set` (on internal arrayref) |
| `slice.len` | `struct.get` (field 1) |
| `slice.cap` | `struct.get` (field 2) |
| `@slice.make(T)` | `struct.new` with null arrayref, len=0, cap=0 |
| `@slice.append` | Allocate new array with double capacity, copy, update |
| `@slice.sub` | `struct.new` sharing same arrayref with updated len/cap |

### **GC Integration**
- All reference types managed by WASM GC
- No explicit `free` operations
- `@null` for null references
- Automatic garbage collection of unreachable objects
- **Memory safety**: bounds checking on all array/slice accesses

## **10. Implementation Details**

### **Field Pointers Resolution**
**Problem**: WASM GC doesn't support references to primitive struct fields.
**Solution**: Restrict `.&` to reference types only:
- Allow `.&` on struct variables, slice elements, array elements
- **Disallow** `.&` on primitive fields (`point.x.&` where `x: i32`)
- **Alternative**: Box primitives in single-field structs (future optimization)

### **Slice Growth Implementation**
```typescript
function sliceAppend(slice: Slice, element: T): Slice {
  if (slice.len == slice.cap) {
    let newCap = slice.cap == 0 ? 1 : slice.cap * 2;
    let newData = array.new(T, newCap, default);
    if (slice.data !== null) {
      array.copy(slice.data, 0, newData, 0, slice.len);
    }
    slice.data = newData;
    slice.cap = newCap;
  }
  array.set(slice.data, slice.len, element);
  slice.len++;
  return slice;
}
```

### **Expression Index Compilation**
```typescript
// slice.(index) compilation:
// 1. Evaluate index expression
// 2. Bounds check: 0 ≤ index < slice.len
// 3. array.get(slice.data, index)

// tuple.(index) compilation:
// 1. Evaluate index expression (must be compile-time constant for tuples)
// 2. Generate appropriate field access
```

### **Null Pointer Handling**
- All `Ptr(T)` variables can hold `@null(T)`
- Dereferencing null pointer traps
- Use `ref.is_null` for null checks

## **11. Example Programs**

```stl
// Struct allocation and usage
Point :: [x: i32, y: i32];
p: Point = [x: 10, y: 20];          // struct.new
p2: Point = [x: 10, y: 20];
same: bool = p == p2;               // false (different objects)

// Pointer operations (struct reference)
ptr: @Ptr(Point) = p.&;             // address of struct
p3: Point = ptr.*;                  // dereference (same as p)

// Slice usage
slice: @slice(i32) = @slice.make(i32);  // empty slice
slice = @slice.append(slice, 42);       // append element
len: i32 = slice.len;                   // read length
elem: i32 = slice.(0);                  // access element

// Extended access syntax
i: i32 = 1;
slice.(i) = slice.(0) + 1;         // dynamic indexing
sub: @slice(i32) = @slice.sub(slice, 1, 2);  // subslice

// Reference assignment and null
maybe: @Ptr(Point) = @null(Point);
if (maybe != @null(Point)) {
  val: Point = maybe.*;
}

field_value: i32 = point.x;  // field by name

// Expression-based field access
index: i32 = calculate_index();
value: i32 = slice.(index * 2 + 1);
```

## **12. Implementation Plan**

### **Phase 1: Type System & Parser**
1. Extend `types.ts` with `PointerType` and `SliceType`
2. Update parser for `@Ptr(T)` and `@slice(T)` type literals
3. Extend tuple access parsing for `.(expr)` syntax
4. Add `.&` and `.*` as new postfix operators

### **Phase 2: Type Checking**
1. Update type checker for new operators
2. Add validation for slice builtins
3. Extend equality checking to all types
4. Implement bounds checking for slice operations
5. Restrict `.&` to reference types only

### **Phase 3: Desugaring**
1. Modify desugaring to preserve named tuples (don't flatten)
2. Handle slice internal representation
3. Process expression-based tuple access
4. Implement slice growth logic

### **Phase 4: Compiler Backend**
1. Generate WASM GC instructions for struct/array operations
2. Implement slice builtins with doubling growth
3. Handle `.&` and `.*` operators
4. Update equality operators for references
5. Add runtime bounds checking

### **Phase 5: Testing & Validation**
1. Test example programs
2. Validate GC behavior and memory safety
3. Performance testing for slice growth

## **13. Breaking Changes**
1. **Named tuples become heap-allocated** (affects existing code)
2. **No linear memory operations** (removes existing memory features)
3. **No pointer arithmetic** (simplifies but removes low-level control)
4. **New reserved operators** `.&`, `.*`, `.(expr)`
5. **Equality operators work on all types** (may change behavior)

## **14. Future Extensions**
1. **Boxing primitives** for field pointers
2. **Slice operations**: `@slice.copy`, `@slice.insert`, `@slice.remove`
3. **Struct inheritance** via subtyping
4. **Interface types** for polymorphism
5. **Custom allocators** for specialized memory management

This specification provides a complete GC-based memory model for STL, leveraging WebAssembly GC capabilities while maintaining the language's simple, typed approach. The design focuses on safety, simplicity, and compatibility with WASM's evolving GC features.
