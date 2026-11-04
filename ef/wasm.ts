// wasm.ts — WebAssembly backend for ef.
//
// Pipeline: parse → typecheck (types.ts, reused as-is) → frontend analysis
// (analysis.ts: builtin tree-shaking, op discovery, live imports) → emit a
// binary .wasm module (WasmGC value plane, no linear memory) → binaryen
// shrink pass (optimizeBinary: in-process npm `binaryen`, no external
// tools) → imports and run. No types needed at emission time: the only
// checker output the backend consumes is the runtime stamps the checker
// leaves on nodes (`e.div` for division, `e.idx` for field access).
//
// Subset: everything except suspension across `if`/`while` (a perform or
// handle site inside a branch or loop body is rejected at compile time).
// Every `perform` (builtin or user-declared op) boxes its args into an
// $ELEMS array, spills the args cell to a frame slot, and walks the
// continuation chain for a handler. With no handler in the chain the
// effect reaches the host (which interprets it via the op table
// `compileWithOps` returns) and the rest-of-site fragment continues with
// the resumed value. `handle` installs a K_HDL continuation cell whose
// case table dispatches performed ops to per-case T_KABI functions running
// over the handler's shared hframe (§4.4); every perform/handle site ends
// the inline body and reifies the code after it as a rest-of-site fragment
// via the compile-time split protocol below. Resume as a value (§4.6): the
// resume binder is a $CLO closure over the shared resume fn plus a
// per-perform-site capture record; every call copies the captured slice
// afresh, re-chains the copy's bottom to a fresh HDL whose next is the k
// the closure was invoked with, and dispatches the resumed value through
// that chain (terminating at the caller's continuation).
//
// Representation (WasmGC — every wasm operand value is an anyref):
// - unit = ref.null any; bool = i31ref 0/1; number = $NUM {f64} (immutable
//   struct); string = $STR (mut i16 array, UTF-16 code units, matches JS
//   strlen/char/Out); array/tuple/list = $ARR wrapper {mut (ref null
//   $ELEMS)} over a backing $ELEMS array (growth repoints the wrapper's
//   backing, so aliases share the wrapper and see growth); closure =
//   immutable $CLO {i31 fnIdx, (ref null $FRAME) env, i31 fsize}.
// - Every call frame is a $FRAME {mut (ref null $FRAME) parent, mut (ref
//   null $ELEMS) slots} with slot array length max(fsize, argc); closures
//   capture their defining frame, so escaping/mutable capture works exactly
//   like the interpreter's env chain. Variables resolve statically to
//   (frame depth, slot); a slot read is struct.get $FRAME 1 + array.get.
// - Continuations are $K cells {mut i31 kind, mut a, mut b, mut (ref null
//   $K) next}, mirroring the old 4-word k-cell layout: K_RET{a = i31
//   thunk funcref index, b = frame}, K_HDL{a = $ELEMS case table of flat
//   [opid, fnIdx, fsize, nparams] i31 quadruples (Return case = opid -1),
//   b = hframe}, K_SPILL{a = frozen $FRAME snapshot, b unused}. k = ref.null
//   $K is the final return.
// - All ef functions have uniform T_KABI signature ((ref null $FRAME),
//   (ref null $K)) -> anyref and dispatch through one funcref table via
//   call_indirect. Builtins are trampolines; map/each/flatmap are compiled
//   CPS loops calling callbacks the same way; tail positions keep
//   return_call/return_call_indirect.
// - Static literals (nums, strings, bools, unit, builtin closures, PI,
//   per-handle case tables) are built once by $init into (mut anyref)
//   globals initialized ref.null any; run() calls $init, then main.
// - JS cannot read GC struct fields directly, so the host boundary is 12
//   exported accessor functions (__tag, __num, __str_len, __str_get,
//   __arr_len, __arr_get, __mk_num, __mk_bool, __str_new, __str_set,
//   __arr_new, __arr_set); the host runtime rebuilds interpreter Values
//   through them. Host imports (7): ef_perform, ef_char, ef_number,
//   ef_args, ef_cos, ef_sin, ef_fail — tree-shaken to the live set
//   (ef_fail always live); effects reaching the host flow back through
//   ef_perform and are interpreted by builtins.ts's builtinEffectHosts.
//
// Known deviations vs the interpreter (degenerate programs only):
// - Arithmetic/comparison on non-numbers traps (ref.cast failure) instead
//   of producing a garbage number — frozen decision, pinned by a
//   wasm.test.ts test; the checker rejects non-num arithmetic statically,
//   so well-typed programs never hit it.
// - `set` growing an array fills holes with unit (interpreter: undefined).
// - Closures always display as [fn] (interpreter may show an inferred type).
// - Stack overflow surfaces as a wasm RuntimeError, not a JS RangeError.
// - Heap reclamation is the host GC's job (the old bump heap was never
//   freed; recursion depth no longer costs O(N) unreclaimed bytes).

// (The eval⇄builtins import cycle is runtime-only on both sides — apply is
// called from builtin closures, eval reads the effect interps lazily — so
// module init order is free; no entry-order breaker import needed.)
import {Parser, type Expr, type ExprID, type Program} from "./parser.ts";
import {checkProgram} from "./types.ts";
import {type Value, show} from "./env.ts";
import {builtinEffectHosts} from "./builtins.ts";
import {BUILTINS, EFFECT_OPS, builtinRefs, collectEffectOps, performsAnyOp} from "./analysis.ts";
import binaryen from "binaryen";

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
// GC emit helpers. Heap types are single bytes (i31 0x6c, eq 0x6d, any
// 0x6e) or small type indices — both fit b.u8; never pass them through the
// sleb writer. struct.new pops fields in declaration order; array.set pops
// (arrayref, index, value); array.copy pops (dst, dstOff, src, srcOff, len).
const snew = (b: Buf, t: number) => { b.u8(GC); b.u8(STRUCT_NEW); b.lebU(t); };
const sget = (b: Buf, t: number, fi: number) => { b.u8(GC); b.u8(STRUCT_GET); b.lebU(t); b.u8(fi); };
const sset = (b: Buf, t: number, fi: number) => { b.u8(GC); b.u8(STRUCT_SET); b.lebU(t); b.u8(fi); };
const anew = (b: Buf, t: number) => { b.u8(GC); b.u8(ARRAY_NEW_DEFAULT); b.lebU(t); };
const aget = (b: Buf, t: number) => { b.u8(GC); b.u8(ARRAY_GET); b.lebU(t); };
const agetu = (b: Buf, t: number) => { b.u8(GC); b.u8(ARRAY_GET_U); b.lebU(t); };
const aset = (b: Buf, t: number) => { b.u8(GC); b.u8(ARRAY_SET); b.lebU(t); };
const alen = (b: Buf) => { b.u8(GC); b.u8(ARRAY_LEN); };
const acopy = (b: Buf, d: number, s: number) => { b.u8(GC); b.u8(ARRAY_COPY); b.lebU(d); b.lebU(s); };
const i31ref = (b: Buf) => { b.u8(GC); b.u8(REF_I31); };
const i31get = (b: Buf) => { b.u8(GC); b.u8(I31_GET_S); };
const rnull = (b: Buf, ht: number) => { b.u8(REF_NULL); b.u8(ht); };
const refeq = (b: Buf) => op(b, REF_EQ);
const rtestn = (b: Buf, ht: number) => { b.u8(GC); b.u8(REF_TEST); b.u8(ht); };   // ref.test (ref ht)
const rtest = (b: Buf, ht: number) => { b.u8(GC); b.u8(REF_TEST_NULL); b.u8(ht); }; // ref.test (ref null ht)
const rcastn = (b: Buf, ht: number) => { b.u8(GC); b.u8(REF_CAST); b.u8(ht); };   // ref.cast (ref ht)
const rcast = (b: Buf, ht: number) => { b.u8(GC); b.u8(REF_CAST_NULL); b.u8(ht); }; // ref.cast (ref null ht)
const gget = (b: Buf, gi: number) => { b.u8(0x23); b.lebU(gi); }; // global.get
const selt = (b: Buf, vt: number[] = [ANYREF]) => { // typed select
  b.u8(0x1c);
  b.lebU(vt.length);
  for (const v of vt) b.u8(v);
};
// i32 arithmetic/comparison
const ADD = 0x6a, SUB = 0x6b, MUL = 0x6c, SHL = 0x74, SHRU = 0x76;
const EQZ = 0x45, EQ = 0x46, NE = 0x47, LTS = 0x48, OR = 0x72, AND = 0x71;
const GTU = 0x4b, LEU = 0x4d, GEU = 0x4f, DIVU = 0x6e;
// f64 arithmetic/comparison
const FABS = 0x99, FNEG = 0x9a, FCEIL = 0x9b, FFLOOR = 0x9c, FTRUNC = 0x9d, FSQRT = 0x9f;
const FADD = 0xa0, FSUB = 0xa1, FMUL = 0xa2, FDIV = 0xa3;
const FLT = 0x63, FGT = 0x64, FLE = 0x65, FGE = 0x66, FEQ = 0x61;
const TRUNC_F64 = 0xaa, CONV_I32 = 0xb7; // i32.trunc_f64_s, f64.convert_i32_s
const CALL = 0x10, CALL_INDIRECT = 0x11, RETURN_CALL = 0x12, RETURN_CALL_INDIRECT = 0x13, SELECT = 0x1b;
const BR = 0x0c, BR_IF = 0x0d, IF = 0x04, ELSE = 0x05, END = 0x0b, LOOP = 0x03, BLOCK = 0x02;
const RETURN = 0x0f, UNREACHABLE = 0x00;


// --- WasmGC substrate (step 1, additive) -------------------------------------

// Abstract heap types are single valtype bytes, never passed through the sleb
// writer; a concrete (ref null $t) would be 0x63 <sleb $t> (not needed yet).
// Nothing below is consumed by assemble() yet — the GC probe module in
// wasm.test.ts is the sole caller until step 2 wires these into the emitters.
export const ANYREF = 0x6e, EQREF = 0x6d, I31REF = 0x6c, NONEREF = 0x71, FUNCREF = 0x70;

// GC opcodes: 0xFB-prefixed instructions carry a sub-opcode (single byte for
// the values here) followed by typeidx/heaptype immediates. REF_NULL/REF_EQ/
// SELECT_TYPED are plain (unprefixed) opcodes; SELECT_TYPED takes a vec of
// valtypes instead of the untyped 0x1b form.
export const GC = 0xfb;
export const STRUCT_NEW = 0x00, STRUCT_GET = 0x02, STRUCT_SET = 0x05;
export const ARRAY_NEW_DEFAULT = 0x07, ARRAY_GET = 0x0b, ARRAY_GET_U = 0x0d,
  ARRAY_SET = 0x0e, ARRAY_LEN = 0x0f, ARRAY_COPY = 0x11;
export const REF_TEST = 0x14, REF_TEST_NULL = 0x15, REF_CAST = 0x16, REF_CAST_NULL = 0x17;
export const REF_I31 = 0x1c, I31_GET_S = 0x1d, I31_GET_U = 0x1e;
export const REF_NULL = 0xd0, REF_EQ = 0xd3, SELECT_TYPED = 0x1c;

// GC-only type builder with structural dedup: identical struct/array/func
// shapes share one type index. Arrays have NO field count — 0x5E <st> <mut>.
// assemble()'s hand-written emitType calls are untouched; step 2 unifies.
export class GcTypes {
  private byt = new Map<string, number>();
  private ents: Buf[] = [];
  private intern(emit: (b: Buf) => void): number {
    const b = new Buf();
    emit(b);
    const key = b.b.join(",");
    const hit = this.byt.get(key);
    if (hit !== undefined) return hit;
    this.byt.set(key, this.ents.length);
    this.ents.push(b);
    return this.ents.length - 1;
  }
  struct(fields: [number, boolean][]): number {
    return this.intern(b => {
      b.u8(0x5f).lebU(fields.length);
      for (const [st, mut] of fields) b.u8(st).u8(mut ? 1 : 0);
    });
  }
  array(st: number, mut: boolean): number {
    return this.intern(b => b.u8(0x5e).u8(st).u8(mut ? 1 : 0));
  }
  func(params: number[], results: number[]): number {
    return this.intern(b => {
      b.u8(0x60).lebU(params.length);
      for (const p of params) b.u8(p);
      b.lebU(results.length);
      for (const r of results) b.u8(r);
    });
  }
  section(): Buf {
    const s = new Buf();
    s.lebU(this.ents.length);
    for (const e of this.ents) s.bytes(e.b);
    return s;
  }
}

// $init scaffolding (§5 statics): mutable anyref globals initialized
// ref.null any, plus an empty $init function envelope the caller fills. Step
// 2 wires both into assemble() ($init runs at the top of run()).
export class GcStatics {
  readonly init = new Fn(0);
  private gs: Buf[] = [];
  global(): number {
    this.gs.push(new Buf().u8(ANYREF).u8(1).u8(REF_NULL).u8(ANYREF).u8(0x0b));
    return this.gs.length - 1;
  }
  section(): Buf {
    const s = new Buf();
    s.lebU(this.gs.length);
    for (const gl of this.gs) s.bytes(gl.b);
    return s;
  }
}

// --- module-level constants -------------------------------------------------


// k-cell kinds (i31 in the $K.kind field). K_RET: a = i31 thunk funcref
// index, b = the frame the thunk runs over. K_HDL: a = $ELEMS case table of
// flat [opid, fnIdx, fsize, nparams] i31 quadruples (the Return case is
// opid -1), b = the handler frame (hframe). K_SPILL: a = frozen $FRAME
// snapshot (per-capture operand snapshot), b unused; it sits between a
// split site's RET cell and the ambient chain so only that site's rest
// fragment sees it (its prologue loads a and skips the cell before
// dispatching).
const K_RET = 0, K_HDL = 1, K_SPILL = 2;

// map/each/flatmap invoke user callbacks, so they are called land-style: a
// map-like call site is a landCalls split site (§3) and the builtin loops
// through per-iteration thunks instead of an inline wasm loop.
const MAP_LIKE = new Set(["map", "each", "flatmap"]);
// Extra entry-frame words a map-like builtin needs beyond its args: the
// result/tmp array (except each) and the iteration counter.
const mapLikeFrameWords = (name: string): number =>
  name === "each" ? 1 : MAP_LIKE.has(name) ? 2 : 0;

const HOST_IMPORTS = [
  "ef_perform",
  "ef_char", "ef_number", "ef_args", "ef_cos", "ef_sin", "ef_fail",
];

// Type section indices — assemble() emits exactly this order: structs/
// arrays 0..6 ($NUM, $ELEMS, $STR, $ARR, $FRAME, $K, $CLO), then func
// types 7..23. Shared shapes dedupe by position: 7 () -> anyref (run +
// ef_args), 8 () -> (), 9 (i32, anyref) -> anyref (ef_perform), 10 (i32,
// anyref, f64, f64) -> () (ef_fail), 11 (anyref) -> anyref (ef_char/
// number/cos/sin), 12 (i32) -> anyref (__mk_bool/__str_new/__arr_new),
// 13 (f64) -> anyref (fBox/__mk_num), 14 (anyref) -> i32 (fTruthy/__tag/
// __str_len/__arr_len), 15 (anyref, anyref) -> anyref (fEq), 16 ((ref null
// $K), (ref null $K)) -> (ref null $K) (fCapture), 17 T_KABI ((ref null
// $FRAME), (ref null $K)) -> anyref, 18 T_III_I ((ref null $FRAME), anyref,
// (ref null $K)) -> anyref; 19..23 are accessor-only shapes named in
// assemble().
const T_RUN = 7, T_INIT = 8, T_PERFORM = 9, T_FAIL = 10, T_STRNUM = 11,
  T_BOX = 13, T_TRUTHY = 14, T_EQ = 15, T_CAPTURE = 16, T_KABI = 17,
  T_III_I = 18;

function impType(n: string): number {
  if (n === "ef_perform") return T_PERFORM;
  if (n === "ef_fail") return T_FAIL;
  if (n === "ef_args") return T_RUN;
  return T_STRNUM;
}

// debug emitter tracing: run with DBGEMIT=1 to log split/thunk internals
// during compile; off (and free) otherwise.
const DBGEMIT = process.env.DBGEMIT === "1";


// --- per-function emitter ---------------------------------------------------

export class Fn {
  body = new Buf();
  locals: number[] = []; // extra locals in allocation order (valtype bytes)
  typeIdx = T_KABI; // program functions share (frame, k) -> i32; helpers may differ
  // Funcref table index (assigned at creation, stable across emission).
  idx = 0;
  constructor(public params: number) {}
  i32(): number { this.locals.push(0x7f); return this.params + this.locals.length - 1; }
  f64(): number { this.locals.push(0x7c); return this.params + this.locals.length - 1; }
  anyref(): number { this.locals.push(ANYREF); return this.params + this.locals.length - 1; }
}

// Emission context: which local holds the ambient continuation cell (1 = a
// T_KABI function's k param, 2 = a rest-of-site fragment's kNext param, any
// other local = a handle's K_HDL cell), plus the not-yet-executed cut path
// when re-emitting a fragment: cut[0] is the child of the current node on
// the path to the split site; an empty array marks the split site itself
// (its value is the fragment's v param). `snap` is the wasm local holding
// the fragment's frozen frame-image pointer (the K_SPILL cell's a): pre-cut
// siblings reload from it instead of the live frame, matching the
// interpreter's frozen CPS accs under multi-shot resume.
type Ctx = {kL: number, cut?: ExprID[], snap?: number};
const INLINE: Ctx = {kL: 1};

// Value-explicit rewrite (stage 1): every expression emitter RETURNS a
// ValueRef instead of leaving a cell pointer on the wasm operand stack.
// 1. ValueRef = one of: const (immediate cell), local (wasm local index,
//    single-use), slot (frame slot: $fp + offset — suspension-stable).
//    Emitters never leave implicit operands on the stack across emitter
//    calls. Short-lived stack use is allowed ONLY inside a helper that
//    fully balances before returning (pushRef materializes a ref onto the
//    stack at its consume point).
// 2. Suspension rule: a ref consumed AFTER a potential suspension point
//    (non-tail call, perform, handle, land) must be a slot or const —
//    materialize locals to frame slots at the split (keepRef; the operand
//    spill map computeSpills fills is the materializer).
// 3. ONE emission shape per node — fresh emission and fragment re-emission
//    (the cut path) share a single body, differing only in the child mode
//    handed to cutChildRef ("post" = evaluate the child now, "cut" = the
//    child continues the fragment, "pre" = reload a pre-cut sibling's
//    spilled value) and in the tail flag (fragment re-emission never
//    tail-calls children). Where fresh and cut shapes remain separate
//    (handle, while, the dispatch-shape if) the difference is structural —
//    the split changes the site itself, not just its children; forcing one
//    shape there would move complexity, not remove it (stage-3/4 ruling).

type ValueRef =
  | {k: "g", gi: number}   // static anyref global (filled by $init)
  | {k: "bool", v: 0 | 1}  // i31 bool
  | {k: "local", l: number}   // anyref local (single-use)
  | {k: "slot", i: number}    // frame slot i of local 0's frame
  | {k: "snapSlot", snap: number, i: number}; // frozen-frame slot (fragment re-emission)


// Compile-time split signal: a perform/handle site or a non-builtin call
// site ended the inline wasm body (return_call into a case function, the
// after-site fragment, or the host boundary). The rest of the enclosing body is compiled once into
// `restFn` (T_III_I: frame, v, kNext) by the enclosing body-level catcher
// (bodyCatch/emitMain), which re-emits from the body root along `chain` —
// the AST path from that root down to the split site — skipping everything
// before the cut at each level and reloading spilled values.
//
// Stage 4: this machinery stays. The control-flow sites still throw —
// handle (fresh and body-cut), perform, the dispatch-shape if, while
// (entry, cond-cut, re-entry) — and the non-builtin call/land site
// constructs a Split and fills it synchronously. Every other node now
// shares one direct/cut body, so a split crossing those nodes only rides
// the `chain` cutStack records; nothing here is dead.
class Split extends Error {
  constructor(
    public restFn: Fn,
    public chain: ExprID[],
  ) { super("internal: compile-time split"); }
}

// The cut-path child check: when re-emitting along a split's chain, the
// --- compiler ---------------------------------------------------------------

type Scope = {
  frame: {slots: number}, // frame identity: changes only at lambda boundaries
  parent: Scope | null,
  map: Map<string, number>,
};

export class WasmError extends Error {}

export function compile(src: string): Uint8Array {
  return compileWithOps(src).bytes;
}

// compile + the effect op table (opid → name) the host needs to interpret
// ef_perform calls. The table is built by the same discovery pass that emits
// the code, so the wasm module and the host agree on op numbering.
export function compileWithOps(src: string): {bytes: Uint8Array, ops: string[]} {
  const c = new Compiler(new Parser(src).parseProgram());
  return {bytes: optimizeBinary(c.compile()), ops: c.effOps};
}

// --- binaryen shrink pass ---------------------------------------------------

