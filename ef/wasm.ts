// wasm.ts — WebAssembly backend for ef.
//
// Pipeline: parse → typecheck (types.ts, reused as-is) → emit a
// self-contained binary .wasm module → instantiate against host imports and
// run. No WasmGC, no external tools, no types needed at emission time: the
// only checker output the backend consumes is the runtime stamps the checker
// leaves on nodes (`e.div` for division, `e.idx` for field access).
//
// Subset: everything except `handle` and user-declared effect ops. `perform`
// of a builtin effect (Read/Write/Println/Out/Exit/Wait/Random) compiles to a
// host-import call: the effect reaches the host, which interprets it (like
// the interpreter's runTop) and resumes with the result. `handle` needs
// multi-shot continuations, which wasm has no primitive for — rejected at
// compile time.
//
// Representation:
// - Value = 16-byte cell {tag: i32, pad: i32, data: 8B} where data holds an
//   f64 (num/bool) or an i32 heap pointer (str/arr/clo). Tags: 0 unit,
//   1 num, 2 bool, 3 str, 4 arr, 5 clo. Bump allocator, never freed.
// - Strings are UTF-16 code-unit arrays (matches JS strlen/char/Out).
// - Every call frame is a heap block {parent, argc, slots...}; closures
//   capture their defining frame pointer, so escaping/mutable capture works
//   exactly like the interpreter's env chain. Variables resolve statically
//   to (frame depth, slot).
// - All ef functions have uniform signature (i32 frame) -> i32 and dispatch
//   through one funcref table via call_indirect. Builtins are trampolines;
//   map/each/flatmap are compiled loops calling callbacks the same way.
// - Static literals (nums, strings, bools, unit, builtin closures) are baked
//   into a data segment; the heap pointer starts after them.
//
// Known deviations vs the interpreter (degenerate programs only):
// - Arithmetic/comparison on non-numbers produces garbage instead of throwing.
// - `set` growing an array fills holes with unit (interpreter: undefined).
// - Closures always display as [fn] (interpreter may show an inferred type).
// - Stack overflow surfaces as a wasm RuntimeError, not a JS RangeError.
// - No GC: every call (tail or not) bump-allocates a frame block that is never
//   reclaimed, so recursion depth N costs O(N) heap (100M tail calls ≈ 1.6 GB).
//   The wasm stack itself stays O(1): calls in tail position use
//   return_call_indirect.

// Cycle-breaker: builtins.ts imports `apply` from eval.ts at runtime, so the
// eval↔builtins cluster only initializes cleanly if eval.ts is entered first
// (same as cli.ts). Must precede parser.ts/types.ts — both reach the cycle.
import "./eval.ts";
import {Parser, type Expr, type ExprID, type Program} from "./parser.ts";
import {checkProgram} from "./types.ts";
import {type Value, show} from "./env.ts";
import {readFileSync, writeFileSync} from "node:fs";
import {sleepSync} from "bun";

// --- binary encoding helpers -----------------------------------------------

class Buf {
  b: number[] = [];
  u8(n: number): this { this.b.push(n & 0xff); return this; }
  lebU(n: number): this {
    n >>>= 0;
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      this.b.push(byte);
    } while (n !== 0);
    return this;
  }
  lebS(n: number): this {
    n |= 0;
    for (;;) {
      const byte = n & 0x7f;
      n >>= 7;
      if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
        this.b.push(byte);
        return this;
      }
      this.b.push(byte | 0x80);
    }
  }
  f64(x: number): this {
    const ab = new ArrayBuffer(8);
    new DataView(ab).setFloat64(0, x, true);
    for (const v of new Uint8Array(ab)) this.b.push(v);
    return this;
  }
  bytes(bs: ArrayLike<number>): this {
    for (let i = 0; i < bs.length; i++) this.b.push(bs[i] & 0xff);
    return this;
  }
  name(s: string): this {
    this.lebU(s.length);
    for (let i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) & 0xff);
    return this;
  }
}

// Instruction shorthands. `b` is always the function body buffer.
const op = (b: Buf, o: number) => b.u8(o);
const g = (b: Buf, i: number) => { b.u8(0x20); b.lebU(i); };  // local.get
const st = (b: Buf, i: number) => { b.u8(0x21); b.lebU(i); }; // local.set
const i32c = (b: Buf, n: number) => { b.u8(0x41); b.lebS(n); };
const f64c = (b: Buf, x: number) => { b.u8(0x44); b.f64(x); };
const ld = (b: Buf, off = 0) => { b.u8(0x28); b.lebU(2); b.lebU(off); };   // i32.load
const ld64 = (b: Buf, off = 0) => { b.u8(0x2b); b.lebU(3); b.lebU(off); }; // f64.load
const ld16 = (b: Buf, off = 0) => { b.u8(0x2f); b.lebU(1); b.lebU(off); }; // i32.load16_u
const strd = (b: Buf, off = 0) => { b.u8(0x36); b.lebU(2); b.lebU(off); }; // i32.store
const st64 = (b: Buf, off = 0) => { b.u8(0x39); b.lebU(3); b.lebU(off); }; // f64.store
const st16 = (b: Buf, off = 0) => { b.u8(0x3b); b.lebU(1); b.lebU(off); }; // i32.store16
const drp = (b: Buf) => op(b, 0x1a);
// i32 arithmetic/comparison
const ADD = 0x6a, SUB = 0x6b, MUL = 0x6c, SHL = 0x74, SHRU = 0x76;
const EQZ = 0x45, EQ = 0x46, NE = 0x47, LTS = 0x48, OR = 0x72, AND = 0x71;
const GTU = 0x4b, LEU = 0x4d, GEU = 0x4f;
// f64 arithmetic/comparison
const FABS = 0x99, FNEG = 0x9a, FCEIL = 0x9b, FFLOOR = 0x9c, FTRUNC = 0x9d, FSQRT = 0x9f;
const FADD = 0xa0, FSUB = 0xa1, FMUL = 0xa2, FDIV = 0xa3;
const FLT = 0x63, FGT = 0x64, FLE = 0x65, FGE = 0x66, FEQ = 0x61;
const TRUNC_F64 = 0xaa, CONV_I32 = 0xb7; // i32.trunc_f64_s, f64.convert_i32_s
const CALL = 0x10, CALL_INDIRECT = 0x11, RETURN_CALL = 0x12, RETURN_CALL_INDIRECT = 0x13, SELECT = 0x1b;
const BR = 0x0c, BR_IF = 0x0d, IF = 0x04, ELSE = 0x05, END = 0x0b, LOOP = 0x03, BLOCK = 0x02;

// --- module-level constants -------------------------------------------------

const TAG_UNIT = 0, TAG_NUM = 1, TAG_BOOL = 2, TAG_STR = 3, TAG_ARR = 4, TAG_CLO = 5;
// Static cells live at fixed offsets so the host can read them too.
const TRUE_CELL = 0, FALSE_CELL = 16, UNIT_CELL = 32, STATIC_FIXED = 48;

// Function indices: 0..HOST_IMPORTS.length-1 host imports, then helpers,
// lambdas, builtins, main.

// Every builtin ef programs can name (the interpreter's global env).
const BUILTINS: {name: string, params: number}[] = [
  {name: "+", params: 2},
  {name: "-", params: 2},
  {name: "*", params: 2},
  {name: "%", params: 2},
  {name: "neg", params: 1},
  {name: "<", params: 2},
  {name: ">", params: 2},
  {name: "<=", params: 2},
  {name: ">=", params: 2},
  {name: "==", params: 2},
  {name: "!=", params: 2},
  {name: "not", params: 1},
  {name: "list", params: 0}, // variadic
  {name: "head", params: 1},
  {name: "tail", params: 1},
  {name: "concat", params: 2},
  {name: "flat", params: 1},
  {name: "len", params: 1},
  {name: "strlen", params: 1},
  {name: "PI", params: 0},
  {name: "cos", params: 1},
  {name: "sin", params: 1},
  {name: "abs", params: 1},
  {name: "round", params: 1},
  {name: "sqrt", params: 1},
  {name: "range", params: 3},
  {name: "char", params: 1},
  {name: "number", params: 1},
  {name: "args", params: 0},
  {name: "get", params: 2},
  {name: "set", params: 3},
  {name: "map", params: 2},
  {name: "each", params: 2},
  {name: "flatmap", params: 2},
];

// Builtin effects performable in the wasm target: op → host import.
const EFFECT_IMPORTS: Record<string, {imp: string, zeroArgs?: boolean}> = {
  "Read": {imp: "ef_read"},
  "Write": {imp: "ef_write"},
  "Println": {imp: "ef_println"},
  "Out": {imp: "ef_out"},
  "Exit": {imp: "ef_exit"},
  "Wait": {imp: "ef_wait"},
  "Random": {imp: "ef_random", zeroArgs: true},
};

