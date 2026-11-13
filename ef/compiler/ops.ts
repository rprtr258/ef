// ops: the operator vocabulary as data — the names, their classifications,
// and the runtime trap-message constructors. Leaf module: imports nothing
// from the compiler, so every stage (parser, checker, analysis, runtimes)
// can consult it at init time.
//
// Names, classifications, and trap-text constructors; the implementations
// and the checker's message templates stay where they run and derive their
// names from here. env.ts's OPS closures serve unstamped app
// sites (operators reached as values); eval.ts's widthOp is the numeric
// dispatch for width-stamped sites (the checker's numKind lands there) and
// owns the ÷0/overflow traps. A width-stamped `%` therefore traps on ÷0
// while an unstamped (polymorphic) `%` flows through OPS's JS remainder —
// the intended split, not an accident to reconcile.

// Operator names, spelled exactly as the surface language and the AST `sym`
// values the parser desugars unary/binary syntax to.
export const OP_ADD = "+";
export const OP_SUB = "-";
export const OP_MUL = "*";
export const OP_DIV = "/";
export const OP_REM = "%";
export const OP_NEG = "neg";
export const OP_LT = "<";
export const OP_GT = ">";
export const OP_LE = "<=";
export const OP_GE = ">=";
export const OP_EQ = "==";
export const OP_NE = "!=";
export const OP_NOT = "not";

// Strict numeric arithmetic: both operands must share a width. `+` is not
// here — it is overloaded with string concatenation (types.ts plusType).
export const ARITH_OPS: ReadonlySet<string> = new Set([OP_SUB, OP_MUL, OP_DIV, OP_REM]);
// Ordering comparisons; equality requires operands to share a type.
export const CMP_OPS: ReadonlySet<string> = new Set([OP_LT, OP_GT, OP_LE, OP_GE]);
export const EQ_OPS: ReadonlySet<string> = new Set([OP_EQ, OP_NE]);
// The operators the checker dispatches structurally, never through the
// generic function-application path: arithmetic, comparisons, equality,
// string/numeric `+`, and unary neg.
export const STAMPED_OPS: ReadonlySet<string> =
  new Set([...ARITH_OPS, ...CMP_OPS, ...EQ_OPS, OP_ADD, OP_NEG]);

// Operator prims that can trap at runtime: integer / and % trap on ÷0 (and
// `/` on signed-width overflow). Every other operator computes for all
// inputs, so a backend may treat its prims as throw-free.
export const TRAPPING_OPS: ReadonlySet<string> = new Set([OP_DIV, OP_REM]);

// Runtime trap-message constructors. The exact strings are load-bearing:
// tests assert them, and the interpreter and the wasm host both throw these
// (parity by construction).
export function errDivByZero(): string {
  return "integer divide by zero";
}
export function errIntOverflow(): string {
  return "integer overflow";
}
// `where` names the trap site: ".field" for a named field read, or the
// builtin's own name ("get"/"set") for an array index.
export function errIndexOOB(where: string, idx: number, len: number): string {
  return `${where}: index ${idx} out of bounds [0, ${len})`;
}
export function errSubRangeOOB(from: number, to: number, len: number): string {
  return `sub: range [${from}, ${to}) out of bounds [0, ${len})`;
}
export function errUnhandled(op: string): string {
  return `Unhandled effect: ${op}`;
}