// binaryen's typings lag its runtime: the binary reader/dispose paths are raw
// emscripten exports without .d.ts entries. Everything else (Features,
// wrapModule, optimize, emitBinary) is typed.
type RawBinaryen = typeof binaryen & {
  _malloc(n: number): number,
  _free(ptr: number): void,
  stringToAscii(s: string, ptr: number): void, // byte-per-char: latin1 round-trips
  _BinaryenModuleReadWithFeatures(ptr: number, len: number, features: number): number,
  _BinaryenModuleDispose(ptr: number): void,
};

// Feature set to read with: exactly what the emitter emits — WasmGC value
// plane (structs/arrays/i31), funcref table (reference-types) +
// return_call_indirect (tail-call) + MVP basics.
const BIN_FEATURES = binaryen.Features.MVP | binaryen.Features.ReferenceTypes |
  binaryen.Features.GC | binaryen.Features.TailCall |
  binaryen.Features.SignExt | binaryen.Features.MutableGlobals;

// Shrink every compiled module through binaryen (wasm-opt in-process; the
// emscripten module is sync-ready at import). Shrink level 2 alone matches
// -Oz output size on our modules at ~1/3 the cost of full -Oz. dispose/free
// per module keeps the binaryen heap flat across many compiles.
// Binaryen aborts (throws a raw emscripten object) on malformed input — e.g.
// the emitter's invalid-module bugs — so a failed pass is normalized into a
// WasmError. The aborted binaryen heap is not reusable in-process afterwards;
// every current caller either recovers by process exit or never hits this.
// extraFeatures extends the read mask without touching the production set
// (the GC probe test passes binaryen.Features.GC; the rewrite flips the mask
// for real in step 2).
// EF_SKIP_WASM_OPT=1 bypasses the shrink pass: a binaryen abort is total
// (every compile fails until process exit), so there must be an escape
// hatch from day one.
export function optimizeBinary(bytes: Uint8Array, extraFeatures = 0): Uint8Array {
  if (process.env.EF_SKIP_WASM_OPT === "1") return bytes;
  const m = binaryen as RawBinaryen;
  try {
    const latin = Buffer.from(bytes).toString("latin1");
    const ptr = m._malloc(latin.length + 1); // +1: stringToAscii appends a NUL
    m.stringToAscii(latin, ptr);
    const modPtr = m._BinaryenModuleReadWithFeatures(ptr, bytes.length, BIN_FEATURES | extraFeatures);
    try {
      if (modPtr === 0) throw new WasmError("binaryen: failed to read compiled module");
      const mod = m.wrapModule(modPtr);
      m.setOptimizeLevel(0);
      m.setShrinkLevel(2);
      mod.optimize();
      return mod.emitBinary();
    } finally {
      if (modPtr !== 0) m._BinaryenModuleDispose(modPtr);
      m._free(ptr);
    }
  } catch (e) {
    if (e instanceof WasmError) throw e;
    throw new WasmError("binaryen: failed to shrink compiled module");
  }
}

class Compiler {
  nodes: Expr[];
  scopes = new Map<ExprID, Scope>();
  globalFrame = {slots: 0};
  globalScope: Scope = {frame: this.globalFrame, parent: null, map: new Map()};
  // Statics: (mut anyref) globals built once by $init (§5). gcount = global
  // count; initBody = the $init code layoutStatics appends to.
  gcount = 0;
  initBody = new Buf();
  numLits = new Map<number, number>();    // literal value → static global idx
  strLits = new Map<string, number>();    // literal value → static global idx
  cloOffsets = new Map<string, number>(); // builtin name → static $CLO global idx
  funcs: Fn[] = [];
  thunks: Fn[] = []; // land thunks (T_III_I), emitted between builtins and main
  thunk0 = 0;        // funcref table index of the first land thunk
  lambdaIdx = new Map<ExprID, number>();
  // Effect op table: opid (table index) → op name. Seeded with the builtin
  // effects (analysis.ts EFFECT_OPS, builtins.ts table order); compile()
  // interns the program's performed/handled ops after them, and the host
  // maps an opid back to its name via the table `compileWithOps` returns.
  effOps: string[] = [...EFFECT_OPS];
  effOpIds = new Map<string, number>(EFFECT_OPS.map((op, i) => [op, i]));
  // Handler machinery (§4.4): per `handle` node, its op cases (each a
  // T_KABI function over the handler's shared hframe), the explicit Return
  // case if any, the static global idx of its dispatch table (set by
  // layoutStatics; a $ELEMS of flat [opid, fnIdx, fsize, nparams] i31s),
  // and the hframe scope discover() bound the case params/resume names
  // into. Filled by discover().
  hdlCases = new Map<ExprID, {
    cases: {op: string, opid: number, fn: Fn, fsize: number, nparams: number, body: ExprID}[],
    retCase: {fn: Fn, fsize: number, nparams: number, body: ExprID} | null,
    // Default-Return identity fn for handlers without an explicit Return
    // case and with npMax > 0: with nparams = npMax, emitDispatch stashes
    // the Return value at hframe slot npMax + 1 where this fn reads it —
    // the shared npMax=0 identity fn would clobber param/resume slots.
    idRet: Fn | null,
    // Max op-case param count; sizes the hframe and the identity Return fn.
    npMax: number,
    tableOff: number,
    scope: Scope,
  }>();
  // Shared default-Return case function, used only by handlers with npMax 0
  // (created by assignCaseFns): reads the Return value emitDispatch stashed
  // in hframe slot 1 and dispatches it through its k — eval.ts:132's
  // `(v, k2) => k2(v)`.
  identityRet: Fn | null = null;
  // Shared resume-closure fn (§4.6, created by assignCaseFns): the T_KABI
  // fn every perform site's boxed resume binder points at.
  resumeFn: Fn | null = null;
  caseFnTotal = 0;
  // Unit/bool statics (unit = the global's initial ref.null any).
  unitRef: ValueRef = {k: "g", gi: 0};
  trueRef: ValueRef = {k: "g", gi: 0};
  falseRef: ValueRef = {k: "g", gi: 0};
  piG = -1; // PI constant global (only when the program references PI)
  // Builtins the program references as values (OPT_PASSES:
  // treeShakeBuiltins): layoutStatics/emitBuiltins emit only these.
  usedBuiltins = new Set<string>();
  // Live host imports (OPT_PASSES: dropDeadHostImports) — a subset of
  // HOST_IMPORTS in original order — each name's funcref index, and the
  // helper indices derived from the live count. Defined-function indices:
  // helpers first (they always follow the imports), then lambdas, then
  // handler case functions, builtins, main.
  liveImports = [...HOST_IMPORTS];
  impIdx = new Map(HOST_IMPORTS.map((n, i): [string, number] => [n, i]));
  fTruthy = HOST_IMPORTS.length;
  fEq = HOST_IMPORTS.length + 1;
  fBox = HOST_IMPORTS.length + 2;
  fCapture = HOST_IMPORTS.length + 3;
  fLambda0 = HOST_IMPORTS.length + 4;
  // Perform spilling (§4.2): perform node → frame slot of its args cell.
  // The cell must survive the handler walk and stay reachable from the
  // after-perform fragment through the RET cell's frame pointer (cell.b).
  spillOf = new Map<ExprID, number>();
  // Perform/handle node → frame slot of its result value, spilled eagerly
  // whenever the node's value is substituted into a rest-of-site fragment
  // so later splits (and resumes) reload it instead of re-running it. For a
  // handle node this slot holds the installed K_HDL cell until the handle
  // completes (a split inside its body reloads the cell from here).
  valSpill = new Map<ExprID, number>();
  // Impure child node → frame slot of its already-computed value, allocated
  // for children that run before a split deeper in the same expression
  // (sibling operands of enclosing apps/arr literals). Pure children re-emit
  // observably identically; impure ones reload from here instead.
  operandSpill = new Map<ExprID, number>();
  // App nodes whose call is a non-builtin (lambda) call: each is a split
  // site — the caller's body ends at the call and the rest-of-site lives
  // in a land fragment (§3 emitCall). Builtins keep the k=0 trampoline.
  landCalls = new Set<ExprID>();
  // Rest fragments already filled: a handle's after-rest fragment is thrown
  // to fillRest from every fragment re-emission of that handle, but only the
  // first fill must land (later fills would append duplicate code to it).
  filledRests = new Set<Fn>();
  // Enclosing body roots (bodyCatch/emitMain): a split-mode if fills an
  // arm's fragment against the body root its emission is nested in.
  bodyRoots: {stmts: ExprID[], sc: Scope, tail: boolean, savedCut: ExprID[]}[] = [];
  // Handle node → its after-handle rest fragment (T_III_I). Created when the
  // handle installs its cells; filled by the body-level catcher that catches
  // the handle's Split (or, when a perform inside the body split first, by
  // the catcher filling the body fragment's nested split).
  hdlRest = new Map<ExprID, Fn>();
  // Split-mode while node → its loop-entry fragment and after-while rest
  // fragment (§6b). The loop entry re-evaluates the condition each pass; the
  // loop-back cell inside a pass re-enters it, so the continuation chain —
  // not a wasm label — carries the loop across suspension points and a
  // captured (copied) chain resumes mid-iteration correctly. Refreshed on
  // every re-emission of the while (fragments that re-run the loop fresh).
  ctlLoops = new Map<ExprID, {entry: Fn, rest: Fn}>();
  // frame → spill slots appended after its named slots (folded into the
  // lambda's frameSize / the global frame's allocation; see frameSizeOf).
  spillTotals = new Map<{slots: number}, number>();
  // Compile-time emission stack: the AST path currently being emitted
  // within one function body (reset at body boundaries). A split site
  // snapshots it as its fragment's re-emission chain.
  cutStack: ExprID[] = [];

  constructor(public prog: Program) {
    this.nodes = prog.nodes;
  }