const HOST_IMPORTS = [
  ...Object.values(EFFECT_IMPORTS).map(e => e.imp),
  "ef_char", "ef_number", "ef_args", "ef_cos", "ef_sin", "ef_fail",
];

// Defined-function indices: helpers first, then lambdas, builtins, main.
const F_ALLOC = HOST_IMPORTS.length, F_TRUTHY = F_ALLOC + 1, F_EQ = F_ALLOC + 2,
  F_BOX = F_ALLOC + 3, F_LAMBDA0 = F_ALLOC + 4;

// Type section indices.
const T_I_I = 0, T_V_I = 1, T_IIFF_I = 2, T_F_I = 3, T_II_I = 4;

function impType(n: string): number {
  if (n === "ef_random" || n === "ef_args") return T_V_I;
  if (n === "ef_fail") return T_IIFF_I;
  if (n === "ef_write") return T_II_I; // (path, content)
  return T_I_I;
}

// --- per-function emitter ---------------------------------------------------

class Fn {
  body = new Buf();
  locals: number[] = []; // extra locals in allocation order (valtype bytes)
  typeIdx = T_I_I; // all ef functions share (i32) -> i32; helpers may differ
  constructor(public params: number) {}
  i32(): number { this.locals.push(0x7f); return this.params + this.locals.length - 1; }
  f64(): number { this.locals.push(0x7c); return this.params + this.locals.length - 1; }
}

// --- compiler ---------------------------------------------------------------

type Scope = {
  frame: {slots: number}, // frame identity: changes only at lambda boundaries
  parent: Scope | null,
  map: Map<string, number>,
};

export class WasmError extends Error {}

export function compile(src: string): Uint8Array {
  return new Compiler(new Parser(src).parseProgram()).compile();
}

class Compiler {
  nodes: Expr[];
  scopes = new Map<ExprID, Scope>();
  globalFrame = {slots: 0};
  globalScope: Scope = {frame: this.globalFrame, parent: null, map: new Map()};
  data = new Buf();
  numLits = new Map<number, number>();    // literal value → static cell offset
  strLits = new Map<string, number>();    // literal value → static cell offset
  cloOffsets = new Map<string, number>(); // builtin name → static clo offset
  funcs: Fn[] = [];
  lambdaIdx = new Map<ExprID, number>();
  piOff = 0;
  hp0 = 0;

  constructor(public prog: Program) {
    this.nodes = prog.nodes;
  }

  compile(): Uint8Array {
    // Typecheck first: rejects ill-typed programs and stamps the runtime
    // markers this backend reads (`div` on applications of `/`, `idx` on
    // field accesses).
    checkProgram(this.prog);
    // 1. Scope discovery: scopes per lambda/block, slot numbering, literals.
    for (const it of this.prog.items) {
      if ("e" in it) this.discover(it.e, this.globalScope);
    }
    // 2. Function index assignment (deterministic AST order).
    for (const it of this.prog.items) {
      if ("e" in it) this.assignLambdas(it.e);
    }
    const builtin0 = F_LAMBDA0 + this.lambdaIdx.size;
    // 3. Static layout (heap pointer starts after it).
    this.layoutStatics(builtin0);
    this.hp0 = (this.data.b.length + 7) & ~7;
    // 4. Emit code: helpers (fixed indices 11..14), lambdas, builtin
    //    trampolines, then main (last).
    this.funcs.push(...this.emitHelpers());
    for (const it of this.prog.items) {
      if ("e" in it) this.emitLambdas(it.e);
    }
    this.funcs.push(...this.emitBuiltins(builtin0));
    const main = new Fn(1);
    this.emitMain(main);
    this.funcs.push(main);
    // 5. Assemble.
    return this.assemble();
  }

  // --- discovery: scopes, slots, literals ------------------------------------

  discover(id: ExprID, sc: Scope): void {
    const e = this.nodes[id];
    switch (e.t) {
      case "num":
        this.numLits.set(e.v, -1);
        break;
      case "str":
        this.strLits.set(e.v, -1);
        break;
      case "lambda": {
        const frame = {slots: 0};
        const s: Scope = {frame, parent: sc, map: new Map()};
        for (const p of e.params) s.map.set(p.name, frame.slots++);
        this.scopes.set(id, s);
        this.discover(e.body, s);
        break;
      }
      // Blocks share the enclosing wasm frame: their lets just take further
      // slots (the interpreter's block env is a child of the current env).
      case "block": {
        const s: Scope = {frame: sc.frame, parent: sc, map: new Map()};
        this.scopes.set(id, s);
        for (const stmt of e.stmts) this.discover(stmt, s);
        break;
      }
      case "let":
        sc.map.set(e.name, sc.frame.slots++);
        this.discover(e.val, sc);
        break;
      case "dlet":
        for (const fd of e.fields) sc.map.set(fd.name, sc.frame.slots++);
        this.discover(e.val, sc);
        break;
      case "assign":
        this.discover(e.val, sc);
        break;
      case "if":
        this.discover(e.c, sc);
        this.discover(e.a, sc);
        this.discover(e.b, sc);
        break;
      case "while":
        this.discover(e.c, sc);
        this.discover(e.body, sc);
        break;
      case "app":
        this.discover(e.fn, sc);
        for (const a of e.args) this.discover(a, sc);
        break;
      case "arr":
        for (const el of e.elems) this.discover(el, sc);
        break;
      case "field":
        this.discover(e.obj, sc);
        this.strLits.set(e.name, -1); // for the out-of-bounds message
        break;
      case "perform":
        for (const a of e.args) this.discover(a, sc);
        break;
      case "handle":
        throw new WasmError(
          "wasm target: 'handle' is not supported (multi-shot continuations); " +
          "builtin effects reach the host unhandled instead",
        );
      case "sym":
      case "bool":
      case "unit":
        break;
    }
  }

  assignLambdas(id: ExprID): void {
    const e = this.nodes[id];
    switch (e.t) {
      case "lambda":
        this.lambdaIdx.set(id, F_LAMBDA0 + this.lambdaIdx.size);
        this.assignLambdas(e.body);
        break;
      case "let":
      case "assign":
      case "dlet":
        this.assignLambdas(e.val);
        break;
      case "block":
        for (const stmt of e.stmts) this.assignLambdas(stmt);
        break;
      case "if":
        this.assignLambdas(e.c);
        this.assignLambdas(e.a);
        this.assignLambdas(e.b);
        break;
      case "while":
        this.assignLambdas(e.c);
        this.assignLambdas(e.body);
        break;
      case "app":
        this.assignLambdas(e.fn);
        for (const a of e.args) this.assignLambdas(a);
        break;
      case "arr":
        for (const el of e.elems) this.assignLambdas(el);
        break;
      case "field":
        this.assignLambdas(e.obj);
        break;
      case "perform":
        for (const a of e.args) this.assignLambdas(a);
        break;
    }
  }

  emitLambdas(id: ExprID): void {
    const e = this.nodes[id];
    switch (e.t) {
      case "lambda": {
        const f = new Fn(1);
        this.expr(e.body, f, this.scopes.get(id), true);
        this.funcs.push(f);
        this.emitLambdas(e.body);
        break;
      }
      case "let":
      case "assign":
      case "dlet":
        this.emitLambdas(e.val);
        break;
      case "block":
        for (const stmt of e.stmts) this.emitLambdas(stmt);
        break;
      case "if":
        this.emitLambdas(e.c);
        this.emitLambdas(e.a);
        this.emitLambdas(e.b);
        break;
      case "while":
        this.emitLambdas(e.c);
        this.emitLambdas(e.body);
        break;
      case "app":
        this.emitLambdas(e.fn);
        for (const a of e.args) this.emitLambdas(a);
        break;
      case "arr":
        for (const el of e.elems) this.emitLambdas(el);
        break;
      case "field":
        this.emitLambdas(e.obj);
        break;
      case "perform":
        for (const a of e.args) this.emitLambdas(a);
        break;
    }
  }

  // --- helper functions (fixed indices 11..14) -------------------------------

