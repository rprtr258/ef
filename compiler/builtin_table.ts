// builtin_table: the declarative builtin table — every builtin ef programs
// can name as pure data: name, kind, checker signature, effect declaration.
// Leaf module: runtime imports only prims.ts and ops.ts (both leaves), so any module
// can read the table at init time regardless of load order. Runtime impls
// (closures, CPS natives, effect interps) live in builtins.ts; operator
// implementations live in env.ts's OPS — the checker resolves operator apps
// structurally, so operators are surface rows only.
import type {Type, Unifier} from "./frontend/unify.ts";
import {uniFresh, uniFreshEff} from "./frontend/unify.ts";
import type {EffectSig} from "./frontend/types.ts";
import {TI64, TANY, TF64, TFLOAT, TINT, TUNIT, TSTR, rowOf, tArr, tFun} from "./prims.ts";
import {
  OP_ADD, OP_SUB, OP_MUL, OP_REM, OP_NEG,
  OP_LT, OP_GT, OP_LE, OP_GE, OP_EQ, OP_NE, OP_NOT,
} from "./ops.ts";

// Sig-construction helpers come from prims.ts (a leaf, like this module),
// so the table and the checker share one definition without a
// builtin_table⇄types runtime cycle. Builtin sigs never need tFun's
// contCall/anyTaint marks.

// One declarative builtin row. `t` is the checker signature — a thunk for
// polymorphic builtins (fresh vars per use); `params` is the fixed-arity
// ABI both backends agree on; `pnames` is display-only (LSP hover text).
// Effect rows declare via `sig` (its params length is their arity).
type BuiltinDecl =
  | {kind: "fn", name: string, t: Type | ((u: Unifier) => Type), params: number, pnames?: string[]}
  | {kind: "value", name: string, t: Type, params: number}
  | {kind: "native", name: string, t: (u: Unifier) => Type, params: number, pnames?: string[]}
  | {kind: "effect", name: string, sig: EffectSig};

// Operators of the surface language, as surface rows: the checker resolves
// these apps structurally and env.ts implements them, so the surface needs
// only the name and fixed arity.
const OPERATOR_ROWS: {name: string, params: number}[] = [
  {name: OP_ADD, params: 2},
  {name: OP_SUB, params: 2},
  {name: OP_MUL, params: 2},
  {name: OP_REM, params: 2},
  {name: OP_NEG, params: 1},
  {name: OP_LT, params: 2},
  {name: OP_GT, params: 2},
  {name: OP_LE, params: 2},
  {name: OP_GE, params: 2},
  {name: OP_EQ, params: 2},
  {name: OP_NE, params: 2},
  {name: OP_NOT, params: 1},
];

// Shared with the wasm backend: the checker stamps numeric operator sites
// with a concrete width (numKind), but polymorphic/escape-hatch sites stay
// unstamped — the wasm backend must then fall back to the operator's
// dynamic trampoline (see treeShakeBuiltins and emitOperatorInline).
export const OPERATOR_OPS: Set<string> = new Set(OPERATOR_ROWS.map(r => r.name));

