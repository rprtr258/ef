## target
- fully typed
  - have enum types
  - sum types
  - product types
  - primitive types
  - function types
  - some form of generics
- first classs types, e.g. generic functions are just functions taking type as parameter, and generic types are functions returning type
- extremely minimalistic in syntax in semantics, particularly has low or no keywords and builtins
- has all ordinary control flow forms: if/else, for/while with continue break
- has block returning values, multiple return statements are allowed in functions
- has compile time evaluation of arbitrary code
- wasm compilation target, or just compiled, or at least interpreted (as it needs to evaluate arbitrary code at compile time)
- first class build time integration, e.g. linters, static analyzers, build time variables evaluation
  https://www.youtube.com/watch?v=IdpD5QIVOKQ
- first class modules - modules are const values
  https://people.mpi-sws.org/~rossberg/1ml/1ml-extended.pdf
  modules are functions of their dependencies?



## features
### ignore values
```python
_ = add(1, 2);
```

### values must be used
requires: ignore values, void
all values must be used, user must explicitly ignore them, when the dont need them
void values might be safely ignored by default, since they yield no useful value

### no shadowing
shadowing is strongly disallowed, that is
```python
# same scope
x := 1;
x := 2; # compile-time error

# nested scopes
x := 1;
if true {
  x := 2; # compile-time error
}

# global/function scope
x := 1;
f :: fn(): [] {
  x := 2; # compile-time error
}

# destructure
x := 1;
[y, x] := [1, 2]; # compile-time error, since x is already defined
```
must be done at type_checker phase and result in compile time error, not warning

### control flow expressions
requires: void
first part is that `if` and `while` must be ablo to return value, in that case `if` must return same type from both branches, and `while` must `break` with value of same type across all `break`s
blocks can return values by not ending last expression with semicolon like in rust:
```python
x := if true {
  log("then");
  1 # no semicolon, returned from if
} else {
  log("else");
  2 # no semicolon, returned from if
};
x := {
  log("block");
  3 # no semicolon, returned from block
};
x := while { # note: empty while must be used, which is sugar for `while true`
  log("while");
  if random() < 0.1 {
    break 4; # break with value, which is returned
  }
}
```
second part is that any statement must return `void`, so function calls which return value, must be explicitly ignored:
```python
write :: fn(string): [n, error]
main :: fn() {
  write("Hello, world!"); # compile-time error, since return result is ignored
  _ = write("Hello, world!"); # ok
}
```
that requires supporting assignment into special symbol `_`
third part is `while {` sugar for `while true {`

### function overloading
declare function as being overloaded by functions, so they are tried in specified order:
```python
format_i32 :: fn(i: i32): string {...}
format_i32_base :: fn(i: i32, base: i32): string {...}
format_i64 :: fn(i: i64): string {...}
format_string :: fn(s: string): string {...}
format :: @overload(
  format_i32,
  format_i32_base,
  format_i64,
  format_string,
)
# or inlined
format :: @overload(
  fn(i: i32): string {...},
  fn(i: i32, base: i32): string {...},
  fn(i: i64): string {...},
  fn(s: string): string {...},
)
format2 :: @overload(
  parse_f32,
  format, # tried recursively
  parse_f64,
)
```

### tuples
which is fixed length array of elements of certain types, e.g.
```python
[] # empty tuple type, also it's value, can be used instead of void type
[T] # tuple of length 1 with element of type T
[T1, T2] # tuple of length 2 with elements of types T1 and T2
t : [T1, T2]
t = [t1, t2] # tuple constructor
t.0 : T1 # first element access
```
so, we defined syntax for both tuple types and values, along with accessor syntax
also that would allow us to use multiple return values just by returning tuple
also, that would allow us to define function types as tuple of two elements, first is argument types tuple, second is returned type
```python
main : @fn([], i32)
cos : @fn([f64], f64)
map : fn(T: Type, R: Type): @fn([List(T), @fn([T], R)], List(R))
```
nested tuples must also be possible as well as nested accessors

