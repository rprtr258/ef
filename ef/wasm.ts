// wasm.ts — WebAssembly backend for ef.
//
// Pipeline: parse → typecheck (types.ts, reused as-is) → emit a
// self-contained binary .wasm module → instantiate against host imports and
// run. No WasmGC, no external tools, no types needed at emission time: the
// only checker output the backend consumes is the runtime stamps the checker
// leaves on nodes (`e.div` for division, `e.idx` for field access).
//
// Subset: everything except suspension across `if`/`while` (a perform or
// handle site inside a branch or loop body is rejected at compile time).
// Every `perform` (builtin or user-declared op) boxes its args, spills the
// args cell to a frame slot, and walks the continuation chain for a handler.
// With no handler in the chain the effect reaches the host (which interprets
// it via the op table `compileWithOps` returns) and the rest-of-site
// fragment continues with the resumed value. `handle` installs a K_HDL
// continuation cell whose case table dispatches performed ops to per-case
// T_KABI functions running over the handler's shared hframe (§4.4); every
// perform/handle site ends the inline body and reifies the code after it as
// a rest-of-site fragment via the compile-time split protocol below. Resume
// as a value (§4.6): the resume binder is a TAG_CLO cell over the shared
// resume fn plus a per-perform-site capture record; every call copies the
// captured slice afresh, re-chains the copy's bottom to a fresh HDL whose
// next is the k the closure was invoked with, and dispatches the resumed
// value through that chain (terminating at the caller's continuation).
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
const RETURN = 0x0f, UNREACHABLE = 0x00;

// --- module-level constants -------------------------------------------------

const TAG_UNIT = 0, TAG_NUM = 1, TAG_BOOL = 2, TAG_STR = 3, TAG_ARR = 4, TAG_CLO = 5;
// k-cell kinds: cells are 16 bytes {kind@0, a@4, b@8, next@12}. K_RET: a = land
// thunk funcref index, b = frame the thunk runs over. K_HDL: a = case-table byte
// offset in the data section, b = the handler frame (hframe).
const K_RET = 0, K_HDL = 1;
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

// map/each/flatmap invoke user callbacks, so they are called land-style: a
// map-like call site is a landCalls split site (§3) and the builtin loops
// through per-iteration thunks instead of an inline wasm loop.
const MAP_LIKE = new Set(["map", "each", "flatmap"]);
// Extra entry-frame words a map-like builtin needs beyond its args: the
// result/tmp block pointer (except each) and the iteration counter.
const mapLikeFrameWords = (name: string): number =>
  name === "each" ? 1 : MAP_LIKE.has(name) ? 2 : 0;

// Builtin effects in op-table order. User-declared ops (from `effect` decls)
// follow them: `effOpIds` interns every op performed in the program, and the
// host maps an opid back to its name via the table `compileWithOps` returns.
const BUILTIN_EFFECT_OPS = ["Read", "Write", "Println", "Out", "Exit", "Wait", "Random"];

const HOST_IMPORTS = [
  "ef_perform",
  "ef_char", "ef_number", "ef_args", "ef_cos", "ef_sin", "ef_fail",
];

// Defined-function indices: helpers first, then lambdas, then handler case
// functions, builtins, main.
const F_ALLOC = HOST_IMPORTS.length, F_TRUTHY = F_ALLOC + 1, F_EQ = F_ALLOC + 2,
  F_BOX = F_ALLOC + 3, F_CAPTURE = F_ALLOC + 4,
  F_LAMBDA0 = F_ALLOC + 5;

// Type section indices. T_KABI is the uniform CPS ABI of every defined
// function (frame, k) -> i32; T_III_I is the land-thunk ABI (frame, v, k) -> i32.
const T_I_I = 0, T_V_I = 1, T_IIFF_I = 2, T_F_I = 3, T_II_I = 4,
  T_KABI = 5, T_III_I = 6;

function impType(n: string): number {
  if (n === "ef_perform") return T_II_I;
  if (n === "ef_fail") return T_IIFF_I;
  if (n === "ef_args") return T_V_I;
  return T_I_I;
}

// --- per-function emitter ---------------------------------------------------

class Fn {
  body = new Buf();
  locals: number[] = []; // extra locals in allocation order (valtype bytes)
  typeIdx = T_KABI; // program functions share (frame, k) -> i32; helpers may differ
  // Funcref table index (assigned at creation, stable across emission).
  idx = 0;
  constructor(public params: number) {}
  i32(): number { this.locals.push(0x7f); return this.params + this.locals.length - 1; }
  f64(): number { this.locals.push(0x7c); return this.params + this.locals.length - 1; }
}

// Emission context: which local holds the ambient continuation cell (1 = a
// T_KABI function's k param, 2 = a rest-of-site fragment's kNext param, any
// other local = a handle's K_HDL cell), plus the not-yet-executed cut path
// when re-emitting a fragment: cut[0] is the child of the current node on
// the path to the split site; an empty array marks the split site itself
// (its value is the fragment's v param).
type Ctx = {kL: number, cut?: ExprID[]};
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
  | {k: "const", off: number} // immediate cell (literal / unit / bool / placed closure)
  | {k: "local", l: number}   // wasm local index holding the cell pointer (single-use)
  | {k: "slot", off: number}; // frame slot: cell pointer at $fp + off