  emitHelpers(): Fn[] {
    // $alloc(n: i32) -> i32: bump-allocate n (rounded to 8) bytes, growing
    // memory as needed. $hp is the module's mutable heap-pointer global.
    const alloc = new Fn(1);
    {
      const b = alloc.body;
      const old = alloc.i32(), need = alloc.i32();
      op(b, 0x23); // global.get $hp
      b.lebU(0);
      st(b, old);
      g(b, old);
      g(b, 0);
      op(b, ADD);
      st(b, need);
      g(b, need);
      op(b, 0x3f); // memory.size
      b.lebU(0);
      i32c(b, 16);
      op(b, SHL);
      op(b, GTU);
      op(b, IF);
      b.u8(0x40);
      g(b, need);
      op(b, 0x3f);
      b.lebU(0);
      i32c(b, 16);
      op(b, SHL);
      op(b, SUB);
      i32c(b, 65535);
      op(b, ADD);
      i32c(b, 16);
      op(b, SHRU);
      op(b, 0x40); // memory.grow
      b.lebU(0);
      drp(b);
      op(b, END);
      g(b, old);
      g(b, 0);
      op(b, ADD);
      op(b, 0x24); // global.set $hp
      b.lebU(0);
      g(b, old);
    }
    // $truthy(cell: i32) -> i32: JS truthiness — false only for unit and
    // the bool payload 0 (matches `c !== false && c !== null`).
    const truthy = new Fn(1);
    {
      const b = truthy.body;
      g(b, 0);
      ld(b, 0);
      i32c(b, 0);
      op(b, EQ);
      op(b, IF);
      b.u8(0x7f);
      i32c(b, 0);
      op(b, ELSE);
      g(b, 0);
      ld(b, 0);
      i32c(b, TAG_BOOL);
      op(b, EQ);
      op(b, IF);
      b.u8(0x7f);
      g(b, 0);
      ld64(b, 8);
      f64c(b, 0);
      op(b, 0x62); // f64.ne
      op(b, ELSE);
      i32c(b, 1);
      op(b, END);
      op(b, END);
    }
    // $eq(a: i32, b: i32) -> i32: JS === — numbers/bools by payload, strings
    // by content, arrays/closures by identity, unit always equal.
    const eq = new Fn(2);
    eq.typeIdx = T_II_I;
    {
      const b = eq.body;
      const at = eq.i32(), bt = eq.i32();
      g(b, 0);
      ld(b, 0);
      st(b, at);
      g(b, 1);
      ld(b, 0);
      st(b, bt);
      g(b, at);
      g(b, bt);
      op(b, NE);
      op(b, IF);
      b.u8(0x7f);
      i32c(b, FALSE_CELL);
      op(b, ELSE);
      g(b, at);
      i32c(b, TAG_UNIT);
      op(b, EQ);
      op(b, IF);
      b.u8(0x7f);
      i32c(b, TRUE_CELL);
      op(b, ELSE);
      g(b, at);
      i32c(b, TAG_NUM);
      op(b, EQ);
      g(b, at);
      i32c(b, TAG_BOOL);
      op(b, EQ);
      op(b, OR);
      op(b, IF);
      b.u8(0x7f);
      this.selectBool(eq, () => {
        g(b, 0);
        ld64(b, 8);
        g(b, 1);
        ld64(b, 8);
        op(b, FEQ);
      });
      op(b, ELSE);
      g(b, at);
      i32c(b, TAG_STR);
      op(b, EQ);
      op(b, IF);
      b.u8(0x7f);
      const ab = eq.i32(), bb = eq.i32(), la = eq.i32(), lb = eq.i32(), res = eq.i32();
      g(b, 0);
      ld(b, 8);
      st(b, ab);
      g(b, 1);
      ld(b, 8);
      st(b, bb);
      g(b, ab);
      ld(b, 0);
      st(b, la);
      g(b, bb);
      ld(b, 0);
      st(b, lb);
      i32c(b, 1);
      st(b, res);
      g(b, la);
      g(b, lb);
      op(b, EQ);
      op(b, EQZ);
      op(b, IF);
      b.u8(0x40);
      i32c(b, 0);
      st(b, res);
      op(b, END);
      this.loop(eq, () => {
        g(b, la);
      }, i => {
        g(b, res);
        g(b, ab);
        i32c(b, 4);
        op(b, ADD);
        g(b, i);
        i32c(b, 2);
        op(b, MUL);
        op(b, ADD);
        ld16(b, 0);
        g(b, bb);
        i32c(b, 4);
        op(b, ADD);
        g(b, i);
        i32c(b, 2);
        op(b, MUL);
        op(b, ADD);
        ld16(b, 0);
        op(b, EQ);
        op(b, AND);
        st(b, res);
      });
      this.selectBool(eq, () => {
        g(b, res);
      });
      op(b, ELSE);
      // arr/clo: identity — compare the data pointers.
      this.selectBool(eq, () => {
        g(b, 0);
        ld(b, 8);
        g(b, 1);
        ld(b, 8);
        op(b, EQ);
      });
      op(b, END); // str
      op(b, END); // num/bool
      op(b, END); // unit
      op(b, END); // at != bt
    }
    // $box(x: f64) -> i32: allocate a num cell.
    const box = new Fn(1);
    box.typeIdx = T_F_I;
    {
      const b = box.body;
      const cell = box.i32();
      i32c(b, 16);
      op(b, CALL);
      b.lebU(F_ALLOC);
      st(b, cell);
      g(b, cell);
      i32c(b, TAG_NUM);
      strd(b, 0);
      g(b, cell);
      g(b, 0); // f64 param
      st64(b, 8);
      g(b, cell);
    }
    return [alloc, truthy, eq, box];
  }

  // --- static layout ---------------------------------------------------------

  place(bytes: number[], align: number): number {
    const off = (this.data.b.length + (align - 1)) & ~(align - 1);
    while (this.data.b.length < off) this.data.b.push(0);
    this.data.bytes(bytes);
    return off;
  }

  placeCell(tag: number, dataF64: number, dataI32: number): number {
    const ab = new ArrayBuffer(16);
    const dv = new DataView(ab);
    dv.setInt32(0, tag, true);
    if (tag === TAG_NUM || tag === TAG_BOOL) dv.setFloat64(8, dataF64, true);
    else dv.setInt32(8, dataI32, true);
    return this.place([...new Uint8Array(ab)], 8);
  }