  compile(): Uint8Array {
    // Typecheck first: rejects ill-typed programs and stamps the runtime
    // markers this backend reads (`div` on applications of `/`, `idx` on
    // field accesses).
    checkProgram(this.prog);
    // Effect op discovery (analysis.ts): builtin ops are pre-seeded (field
    // init); the program's performed/handled ops intern in first-appearance
    // AST order — before discover(), whose handler records read effOpIds.
    for (const op of collectEffectOps(this.prog))
      if (!this.effOpIds.has(op)) {
        this.effOpIds.set(op, this.effOps.length);
        this.effOps.push(op);
      }
    // 1. Scope discovery: scopes per lambda/block, slot numbering, literals.
    for (const it of this.prog.items) {
      if ("e" in it) this.discover(it.e, this.globalScope);
    }
    // 2. Module-level optimization pipeline: ordered passes over the
    //    analysis results; each pass records facts the emitters consume.
    //    They run before index assignment because helper/lambda/builtin
    //    funcref indices derive from the live import count. (Planned for
    //    this seam: helper-function reachability, function-body dedup.)
    for (const pass of OPT_PASSES)
      pass(this);
    // 2b. Helper funcref indices: helpers always follow the live imports.
    this.fTruthy = this.liveImports.length;
    this.fEq = this.fTruthy + 1;
    this.fBox = this.fTruthy + 2;
    this.fCapture = this.fTruthy + 3;
    this.fLambda0 = this.fTruthy + 4;
    // 2c. Function index assignment (deterministic AST order).
    for (const it of this.prog.items) {
      if ("e" in it) this.assignLambdas(it.e);
    }
    // 2d. Spill slots for perform/handle sites (§4.2/§4.4): each perform
    // gets an args-cell slot and a result-value slot, each handle a
    // result-value slot, folded into the enclosing frame's size (case-body
    // spills go into the handler's hframe).
    this.computeSpills();
    // 2e. Handler case functions: funcref indices + hframe sizes, plus the
    // shared default-Return identity function.
    this.assignCaseFns();
    const builtins = BUILTINS.filter(b => this.usedBuiltins.has(b.name));
    const builtin0 = this.fLambda0 + this.lambdaIdx.size + this.caseFnTotal;
    // Land thunks occupy the table slots between builtins and main.
    this.thunk0 = builtin0 + builtins.length;
    // 3. Static layout: assign global indices + $init code (§5).
    this.layoutStatics(builtin0);
    // 4. Emit code: helpers (right after the live imports), lambdas, builtin
    //    trampolines, then main (last; run/$init/accessors follow in
    //    assemble()).
    this.funcs.push(...this.emitHelpers());
    for (const it of this.prog.items) {
      if ("e" in it) this.emitLambdas(it.e);
    }
    this.emitCaseFns();
    this.funcs.push(...this.emitBuiltins(builtin0));
    const main = new Fn(2);
    this.emitMain(main);
    // Thunks are appended after all emission (emitMain's top-level calls
    // create thunks too); main stays the last program function (exported
    // as run — the run wrapper is assembled after it).
    this.funcs.push(...this.thunks);
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
      case "app": {
        // Mark non-builtin calls as split sites (§3 emitCall); the same
        // predicate the app case/emitCallClosure use for the land convention.
        // map/each/flatmap are builtins but land-style too: their result
        // dispatches through the caller's continuation and a performing
        // callback must see the caller's handler chain.
        // (cloOffsets is only filled at static layout, later than this
        // pass, so match against the BUILTINS name list here.)
        const fne = this.nodes[e.fn];
        const name = fne.t === "sym" ? fne.v : null;
        const isBuiltin = name !== null && this.resolve(sc, name) === null &&
          BUILTINS.some(b => b.name === name);
        if (name === null || !isBuiltin || MAP_LIKE.has(name)) {
          this.landCalls.add(id);
        }
        this.discover(e.fn, sc);
        for (const a of e.args) this.discover(a, sc);
        break;
      }
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
      case "handle": {
        // Size the shared hframe: op params at slots 0..npMax-1 (per matched
        // case, unit-padded), each case's resume binder at slot nparams,
        // the Return param at slot npMax+1 (emitDispatch writes it there
        // via the Return entry's nparams = npMax), spill slots after. (Op
        // ids were interned by collectEffectOps before the passes ran.)
        let npMax = 0;
        for (const c of e.cases) {
          if (c.op === "Return") continue;
          npMax = Math.max(npMax, c.params.length);
        }
        const frame = {slots: 0};
        const hs: Scope = {frame, parent: sc, map: new Map()};
        const cases: {op: string, opid: number, fn: Fn, fsize: number, nparams: number, body: ExprID}[] = [];
        let retCase: {fn: Fn, fsize: number, nparams: number, body: ExprID} | null = null;
        for (const c of e.cases) {
          if (c.op === "Return") {
            hs.map.set(c.params[0].name, npMax + 1);
            hs.map.set(c.resume, npMax);
            retCase = {fn: new Fn(2), fsize: 0, nparams: npMax, body: c.body};
          } else {
            for (let i = 0; i < c.params.length; i++) hs.map.set(c.params[i].name, i);
            hs.map.set(c.resume, c.params.length);
            cases.push({
              op: c.op,
              opid: this.effOpIds.get(c.op)!,
              fn: new Fn(2),
              fsize: 0,
              nparams: c.params.length,
              body: c.body,
            });
          }
        }
        frame.slots = npMax + 2;
        this.hdlCases.set(id, {cases, retCase, idRet: null, npMax, tableOff: 0, scope: hs});
        // The handler body binds into the enclosing frame (it runs inline
        // there); case bodies bind into the hframe.
        this.discover(e.body, sc);
        for (const c of e.cases) this.discover(c.body, hs);
        break;
      }
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
        this.lambdaIdx.set(id, this.fLambda0 + this.lambdaIdx.size);
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
      case "handle":
        this.assignLambdas(e.body);
        for (const c of e.cases) this.assignLambdas(c.body);
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
        const f = new Fn(2);
        // bodyCatch emits the body and its completion dispatch (dead when
        // the body ended in a tail call or split).
        this.bodyCatch(e.body, f, this.scopes.get(id)!, true, INLINE);
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
      case "handle":
        this.emitLambdas(e.body);
        for (const c of e.cases) this.emitLambdas(c.body);
        break;
      case "perform":
        for (const a of e.args) this.emitLambdas(a);
        break;
    }
  }


  // --- body-level split protocol ---------------------------------------------

  // 4b. Handler case function bodies (§4.4). Each case body runs over the
  // handler's shared hframe (its frame param) with k = HDL.next — the
  // two-k rule: the ambient continuation is the one captured OUTSIDE the
  // handler, so a perform inside a case body walks from there and never
  // re-enters its own handler, and a case body finishing normally
  // dispatches straight through it (no Return re-wrap). The identity fns
  // dispatch their frame's Return value (slot 1 for the shared npMax=0 fn,
  // slot npMax+1 for a per-handler fn — where emitDispatch stashes it for
  // the matching nparams) through their k — eval.ts:132's (v, k2) => k2(v).

  // 4b. Handler case function bodies (§4.4). Each case body runs over the
  // handler's shared hframe (its frame param) with k = HDL.next — the
  // two-k rule: the ambient continuation is the one captured OUTSIDE the
  // handler, so a perform inside a case body walks from there and never
  // re-enters its own handler, and a case body finishing normally
  // dispatches straight through it (no Return re-wrap). The identity fns
  // dispatch their frame's Return value (slot 1 for the shared npMax=0 fn,
  // slot npMax+1 for a per-handler fn — where emitDispatch stashes it for
  // the matching nparams) through their k — eval.ts:132's (v, k2) => k2(v).
  emitCaseFns(): void {
    const idf = this.identityRet!;
    {
      const b = idf.body;
      const v = idf.anyref();
      g(b, 0);
      sget(b, 4, 1);
      i32c(b, 1);
      aget(b, 1); // hframe slot 1: the Return value
      st(b, v);
      this.emitDispatch(idf, v);
    }
    this.funcs.push(idf);
    for (const info of this.hdlCases.values()) {
      for (const c of info.cases) {
        this.bodyCatch(c.body, c.fn, info.scope, true, INLINE);
        this.funcs.push(c.fn);
      }
      if (info.retCase !== null) {
        this.bodyCatch(info.retCase.body, info.retCase.fn, info.scope, true, INLINE);
        this.funcs.push(info.retCase.fn);
      } else if (info.idRet !== null) {
        const idr = info.idRet;
        const b = idr.body;
        const v = idr.anyref();
        g(b, 0);
        sget(b, 4, 1);
        i32c(b, info.npMax + 1); // hframe Return slot (nparams = npMax)
        aget(b, 1);
        st(b, v);
        this.emitDispatch(idr, v);
        this.funcs.push(idr);
      }
    }
    // The shared resume closure fn (§4.6): (frame, k) -> anyref. frame's
    // parent is the perform site's capture record {slot 1 = captured slice,
    // slot 2 = matched HDL, slot 3 = the invocation's hframe copy}; frame's
    // slot 0 is the resumed value. Copies the slice afresh (originals
    // untouched — multi-shot safe), re-chains the copy's bottom to a fresh
    // HDL {case table, hframe, next = this call's k} and dispatches the
    // resumed value through the fresh chain: RET cells run the segment's
    // fragments, the fresh HDL's Return entry fires, and dispatch
    // terminates at the caller's continuation.
    const rf = this.resumeFn!;
    {
      const b = rf.body;
      const v = rf.anyref(), rec = rf.anyref(), slice = rf.anyref(), hdl = rf.anyref();
      const copy = rf.anyref(), fresh = rf.anyref(), cur = rf.anyref();
      g(b, 0);
      sget(b, 4, 1);
      i32c(b, 0);
      aget(b, 1);
      st(b, v); // the resumed value: the closure call frame's slot 0
      g(b, 0);
      sget(b, 4, 0); // the capture record (env frame)
      st(b, rec);
      g(b, rec);
      rcast(b, 4);
      sget(b, 4, 1);
      i32c(b, 1);
      aget(b, 1);
      st(b, slice);
      g(b, rec);
      rcast(b, 4);
      sget(b, 4, 1);
      i32c(b, 2);
      aget(b, 1);
      st(b, hdl);
      g(b, slice);
      rcast(b, 5);
      g(b, hdl);
      rcast(b, 5);
      op(b, CALL);
      b.lebU(this.fCapture);
      st(b, copy);
      i32c(b, K_HDL);
      i31ref(b);
      g(b, hdl);
      rcast(b, 5);
      sget(b, 5, 1); // a = the matched handler's case table
      g(b, rec);
      rcast(b, 4);
      sget(b, 4, 1);
      i32c(b, 3);
      aget(b, 1); // b = the invocation's hframe copy (rec slot 3)
      g(b, 1); // next = the k this closure was invoked with
      snew(b, 5);
      st(b, fresh);
      g(b, copy);
      st(b, cur);
      op(b, BLOCK);
      b.u8(0x40);
      op(b, LOOP);
      b.u8(0x40);
      g(b, cur);
      rcast(b, 5);
      sget(b, 5, 3);
      g(b, hdl);
      rcast(b, 5);
      refeq(b);
      op(b, BR_IF);
      b.lebU(1); // cur is the bottom copy (its next is the old HDL)
      g(b, cur);
      rcast(b, 5);
      sget(b, 5, 3);
      st(b, cur);
      op(b, BR);
      b.lebU(0);
      op(b, END);
      op(b, END);
      g(b, cur);
      rcast(b, 5);
      g(b, fresh);
      rcast(b, 5);
      sset(b, 5, 3);
      this.emitDispatch(rf, v, copy); // k = the closure's own k param
    }
    this.funcs.push(rf);
  }

  emitStmtSeq(stmts: ExprID[], f: Fn, sc: Scope, tail: boolean, ctx: Ctx): void {
    const b = f.body;
    if (stmts.length === 0) {
      const v = f.anyref();
      this.pushRef(f, this.unitRef);
      st(b, v);
      this.emitDispatch(f, v, ctx.kL);
      return;
    }
    for (let k = 0; k < stmts.length; k++) {
      const r = this.expr(stmts[k], f, sc, tail && k === stmts.length - 1, ctx);
      if (k === stmts.length - 1) {
        this.pushRef(f, r);
        const v = f.anyref();
        st(b, v);
        this.emitDispatch(f, v, ctx.kL);
      }
    }
  }

  // Emit a lambda/case body, catching the Split of a perform/handle site
  // inside it and filling that site's rest-of-site fragment (see fillRest).
  // Lambda and case bodies are split boundaries: the chain never crosses a
  // lambda call, so each body's catcher owns its sites' fragments.
  bodyCatch(bodyId: ExprID, f: Fn, sc: Scope, tail: boolean, ctx: Ctx): void {
    const savedCut = this.cutStack;
    const bodyE = this.nodes[bodyId];
    const stmts = bodyE.t === "block" ? bodyE.stmts : [bodyId];
    const bsc = this.scopes.get(bodyId) ?? sc;
    this.bodyRoots.push({stmts, sc: bsc, tail, savedCut: [...savedCut]});
    try {
      try {
        this.emitStmtSeq(stmts, f, bsc, tail, ctx);
      } catch (sp) {
        this.cutStack = savedCut;
        if (!(sp instanceof Split)) throw sp;
        this.fillRest(sp, stmts, bsc, tail);
        return;
      }
      this.cutStack = savedCut;
    } finally {
      this.bodyRoots.pop();
    }
  }

  // Fill a split's rest-of-site fragment (T_III_I: frame, v, kNext) by
  // re-emitting from the body root along the split's chain: statements
  // before the cut already executed (skipped; surviving values reload from
  // spill slots), the cut site continues the fragment with its value being
  // the v param, statements after it re-emit inline. A further split during
  // re-emission chains another fragment off this one's split site.
  fillRest(sp: Split, root: ExprID[], sc: Scope, tail: boolean): void {
    const gf = sp.restFn;
    if (DBGEMIT) console.log("FILL_REST fn=", gf.idx, "root=", root.length, "chain=", sp.chain.length, "types=", "[" + sp.chain.map((x) => this.nodes[x]?.t).join(",") + "]", "tail=", tail);
    // A shared after-rest fragment (e.g. a handle's) may be routed here
    // again by a later re-emission of the same site; its content is already
    // correct, so re-filling would only append a duplicate tail.
    if (this.filledRests.has(gf)) return;
    this.filledRests.add(gf);
    const b = gf.body;
    // Prologue: the k param is the split site's K_SPILL cell (see snapWrap)
    // — load its frozen frame-image pointer into the `snap` local (pre-cut
    // operand reloads read it) and continue with the cell's own next. A
    // plain cell (nested-chained fragments whose site ran synchronously)
    // means snap = the live frame (local 0): no operand-spill reload can
    // happen in a fragment whose site never froze one, because such
    // fragments re-emit only post-cut code and pure children re-emit
    // instead of reloading.
    const snap = gf.anyref();
    g(b, 2);
    op(b, 0xd1); // ref.is_null: k = null → nothing froze a snapshot
    op(b, IF);
    b.u8(0x40);
    g(b, 0); // live frame: snapSlot reads hit the frame param
    st(b, snap);
    op(b, ELSE);
    g(b, 2);
    rcast(b, 5);
    sget(b, 5, 0);
    i31get(b);
    i32c(b, K_SPILL);
    op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    g(b, 2);
    rcast(b, 5);
    sget(b, 5, 1); // a = the frozen $FRAME snapshot
    st(b, snap);
    g(b, 2);
    rcast(b, 5);
    sget(b, 5, 3);
    st(b, 2);
    op(b, END);
    op(b, END);
    const ci = root.indexOf(sp.chain[0]);
    if (ci < 0) throw new WasmError("internal: split chain root mismatch");
    const savedCut = this.cutStack;
    try {
      for (let k = 0; k < root.length; k++) {
        if (k < ci) continue; // executed before the split
        const r = (k === ci)
          ? this.expr(sp.chain[0], gf, sc, tail && k === root.length - 1, {kL: 2, cut: sp.chain.slice(1), snap})
          : this.expr(root[k], gf, sc, tail && k === root.length - 1, {kL: 2, snap});
        if (k === root.length - 1) {
          this.pushRef(gf, r);
          const v = gf.anyref();
          st(gf.body, v);
          this.emitDispatch(gf, v, 2); // kNext param
        }
      }
    } catch (sp2) {
      this.cutStack = savedCut;
      if (!(sp2 instanceof Split)) throw sp2;
      // The re-emitted code ended at another split site: this fragment is
      // complete (it ends at that site's host boundary / case invocation);
      // the rest after it chains into the new site's fragment.
      if (DBGEMIT) console.log("  NESTED_SPLIT in fn=", gf.idx, "-> chain=", "[" + sp2.chain.map((x) => this.nodes[x]?.t).join(",") + "]");
      this.fillRest(sp2, root, sc, tail);
      return;
    }
    this.cutStack = savedCut;
  }

  // Fragment re-emission of a statement sequence from a cut statement:
  // statements before index ci already executed (skipped — surviving values
  // reload from spill slots), stmts[ci] continues the fragment with its
  // value being the fragment's v param, statements after it re-emit inline.
  // Returns the last statement's ref; pushRef it where the caller needs the
  // legacy stack operand (handle/while-cut do, block-cut returns it).
  emitStmtsFrom(stmts: ExprID[], f: Fn, s: Scope, ctx: Ctx, ci: number, cut: ExprID[], tail: boolean): ValueRef {
    let r: ValueRef = this.unitRef;
    for (let k = ci; k < stmts.length; k++) {
      r = (k === ci)
        ? this.expr(stmts[k], f, s, tail && k === stmts.length - 1, {kL: ctx.kL, cut: cut.slice(1)})
        : this.expr(stmts[k], f, s, tail && k === stmts.length - 1, {kL: ctx.kL});
    }
    return r;
  }

  // --- helper functions (fixed indices after the live imports) ---------------

  emitHelpers(): Fn[] {
    // $truthy(v: anyref) -> i32: JS truthiness — 0 only for unit (ref.null
    // any) and the bool i31 0 (matches `c !== false && c !== null`); every
    // $NUM (including 0.0), $STR, $ARR and $CLO is truthy.
    const truthy = new Fn(1);
    truthy.typeIdx = T_TRUTHY;
    {
      const b = truthy.body;
      g(b, 0);
      op(b, 0xd1); // ref.is_null
      op(b, IF);
      b.u8(0x7f);
      i32c(b, 0);
      op(b, ELSE);
      g(b, 0);
      rtest(b, I31REF); // ref.test (ref null i31)
      op(b, IF);
      b.u8(0x7f);
      g(b, 0);
      rcastn(b, I31REF);
      i31get(b); // i31.get_u
      op(b, ELSE);
      i32c(b, 1);
      op(b, END);
      op(b, END);
    }
    // $eq(a: anyref, b: anyref) -> anyref bool: JS === — nums by f64
    // payload, bools by i31 payload, strings by i16 content, arrays/
    // tuples/closures by identity (ref.cast (ref null eq) + ref.eq;
    // identity survives `set` growth because growth repoints the wrapper's
    // backing, not the wrapper), unit (null) equal only to unit.
    const eq = new Fn(2);
    eq.typeIdx = T_EQ;
    {
      const b = eq.body;
      const res = eq.i32();
      // decided: a typed path (or the null mismatch) already answered.
      const decided = eq.i32();
      i32c(b, 0);
      st(b, decided);
      // null ladder: equal nulls → true, one null → false.
      g(b, 0);
      op(b, 0xd1);
      g(b, 1);
      op(b, 0xd1);
      op(b, EQ);
      op(b, IF);
      b.u8(0x7f);
      g(b, 0);
      op(b, 0xd1);
      op(b, ELSE);
      i32c(b, 0);
      op(b, END);
      st(b, res);
      // one null, one not: the ladder answered (false).
      g(b, 0);
      op(b, 0xd1);
      g(b, 1);
      op(b, 0xd1);
      op(b, EQ);
      op(b, EQZ);
      st(b, decided);
      // bool == bool: i31 payloads.
      g(b, 0);
      rtest(b, I31REF);
      g(b, 1);
      rtest(b, I31REF);
      op(b, AND);
      op(b, IF);
      b.u8(0x40);
      g(b, 0);
      rcastn(b, I31REF);
      i31get(b);
      g(b, 1);
      rcastn(b, I31REF);
      i31get(b);
      op(b, EQ);
      st(b, res);
      // decided: the bool path answered.
      g(b, 0);
      rtest(b, I31REF);
      g(b, 1);
      rtest(b, I31REF);
      op(b, AND);
      g(b, decided);
      op(b, 0x78); // i32.or
      st(b, decided);
      op(b, END);
      // num == num: f64 payloads.
      g(b, 0);
      rtest(b, 0);
      g(b, 1);
      rtest(b, 0);
      op(b, AND);
      op(b, IF);
      b.u8(0x40);
      g(b, 0);
      rcast(b, 0);
      sget(b, 0, 0);
      g(b, 1);
      rcast(b, 0);
      sget(b, 0, 0);
      op(b, FEQ);
      st(b, res);
      // decided: the num path answered.
      g(b, 0);
      rtest(b, 0);
      g(b, 1);
      rtest(b, 0);
      op(b, AND);
      g(b, decided);
      op(b, 0x78); // i32.or
      st(b, decided);
      op(b, END);
      // str == str: i16 content.
      g(b, 0);
      rtest(b, 2);
      g(b, 1);
      rtest(b, 2);
      op(b, AND);
      op(b, IF);
      b.u8(0x40);
      const la = eq.i32(), lb = eq.i32();
      g(b, 0);
      rcast(b, 2);
      alen(b);
      st(b, la);
      g(b, 1);
      rcast(b, 2);
      alen(b);
      st(b, lb);
      g(b, la);
      g(b, lb);
      op(b, EQ);
      st(b, res);
      this.loop(eq, () => {
        g(b, la);
      }, i => {
        g(b, res);
        g(b, 0);
        rcast(b, 2);
        g(b, i);
        agetu(b, 2);
        g(b, 1);
        rcast(b, 2);
        g(b, i);
        agetu(b, 2);
        op(b, EQ);
        op(b, AND);
        st(b, res);
      });
      op(b, END);
      // Mixed/same-shape-arr/clo → identity (both operands cast through
      // (ref null eq); a nullable cast accepts null but the null ladder
      // already left). Only runs when no typed path answered.
      g(b, decided);
      op(b, EQZ);
      op(b, IF);
      b.u8(0x40);
      g(b, 0);
      rcast(b, EQREF);
      g(b, 1);
      rcast(b, EQREF);
      refeq(b);
      st(b, res);
      op(b, END);
      g(b, res);
      i31ref(b);
    }
    // $box(x: f64) -> anyref: number struct.
    const box = new Fn(1);
    box.typeIdx = T_BOX;
    g(box.body, 0);
    snew(box.body, 0);
    // $captureSlice(k: (ref null $K), until: (ref null $K)) -> (ref null $K):
    // fresh copies of the cells from k up to (excluding) until, each
    // {kind, a, b} verbatim; the bottom copy chains to `until`. Two passes:
    // count (n ≥ 1: the slice always starts at a RET cell), then allocate
    // n cells into a temp $ELEMS and link them (a $K cell is singly linked
    // forward, so the copies are chained bottom-up out of the temp array).
    const capture = new Fn(2);
    capture.typeIdx = T_CAPTURE;
    {
      const b = capture.body;
      const n = capture.i32(), cur = capture.anyref(), tmp = capture.anyref();
      const i = capture.i32(), src = capture.anyref();
      i32c(b, 0);
      st(b, n);
      g(b, 0);
      st(b, cur);
      op(b, BLOCK);
      b.u8(0x40);
      op(b, LOOP);
      b.u8(0x40);
      g(b, cur);
      rcast(b, 5);
      g(b, 1);
      refeq(b);
      op(b, BR_IF);
      b.lebU(1);
      g(b, n);
      i32c(b, 1);
      op(b, ADD);
      st(b, n);
      g(b, cur);
      rcast(b, 5);
      sget(b, 5, 3);
      st(b, cur);
      op(b, BR);
      b.lebU(0);
      op(b, END);
      op(b, END);
      g(b, n);
      anew(b, 1);
      st(b, tmp);
      g(b, 0);
      st(b, src);
      i32c(b, 0);
      st(b, i);
      op(b, BLOCK);
      b.u8(0x40);
      op(b, LOOP);
      b.u8(0x40);
      g(b, i);
      g(b, n);
      op(b, GEU);
      op(b, BR_IF);
      b.lebU(1);
      g(b, tmp);
      rcast(b, 1);
      g(b, i);
      g(b, src);
      rcast(b, 5);
      sget(b, 5, 0);
      g(b, src);
      rcast(b, 5);
      sget(b, 5, 1);
      g(b, src);
      rcast(b, 5);
      sget(b, 5, 2);
      rnull(b, 5);
      snew(b, 5);
      aset(b, 1);
      g(b, i);
      i32c(b, 1);
      op(b, ADD);
      st(b, i);
      g(b, src);
      rcast(b, 5);
      sget(b, 5, 3);
      st(b, src);
      op(b, BR);
      b.lebU(0);
      op(b, END);
      op(b, END);
      i32c(b, 0);
      st(b, i);
      op(b, BLOCK);
      b.u8(0x40);
      op(b, LOOP);
      b.u8(0x40);
      g(b, i);
      g(b, n);
      op(b, GEU);
      op(b, BR_IF);
      b.lebU(1);
      g(b, tmp);
      rcast(b, 1);
      g(b, i);
      aget(b, 1);
      rcast(b, 5);
      g(b, i);
      i32c(b, 1);
      op(b, ADD);
      st(b, i);
      g(b, i);
      g(b, n);
      op(b, GEU);
      op(b, IF);
      b.u8(0x63);
      b.u8(5); // next = until (the bottom of the slice)
      g(b, 1);
      op(b, ELSE);
      g(b, tmp);
      rcast(b, 1);
      g(b, i);
      aget(b, 1);
      rcast(b, 5);
      op(b, END);
      sset(b, 5, 3);
      op(b, BR);
      b.lebU(0);
      op(b, END);
      op(b, END);
      g(b, tmp);
      rcast(b, 1);
      i32c(b, 0);
      aget(b, 1);
      rcast(b, 5);
    }
    return [truthy, eq, box, capture];
  }

  splits(id: ExprID): boolean {
    const e = this.nodes[id];
    switch (e.t) {
      case "perform":
      case "handle":
        return true;
      case "lambda":
        return false;
      case "block":
        return e.stmts.some(st2 => this.splits(st2));
      case "let":
      case "assign":
      case "dlet":
        return this.splits(e.val);
      case "if":
        return this.splits(e.c) || this.splits(e.a) || this.splits(e.b);
      case "while":
        return this.splits(e.c) || this.splits(e.body);
      case "app":
        return this.landCalls.has(id) || this.splits(e.fn) || e.args.some(a => this.splits(a));
      case "arr":
        return e.elems.some(el => this.splits(el));
      case "field":
        return this.splits(e.obj);
      default:
        return false; // num/str/bool/unit/sym
    }
  }

  // Whether re-emitting this node inside a fragment is observationally
  // identical to reloading its value: pure nodes (constants, symbol reads,
  // closure allocations) re-emit; impure ones must reload a spill slot.
  pure(id: ExprID): boolean {
    const e = this.nodes[id];
    switch (e.t) {
      case "num":
      case "str":
      case "bool":
      case "unit":
      case "sym":
      case "lambda":
        return true;
      case "arr":
        return e.elems.every(el => this.pure(el));
      case "field":
        return this.pure(e.obj);
      default:
        return false;
    }
  }

  // One spill slot in `frame` for an operand that runs before a split.
  addOperandSpill(id: ExprID, frame: {slots: number}): void {
    this.operandSpill.set(id, frame.slots + (this.spillTotals.get(frame) ?? 0));
    this.spillTotals.set(frame, (this.spillTotals.get(frame) ?? 0) + 1);
  }

  // Spill slots for perform/handle sites (§4.2/§4.4): each perform gets an
  // args-cell slot and a result-value slot, each handle a cell slot; plus
  // one slot per impure child that runs before a split deeper among its
  // siblings (app fn/args, arr elems, perform args) so the fragment reloads
  // the value instead of re-running it. Case-body spills land in the
  // handler's hframe. Runs after discovery so the named-slot counts are
  // final, before any emission reads a frame size.
  computeSpills(): void {
    const walk = (id: ExprID, frame: {slots: number}): void => {
      const e = this.nodes[id];
      switch (e.t) {
        case "lambda":
          walk(e.body, this.scopes.get(id)!.frame);
          break;
        case "block":
          for (const stmt of e.stmts) walk(stmt, frame);
          break;
        case "let":
        case "assign":
        case "dlet":
          walk(e.val, frame);
          break;
        case "if":
          if (this.splits(e.c) || this.splits(e.a) || this.splits(e.b)) {
            // A split-mode if (splitting arms): the condition reloads in
            // the fragment, and an arm before the cut site reloads too.
            // Every child spills — including pure ones: a multi-shot resume
            // re-runs the fragment after the first resume mutated the frame,
            // so re-emitting a sym/lambda/arr-literal child would observe
            // post-mutation state (or a fresh cell identity) where the
            // interpreter's CPS acc froze the pre-perform value.
            this.addOperandSpill(e.c, frame);
            this.addOperandSpill(e.a, frame);
            this.addOperandSpill(e.b, frame);
          }
          walk(e.c, frame);
          walk(e.a, frame);
          walk(e.b, frame);
          break;
        case "while":
          walk(e.c, frame);
          walk(e.body, frame);
          break;
        case "app": {
          const kids = [e.fn, ...e.args];
          // Any splitting child (land call, perform, handle) ends the
          // inline body: every sibling's value must survive in a spill
          // slot so the fragment reloads it instead of re-running it.
          // Pure children spill too — see the if case (multi-shot freeze).
          if (kids.some(k2 => this.splits(k2))) {
            for (const k2 of kids) {
              this.addOperandSpill(k2, frame);
            }
          }
          for (const k2 of kids) walk(k2, frame);
          break;
        }
        case "arr": {
          const elems = e.elems;
          if (elems.some(el => this.splits(el))) {
            for (const el of elems) {
              this.addOperandSpill(el, frame);
            }
          }
          for (const el of elems) walk(el, frame);
          break;
        }
        case "field":
          walk(e.obj, frame);
          break;
        case "perform": {
          this.spillOf.set(id, frame.slots + (this.spillTotals.get(frame) ?? 0));
          this.spillTotals.set(frame, (this.spillTotals.get(frame) ?? 0) + 1);
          this.valSpill.set(id, frame.slots + (this.spillTotals.get(frame) ?? 0));
          this.spillTotals.set(frame, (this.spillTotals.get(frame) ?? 0) + 1);
          const flags = e.args.map(a => this.splits(a));
          if (flags.some(Boolean)) {
            for (const a of e.args) {
              this.addOperandSpill(a, frame);
            }
          }
          for (const a of e.args) walk(a, frame);
          break;
        }
        case "handle": {
          this.valSpill.set(id, frame.slots + (this.spillTotals.get(frame) ?? 0));
          this.spillTotals.set(frame, (this.spillTotals.get(frame) ?? 0) + 1);
          walk(e.body, frame);
          // Case bodies run over the handler's shared hframe, so their
          // perform spills land there (folded into the table's fsize).
          const info = this.hdlCases.get(id)!;
          for (const c of info.cases) walk(c.body, info.scope.frame);
          if (info.retCase !== null) walk(info.retCase.body, info.scope.frame);
          break;
        }
        default:
          break; // num/str/bool/unit/sym: no children
      }
    };
    for (const it of this.prog.items) {
      if ("e" in it) walk(it.e, this.globalFrame);
    }
  }

  // Frame size of a scope's frame: named slots + perform spill slots (§4.2).
  // Everything that allocates a frame (lambda closure fsize, the global
  // frame in emitMain) must go through this so spilled values fit.
  frameSizeOf(sc: Scope): number {
    return sc.frame.slots + (this.spillTotals.get(sc.frame) ?? 0);
  }

  // 2c. Handler case functions (§4.4): funcref indices + hframe sizes, plus
  // the default-Return identity functions (shared npMax=0 one, per-handler
  // ones for npMax > 0). Case functions run over the handler's shared
  // hframe, so every case of one handler shares its fsize.
  assignCaseFns(): void {
    const idf = new Fn(2);
    idf.idx = this.fLambda0 + this.lambdaIdx.size;
    this.identityRet = idf;
    let next = idf.idx + 1;
    for (const info of this.hdlCases.values()) {
      const fs = this.frameSizeOf(info.scope);
      for (const c of info.cases) {
        c.fn.idx = next++;
        c.fsize = fs;
      }
      if (info.retCase !== null) {
        info.retCase.fn.idx = next++;
        info.retCase.fsize = fs;
      } else if (info.npMax > 0) {
        info.idRet = new Fn(2);
        info.idRet.idx = next++;
      }
    }
    const rf = new Fn(2);
    rf.idx = next++;
    this.resumeFn = rf;
    this.caseFnTotal = next - idf.idx;
  }


  // --- static layout ---------------------------------------------------------

  // Statics live in (mut anyref) globals initialized ref.null any and are
  // built once by $init at run() start (§5): deduped number literals, PI,
  // string literals, true/false i31s, unit, one $CLO per surviving builtin,
  // and per-handle case tables ($ELEMS of flat [opid, fnIdx, fsize,
  // nparams] i31 quadruples). Every static allocates one global index and
  // appends $init code filling it.
  newStatic(): number {
    this.gcount++;
    return this.gcount - 1;
  }

  layoutStatics(builtin0: number): void {
    // Unit: the global's initial ref.null any IS the unit value.
    this.unitRef = {k: "g", gi: this.newStatic()};
    // Bools: i31(0/1), built by $init.
    this.trueRef = {k: "g", gi: this.newStatic()};
    this.falseRef = {k: "g", gi: this.newStatic()};
    const b = this.initBody;
    const gset = (gi: number) => { b.u8(0x24); b.lebU(gi); };
    i32c(b, 1);
    i31ref(b);
    gset(this.trueRef.gi);
    i32c(b, 0);
    i31ref(b);
    gset(this.falseRef.gi);
    // Number literals (deduped by value).
    for (const [v] of this.numLits) {
      const gi = this.newStatic();
      f64c(b, v);
      snew(b, 0);
      gset(gi);
      this.numLits.set(v, gi);
    }
    // PI constant (only when the program references it).
    if (this.usedBuiltins.has("PI")) {
      this.piG = this.newStatic();
      f64c(b, Math.PI);
      snew(b, 0);
      gset(this.piG);
    }
    // String literals (field names included — same constant pool).
    for (const [v] of this.strLits) {
      const gi = this.newStatic();
      i32c(b, v.length);
      anew(b, 2);
      gset(gi);
      for (let i = 0; i < v.length; i++) {
        gget(b, gi);
        rcast(b, 2);
        i32c(b, i);
        i32c(b, v.charCodeAt(i));
        aset(b, 2);
      }
      this.strLits.set(v, gi);
    }
    // Builtin closures: $CLO {fnIdx, env = null, fsize = params + map-like
    // extras} — only referenced builtins get one (OPT_PASSES:
    // treeShakeBuiltins). `list` keeps fsize 0: its slot count is exactly
    // argc, which the trampoline reads back via array.len.
    let i = 0;
    for (const bi of BUILTINS) {
      if (!this.usedBuiltins.has(bi.name)) continue;
      const fni = builtin0 + i++;
      const gi = this.newStatic();
      i32c(b, fni);
      i31ref(b);
      rnull(b, 4); // env: builtins run over the call frame itself
      i32c(b, bi.params + mapLikeFrameWords(bi.name));
      i31ref(b);
      snew(b, 6);
      gset(gi);
      this.cloOffsets.set(bi.name, gi);
    }
    // PI is a float *value* (the checker types it `float`, not
    // `() -> float`), so bind the name to the constant global, not to a
    // closure.
    if (this.usedBuiltins.has("PI")) {
      this.cloOffsets.set("PI", this.piG);
    }
    // Handler case tables (§4.4): flat [opid, fnIdx, fsize, nparams]* i31s.
    // The Return entry (opid -1) always goes last — an explicit case fn when
    // the handler declares one (its nparams = npMax puts the value at slot
    // npMax+1), otherwise an identity fn with matching nparams (the shared
    // npMax=0 fn puts the value at slot 1 where it reads it back; handlers
    // with npMax > 0 get a per-handler fn so param/resume slots stay
    // intact). The perform walk reads these at runtime, so all facts are
    // data, not immediates.
    for (const [hdlId, info] of this.hdlCases) {
      const entries = info.cases.map(c => ({opid: c.opid, fn: c.fn, fsize: c.fsize, nparams: c.nparams}));
      if (info.retCase !== null) {
        entries.push({opid: -1, fn: info.retCase.fn, fsize: info.retCase.fsize, nparams: info.retCase.nparams});
      } else if (info.npMax === 0) {
        entries.push({opid: -1, fn: this.identityRet!, fsize: this.frameSizeOf(info.scope), nparams: 0});
      } else {
        entries.push({opid: -1, fn: info.idRet!, fsize: this.frameSizeOf(info.scope), nparams: info.npMax});
      }
      const words: number[] = [];
      for (const en of entries) words.push(en.opid, en.fn.idx, en.fsize, en.nparams);
      const gi = this.newStatic();
      i32c(b, words.length);
      anew(b, 1);
      gset(gi);
      for (let k = 0; k < words.length; k++) {
        gget(b, gi);
        rcast(b, 1);
        i32c(b, k);
        i32c(b, words[k]);
        i31ref(b);
        aset(b, 1);
      }
      this.hdlCases.get(hdlId)!.tableOff = gi;
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

  // Returns the cell pointer of `name` as a ValueRef: a frame slot for the

  // Returns the anyref value of `name` as a ValueRef: a frame slot for the
  // current frame, a fresh local for parent frames (the frame walk balances
  // its own stack), or a static global for placed closures.
  emitSym(f: Fn, sc: Scope, name: string): ValueRef {
    const b = f.body;
    const r = this.resolve(sc, name);
    if (r !== null) {
      if (r.d === 0) return {k: "slot", i: r.i};
      const v = f.anyref();
      g(b, 0);
      for (let k = 0; k < r.d; k++) sget(b, 4, 0); // walk parent frames (typed field)
      sget(b, 4, 1);
      i32c(b, r.i);
      aget(b, 1);
      st(b, v);
      return {k: "local", l: v};
    }
    const clo = this.cloOffsets.get(name);
    if (clo !== undefined) return {k: "g", gi: clo};
    throw new WasmError(`Unbound symbol: ${name}`);
  }

  // Calls the closure in local `fc`; argEmit(k, ffp) stores argument k into
  // the fresh frame at local ffp. The callee has the uniform CPS ABI
  // (frame, k) -> i32. Leaves the result cell on the stack — or, when `tail`,
  // returns the callee's result from the enclosing function directly
  // (return_call_indirect passing the caller's k through, so tail recursion
  // uses O(1) stack). A non-tail call passes k=0: the callee's dispatch(0, v)
  // returns its result cell inline (today's zero-overhead arithmetic) — or,
  // when `land`, a freshly allocated RET cell {K_RET, landA, $fp, k}:
  // the callee's dispatch tail-calls the land thunk over the caller's frame
  // and k, which dispatches the result into the caller's continuation (k=0
  // here, so the value comes back to this call site and the body continues
  // inline; the rest-of-site fragment machinery is in place for the
  // suspendable constructs of later steps).
  // A RET cell {K_RET, fragIdx, $fp, next} (§3): the continuation cell that
  // tail-calls fragment `fragIdx` (T_III_I) over the caller's frame (local
  // 0). `nextE` pushes the cell's next-pointer operand. Returns the cell.
  retCell(f: Fn, fragIdx: number, nextE: () => void): number {
    const b = f.body;
    const cell = f.anyref();
    i32c(b, K_RET);
    i31ref(b);
    i32c(b, fragIdx);
    i31ref(b);
    g(b, 0); // b = the frame the fragment runs over
    nextE();
    rcast(b, 5);
    snew(b, 5);
    st(b, cell);
    return cell;
  }

  // A K_SPILL cell {K_SPILL, snapshot, null, next} chained in front of a
  // split site's rest fragment. The snapshot freezes the values the rest
  // fragment reloads from operand-spill slots: on the fresh path it is a
  // copy of the current frame image taken at the split site (per capture —
  // this cell is allocated at runtime on every site execution and copied
  // into every continuation captured here, so multi-shot resumes each see
  // the pre-perform values, matching the interpreter's CPS accs); on a
  // fragment re-emission it is the enclosing fragment's snapshot (the same
  // capture's frozen values — nested split sites inside the fragment must
  // not re-freeze the already-mutated frame).
  snapWrap(f: Fn, sc: Scope, ctx: Ctx, nextE: () => void): number {
    const b = f.body;
    const ksp = f.anyref(), snapv = f.anyref();
    if (ctx.snap !== undefined) {
      g(b, ctx.snap);
      st(b, snapv);
    } else {
      // Fresh $FRAME {same parent, slots array copied via array.copy} — the
      // per-capture freeze (shallow slot copy, same as the old block copy).
      g(b, 0); sget(b, 4, 1); alen(b);
      anew(b, 1);
      st(b, snapv);
      g(b, snapv);
      rcast(b, 1);
      i32c(b, 0);
      g(b, 0); sget(b, 4, 1);
      i32c(b, 0);
      g(b, 0); sget(b, 4, 1); alen(b);
      acopy(b, 1, 1);
      g(b, 0); sget(b, 4, 0);
      g(b, snapv);
      rcast(b, 1);
      snew(b, 4);
      st(b, snapv);
    }
    i32c(b, K_SPILL);
    i31ref(b);
    g(b, snapv);
    rnull(b, ANYREF); // b unused (was UNIT_CELL)
    nextE();
    rcast(b, 5);
    snew(b, 5);
    st(b, ksp);
    return ksp;
  }

  emitCallClosure(f: Fn, fc: number, argc: number, argEmit: (k: number, ffp: number) => void, tail = false, land = false, kL = 1, noSplit = false, landA?: number, sc?: Scope, ctx?: Ctx): void {
    const b = f.body;
    const clob = f.anyref(), idx = f.i32(), cf = f.anyref(), fs = f.i32(),
      maxL = f.i32(), slots = f.anyref(), ffp = f.anyref();
    g(b, fc);
    st(b, clob);
    g(b, clob); rcast(b, 6); sget(b, 6, 0); i31get(b);
    st(b, idx);
    g(b, clob); rcast(b, 6); sget(b, 6, 1);
    st(b, cf);
    g(b, clob); rcast(b, 6); sget(b, 6, 2); i31get(b);
    st(b, fs);
    // Slot count = max(fs, argc) — the slots array holds the params and the
    // body's lets (fs) or all the args, whichever is longer. (argc readers
    // use array.len instead of a stored argc field — valid only because the
    // sole argc reader is `list`, whose fsize is 0.)
    g(b, fs);
    i32c(b, argc);
    g(b, fs);
    i32c(b, argc);
    op(b, GTU);
    op(b, SELECT);
    st(b, maxL);
    g(b, maxL);
    anew(b, 1);
    st(b, slots);
    g(b, cf);
    rcast(b, 4);
    g(b, slots);
    rcast(b, 1);
    snew(b, 4); // {parent, slots}
    st(b, ffp);
    for (let k = 0; k < argc; k++) argEmit(k, ffp);
    g(b, ffp);
    rcast(b, 4); // the call's frame param (ffp is an anyref local)
    let splitAt: Split | null = null;
    if (tail) { g(b, kL); rcast(b, 5); } // tail call: pass the ambient continuation through
    else if (land) {
      if (noSplit) {
        // Land-style RET cell ending the caller's body: used inside
        // loop-entry thunks (map-like builtins), where the callback's result
        // lands in the per-iteration thunk `landA` instead of the generic
        // per-site dispatcher and the loop continues from there. The call is
        // a tail call: the callback's completion always tails into landA
        // (never returns here), and a terminal k=0 return must unwind past
        // the whole loop to the caller's own call site.
        g(b, this.retCell(f, landA!, () => g(b, kL))); // next = ambient k
        rcast(b, 5);
      } else {
        // Non-tail lambda call (§3 emitCall): the caller's body ENDS at
        // the call — return_call_indirect with the continuation in the
        // RET cell {K_RET, rest-of-site fragment, caller frame, ambient
        // k}. Direct land emission: the caller's body is complete once the
        // return_call is on the wire, so the rest-of-site fragment is
        // filled HERE, synchronously — no Split is thrown and the
        // body-level catch/replay round-trip is bypassed for these sites
        // (the chain is still what fillRest re-emits; perform/handle/
        // map/while sites keep the throw path until stages 3–4). The
        // caller must keep no pending return address: a handler capture
        // dispatches straight through H.next, and the terminal k=0
        // return must not unwind through this call site. The rest
        // fragment's K_SPILL cell freezes the frame image at the call
        // (pre-cut operand reloads — sibling operands of the call — read
        // the frozen values under multi-shot resume).
        const rest = this.makeRestThunk("handle:after-handle");
        const ksp = this.snapWrap(f, sc!, ctx!, () => g(b, kL));
        g(b, this.retCell(f, rest.idx, () => g(b, ksp))); // next = K_SPILL{frozen frame, ambient k}
        rcast(b, 5);
        if (DBGEMIT) console.log("THROW handle-split cutStack=", this.cutStack.length);
        splitAt = new Split(rest, [...this.cutStack]);
      }
    } else rnull(b, 5); // k=0 (ref.null $K): the callee's dispatch returns its value inline
    g(b, idx);
    op(b, tail || land ? RETURN_CALL_INDIRECT : CALL_INDIRECT); // noSplit land calls tail too (see above)
    b.lebU(T_KABI);
    b.lebU(0);
    if (splitAt !== null) {
      // Fill the rest-of-site fragment directly at the land call site.
      // Cut-stack baseline: the same value the enclosing body-level catcher
      // (bodyCatch/emitMain) restores before its fillRest call, so nested
      // splits during the fill re-discover clean chains from the body root.
      const root = this.bodyRoots[this.bodyRoots.length - 1];
      const savedCut = this.cutStack;
      this.cutStack = [...root.savedCut];
      try {
        this.fillRest(splitAt, root.stmts, root.sc, root.tail);
      } finally {
        this.cutStack = savedCut;
      }
    }
  }

  // One rest-of-site fragment: a T_III_I function (frame, v, kNext) -> i32
  // registered in the funcref table. Filled later by the body-level catcher
  // that catches this site's Split (bodyCatch/emitMain/fillRest).
  makeRestThunk(role?: string): Fn {
    const f = new Fn(3);
    f.typeIdx = T_III_I;
    f.idx = this.thunk0 + this.thunks.length;
    if (DBGEMIT && role !== undefined) console.log("THUNK", f.idx, role);
    this.thunks.push(f);
    return f;
  }

  emitDispatch(f: Fn, v: number, k = 1): void {
    const b = f.body;
    const kind = () => { g(b, k); rcast(b, 5); sget(b, 5, 0); i31get(b); };
    const i31of = () => { rcastn(b, I31REF); i31get(b); }; // anyref → i32 (i31 payload)
    op(b, BLOCK);
    b.u8(ANYREF); // block (result anyref)
    op(b, LOOP);
    b.u8(0x40);
    g(b, k);
    op(b, 0xd1); // ref.is_null: final return → the value itself
    op(b, IF);
    b.u8(0x40);
    g(b, v);
    op(b, BR); b.lebU(2); // leave the block with v
    op(b, END);
    kind(); i32c(b, K_RET); op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    const tbl = f.anyref(), nL = f.i32(), iL = f.i32(), found = f.i32(),
      fnIdx = f.i32(), nparams = f.i32(), ent = f.i32();
    g(b, k); rcast(b, 5); sget(b, 5, 2); rcast(b, 4);
    g(b, v);
    g(b, k); rcast(b, 5); sget(b, 5, 3);
    g(b, k); rcast(b, 5); sget(b, 5, 1); i31of();
    op(b, RETURN_CALL_INDIRECT);
    b.lebU(T_III_I);
    b.lebU(0);
    op(b, END);
    // K_HDL: scan the case table at k.a (a $ELEMS of flat [opid, fnIdx,
    // fsize, nparams] i31 quadruples; the Return case, opid -1, goes last).
    // A K_SPILL cell (a rest fragment's frozen-frame marker) is transparent:
    // it carries no handler — skip it and walk on. Only kind==K_HDL scans.
    kind(); i32c(b, K_HDL); op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    g(b, k); rcast(b, 5); sget(b, 5, 1); st(b, tbl);
    g(b, tbl); rcast(b, 1); alen(b); i32c(b, 4); op(b, DIVU); st(b, nL);
    i32c(b, 0); st(b, found);
    i32c(b, 0); st(b, iL);
    op(b, BLOCK);
    b.u8(0x40);
    op(b, LOOP);
    b.u8(0x40);
    g(b, iL); g(b, nL); op(b, GEU); op(b, BR_IF); b.lebU(1);
    g(b, iL); i32c(b, 4); op(b, MUL); st(b, ent);
    g(b, tbl); rcast(b, 1); g(b, ent); aget(b, 1); i31of();
    i32c(b, -1); op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    i32c(b, 1); st(b, found);
    g(b, tbl); rcast(b, 1); g(b, ent); i32c(b, 1); op(b, ADD); aget(b, 1); i31of(); st(b, fnIdx);
    g(b, tbl); rcast(b, 1); g(b, ent); i32c(b, 3); op(b, ADD); aget(b, 1); i31of(); st(b, nparams);
    op(b, BR); b.lebU(2); // exit the scan block
    op(b, END);
    g(b, iL); i32c(b, 1); op(b, ADD); st(b, iL);
    op(b, BR); b.lebU(0);
    op(b, END);
    op(b, END);
    g(b, found);
    op(b, IF);
    b.u8(0x40);
    // Return case: store v into the hframe's Return param slot, then
    // tail-call the case body as (hframe, k.next); funcref index last.
    g(b, k); rcast(b, 5); sget(b, 5, 2); rcast(b, 4); sget(b, 4, 1);
    g(b, nparams); i32c(b, 1); op(b, ADD);
    g(b, v);
    aset(b, 1);
    g(b, k); rcast(b, 5); sget(b, 5, 2); rcast(b, 4);
    g(b, k); rcast(b, 5); sget(b, 5, 3);
    g(b, fnIdx);
    op(b, RETURN_CALL_INDIRECT);
    b.lebU(T_KABI);
    b.lebU(0);
    op(b, END);
    op(b, END); // kind==K_HDL guard
    // No Return case (or a skipped K_SPILL): k = k.next and dispatch again.
    g(b, k); rcast(b, 5); sget(b, 5, 3); st(b, k);
    op(b, BR); b.lebU(0);
    op(b, END); // loop
    op(b, 0x00); // unreachable: the loop exits only through the k==0 branch
    op(b, END); // block
  }

  // Calls ef_fail(code, name, a, b); the import throws, so unreachable.
  // `name` is a $STR static global index (field-access failures) or null.
  emitFail(f: Fn, code: number, nameG: number | null, pushA: () => void, pushB: () => void): void {
    const b = f.body;
    i32c(b, code);
    if (nameG === null) rnull(b, ANYREF);
    else gget(b, nameG);
    pushA();
    pushB();
    op(b, CALL);
    b.lebU(this.impIdx.get("ef_fail")!);
    op(b, 0x00); // unreachable
  }

  constF64 = (f: Fn, x: number) => () => f64c(f.body, x);

  // String concatenation of $STR locals a, b → new $STR on the stack.
  emitStrCat(f: Fn, a: number, b: number): void {
    const body = f.body;
    const res = f.anyref();
    g(body, a); rcast(body, 2); alen(body);
    g(body, b); rcast(body, 2); alen(body);
    op(body, ADD);
    anew(body, 2);
    st(body, res);
    // copy a then b (b starts at unit offset la)
    g(body, res);
    rcast(body, 2);
    i32c(body, 0);
    g(body, a); rcast(body, 2);
    i32c(body, 0);
    g(body, a); rcast(body, 2); alen(body);
    acopy(body, 2, 2);
    g(body, res);
    rcast(body, 2);
    g(body, a); rcast(body, 2); alen(body);
    g(body, b); rcast(body, 2);
    i32c(body, 0);
    g(body, b); rcast(body, 2); alen(body);
    acopy(body, 2, 2);
    g(body, res);
  }

  // for (i = 0; i < n; i++) iter(i) — n pushed by pushN (const or local).
  // Emits BLOCK { LOOP { cond; br_if out; iter; incr; br; } }.
  loop(f: Fn, pushN: () => void, iter: (i: number) => void): void {
    const b = f.body;
    const i = f.i32();
    i32c(b, 0);
    st(b, i); // reset: a loop nested in another loop's body reuses this local across outer iterations
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

  // Pushes (arrayref, index) of element i (local) of raw $ELEMS local
  // `blk`; callers finish with aget (read) or push the value + aset (write).
  elemAddr(f: Fn, blk: number, i: number): void {
    g(f.body, blk);
    rcast(f.body, 1);
    g(f.body, i);
  }

  // Allocates a raw $ELEMS array of length local `n`; returns the local.
  allocArrBlk(f: Fn, n: number): number {
    const blk = f.anyref();
    g(f.body, n);
    anew(f.body, 1);
    st(f.body, blk);
    return blk;
  }

  // Wraps the raw $ELEMS local `blk` → new $ARR wrapper on the stack.
  // Growth (`set`) repoints the wrapper's backing array, so every alias
  // sharing the wrapper sees the growth (§7.1).
  boxArr(f: Fn, blk: number): void {
    g(f.body, blk);
    rcast(f.body, 1);
    snew(f.body, 3);
  }

  // Copies n (local) elements from srcBlk's elements starting at srcOff into
  // a fresh array; leaves the boxed $ARR wrapper on the stack.
  emitArrCopy(f: Fn, srcBlk: number, srcOff: number, n: number): void {
    const b = f.body;
    const blk = this.allocArrBlk(f, n);
    g(b, blk);
    rcast(b, 1);
    i32c(b, 0);
    g(b, srcBlk);
    rcast(b, 1);
    i32c(b, srcOff);
    g(b, n);
    acopy(b, 1, 1);
    this.boxArr(f, blk);
  }

  // true/false i31 selected by the i32 condition emitted by emitCond.
  selectBool(f: Fn, emitCond: () => void): void {
    const b = f.body;
    const t = f.i32();
    emitCond();
    st(b, t);
    this.pushRef(f, this.trueRef);
    this.pushRef(f, this.falseRef);
    g(b, t);
    selt(b); // typed select (result anyref)
  }

  // Materialize a ValueRef onto the operand stack, at its consume point.
  // This is the ONLY sanctioned place short-lived stack values cross an
  // emitter boundary (the helper fully balances the stack per ref).
  pushRef(f: Fn, r: ValueRef): void {
    const b = f.body;
    if (r.k === "g") gget(b, r.gi);
    else if (r.k === "bool") { i32c(b, r.v); i31ref(b); }
    else if (r.k === "local") g(b, r.l);
    else if (r.k === "snapSlot") { g(b, r.snap); rcast(b, 4); sget(b, 4, 1); i32c(b, r.i); aget(b, 1); }
    else { g(b, 0); sget(b, 4, 1); i32c(b, r.i); aget(b, 1); }
  }

  // Persist a ref into the operand spill slot computeSpills allocated for
  // `id` (if any) and return the slot ref: a value that must survive a
  // later split is read back from the frame by the fragment machinery.
  keepRef(id: ExprID, f: Fn, r: ValueRef): ValueRef {
    const sp = this.operandSpill.get(id);
    if (sp === undefined) return r;
    const b = f.body;
    this.pushRef(f, r);
    const t = f.anyref();
    st(b, t);
    g(b, 0); sget(b, 4, 1); i32c(b, sp); g(b, t); aset(b, 1);
    return {k: "slot", i: sp};
  }

  preCut(id: ExprID, f: Fn, s: Scope, ctx: Ctx): ValueRef {
    const sp = this.operandSpill.get(id) ?? this.valSpill.get(id);
    if (sp !== undefined) {
      if (ctx.snap !== undefined) return {k: "snapSlot", snap: ctx.snap, i: sp};
      return {k: "slot", i: sp};
    }
    return this.expr(id, f, s, false, {kL: ctx.kL, snap: ctx.snap});
  }

  // One child of a cut node, ref-native — also used for fresh emission
  // (mode "post"), so fresh and cut bodies can share one shape.
  // "cut": the child holding the deeper split site — continues the fragment
  // chain (its value is the fragment's v param). "pre": a sibling evaluated
  // BEFORE the cut child — a slot ref into its spill, or re-emit pure code
  // inline (preCut). "post": a sibling evaluated AFTER the cut child (or no
  // cut at all) — re-emit inline, with the caller's tail flag. Persists any
  // mapped operand spill slot.
  cutChildRef(child: ExprID, f: Fn, s: Scope, ctx: Ctx, mode: "cut" | "pre" | "post", tail = false): ValueRef {
    if (mode === "cut") return this.keepRef(child, f, this.expr(child, f, s, false, {kL: ctx.kL, cut: ctx.cut!.slice(1), snap: ctx.snap}));
    if (mode === "pre") return this.keepRef(child, f, this.preCut(child, f, s, ctx));
    return this.keepRef(child, f, this.expr(child, f, s, tail, {kL: ctx.kL, snap: ctx.snap}));
  }

  // The split site is this node itself inside a fragment: its value is the
  // fragment's v param (local 1), persisted for later fragments that reload it.
  fragV(id: ExprID, f: Fn): ValueRef {
    return this.keepRef(id, f, {k: "local", l: 1});
  }

  // The main expression emitter. Returns the expression's cell as a
  // ValueRef — never leaves an implicit operand on the stack (see the
  // value-explicit invariants above the ValueRef type).

  expr(id: ExprID, f: Fn, sc?: Scope, tail = false, ctx: Ctx = INLINE): ValueRef {
    const e = this.nodes[id];
    // Lambda/block nodes carry their own scope; other nodes inherit sc.
    const s = this.scopes.get(id) ?? sc;
    if (s === undefined) throw new WasmError(`internal: no scope for node ${id} (${e.t})`);
    const b = f.body;
    // Cut path: undefined = normal emission; [] = this node is the split
    // site (its value is the fragment's v param); [child, ...] = the child
    // on the path continues the fragment.
    const cut = ctx.cut;
    // A split caught mid-emission (emitIfDispatch filling an arm's Split
    // against the body root) re-emits a node whose own emission frame is
    // still on the cut stack. The chain must stay an AST path — one frame
    // per node — so do not duplicate the frame on re-entry.
    const pushed = this.cutStack[this.cutStack.length - 1] !== id;
    if (pushed) this.cutStack.push(id);
    // try/finally: a child's Split (or error) unwinds through this frame —
    // the push must not survive, or the next Split captures a stale chain
    // whose head re-routes fillRest through the same (already handled)
    // site forever.
    try {
    switch (e.t) {
      case "num":
        return {k: "g", gi: this.numLits.get(e.v)!};
      case "str":
        return {k: "g", gi: this.strLits.get(e.v)!};
      case "bool":
        return {k: "bool", v: e.v ? 1 : 0};
      case "unit":
        return this.unitRef;
      case "sym":
        return this.emitSym(f, s, e.v);
      case "lambda": {
        // immutable $CLO {fnIdx, env = current frame, fsize}
        const clo = f.anyref();
        i32c(b, this.lambdaIdx.get(id)!);
        i31ref(b);
        g(b, 0); // captured frame = the frame param
        i32c(b, this.frameSizeOf(this.scopes.get(id)!)); // params + body lets + perform spills
        i31ref(b);
        snew(b, 6);
        st(b, clo);
        return {k: "local", l: clo};
      }
      case "let": {
        // Binds in the current frame (mirrors the interpreter: the binding
        // exists before the value is computed, so `let x = x` sees null —
        // a null slot read normalizes to unit inside the module).
        const slot = s.map.get(e.name)!;
        const vr = this.expr(e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1), snap: ctx.snap});
        g(b, 0); sget(b, 4, 1);
        i32c(b, slot);
        this.pushRef(f, vr);
        aset(b, 1);
        return this.unitRef;
      }
      case "dlet": {
        const blk = f.anyref();
        const vr = this.expr(e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1), snap: ctx.snap});
        this.pushRef(f, vr);
        rcast(b, 3);
        sget(b, 3, 0);
        st(b, blk);
        for (let k = 0; k < e.fields.length; k++) {
          const slot = s.map.get(e.fields[k].name)!;
          // tuple element k → frame slot (balances its stack in place)
          g(b, 0); sget(b, 4, 1);
          i32c(b, slot);
          g(b, blk);
          rcast(b, 1);
          i32c(b, k);
          aget(b, 1);
          aset(b, 1);
        }
        return this.unitRef;
      }
      case "assign": {
        const r = this.resolve(s, e.name);
        if (r === null) throw new WasmError(`Assignment to unbound symbol: ${e.name}`);
        const vr = this.expr(e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1), snap: ctx.snap});
        g(b, 0);
        for (let k = 0; k < r.d; k++) sget(b, 4, 0);
        sget(b, 4, 1);
        i32c(b, r.i);
        this.pushRef(f, vr);
        aset(b, 1);
        return this.unitRef;
      }
      case "if": {
        if (cut !== undefined && cut.length === 0) {
          // The split site itself inside a fragment: a split-mode if's
          // value arrives via the after-if fragment's v param.
          return this.fragV(id, f);
        }
        // Cut descent index (0 = the condition, 1/2 = an arm); undefined =
        // fresh emission.
        const ci = cut === undefined ? undefined : [e.c, e.a, e.b].indexOf(cut[0]);
        if (ci !== undefined && ci < 0) throw new WasmError("internal: split chain root mismatch");
        // When the cut is inside an arm (or the condition while an arm can
        // split), the if uses the dispatch shape: a sibling arm's own split
        // during this re-emission would otherwise leave the fragment's IF
        // unclosed. Split-mode fresh emission needs the same shape: an arm
        // containing a split site cannot keep the value-shape IF — the
        // site's return_call would end the function mid-block. Both arms
        // dispatch their values through a RET cell chained to the after-if
        // fragment, and the if itself becomes a split site whose fragment
        // (filled by the body-level catcher) receives the if's value.
        if (ci !== undefined
          ? (ci !== 0 || this.splits(e.a) || this.splits(e.b))
          : (this.splits(e.a) || this.splits(e.b))) {
          this.emitIfDispatch(id, e, f, s, ctx, ci);
          return this.unitRef; // unreachable: the dispatch-shape if throws Split
        }
        // Value shape — shared by fresh emission (ci undefined) and
        // fragment re-emission (no arm can split): condition and both arms
        // are value-explicit; each arm's ref is pushed as the IF block's
        // result value. Fragment re-emission never tail-calls the arms.
        const at = ci === undefined && tail;
        this.pushRef(f, this.cutChildRef(e.c, f, s, ctx, ci === undefined ? "post" : ci === 0 ? "cut" : "pre"));
        op(b, CALL);
        b.lebU(this.fTruthy);
        op(b, IF);
        b.u8(0x6e); // result anyref
        this.pushRef(f, this.cutChildRef(e.a, f, s, ctx, ci === undefined ? "post" : ci === 1 ? "cut" : ci === 2 ? "pre" : "post", at));
        op(b, ELSE);
        this.pushRef(f, this.cutChildRef(e.b, f, s, ctx, ci === undefined ? "post" : ci === 2 ? "cut" : "post", at));
        op(b, END);
        const v = f.anyref();
        st(b, v);
        return this.keepRef(id, f, {k: "local", l: v});
      }
      case "while": {
        if (cut !== undefined && cut.length === 0) {
          // The loop exited: its unit value is the fragment's v param.
          return this.fragV(id, f);
        }
        if (this.splits(e.c) || this.splits(e.body)) {
          this.emitWhileCPS(id, e, f, s, ctx, cut);
          return this.unitRef; // unreachable: the split-mode while throws Split
        }
        if (cut !== undefined) throw new WasmError("internal: split crossing a while");
        op(b, BLOCK);
        b.u8(0x40);
        op(b, LOOP);
        b.u8(0x40);
        this.pushRef(f, this.expr(e.c, f, s, false, ctx));
        op(b, CALL);
        b.lebU(this.fTruthy);
        op(b, EQZ);
        op(b, BR_IF);
        b.lebU(1);
        this.expr(e.body, f, s, false, ctx); // body value dropped: nothing on the stack
        op(b, BR);
        b.lebU(0);
        op(b, END);
        op(b, END);
        return this.unitRef;
      }
      case "block": {
        if (cut === undefined) {
          let last: ValueRef = this.unitRef;
          for (let k = 0; k < e.stmts.length; k++) {
            // Dropped statements leave nothing on the stack.
            last = this.expr(e.stmts[k], f, s, tail && k === e.stmts.length - 1, ctx);
          }
          return last;
        }
        // Cut path through the block: statements before the cut site already
        // executed (skipped), the cut statement continues the fragment with
        // its value from the fragment's v param, the rest re-emits inline.
        const ci = e.stmts.indexOf(cut[0]);
        if (ci < 0) throw new WasmError("internal: split chain root mismatch");
        return this.emitStmtsFrom(e.stmts, f, s, ctx, ci, cut, tail);
      }
      case "arr": {
        const blk = f.anyref();
        i32c(b, e.elems.length);
        anew(b, 1);
        st(b, blk);
        const ci = cut === undefined ? -1 : e.elems.indexOf(cut[0]);
        if (cut !== undefined && ci < 0) throw new WasmError("internal: split chain root mismatch");
        for (let k = 0; k < e.elems.length; k++) {
          // Value-explicit element order: the child's ref is computed BEFORE
          // the destination address is pushed, so a split inside the child
          // aborts on a clean operand stack (same ordering as the app
          // case's args).
          // Elements after the cut child have NOT run yet: they re-emit
          // inline ("post"), never reload a never-written spill slot ("pre").
          const r = this.cutChildRef(e.elems[k], f, s, ctx,
            cut === undefined ? "post" : k === ci ? "cut" : k < ci ? "pre" : "post");
          g(b, blk);
          rcast(b, 1);
          i32c(b, k);
          this.pushRef(f, r);
          aset(b, 1);
        }
        g(b, blk);
        rcast(b, 1);
        snew(b, 3); // $ARR wrapper
        const v = f.anyref();
        st(b, v);
        return {k: "local", l: v};
      }
      case "field": {
        const o = f.anyref(), blk = f.anyref();
        this.pushRef(f, this.expr(e.obj, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1)}));
        rcast(b, 3);
        sget(b, 3, 0);
        st(b, blk);
        // len <= idx → out of bounds
        g(b, blk);
        rcast(b, 1);
        alen(b);
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
        rcast(b, 1);
        i32c(b, e.idx!);
        aget(b, 1);
        const v = f.anyref();
        st(b, v);
        return {k: "local", l: v};
      }
      case "perform":
        if (cut !== undefined && cut.length === 0) {
          // The split site itself inside a fragment: its value is the
          // fragment's v param (the value the case body or host resumed
          // with).
          return this.fragV(id, f);
        }
        this.emitPerform(id, e, f, s, ctx);
        return this.unitRef; // unreachable: perform always ends at its split site
      case "handle":
        if (cut !== undefined && cut.length === 0) {
          // The split site itself inside a fragment: its value is the
          // handle's value delivered by the after-handle fragment chain.
          return this.fragV(id, f);
        }
        if (cut !== undefined) {
          // A perform inside the body split: emit the body's remainder with
          // the fragment's ambient continuation (kNext) — the perform-site
          // RET cell carries it: the handler cell the walk started from in
          // the original flow, or the fresh §4.6 chain (whose copied HDLs
          // keep every enclosing handler live around the resumed segment)
          // when the fragment runs from a resume closure.
          const bodyE = this.nodes[e.body];
          const stmts = bodyE.t === "block" ? bodyE.stmts : [e.body];
          const bsc = this.scopes.get(e.body) ?? s;
          const ci = stmts.indexOf(cut[0]);
          if (ci < 0) throw new WasmError("internal: split chain root mismatch");
          this.pushRef(f, this.emitStmtsFrom(stmts, f, bsc, ctx, ci, cut, false));
          const v = f.anyref();
          st(b, v);
          this.emitDispatch(f, v, ctx.kL);
          // The dispatch tail-calls away (every table carries a Return
          // entry); the after-handle rest chains from the split site.
          throw new Split(this.hdlRest.get(id)!, [...this.cutStack]);
        }
        this.emitHandle(id, e, f, s, ctx);
        return this.unitRef; // unreachable: the body's dispatch tail-calls away
      case "app": {
        if (cut !== undefined && cut.length === 0) {
          // The split site itself inside a fragment: the call's result is
          // the fragment's v param (the caller's body ended at the call's
          // return_call, §3 emitCall).
          return this.fragV(id, f);
        }
        // One shape for fresh emission and fragment re-emission: children
        // before the cut site reload (or, if pure, re-emit), the cut child
        // continues with the fragment's v param, children after re-emit
        // inline; fresh emission evaluates everything (mode "post").
        const kids = [e.fn, ...e.args];
        const ci = cut === undefined ? -1 : kids.indexOf(cut[0]);
        if (cut !== undefined && ci < 0) throw new WasmError("internal: split chain root mismatch");
        if (e.div !== undefined) {
          // `/` is stamped by the checker (int vs float truncation); the
          // fn is the `/` sym itself, so the cut site is always in an
          // operand (ci >= 1). Value-explicit operand order: both child
          // refs are computed (and spilled) before either is materialized,
          // so a split inside a child aborts on a clean operand stack.
          // A non-number operand traps at the ref.cast (frozen deviation —
          // the checker rejects non-num arithmetic statically).
          if (ci === 0) throw new WasmError("internal: split chain root mismatch");
          this.pushRef(f, this.cutChildRef(e.args[0], f, s, ctx, ci === 1 ? "cut" : ci < 0 ? "post" : "pre"));
          rcastn(b, 0);
          sget(b, 0, 0);
          this.pushRef(f, this.cutChildRef(e.args[1], f, s, ctx, ci === 2 ? "cut" : "post"));
          rcastn(b, 0);
          sget(b, 0, 0);
          op(b, FDIV);
          if (e.div === "int") op(b, FTRUNC);
          // Fresh + tail: the boxed value is the caller's return value;
          // fragment re-emission: the value continues inside the fragment.
          op(b, cut === undefined && tail ? RETURN_CALL : CALL); // return_call / call
          b.lebU(this.fBox);
        } else {
          const fc = f.anyref();
          this.pushRef(f, this.cutChildRef(e.fn, f, s, ctx, ci === 0 ? "cut" : ci < 0 ? "post" : "pre"));
          st(b, fc);
          this.emitCallClosure(f, fc, e.args.length, (k, ffp) => {
            // Value-explicit arg order: the child's ref is computed (and
            // spilled) BEFORE the destination address is pushed, so a split
            // inside the child aborts on a clean operand stack (blocker (b)
            // by construction).
            const r = this.cutChildRef(e.args[k], f, s, ctx,
              k + 1 === ci ? "cut" : k + 1 < ci ? "pre" : "post");
            g(b, ffp); rcast(b, 4); sget(b, 4, 1);
            i32c(b, k);
            this.pushRef(f, r);
            aset(b, 1);
          }, cut === undefined && tail,
          // Builtins never perform or capture, so they keep the k=0
          // trampoline convention; every other (lambda) call site lands
          // through a RET cell and is a split site (§3 emitCall).
          this.landCalls.has(id),
          ctx.kL,
          undefined,
          undefined,
          s,
          ctx);
        }
        // emitCallClosure leaves the landed result on the stack (or
        // tail-returns, making this capture unreachable). Bridge to a ref.
        const v = f.anyref();
        st(b, v);
        return {k: "local", l: v};
      }
      default:
        // Unreachable: the switch covers every Expr variant, but a try/finally
        // wrapper defeats TS's exhaustiveness-based end-of-function check.
        throw new WasmError(`internal: no emitter for node ${id}`);
    }
    } finally {
      if (pushed) this.cutStack.pop();
    }
  }

  emitPerform(id: ExprID, e: Expr & {t: "perform"}, f: Fn, s: Scope, ctx: Ctx): void {
    const b = f.body;
    const blk = f.anyref(), cell = f.anyref();
    i32c(b, e.args.length);
    anew(b, 1);
    st(b, blk);
    // Cut path: the split site is inside one of the args. Args before it
    // already ran (reload spilled / re-emit pure), the cut arg continues
    // with the fragment's v, args after it re-emit inline; then the walk
    // below re-runs with the fragment's ambient continuation.
    const cut = ctx.cut;
    const ci = cut === undefined ? -1 : e.args.indexOf(cut[0]);
    if (cut !== undefined && ci < 0) throw new WasmError("internal: split chain root mismatch");
    for (let k = 0; k < e.args.length; k++) {
      // Value-explicit arg order: the child's ref is computed BEFORE the
      // destination address is pushed, so a split inside the child aborts
      // on a clean operand stack (same ordering as the app case's args).
      const r = k === ci
        ? this.cutChildRef(e.args[k], f, s, ctx, "cut")
        : k < ci
          ? this.cutChildRef(e.args[k], f, s, ctx, "pre")
          : this.cutChildRef(e.args[k], f, s, ctx, "post");
      g(b, blk);
      rcast(b, 1);
      i32c(b, k);
      this.pushRef(f, r);
      aset(b, 1);
    }
    g(b, blk);
    rcast(b, 1);
    snew(b, 3); // $ARR wrapper
    st(b, cell);
    const spillSlot = this.spillOf.get(id)!;
    g(b, 0); sget(b, 4, 1);
    i32c(b, spillSlot);
    g(b, cell);
    aset(b, 1);
    // Handler walk: kL walks the k chain; the first K_HDL whose case table
    // (flat [opid, fnIdx, fsize, nparams]* i31s) contains opid wins. The
    // pre-walk ambient continuation (amb) is what the RET cell carries:
    // fragments re-dispatch through their kNext, so a resumed segment
    // follows the fresh §4.6 chain (copied HDLs + kCaller) instead of
    // skipping it.
    const opid = this.effOpIds.get(e.op)!;
    const restFn = this.makeRestThunk("perform:rest op=" + e.op);
    const kL = f.anyref(), hdl = f.anyref(), found = f.i32();
    const tbl = f.anyref(), nL = f.i32(), iL = f.i32(), ent = f.i32();
    const fnIdx = f.i32(), fsz = f.i32(), nparams = f.i32(), amb = f.anyref();
    const i31of = () => { rcastn(b, I31REF); i31get(b); }; // anyref → i32 (i31 payload)
    g(b, ctx.kL); // the ambient continuation
    st(b, kL);
    g(b, ctx.kL);
    st(b, amb);
    i32c(b, 0);
    st(b, found);
    op(b, BLOCK);
    b.u8(0x40);
    op(b, LOOP);
    b.u8(0x40);
    g(b, kL);
    op(b, 0xd1); // ref.is_null: k=0 → no handler anywhere → host fallback
    op(b, BR_IF);
    b.lebU(1);
    g(b, kL); rcast(b, 5); sget(b, 5, 0); i31get(b);
    i32c(b, K_HDL);
    op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    g(b, kL); rcast(b, 5); sget(b, 5, 1);
    st(b, tbl);
    g(b, tbl); rcast(b, 1); alen(b); i32c(b, 4); op(b, DIVU);
    st(b, nL);
    this.loop(f, () => {
      g(b, nL);
    }, i => {
      g(b, i); i32c(b, 4); op(b, MUL);
      st(b, ent);
      g(b, tbl); rcast(b, 1); g(b, ent); aget(b, 1); i31of();
      i32c(b, opid);
      op(b, EQ);
      op(b, IF);
      b.u8(0x40);
      i32c(b, 1);
      st(b, found);
      g(b, kL);
      st(b, hdl);
      g(b, tbl); rcast(b, 1); g(b, ent); i32c(b, 1); op(b, ADD); aget(b, 1); i31of();
      st(b, fnIdx);
      g(b, tbl); rcast(b, 1); g(b, ent); i32c(b, 2); op(b, ADD); aget(b, 1); i31of();
      st(b, fsz);
      g(b, tbl); rcast(b, 1); g(b, ent); i32c(b, 3); op(b, ADD); aget(b, 1); i31of();
      st(b, nparams);
      op(b, BR);
      b.lebU(2); // exit the table scan
      op(b, END);
    });
    g(b, found);
    op(b, BR_IF);
    b.lebU(2); // matched handler → leave the walk
    op(b, END);
    g(b, kL); rcast(b, 5); sget(b, 5, 3);
    st(b, kL);
    op(b, BR);
    b.lebU(0);
    op(b, END);
    op(b, END);
    // Freeze the frame image for this capture and chain the rest fragment
    // behind a K_SPILL cell carrying it: the fragment's pre-cut operand
    // reloads read the frozen values, so a multi-shot resume re-runs the
    // rest against the pre-perform state (the interpreter's CPS accs),
    // not the frame as mutated by earlier resumes / loop iterations.
    const ksp = this.snapWrap(f, s, ctx, () => {
      g(b, amb);
    });
    g(b, found);
    op(b, IF);
    b.u8(0x7f); // handler found: invoke the matched case body
    // Per-invocation frame copy: case invocations of one handler nest (a
    // resumed segment can re-enter the handler), and each invocation needs
    // its own params/spills — the interpreter gives every case invocation a
    // fresh env, so the shared hframe must not be re-bound under an
    // in-flight outer invocation (its fragments re-read scope slots). Copy
    // the hframe; the matched entry's fsize (table word @2) sizes the copy,
    // and the resume capture records a fresh HDL over the copy so the fresh
    // chain's Return lands in this invocation's frame.
    const hfc = f.anyref(), hfsrc = f.anyref(), hfs = f.anyref();
    g(b, hdl); rcast(b, 5); sget(b, 5, 2); rcast(b, 4);
    st(b, hfsrc);
    g(b, hfsrc); rcast(b, 4); sget(b, 4, 0); // parent (unchanged)
    g(b, fsz);
    anew(b, 1);
    st(b, hfs);
    this.loop(f, () => {
      g(b, fsz);
    }, i => {
      g(b, hfs);
      rcast(b, 1);
      g(b, i);
      g(b, hfsrc); rcast(b, 4); sget(b, 4, 1);
      g(b, i);
      aget(b, 1);
      aset(b, 1);
    });
    g(b, hfs);
    rcast(b, 1);
    snew(b, 4);
    st(b, hfc);
    // Push this perform's RET cell; the slice below is captured as if this
    // cell had been pushed before the walk (scan-first). Its next is the
    // K_SPILL cell (the rest fragment's prologue loads the snapshot and
    // skips the cell before dispatching, so K_SPILL stays invisible to
    // every other dispatch and to fCapture's slice walk).
    const ret = this.retCell(f, restFn.idx, () => {
      g(b, ksp); // next = K_SPILL{frozen frame image, pre-walk ambient}
    }); // b = the current frame (holds the spilled args cell)
    // Capture the slice above the handler into fresh cells (originals
    // untouched; the resume closure copies again on every call).
    const slice = f.anyref();
    g(b, ret);
    rcast(b, 5);
    g(b, hdl);
    rcast(b, 5);
    op(b, CALL);
    b.lebU(this.fCapture);
    st(b, slice);
    // The resume binder (§4.6): a $CLO over the shared resume fn and a
    // capture-record frame {slot 1 = the slice, slot 2 = the matched HDL
    // (the capture sentinel), slot 3 = this invocation's hframe copy}. The
    // resume fn copies the slice afresh per call (sentinel = slot 2) and
    // re-chains its bottom to a fresh HDL {slot 2's table, slot 3's frame,
    // next = the k the closure was invoked with}, so the resumed segment
    // runs against the caller's continuation and its Return lands in the
    // invocation's frame copy.
    const recs = f.anyref(), rec = f.anyref(), rclo = f.anyref();
    i32c(b, 4);
    anew(b, 1);
    st(b, recs);
    g(b, recs); rcast(b, 1); i32c(b, 0); rnull(b, ANYREF); aset(b, 1); // slot 0 unused
    g(b, recs); rcast(b, 1); i32c(b, 1); g(b, slice); aset(b, 1); // slot 1: the captured slice
    g(b, recs); rcast(b, 1); i32c(b, 2); g(b, hdl); aset(b, 1); // slot 2: the matched HDL (sentinel)
    g(b, recs); rcast(b, 1); i32c(b, 3); g(b, hfc); aset(b, 1); // slot 3: this invocation's hframe copy
    rnull(b, 4); // parent = none
    g(b, recs);
    rcast(b, 1);
    snew(b, 4);
    st(b, rec);
    i32c(b, this.resumeFn!.idx);
    i31ref(b);
    g(b, rec);
    rcast(b, 4); // env = the resume record's $FRAME (rec is an anyref local)
    i32c(b, 1); // fsize (call frame size hint: slot 0 = the resumed value)
    i31ref(b);
    snew(b, 6);
    st(b, rclo);
    // Case invocation over the handler's shared hframe copy (hdl.b): bind
    // the case params from the args cell, the resume binder to the boxed
    // resume closure, then tail-call the case body
    // with (hframe, hdl.next) — its continuation never contains this
    // handler (two-k rule).
    g(b, hfc); rcast(b, 4); sget(b, 4, 1);
    this.loop(f, () => {
      g(b, nparams);
    }, i2 => {
      g(b, hfc); rcast(b, 4); sget(b, 4, 1);
      g(b, i2);
      g(b, cell); rcast(b, 3); sget(b, 3, 0);
      g(b, i2);
      aget(b, 1);
      aset(b, 1);
    });
    g(b, hfc); rcast(b, 4); sget(b, 4, 1);
    g(b, nparams);
    g(b, rclo);
    aset(b, 1);
    g(b, hfc);
    rcast(b, 4);
    g(b, hdl); rcast(b, 5); sget(b, 5, 3);
    g(b, fnIdx);
    op(b, RETURN_CALL_INDIRECT);
    b.lebU(T_KABI);
    b.lebU(0);
    op(b, ELSE);
    // No matching handler: bare host call, then the rest-of-site fragment —
    // the SAME fragment the RET cell carries — continues with the resumed
    // value over this frame and the ambient continuation. The args cell is
    // reloaded from its spill slot, the pattern the fragment itself uses.
    const v = f.anyref();
    i32c(b, opid);
    g(b, 0); sget(b, 4, 1); i32c(b, spillSlot); aget(b, 1);
    op(b, CALL);
    b.lebU(this.impIdx.get("ef_perform")!);
    st(b, v);
    g(b, 0); sget(b, 4, 1); i32c(b, this.valSpill.get(id)!);
    g(b, v);
    aset(b, 1);
    g(b, 0);
    g(b, v);
    g(b, ksp);
    rcast(b, 5);
    i32c(b, restFn.idx);
    op(b, RETURN_CALL_INDIRECT);
    b.lebU(T_III_I);
    b.lebU(0);
    op(b, END);
    op(b, 0x00); // unreachable: both arms end in a tail call
    // The inline body ends at the split site; the catcher fills restFn.
    if (DBGEMIT) console.log("THROW perform-split op=", e.op, "cut=", this.cutStack.length, "[" + this.cutStack.map((x) => this.nodes[x]?.t).join(",") + "]");
    throw new Split(restFn, [...this.cutStack]);
  }

  // §4.4 handle. Installs the handler's continuation state and runs the
  // body inline with the K_HDL cell as the ambient continuation k':
  // - hframe: the handler's shared frame (op-param slots, resume binders,
  //   the Return value slot, case-body spills — frameSizeOf(info.scope)).
  // - RET cell for the after-handle rest: {K_RET, restFn, $fp, ambient k} —
  //   the continuation OUTSIDE the handler; the Return case (and the
  //   identity default) delivers the handle's value through it.
  // - K_HDL cell: {K_HDL, case-table global, hframe, next = the RET cell}.
  // The cell is spilled to the handle's frame slot so a perform inside the
  // body (whose split re-emits this node in fragment mode) reloads the
  // installed handler instead of reinstalling it. The body's completion
  // dispatches through the cell (Return entry — explicit case fn or the
  // shared identity); like a perform site, the handle ends the inline body
  // and the after-handle rest lives in its own fragment.
  emitHandle(id: ExprID, e: Expr & {t: "handle"}, f: Fn, s: Scope, ctx: Ctx): void {
    const b = f.body;
    const info = this.hdlCases.get(id)!;
    const restFn = this.makeRestThunk("handle:restFn");
    this.hdlRest.set(id, restFn);
    const hf = f.anyref(), hdl = f.anyref();
    g(b, 0); // parent = the frame at the handle site
    i32c(b, this.frameSizeOf(info.scope));
    anew(b, 1);
    snew(b, 4);
    st(b, hf);
    // K_SPILL cell freezing the pre-handle frame image: the after-handle
    // rest's pre-cut operand reloads (chain levels above the handle, e.g.
    // sibling operands of `s + handle {...}`) must see the values as of
    // the install, not as mutated by the handler body / resumes.
    const ksp = this.snapWrap(f, s, ctx, () => {
      g(b, ctx.kL);
    });
    // RET cell over the handle-site frame; next = the continuation outside
    // the handler (the two-k rule: the case body's ambient continuation is
    // the one captured OUTSIDE the handler).
    const ret = this.retCell(f, restFn.idx, () => {
      g(b, ksp);
    });
    i32c(b, K_HDL);
    i31ref(b);
    gget(b, info.tableOff); // a = the case table
    g(b, hf);
    g(b, ret); rcast(b, 5);
    snew(b, 5);
    st(b, hdl);
    const sp = this.valSpill.get(id);
    if (sp !== undefined) {
      g(b, 0); sget(b, 4, 1);
      i32c(b, sp);
      g(b, hdl);
      aset(b, 1);
    }
    // Body with the handler cell as the ambient continuation: no tail calls
    // through the k param here — every value flows through the handler.
    const bodyE = this.nodes[e.body];
    const stmts = bodyE.t === "block" ? bodyE.stmts : [e.body];
    this.emitStmtSeq(stmts, f, this.scopes.get(e.body) ?? s, false, {kL: hdl});
    // The completion dispatch tail-calls the Return case (every table
    // carries one); control never returns here. The after-handle rest is
    // in restFn — the catcher that receives this Split fills it, re-emitting
    // this node as the chain's split site (its value = the fragment's v).
    throw new Split(restFn, [...this.cutStack]);
  }

  // --- builtin trampolines ---------------------------------------------------

  // Dispatch-shape if (§3): used when an arm can split, or when re-emitting
  // a fragment whose cut lands inside the if. Both arms dispatch their
  // values through a RET cell {K_RET, restAfterIf, frame, ambient k} and
  // return; the if itself becomes a split site whose fragment (filled by
  // the body-level catcher) receives the if's value as v. An arm whose
  // emission throws is closed with unreachable; its fragment is filled
  // here against the enclosing body root along the split's chain.
  // `ci` is the cut descent index when re-emitting a fragment (0 = the
  // condition continues the fragment, 1/2 = the arm does); undefined when
  // emitting fresh.
  emitIfDispatch(id: ExprID, e: Expr & {t: "if"}, f: Fn, s: Scope, ctx: Ctx, ci?: number): void {
    const b = f.body;
    // The split chain for this if: the path from the body root to here.
    // Frames pushed while emitting the arms (nested re-emissions) are not
    // part of it.
    const chainToIf = [...this.cutStack];
    const restAfterIf = this.makeRestThunk("if:after");
    // K_SPILL cell freezing the pre-if frame image for the after-if rest's
    // pre-cut operand reloads (see snapWrap).
    const ksp = this.snapWrap(f, s, ctx, () => {
      g(b, ctx.kL); // the ambient continuation
    });
    const ifk = this.retCell(f, restAfterIf.idx, () => {
      g(b, ksp); // next = K_SPILL{frozen frame image, ambient k}
    });
    // Inside the dispatch shape the arms' ambient continuation is the arm
    // completion cell: every split site in an arm (perform/land/...) must
    // chain its rest fragment through ifk, or the resumed value bypasses
    // the after-if rest entirely. The condition keeps the outer kL — its
    // completion is the fTruthy call, not the arm dispatch.
    const ctxArm: Ctx = {...ctx, kL: ifk};
    let condSplit: Split | null = null;
    try {
      if (ci === undefined) this.pushRef(f, this.cutChildRef(e.c, f, s, ctx, "post"));
      else this.pushRef(f, this.cutChildRef(e.c, f, s, ctx, ci === 0 ? "cut" : "pre"));
    } catch (spC) {
      if (!(spC instanceof Split)) throw spC;
      condSplit = spC;
    }
    if (condSplit !== null) {
      // The condition/cut-child split: ifk already references restAfterIf in
      // the emitted code, and under multi-shot resume the condition can still
      // complete and dispatch an arm through it — so the post-if fragment
      // must exist. Fill it along the if's own chain (the same content the
      // trailing throw below would have carried), then let the condition's
      // Split propagate; its own rest is filled by the enclosing catcher.
      this.cutStack.pop(); // fragments must not see the if's own frame
      const rootC = this.bodyRoots[this.bodyRoots.length - 1];
      const savedCutC = this.cutStack;
      this.cutStack = [...rootC.savedCut];
      try {
        this.fillRest(new Split(restAfterIf, chainToIf), rootC.stmts, rootC.sc, rootC.tail);
      } finally {
        this.cutStack = savedCutC;
      }
      op(b, UNREACHABLE); // close the aborted fragment (the condition never falls through)
      throw condSplit;
    }
    op(b, CALL);
    b.lebU(this.fTruthy);
    op(b, IF);
    b.u8(0x40); // void: each arm ends in dispatch + return
    const arm = (armE: ExprID, cutArm: boolean): Split | null => {
      const va = f.anyref();
      let sp: Split | null = null;
      try {
        if (cutArm) {
          this.pushRef(f, this.cutChildRef(armE, f, s, ctxArm, "cut"));
        } else {
          // The other arm re-emits without the cut: the cut path belongs to
          // the cut arm's subtree only.
          this.pushRef(f, this.cutChildRef(armE, f, s, ctxArm, "post"));
        }
        st(b, va);
      } catch (sp2) {
        if (!(sp2 instanceof Split)) throw sp2;
        sp = sp2;
      }
      if (sp !== null) {
        if (!cutArm) {
          // The non-cut arm re-emits fresh; a split site inside it must not
          // re-root its fragment at the body root — filling from there would
          // re-emit this if (with the arms' roles swapped), regenerating the
          // sibling arm's split forever. Fill against the arm subtree:
          // the fragment continues the arm's remainder and its kNext is the
          // site's snap-wrapped ambient continuation (ifk), so the after-if
          // rest still receives the if's value. The synthetic root is the
          // first frame under this if on the split's chain (the arm body
          // node itself when it pushed one, the split site's parent
          // otherwise), so the re-emission root and chain stay consistent.
          if (sp.chain.length < 2) throw new WasmError("internal: arm split chain too short");
          this.cutStack.pop(); // the synthetic root is the arm, not this if
          const savedCutA = this.cutStack;
          this.cutStack = [];
          try {
            this.fillRest(new Split(sp.restFn, sp.chain.slice(1)), [sp.chain[1]], s, false);
          } finally {
            this.cutStack = savedCutA;
          }
        }
        op(b, UNREACHABLE);
        return cutArm ? sp : null; // fresh arm: filled locally, arm "completes"
      }
      this.emitDispatch(f, va, ifk);
      op(b, RETURN); // the dispatch's result is this function's result
      return null;
    };
    const spA = arm(e.a, ci === 1);
    op(b, ELSE);
    const spB = arm(e.b, ci === 2);
    op(b, END);
    op(b, UNREACHABLE); // unreachable: each arm returned or trapped
    const root = this.bodyRoots[this.bodyRoots.length - 1];
    // This if's own expr frame is still on the cut stack; the arm fragment
    // re-emissions must not see it (they push a fresh if frame along the
    // re-emitted chain).
    this.cutStack.pop();
    if (spA !== null) this.fillRest(spA, root.stmts, root.sc, root.tail);
    if (spB !== null) this.fillRest(spB, root.stmts, root.sc, root.tail);
    this.cutStack.push(id);
    // The code after the if chains through restAfterIf: the enclosing
    // body-level catcher fills it with the if's value as v.
    if (DBGEMIT) console.log("THROW if-split");
    throw new Split(restAfterIf, chainToIf);
  }

  // Split-mode while (§6b): a perform/handle/land call inside the condition
  // or body cannot keep the wasm block/loop shape — the site's return_call
  // would end the function mid-loop and no captured continuation may cross a
  // wasm label. The loop becomes a split site:
  // - pass 1 (fresh): allocates the after-while RET cell {K_RET, restAfter,
  //   $fp, ambient k} and the loop-entry RET cell {K_RET, loopEntry, $fp,
  //   ifk}, fills the loopEntry fragment (one loop pass), and enters the
  //   loop by dispatching unit through the entry cell. The body's ambient
  //   continuation is a fresh per-pass loop-back cell {K_RET, loopEntry,
  //   $fp, kNext} — the body re-enters the loop through the k chain, never
  //   a label, and a perform inside the body captures that cell (so a
  //   resumed copy re-enters the loop on the resumed chain).
  // - cut = [] (fragment re-emission after the loop exited): the loop's
  //   unit value is the fragment's v param.
  // - cut through the body (a split inside it resumed): the rest of the
  //   current iteration runs with the fragment's ambient continuation (the
  //   loop-back cell in effect) and the iteration re-enters the loop
  //   through it; the after-while rest chains off a fresh Split.
  // - cut through the condition (a split inside it resumed): the condition
  //   continues with the fragment's v, then one loop pass re-runs
  //   (emitLoopPass with kNext = the fragment's ambient continuation).
  emitWhileCPS(id: ExprID, e: Expr & {t: "while"}, f: Fn, s: Scope, ctx: Ctx, cut?: ExprID[]): void {
    const b = f.body;
    if (cut === undefined) {
      const chainToWhile = [...this.cutStack];
      const restAfter = this.makeRestThunk("while:after");
      const loopEntry = this.makeRestThunk("while:loopEntry");
      this.ctlLoops.set(id, {entry: loopEntry, rest: restAfter});
      let inner: Split | null = null;
      try {
        this.emitLoopPass(loopEntry, e, s, 2, loopEntry.idx);
      } catch (sp) {
        if (!(sp instanceof Split)) throw sp;
        inner = sp;
      }
      // K_SPILL cell freezing the pre-loop frame image for the after-while
      // rest's pre-cut operand reloads (see snapWrap).
      const ksp = this.snapWrap(f, s, ctx, () => {
        g(b, ctx.kL); // the ambient continuation
      });
      const ifk = this.retCell(f, restAfter.idx, () => {
        g(b, ksp); // next = K_SPILL{frozen frame image, ambient k}
      });
      const loopk = this.retCell(f, loopEntry.idx, () => {
        g(b, ifk); // next = the after-while cell
      });
      const u = f.anyref();
      this.pushRef(f, this.unitRef);
      st(b, u);
      this.emitDispatch(f, u, loopk); // enter the loop (tail call)
      // The loop pass's emission ends at a split site inside it (that is
      // what makes the while split-mode): that site's rest fragment is
      // filled by the enclosing body-level catcher along the chain through
      // this while; this loop's own after-rest chains when the cut path
      // re-emits (below). The throw is unreachable in practice.
      if (inner !== null) throw inner;
      if (DBGEMIT) console.log("THROW while-cond-split");
      throw new Split(restAfter, chainToWhile);
    }
    const loop = this.ctlLoops.get(id);
    if (loop === undefined) throw new WasmError("internal: split chain root mismatch");
    if (DBGEMIT) console.log("WHILE_CUT cond=", cut[0] === e.c, "body=", cut[0] === e.body, "cutlen=", cut.length);
    if (cut[0] === e.c) {
      // The condition continues the fragment with the fragment's v, then one
      // loop pass re-runs over the ambient continuation (fresh loop-back
      // cell inside emitLoopPass).
      this.emitLoopPass(f, e, s, ctx.kL, loop.entry.idx, cut.slice(1), ctx.snap);
      op(b, UNREACHABLE); // each path dispatched (loop back / exit)
      throw new Split(loop.rest, [...this.cutStack]);
    }
    if (cut[0] === e.body) {
      // Mid-iteration re-entry with a non-block body: it continues the
      // fragment with the cut site's value.
      const bsc = this.scopes.get(e.body) ?? s;
      this.pushRef(f, this.expr(e.body, f, bsc, false, {kL: ctx.kL, cut: cut.slice(1)}));
    } else {
      // Mid-iteration re-entry: skip the condition (already run). Like
      // handler bodies, a block body is bypassed by emitStmtSeq, so the
      // chain's next element is a statement of the body block: statements
      // before the cut site executed, it continues with the fragment's v,
      // statements after it re-emit inline.
      const bodyE = this.nodes[e.body];
      if (bodyE.t !== "block") throw new WasmError("internal: split chain root mismatch");
      const stmts = bodyE.stmts;
      const bsc = this.scopes.get(e.body) ?? s;
      const ci = stmts.indexOf(cut[0]);
      if (ci < 0) throw new WasmError("internal: split chain root mismatch");
      this.pushRef(f, this.emitStmtsFrom(stmts, f, bsc, ctx, ci, cut, false));
    }
    const v = f.anyref();
    st(b, v);
    this.emitDispatch(f, v, ctx.kL); // loop back through the k chain
    op(b, UNREACHABLE);
    throw new Split(loop.rest, [...this.cutStack]);
  }

  // One loop pass (§6b loop-entry fragment): evaluate the condition (fresh,
  // or continuing a fragment's v when `condCut` is set), then truthy?
  // body-then-loop-back : exit with the loop's unit value. The loop-back
  // cell is allocated per pass and chained to `kNext` (the after-loop
  // continuation in effect), so every capture of it resumes on the chain it
  // was captured from. The body's completion dispatches through the cell;
  // a Split inside the body leaves the pass closed at the site (unreachable
  // body path) and propagates — the enclosing catcher fills that site's
  // fragment along the chain through this while.
  emitLoopPass(f: Fn, e: Expr & {t: "while"}, s: Scope, kNext: number, entryIdx: number, condCut?: ExprID[], snap?: number): void {
    const b = f.body;
    // Value-explicit cond: the ref is materialized at its consume point
    // (fTruthy); keepRef persists it into the operand spill slot when the
    // fragment machinery mapped one (same discipline as the app case's
    // args). A Split inside the condition (a perform/handle/land call in
    // it) propagates to the enclosing catcher before the IF opens — the
    // pass closes with unreachable and the cond-cut fragment re-runs the
    // pass with the resumed value.
    let condRef: ValueRef;
    try {
      condRef = condCut === undefined
        ? this.keepRef(e.c, f, this.expr(e.c, f, s, false, {kL: kNext}))
        : condCut.length === 0
          ? this.keepRef(e.c, f, {k: "local", l: 1}) // cond is the split site: v param
          // condCut[0] is a descendant of the cond (e.g. a perform inside
          // the comparison), not the cond itself — pass the cut through
          // intact; cutChildRef's slice(1) would drop the site and the
          // cond would collapse to bare fragV.
          : this.keepRef(e.c, f, this.expr(e.c, f, s, false, {kL: kNext, cut: condCut, snap}));
    } catch (sp) {
      if (!(sp instanceof Split)) throw sp;
      op(b, UNREACHABLE); // the pass never completes inline at this site
      throw sp;
    }
    this.pushRef(f, condRef);
    op(b, CALL);
    b.lebU(this.fTruthy);
    op(b, IF);
    b.u8(0x40); // void: the body path tails into the loop-back cell
    try {
      // RET cell over the pass's frame; next = the after-loop continuation
      const lb = this.retCell(f, entryIdx, () => {
        g(b, kNext);
      });
      const bodyE = this.nodes[e.body];
      const stmts = bodyE.t === "block" ? bodyE.stmts : [e.body];
      const bsc = this.scopes.get(e.body) ?? s;
      this.emitStmtSeq(stmts, f, bsc, false, {kL: lb});
      // The body's completion dispatch left the dispatch walk's block
      // result on the stack (the k=0 terminal-return value): consume it as
      // this pass's return. When the body splits, the catch below closes
      // the arm before this line.
      op(b, RETURN);
    } catch (sp) {
      if (!(sp instanceof Split)) throw sp;
      op(b, UNREACHABLE); // the body never completes inline at this site
      op(b, END);
      const u = f.anyref();
      this.pushRef(f, this.unitRef);
      st(b, u);
      this.emitDispatch(f, u, kNext); // condition false: exit
      throw sp;
    }
    op(b, END);
    const u = f.anyref();
    this.pushRef(f, this.unitRef);
    st(b, u);
    this.emitDispatch(f, u, kNext); // condition false: exit
  }

  // Frame slot i (anyref) of the current frame (local 0) — the args/builtin
  // access path. Writes push (arrayref, index) + value + aset at the caller.
  slot(f: Fn, i: number): void {
    g(f.body, 0);
    sget(f.body, 4, 1);
    i32c(f.body, i);
    aget(f.body, 1);
  }

  // f64 payload of slot i's number; ref.cast traps on non-numbers (the
  // frozen §7.7 deviation — unreachable in well-typed programs).
  slotF64(f: Fn, i: number): number {
    const l = f.f64();
    this.slot(f, i);
    rcastn(f.body, 0);
    sget(f.body, 0, 0);
    st(f.body, l);
    return l;
  }

  emitBuiltins(builtin0: number): Fn[] {
    const out: Fn[] = [];
    for (const {name} of BUILTINS) {
      if (!this.usedBuiltins.has(name)) continue;
      const f = new Fn(2); // (frame, k): builtins are T_KABI trampolines
      f.typeIdx = T_KABI;
      const b = f.body;
      const box = () => {
        op(b, CALL);
        b.lebU(this.fBox);
      };
      switch (name) {
        case "+": {
          const a = f.anyref(), bv = f.anyref();
          this.slot(f, 0);
          st(b, a);
          this.slot(f, 1);
          st(b, bv);
          g(b, a);
          rtestn(b, 0);
          g(b, bv);
          rtestn(b, 0);
          op(b, AND);
          op(b, IF);
          b.u8(0x6e); // result anyref
          g(b, a);
          rcastn(b, 0);
          sget(b, 0, 0);
          g(b, bv);
          rcastn(b, 0);
          sget(b, 0, 0);
          op(b, FADD);
          box();
          op(b, ELSE);
          g(b, a);
          rtestn(b, 2);
          g(b, bv);
          rtestn(b, 2);
          op(b, AND);
          op(b, IF);
          b.u8(0x6e);
          this.emitStrCat(f, a, bv);
          op(b, ELSE);
          rnull(b, ANYREF);
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
          b.lebU(this.fEq);
          break;
        }
        case "!=": {
          this.slot(f, 0);
          this.slot(f, 1);
          op(b, CALL);
          b.lebU(this.fEq);
          rcastn(b, I31REF); // eq result's i31 bool payload
          i31get(b);
          op(b, EQZ); // 1 when $eq said false
          this.selectBool(f, () => {});
          break;
        }
        case "not": {
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(this.fTruthy);
          op(b, EQZ);
          this.selectBool(f, () => {});
          break;
        }
        case "list": {
          // The frame has fsize 0, so the slots array length IS argc — the
          // only argc reader in the backend (do not generalize).
          const n = f.i32();
          g(b, 0);
          sget(b, 4, 1);
          alen(b);
          st(b, n);
          const blk = this.allocArrBlk(f, n);
          this.loop(f, () => {
            g(b, n);
          }, i => {
            this.elemAddr(f, blk, i);
            this.slot(f, i);
            aset(b, 1);
          });
          this.boxArr(f, blk);
          break;
        }
        case "head": {
          const blk = f.anyref();
          this.slot(f, 0);
          rcast(b, 3);
          sget(b, 3, 0);
          st(b, blk);
          g(b, blk);
          rcast(b, 1);
          alen(b);
          op(b, EQZ);
          op(b, IF);
          b.u8(0x40);
          this.emitFail(f, 0, null, this.constF64(f, 0), this.constF64(f, 0));
          op(b, END);
          g(b, blk);
          rcast(b, 1);
          i32c(b, 0);
          aget(b, 1);
          break;
        }
        case "tail": {
          const blk = f.anyref(), len = f.i32(), n1 = f.i32();
          this.slot(f, 0);
          rcast(b, 3);
          sget(b, 3, 0);
          st(b, blk);
          g(b, blk);
          rcast(b, 1);
          alen(b);
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
          const aBlk = f.anyref(), bBlk = f.anyref(), la = f.i32(), lb = f.i32(), n = f.i32();
          this.slot(f, 0);
          rcast(b, 3);
          sget(b, 3, 0);
          st(b, aBlk);
          this.slot(f, 1);
          rcast(b, 3);
          sget(b, 3, 0);
          st(b, bBlk);
          g(b, aBlk);
          rcast(b, 1);
          alen(b);
          st(b, la);
          g(b, bBlk);
          rcast(b, 1);
          alen(b);
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
            aget(b, 1);
            aset(b, 1);
          });
          this.loop(f, () => {
            g(b, lb);
          }, i => {
            this.elemAddr(f, blk, i);
            g(b, la);
            op(b, ADD);
            this.elemAddr(f, bBlk, i);
            aget(b, 1);
            aset(b, 1);
          });
          this.boxArr(f, blk);
          break;
        }
        case "flat": {
          const xss = f.anyref(), n = f.i32(), total = f.i32();
          this.slot(f, 0);
          rcast(b, 3);
          sget(b, 3, 0);
          st(b, xss);
          g(b, xss);
          rcast(b, 1);
          alen(b);
          st(b, n);
          i32c(b, 0);
          st(b, total);
          // JS Array.prototype.flat parity: non-array elements pass through
          // instead of being read as inner arrays (a resumed scalar flowing
          // back through a map-like land path lands exactly here).
          this.loop(f, () => {
            g(b, n);
          }, k => {
            const cell = f.anyref();
            this.elemAddr(f, xss, k);
            aget(b, 1);
            st(b, cell);
            g(b, cell);
            rtestn(b, 3); // is $ARR?
            op(b, IF);
            b.u8(0x40);
            g(b, cell);
            rcast(b, 3);
            sget(b, 3, 0);
            rcast(b, 1);
            alen(b); // inner len
            g(b, total);
            op(b, ADD);
            st(b, total);
            op(b, ELSE);
            g(b, total);
            i32c(b, 1);
            op(b, ADD);
            st(b, total);
            op(b, END);
          });
          const blk = this.allocArrBlk(f, total);
          const w = f.i32();
          i32c(b, 0);
          st(b, w);
          this.loop(f, () => {
            g(b, n);
          }, k => {
            const cell = f.anyref(), xb = f.anyref(), xl = f.i32();
            this.elemAddr(f, xss, k);
            aget(b, 1);
            st(b, cell);
            g(b, cell);
            rtestn(b, 3);
            op(b, IF);
            b.u8(0x40);
            g(b, cell);
            rcast(b, 3);
            sget(b, 3, 0);
            st(b, xb);
            g(b, xb);
            rcast(b, 1);
            alen(b);
            st(b, xl);
            this.loop(f, () => {
              g(b, xl);
            }, j => {
              this.elemAddr(f, blk, w);
              this.elemAddr(f, xb, j);
              aget(b, 1);
              aset(b, 1);
              g(b, w);
              i32c(b, 1);
              op(b, ADD);
              st(b, w);
            });
            op(b, ELSE);
            this.elemAddr(f, blk, w);
            g(b, cell);
            aset(b, 1);
            g(b, w);
            i32c(b, 1);
            op(b, ADD);
            st(b, w);
            op(b, END);
          });
          this.boxArr(f, blk);
          break;
        }
        case "len": {
          this.slot(f, 0);
          rcast(b, 3);
          sget(b, 3, 0);
          rcast(b, 1);
          alen(b);
          op(b, CONV_I32);
          box();
          break;
        }
        case "strlen": {
          this.slot(f, 0);
          rcast(b, 2);
          alen(b);
          op(b, CONV_I32);
          box();
          break;
        }
        case "PI":
          gget(b, this.piG);
          break;
        case "cos":
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(this.impIdx.get("ef_cos")!);
          break;
        case "sin":
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(this.impIdx.get("ef_sin")!);
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
            aset(b, 1);
          });
          this.boxArr(f, blk);
          break;
        }
        case "char":
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(this.impIdx.get("ef_char")!);
          break;
        case "number":
          this.slot(f, 0);
          op(b, CALL);
          b.lebU(this.impIdx.get("ef_number")!);
          break;
        case "args":
          op(b, CALL);
          b.lebU(this.impIdx.get("ef_args")!);
          break;
        case "get": {
          const blk = f.anyref(), len = f.i32(), idx = f.i32();
          const idxF = this.slotF64(f, 1);
          this.slot(f, 0);
          rcast(b, 3);
          sget(b, 3, 0);
          st(b, blk);
          g(b, blk);
          rcast(b, 1);
          alen(b);
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
          this.emitFail(f, 1, null, () => {
            g(b, idxF);
          }, () => {
            g(b, len);
            op(b, CONV_I32);
          });
          op(b, END);
          this.elemAddr(f, blk, idx);
          aget(b, 1);
          break;
        }
        case "set": {
          const xs = f.anyref(), blk = f.anyref(), len = f.i32(), idx = f.i32(), v = f.anyref();
          const idxF = this.slotF64(f, 1);
          this.slot(f, 0);
          st(b, xs);
          g(b, xs);
          rcast(b, 3);
          sget(b, 3, 0);
          st(b, blk);
          g(b, blk);
          rcast(b, 1);
          alen(b);
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
          aset(b, 1);
          op(b, ELSE);
          // grow: fresh slots array of len idx+1, copy old, fill holes with
          // unit, repoint the wrapper's backing (aliases share the wrapper,
          // so they all see the growth — §7.1).
          const nb = f.anyref(), nlen = f.i32();
          g(b, idx);
          i32c(b, 1);
          op(b, ADD);
          st(b, nlen);
          g(b, nlen);
          anew(b, 1);
          st(b, nb);
          this.loop(f, () => {
            g(b, nlen);
          }, k => {
            g(b, nb);
            rcast(b, 1);
            g(b, k);
            g(b, k);
            g(b, len);
            op(b, 0x49); // k < old len → copy
            op(b, IF);
            b.u8(0x6e); // result anyref
            this.elemAddr(f, blk, k);
            aget(b, 1);
            op(b, ELSE);
            rnull(b, ANYREF);
            op(b, END);
            aset(b, 1);
          });
          g(b, nb);
          rcast(b, 1);
          g(b, idx);
          g(b, v);
          aset(b, 1);
          g(b, xs);
          rcast(b, 3);
          g(b, nb);
          rcast(b, 1);
          sset(b, 3, 0); // point the wrapper at the new backing
          op(b, END);
          rnull(b, ANYREF);
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
      // Complete with the ABI's dispatch: builtins are called with k=0, so
      // dispatch(0, v) just returns the computed value.
      const v = f.anyref();
      st(b, v);
      this.emitDispatch(f, v);
      out.push(f);
    }
    return out;
  }

  // map/each/flatmap CPS (§3): a map-like call site is a landCalls split
  // site, so the entry (this builtin Fn) runs with the caller's RET cell as
  // its k and its result dispatches through the caller's continuation. The
  // entry reads the array, allocates the result array into its own frame,
  // and tail-calls the loop-entry thunk; each iteration calls the callback
  // with a RET cell {K_RET, iter-land, entry frame, ambient k} — so a
  // performing callback walks the caller's handler chain, and a completed
  // callback lands in the per-iteration thunk (res[i] = v, i+1, loop-entry).
  // All loop state (result/tmp array, counter) lives in the entry frame
  // slots, so the loop survives suspension. The counter slot holds a boxed
  // number (slots are anyref); it is unboxed for comparisons and boxed
  // again when passed to the callback as the iteration index.
  emitMapLike(f: Fn, name: string): void {
    const b = f.body;
    const resSlot = name === "each" ? -1 : 2; // map: res, flatmap: tmp
    const iSlot = name === "each" ? 2 : 3;
    const loopEntry = this.makeRestThunk("maplike:loopEntry");
    const iterLand = this.makeRestThunk("maplike:iterLand");
    // Per-iteration land: store the callback result (map/flatmap), bump the
    // counter, continue the loop. frame = the entry frame, v = the callback
    // result, k = the ambient continuation (passed to the next iteration).
    {
      const t = iterLand, tb = t.body;
      if (name !== "each") {
        const blk = t.anyref(), iL = t.i32();
        this.slot(t, resSlot);
        rcast(tb, 3);
        sget(tb, 3, 0);
        st(tb, blk);
        this.slot(t, iSlot);
        rcastn(tb, 0);
        sget(tb, 0, 0);
        op(tb, TRUNC_F64);
        st(tb, iL);
        this.elemAddr(t, blk, iL);
        g(tb, 1);
        aset(tb, 1);
      }
      // counter += 1 (boxed back into the slot)
      g(tb, 0); sget(tb, 4, 1);
      i32c(tb, iSlot);
      this.slot(t, iSlot);
      rcastn(tb, 0);
      sget(tb, 0, 0);
      f64c(tb, 1);
      op(tb, FADD);
      op(tb, CALL);
      tb.lebU(this.fBox);
      aset(tb, 1);
      g(tb, 0);
      this.pushRef(t, this.unitRef);
      g(tb, 2);
      op(tb, RETURN_CALL);
      tb.lebU(loopEntry.idx);
    }

    // Loop entry: done → finalize (box the result / flatmap copy) and
    // dispatch through this thunk's k; else call the callback on element i.
    {
      const t = loopEntry, tb = t.body;
      const xb = t.anyref(), n = t.i32(), iL = t.i32(), fc = t.anyref();
      this.slot(t, 1); // the xs wrapper (arg 1) → its backing array and length
      rcast(tb, 3);
      sget(tb, 3, 0);
      st(tb, xb);
      g(tb, xb);
      rcast(tb, 1);
      alen(tb);
      st(tb, n);
      this.slot(t, iSlot);
      rcastn(tb, 0);
      sget(tb, 0, 0);
      op(tb, TRUNC_F64);
      st(tb, iL);
      g(tb, iL);
      g(tb, n);
      op(tb, GEU);
      op(tb, IF);
      tb.u8(0x40);
      const v = t.anyref();
      if (name === "map") {
        const res = t.anyref();
        this.slot(t, resSlot);
        rcast(tb, 3);
        sget(tb, 3, 0);
        st(tb, res);
        this.boxArr(t, res);
      } else if (name === "each") {
        this.pushRef(t, this.unitRef);
      } else {
        // flatmap: total = Σ per-element lengths; allocate; copy; box.
        const tmp = t.anyref(), total = t.i32();
        this.slot(t, resSlot);
        rcast(tb, 3);
        sget(tb, 3, 0);
        st(tb, tmp);
        i32c(tb, 0);
        st(tb, total);
        this.loop(t, () => {
          g(tb, n);
        }, i => {
          // total += len of callback result i: elem → its backing array →
          // len (scalar elements count as 1 — the tag test, not the value).
          const cell = t.anyref();
          this.elemAddr(t, tmp, i);
          aget(tb, 1);
          st(tb, cell);
          g(tb, cell);
          rtestn(tb, 3);
          op(tb, IF);
          tb.u8(0x40);
          g(tb, cell);
          rcast(tb, 3);
          sget(tb, 3, 0);
          rcast(tb, 1);
          alen(tb);
          g(tb, total);
          op(tb, ADD);
          st(tb, total);
          op(tb, ELSE);
          g(tb, total);
          i32c(tb, 1);
          op(tb, ADD);
          st(tb, total);
          op(tb, END);
        });
        const res = this.allocArrBlk(t, total);
        const w = t.i32();
        i32c(tb, 0);
        st(tb, w);
        this.loop(t, () => {
          g(tb, n);
        }, i => {
          const xb2 = t.anyref(), xl = t.i32();
          const cell = t.anyref();
          this.elemAddr(t, tmp, i);
          aget(tb, 1);
          st(tb, cell);
          g(tb, cell);
          rtestn(tb, 3);
          op(tb, IF);
          tb.u8(0x40);
          g(tb, cell);
          rcast(tb, 3);
          sget(tb, 3, 0);
          st(tb, xb2);
          g(tb, xb2);
          rcast(tb, 1);
          alen(tb);
          st(tb, xl);
          this.loop(t, () => {
            g(tb, xl);
          }, j => {
            // dst = res[w], src = xb2[j] (element values, same layout the
            // box/collect path reads back).
            this.elemAddr(t, res, w);
            this.elemAddr(t, xb2, j);
            aget(tb, 1);
            aset(tb, 1);
            g(tb, w);
            i32c(tb, 1);
            op(tb, ADD);
            st(tb, w);
          });
          op(tb, ELSE);
          this.elemAddr(t, res, w);
          g(tb, cell);
          aset(tb, 1);
          g(tb, w);
          i32c(tb, 1);
          op(tb, ADD);
          st(tb, w);
          op(tb, END);
        });
        this.boxArr(t, res);
      }
      st(tb, v);
      this.emitDispatch(t, v, 2); // k = this thunk's k param
      op(tb, RETURN); // only the k=0 branch reaches here, with the value
      op(tb, ELSE);
      // Iteration: elem = xs[i]; the callback's RET cell lands in iterLand
      // (landA) over this thunk's frame, with next = this thunk's k.
      this.slot(t, 0);
      st(tb, fc);
      const elem = t.anyref();
      this.elemAddr(t, xb, iL);
      aget(tb, 1);
      st(tb, elem);
      this.emitCallClosure(t, fc, name === "map" ? 1 : 2, (k, ffp) => {
        // Suspension-safe as-is: elem/iL are locals set before the call, and
        // fBox cannot suspend, so no operand spans a suspension point.
        g(tb, ffp); rcast(tb, 4); sget(tb, 4, 1);
        i32c(tb, k);
        if (k === 0) g(tb, elem);
        else {
          g(tb, iL);
          op(tb, CONV_I32);
          op(tb, CALL);
          tb.lebU(this.fBox);
        }
        aset(tb, 1);
      }, false, true, 2, true, iterLand.idx);
      op(tb, UNREACHABLE); // the callback always tails into iterLand
      op(tb, END);
      op(tb, UNREACHABLE); // both if arms diverge; keep the implicit end typed
    }
    // Entry (this builtin Fn): allocate the result array, init the counter,
    // tail-call the loop entry.
    const xb = f.anyref(), n = f.i32();
    this.slot(f, 1);
    rcast(b, 3);
    sget(b, 3, 0);
    st(b, xb);
    g(b, xb);
    rcast(b, 1);
    alen(b);
    st(b, n);
    if (resSlot >= 0) {
      const res = this.allocArrBlk(f, n);
      g(b, 0); sget(b, 4, 1);
      i32c(b, resSlot);
      this.boxArr(f, res); // the slot holds the $ARR wrapper (iterLand + the
                           // done path read it back as a wrapper)
      aset(b, 1);
    }
    g(b, 0); sget(b, 4, 1);
    i32c(b, iSlot);
    i32c(b, 0);
    op(b, CONV_I32);
    op(b, CALL);
    b.lebU(this.fBox);
    aset(b, 1);
    g(b, 0);
    this.pushRef(f, this.unitRef);
    g(b, 1);
    op(b, RETURN_CALL);
    b.lebU(loopEntry.idx);
  }

  // --- main & assembly -------------------------------------------------------

  emitMain(f: Fn): void {
    const b = f.body;
    // The global frame is allocated by run() (the frame param is local 0).
    const exprs = this.prog.items.filter((it): it is {e: ExprID} => "e" in it);
    const v = f.anyref();
    if (exprs.length === 0) {
      this.pushRef(f, this.unitRef);
      st(b, v);
    } else {
      // Same split protocol as bodyCatch: a perform/handle at the top level
      // ends the inline body; its fragment re-emits the remaining items.
      const savedCut = this.cutStack;
      const roots = exprs.map(it => it.e);
      this.bodyRoots.push({stmts: roots, sc: this.globalScope, tail: false, savedCut: [...savedCut]});
      try {
        try {
          for (let k = 0; k < exprs.length; k++) {
            const r = this.expr(exprs[k].e, f, this.globalScope);
            if (k < exprs.length - 1) { /* dropped: nothing on the stack */ }
            else { this.pushRef(f, r); st(b, v); }
          }
        } catch (sp) {
          this.cutStack = savedCut;
          if (!(sp instanceof Split)) throw sp;
          this.fillRest(sp, roots, this.globalScope, false);
          return; // the body ends at the split site (both paths tail-call)
        }
        this.cutStack = savedCut;
      } finally {
        this.bodyRoots.pop();
      }
    }
    // run() calls main with k = ref.null $K, so dispatch(null, v) returns
    // the top-level value.
    this.emitDispatch(f, v);
  }

  // $init (statics, §5 — the body was built by layoutStatics), run (calls
  // $init, allocates the global frame, calls main with k = null), and the
  // 12 host accessors (§4 — JS cannot read GC fields directly). Appended
  // after main; indices computed here.
  emitInits(): void {
    const mainIdx = this.liveImports.length + this.funcs.length - 1; // main is last
    const init = new Fn(0);
    init.typeIdx = T_INIT;
    init.idx = mainIdx + 1;
    init.body.bytes(this.initBody.b);
    this.funcs.push(init);
    const run = new Fn(0);
    run.typeIdx = T_RUN;
    run.idx = mainIdx + 2;
    {
      const b = run.body;
      op(b, CALL);
      b.lebU(init.idx);
      rnull(b, 4); // global frame parent = null
      i32c(b, this.frameSizeOf(this.globalScope));
      anew(b, 1);
      snew(b, 4);
      rnull(b, 5); // k = null: main's dispatch returns its value
      op(b, CALL);
      b.lebU(mainIdx);
    }
    this.funcs.push(run);
    const acc = (params: number, typeIdx: number, emit: (b: Buf, f: Fn) => void): Fn => {
      const f = new Fn(params);
      f.typeIdx = typeIdx;
      f.idx = this.liveImports.length + this.funcs.length;
      emit(f.body, f);
      this.funcs.push(f);
      return f;
    };
    // __tag(v) -> i32: 0 unit (null) 1 num 2 bool 3 str 4 arr 5 clo
    acc(1, 14, (b) => {
      g(b, 0);
      op(b, 0xd1);
      op(b, IF);
      b.u8(0x7f);
      i32c(b, 0);
      op(b, ELSE);
      const tag = (ht: number, t: number) => {
        g(b, 0);
        rtestn(b, ht);
        op(b, IF);
        b.u8(0x7f);
        i32c(b, t);
        op(b, ELSE);
      };
      tag(I31REF, 2);
      tag(0, 1); // $NUM
      tag(2, 3); // $STR
      tag(3, 4); // $ARR
      g(b, 0);
      rtestn(b, 6); // $CLO
      op(b, IF);
      b.u8(0x7f);
      i32c(b, 5);
      op(b, ELSE);
      op(b, UNREACHABLE);
      op(b, END);
      op(b, END);
      op(b, END);
      op(b, END);
      op(b, END);
      op(b, END);
    });
    // __num(v) -> f64
    acc(1, 19, (b) => {
      g(b, 0);
      rcastn(b, 0);
      sget(b, 0, 0);
    });
    // __str_len(v) -> i32
    acc(1, 14, (b) => {
      g(b, 0);
      rcastn(b, 2);
      alen(b);
    });
    // __str_get(v, i) -> i32
    acc(2, 20, (b) => {
      g(b, 0);
      rcastn(b, 2);
      g(b, 1);
      agetu(b, 2);
    });
    // __arr_len(v) -> i32
    acc(1, 14, (b) => {
      g(b, 0);
      rcastn(b, 3);
      sget(b, 3, 0);
      alen(b);
    });
    // __arr_get(v, i) -> anyref
    acc(2, 22, (b) => {
      g(b, 0);
      rcastn(b, 3);
      sget(b, 3, 0);
      g(b, 1);
      aget(b, 1);
    });
    // __mk_num(x) -> anyref
    acc(1, 13, (b) => {
      g(b, 0);
      snew(b, 0);
    });
    // __mk_bool(b) -> anyref
    acc(1, 12, (b) => {
      g(b, 0);
      i31ref(b);
    });
    // __str_new(n) -> anyref
    acc(1, 12, (b) => {
      g(b, 0);
      anew(b, 2);
    });
    // __str_set(v, i, u) -> ()
    acc(3, 21, (b) => {
      g(b, 0);
      rcastn(b, 2);
      g(b, 1);
      g(b, 2);
      aset(b, 2);
    });
    // __arr_new(n) -> anyref
    acc(1, 12, (b) => {
      g(b, 0);
      anew(b, 1);
      snew(b, 3);
    });
    // __arr_set(v, i, x) -> ()
    acc(3, 23, (b) => {
      g(b, 0);
      rcastn(b, 3);
      sget(b, 3, 0);
      g(b, 1);
      g(b, 2);
      aset(b, 1);
    });
  }

  assemble(): Uint8Array {
    this.emitInits();
    // type section: GC structs/arrays 0..6 then func types 7..23 (§1).
    const typeSection = new Buf();
    typeSection.lebU(24);
    // 0 $NUM: struct (field f64)
    typeSection.u8(0x5f).lebU(1).u8(0x7c).u8(0);
    // 1 $ELEMS: array (mut anyref)
    typeSection.u8(0x5e).u8(ANYREF).u8(1);
    // 2 $STR: array (mut i16)
    typeSection.u8(0x5e).u8(0x77).u8(1);
    // 3 $ARR: struct (field (mut (ref null $ELEMS)))
    typeSection.u8(0x5f).lebU(1).u8(0x63).lebU(1).u8(1);
    // 4 $FRAME: struct (field (mut (ref null $FRAME))) (field (mut (ref null $ELEMS)))
    typeSection.u8(0x5f).lebU(2).u8(0x63).lebU(4).u8(1).u8(0x63).lebU(1).u8(1);
    // 5 $K: struct (field (mut i31)) (field (mut anyref))*2 (field (mut (ref null $K)))
    typeSection.u8(0x5f).lebU(4).u8(I31REF).u8(1).u8(ANYREF).u8(1).u8(ANYREF).u8(1).u8(0x63).lebU(5).u8(1);
    // 6 $CLO: struct (field i31) (field (ref null $FRAME)) (field i31) — immutable
    typeSection.u8(0x5f).lebU(3).u8(I31REF).u8(0).u8(0x63).lebU(4).u8(0).u8(I31REF).u8(0);
    const emitType = (params: (number | number[])[], result: number | number[] | null) => {
      typeSection.u8(0x60);
      typeSection.lebU(params.length);
      for (const p of params) {
        if (Array.isArray(p)) typeSection.u8(0x63).lebU(p[1]); // (ref null $t)
        else typeSection.u8(p);
      }
      if (result === null) typeSection.lebU(0);
      else {
        typeSection.lebU(1);
        if (Array.isArray(result)) typeSection.u8(0x63).lebU(result[1]);
        else typeSection.u8(result);
      }
    };
    const ANY = ANYREF, I32 = 0x7f, F64 = 0x7c, K = [0x63, 5], FR = [0x63, 4];
    emitType([], ANY);                    // 7 T_RUN: () -> anyref
    emitType([], null);                   // 8 T_INIT: () -> ()
    emitType([I32, ANY], ANY);            // 9 T_PERFORM
    emitType([I32, ANY, F64, F64], null); // 10 T_FAIL
    emitType([ANY], ANY);                 // 11 T_STRNUM (char/number/cos/sin)
    emitType([I32], ANY);                 // 12 (__mk_bool/__str_new/__arr_new)
    emitType([F64], ANY);                 // 13 T_BOX / __mk_num
    emitType([ANY], I32);                 // 14 T_TRUTHY / __tag / __str_len / __arr_len
    emitType([ANY, ANY], ANY);            // 15 T_EQ
    emitType([K, K], K);                  // 16 T_CAPTURE
    emitType([FR, K], ANY);               // 17 T_KABI
    emitType([FR, ANY, K], ANY);          // 18 T_III_I
    emitType([ANY], F64);                 // 19 __num
    emitType([ANY, I32], I32);            // 20 __str_get
    emitType([ANY, I32, I32], null);      // 21 __str_set
    emitType([ANY, I32], ANY);            // 22 __arr_get
    emitType([ANY, I32, ANY], null);      // 23 __arr_set

    // import section
    const impSection = new Buf();
    impSection.lebU(this.liveImports.length);
    for (const n of this.liveImports) {
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
    tableSection.lebU(this.liveImports.length + this.funcs.length);

    // global section: (mut anyref) statics initialized ref.null any, filled
    // by $init at run() start (§5).
    const globalSection = new Buf();
    globalSection.lebU(this.gcount);
    for (let i = 0; i < this.gcount; i++) {
      globalSection.u8(ANYREF);
      globalSection.u8(0x01);
      globalSection.u8(REF_NULL);
      globalSection.u8(ANYREF);
      globalSection.u8(0x0b);
    }

    // exports: run + the 12 accessors (§4)
    const expNames = ["run", "__tag", "__num", "__str_len", "__str_get",
      "__arr_len", "__arr_get", "__mk_num", "__mk_bool", "__str_new",
      "__str_set", "__arr_new", "__arr_set"];
    const expSection = new Buf();
    expSection.lebU(expNames.length);
    for (let i = 0; i < expNames.length; i++) {
      expSection.name(expNames[i]);
      expSection.u8(0x00);
      expSection.lebU(this.liveImports.length + this.funcs.length - expNames.length + i);
    }

    // element segment: identity mapping table slot i → func i
    const total = this.liveImports.length + this.funcs.length;
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
    sec(6, globalSection);
    sec(7, expSection);
    sec(9, elemSection);
    sec(10, codeSection);
    return new Uint8Array(mod.b);
  }
}

