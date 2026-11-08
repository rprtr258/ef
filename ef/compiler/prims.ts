// prims: the primitive type constants, in their own leaf module so
// builtins.ts can build its const table at load time without tripping the
// types.ts ⇄ builtins.ts import cycle (type-only imports are erased).
import type {AnyT, Prim} from "./types.ts";

export const TINT: Prim = {tag: "prim", name: "int"};
export const TFLOAT: Prim = {tag: "prim", name: "float"};
export const TSTR: Prim = {tag: "prim", name: "string"};
export const TBOOL: Prim = {tag: "prim", name: "bool"};
export const TNULL: Prim = {tag: "prim", name: "unit"};
export const TANY: AnyT = {tag: "any"};