  placeStrBlock(s: string): number {
    const off = this.place([s.length & 0xff, (s.length >> 8) & 0xff, 0, 0], 4);
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      this.data.b.push(u & 0xff, (u >> 8) & 0xff);
    }
    return off;
  }

  layoutStatics(builtin0: number): void {
    // Fixed cells first (the host knows these offsets).
    this.placeCell(TAG_BOOL, 1, 0); // TRUE_CELL = 0
    this.placeCell(TAG_BOOL, 0, 0); // FALSE_CELL = 16
    this.placeCell(TAG_UNIT, 0, 0); // UNIT_CELL = 32
    // PI constant cell.
    this.piOff = this.placeCell(TAG_NUM, Math.PI, 0);
    // Builtin closures: clo block {fn_idx, frame: 0, fsize} + a cell per name.
    for (let i = 0; i < BUILTINS.length; i++) {
      const bi = BUILTINS[i];
      const fni = builtin0 + i;

      const blk = this.place([
        fni & 0xff, (fni >> 8) & 0xff, (fni >> 16) & 0xff, (fni >> 24) & 0xff,
        0, 0, 0, 0,
        bi.params & 0xff, 0, 0, 0,
      ], 4);
      this.cloOffsets.set(bi.name, this.placeCell(TAG_CLO, 0, blk));
    }
    // PI is a float *value* (the checker types it `float`, not `() -> float`),
    // so bind the name to the constant cell, not to a closure.
    this.cloOffsets.set("PI", this.piOff);
    // Number literals.
    for (const [v] of this.numLits) {
      this.numLits.set(v, this.placeCell(TAG_NUM, v, 0));
    }
    // String literals (field names included — same constant pool).
    for (const [v] of this.strLits) {
      const blk = this.placeStrBlock(v);
      this.strLits.set(v, this.placeCell(TAG_STR, 0, blk));
    }
  }

  // --- expression emission ---------------------------------------------------

  resolve(sc: Scope, name: string): {d: number, i: number} | null {
    let d = 0;
    let s: Scope | null = sc;
    while (s !== null) {
      const i = s.map.get(name);
      if (i !== undefined) return {d, i};
      if (s.parent !== null && s.parent.frame !== s.frame) d++;
      s = s.parent;
    }
    return null;
  }

  // Leaves the cell pointer of `name` on the stack ($fp is local 0).
  emitSym(f: Fn, sc: Scope, name: string): void {
    const b = f.body;
    const r = this.resolve(sc, name);
    if (r !== null) {
      g(b, 0);
      for (let k = 0; k < r.d; k++) ld(b, 0); // walk parent frames
      ld(b, 8 + 4 * r.i);
      return;
    }
    const clo = this.cloOffsets.get(name);
    if (clo !== undefined) {
      i32c(b, clo);
      return;
    }
    throw new WasmError(`Unbound symbol: ${name}`);
  }

  // Calls the closure in local `fc`; argEmit(k, ffp) stores argument k into
  // the fresh frame at local ffp. Leaves the result cell on the stack — or,
  // when `tail`, returns the callee's result from the enclosing function
  // directly (return_call_indirect, so tail recursion uses O(1) stack).
  emitCallClosure(f: Fn, fc: number, argc: number, argEmit: (k: number, ffp: number) => void, tail = false): void {
    const b = f.body;
    const clob = f.i32(), idx = f.i32(), cf = f.i32(), fs = f.i32(), ffp = f.i32();
    g(b, fc);
    ld(b, 8);
    st(b, clob);
    g(b, clob);
    ld(b, 0);
    st(b, idx);
    g(b, clob);
    ld(b, 4);
    st(b, cf);
    g(b, clob);
    ld(b, 8);
    st(b, fs);
    // size = 8 + 4 * max(fs, argc) — fs/argc pushed twice: once as the
    // select operands, once for the comparison.
    g(b, fs);
    i32c(b, argc);
    g(b, fs);
    i32c(b, argc);
    op(b, GTU);
    op(b, SELECT);
    i32c(b, 4);
    op(b, MUL);
    i32c(b, 8);
    op(b, ADD);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, ffp);
    g(b, ffp);
    g(b, cf);
    strd(b, 0); // parent
    g(b, ffp);
    i32c(b, argc);
    strd(b, 4); // argc
    for (let k = 0; k < argc; k++) argEmit(k, ffp);
    g(b, ffp);
    g(b, idx);
    op(b, tail ? RETURN_CALL_INDIRECT : CALL_INDIRECT);
    b.lebU(T_I_I);
    b.lebU(0);
  }

  // Calls ef_fail(code, namePtr, a, b); the import throws, so unreachable.
  emitFail(f: Fn, code: number, namePtr: number, pushA: () => void, pushB: () => void): void {
    const b = f.body;
    i32c(b, code);
    i32c(b, namePtr);
    pushA();
    pushB();
    op(b, CALL);
    b.lebU(HOST_IMPORTS.indexOf("ef_fail"));
    op(b, 0x00); // unreachable
  }

  constF64 = (f: Fn, x: number) => () => f64c(f.body, x);

  // String concatenation of cells in locals a, b → new str cell on stack.
  emitStrCat(f: Fn, a: number, b: number): void {
    const body = f.body;
    const ab = f.i32(), bb = f.i32(), la = f.i32(), lb = f.i32(), blk = f.i32(), cell = f.i32();
    g(body, a);
    ld(body, 8);
    st(body, ab);
    g(body, b);
    ld(body, 8);
    st(body, bb);
    g(body, ab);
    ld(body, 0);
    st(body, la);
    g(body, bb);
    ld(body, 0);
    st(body, lb);
    // str block: {len: la+lb, units...}
    i32c(body, 4);
    g(body, la);
    g(body, lb);
    op(body, ADD);
    i32c(body, 2);
    op(body, MUL);
    op(body, ADD);
    op(body, CALL);
    body.lebU(F_ALLOC);
    st(body, blk);
    g(body, blk);
    g(body, la);
    g(body, lb);
    op(body, ADD);
    strd(body, 0);
    // copy a then b (b starts at unit offset la)
    const copy = (src: number, dstUnits: number | null, len: number) => {
      this.loop(f, () => {
        g(f.body, len);
      }, i => {
        // dst unit address: blk + 4 + 2*(dst + i)
        g(f.body, blk);
        i32c(f.body, 4);
        op(f.body, ADD);
        if (dstUnits !== null) {
          g(f.body, dstUnits);
          i32c(f.body, 2);
          op(f.body, MUL);
          op(f.body, ADD);
        }
        g(f.body, i);
        i32c(f.body, 2);
        op(f.body, MUL);
        op(f.body, ADD);
        // src unit address: src + 4 + 2*i
        g(f.body, src);
        i32c(f.body, 4);
        op(f.body, ADD);
        g(f.body, i);
        i32c(f.body, 2);
        op(f.body, MUL);
        op(f.body, ADD);
        ld16(f.body, 0);
        st16(f.body, 0);
      });
    };
    copy(ab, null, la);
    copy(bb, la, lb);
    i32c(body, 16);
    op(body, CALL);
    body.lebU(F_ALLOC);
    st(body, cell);
    g(body, cell);
    i32c(body, TAG_STR);
    strd(body, 0);
    g(body, cell);
    g(body, blk);
    strd(body, 8);
    g(body, cell);
  }

  // for (i = 0; i < n; i++) iter(i) — n pushed by pushN (const or local).
  // Emits BLOCK { LOOP { cond; br_if out; iter; incr; br; } }.
  loop(f: Fn, pushN: () => void, iter: (i: number) => void): void {
    const b = f.body;
    const i = f.i32();
    op(b, BLOCK);
    b.u8(0x40);
    op(b, LOOP);
    b.u8(0x40);
    g(b, i);
    pushN();
    op(b, GEU);
    op(b, BR_IF);
    b.lebU(1);
    iter(i);
    g(b, i);
    i32c(b, 1);
    op(b, ADD);
    st(b, i);
    op(b, BR);
    b.lebU(0);
    op(b, END);
    op(b, END);
  }

  // Address of element i (local) of array block local `blk` on the stack.
  elemAddr(f: Fn, blk: number, i: number): void {
    const b = f.body;
    g(b, blk);
    i32c(b, 8);
    op(b, ADD);
    g(b, i);
    i32c(b, 4);
    op(b, MUL);
    op(b, ADD);
  }

  // Allocates an array block of length local `n`; returns the block local.
  allocArrBlk(f: Fn, n: number): number {
    const b = f.body;
    const blk = f.i32();
    g(b, n);
    i32c(b, 4);
    op(b, MUL);
    i32c(b, 8);
    op(b, ADD);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, blk);
    g(b, blk);
    g(b, n);
    strd(b, 0);
    return blk;
  }

  // Boxes the array block local `blk` → new arr cell on the stack.
  boxArr(f: Fn, blk: number): void {
    const b = f.body;
    const cell = f.i32();
    i32c(b, 16);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, cell);
    g(b, cell);
    i32c(b, TAG_ARR);
    strd(b, 0);
    g(b, cell);
    g(b, blk);
    strd(b, 8);
    g(b, cell);
  }

  // Copies n (local) elements from srcBlk's elements starting at srcOff into
  // a fresh array block; leaves the boxed cell on the stack.
  emitArrCopy(f: Fn, srcBlk: number, srcOff: number, n: number): void {
    const b = f.body;
    const blk = this.allocArrBlk(f, n);
    this.loop(f, () => {
      g(b, n);
    }, i => {
      this.elemAddr(f, blk, i);
      g(b, srcBlk);
      i32c(b, 8 + 4 * srcOff);
      op(b, ADD);
      g(b, i);
      i32c(b, 4);
      op(b, MUL);
      op(b, ADD);
      ld(b, 0);
      strd(b, 0);
    });
    this.boxArr(f, blk);
  }

  // true_cell/false_cell selected by the i32 condition emitted by emitCond.
  selectBool(f: Fn, emitCond: () => void): void {
    const b = f.body;
    const t = f.i32();
    emitCond();
    st(b, t);
    i32c(b, TRUE_CELL);
    i32c(b, FALSE_CELL);
    g(b, t);
    op(b, SELECT);
  }

  // The main expression emitter. Leaves exactly one i32 (cell pointer).
  expr(id: ExprID, f: Fn, sc?: Scope, tail = false): void {
    const e = this.nodes[id];
    // Lambda/block nodes carry their own scope; other nodes inherit sc.
    const s = this.scopes.get(id) ?? sc;
    if (s === undefined) throw new WasmError(`internal: no scope for node ${id} (${e.t})`);
    const b = f.body;
    switch (e.t) {
      case "num":
        i32c(b, this.numLits.get(e.v)!);
        break;
      case "str":
        i32c(b, this.strLits.get(e.v)!);
        break;
      case "bool":
        i32c(b, e.v ? TRUE_CELL : FALSE_CELL);
        break;
      case "unit":
        i32c(b, UNIT_CELL);
        break;
      case "sym":
        this.emitSym(f, s, e.v);
        break;
      case "lambda": {
        // clo block {fn_idx, frame, fsize} then cell {TAG_CLO, clo}
        const blk = f.i32(), cell = f.i32();
        i32c(b, 12);
        op(b, CALL);
        b.lebU(F_ALLOC);
        st(b, blk);
        g(b, blk);
        i32c(b, this.lambdaIdx.get(id)!);
        strd(b, 0);
        g(b, blk);
        g(b, 0); // captured frame = current $fp
        strd(b, 4);
        g(b, blk);
        i32c(b, this.scopes.get(id)!.frame.slots); // params + body lets
        strd(b, 8);
        i32c(b, 16);
        op(b, CALL);
        b.lebU(F_ALLOC);
        st(b, cell);
        g(b, cell);
        i32c(b, TAG_CLO);
        strd(b, 0);
        g(b, cell);
        g(b, blk);
        strd(b, 8);
        g(b, cell);
        break;
      }
      case "let": {
        // Binds in the current frame (mirrors the interpreter: the binding
        // exists before the value is computed, so `let x = x` sees null).
        const slot = s.map.get(e.name)!;
        const v = f.i32();
        this.expr(e.val, f, s);
        st(b, v);
        g(b, 0);
        g(b, v);
        strd(b, 8 + 4 * slot);
        i32c(b, UNIT_CELL);
        break;
      }
      case "dlet": {
        const arr = f.i32(), blk = f.i32();
        this.expr(e.val, f, s);
        st(b, arr);
        g(b, arr);
        ld(b, 8);
        st(b, blk);
        for (let k = 0; k < e.fields.length; k++) {
          const slot = s.map.get(e.fields[k].name)!;
          const v = f.i32();
          g(b, blk);
          ld(b, 8 + 4 * k);
          st(b, v);
          g(b, 0);
          g(b, v);
          strd(b, 8 + 4 * slot);
        }
        i32c(b, UNIT_CELL);
        break;
      }
      case "assign": {
        const r = this.resolve(s, e.name);
        if (r === null) throw new WasmError(`Assignment to unbound symbol: ${e.name}`);
        const v = f.i32();
        this.expr(e.val, f, s);
        st(b, v);
        g(b, 0);
        for (let k = 0; k < r.d; k++) ld(b, 0);
        g(b, v);
        strd(b, 8 + 4 * r.i);
        i32c(b, UNIT_CELL);
        break;
      }
      case "if": {
        this.expr(e.c, f, s);
        op(b, CALL);
        b.lebU(F_TRUTHY);
        op(b, IF);
        b.u8(0x7f); // result i32
        this.expr(e.a, f, s, tail);
        op(b, ELSE);
        this.expr(e.b, f, s, tail);
        op(b, END);
        break;
      }
      case "while": {
        op(b, BLOCK);
        b.u8(0x40);
        op(b, LOOP);
        b.u8(0x40);
        this.expr(e.c, f, s);
        op(b, CALL);
        b.lebU(F_TRUTHY);
        op(b, EQZ);
        op(b, BR_IF);
        b.lebU(1);
        this.expr(e.body, f, s);
        drp(b);
        op(b, BR);
        b.lebU(0);
        op(b, END);
        op(b, END);
        i32c(b, UNIT_CELL);
        break;
      }
      case "block": {
        for (let k = 0; k < e.stmts.length; k++) {
          this.expr(e.stmts[k], f, s, tail && k === e.stmts.length - 1);
          if (k < e.stmts.length - 1) drp(b);
        }
        if (e.stmts.length === 0) i32c(b, UNIT_CELL);
        break;
      }
      case "arr": {
        const blk = f.i32();
        i32c(b, 8 + 4 * e.elems.length);
        op(b, CALL);
        b.lebU(F_ALLOC);
        st(b, blk);
        g(b, blk);
        i32c(b, e.elems.length);
        strd(b, 0);
        for (let k = 0; k < e.elems.length; k++) {
          g(b, blk);
          i32c(b, 8 + 4 * k);
          op(b, ADD);
          this.expr(e.elems[k], f, s);
          strd(b, 0);
        }
        this.boxArr(f, blk);
        break;
      }
      case "field": {
        const o = f.i32(), blk = f.i32();
        this.expr(e.obj, f, s);
        st(b, o);
        g(b, o);
        ld(b, 8);
        st(b, blk);
        // len <= idx → out of bounds
        g(b, blk);
        ld(b, 0);
        i32c(b, e.idx!);
        op(b, LEU);
        op(b, IF);
        b.u8(0x40);
        this.emitFail(
          f, 2, this.strLits.get(e.name)!,
          this.constF64(f, e.idx!),
          this.constF64(f, -1),
        );
        op(b, END);
        g(b, blk);
        ld(b, 8 + 4 * e.idx!);
        break;
      }
      case "perform": {
        const spec =
          (EFFECT_IMPORTS as Record<string, {imp: string, zeroArgs?: boolean} | undefined>)[e.op];
        if (spec === undefined) {
          throw new WasmError(
            `wasm target: user effect ops are not supported (op '${e.op}'); only builtin ` +
            "effects (Read/Write/Println/Out/Exit/Wait/Random) can reach the host",
          );
        }
        if (spec.zeroArgs !== true) {
          for (const a of e.args) this.expr(a, f, s);
        }
        op(b, tail ? RETURN_CALL : CALL);
        b.lebU(HOST_IMPORTS.indexOf(spec.imp));
        break;
      }
      case "handle":
        throw new WasmError(
          "wasm target: 'handle' is not supported (multi-shot continuations); " +
          "builtin effects reach the host unhandled instead",
        );
      case "app":
        this.emitApp(id, f, s, tail);
        break;
    }
  }

  emitApp(id: ExprID, f: Fn, s: Scope, tail = false): void {
    const e = this.nodes[id];
    if (e.t !== "app") throw new WasmError("internal: not an app node");
    const b = f.body;
    // `/` is stamped by the checker (int vs float truncation).
    const fn = this.nodes[e.fn];
    if (fn.t === "sym" && fn.v === "/") {
      const a = f.i32(), bv = f.i32();
      this.expr(e.args[0], f, s);
      st(b, a);
      this.expr(e.args[1], f, s);
      st(b, bv);
      g(b, a);
      ld64(b, 8);
      g(b, bv);
      ld64(b, 8);
      op(b, FDIV);
      if (e.div === "int") op(b, FTRUNC);
      op(b, tail ? RETURN_CALL : CALL); // return_call / call
      b.lebU(F_BOX);
      return;
    }
    const fc = f.i32();
    this.expr(e.fn, f, s);
    st(b, fc);
    this.emitCallClosure(f, fc, e.args.length, (k, ffp) => {
      g(b, ffp);
      i32c(b, 8 + 4 * k);
      op(b, ADD);
      this.expr(e.args[k], f, s);
      strd(b, 0);
    }, tail);
  }

  // --- builtin trampolines ---------------------------------------------------

  slot(f: Fn, i: number): void {
    g(f.body, 0);
    ld(f.body, 8 + 4 * i);
  }

  slotF64(f: Fn, i: number): number {
    const l = f.f64();
    this.slot(f, i);
    ld64(f.body, 8);
    st(f.body, l);
    return l;
  }

  emitBuiltins(builtin0: number): Fn[] {
    const out: Fn[] = [];
    for (const {name} of BUILTINS) {
      const f = new Fn(1);
      const b = f.body;
      const box = () => {
        op(b, CALL);
        b.lebU(F_BOX);
      };
      switch (name) {
        case "+": {
          const a = f.i32(), bv = f.i32(), at = f.i32(), bt = f.i32();
          this.slot(f, 0);
          st(b, a);
          this.slot(f, 1);
          st(b, bv);
          g(b, a);
          ld(b, 0);
          st(b, at);
          g(b, bv);
          ld(b, 0);
          st(b, bt);
          g(b, at);
          i32c(b, TAG_NUM);
          op(b, EQ);
          g(b, bt);
          i32c(b, TAG_NUM);
          op(b, EQ);
          op(b, AND);
          op(b, IF);
          b.u8(0x7f);
          g(b, a);
          ld64(b, 8);
          g(b, bv);
          ld64(b, 8);
          op(b, FADD);
          box();
          op(b, ELSE);
          g(b, at);
          i32c(b, TAG_STR);
          op(b, EQ);
          g(b, bt);
          i32c(b, TAG_STR);
          op(b, EQ);
          op(b, AND);
          op(b, IF);
          b.u8(0x7f);
          this.emitStrCat(f, a, bv);
          op(b, ELSE);
          i32c(b, UNIT_CELL);
          op(b, END);
          op(b, END);
          break;
        }
        case "-": {
          const x = this.slotF64(f, 0), y = this.slotF64(f, 1);
          g(b, x);
          g(b, y);
          op(b, FSUB);
          box();
          break;
        }
        case "*": {
          const x = this.slotF64(f, 0), y = this.slotF64(f, 1);
          g(b, x);
          g(b, y);
          op(b, FMUL);
          box();
          break;
        }
        case "%": {
          // JS fmod: a - b * trunc(a/b)
          const x = this.slotF64(f, 0), y = this.slotF64(f, 1), t = f.f64();
          g(b, x);
          g(b, y);
          op(b, FDIV);
          op(b, FTRUNC);
          st(b, t);
          g(b, x);
          g(b, y);
          g(b, t);
          op(b, FMUL);
          op(b, FSUB);
          box();
          break;
        }
        case "neg": {
          const x = this.slotF64(f, 0);
          g(b, x);
          op(b, FNEG);
          box();
          break;
        }
        case "<":
        case ">":
        case "<=":
        case ">=": {
          const x = this.slotF64(f, 0), y = this.slotF64(f, 1);
          const cmp = name === "<" ? FLT : name === ">" ? FGT : name === "<=" ? FLE : FGE;
          this.selectBool(f, () => {
            g(b, x);
            g(b, y);
            op(b, cmp);
          });
          break;
        }
        case "==": {
          this.slot(f, 0);
          this.slot(f, 1);
          op(b, CALL);
          b.lebU(F_EQ);
          break;
        }
        case "!=": {
          this.slot(f, 0);
          this.slot(f, 1);
          op(b, CALL);
          b.lebU(F_EQ);
          ld64(b, 8); // eq result cell's bool payload
          f64c(b, 0);
          op(b, FEQ); // 1 when $eq said false
          op(b, IF);
          b.u8(0x7f);
          i32c(b, TRUE_CELL);
          op(b, ELSE);
          i32c(b, FALSE_CELL);
          op(b, END);
          break;
        }
        case "not": {
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(F_TRUTHY);
          op(b, EQZ);
          this.selectBool(f, () => {});
          break;
        }
        case "list": {
          const n = f.i32();
          g(b, 0);
          ld(b, 4); // argc
          st(b, n);
          const blk = this.allocArrBlk(f, n);
          this.loop(f, () => {
            g(b, n);
          }, i => {
            this.elemAddr(f, blk, i);
            g(b, 0); // $fp
            g(b, i);
            i32c(b, 4);
            op(b, MUL);
            i32c(b, 8);
            op(b, ADD);
            ld(b, 0);
            strd(b, 0);
          });
          this.boxArr(f, blk);
          break;
        }
        case "head": {
          const blk = f.i32();
          this.slot(f, 0);
          ld(b, 8);
          st(b, blk);
          g(b, blk);
          ld(b, 0);
          op(b, EQZ);
          op(b, IF);
          b.u8(0x40);
          this.emitFail(f, 0, 0, this.constF64(f, 0), this.constF64(f, 0));
          op(b, END);
          g(b, blk);
          ld(b, 8);
          break;
        }
        case "tail": {
          const blk = f.i32(), len = f.i32(), n1 = f.i32();
          this.slot(f, 0);
          ld(b, 8);
          st(b, blk);
          g(b, blk);
          ld(b, 0);
          st(b, len);
          g(b, len);
          op(b, EQZ);
          op(b, IF);
          b.u8(0x7f);
          i32c(b, 0);
          op(b, ELSE);
          g(b, len);
          i32c(b, 1);
          op(b, SUB);
          op(b, END);
          st(b, n1);
          this.emitArrCopy(f, blk, 1, n1);
          break;
        }
        case "concat": {
          const aBlk = f.i32(), bBlk = f.i32(), la = f.i32(), lb = f.i32(), n = f.i32();
          this.slot(f, 0);
          ld(b, 8);
          st(b, aBlk);
          this.slot(f, 1);
          ld(b, 8);
          st(b, bBlk);
          g(b, aBlk);
          ld(b, 0);
          st(b, la);
          g(b, bBlk);
          ld(b, 0);
          st(b, lb);
          g(b, la);
          g(b, lb);
          op(b, ADD);
          st(b, n);
          const blk = this.allocArrBlk(f, n);
          this.loop(f, () => {
            g(b, la);
          }, i => {
            this.elemAddr(f, blk, i);
            this.elemAddr(f, aBlk, i);
            ld(b, 0);
            strd(b, 0);
          });
          this.loop(f, () => {
            g(b, lb);
          }, i => {
            this.elemAddr(f, blk, i);
            g(b, la);
            i32c(b, 4);
            op(b, MUL);
            op(b, ADD);
            this.elemAddr(f, bBlk, i);
            ld(b, 0);
            strd(b, 0);
          });
          this.boxArr(f, blk);
          break;
        }
        case "flat": {
          const xss = f.i32(), n = f.i32(), total = f.i32();
          this.slot(f, 0);
          ld(b, 8);
          st(b, xss);
          g(b, xss);
          ld(b, 0);
          st(b, n);
          i32c(b, 0);
          st(b, total);
          this.loop(f, () => {
            g(b, n);
          }, k => {
            this.elemAddr(f, xss, k);
            ld(b, 0); // inner arr cell
            ld(b, 8); // inner block
            ld(b, 0); // inner len
            g(b, total);
            op(b, ADD);
            st(b, total);
          });
          const blk = this.allocArrBlk(f, total);
          const w = f.i32();
          i32c(b, 0);
          st(b, w);
          this.loop(f, () => {
            g(b, n);
          }, k => {
            const xb = f.i32(), xl = f.i32();
            this.elemAddr(f, xss, k);
            ld(b, 0);
            ld(b, 8);
            st(b, xb);
            g(b, xb);
            ld(b, 0);
            st(b, xl);
            this.loop(f, () => {
              g(b, xl);
            }, j => {
              this.elemAddr(f, blk, w);
              i32c(b, 4);
              op(b, ADD);
              g(b, w);
              i32c(b, 4);
              op(b, MUL);
              op(b, ADD);
              this.elemAddr(f, xb, j);
              ld(b, 0);
              strd(b, 0);
              g(b, w);
              i32c(b, 1);
              op(b, ADD);
              st(b, w);
            });
          });
          this.boxArr(f, blk);
          break;
        }
        case "len": {
          this.slot(f, 0);
          ld(b, 8);
          ld(b, 0);
          op(b, CONV_I32);
          box();
          break;
        }
        case "strlen": {
          this.slot(f, 0);
          ld(b, 8);
          ld(b, 0);
          op(b, CONV_I32);
          box();
          break;
        }
        case "PI":
          i32c(b, this.piOff);
          break;
        case "cos":
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(HOST_IMPORTS.indexOf("ef_cos"));
          break;
        case "sin":
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(HOST_IMPORTS.indexOf("ef_sin"));
          break;
        case "sqrt": {
          const x = this.slotF64(f, 0);
          g(b, x);
          op(b, FSQRT);
          box();
          break;
        }
        case "abs": {
          const x = this.slotF64(f, 0);
          g(b, x);
          op(b, FABS);
          box();
          break;
        }
        case "round": {
          const x = this.slotF64(f, 0);
          g(b, x);
          f64c(b, 0.5);
          op(b, FADD);
          op(b, FFLOOR);
          box();
          break;
        }
        case "range": {
          const s = this.slotF64(f, 0), e = this.slotF64(f, 1), stepv = this.slotF64(f, 2);
          const n = f.i32();
          g(b, stepv);
          f64c(b, 0);
          op(b, FEQ);
          op(b, IF);
          b.u8(0x7f);
          i32c(b, 0);
          op(b, ELSE);
          g(b, e);
          g(b, s);
          op(b, FSUB);
          g(b, stepv);
          op(b, FDIV);
          op(b, FCEIL);
          f64c(b, 0);
          op(b, FGT);
          op(b, IF);
          b.u8(0x7f);
          g(b, e);
          g(b, s);
          op(b, FSUB);
          g(b, stepv);
          op(b, FDIV);
          op(b, FCEIL);
          op(b, TRUNC_F64);
          op(b, ELSE);
          i32c(b, 0);
          op(b, END);
          op(b, END);
          st(b, n);
          const blk = this.allocArrBlk(f, n);
          this.loop(f, () => {
            g(b, n);
          }, k => {
            this.elemAddr(f, blk, k);
            g(b, s);
            g(b, k);
            op(b, CONV_I32);
            g(b, stepv);
            op(b, FMUL);
            op(b, FADD);
            box();
            strd(b, 0);
          });
          this.boxArr(f, blk);
          break;
        }
        case "char":
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(HOST_IMPORTS.indexOf("ef_char"));
          break;
        case "number":
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(HOST_IMPORTS.indexOf("ef_number"));
          break;
        case "args":
          op(b, CALL);
          b.lebU(HOST_IMPORTS.indexOf("ef_args"));
          break;
        case "get": {
          const blk = f.i32(), len = f.i32(), idx = f.i32();
          const idxF = this.slotF64(f, 1);
          this.slot(f, 0);
          ld(b, 8);
          st(b, blk);
          g(b, blk);
          ld(b, 0);
          st(b, len);
          g(b, idxF);
          op(b, TRUNC_F64);
          st(b, idx);
          g(b, idx);
          i32c(b, 0);
          op(b, LTS); // idx < 0
          g(b, idx);
          g(b, len);
          op(b, GEU); // idx >= len
          op(b, OR);
          op(b, IF);
          b.u8(0x40);
          this.emitFail(f, 1, 0, () => {
            g(b, idxF);
          }, () => {
            g(b, len);
            op(b, CONV_I32);
          });
          op(b, END);
          this.elemAddr(f, blk, idx);
          ld(b, 0);
          break;
        }
        case "set": {
          const xs = f.i32(), blk = f.i32(), len = f.i32(), idx = f.i32(), v = f.i32();
          const idxF = this.slotF64(f, 1);
          this.slot(f, 0);
          st(b, xs);
          g(b, xs);
          ld(b, 8);
          st(b, blk);
          g(b, blk);
          ld(b, 0);
          st(b, len);
          g(b, idxF);
          op(b, TRUNC_F64);
          st(b, idx);
          this.slot(f, 2);
          st(b, v);
          g(b, idx);
          g(b, len);
          op(b, 0x49); // i32.lt_u: idx < len → in-place
          op(b, IF);
          b.u8(0x40);
          this.elemAddr(f, blk, idx);
          g(b, v);
          strd(b, 0);
          op(b, ELSE);
          // grow: new block of len idx+1, copy old, fill holes with unit
          const nb = f.i32(), nlen = f.i32();
          g(b, idx);
          i32c(b, 1);
          op(b, ADD);
          st(b, nlen);
          g(b, nlen);
          i32c(b, 4);
          op(b, MUL);
          i32c(b, 8);
          op(b, ADD);
          op(b, CALL);
          b.lebU(F_ALLOC);
          st(b, nb);
          g(b, nb);
          g(b, nlen);
          strd(b, 0);
          this.loop(f, () => {
            g(b, nlen);
          }, k => {
            this.elemAddr(f, nb, k);
            g(b, k);
            g(b, len);
            op(b, 0x49); // k < old len → copy
            op(b, IF);
            b.u8(0x7f);
            this.elemAddr(f, blk, k);
            ld(b, 0);
            op(b, ELSE);
            i32c(b, UNIT_CELL);
            op(b, END);
            strd(b, 0);
          });
          this.elemAddr(f, nb, idx);
          g(b, v);
          strd(b, 0);
          g(b, xs);
          g(b, nb);
          strd(b, 8); // point the cell at the new block
          op(b, END);
          i32c(b, UNIT_CELL);
          break;
        }
        case "map":
        case "each":
        case "flatmap":
          this.emitMapLike(f, name);
          break;
        default:
          throw new WasmError(`internal: builtin ${name} not implemented`);
      }
      out.push(f);
    }
    return out;
  }

  // map/each/flatmap: callbacks invoked through the same call_indirect path.
  emitMapLike(f: Fn, name: string): void {
    const b = f.body;
    const fc = f.i32(), xb = f.i32(), n = f.i32();
    this.slot(f, 0);
    st(b, fc);
    this.slot(f, 1);
    ld(b, 8);
    st(b, xb);
    g(b, xb);
    ld(b, 0);
    st(b, n);
    const callWith = (argc: number, argLocal: (k: number) => (() => void) | null) => {
      this.emitCallClosure(f, fc, argc, (k, ffp) => {
        g(b, ffp);
        i32c(b, 8 + 4 * k);
        op(b, ADD);
        const push = argLocal(k);
        if (push !== null) push();
        strd(b, 0);
      });
    };
    if (name === "map") {
      const res = this.allocArrBlk(f, n);
      const out = f.i32();
      this.loop(f, () => {
        g(b, n);
      }, i => {
        const elem = f.i32();
        this.elemAddr(f, xb, i);
        ld(b, 0);
        st(b, elem);
        callWith(1, k => (k === 0 ? () => g(b, elem) : null));
        st(b, out);
        this.elemAddr(f, res, i);
        g(b, out);
        strd(b, 0);
      });
      this.boxArr(f, res);
      return;
    }
    if (name === "each") {
      this.loop(f, () => {
        g(b, n);
      }, i => {
        const elem = f.i32();
        this.elemAddr(f, xb, i);
        ld(b, 0);
        st(b, elem);
        callWith(2, k => {
          if (k === 0) return () => g(b, elem);
          return () => {
            g(b, i);
            op(b, CONV_I32);
            op(b, CALL);
            b.lebU(F_BOX);
          };
        });
        drp(b);
      });
      i32c(b, UNIT_CELL);
      return;
    }
    // flatmap: two passes — collect per-element arrays, then copy.
    const tmp = this.allocArrBlk(f, n);
    const arrCell = f.i32();
    this.loop(f, () => {
      g(b, n);
    }, i => {
      const elem = f.i32();
      this.elemAddr(f, xb, i);
      ld(b, 0);
      st(b, elem);
      callWith(2, k => {
        if (k === 0) return () => g(b, elem);
        return () => {
          g(b, i);
          op(b, CONV_I32);
          op(b, CALL);
          b.lebU(F_BOX);
        };
      });
      st(b, arrCell);
      this.elemAddr(f, tmp, i);
      g(b, arrCell);
      strd(b, 0);
    });
    const total = f.i32();
    i32c(b, 0);
    st(b, total);
    this.loop(f, () => {
      g(b, n);
    }, i => {
      this.elemAddr(f, tmp, i);
      ld(b, 0);
      ld(b, 0);
      g(b, total);
      op(b, ADD);
      st(b, total);
    });
    const res = this.allocArrBlk(f, total);
    const w = f.i32();
    i32c(b, 0);
    st(b, w);
    this.loop(f, () => {
      g(b, n);
    }, i => {
      const xb2 = f.i32(), xl = f.i32();
      this.elemAddr(f, tmp, i);
      ld(b, 0);
      ld(b, 8);
      st(b, xb2);
      g(b, xb2);
      ld(b, 0);
      st(b, xl);
      this.loop(f, () => {
        g(b, xl);
      }, j => {
        this.elemAddr(f, res, w);
        i32c(b, 4);
        op(b, ADD);
        g(b, w);
        i32c(b, 4);
        op(b, MUL);
        op(b, ADD);
        this.elemAddr(f, xb2, j);
        ld(b, 0);
        strd(b, 0);
        g(b, w);
        i32c(b, 1);
        op(b, ADD);
        st(b, w);
      });
    });
    this.boxArr(f, res);
  }

  // --- main & assembly -------------------------------------------------------

  emitMain(f: Fn): void {
    const b = f.body;
    // Allocate the global frame into local 0 ($fp convention).
    i32c(b, 8 + 4 * this.globalFrame.slots);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, 0);
    g(b, 0);
    i32c(b, 0);
    strd(b, 0); // parent = 0
    g(b, 0);
    i32c(b, 0);
    strd(b, 4); // argc = 0
    const exprs = this.prog.items.filter((it): it is {e: ExprID} => "e" in it);
    if (exprs.length === 0) {
      i32c(b, UNIT_CELL);
      return;
    }
    for (let k = 0; k < exprs.length; k++) {
      this.expr(exprs[k].e, f, this.globalScope);
      if (k < exprs.length - 1) drp(b);
    }
  }

  assemble(): Uint8Array {
    // type section
    const typeSection = new Buf();
    typeSection.lebU(5);
    const emitType = (params: number[]) => {
      typeSection.u8(0x60);
      typeSection.lebU(params.length);
      for (const p of params) typeSection.u8(p);
      typeSection.lebU(1);
      typeSection.u8(0x7f);
    };
    emitType([0x7f]);                   // T0 (i32) -> i32
    emitType([]);                       // T1 () -> i32
    emitType([0x7f, 0x7f, 0x7c, 0x7c]); // T2 (i32,i32,f64,f64) -> i32
    emitType([0x7c]);                   // T3 (f64) -> i32
    emitType([0x7f, 0x7f]);             // T4 (i32,i32) -> i32

    // import section
    const impSection = new Buf();
    impSection.lebU(HOST_IMPORTS.length);
    for (const n of HOST_IMPORTS) {
      impSection.name("env");
      impSection.name(n);
      impSection.u8(0x00);
      impSection.lebU(impType(n));
    }

    // function section
    const fnSection = new Buf();
    fnSection.lebU(this.funcs.length);
    for (const f of this.funcs) fnSection.lebU(f.typeIdx);

    // table
    const tableSection = new Buf();
    tableSection.lebU(1);
    tableSection.u8(0x70); // funcref
    tableSection.u8(0x00);
    tableSection.lebU(HOST_IMPORTS.length + this.funcs.length);

    // memory
    const pages = Math.max(1, Math.ceil(this.hp0 / 65536)) + 16;
    const memSection = new Buf();
    memSection.lebU(1);
    memSection.u8(0x00);
    memSection.lebU(pages);

    // global $hp
    const globalSection = new Buf();
    globalSection.lebU(1);
    globalSection.u8(0x7f);
    globalSection.u8(0x01);
    globalSection.u8(0x41);
    globalSection.lebS(this.hp0);
    globalSection.u8(0x0b);

    // exports: mem, run, __hp
    const mainIdx = HOST_IMPORTS.length + this.funcs.length - 1;
    const expSection = new Buf();
    expSection.lebU(3);
    expSection.name("mem");
    expSection.u8(0x02);
    expSection.lebU(0);
    expSection.name("run");
    expSection.u8(0x00);
    expSection.lebU(mainIdx);
    expSection.name("__hp");
    expSection.u8(0x03);
    expSection.lebU(0);

    // element segment: identity mapping table slot i → func i
    const total = HOST_IMPORTS.length + this.funcs.length;
    const elemSection = new Buf();
    elemSection.lebU(1);
    elemSection.u8(0x00);
    elemSection.u8(0x41);
    elemSection.lebS(0);
    elemSection.u8(0x0b);
    elemSection.lebU(total);
    for (let i = 0; i < total; i++) elemSection.lebU(i);

    // code section
    const codeSection = new Buf();
    codeSection.lebU(this.funcs.length);
    for (const f of this.funcs) {
      const locals = new Buf();
      // Group consecutive same-type allocations.
      const groups: [number, number][] = [];
      let last: [number, number] | undefined;
      for (const ty of f.locals) {
        if (last !== undefined && last[1] === ty) last[0]++;
        else {
          last = [1, ty];
          groups.push(last);
        }
      }
      locals.lebU(groups.length);
      for (const [count, type] of groups) {
        locals.lebU(count);
        locals.u8(type);
      }
      const body = new Buf();
      body.bytes(locals.b);
      body.bytes(f.body.b);
      body.u8(0x0b);
      codeSection.lebU(body.b.length);
      codeSection.bytes(body.b);
    }

    // data section
    const dataSection = new Buf();
    dataSection.lebU(1);
    dataSection.u8(0x00);
    dataSection.u8(0x41);
    dataSection.lebS(0);
    dataSection.u8(0x0b);
    dataSection.lebU(this.data.b.length);
    dataSection.bytes(this.data.b);

    const mod = new Buf();
    mod.bytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const sec = (id: number, payload: Buf) => {
      mod.u8(id);
      mod.lebU(payload.b.length);
      mod.bytes(payload.b);
    };
    sec(1, typeSection);
    sec(2, impSection);
    sec(3, fnSection);
    sec(4, tableSection);
    sec(5, memSection);
    sec(6, globalSection);
    sec(7, expSection);
    sec(9, elemSection);
    sec(10, codeSection);
    sec(11, dataSection);
    return new Uint8Array(mod.b);
  }
}