// --- module-level optimization pipeline ---------------------------------------

// Ordered passes after the analysis phase and before index assignment (run
// in compile()); each records facts the emitters consume, and index
// assignment derives helper/lambda/builtin funcref indices from the live
// import count. The AST walks themselves live in analysis.ts (shared with
// interpreter-side consumers); planned for this seam: helper-function
// reachability, function-body dedup.
const OPT_PASSES: ((c: Compiler) => void)[] = [
  treeShakeBuiltins,
  dropDeadHostImports,
];

// Marks every builtin the program references as a value (analysis.ts
// builtinRefs — shadowing-correct, checker-mirroring binding order):
// layoutStatics/emitBuiltins emit only these.
function treeShakeBuiltins(c: Compiler): void {
  c.usedBuiltins = builtinRefs(c.prog);
}

// Import names that serve exactly one builtin each (import → builtin).
const BUILTIN_IMPORTS: Record<string, string> = {
  ef_char: "char", ef_number: "number", ef_args: "args",
  ef_cos: "cos", ef_sin: "sin",
};

// Drops dead host imports: a builtin-served import is live iff its builtin
// is in usedBuiltins (treeShakeBuiltins — shadowing-correct); ef_perform is
// live iff the program contains any perform node (analysis.ts performsAnyOp
// — any op, even inside a handler's body or a case body; handlers don't
// prove non-performance); ef_fail stays live unconditionally — proving it
// dead needs reachability analysis over the bounds checks in
// get/len/head/tail/set AND the inline index/field-access bounds checks
// (deferred to the helper-reachability pass). Live imports keep their
// HOST_IMPORTS order.
function dropDeadHostImports(c: Compiler): void {
  const live = HOST_IMPORTS.filter(n =>
    n === "ef_perform" ? performsAnyOp(c.prog) :
    n === "ef_fail" ? true :
    Object.hasOwn(BUILTIN_IMPORTS, n) &&
      c.usedBuiltins.has(BUILTIN_IMPORTS[n]));
  c.liveImports = live;
  c.impIdx = new Map(live.map((n, i): [string, number] => [n, i]));
}