const REF_UNIT: ValueRef = {k: "const", off: UNIT_CELL};

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
  return {bytes: c.compile(), ops: c.effOps};
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
  thunks: Fn[] = []; // land thunks (T_III_I), emitted between builtins and main
  thunk0 = 0;        // funcref table index of the first land thunk
  lambdaIdx = new Map<ExprID, number>();
  // Effect op table: opid (table index) → op name. Seeded with the builtin
  // effects; discover() interns user-declared ops at perform sites.
  effOps: string[] = [...BUILTIN_EFFECT_OPS];
  effOpIds = new Map<string, number>(BUILTIN_EFFECT_OPS.map((op, i) => [op, i]));
  // Handler machinery (§4.4): per `handle` node, its op cases (each a
  // T_KABI function over the handler's shared hframe), the explicit Return
  // case if any, the offset of its dispatch table in static data (set by
  // layoutStatics), and the hframe scope discover() bound the case
  // params/resume names into. Filled by discover().
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
  piOff = 0;
  hp0 = 0;
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
  // Open if/while structures at emission time. A split cannot cross one (the
  // partial branch/loop bytes would dangle in the body buffer), so perform/
  // handle sites throw a compile error instead.
  ctlDepth = 0;
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
    // 1. Scope discovery: scopes per lambda/block, slot numbering, literals.
    for (const it of this.prog.items) {
      if ("e" in it) this.discover(it.e, this.globalScope);
    }
    // 2. Function index assignment (deterministic AST order).
    for (const it of this.prog.items) {
      if ("e" in it) this.assignLambdas(it.e);
    }
    // 2b. Spill slots for perform/handle sites (§4.2/§4.4): each perform
    // gets an args-cell slot and a result-value slot, each handle a
    // result-value slot, folded into the enclosing frame's size (case-body
    // spills go into the handler's hframe).
    this.computeSpills();
    // 2c. Handler case functions: funcref indices + hframe sizes, plus the
    // shared default-Return identity function.
    this.assignCaseFns();
    const builtin0 = F_LAMBDA0 + this.lambdaIdx.size + this.caseFnTotal;
    // Land thunks occupy the table slots between builtins and main.
    this.thunk0 = builtin0 + BUILTINS.length;
    // 3. Static layout (heap pointer starts after it).
    this.layoutStatics(builtin0);
    this.hp0 = (this.data.b.length + 7) & ~7;
    // 4. Emit code: helpers (fixed indices 11..14), lambdas, builtin
    //    trampolines, then main (last).
    this.funcs.push(...this.emitHelpers());
    for (const it of this.prog.items) {
      if ("e" in it) this.emitLambdas(it.e);
    }
    this.emitCaseFns();
    this.funcs.push(...this.emitBuiltins(builtin0));
    const main = new Fn(2);
    this.emitMain(main);
    // Thunks are appended after all emission (emitMain's top-level calls
    // create thunks too); main stays the last function (exported as run).
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
        if (!this.effOpIds.has(e.op)) {
          this.effOpIds.set(e.op, this.effOps.length);
          this.effOps.push(e.op);
        }
        for (const a of e.args) this.discover(a, sc);
        break;
      case "handle": {
        // Intern the handler's ops (case tables reference opids) and size
        // the shared hframe: op params at slots 0..npMax-1 (per matched
        // case, unit-padded), each case's resume binder at slot nparams,
        // the Return param at slot npMax+1 (emitDispatch writes it there
        // via the Return entry's nparams = npMax), spill slots after.
        let npMax = 0;
        for (const c of e.cases) {
          if (c.op === "Return") continue;
          if (!this.effOpIds.has(c.op)) {
            this.effOpIds.set(c.op, this.effOps.length);
            this.effOps.push(c.op);
          }
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
  emitCaseFns(): void {
    const idf = this.identityRet!;
    {
      const b = idf.body;
      const v = idf.i32();
      g(b, 0);
      ld(b, 12); // hframe slot 1: the Return value
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
        const v = idr.i32();
        g(b, 0);
        ld(b, 8 + 4 * (info.npMax + 1)); // hframe Return slot (nparams = npMax)
        st(b, v);
        this.emitDispatch(idr, v);
        this.funcs.push(idr);
      }
    }
    // The shared resume closure fn (§4.6): (frame, k) -> cell. frame's
    // parent is the perform site's capture record {arg0 = captured slice,
    // arg1 = matched HDL}; frame's arg0 is the resumed value. Copies the
    // slice afresh (originals untouched — multi-shot safe), re-chains the
    // copy's bottom to a fresh HDL {case table, hframe, next = this call's
    // k} and dispatches the resumed value through the fresh chain: RET
    // cells run the segment's fragments, the fresh HDL's Return entry
    // fires, and dispatch terminates at the caller's continuation.
    const rf = this.resumeFn!;
    {
      const b = rf.body;
      const v = rf.i32(), slice = rf.i32(), hdl = rf.i32();
      const copy = rf.i32(), fresh = rf.i32(), cur = rf.i32();
      g(b, 0);
      ld(b, 8);
      st(b, v); // the resumed value: the closure call frame's arg0
      g(b, 0);
      ld(b, 0);
      ld(b, 12);
      st(b, slice);
      g(b, 0);
      ld(b, 0);
      ld(b, 16);
      st(b, hdl);
      g(b, slice);
      g(b, hdl);
      op(b, CALL);
      b.lebU(F_CAPTURE);
      st(b, copy);
      i32c(b, 16);
      op(b, CALL);
      b.lebU(F_ALLOC);
      st(b, fresh);
      g(b, fresh);
      i32c(b, K_HDL);
      strd(b, 0);
      g(b, fresh);
      g(b, hdl);
      ld(b, 4);
      strd(b, 4); // a = the matched handler's case-table offset
      g(b, fresh);
      g(b, 0);
      ld(b, 0);
      ld(b, 20);
      strd(b, 8); // b = the invocation's hframe copy (rec arg2)
      g(b, fresh);
      g(b, 1); // next = the k this closure was invoked with
      strd(b, 12);
      g(b, copy);
      st(b, cur);
      op(b, BLOCK);
      b.u8(0x40);
      op(b, LOOP);
      b.u8(0x40);
      g(b, cur);
      ld(b, 12);
      g(b, hdl);
      op(b, EQ);
      op(b, BR_IF);
      b.lebU(1); // cur is the bottom copy (its next is the old HDL)
      g(b, cur);
      ld(b, 12);
      st(b, cur);
      op(b, BR);
      b.lebU(0);
      op(b, END);
      op(b, END);
      g(b, cur);
      g(b, fresh);
      strd(b, 12);
      this.emitDispatch(rf, v, copy); // k = the closure's own k param
    }
    this.funcs.push(rf);
  }

  // One statement of a body sequence; the sequence completes by dispatching
  // its last value (or unit) through the ambient continuation `ctx.kL`.
  // A perform/handle site inside ends the body via a thrown Split.
  emitStmtSeq(stmts: ExprID[], f: Fn, sc: Scope, tail: boolean, ctx: Ctx): void {
    const b = f.body;
    if (stmts.length === 0) {
      const v = f.i32();
      i32c(b, UNIT_CELL);
      st(b, v);
      this.emitDispatch(f, v, ctx.kL);
      return;
    }
    for (let k = 0; k < stmts.length; k++) {
      const r = this.expr(stmts[k], f, sc, tail && k === stmts.length - 1, ctx);
      if (k === stmts.length - 1) {
        this.pushRef(f, r);
        const v = f.i32();
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
    this.ctlDepth = 0;
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
    const g = sp.restFn;
    // A shared after-rest fragment (e.g. a handle's) may be routed here
    // again by a later re-emission of the same site; its content is already
    // correct, so re-filling would only append a duplicate tail.
    if (this.filledRests.has(g)) return;
    this.filledRests.add(g);
    const b = g.body;
    const ci = root.indexOf(sp.chain[0]);
    if (ci < 0) throw new WasmError("internal: split chain root mismatch");
    const savedCut = this.cutStack;
    this.ctlDepth = 0;
    try {
      for (let k = 0; k < root.length; k++) {
        if (k < ci) continue; // executed before the split
        const r = (k === ci)
          ? this.expr(sp.chain[0], g, sc, tail && k === root.length - 1, {kL: 2, cut: sp.chain.slice(1)})
          : this.expr(root[k], g, sc, tail && k === root.length - 1, {kL: 2});
        if (k === root.length - 1) {
          this.pushRef(g, r);
          const v = g.i32();
          st(g.body, v);
          this.emitDispatch(g, v, 2); // kNext param
        }
      }
    } catch (sp2) {
      this.cutStack = savedCut;
      if (!(sp2 instanceof Split)) throw sp2;
      // The re-emitted code ended at another split site: this fragment is
      // complete (it ends at that site's host boundary / case invocation);
      // the rest after it chains into the new site's fragment.
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
    let r: ValueRef = REF_UNIT;
    for (let k = ci; k < stmts.length; k++) {
      r = (k === ci)
        ? this.expr(stmts[k], f, s, tail && k === stmts.length - 1, {kL: ctx.kL, cut: cut.slice(1)})
        : this.expr(stmts[k], f, s, tail && k === stmts.length - 1, {kL: ctx.kL});
    }
    return r;
  }

  // --- helper functions (fixed indices 11..14) -------------------------------

  emitHelpers(): Fn[] {
    // $alloc(n: i32) -> i32: bump-allocate n (rounded to 8) bytes, growing
    // memory as needed. $hp is the module's mutable heap-pointer global.
    const alloc = new Fn(1);
    alloc.typeIdx = T_I_I; // internal helper, not part of the CPS ABI
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
    truthy.typeIdx = T_I_I; // internal helper, not part of the CPS ABI
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
    // $captureSlice(k: i32, until: i32) -> i32: reify the slice of
    // continuation cells strictly above `until` (the matched K_HDL) as a
    // FRESH cell chain — originals untouched (cells are immutable; the
    // resume closure copies again). The head is a copy of the cell at `k`
    // (the perform's just-pushed RET); each copy keeps {kind, a, b} verbatim
    // and chains to the next copy; the last copy's next points at `until`.
    const capture = new Fn(2);
    {
      const b = capture.body;
      const n = capture.i32(), cur = capture.i32(), base = capture.i32();
      const i = capture.i32(), src = capture.i32(), dst = capture.i32();
      // Pass 1: n = number of cells from k up to (excluding) until.
      i32c(b, 0);
      st(b, n);
      g(b, 0);
      st(b, cur);
      op(b, BLOCK);
      b.u8(0x40);
      op(b, LOOP);
      b.u8(0x40);
      g(b, cur);
      g(b, 1);
      op(b, EQ);
      op(b, BR_IF);
      b.lebU(1);
      g(b, n);
      i32c(b, 1);
      op(b, ADD);
      st(b, n);
      g(b, cur);
      ld(b, 12);
      st(b, cur);
      op(b, BR);
      b.lebU(0);
      op(b, END);
      op(b, END);
      // Pass 2: one contiguous fresh block, cell i at base + 16*i.
      g(b, n);
      i32c(b, 16);
      op(b, MUL);
      op(b, CALL);
      b.lebU(F_ALLOC);
      st(b, base);
      g(b, 0);
      st(b, src);
      i32c(b, 0);
      st(b, i);
      op(b, BLOCK);
      b.u8(0x40);
      op(b, LOOP);
      b.u8(0x40);
      g(b, base);
      g(b, i);
      i32c(b, 16);
      op(b, MUL);
      op(b, ADD);
      st(b, dst);
      g(b, dst);
      g(b, src);
      ld(b, 0);
      strd(b, 0); // kind
      g(b, dst);
      g(b, src);
      ld(b, 4);
      strd(b, 4); // a
      g(b, dst);
      g(b, src);
      ld(b, 8);
      strd(b, 8); // b
      g(b, i);
      i32c(b, 1);
      op(b, ADD);
      st(b, i);
      g(b, i);
      g(b, n);
      op(b, EQ);
      op(b, IF);
      b.u8(0x40);
      // Last copy chains to the matched handler cell (the resume closure
      // replaces that pointer with a fresh HDL chained to the resume-site k).
      g(b, dst);
      g(b, 1);
      strd(b, 12);
      op(b, ELSE);
      g(b, dst);
      g(b, base);
      g(b, i);
      i32c(b, 16);
      op(b, MUL);
      op(b, ADD);
      strd(b, 12);
      op(b, END);
      g(b, i);
      g(b, n);
      op(b, EQ);
      op(b, BR_IF);
      b.lebU(1);
      g(b, src);
      ld(b, 12);
      st(b, src);
      op(b, BR);
      b.lebU(0);
      op(b, END);
      op(b, END);
      g(b, base);
    }
    return [alloc, truthy, eq, box, capture];
  }

  // Whether emitting this subtree can throw a Split: a perform or handle
  // site whose split escapes the enclosing body (lambda bodies catch their
  // own, so they do not propagate). Drives operand-spill allocation.
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
            if (!this.pure(e.c)) this.addOperandSpill(e.c, frame);
            if (!this.pure(e.a)) this.addOperandSpill(e.a, frame);
            if (!this.pure(e.b)) this.addOperandSpill(e.b, frame);
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
          // inline body: every impure sibling's value must survive in a
          // spill slot so the fragment reloads it instead of re-running it.
          if (kids.some(k2 => this.splits(k2))) {
            for (const k2 of kids) {
              if (!this.pure(k2)) this.addOperandSpill(k2, frame);
            }
          }
          for (const k2 of kids) walk(k2, frame);
          break;
        }
        case "arr": {
          const elems = e.elems;
          if (elems.some(el => this.splits(el))) {
            for (const el of elems) {
              if (!this.pure(el)) this.addOperandSpill(el, frame);
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
              if (!this.pure(a)) this.addOperandSpill(a, frame);
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
    idf.idx = F_LAMBDA0 + this.lambdaIdx.size;
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
        // fsize: map-like entries keep their result block + counter in the
        // frame the per-iteration thunks reload after a suspension.
        (bi.params + mapLikeFrameWords(bi.name)) & 0xff, 0, 0, 0,
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
    // Handler case tables (§4.4): [n: i32][opid, fnIdx, fsize, nparams]*.
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
      const words = [entries.length];
      for (const en of entries) words.push(en.opid, en.fn.idx, en.fsize, en.nparams);
      const bytes = words.flatMap(w => [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >> 24) & 0xff]);
      const off = this.place(bytes, 4);
      this.hdlCases.get(hdlId)!.tableOff = off;
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
  // current frame, a fresh local for parent frames (the frame walk balances
  // its own stack), or an immediate for placed closures.
  emitSym(f: Fn, sc: Scope, name: string): ValueRef {
    const b = f.body;
    const r = this.resolve(sc, name);
    if (r !== null) {
      if (r.d === 0) return {k: "slot", off: 8 + 4 * r.i};
      const v = f.i32();
      g(b, 0);
      for (let k = 0; k < r.d; k++) ld(b, 0); // walk parent frames
      ld(b, 8 + 4 * r.i);
      st(b, v);
      return {k: "local", l: v};
    }
    const clo = this.cloOffsets.get(name);
    if (clo !== undefined) return {k: "const", off: clo};
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
    const cell = f.i32();
    i32c(b, 16);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, cell);
    g(b, cell);
    i32c(b, K_RET);
    strd(b, 0);
    g(b, cell);
    i32c(b, fragIdx);
    strd(b, 4);
    g(b, cell);
    g(b, 0); // b = the frame the fragment runs over
    strd(b, 8);
    g(b, cell);
    nextE();
    strd(b, 12);
    return cell;
  }

  emitCallClosure(f: Fn, fc: number, argc: number, argEmit: (k: number, ffp: number) => void, tail = false, land = false, kL = 1, noSplit = false, landA?: number): void {
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
    let splitAt: Split | null = null;
    if (tail) g(b, kL); // tail call: pass the ambient continuation through
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
        // return must not unwind through this call site.
        const rest = this.makeRestThunk();
        g(b, this.retCell(f, rest.idx, () => g(b, kL))); // next = ambient k
        splitAt = new Split(rest, [...this.cutStack]);
      }
    } else i32c(b, 0); // k=0: the callee's dispatch(0, v) returns its value inline
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
  makeRestThunk(): Fn {
    const f = new Fn(3);
    f.typeIdx = T_III_I;
    f.idx = this.thunk0 + this.thunks.length;
    this.thunks.push(f);
    return f;
  }

  // End-of-body dispatch: completes a T_KABI function whose result cell sits
  // in local `v`; `k` is the function's second parameter. k == 0 → the value
  // is the result. K_RET cell → tail-call the land thunk over its frame.
  // K_HDL cell → scan the case table at k.a for the Return entry (opid -1):
  // found → write v into the hframe's Return param slot (nparams + 1) and
  // tail-call the Return case body with (hframe, k.next); not found →
  // identity default, propagate the value through k.next (eval.ts:135).
  // `k` is the local holding the continuation cell: 1 = the k parameter of
  // the (frame, k) -> i32 ABI, 2 = the k parameter of a land thunk.
  emitDispatch(f: Fn, v: number, k = 1): void {
    const b = f.body;
    const nL = f.i32(), iL = f.i32(), found = f.i32(), fnIdx = f.i32(),
      nparams = f.i32(), ent = f.i32();
    op(b, BLOCK);
    b.u8(0x7f); // block (result i32)
    op(b, LOOP);
    b.u8(0x40);
    g(b, k); i32c(b, 0); op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    g(b, v);
    op(b, BR); b.lebU(2); // leave the block with v
    op(b, END);
    g(b, k); ld(b, 0); i32c(b, K_RET); op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    // RET: tail-call the land thunk (frame, v, next); funcref index last.
    g(b, k); ld(b, 8);
    g(b, v);
    g(b, k); ld(b, 12);
    g(b, k); ld(b, 4);
    op(b, RETURN_CALL_INDIRECT);
    b.lebU(T_III_I);
    b.lebU(0);
    op(b, END);
    // K_HDL: scan the case table at k.a (a data-section byte offset, laid out
    // [n][opid, fnIdx, fsize, nparams]*; the Return case, opid -1, goes last).
    g(b, k); ld(b, 4); ld(b, 0); st(b, nL);
    i32c(b, 0); st(b, found);
    i32c(b, 0); st(b, iL);
    op(b, BLOCK);
    b.u8(0x40);
    op(b, LOOP);
    b.u8(0x40);
    g(b, iL); g(b, nL); op(b, GEU); op(b, BR_IF); b.lebU(1);
    g(b, k); ld(b, 4); i32c(b, 4); op(b, ADD);
    g(b, iL); i32c(b, 16); op(b, MUL); op(b, ADD); st(b, ent);
    g(b, ent); ld(b, 0); i32c(b, -1); op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    i32c(b, 1); st(b, found);
    g(b, ent); ld(b, 4); st(b, fnIdx);
    g(b, ent); ld(b, 12); st(b, nparams);
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
    g(b, k); ld(b, 8);
    g(b, nparams); i32c(b, 1); op(b, ADD); i32c(b, 4); op(b, MUL); i32c(b, 8); op(b, ADD);
    op(b, ADD);
    g(b, v);
    strd(b, 0);
    g(b, k); ld(b, 8);
    g(b, k); ld(b, 12);
    g(b, fnIdx);
    op(b, RETURN_CALL_INDIRECT);
    b.lebU(T_KABI);
    b.lebU(0);
    op(b, END);
    // No Return case: k = k.next and dispatch again.
    g(b, k); ld(b, 12); st(b, k);
    op(b, BR); b.lebU(0);
    op(b, END); // loop
    op(b, 0x00); // unreachable: the loop exits only through the k==0 branch
    op(b, END); // block
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

  // Materialize a ValueRef onto the operand stack, at its consume point.
  // This is the ONLY sanctioned place short-lived stack values cross an
  // emitter boundary (the helper fully balances the stack per ref).
  pushRef(f: Fn, r: ValueRef): void {
    const b = f.body;
    if (r.k === "const") i32c(b, r.off);
    else if (r.k === "local") g(b, r.l);
    else { g(b, 0); ld(b, r.off); }
  }

  // Persist a ref into the operand spill slot computeSpills allocated for
  // `id` (if any) and return the slot ref: a value that must survive a
  // later split is read back from the frame by the fragment machinery.
  keepRef(id: ExprID, f: Fn, r: ValueRef): ValueRef {
    const sp = this.operandSpill.get(id);
    if (sp === undefined) return r;
    const b = f.body;
    this.pushRef(f, r);
    const t = f.i32();
    st(b, t);
    g(b, 0);
    g(b, t);
    strd(b, 8 + 4 * sp);
    return {k: "slot", off: 8 + 4 * sp};
  }

  // Value of a child that already ran before a split deeper among its
  // siblings: a slot ref to its spilled value, or (pure children) re-emit
  // it inline — observationally identical.
  preCut(id: ExprID, f: Fn, s: Scope, ctx: Ctx): ValueRef {
    const sp = this.operandSpill.get(id) ?? this.valSpill.get(id);
    if (sp !== undefined) return {k: "slot", off: 8 + 4 * sp};
    return this.expr(id, f, s, false, {kL: ctx.kL});
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
    if (mode === "cut") return this.keepRef(child, f, this.expr(child, f, s, false, {kL: ctx.kL, cut: ctx.cut!.slice(1)}));
    if (mode === "pre") return this.keepRef(child, f, this.preCut(child, f, s, ctx));
    return this.keepRef(child, f, this.expr(child, f, s, tail, {kL: ctx.kL}));
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
        return {k: "const", off: this.numLits.get(e.v)!};
      case "str":
        return {k: "const", off: this.strLits.get(e.v)!};
      case "bool":
        return {k: "const", off: e.v ? TRUE_CELL : FALSE_CELL};
      case "unit":
        return REF_UNIT;
      case "sym":
        return this.emitSym(f, s, e.v);
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
        i32c(b, this.frameSizeOf(this.scopes.get(id)!)); // params + body lets + perform spills
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
        const v = f.i32();
        st(b, v);
        return {k: "local", l: v};
      }
      case "let": {
        // Binds in the current frame (mirrors the interpreter: the binding
        // exists before the value is computed, so `let x = x` sees null).
        const slot = s.map.get(e.name)!;
        const vr = this.expr(e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1)});
        g(b, 0); // frame address
        this.pushRef(f, vr);
        strd(b, 8 + 4 * slot);
        return REF_UNIT;
      }
      case "dlet": {
        const blk = f.i32();
        const vr = this.expr(e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1)});
        this.pushRef(f, vr);
        ld(b, 8);
        st(b, blk);
        for (let k = 0; k < e.fields.length; k++) {
          const slot = s.map.get(e.fields[k].name)!;
          // cellAt(blk, 8+4k) → frame slot (balances its stack in place)
          g(b, 0);
          g(b, blk);
          ld(b, 8 + 4 * k);
          strd(b, 8 + 4 * slot);
        }
        return REF_UNIT;
      }
      case "assign": {
        const r = this.resolve(s, e.name);
        if (r === null) throw new WasmError(`Assignment to unbound symbol: ${e.name}`);
        const vr = this.expr(e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1)});
        g(b, 0);
        for (let k = 0; k < r.d; k++) ld(b, 0);
        this.pushRef(f, vr);
        strd(b, 8 + 4 * r.i);
        return REF_UNIT;
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
          return REF_UNIT; // unreachable: the dispatch-shape if throws Split
        }
        // Value shape — shared by fresh emission (ci undefined) and
        // fragment re-emission (no arm can split): condition and both arms
        // are value-explicit; each arm's ref is pushed as the IF block's
        // result value. Fragment re-emission never tail-calls the arms.
        const at = ci === undefined && tail;
        this.pushRef(f, this.cutChildRef(e.c, f, s, ctx, ci === undefined ? "post" : ci === 0 ? "cut" : "pre"));
        op(b, CALL);
        b.lebU(F_TRUTHY);
        op(b, IF);
        b.u8(0x7f); // result i32
        this.ctlDepth++;
        this.pushRef(f, this.cutChildRef(e.a, f, s, ctx, ci === undefined ? "post" : ci === 1 ? "cut" : ci === 2 ? "pre" : "post", at));
        op(b, ELSE);
        this.pushRef(f, this.cutChildRef(e.b, f, s, ctx, ci === undefined ? "post" : ci === 2 ? "cut" : "post", at));
        this.ctlDepth--;
        op(b, END);
        const v = f.i32();
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
          return REF_UNIT; // unreachable: the split-mode while throws Split
        }
        if (cut !== undefined) throw new WasmError("internal: split crossing a while");
        op(b, BLOCK);
        b.u8(0x40);
        op(b, LOOP);
        b.u8(0x40);
        this.ctlDepth++;
        this.pushRef(f, this.expr(e.c, f, s, false, ctx));
        op(b, CALL);
        b.lebU(F_TRUTHY);
        op(b, EQZ);
        op(b, BR_IF);
        b.lebU(1);
        this.ctlDepth++;
        this.expr(e.body, f, s, false, ctx); // body value dropped: nothing on the stack
        this.ctlDepth -= 2;
        op(b, BR);
        b.lebU(0);
        op(b, END);
        op(b, END);
        return REF_UNIT;
      }
      case "block": {
        if (cut === undefined) {
          let last: ValueRef = REF_UNIT;
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
        const blk = f.i32();
        i32c(b, 8 + 4 * e.elems.length);
        op(b, CALL);
        b.lebU(F_ALLOC);
        st(b, blk);
        g(b, blk);
        i32c(b, e.elems.length);
        strd(b, 0);
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
          i32c(b, 8 + 4 * k);
          op(b, ADD);
          this.pushRef(f, r);
          strd(b, 0);
        }
        this.boxArr(f, blk);
        const v = f.i32();
        st(b, v);
        return {k: "local", l: v};
      }
      case "field": {
        const o = f.i32(), blk = f.i32();
        this.pushRef(f, this.expr(e.obj, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1)}));
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
        const v = f.i32();
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
        return REF_UNIT; // unreachable: perform always ends at its split site
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
          const v = f.i32();
          st(b, v);
          this.emitDispatch(f, v, ctx.kL);
          // The dispatch tail-calls away (every table carries a Return
          // entry); the after-handle rest chains from the split site.
          throw new Split(this.hdlRest.get(id)!, [...this.cutStack]);
        }
        this.emitHandle(id, e, f, s, ctx);
        return REF_UNIT; // unreachable: the body's dispatch tail-calls away
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
          if (ci === 0) throw new WasmError("internal: split chain root mismatch");
          this.pushRef(f, this.cutChildRef(e.args[0], f, s, ctx, ci === 1 ? "cut" : ci < 0 ? "post" : "pre"));
          ld64(b, 8);
          this.pushRef(f, this.cutChildRef(e.args[1], f, s, ctx, ci === 2 ? "cut" : "post"));
          ld64(b, 8);
          op(b, FDIV);
          if (e.div === "int") op(b, FTRUNC);
          // Fresh + tail: the boxed value is the caller's return value;
          // fragment re-emission: the value continues inside the fragment.
          op(b, cut === undefined && tail ? RETURN_CALL : CALL); // return_call / call
          b.lebU(F_BOX);
        } else {
          const fc = f.i32();
          this.pushRef(f, this.cutChildRef(e.fn, f, s, ctx, ci === 0 ? "cut" : ci < 0 ? "post" : "pre"));
          st(b, fc);
          this.emitCallClosure(f, fc, e.args.length, (k, ffp) => {
            // Value-explicit arg order: the child's ref is computed (and
            // spilled) BEFORE the destination address is pushed, so a split
            // inside the child aborts on a clean operand stack (blocker (b)
            // by construction).
            const r = this.cutChildRef(e.args[k], f, s, ctx,
              k + 1 === ci ? "cut" : k + 1 < ci ? "pre" : "post");
            g(b, ffp);
            i32c(b, 8 + 4 * k);
            op(b, ADD);
            this.pushRef(f, r);
            strd(b, 0);
          }, cut === undefined && tail,
          // Builtins never perform or capture, so they keep the k=0
          // trampoline convention; every other (lambda) call site lands
          // through a RET cell and is a split site (§3 emitCall).
          this.landCalls.has(id),
          ctx.kL);
        }
        // emitCallClosure leaves the landed result on the stack (or
        // tail-returns, making this capture unreachable). Bridge to a ref.
        const v = f.i32();
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

  // §4.2 perform. Package the op's args as an array cell (same layout as an
  // `arr` literal) and spill it to the frame slot computeSpills allocated:
  // the cell must survive the handler walk and stay reachable from the
  // after-perform fragment through the RET cell's frame pointer (cell.b).
  // Then scan-first: walk the continuation chain (the ambient continuation,
  // ctx.kL) BEFORE pushing anything, looking for the first K_HDL whose case
  // table contains the performed opid.
  // - Handler found: push this perform's RET cell {K_RET, rest-of-site
  //   fragment, frame, ambient k}, capture the slice (every cell strictly
  //   above the handler, INCLUDING the just-pushed RET, reified as a fresh
  //   cell chain), bind the case params from the args cell plus the boxed
  //   resume closure as the resume binder, and tail-call the matched case
  //   body with (hframe, hdl.next) — the two-k rule: the case body's ambient
  //   continuation is OUTSIDE the handler, never a chain containing it.
  // - No handler (the walk reaches k=0): bare ef_perform host call, then
  //   the SAME rest-of-site fragment the RET cell carries tail-calls with
  //   (fp, v, ambient k) — one copy of the after-perform code, no
  //   allocation on the host path.
  // Either way the inline body ends here; the enclosing body-level catcher
  // (bodyCatch/emitMain/fillRest) fills the fragment afterwards.
  emitPerform(id: ExprID, e: Expr & {t: "perform"}, f: Fn, s: Scope, ctx: Ctx): void {
    if (this.ctlDepth > 0) {
      throw new WasmError("wasm target: perform inside if/while is not supported");
    }
    const b = f.body;
    const blk = f.i32(), cell = f.i32();
    i32c(b, 8 + 4 * e.args.length);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, blk);
    g(b, blk);
    i32c(b, e.args.length);
    strd(b, 0);
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
      i32c(b, 8 + 4 * k);
      op(b, ADD);
      this.pushRef(f, r);
      strd(b, 0);
    }
    this.boxArr(f, blk);
    st(b, cell);
    const spillSlot = this.spillOf.get(id)!;
    g(b, 0);
    g(b, cell);
    strd(b, 8 + 4 * spillSlot);
    // Handler walk: kL walks the k chain; the first K_HDL whose case table
    // ([n][opid, fnIdx, fsize, nparams]*) contains opid wins. The pre-walk
    // ambient continuation (amb) is what the RET cell carries: fragments
    // re-dispatch through their kNext, so a resumed segment follows the
    // fresh §4.6 chain (copied HDLs + kCaller) instead of skipping it.
    const opid = this.effOpIds.get(e.op)!;
    const restFn = this.makeRestThunk();
    const kL = f.i32(), hdl = f.i32(), found = f.i32();
    const nL = f.i32(), ent = f.i32();
    const fnIdx = f.i32(), nparams = f.i32(), amb = f.i32();
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
    i32c(b, 0);
    op(b, EQ);
    op(b, BR_IF);
    b.lebU(1); // k=0: no handler anywhere → host fallback
    g(b, kL);
    ld(b, 0);
    i32c(b, K_HDL);
    op(b, EQ);
    op(b, IF);
    b.u8(0x40);
    g(b, kL);
    ld(b, 4);
    ld(b, 0);
    st(b, nL);
    this.loop(f, () => {
      g(b, nL);
    }, iL => {
      g(b, kL);
      ld(b, 4);
      i32c(b, 4);
      op(b, ADD);
      g(b, iL);
      i32c(b, 16);
      op(b, MUL);
      op(b, ADD);
      st(b, ent);
      g(b, ent);
      ld(b, 0);
      i32c(b, opid);
      op(b, EQ);
      op(b, IF);
      b.u8(0x40);
      i32c(b, 1);
      st(b, found);
      g(b, kL);
      st(b, hdl);
      g(b, ent);
      ld(b, 4);
      st(b, fnIdx);
      g(b, ent);
      ld(b, 12);
      st(b, nparams);
      op(b, BR);
      b.lebU(2); // exit the table scan
      op(b, END);
    });
    g(b, found);
    op(b, BR_IF);
    b.lebU(2); // matched handler → leave the walk
    op(b, END);
    g(b, kL);
    ld(b, 12);
    st(b, kL);
    op(b, BR);
    b.lebU(0);
    op(b, END);
    op(b, END);
    g(b, found);
    op(b, IF);
    b.u8(0x7f); // handler found: invoke the matched case body
    // Per-invocation frame copy: case invocations of one handler nest (a
    // resumed segment can re-enter the handler), and each invocation needs
    // its own params/spills — the interpreter gives every case invocation a
    // fresh env, so the shared hframe must not be re-bound under an
    // in-flight outer invocation (its fragments re-read scope slots). Copy
    // the hframe; the matched entry's fsize (word @8) sizes the copy, and
    // the resume capture records a fresh HDL over the copy so the fresh
    // chain's Return lands in this invocation's frame.
    const hfc = f.i32(), fsz = f.i32();
    g(b, ent);
    ld(b, 8);
    st(b, fsz);
    i32c(b, 8);
    g(b, fsz);
    i32c(b, 4);
    op(b, MUL);
    op(b, ADD);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, hfc);
    this.loop(f, () => {
      g(b, fsz);
      i32c(b, 2);
      op(b, ADD);
    }, i => {
      g(b, hfc);
      g(b, i);
      i32c(b, 4);
      op(b, MUL);
      op(b, ADD);
      g(b, hdl);
      ld(b, 8);
      g(b, i);
      i32c(b, 4);
      op(b, MUL);
      op(b, ADD);
      ld(b, 0);
      strd(b, 0);
    });
    // Push this perform's RET cell; the slice below is captured as if this
    // cell had been pushed before the walk (scan-first).
    const ret = this.retCell(f, restFn.idx, () => {
      g(b, amb); // next = the pre-walk ambient continuation
    }); // b = the current frame (holds the spilled args cell)
    // Capture the slice above the handler into fresh cells (originals
    // untouched; the resume closure copies again on every call).
    const slice = f.i32();
    g(b, ret);
    g(b, hdl);
    op(b, CALL);
    b.lebU(F_CAPTURE);
    st(b, slice);
    // Box the resume binder (§4.6): a TAG_CLO cell over the shared resume
    // fn and a capture record {arg0 = the slice, arg1 = the matched HDL
    // (the capture sentinel), arg2 = this invocation's hframe copy}. The
    // resume fn copies the slice afresh per call (sentinel = arg1) and
    // re-chains its bottom to a fresh HDL {arg1's table, arg2's frame,
    // next = the k the closure was invoked with}, so the resumed segment
    // runs against the caller's continuation and its Return lands in the
    // invocation's frame copy.
    const rec = f.i32(), rblk = f.i32(), rclo = f.i32();
    i32c(b, 24);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, rec);
    g(b, rec);
    i32c(b, 0);
    strd(b, 0); // parent = none
    g(b, rec);
    i32c(b, 2);
    strd(b, 4); // argc
    g(b, rec);
    g(b, slice);
    strd(b, 12); // arg0: the captured slice
    g(b, rec);
    g(b, hdl);
    strd(b, 16); // arg1: the matched HDL cell (the capture sentinel)
    g(b, rec);
    g(b, hfc);
    strd(b, 20); // arg2: this invocation's hframe copy
    i32c(b, 12);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, rblk);
    g(b, rblk);
    i32c(b, this.resumeFn!.idx);
    strd(b, 0);
    g(b, rblk);
    g(b, rec);
    strd(b, 4);
    g(b, rblk);
    i32c(b, 1);
    strd(b, 8); // fsize (call frame size hint)
    i32c(b, 16);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, rclo);
    g(b, rclo);
    i32c(b, TAG_CLO);
    strd(b, 0);
    g(b, rclo);
    g(b, rblk);
    strd(b, 8);
    // Case invocation over the handler's shared hframe (hdl.b): bind the
    // case params from the args cell, the resume binder to the boxed
    // resume closure, then tail-call the case body
    // with (hframe, hdl.next) — its continuation never contains this
    // handler (two-k rule).
    const hf = f.i32(), argsBlk = f.i32();
    g(b, hfc); // run the case body over the invocation's frame copy
    st(b, hf);
    g(b, cell);
    ld(b, 8); // the args cell's block: element ptrs live at blk+8+4i, not cell+8+4i
    st(b, argsBlk);
    this.loop(f, () => {
      g(b, nparams);
    }, i2 => {
      g(b, hf);
      g(b, i2);
      i32c(b, 4);
      op(b, MUL);
      i32c(b, 8);
      op(b, ADD);
      op(b, ADD);
      g(b, argsBlk);
      g(b, i2);
      i32c(b, 4);
      op(b, MUL);
      i32c(b, 8);
      op(b, ADD);
      op(b, ADD);
      ld(b, 0);
      strd(b, 0);
    });
    g(b, hf);
    g(b, nparams);
    i32c(b, 4);
    op(b, MUL);
    i32c(b, 8);
    op(b, ADD);
    op(b, ADD);
    g(b, rclo);
    strd(b, 0);
    g(b, hf);
    g(b, hdl);
    ld(b, 12);
    g(b, fnIdx);
    op(b, RETURN_CALL_INDIRECT);
    b.lebU(T_KABI);
    b.lebU(0);
    op(b, ELSE);
    // No matching handler: bare host call, then the rest-of-site fragment —
    // the SAME fragment the RET cell carries — continues with the resumed
    // value over this frame and the ambient continuation. The args cell is
    // reloaded from its spill slot, the pattern the fragment itself uses.
    const v = f.i32();
    i32c(b, opid);
    g(b, 0);
    ld(b, 8 + 4 * spillSlot);
    op(b, CALL);
    b.lebU(HOST_IMPORTS.indexOf("ef_perform"));
    st(b, v);
    g(b, 0);
    g(b, v);
    strd(b, 8 + 4 * this.valSpill.get(id)!);
    g(b, 0);
    g(b, v);
    g(b, amb);
    i32c(b, restFn.idx);
    op(b, RETURN_CALL_INDIRECT);
    b.lebU(T_III_I);
    b.lebU(0);
    op(b, END);
    op(b, 0x00); // unreachable: both arms end in a tail call
    // The inline body ends at the split site; the catcher fills restFn.
    throw new Split(restFn, [...this.cutStack]);
  }

  // §4.4 handle. Installs the handler's continuation state and runs the
  // body inline with the K_HDL cell as the ambient continuation k':
  // - hframe: the handler's shared frame (op-param slots, resume binders,
  //   the Return value slot, case-body spills — frameSizeOf(info.scope)).
  // - RET cell for the after-handle rest: {K_RET, restFn, $fp, ambient k} —
  //   the continuation OUTSIDE the handler; the Return case (and the
  //   identity default) delivers the handle's value through it.
  // - K_HDL cell: {K_HDL, case-table offset, hframe, next = the RET cell}.
  // The cell is spilled to the handle's frame slot so a perform inside the
  // body (whose split re-emits this node in fragment mode) reloads the
  // installed handler instead of reinstalling it. The body's completion
  // dispatches through the cell (Return entry — explicit case fn or the
  // shared identity); like a perform site, the handle ends the inline body
  // and the after-handle rest lives in its own fragment.
  emitHandle(id: ExprID, e: Expr & {t: "handle"}, f: Fn, s: Scope, ctx: Ctx): void {
    if (this.ctlDepth > 0) {
      throw new WasmError("wasm target: handle inside if/while is not supported");
    }
    const b = f.body;
    const info = this.hdlCases.get(id)!;
    const restFn = this.makeRestThunk();
    this.hdlRest.set(id, restFn);
    const hf = f.i32(), hdl = f.i32();
    i32c(b, 8 + 4 * this.frameSizeOf(info.scope));
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, hf);
    g(b, hf);
    g(b, 0);
    strd(b, 0); // parent = the frame at the handle site
    // RET cell over the handle-site frame; next = the continuation outside
    // the handler (the two-k rule: the case body's ambient continuation is
    // the one captured OUTSIDE the handler).
    const ret = this.retCell(f, restFn.idx, () => {
      g(b, ctx.kL);
    });
    i32c(b, 16);
    op(b, CALL);
    b.lebU(F_ALLOC);
    st(b, hdl);
    g(b, hdl);
    i32c(b, K_HDL);
    strd(b, 0);
    g(b, hdl);
    i32c(b, info.tableOff);
    strd(b, 4);
    g(b, hdl);
    g(b, hf);
    strd(b, 8);
    g(b, hdl);
    g(b, ret);
    strd(b, 12);
    const sp = this.valSpill.get(id);
    if (sp !== undefined) {
      g(b, 0);
      g(b, hdl);
      strd(b, 8 + 4 * sp);
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
    const restAfterIf = this.makeRestThunk();
    const ifk = this.retCell(f, restAfterIf.idx, () => {
      g(b, ctx.kL); // next = the ambient continuation
    });
    if (ci === undefined) this.pushRef(f, this.cutChildRef(e.c, f, s, ctx, "post"));
    else this.pushRef(f, this.cutChildRef(e.c, f, s, ctx, ci === 0 ? "cut" : "pre"));
    op(b, CALL);
    b.lebU(F_TRUTHY);
    op(b, IF);
    b.u8(0x40); // void: each arm ends in dispatch + return
    this.ctlDepth++;
    const arm = (armE: ExprID, cutArm: boolean): Split | null => {
      const va = f.i32();
      let sp: Split | null = null;
      try {
        if (cutArm) {
          this.pushRef(f, this.cutChildRef(armE, f, s, ctx, "cut"));
        } else {
          // The other arm re-emits without the cut: the cut path belongs to
          // the cut arm's subtree only.
          this.pushRef(f, this.cutChildRef(armE, f, s, ctx, "post"));
        }
        st(b, va);
      } catch (sp2) {
        if (!(sp2 instanceof Split)) throw sp2;
        sp = sp2;
      }
      if (sp !== null) op(b, UNREACHABLE);
      else {
        this.emitDispatch(f, va, ifk);
        op(b, RETURN); // the dispatch's result is this function's result
      }
      return sp;
    };
    const spA = arm(e.a, ci === 1);
    op(b, ELSE);
    const spB = arm(e.b, ci === 2);
    this.ctlDepth--;
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
      const restAfter = this.makeRestThunk();
      const loopEntry = this.makeRestThunk();
      this.ctlLoops.set(id, {entry: loopEntry, rest: restAfter});
      let inner: Split | null = null;
      const savedCtl = this.ctlDepth;
      try {
        // Fresh fragment fn: no wasm structures are open across it.
        this.ctlDepth = 0;
        this.emitLoopPass(loopEntry, e, s, 2, loopEntry.idx);
      } catch (sp) {
        if (!(sp instanceof Split)) throw sp;
        inner = sp;
      }
      this.ctlDepth = savedCtl;
      const ifk = this.retCell(f, restAfter.idx, () => {
        g(b, ctx.kL); // next = the ambient continuation
      });
      const loopk = this.retCell(f, loopEntry.idx, () => {
        g(b, ifk); // next = the after-while cell
      });
      const u = f.i32();
      i32c(b, UNIT_CELL);
      st(b, u);
      this.emitDispatch(f, u, loopk); // enter the loop (tail call)
      // The loop pass's emission ends at a split site inside it (that is
      // what makes the while split-mode): that site's rest fragment is
      // filled by the enclosing body-level catcher along the chain through
      // this while; this loop's own after-rest chains when the cut path
      // re-emits (below). The throw is unreachable in practice.
      if (inner !== null) throw inner;
      throw new Split(restAfter, chainToWhile);
    }
    const loop = this.ctlLoops.get(id);
    if (loop === undefined) throw new WasmError("internal: split chain root mismatch");
    if (cut[0] === e.c) {
      // The condition continues the fragment with the fragment's v, then one
      // loop pass re-runs over the ambient continuation (fresh loop-back
      // cell inside emitLoopPass).
      this.emitLoopPass(f, e, s, ctx.kL, loop.entry.idx, cut.slice(1));
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
    const v = f.i32();
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
  emitLoopPass(f: Fn, e: Expr & {t: "while"}, s: Scope, kNext: number, entryIdx: number, condCut?: ExprID[]): void {
    const b = f.body;
    // A perform/handle inside the CONDITION has no sound split shape (the
    // cond-cut path would re-emit perform machinery inside the pass's
    // BLOCK/LOOP), so it gets the same clean rejection as if-arms. The
    // guard is scoped to the condition only: perform inside the loop BODY
    // is supported (it splits the body via the pass's RET cell).
    this.ctlDepth++;
    // Value-explicit cond: the ref is materialized at its consume point
    // (F_TRUTHY); keepRef persists it into the operand spill slot when the
    // fragment machinery mapped one (same discipline as the app case's args).
    const condRef = condCut === undefined
      ? this.keepRef(e.c, f, this.expr(e.c, f, s, false, {kL: kNext}))
      : condCut.length === 0
        ? this.keepRef(e.c, f, {k: "local", l: 1}) // cond is the split site: v param
        : this.cutChildRef(e.c, f, s, {kL: kNext, cut: condCut}, "cut");
    this.ctlDepth--;
    this.pushRef(f, condRef);
    op(b, CALL);
    b.lebU(F_TRUTHY);
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
    } catch (sp) {
      if (!(sp instanceof Split)) throw sp;
      op(b, UNREACHABLE); // the body never completes inline at this site
      op(b, END);
      const u = f.i32();
      i32c(b, UNIT_CELL);
      st(b, u);
      this.emitDispatch(f, u, kNext); // condition false: exit
      throw sp;
    }
    op(b, END);
    const u = f.i32();
    i32c(b, UNIT_CELL);
    st(b, u);
    this.emitDispatch(f, u, kNext); // condition false: exit
  }

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
      const f = new Fn(2); // (frame, k): builtins are T_KABI trampolines
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
          // JS Array.prototype.flat parity: non-array elements pass through
          // instead of being read as inner arrays (a resumed scalar flowing
          // back through a map-like land path lands exactly here).
          this.loop(f, () => {
            g(b, n);
          }, k => {
            const cell = f.i32();
            this.elemAddr(f, xss, k);
            ld(b, 0); // element cell
            st(b, cell);
            g(b, cell);
            ld(b, 0); // tag
            i32c(b, TAG_ARR);
            op(b, EQ);
            op(b, IF);
            b.u8(0x40);
            g(b, cell);
            ld(b, 8); // inner block
            ld(b, 0); // inner len
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
            const cell = f.i32(), xb = f.i32(), xl = f.i32();
            this.elemAddr(f, xss, k);
            ld(b, 0);
            st(b, cell);
            g(b, cell);
            ld(b, 0);
            i32c(b, TAG_ARR);
            op(b, EQ);
            op(b, IF);
            b.u8(0x40);
            g(b, cell);
            ld(b, 8);
            st(b, xb);
            g(b, xb);
            ld(b, 0);
            st(b, xl);
            this.loop(f, () => {
              g(b, xl);
            }, j => {
              this.elemAddr(f, blk, w);
              this.elemAddr(f, xb, j);
              ld(b, 0);
              strd(b, 0);
              g(b, w);
              i32c(b, 1);
              op(b, ADD);
              st(b, w);
            });
            op(b, ELSE);
            this.elemAddr(f, blk, w);
            g(b, cell);
            strd(b, 0);
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
      // Complete with the ABI's dispatch: builtins are called with k=0, so
      // dispatch(0, v) just returns the computed cell.
      const v = f.i32();
      st(b, v);
      this.emitDispatch(f, v);
      out.push(f);
    }
    return out;
  }

  // map/each/flatmap CPS (§3): a map-like call site is a landCalls split
  // site, so the entry (this builtin Fn) runs with the caller's RET cell as
  // its k and its result dispatches through the caller's continuation. The
  // entry reads the array, allocates the result block into its own frame,
  // and tail-calls the loop-entry thunk; each iteration calls the callback
  // with a RET cell {K_RET, iter-land, entry frame, ambient k} — so a
  // performing callback walks the caller's handler chain, and a completed
  // callback lands in the per-iteration thunk (res[i] = v, i+1, loop-entry).
  // All loop state (result/tmp block, counter) lives in the entry frame
  // slots, so the loop survives suspension.
  emitMapLike(f: Fn, name: string): void {
    const b = f.body;
    const resSlot = name === "each" ? -1 : 2; // map: res, flatmap: tmp
    const iSlot = name === "each" ? 2 : 3;
    const loopEntry = this.makeRestThunk();
    const iterLand = this.makeRestThunk();
    // Per-iteration land: store the callback result (map/flatmap), bump the
    // counter, continue the loop. frame = the entry frame, v = the callback
    // result, k = the ambient continuation (passed to the next iteration).
    {
      const t = iterLand, tb = t.body;
      if (name !== "each") {
        const blk = t.i32(), iL = t.i32();
        this.slot(t, resSlot);
        st(tb, blk);
        this.slot(t, iSlot);
        st(tb, iL);
        this.elemAddr(t, blk, iL);
        g(tb, 1);
        strd(tb, 0);
      }
      g(tb, 0);
      this.slot(t, iSlot);
      i32c(tb, 1);
      op(tb, ADD);
      strd(tb, 8 + 4 * iSlot);
      g(tb, 0);
      i32c(tb, UNIT_CELL);
      g(tb, 2);
      op(tb, RETURN_CALL);
      tb.lebU(loopEntry.idx);
    }
    // Loop entry: done → finalize (box the result / flatmap copy) and
    // dispatch through this thunk's k; else call the callback on element i.
    {
      const t = loopEntry, tb = t.body;
      const xb = t.i32(), n = t.i32(), iL = t.i32(), fc = t.i32();
      this.slot(t, 1); // the xs cell (arg 1) → its block pointer and length
      ld(tb, 8);
      st(tb, xb);
      g(tb, xb);
      ld(tb, 0);
      st(tb, n);
      this.slot(t, iSlot);
      st(tb, iL);
      g(tb, iL);
      g(tb, n);
      op(tb, GEU);
      op(tb, IF);
      tb.u8(0x40);
      const v = t.i32();
      if (name === "map") {
        const res = t.i32();
        this.slot(t, resSlot);
        st(tb, res);
        this.boxArr(t, res);
      } else if (name === "each") {
        i32c(tb, UNIT_CELL);
      } else {
        // flatmap: total = Σ per-element lengths; allocate; copy; box.
        const tmp = t.i32(), total = t.i32();
        this.slot(t, resSlot);
        st(tb, tmp);
        i32c(tb, 0);
        st(tb, total);
        this.loop(t, () => {
          g(tb, n);
        }, i => {
          // total += len of callback result i: elem cell → its block → len
          // (the cell's word @0 is the TAG, not the length).
          this.elemAddr(t, tmp, i);
          ld(tb, 0);
          ld(tb, 8);
          ld(tb, 0);
          g(tb, total);
          op(tb, ADD);
          st(tb, total);
        });
        const res = this.allocArrBlk(t, total);
        const w = t.i32();
        i32c(tb, 0);
        st(tb, w);
        this.loop(t, () => {
          g(tb, n);
        }, i => {
          const xb2 = t.i32(), xl = t.i32();
          this.elemAddr(t, tmp, i);
          ld(tb, 0);
          ld(tb, 8);
          st(tb, xb2);
          g(tb, xb2);
          ld(tb, 0);
          st(tb, xl);
          this.loop(t, () => {
            g(tb, xl);
          }, j => {
            // dst = res + 8 + 4*w (element cell pointers, same layout the
            // box/collect path reads back), src = xb2[j].
            this.elemAddr(t, res, w);
            this.elemAddr(t, xb2, j);
            ld(tb, 0);
            strd(tb, 0);
            g(tb, w);
            i32c(tb, 1);
            op(tb, ADD);
            st(tb, w);
          });
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
      const elem = t.i32();
      this.elemAddr(t, xb, iL);
      ld(tb, 0);
      st(tb, elem);
      this.emitCallClosure(t, fc, name === "map" ? 1 : 2, (k, ffp) => {
        // Suspension-safe as-is: elem/iL are locals set before the call, and
        // F_BOX cannot suspend, so no operand spans a suspension point.
        g(tb, ffp);
        i32c(tb, 8 + 4 * k);
        op(tb, ADD);
        if (k === 0) g(tb, elem);
        else {
          g(tb, iL);
          op(tb, CONV_I32);
          op(tb, CALL);
          tb.lebU(F_BOX);
        }
        strd(tb, 0);
      }, false, true, 2, true, iterLand.idx);
      op(tb, UNREACHABLE); // the callback always tails into iterLand
      op(tb, END);
      op(tb, UNREACHABLE); // both if arms diverge; keep the implicit end typed
    }
    // Entry (this builtin Fn): allocate the result block, init the counter,
    // tail-call the loop entry.
    const xb = f.i32(), n = f.i32();
    this.slot(f, 1);
    ld(b, 8);
    st(b, xb);
    g(b, xb);
    ld(b, 0);
    st(b, n);
    if (resSlot >= 0) {
      const res = this.allocArrBlk(f, n);
      g(b, 0);
      g(b, res);
      strd(b, 8 + 4 * resSlot);
    }
    g(b, 0);
    i32c(b, 0);
    strd(b, 8 + 4 * iSlot);
    g(b, 0);
    i32c(b, UNIT_CELL);
    g(b, 1);
    op(b, RETURN_CALL);
    b.lebU(loopEntry.idx);
  }

  // --- main & assembly -------------------------------------------------------

  emitMain(f: Fn): void {
    const b = f.body;
    // Allocate the global frame into local 0 ($fp convention).
    i32c(b, 8 + 4 * this.frameSizeOf(this.globalScope));
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
    const v = f.i32();
    if (exprs.length === 0) {
      i32c(b, UNIT_CELL);
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
    // The JS caller invokes run() with no args; the frame and k params coerce
    // to 0, so dispatch(0, v) returns the top-level value.
    this.emitDispatch(f, v);
  }

  assemble(): Uint8Array {
    // type section
    const typeSection = new Buf();
    typeSection.lebU(7);
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
    emitType([0x7f, 0x7f]);             // T5 T_KABI: (frame, k) -> i32
    emitType([0x7f, 0x7f, 0x7f]);       // T6 T_III_I: (frame, v, k) -> i32

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

// One-shot host-side effect interpretation (direct style — the wasm boundary
// has no continuations to resume): maps an op name to an implementation that
// receives the performed args and returns the value to resume with. Overrides
// the builtin interpretation; unhandled ops throw the interpreter's error.
export type EffectInterp = Partial<Record<string, (args: Value[]) => Value>>;

// The 7 builtin effects' default interpretation (mirrors builtins.ts, direct
// style — interp entries in wasm land return a value, never an Outcome).
const builtinEffectHosts: Record<string, (args: Value[]) => Value> = {
  Read: (args) => readFileSync(args[0] as string, "utf8"),
  Write: (args) => {
    writeFileSync(args[0] as string, args[1] as string);
    return null;
  },
  Println: (args) => {
    console.log(show(args[0] ?? null));
    return null;
  },
  Out: (args) => {
    process.stdout.write(args[0] as string);
    return null;
  },
  // Exit terminates the process by default (never resumes).
  Exit: (args) => process.exit(args[0] as number),
  Wait: (args) => {
    sleepSync((args[0] as number) * 1000);
    return null;
  },
  Random: () => Math.random(),
};

// compile+instantiate+run: the wasm-target twin of eval.ts's run().
export function runWasm(src: string, interp?: EffectInterp): Value {
  const {bytes, ops} = compileWithOps(src);
  const mod = new WebAssembly.Module(bytes);
  // Assigned after the imports are built (they close over the instance).
  // eslint-disable-next-line prefer-const
  let inst!: WebAssembly.Instance;
  const imports = {
    ef_perform: (opid: number, argsCell: number) => {
      const op = (ops as (string | undefined)[])[opid];
      if (op === undefined) throw new Error(`wasm host: unknown effect opid ${opid}`);
      const args = hostUnbox(inst, argsCell) as Value[];
      const custom = interp?.[op];
      if (custom !== undefined) return hostBox(inst, custom(args));
      const bi = (builtinEffectHosts as
        Record<string, ((args: Value[]) => Value) | undefined>)[op];
      if (bi === undefined) throw new Error("Unhandled effect: " + op);
      return hostBox(inst, bi(args));
    },
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