// --- host runtime ------------------------------------------------------------

function hostBox(inst: WebAssembly.Instance, v: Value): number {
  const mem = new DataView((inst.exports.mem as WebAssembly.Memory).buffer);
  const hpGlobal = inst.exports.__hp as WebAssembly.Global;
  const alloc = (n: number): number => {
    const p = hpGlobal.value as number;
    hpGlobal.value = p + ((n + 7) & ~7);
    return p;
  };
  if (v === null) return UNIT_CELL;
  if (typeof v === "boolean") return v ? TRUE_CELL : FALSE_CELL;
  if (typeof v === "number") {
    const cell = alloc(16);
    mem.setInt32(cell, TAG_NUM, true);
    mem.setFloat64(cell + 8, v, true);
    return cell;
  }
  if (typeof v === "string") {
    const cell = alloc(16);
    const blk = alloc(4 + 2 * v.length);
    mem.setInt32(blk, v.length, true);
    for (let i = 0; i < v.length; i++) mem.setUint16(blk + 4 + 2 * i, v.charCodeAt(i), true);
    mem.setInt32(cell, TAG_STR, true);
    mem.setInt32(cell + 8, blk, true);
    return cell;
  }
  if (Array.isArray(v)) {
    const cell = alloc(16);
    const elems = v.map(x => hostBox(inst, x));
    const blk = alloc(8 + 4 * elems.length);
    mem.setInt32(blk, elems.length, true);
    for (let i = 0; i < elems.length; i++) mem.setInt32(blk + 8 + 4 * i, elems[i], true);
    mem.setInt32(cell, TAG_ARR, true);
    mem.setInt32(cell + 8, blk, true);
    return cell;
  }
  throw new Error("wasm host: cannot box value " + show(v));
}