// --- host runtime ------------------------------------------------------------


// --- host runtime ------------------------------------------------------------

// The §4 accessor ABI: 12 exported functions — the only way JS can touch GC
// structs. hostBox/hostUnbox rebuild interpreter Values through them.
type Accessors = {
  tag: (v: unknown) => number,
  num: (v: unknown) => number,
  strLen: (v: unknown) => number,
  strGet: (v: unknown, i: number) => number,
  arrLen: (v: unknown) => number,
  arrGet: (v: unknown, i: number) => unknown,
  mkNum: (x: number) => unknown,
  mkBool: (b: number) => unknown,
  strNew: (n: number) => unknown,
  strSet: (v: unknown, i: number, u: number) => void,
  arrNew: (n: number) => unknown,
  arrSet: (v: unknown, i: number, x: unknown) => void,
};

const accessorsOf = (inst: WebAssembly.Instance): Accessors => {
  const ex = inst.exports as unknown as {
    __tag(v: unknown): number,
    __num(v: unknown): number,
    __str_len(v: unknown): number,
    __str_get(v: unknown, i: number): number,
    __arr_len(v: unknown): number,
    __arr_get(v: unknown, i: number): unknown,
    __mk_num(x: number): unknown,
    __mk_bool(b: number): unknown,
    __str_new(n: number): unknown,
    __str_set(v: unknown, i: number, u: number): void,
    __arr_new(n: number): unknown,
    __arr_set(v: unknown, i: number, x: unknown): void,
  };
  return {
    tag: (v) => ex.__tag(v),
    num: (v) => ex.__num(v),
    strLen: (v) => ex.__str_len(v),
    strGet: (v, i) => ex.__str_get(v, i),
    arrLen: (v) => ex.__arr_len(v),
    arrGet: (v, i) => ex.__arr_get(v, i),
    mkNum: (x) => ex.__mk_num(x),
    mkBool: (b) => ex.__mk_bool(b),
    strNew: (n) => ex.__str_new(n),
    strSet: (v, i, u) => ex.__str_set(v, i, u),
    arrNew: (n) => ex.__arr_new(n),
    arrSet: (v, i, x) => ex.__arr_set(v, i, x),
  };
};