### memory
we need to give user ability to allocate memory. One way is to use GC to manage the memory, maybe with optional opt-in into manual memory management for advanced users.
this requires introducing pointer to memory type, and using it for reading/writing memory and getting/writing different type values into it

### views
which is a way to access value from different angles, e.g.
```python
t : [T1, T2]
t.0 : T1 # first element access
t.[1, 0] : [T2, T1] # access tuple using tuple index
t.first # access first field
t.first = t1 # set first field
```
views can be read and written. For read-only views, just use functions. To decide on views declaration syntax.
That feature will allow to introduce struct types as tuple type with named views for fields.
nested views must also be possible

### structs
requires: tuples, views
since structs are just tuples with named views, there is no need to introduce struct type declaration
but we need to give users simpler methods to construct such values, e.g.
```python
t : [T1, T2]
# somehow give it names [first, second]
t = [first = t1, second = t2]
# or
t = {first = t1, second = t2}
```
we use `=` instead of `:` in struct literal, as other languages do, because this is more in line with what actually happens: we assign values to fields, similar to how syntax sugar works in C:
```c
struct t {
  int first;
  int second;
} t = {.first = 1, .second = 2};
```
and also it is easier to refactor back and forth than colons
```python
t = {
  first = t1,
  second = t2, # trailing comma is allowed
};
# to/from
t.first = t1;
t.second = t2;
```
and also colon is used for type declaration

### closures aka lambdas aka first-class functions
requires: tuples
closures are pair of environment struct and function pointer
must be defined just like functions but with no name
at typecheck and runtime, environment is "erased" that is it is transfered transparently
also, user must be able to write their type, which is also might be covered by tuples feature

### void/unit
requires: tuples
instead of void type, user can just use empty tuple type

### compiletime
requires: closures
declarations like `kek :: fn(args...): returntype { ... }` must now be considered just like constant declarations, and since global constant declarations are evaluated at compile time, that is example of statically linked function
other examples:
```python
table :: (some long hard evaluation) # must be evaluated at compile time, and in compiled binary be represented by just memory bytes
```
there must be way for user to specify argument as compiletime known, e.g. for `printf(format :: string, args :: printf_args(format))` function which can parse and validate arguments and compile time
we also need to compile somehow compiletime if/while statements, e.g. for detecting (platform?), that may require special directive for compile time error when tried to be compiled
traits/typeclasses/interfaces are just compiletime constant structs with some function fields, so vtable are the same, but runtime evaluated, function may require trait implementation by requiring such vtable struct and it being constant

### first-class types
requires: compiletime
there are functions which have to accept types, also generics are implemented so
so we have to introduce `Type` type of all types, it must be inspectable since it represents any type
all type arguments are evaluated at compile time
that brings us full power of dependent types

### generics
requires: first-class types
generic function/types are just functions having `Type` arguments

### arrays
requires: tuples, first-class types
arrays are tuples of same element type
they are constructed by function of type `fn([Type, i32], Type)` both arguments of which must be evaluated at compile time
some accessor syntax is required, dont want to use `[]` if we can reuse something existing, e.g. `.5` for constant access like in tuples and use `.(i)` for access by index

### slices
requires: memory, first-class types, arrays
slices are just arrays of unknown size, so it is stored alongside with pointer to data (or data itself?), in other words, array is function `fn([Type, i32], Type)` both arguments of which were evaluated at compile time, and slice is the same function with second argument evaluated at runtime (hence stored)
so, `[1, 2, 3]` is valid slice value despite it is initially tuple value of type `[i32, i32, i32]`

### enum types
`keys` of struct type is enum with field names as enum values, we also must have way to access struct using such enum
`keys` of tuple type is enum with `0 | 1 | 2 | ... | n` as enum values, we also must have way to access tuple using such enum
so `keys` is just function of type `@fn([Type], Type)`