// Read a cell out of module memory into a JS Value (mirror of the runtime
// representation). Closures come back as an interpreter-Closure-shaped
// marker so show() prints [fn].
function hostUnbox(inst: WebAssembly.Instance, cell: number): Value {
  const mem = new DataView((inst.exports.mem as WebAssembly.Memory).buffer);
  const tag = mem.getInt32(cell, true);
  switch (tag) {
    case TAG_UNIT:
      return null;
    case TAG_NUM:
      return mem.getFloat64(cell + 8, true);
    case TAG_BOOL:
      return mem.getFloat64(cell + 8, true) !== 0;
    case TAG_STR: {
      const blk = mem.getInt32(cell + 8, true);
      const len = mem.getInt32(blk, true);
      let s = "";
      for (let i = 0; i < len; i++) s += String.fromCharCode(mem.getUint16(blk + 4 + 2 * i, true));
      return s;
    }
    case TAG_ARR: {
      const blk = mem.getInt32(cell + 8, true);
      const len = mem.getInt32(blk, true);
      const out: Value[] = [];
      for (let i = 0; i < len; i++) out.push(hostUnbox(inst, mem.getInt32(blk + 8 + 4 * i, true)));
      return out;
    }
    case TAG_CLO:
      return {tag: "fn"} as Value;
  }
  throw new Error(`wasm host: unknown cell tag ${tag}`);
}

