// prims: the primitive type constants, a leaf module — its only types.ts
// import is type-only (erased at runtime), so builtin_table.ts can read
// these constants at init time without loading the checker.
import type {AnyT, Prim} from "./types.ts";

// The six machine widths. Arithmetic between distinct widths is a type
// error; @as converts.
export const TI32: Prim = {tag: "prim", name: "i32"};
export const TI64: Prim = {tag: "prim", name: "i64"};
export const TU32: Prim = {tag: "prim", name: "u32"};
export const TU64: Prim = {tag: "prim", name: "u64"};
export const TF32: Prim = {tag: "prim", name: "f32"};
export const TF64: Prim = {tag: "prim", name: "f64"};
// Untyped numeric literals: `1` and `1.5` carry these until a concrete
// numeric context fixes them; unresolved they default to i64 / f64. Not
// writable in source — only the num literal rule produces them.
export const TINT: Prim = {tag: "prim", name: "int"};
export const TFLOAT: Prim = {tag: "prim", name: "float"};
export const TSTR: Prim = {tag: "prim", name: "string"};
export const TBOOL: Prim = {tag: "prim", name: "bool"};
export const TUNIT: Prim = {tag: "prim", name: "unit"};
// The type of type-parameters: annotation-only (alias definitions like
// `Pair :: fn(a: type, b: type): type {...}`). Nothing at term level
// produces it, so it never reaches the evaluator or the wasm backend.
export const TTYPE: Prim = {tag: "prim", name: "type"};
export const TANY: AnyT = {tag: "any"};
