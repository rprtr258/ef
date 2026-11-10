# AGENTS.md

## Definitions
- STL: Simply Typed Language
- WAT: WebAssembly Text format
- Lexer: Tokenize input string into tokens (keywords, idents, literals, operators).
- Parser: Hand-written recursive Pratt parser for expressions (infix/precedence via binding powers); recursive descent for statements/decls.
- Type Checker: Traverse AST, infer/check types, ensure matches for ops/assigns/returns.
- Compiler: AST to WASM IR; map types (i32->i32, i64->i64, bool->i32); use WASM ops for control (if/loop/br); functions as WASM funcs; emit WAT text.
- CLI: Bun-based entry; commands for compile (to WAT) and run (compile to WASM and execute).
- Playground: Vue.js web app with CodeMirror editor; compiles STL to WAT in browser; displays WAT output.

## Goals
- Tool to parse, type-check, and compile STL code to WebAssembly.
- Supports i32, i64, f32, f64, bool types; unary operators (-, !); if/else, while; functions; @as type casting.
- Includes web playground for online experimentation.
- Built with Bun and TypeScript; hand-written recursive Pratt parser.

## Scope
In: Parser, type checker, WASM compiler backend, CLI, playground.
Out: Interpreter, optimizations, advanced types, modules.

## Invariants
- Input: STL source files (.stl).
- Output: WAT text or execution result.
- Performance: Handle programs up to 10k LOC.
- Compatibility: Run on Bun runtime.
- Non-functional: Type-safe TypeScript code; tests for parser, typer, compiler, interpreter.
- Error handling for syntax/type errors.
- Data Flow: Source -> Lexer -> Tokens -> Parser -> AST -> Type Checker -> Typed AST -> Compiler -> WAT -> (wat2wasm -> WASM -> Execution).
- Tech Stack: Bun for runtime/CLI, TypeScript for all code, Vue.js for playground, CodeMirror for editing, @webassemblyjs for WASM utilities, binaryen for WASM processing.
- Project Structure: Subprojects compiler (core) and playground (web app). Directory structure as specified.
- Code Style Guidelines: TypeScript strict, 2 spaces indentation, PascalCase classes, camelCase functions/variables, enums PascalCase, interfaces for data, enums for constants, throw Error with messages, grouped alphabetical imports, no comments unless necessary, Bun test with exact assertions, double quotes, prefer switch/case, no linter disables.

## Non-goals
- Interpreter.

## Operating Rules
- Perform only minimal changes required to do the task.
- If you need to check pending difference, run `jj diff` using shell tool.
- Follow security guidelines: refuse malicious code, no CSAM, no hacking, etc.
- After every project change, run `bun run ci` to check everything is still working. If not, fix it, until there are no errors.
- Learn about serena mcp tools and use them to aid your work.

Build/Lint/Test Commands:
- Build: `bun run build` (compiles TypeScript to dist/)
- Test all: `bun test`
- Test single file: `bun test src/lexer.test.ts` (replace with specific test file)
- Lint: `bun run lint` (runs ESLint on src/**/*.ts)

CLI Usage:
- Compile to WAT: `bun run cli compile file.stl` (outputs .wat)
- Run STL file (interpret): `bun run cli run file.stl`

Test Strategies: Bun test, complete assertions, WAT validation, parser/type checker/compiler coverage.

## Success Criteria
- All tests pass.
- Linting and typechecking succeed.
- Builds without errors.
- Commands execute correctly.
- Output matches expected WAT for test cases.