function hostStr(inst: WebAssembly.Instance, cell: number): string {
  return hostUnbox(inst, cell) as string;
}

// compile+instantiate+run: the wasm-target twin of eval.ts's run().
export function runWasm(src: string): Value {
  const bytes = compile(src);
  const mod = new WebAssembly.Module(bytes);
  // Assigned after the imports are built (they close over the instance).
  // eslint-disable-next-line prefer-const
  let inst!: WebAssembly.Instance;
  const imports = {
    ef_read: (cell: number) => hostBox(inst, readFileSync(hostStr(inst, cell), "utf8")),
    ef_write: (p: number, c: number) => {
      writeFileSync(hostStr(inst, p), hostStr(inst, c));
      return UNIT_CELL;
    },
    ef_println: (cell: number) => {
      console.log(show(hostUnbox(inst, cell)));
      return UNIT_CELL;
    },
    ef_out: (cell: number) => {
      process.stdout.write(hostStr(inst, cell));
      return UNIT_CELL;
    },
    ef_exit: (cell: number) => process.exit(hostUnbox(inst, cell) as number),
    ef_wait: (cell: number) => {
      sleepSync((hostUnbox(inst, cell) as number) * 1000);
      return UNIT_CELL;
    },
    ef_random: () => hostBox(inst, Math.random()),
    ef_char: (cell: number) =>
      hostBox(inst, String.fromCodePoint((hostUnbox(inst, cell) as number) | 0)),
    ef_number: (cell: number) => hostBox(inst, parseFloat(hostStr(inst, cell))),
    ef_args: () => hostBox(inst, process.argv.slice(2)),
    ef_cos: (cell: number) => hostBox(inst, Math.cos(hostUnbox(inst, cell) as number)),
    ef_sin: (cell: number) => hostBox(inst, Math.sin(hostUnbox(inst, cell) as number)),
    ef_fail: (code: number, namePtr: number, a: number, bnum: number) => {
      if (code === 0) throw new Error("head of empty array");
      if (code === 1) throw new Error(`get: index ${a} out of bounds [0, ${bnum})`);
      throw new Error(`.${hostStr(inst, namePtr)}: index ${a} out of bounds [0, ${bnum})`);
    },
  };
  inst = new WebAssembly.Instance(mod, {env: imports});
  const result = (inst.exports.run as () => number)();
  return hostUnbox(inst, result);
}