// Interpreter Value → anyref (via the accessors).
function hostBox(ex: Accessors, v: Value): unknown {
  if (v === null) return null;
  if (typeof v === "boolean") return ex.mkBool(v ? 1 : 0);
  if (typeof v === "number") return ex.mkNum(v);
  if (typeof v === "string") {
    const s = ex.strNew(v.length);
    for (let i = 0; i < v.length; i++) ex.strSet(s, i, v.charCodeAt(i));
    return s;
  }
  if (Array.isArray(v)) {
    const a = ex.arrNew(v.length);
    for (let i = 0; i < v.length; i++) ex.arrSet(a, i, hostBox(ex, v[i]));
    return a;
  }
  throw new Error("wasm host: cannot box value " + show(v));
}

// anyref → interpreter Value (via the accessors; i31 bools cross the JS
// boundary as Numbers).
function hostUnbox(ex: Accessors, v: unknown): Value {
  if (v === null) return null;
  switch (ex.tag(v)) {
    case 1: return ex.num(v);
    case 2: return (v as number) !== 0;
    case 3: {
      const n = ex.strLen(v);
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCharCode(ex.strGet(v, i));
      return s;
    }
    case 4: {
      const n = ex.arrLen(v);
      const out: Value[] = [];
      for (let i = 0; i < n; i++) out.push(hostUnbox(ex, ex.arrGet(v, i)));
      return out;
    }
    case 5: return {tag: "fn"} as Value; // closures display as [fn]
  }
  throw new Error(`wasm host: unknown anyref tag ${ex.tag(v)}`);
}