### sum types

### strings
requires: slices, memory
strings are immutable utf-8 slices of bytes
string literals are stored in static memory
operating with strings, e.g. concatenation requires us to use memory allocation and hence GC

### destructure
requires: tuples?
destructure is syntax to deconstruct some parts complex value right into variables, e.g.
```python
t : [T1, T2]
[t1, t2] := t # destructure first element into variable named "t1", second into "t2"
{first} := t # destructure "first" field into variable named "first"
{first: v} := t # destructure "first" field into variable named "v"
```
for composite types, syntax is `{field}` to deconstruct field into same named variable, and `{field: v}` to deconstruct field into variable named `v` since it looks just how value was constructed `{field: "some-value"}` and we just replaced value with variable name which will get that value

### buildtime
buildtime is about the same process as build.zig or [build routine](https://pixeldroid.com/jailang/overview/Features/Build-routines/#/overview/) in Jai
we can define which and how modules to link, which builtins are defined, what stdlib to use
by default, if no build script is defined, we use some defaults

### modules
requires: buildtime, destructure
modules are way to import/export symbols from other packages, which might be functions or variables
for that, source files are just scripts with return values, just like in zig, so final return value is just some struct with exported values/functions, although it might be not only struct, in which case value is exported as whole. All of that is transparent for user.
also it might be possible to include `json` files as constant values, or other files to "bake" in their data into compiled binary
all imports are top level constants, so done in compile time
imports can be destructured for easier access:
```python
{sin, cos} :: @import("std").math;
```
buildtime is required to handle how imports are performed

### stdlib
requires: modules
stdlib is just collection of some default modules, like math, logging, etc, some of them might be implemented inside the language, some require default imports from runtime, e.g. logging and working with files

### maps
requires: stdlib
despite maps are language defined in most scripting language, it is hard for us to introduce them consistently, e.g. `{...}` syntax is already used for blocks and struct literals, we also have to introduce syntax to access them, so it is too much work to disambugate them from other language features
instead, we introduce builtin hashmap type like `fn(Key: Type, hasher: fn(Key): u64, Value: Type): Type` with `get` and `set` defined as methods

### operator overloading
operator overloading is useful for math such as vector/matrices, for path manipulation, etc
must somehow define them and parse correctly, maybe check haskell design?

### builtins
requires: buildtime, stdlib, operator-overloading
builtins like `i32` might be declared inside the language like
```python
integer_type :: fn(i32): Type
i32 :: integer_type(32)
void :: [] # or unit
sizeof :: fn(Type): u32 # builtin, calls must be evaluated at compile time
# more complex examples
f32 :: Float(.IEEE754, exponent=8, mantissa=23)
f64 :: Float(.IEEE754, exponent=11, mantissa=52)
# other variants:
d32 :: Float(.Decimal, integer=15, fractional=16)
q32 :: Float(.Rational/.Quotient, numerator=15, denumerator=16)
```
wasm builtins are defined as builtins and implemented by compiler, other builtins, require special handling from compiler, e.g. for `u7`
operator overloading is required to define builtin operator types, e.g. `+` for `i32/i64/f32/f64`

### match/pattern matching
requires: destructure
for complex types we need to use pattern matching construct
it must be possible to match values, and bind unmatched values into variables, which requires somehow declaring bound variables inside patterns
pattern must also support handling expressing conditions not possible with just type constructor "shape", that is type guards, like `case [x, y] if x > y: ...`

### remove if
requires: pattern matching
if is just matching on predicate with true and optional false branch, so in the name of simplicity, it must be removed
it might be possible to introduce `match {` sugar for `match true` similar to `while` to handle boolean conditions easier

### effect system
requires: closures
required for async support, userspace exceptions, etc
aim only for single-shot continuations, multishot are too expensive for little value they provide
continuations in effect handlers can be stored just like closures
check how to compile that to wasm with no stack access
