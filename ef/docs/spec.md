# Simple Typed Language (STL) Specification

## Overview
STL is a simply typed imperative language supporting compilation to WebAssembly (WASM). Types: i32, i64, u32, u64, f32, f64, bool, and tuples (including named tuples). Control: if/else, while, break, continue. Functions with parameters and returns. External modules can be declared to import functions from the host environment. Type casting with @as builtin. Comments: single‑line comments starting with #.

## Syntax (EBNF Grammar)

```
<program> ::= (<module-decl> | <function>)*

<module-decl> ::= <ident> "::" "[" <field-list>? "]"
<field-list> ::= <field> ("," <field>)*
<field> ::= <ident> ":" "fn" "(" <param-list>? ")" ":" <type>

<function> ::= <function-decl> "{" <stmt>* "}"
<function-decl> ::= <ident> "::" "fn" "(" <param-list>? ")" ":" <type>
<param-list> ::= <var-decl> ("," <var-decl>)*
<var-decl> ::= <ident> ":" <type>

<type> ::= <primitive-type> | <tuple-type> | <named-tuple-type>
<primitive-type> ::= "i32" | "i64" | "u32" | "u64" | "f32" | "f64" | "bool"
<tuple-type> ::= "[" <type-list>? "]"
<named-tuple-type> ::= "[" <named-type-list>? "]"
<type-list> ::= <type> ("," <type>)*
<named-type-list> ::= <ident> ":" <type> ("," <ident> ":" <type>)*

<stmt> ::= <decl-stmt> | <assign-stmt> | <if-stmt> | <while-stmt> | <break-stmt> | <continue-stmt> | <return-stmt> | <expr-stmt>
<decl-stmt> ::= <ident> ":" <type> ("=" <expr>)? ";"
<assign-stmt> ::= <expr> "=" <expr> ";"
<if-stmt> ::= "if" <expr> "{" <stmt>* "}" ("else" "{" <stmt>* "}")?
<while-stmt> ::= "while" <expr> "{" <stmt>* "}"
<break-stmt> ::= "break" ";"
<continue-stmt> ::= "continue" ";"
<return-stmt> ::= "return" <expr>? ";"
<expr-stmt> ::= <expr> ";"

<expr> ::= <unary-expr> | <binary-expr> | <call-expr> | <cast-expr> | <tuple-literal> | <tuple-access> | <literal> | <ident> | "(" <expr> ")"
<unary-expr> ::= ("-" | "!") <expr>
<binary-expr> ::= <expr> <bin-op> <expr>
<bin-op> ::= "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "&" | "|" | "^" | "<<" | ">>"
<call-expr> ::= <ident> "(" <arg-list>? ")"
<arg-list> ::= <expr> ("," <expr>)*
<cast-expr> ::= "@as" "(" <expr> "," <type> ")"
<tuple-literal> ::= "[" <expr-list>? "]" | "[" <named-expr-list>? "]"
<expr-list> ::= <expr> ("," <expr>)*
<named-expr-list> ::= <ident> "=" <expr> ("," <ident> "=" <expr>)*
<tuple-access> ::= <expr> "." (<integer> | <ident>)

<literal> ::= <num-lit> | "true" | "false"
<num-lit> ::= ("0b" [01]+ | "0x" [0-9a-fA-F]+ | [0-9]+ ("." [0-9]+)? (("e" | "E") ("+" | "-")? [0-9]+)? ) ("i32" | "i64" | "u32" | "u64" | "f32" | "f64")?
<ident> ::= [a-zA-Z_][a-zA-Z0-9_]*
<integer> ::= [0-9]+
```
## Semantics
- **Types**: Static typing. i32/i64 for integers (32/64-bit signed), u32/u64 for integers (32/64-bit unsigned), f32/f64 for floats (32/64-bit IEEE 754). bool for true/false. Tuple types group multiple values of possibly different types; named tuples provide field names (order‑insensitive).
  - **Expressions**: Evaluate to typed values. Binary ops require matching types (i32/i64/u32/u64 arithmetic/bitwise, bool logical/bitwise). Unary - for i32/i64/u32/u64/f32/f64, ! for bool. @as performs type casting with runtime conversion where necessary. Bitwise ops (& | ^ << >>) for i32/i64/u32/u64/bool.
  - **Tuples**: Tuple literals produce tuple values. Tuple access by index (integer) or field name (for named tuples) retrieves the element. Assignment to tuple elements is allowed.
- **Statements**:
  - Declarations: `ident : type [= expr] ;` introduces a new variable of the given type; if an initializer is present, its type must match.
  - Assignment: `expr = expr ;` assigns a value to a variable or tuple element; left‑hand side must be an l‑value (identifier or tuple access).
  - If/else: Condition must be bool.
  - While: Condition bool; break/continue only in loops.
  - Functions: Call with matching args. Return type checked. The `main` function must have signature `fn(): i32`.
- **Scope**: Block‑scoped variables. Functions global.
## Compilation to WASM
- Map types: i32 → i32, i64 → i64, u32 → i32, u64 → i64, f32 → f32, f64 → f64, bool → i32 (0/1).
- Tuples are flattened: each element becomes a separate WASM value (multiple `result`/`param`/`local` entries). Named tuples lose their field names.
- Functions → WASM functions; `main` is exported as `"main"`.
- Control: Use WASM if/else, loop/br for while/break/continue.
- Bitwise: Direct WASM ops (and, or, xor, shl, shr_s/shr_u for signed/unsigned).
- Literals: Binary/hex/scientific parsed to numbers.
- Use locals for variables; no linear memory needed for simple programs.
## Interpretation
- Use stack-based VM.
- Environment for variables/functions.
- Eval expressions recursively.
- Execute statements sequentially, handling control flow.