// The one declarative builtin table. One entry per builtin; adding a
// builtin means one entry here plus one impl row in builtins.ts. Entries
// are immutable and safe to share across programs: polymorphic `t` thunks
// instantiate fresh vars per use.
export const BUILTIN_TABLE: readonly BuiltinDecl[] = [
    {kind: "fn", name: "sub", t: (u: Unifier) => { const a = uniFresh(u); return tFun([tArr(a), TI64, TI64], tArr(a), rowOf()); }, params: 3, pnames: ["xs", "from", "to"]},
    {kind: "fn", name: "concat", t: (u: Unifier) => { const a = uniFresh(u); return tFun([tArr(a), tArr(a)], tArr(a), rowOf()); }, params: 2, pnames: ["xs", "ys"]},
    {kind: "fn", name: "flat", t: (u: Unifier) => { const a = uniFresh(u); return tFun([tArr(tArr(a))], tArr(a), rowOf()); }, params: 1, pnames: ["xs"]},
    {kind: "fn", name: "len", t: (u: Unifier) => { const a = uniFresh(u); return tFun([tArr(a)], TI64, rowOf()); }, params: 1, pnames: ["xs"]},
    {kind: "fn", name: "strlen", t: tFun([TSTR], TI64, rowOf()), params: 1, pnames: ["s"]},

    {kind: "value", name: "PI", t: TFLOAT, params: 0},
    {kind: "fn", name: "cos", t: tFun([TFLOAT], TFLOAT, rowOf()), params: 1, pnames: ["x"]},
    {kind: "fn", name: "sin", t: tFun([TFLOAT], TFLOAT, rowOf()), params: 1, pnames: ["x"]},
    {kind: "fn", name: "abs", t: tFun([TFLOAT], TFLOAT, rowOf()), params: 1, pnames: ["x"]},
    {kind: "fn", name: "round", t: tFun([TF64], TI64, rowOf()), params: 1, pnames: ["x"]},
    {kind: "fn", name: "sqrt", t: tFun([TFLOAT], TFLOAT, rowOf()), params: 1, pnames: ["x"]},
    // Builtins return concrete widths — range is (i64, i64, i64) -> [i64],
    // so its output is never width-ambiguous. Elements are plain JS numbers;
    // every read at an i64-typed site (get, callbacks) re-normalizes to BigInt.
    {kind: "fn", name: "range", t: tFun([TI64, TI64, TI64], tArr(TI64), rowOf()), params: 3, pnames: ["from", "to", "step"]},
    {kind: "fn", name: "char", t: tFun([TINT], TSTR, rowOf()), params: 1, pnames: ["code"]},
    {kind: "fn", name: "number", t: tFun([TSTR], TFLOAT, rowOf()), params: 1, pnames: ["s"]},
    {kind: "fn", name: "args", t: tFun([], tArr(TSTR), rowOf()), params: 0},
    {kind: "fn", name: "get", t: (u: Unifier) => { const a = uniFresh(u); return tFun([tArr(a), TI64], a, rowOf()); }, params: 2, pnames: ["xs", "i"]},
    {kind: "fn", name: "set", t: (u: Unifier) => { const a = uniFresh(u); return tFun([tArr(a), TI64, a], TUNIT, rowOf()); }, params: 3, pnames: ["xs", "i", "v"]},

    // Builtin effects, declared to the checker via `sig` and interpreted by
    // the runtime when left unhandled. `Read(path): string` reads a file;
    // `Write(path, content): null` writes one. `Println(v: any): null` and
    // `Out(s: string): null` are the console effects. User `effect` decls
    // may add or override these.
    {kind: "effect", name: "Read", sig: {params: [TSTR], ret: TSTR, names: ["path"]}},
    {kind: "effect", name: "Write", sig: {params: [TSTR, TSTR], ret: TUNIT, names: ["path", "content"]}},
    {kind: "effect", name: "Println", sig: {params: [TANY], ret: TUNIT, names: ["v"]}},
    {kind: "effect", name: "Out", sig: {params: [TSTR], ret: TUNIT, names: ["s"]}},
    // `Exit(code: i64): unit` terminates the process by default (never
    // resumes); `Wait(secs: i64): unit` blocks for `secs` seconds then
    // resumes with unit. Both are effects so a handler can intercept them.
    {kind: "effect", name: "Exit", sig: {params: [TI64], ret: TUNIT, names: ["code"]}},
    {kind: "effect", name: "Wait", sig: {params: [TI64], ret: TUNIT, names: ["secs"]}},
    // `Random(): f64` resumes with a random number in [0, 1).
    {kind: "effect", name: "Random", sig: {params: [], ret: TF64}},

    // Natives that call ef closures mid-flight (map/each/flatmap): CPS.
    {kind: "native", name: "map", t: (u: Unifier) => {
      const a = uniFresh(u), b = uniFresh(u), e = rowOf([], [uniFreshEff(u)]);
      return tFun([tFun([a], b, e), tArr(a)], tArr(b), e);
    }, params: 2, pnames: ["f", "xs"]},
    {kind: "native", name: "each", t: (u: Unifier) => {
      const a = uniFresh(u), b = uniFresh(u), e = rowOf([], [uniFreshEff(u)]);
      return tFun([tFun([a, TI64], b, e), tArr(a)], TUNIT, e);
    }, params: 2, pnames: ["f", "xs"]},
    {kind: "native", name: "flatmap", t: (u: Unifier) => {
      const a = uniFresh(u), b = uniFresh(u), e = rowOf([], [uniFreshEff(u)]);
      return tFun([tFun([a, TI64], tArr(b), e), tArr(a)], tArr(b), e);
    }, params: 2, pnames: ["f", "xs"]},
];

// The native builtins — the rows whose trampoline calls an ef closure
// mid-flight (map/each/flatmap today), so every consumer must treat their
// call sites as suspension points. Derived here — the set is exactly the
// table's `kind: "native"` rows — so a new native row joins the checker's
// suspension stamping, the wasm devirtualizer's callback edges and the
// wasm trampoline frame layout with no second hand-maintained list.
export const NATIVE_BUILTINS: ReadonlySet<string> = new Set(
  BUILTIN_TABLE.filter(d => d.kind === "native").map(d => d.name));

// Every builtin ef programs can name (the interpreter's global env): the
// checker's operators first (resolved structurally, no table entry), then
// the table's non-effect builtins in table order — names that already
// surface as operator rows (`not`) list once, via the operator rows.
export const BUILTINS: {name: string, params: number}[] = [
  ...OPERATOR_ROWS,
  ...BUILTIN_TABLE
    .filter((d): d is Exclude<BuiltinDecl, {kind: "effect"}> =>
      d.kind !== "effect" && !OPERATOR_OPS.has(d.name))
    .map(d => ({name: d.name, params: d.params})),
];

// Builtin effect op names in op-table order (= table order). The wasm op
// table seeds these at opids 0..n-1; performed/handled program ops intern
// after them.
export const EFFECT_OPS: string[] =
  BUILTIN_TABLE.filter(d => d.kind === "effect").map(d => d.name);
