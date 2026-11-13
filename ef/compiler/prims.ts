// prims: the primitive type constants and the shared type-shape
// constructors, a leaf module — its unify.ts import is type-only (erased at
// runtime), so builtin_table.ts and types.ts read these at init time without
// a runtime dependency on the checker.
import type {AnyT, ArrT, Effs, FunT, Prim, TupField, TupT, Type} from "./unify.ts";

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

// The type-shape constructors the checker, the unifier, and the builtin
// table use — one definition here because prims is a leaf: a runtime import
// of these from unify.ts/types.ts into builtin_table.ts would tie table init
// to checker init, and those modules read each other's exports.
export function tArr(elem: Type): ArrT { return {tag: "arr", elem}; }
export function tFun(params: Type[], ret: Type, effs: Effs, marks?: {contCall?: true, anyTaint?: true}): FunT {
  const ft: FunT = {tag: "fun", params, ret, effs};
  if (marks?.contCall === true) ft.contCall = true;
  if (marks?.anyTaint === true) ft.anyTaint = true;
  return ft;
}
export function tTup(fields: TupField[]): TupT { return {tag: "tup", fields}; }