function hostStr(ex: Accessors, v: unknown): string {
  const n = ex.strLen(v);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(ex.strGet(v, i));
  return s;
}

export type EffectInterp = Partial<Record<string, (args: Value[]) => Value>>;

export function runWasm(src: string, interp?: EffectInterp): Value {
  const {bytes, ops} = compileWithOps(src);
  const mod = new WebAssembly.Module(bytes);
  // eslint-disable-next-line prefer-const
  let inst!: WebAssembly.Instance;
  const ex = () => accessorsOf(inst);
  const imports = {
    ef_perform: (opid: number, args: unknown) => {
      const op = (ops as (string | undefined)[])[opid];
      if (op === undefined) throw new Error(`wasm host: unknown effect opid ${opid}`);
      const argv = hostUnbox(ex(), args) as Value[];
      const custom = interp?.[op];
      if (custom !== undefined) return hostBox(ex(), custom(argv));
      const bi = (builtinEffectHosts as Record<string, ((args: Value[]) => Value) | undefined>)[op];
      if (bi === undefined) throw new Error("Unhandled effect: " + op);
      return hostBox(ex(), bi(argv));
    },
    ef_char: (v: unknown) => hostBox(ex(), String.fromCodePoint(ex().num(v) | 0)),
    ef_number: (v: unknown) => hostBox(ex(), parseFloat(hostStr(ex(), v))),
    ef_args: () => hostBox(ex(), process.argv.slice(2)),
    ef_cos: (v: unknown) => hostBox(ex(), Math.cos(ex().num(v))),
    ef_sin: (v: unknown) => hostBox(ex(), Math.sin(ex().num(v))),
    ef_fail: (code: number, name: unknown, a: number, b: number) => {
      if (code === 0) throw new Error("head of empty array");
      if (code === 1) throw new Error(`get: index ${a} out of bounds [0, ${b})`);
      throw new Error(`.${hostStr(ex(), name)}: index ${a} out of bounds [0, ${b})`);
    },
  };
  inst = new WebAssembly.Instance(mod, {env: imports});
  const result = (inst.exports.run as () => unknown)();
  return hostUnbox(ex(), result);
}
