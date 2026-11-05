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
//   per-handle case tables) are immutable anyref globals, each initialized
//   by a GC constant expression at instantiation; run() builds the global
//   frame, then calls main.
// - JS cannot read GC struct fields directly, so the host boundary is 12
//   exported accessor functions (__tag, __num, __str_len, __str_get,
//   __arr_len, __arr_get, __mk_num, __mk_bool, __str_new, __str_set,
//   __arr_new, __arr_set); wasm_host.ts rebuilds interpreter Values
//   through them. Host imports (7): ef_perform, ef_char, ef_number,
//   ef_args, ef_cos, ef_sin, ef_fail — tree-shaken to the live set
//   (ef_fail always live); effects reaching the host flow back through
//   ef_perform and are interpreted there (wasm_host.ts, via builtins.ts's
//   builtinEffectHosts).
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
import binaryen from "binaryen";
import {Parser, type Expr, type ExprID, type Program} from "./parser.ts";
import {checkProgram} from "./types.ts";
import {BUILTINS, EFFECT_OPS, builtinRefs, builtinValueUses, collectEffectOps, performsAnyOp} from "./analysis.ts";
import {Ctx, INLINE, Scope, WasmError, _T} from "./wasm_types.ts";
import * as w from "./wasm_consts.ts";
// The binary format layer is gone: Buf interprets the emitters' stack-machine
// instruction stream directly into binaryen AST (see Buf below).

// map/each/flatmap invoke user callbacks, so they are called land-style: a
// map-like call site is a landCalls split site (§3) and the builtin loops
// through per-iteration thunks instead of an inline wasm loop.
const MAP_LIKE = new Set(["map", "each", "flatmap"]);
// Extra entry-frame words a map-like builtin needs beyond its args: the
// result/tmp array (except each) and the iteration counter.
const mapLikeFrameWords = (name: string): number => name === "each" ? 1 : MAP_LIKE.has(name) ? 2 : 0;

// Operators compile inline at call sites (like the checker-stamped `/`):
// operands unbox to f64 (or dispatch to $eq/$truthy) right in the caller,
// no call, no frame. A trampoline exists only for operators referenced as
// values (e.g. passed to foldl) — see treeShakeBuiltins.
const OPERATOR_OPS = new Set(["+", "-", "*", "%", "neg", "<", ">", "<=", ">=", "==", "!=", "not"]);

// Import names that serve exactly one builtin each (import → builtin).
const BUILTIN_IMPORTS: Record<string, string> = {
  ef_char: "char", ef_number: "number", ef_args: "args",
  ef_cos: "cos", ef_sin: "sin",
};

const HOST_IMPORTS = [
  "ef_perform", "ef_fail",
  ...Object.keys(BUILTIN_IMPORTS),
];

// debug emitter tracing: run with DBGEMIT=1 to log split/thunk internals
// during compile; off (and free) otherwise.
const DBGEMIT = process.env["DBGEMIT"] === "1";


// --- binaryen-backed body emitter -------------------------------------------

// Func signatures by type index (§1 func types 7..23). Valtype spellings
// mirror the emitter's byte language: 0x7f i32, 0x7c f64, 0x6e anyref,
// [0x63, n] = (ref null $n). Consumed by Buf's call handling and by
// buildModule's addFunction calls.
const SIGS: Record<number, {p: (number | number[])[], r: number | number[] | null}> = {
  [w.T_RUN]: {p: [], r: w.ANYREF},                    // run, ef_args
  [w.T_PERFORM]: {p: [0x7f, w.ANYREF], r: w.ANYREF},    // ef_perform
  [w.T_FAIL]: {p: [0x7f, w.ANYREF, 0x7c, 0x7c], r: null}, // ef_fail
  [w.T_STRNUM]: {p: [w.ANYREF], r: w.ANYREF},           // ef_char/number/cos/sin
  [12]: {p: [0x7f], r: w.ANYREF},                   // __mk_bool/__str_new/__arr_new
  [w.T_BOX]: {p: [0x7c], r: w.ANYREF},                // fBox, __mk_num
  [w.T_TRUTHY]: {p: [w.ANYREF], r: 0x7f},             // fTruthy, __tag/__str_len/__arr_len
  [w.T_EQ]: {p: [w.ANYREF, w.ANYREF], r: w.ANYREF},       // fEq
  [w.T_CAPTURE]: {p: [[0x63, 5], [0x63, 5]], r: [0x63, 5]}, // fCapture
  [w.T_KABI]: {p: [[0x63, 4], [0x63, 5]], r: w.ANYREF},       // (frame, k) program fns
  [w.T_III_I]: {p: [[0x63, 4], w.ANYREF, [0x63, 5]], r: w.ANYREF}, // land thunks
  [19]: {p: [w.ANYREF], r: 0x7c},                   // __num
  [20]: {p: [w.ANYREF, 0x7f], r: 0x7f},             // __str_get
  [21]: {p: [w.ANYREF, 0x7f, 0x7f], r: null},       // __str_set
  [22]: {p: [w.ANYREF, 0x7f], r: w.ANYREF},           // __arr_get
  [23]: {p: [w.ANYREF, 0x7f, w.ANYREF], r: null},     // __arr_set
};

// Valtype byte (or [0x63, idx] pair) → binaryen Type. 0x40 → none (void).
function vt(t: number | number[] | null): binaryen.Type {
  if (t === null || t === 0x40) return binaryen.none;
  if (typeof t === "number") {
    if (t === 0x7f) return binaryen.i32;
    if (t === 0x7c) return binaryen.f64;
    if (t === w.ANYREF) return binaryen.anyref;
    if (t === w.EQREF) return binaryen.eqref;
    if (t === w.I31REF) return binaryen.i31ref;
  } else return _T.RF[t[1]];
  throw new WasmError(`internal: bad valtype ${JSON.stringify(t)}`);
}

// One compile at a time runs in-process, so the module under construction
// lives in a module-level binding (Buf emitters construct binaryen
// expressions through it without threading it through every call). The
// owning Emit context travels on each Fn instead (Fn.em).
let MOD: binaryen.Module;

// Control scope under construction: the implicit first scope is the function
// body; block/loop/if open on top. `label` names the scope for br depth
// resolution (wasm label depth counts blocks, loops and ifs alike).
type ScopeRec = {
  kind: "fn" | "block" | "loop" | "if",
  label: string,
  result: number,  // blocktype byte: 0x40 void | 0x7f i32 | 0x6e anyref | 0x63
  extra: number,   // typeidx for 0x63 (ref null $t)
  stmts: binaryen.ExpressionRef[],
  cond?: binaryen.ExpressionRef,  // if: the popped condition
  arm?: binaryen.ExpressionRef,   // if: then-branch (built at ELSE)
  mark?: number,                  // if: ops depth at arm start
  spill?: number[],               // block/loop: leaked operand spill locals
  dead: boolean,                  // unreachable / after br — drops everything
};

// Struct field valtypes by type index (struct.new pops fields in reverse
// declaration order — the last field pushed is the first popped).
const STRUCT_FIELDS: Record<number, (number | number[])[]> = {
  [0]: [0x7c],                       // $NUM: f64
  [3]: [[0x63, 1]],                  // $ARR: (ref null $ELEMS)
  [4]: [[0x63, 4], [0x63, 1]],       // $FRAME
  [5]: [w.I31REF, w.ANYREF, w.ANYREF, [0x63, 5]], // $K
  [6]: [w.I31REF, [0x63, 4], w.I31REF],  // $CLO
};

class Buf {
  private scopes: ScopeRec[] = [{kind: "fn", label: "", result: 0x40, extra: 0, stmts: [], dead: false}];
  // Operand stack — mirrors the wasm operand stack the emitters juggle.
  ops: binaryen.ExpressionRef[] = [];
  // Spill reloads waiting to be consumed (LIFO — byte-stack order: the
  // reloads are the deepest entries, so pops reach them only after ops
  // drains). Reloads live OUTSIDE ops so a result-scope's trailing-value
  // capture never mistakes one for its own result.
  private pending: number[] = [];
  private labelN = 0;
  // Pending stream instruction awaiting raw immediates (b.u8(w.CALL) +
  // b.lebU(idx) and friends): opcode, GC sub-opcode, remaining immediates.
  private pend: {op: number, gc: number, need: ("bt" | "lebU")[], got: number[]} | null = null;

  constructor(public fn: Fn) {}

  private top(): ScopeRec { return this.scopes[this.scopes.length - 1]; }
  private dead(): boolean { return this.top().dead; }
  private stmt(e: binaryen.ExpressionRef): void {
    if (this.dead()) return;
    if (DBGEMIT && this.ops.length > 0)
      console.error(`stmt f${this.fn.fid}(idx${this.fn.idx}) id=${binaryen.getExpressionId(e)} leaving ${this.ops.length} ops: [${this.ops.map((o) => String(binaryen.getExpressionType(o))).join(",")}]`);
    this.top().stmts.push(e);
  }
  push(e: binaryen.ExpressionRef): void {
    if (DBGEMIT)
      console.error(`push f${this.fn.fid}(idx${this.fn.idx}) d=${this.ops.length + 1} t=${binaryen.getExpressionType(e)} dead=${this.dead()}`);
    if (this.dead()) return;
    this.ops.push(e);
  }
  pop(): binaryen.ExpressionRef {
    if (this.dead()) return MOD.unreachable(); // dead code: value never used
    if (this.ops.length === 0) {
      if (this.pending.length === 0) throw new WasmError("internal: operand stack underflow");
      const t = this.pending.pop()!;
      if (DBGEMIT)
        console.error(`pop  f${this.fn.fid}(idx${this.fn.idx}) d=-1 reload=${t}`);
      return MOD.local.get(t, this.localType(t));
    }
    if (DBGEMIT)
      console.error(`pop  f${this.fn.fid}(idx${this.fn.idx}) d=${this.ops.length - 1} t=${binaryen.getExpressionType(this.ops[this.ops.length - 1])}`);
    return this.ops.pop()!;
  }
  // Mark the current scope dead (unreachable / return / br to a block).
  // Values pushed inside it are phantom — stack-polymorphic code cannot
  // consume them meaningfully — but they are NOT effect-free: a pushed
  // if/call still runs its arms in the byte world. Convert each phantom to
  // a drop() statement (evaluates once, discards the value), then truncate.
  private markDead(): void {
    const sc = this.top();
    if (DBGEMIT && !sc.dead)
      console.error(`markDead f${this.fn.fid} ${sc.kind}:${sc.label} at\n` + (new Error().stack ?? "").split("\n").slice(1, 4).join("\n"));
    sc.dead = true;
    const keep = sc.mark ?? 0;
    // Bypass stmt(): it drops statements in a dead scope, and these drops
    // ARE the dead scope's surviving effect trail.
    while (this.ops.length > keep) {
      const d = this.ops.pop()!;
      if (DBGEMIT)
        console.error(`markDead f${this.fn.fid} ${sc.kind}:${sc.label} drop id=${binaryen.getExpressionId(d)} t=${binaryen.getExpressionType(d)}`);
      sc.stmts.push(MOD.drop(d));
    }
    // pending reloads survive: they are the pre-block leaked operands whose
    // consumers are later (still-live) code — the byte world's stack keeps
    // them across a dead block.
  }

  private label(): string { return `L${this.labelN++}`; }

  // Local valtype: params from the fn signature, then declared locals.
  private localType(i: number): binaryen.Type {
    if (i < this.fn.params) {
      const sig = SIGS[this.fn.typeIdx];
      return vt(sig.p[i]);
    }
    const l = this.fn.locals[i - this.fn.params] as binaryen.Type | undefined;
    if (typeof l === "undefined") throw new WasmError(`internal: no local ${i} (fn ${this.fn.idx})`);
    return l;
  }

  // The target of a br depth: d = 0 is the innermost scope. Result blocks
  // (the dispatch walk's block (result anyref)) receive the br's value.
  // This emitter never branches to an if label — assert that.
  private brTarget(d: number): ScopeRec {
    if (d >= this.scopes.length) throw new WasmError(`internal: br depth ${d} out of range`);
    const t = this.scopes[this.scopes.length - 1 - d];
    if (t.kind === "if") throw new WasmError("internal: br to an if label");
    return t;
  }

  // Build a scope's block expression: stmts plus a trailing value (if any)
  // wrapped so the blocktype's result is honored. Non-void blocks always
  // carry their explicit result type (a dead one is reached only via
  // br-with-value, which supplies it); dead void branches get no type —
  // their type is bottom, which satisfies anything. Block-scope closes pass
  // the scope's label (br depth resolution); if-arms are unlabeled.
  private branch(sc: ScopeRec, label: string | null = null): binaryen.ExpressionRef {
    // Trailing value: the top of ops only. Pending reloads are pre-scope
    // leaks — the original byte emitter never captured them as a scope's
    // yield (they sat below the mark), and their types may not match the
    // scope's result type.
    const hasVal = sc.result !== 0x40 && this.ops.length > (sc.mark ?? 0);
    const val = hasVal ? this.ops.pop() : undefined;
    // A void scope's own pushes (above mark) stay inside it — the byte
    // world's scope slice contained them (e.g. a tail call ending a void
    // if-arm). Left in ops they would leak into the parent and garble the
    // stream. Drop the values (side effects run; the byte world's leftovers
    // were always bottom-typed/unreachable-after).
    while (this.ops.length > (sc.mark ?? 0)) {
      const e = this.ops.pop()!;
      sc.stmts.push(MOD.drop(e));
    }
    const rt = sc.result !== 0x40 ? vt(sc.result === 0x63 ? [0x63, sc.extra] : sc.result)
      : sc.dead ? undefined : binaryen.none;
    const body = val !== undefined ? [...sc.stmts, val] : sc.stmts;
    if (body.length === 0 && rt === binaryen.none) return MOD.nop();
    return MOD.block(label, body, rt);
  }

  // --- raw byte-stream interface (unchanged call sites feed these) --------

  u8(n: number): this {
    if (this.pend === null) {
      this.pend = {op: n, gc: -1, need: this.needs(n, -1), got: []};
      if (this.pend.need.length === 0) this.complete(); // immediate-less op
      return this;
    }
    if (this.pend.gc === -1 && this.pend.op === w.GC) {
      this.pend.gc = n;
      this.pend.need = this.needs(n, n);
      if (this.pend.need.length === 0) this.complete();
      return this;
    }
    const need = this.pend.need[0];
    if (need !== "bt") throw new WasmError(`internal: unexpected u8 for ${this.pend.op}`);
    this.pend.got.push(n);
    this.pend.need.shift();
    if (n === 0x63) { this.pend.need.unshift("bt"); return this; } // ref-typeidx follows
    this.complete();
    return this;
  }

  lebU(n: number): this {
    if (this.pend === null || this.pend.need[0] !== "lebU")
      throw new WasmError(`internal: unexpected lebU (op ${this.pend?.op ?? "none"})`);
    this.pend.got.push(n);
    this.pend.need.shift();
    if (this.pend.need.length === 0)
      this.complete();
    return this;
  }

  // Immediates a stream opcode needs (before its completion handler runs).
  private needs(op: number, gc: number): ("bt" | "lebU")[] {
    if (gc >= 0)
      return []; // GC ops never reach the stream (emit methods bypass it)
    switch (op) {
      case w.BLOCK: case w.LOOP: case w.IF: return ["bt"];
      case w.CALL: case w.RETURN_CALL: case w.BR: case w.BR_IF: return ["lebU"];
      case w.CALL_INDIRECT: case w.RETURN_CALL_INDIRECT: return ["lebU", "lebU"];
      default: return [];
    }
  }

  // A stream instruction's immediates are complete — build it.
  private complete(): void {
    const {op, gc, got} = this.pend!;
    this.pend = null;
    if (gc >= 0) throw new WasmError("internal: GC op reached the stream");
    if (DBGEMIT)
      console.error(`insn f${this.fn.fid} ${op.toString(16)} [${got.join(",")}]`);
    switch (op) {
      case w.BLOCK: this.openScope("block", got); return;
      case w.LOOP: this.openScope("loop", got); return;
      case w.IF: {
        const cond = this.pop();
        this.openScope("if", got);
        this.top().cond = cond;
        if (DBGEMIT)
          console.error(`IF f${this.fn.fid} stack=[${this.scopes.map((s) => s.kind.slice(0, 2) + ":" + s.label).join(",")}]`);
        return;
      }
      case w.ELSE: {
        const sc = this.top();
        if (DBGEMIT)
          console.error(`ELSE f${this.fn.fid} top=${sc.kind}:${sc.label} arm=${sc.arm !== undefined}`);
        if (sc.kind !== "if" || sc.arm !== undefined) throw new WasmError("internal: misplaced ELSE");
        sc.arm = this.branch(sc);
        sc.stmts = [];
        sc.mark = this.ops.length;
        sc.dead = false;
        return;
      }
      case w.END: {
        const sc = this.scopes.pop()!;
        if (DBGEMIT)
          console.error(`END f${this.fn.fid} pop=${sc.kind}:${sc.label} res=${sc.result} stmts=${sc.stmts.length} dead=${sc.dead} ids=[${sc.stmts.map((s) => String(binaryen.getExpressionId(s))).join(",")}] stack=[${this.scopes.map((s) => s.kind.slice(0, 2) + ":" + s.label).join(",")}]`);
        if (sc.kind === "if") {
          if (sc.arm === undefined) {
            // if without ELSE: the scope state is the then-branch.
            const thenArm = this.branch(sc);
            this.finishScope(sc, MOD.if(sc.cond!, thenArm));
          } else {
            this.finishScope(sc, MOD.if(sc.cond!, sc.arm, this.branch(sc)));
          }
          return;
        }
        if (sc.kind === "loop") {
          if (sc.stmts.length === 0) throw new WasmError("internal: empty loop");
          this.finishScope(sc,
            MOD.loop(sc.label, sc.stmts.length === 1 ? sc.stmts[0] : MOD.block(null, sc.stmts)));
          return;
        }
        this.finishScope(sc, this.branch(sc, sc.label));
        return;
      }
      case w.BR: {
        const t = this.brTarget(got[0]);
        const val = t.result === 0x40 ? undefined : this.pop();
        // markDead BEFORE pushing the br: leaked-operand drops belong before
        // the terminator (they execute in the byte world; after the br they
        // would be dead code). Deadness is innermost-only: the rest of the
        // CURRENT scope is dead; enclosing scopes stay live — their code
        // runs whenever the br is not taken.
        this.markDead();
        this.top().stmts.push(val === undefined ? MOD.br(t.label) : MOD.br(t.label, undefined, val));
        return;
      }
      case w.BR_IF: {
        const cond = this.pop(); // cond sits on top of any br value
        const t = this.brTarget(got[0]);
        const val = t.result === 0x40 ? undefined : this.pop();
        this.stmt(val === undefined ? MOD.br_if(t.label, cond) : MOD.br_if(t.label, cond, val));
        return;
      }
      case w.CALL: case w.RETURN_CALL: {
        const sig = sigOf(this.fn.em!, got[0]);
        const args = sig.ps.map(() => this.pop()).reverse();
        const call = op === w.RETURN_CALL
          ? MOD.return_call(`f${got[0]}`, args, sig.r ?? binaryen.none)
          : MOD.call(`f${got[0]}`, args, sig.r ?? binaryen.none);
        this.callResult(op, call, sig);
        return;
      }
      case w.CALL_INDIRECT: case w.RETURN_CALL_INDIRECT: {
        const [typeIdx, tableIdx] = got;
        if (tableIdx !== 0) throw new WasmError("internal: call_indirect table != 0");
        const sig = this.tSig(typeIdx);
        const idxExpr = this.pop();
        const args = sig.ps.map(() => this.pop()).reverse();
        const call = op === w.CALL_INDIRECT
          ? MOD.call_indirect("t0", idxExpr, args, binaryen.createType(sig.ps), sig.r ?? binaryen.none)
          : MOD.return_call_indirect("t0", idxExpr, args, binaryen.createType(sig.ps), sig.r ?? binaryen.none);
        this.callResult(op, call, sig);
        return;
      }
      case w.RETURN: {
        const sig = SIGS[this.fn.typeIdx];
        const rv = sig.r === null ? undefined : this.pop(); // pop while alive
        // markDead FIRST so leaked-operand drops land BEFORE the return —
        // the byte world's stack keeps them as live expressions before the
        // terminator; after it they would be unreachable dead code.
        this.markDead();
        this.top().stmts.push(rv === undefined ? MOD.return() : MOD.return(rv));
        return;
      }
      case w.UNREACHABLE:
        this.markDead();
        this.top().stmts.push(MOD.unreachable());
        return;
      case w.SELECT: {
        const cond = this.pop(), v2 = this.pop(), v1 = this.pop();
        this.push(MOD.select(cond, v1, v2));
        return;
      }
      case 0xd1: this.push(MOD.ref.is_null(this.pop())); return;
      default: this.numeric(op);
    }
  }

  // call vs return_call: both pop args; direct calls push a result unless
  // the target is void; return-calls (direct and indirect) are statements —
  // they never return.
  private callResult(op: number, call: binaryen.ExpressionRef, sig: {r: binaryen.Type | null}): void {
    if (op === w.RETURN_CALL || op === w.RETURN_CALL_INDIRECT) {
      // The byte world pushed the callee's result bytes even for tail calls
      // (stack-polymorphic unreachable): code after the tail call stays
      // stack-typed (e.g. a following local.set consumes it). Bottom-typed
      // push keeps everything after dead while consuming pops correctly.
      this.push(call); // bottom-typed after a tail call
      return;
    }
    if (sig.r === null) this.stmt(call);
    else this.push(call);
  }

  private openScope(kind: "block" | "loop" | "if", got: number[]): void {
    const sc: ScopeRec = {
      kind, label: this.label(), result: got[0], extra: got[1] ?? 0,
      stmts: [], mark: this.ops.length, dead: this.dead(),
    };
    if (DBGEMIT)
      console.error(`open f${this.fn.fid} ${kind} ${sc.label} res=${got[0]} ops=${this.ops.length} bornDead=${sc.dead}`);
    // The emitters park operand-stack values ACROSS block/loop boundaries
    // (e.g. the handler-found index in emitPerform). binaryen AST cannot
    // flow a value through a void block, so spills mirror what the binary
    // reader does: set each leaked value to a fresh local inside the scope,
    // reload after it closes (see END). If-arms never consume leaks, so ifs
    // need no spilling.
    if ((kind === "block" || kind === "loop") && !sc.dead && this.ops.length > 0) {
      sc.spill = this.ops.splice(0).map((v) => {
        const tmp = this.tempLocal(binaryen.getExpressionType(v));
        sc.stmts.push(MOD.local.set(tmp, v));
        return tmp;
      });
      sc.mark = 0;
    }
    this.scopes.push(sc);
  }

  // Fresh local of a binaryen type (spill slots keep the exact type so
  // consumers keep validating).
  private tempLocal(t: binaryen.Type): number {
    return this.fn.typed(t);
  }

  // A closed scope is a statement (void) or a value (its blocktype has a
  // result). The scope's own expression appends UNCONDITIONALLY: a dead
  // scope still closes (its structure is the live path — e.g. a loop whose
  // body contains a br exiting an outer block). Spilled leaks reload via
  // push(), which drops them in a dead parent.
  private finishScope(sc: ScopeRec, e: binaryen.ExpressionRef): void {
    if (sc.result === 0x40) this.top().stmts.push(e);
    else this.ops.push(e);
    if (sc.spill !== undefined) {
      // Reloads wait in pending (byte order); pop() drains them once ops
      // is empty — exactly matching how the byte world's stack behaved.
      this.pending.push(...sc.spill);
    }
  }

  // Typed immediate from the stream's (typeidx, tableidx) pair.
  private tSig(typeIdx: number): {ps: binaryen.Type[], r: binaryen.Type | null} {
    const sig = SIGS[typeIdx] as {p: (number | number[])[], r: number | number[] | null} | undefined;
    if (sig === undefined) throw new WasmError(`internal: no sig for type ${typeIdx}`);
    return {ps: sig.p.map((t) => vt(t)), r: sig.r === null ? null : vt(sig.r)};
  }

  // MVP numeric ops + f64 ops + conversions (all immediate-less).
  private numeric(op: number): void {
    const bin = (f: (l: binaryen.ExpressionRef, r: binaryen.ExpressionRef) => binaryen.ExpressionRef) => {
      const r = this.pop(), l = this.pop();
      this.push(f(l, r));
    };
    const un = (f: (v: binaryen.ExpressionRef) => binaryen.ExpressionRef) => {
      const x = this.pop();
      this.push(f(x));
    };
    switch (op) {
      case w.EQZ: un((v) => MOD.i32.eqz(v)); return;
      case w.EQ: bin((l, r) => MOD.i32.eq(l, r)); return;
      case w.LTS: bin((l, r) => MOD.i32.lt_s(l, r)); return;
      case w.LTU: bin((l, r) => MOD.i32.lt_u(l, r)); return;
      case w.GTU: bin((l, r) => MOD.i32.gt_u(l, r)); return;
      case w.LEU: bin((l, r) => MOD.i32.le_u(l, r)); return;
      case w.GEU: bin((l, r) => MOD.i32.ge_u(l, r)); return;
      case w.ADD: bin((l, r) => MOD.i32.add(l, r)); return;
      case w.SUB: bin((l, r) => MOD.i32.sub(l, r)); return;
      case w.MUL: bin((l, r) => MOD.i32.mul(l, r)); return;
      case w.DIVU: bin((l, r) => MOD.i32.div_u(l, r)); return;
      case w.AND: bin((l, r) => MOD.i32.and(l, r)); return;
      case w.OR: bin((l, r) => MOD.i32.or(l, r)); return;
      case w.FADD: bin((l, r) => MOD.f64.add(l, r)); return;
      case w.FSUB: bin((l, r) => MOD.f64.sub(l, r)); return;
      case w.FMUL: bin((l, r) => MOD.f64.mul(l, r)); return;
      case w.FDIV: bin((l, r) => MOD.f64.div(l, r)); return;
      case w.FEQ: bin((l, r) => MOD.f64.eq(l, r)); return;
      case w.FLT: bin((l, r) => MOD.f64.lt(l, r)); return;
      case w.FGT: bin((l, r) => MOD.f64.gt(l, r)); return;
      case w.FLE: bin((l, r) => MOD.f64.le(l, r)); return;
      case w.FGE: bin((l, r) => MOD.f64.ge(l, r)); return;
      case w.FABS: un((v) => MOD.f64.abs(v)); return;
      case w.FNEG: un((v) => MOD.f64.neg(v)); return;
      case w.FCEIL: un((v) => MOD.f64.ceil(v)); return;
      case w.FFLOOR: un((v) => MOD.f64.floor(v)); return;
      case w.FTRUNC: un((v) => MOD.f64.trunc(v)); return;
      case w.FSQRT: un((v) => MOD.f64.sqrt(v)); return;
      case w.TRUNC_F64: un((v) => MOD.i32.trunc_s.f64(v)); return;
      case w.CONV_I32: un((v) => MOD.f64.convert_s.i32(v)); return;
      default: throw new WasmError(`internal: unknown opcode 0x${op.toString(16)}`);
    }
  }

  // --- instruction emit methods ---------------------------------------------

  i32Const(n: number): void { this.push(MOD.i32.const(n)); }
  f64Const(x: number): void { this.push(MOD.f64.const(x)); }
  localGet(i: number): void { this.push(MOD.local.get(i, this.localType(i))); }
  localSet(i: number): void { this.stmt(MOD.local.set(i, this.pop())); }
  globalGet(gi: number): void { this.push(MOD.global.get(`g${gi}`, binaryen.anyref)); }
  structNew(t: number): void {
    const sig = STRUCT_FIELDS[t];
    if (typeof sig === "undefined")
      throw new WasmError(`internal: no struct fields for type ${t}`);
    const fields = sig.map(() => this.pop()).reverse();
    this.push(MOD.struct.new(fields, _T.HT[t]));
  }
  structGet(t: number, fi: number): void {
    this.push(MOD.struct.get(fi, this.pop(), _T.HT[t], false));
  }
  structSet(fi: number): void {
    const v = this.pop(), ref = this.pop();
    this.stmt(MOD.struct.set(fi, ref, v));
  }
  arrayNew(t: number): void {
    this.push(MOD.array.new_default(_T.HT[t], this.pop()));
  }
  arrayGet(t: number): void {
    // aget (non-packed $ELEMS) and agetu (unsigned i16 $STR) both pass
    // signed=false: get_u spelling for packed arrays, no extension otherwise.
    const idx = this.pop(), ref = this.pop();
    this.push(MOD.array.get(ref, idx, _T.HT[t], false));
  }

  arraySet(): void { // pops (arrayref, index, value)
    const v = this.pop(), idx = this.pop(), ref = this.pop();
    this.stmt(MOD.array.set(ref, idx, v));
  }
  arrayLen(): void { this.push(MOD.array.len(this.pop())); }
  arrayCopy(d: number, s: number): void { // pops (dst, dstOff, src, srcOff, len)
    const len = this.pop(), srcOff = this.pop(), src = this.pop(), dstOff = this.pop(), dst = this.pop();
    this.stmt(MOD.array.copy(dst, dstOff, src, srcOff, len));
    if (d !== s)
      throw new WasmError("internal: array.copy with distinct types");
  }
  // nullable=true casts to (ref null ht); false to the non-null (ref ht).
  refTest(ht: number, nullable: boolean): void {
    this.push(MOD.ref.test(this.pop(), this.castType(ht, nullable)));
  }
  refCast(ht: number, nullable: boolean): void {
    this.push(MOD.ref.cast(this.pop(), this.castType(ht, nullable)));
  }
  // Cast target: nullable = the full (ref null ht) type; non-nullable = the
  // bare heap type for concrete types (binaryen takes it directly) or the
  // non-null form for abstract ones (i31/any/eq — their heap-type constants
  // are not type ids).
  private castType(ht: number, nullable: boolean): binaryen.Type {
    if (nullable)
      return w.heapTypes(ht).n;
    if (ht >= 0 && ht <= 6)
      return _T.HT[ht];
    return binaryen.getTypeFromHeapType(w.heapTypes(ht).h, false);
  }
  refNull(ht: number): void { this.push(MOD.ref.null(w.heapTypes(ht).n)); }
  refI31(): void { this.push(MOD.ref.i31(this.pop())); }
  i31Get(): void { this.push(MOD.i31.get_s(this.pop())); }
  refEq(): void { const r = this.pop(), l = this.pop(); this.push(MOD.ref.eq(l, r)); }
  typedSelect(): void {
    const cond = this.pop(), v2 = this.pop(), v1 = this.pop();
    this.push(MOD.if(cond, v1, v2)); // ref select: binaryen's select() is numeric-only
  }

  // Finish the function body: close any open scopes (none expected) and wrap
  // the statement list, with a trailing operand as the function result.
  finish(): binaryen.ExpressionRef {
    if (this.scopes.length !== 1 || this.pend !== null)
      throw new WasmError("internal: unbalanced function body");
    const sc = this.top();
    // A diverging fn's trailing value may be a pre-scope leak sitting in
    // pending (the byte world's stale stack entry — its finish popped it
    // as the fn result).
    if (this.ops.length === 0 && this.pending.length > 0 && SIGS[this.fn.typeIdx].r !== null) {
      const t = this.pending.pop()!;
      if (DBGEMIT)
        console.error(`finishBody f${this.fn.fid} idx=${this.fn.idx} PENDING t=${t} stmts=[${sc.stmts.map((e) => binaryen.getExpressionId(e)).join(",")}]`);
      return MOD.block(null, [...sc.stmts, MOD.local.get(t, this.localType(t))], vt(SIGS[this.fn.typeIdx].r));
    }
    // Leftover pending reloads are the byte world's stale stack entries
    // below the fn's trailing value: pure local.gets the byte emitter left
    // on its stack across a tail call/unreachable fn end. Drop them.
    if (this.ops.length > 1 || (this.pending.length > 0 && this.ops.length !== 1)) {
      if (DBGEMIT)
        console.error("finish f" + String(this.fn.fid), "idx", this.fn.idx, "typeIdx", this.fn.typeIdx,
          "ops:", this.ops.map(o => binaryen.getExpressionType(o)), "pending:", this.pending);
      throw new WasmError(`internal: leftover operands at fn end (fn ${this.fn.idx}, ${this.ops.length} ops, ${this.pending.length} pending)`);
    }
    while (this.pending.length > 0) {
      const t = this.pending.pop()!;
      sc.stmts.push(MOD.drop(MOD.local.get(t, this.localType(t))));
    }
    const val = this.ops.pop();
    const sig = SIGS[this.fn.typeIdx];
    if (val !== undefined && sig.r === null)
      throw new WasmError("internal: value in void function");
    if (val === undefined && sig.r !== null && !sc.dead)
      throw new WasmError(`internal: missing result in fn ${this.fn.idx}`);
    const body = val !== undefined ? [...sc.stmts, val] : sc.stmts;
    if (body.length === 0) {
      if (sig.r !== null)
        throw new WasmError("internal: empty non-void function body");
      return MOD.nop();
    }
    // A dead body (ends in unreachable/return) gets no explicit result type:
    // its type is bottom, which satisfies any declared result.
    const rt = sc.dead && val === undefined ? undefined
      : sig.r === null ? binaryen.none : vt(sig.r);
    if (DBGEMIT)
      console.error(`finishBody f${this.fn.fid} idx=${this.fn.idx} stmts=[${body.map(binaryen.getExpressionId).join(",")}] rt=${rt}`);
    return MOD.block(null, body, rt);
  }
}


// --- per-function emitter ---------------------------------------------------

class Fn {
  static nextId = 0;
  readonly fid = Fn.nextId++; // trace discriminator (idx repeats across fns)
  body: Buf;
  locals: binaryen.Type[] = []; // extra locals in allocation order
  typeIdx = w.T_KABI; // program functions share (frame, k) -> i32; helpers may differ
  // Funcref table index (assigned at creation, stable across emission).
  idx = 0;
  // The owning emission context: Buf handlers reach per-compile state
  // (import tables, funcref sigs) through it instead of module globals. Fn
  // is created context-free during the pre-emission phases (discover /
  // assignIndices); the context is attached when its body is emitted.
  constructor(public params: number, public em?: Emit) {
    this.body = new Buf(this);
  }
  i32(): number { return this.typed(binaryen.i32); }
  f64(): number { return this.typed(binaryen.f64); }
  anyref(): number { return this.typed(binaryen.anyref); }
  // Precise-type local (spill slots keep GC ref types exact).
  typed(t: binaryen.Type): number {
    this.locals.push(t);
    return this.params + this.locals.length - 1;
  }

  // Frame slot i (anyref) of the current frame (local 0) — the args/builtin
  // access path. Writes push (arrayref, index) + value + aset at the .
  slot(i: number): void {
    this.body.localGet(0);
    this.body.structGet(4, 1);
    this.body.i32Const(i);
    this.body.arrayGet(1);
  }

  // f64 payload of slot i's number; ref.cast traps on non-numbers (the
  // frozen §7.7 deviation — unreachable in well-typed programs).
  slotF64(i: number): number {
    const l = this.f64();
    this.slot(i);
    this.body.refCast(0, false);
    this.body.structGet(0, 0);
    this.body.localSet(l);
    return l;
  }


  // String concatenation of $STR locals a, b → new $STR on the stack.
  emitStrCat(a: number, b: number): void {
    const body = this.body;
    const res = this.anyref();
    body.localGet(a); body.refCast(2, true); body.arrayLen();
    body.localGet(b); body.refCast(2, true); body.arrayLen();
    body.u8(w.ADD);
    body.arrayNew(2);
    body.localSet(res);
    // copy a then b (b starts at unit offset la)
    body.localGet(res);
    body.refCast(2, true);
    body.i32Const(0);
    body.localGet(a); body.refCast(2, true);
    body.i32Const(0);
    body.localGet(a); body.refCast(2, true); body.arrayLen();
    body.arrayCopy(2, 2);
    body.localGet(res);
    body.refCast(2, true);
    body.localGet(a); body.refCast(2, true); body.arrayLen();
    body.localGet(b); body.refCast(2, true);
    body.i32Const(0);
    body.localGet(b); body.refCast(2, true); body.arrayLen();
    body.arrayCopy(2, 2);
    body.localGet(res);
  }

  // for (i = 0; i < n; i++) iter(i) — n pushed by pushN (const or local).
  // Emits BLOCK { LOOP { cond; br_if out; iter; incr; br; } }.
  loop(pushN: () => void, iter: (i: number) => void): void {
    const b = this.body;
    const i = this.i32();
    b.i32Const(0);
    b.localSet(i); // reset: a loop nested in another loop's body reuses this local across outer iterations
    b.u8(w.BLOCK);
    b.u8(0x40);
    b.u8(w.LOOP);
    b.u8(0x40);
    b.localGet(i);
    pushN();
    b.u8(w.GEU);
    b.u8(w.BR_IF);
    b.lebU(1);
    iter(i);
    b.localGet(i);
    b.i32Const(1);
    b.u8(w.ADD);
    b.localSet(i);
    b.u8(w.BR);
    b.lebU(0);
    b.u8(w.END);
    b.u8(w.END);
  }

  // Pushes (arrayref, index) of element i (local) of raw $ELEMS local
  // `blk`; callers finish with aget (read) or push the value + aset (write).
  elemAddr(blk: number, i: number): void {
    this.body.localGet(blk);
    this.body.refCast(1, true);
    this.body.localGet(i);
  }

  // Allocates a raw $ELEMS array of length local `n`; returns the local.
  allocArrBlk(n: number): number {
    const blk = this.anyref();
    this.body.localGet(n);
    this.body.arrayNew(1);
    this.body.localSet(blk);
    return blk;
  }

  // Wraps the raw $ELEMS local `blk` → new $ARR wrapper on the stack.
  // Growth (`set`) repoints the wrapper's backing array, so every alias
  // sharing the wrapper sees the growth (§7.1).
  boxArr(blk: number): void {
    this.body.localGet(blk);
    this.body.refCast(1, true);
    this.body.structNew(3);
  }

  // Copies n (local) elements from srcBlk's elements starting at srcOff into
  // a fresh array; leaves the boxed $ARR wrapper on the stack.
  emitArrCopy(srcBlk: number, srcOff: number, n: number): void {
    const b = this.body;
    const blk = this.allocArrBlk(n);
    b.localGet(blk);
    b.refCast(1, true);
    b.i32Const(0);
    b.localGet(srcBlk);
    b.refCast(1, true);
    b.i32Const(srcOff);
    b.localGet(n);
    b.arrayCopy(1, 1);
    this.boxArr(blk);
  }

  // Materialize a ValueRef onto the operand stack, at its consume point.
  // This is the ONLY sanctioned place short-lived stack values cross an
  // emitter boundary (the helper fully balances the stack per ref).
  pushRef(r: ValueRef): void {
    const b = this.body;
    if (r.k === "g") b.globalGet(r.gi);
    else if (r.k === "bool") { b.i32Const(r.v); b.refI31(); }
    else if (r.k === "local") b.localGet(r.l);
    else if (r.k === "snapSlot") { b.localGet(r.snap); b.refCast(4, true); b.structGet(4, 1); b.i32Const(r.i); b.arrayGet(1); }
    else { b.localGet(0); b.structGet(4, 1); b.i32Const(r.i); b.arrayGet(1); }
  }

  constF64(x: number) {
    return () => this.body.f64Const(x);
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
  retCell(fragIdx: number, nextE: () => void): number {
    const b = this.body;
    const cell = this.anyref();
    b.i32Const(w.K_RET);
    b.refI31();
    b.i32Const(fragIdx);
    b.refI31();
    b.localGet(0); // b = the frame the fragment runs over
    nextE();
    b.refCast(5, true);
    b.structNew(5);
    b.localSet(cell);
    return cell;
  }

  // A K_SPILL cell {K_SPILL, snapshot, null, next} chained in front of a
  // split site's rest fragment. The snapshot freezes the values the rest
  // fragment reloads from operand-spill slots: a copy of the current frame
  // image taken at the split site (per capture — this cell is allocated at
  // runtime on every site execution and copied into every continuation
  // captured here, so multi-shot resumes each see the values this execution
  // had built up, matching the interpreter's CPS accs).
  // This is correct at a NESTED site too (a split site inside a fragment
  // re-emission): the frame slots such a fragment reloads
  // were all written after the outer freeze — fresh emission aborts at the
  // first split site, so anything after it is only ever computed by
  // fragment code, which re-runs on every resume and re-persists its spill
  // slots before reaching the nested site. The outer frozen image predates
  // those writes (reusing it here handed the nested fragment null for
  // slots it legitimately reloads), while pre-outer-cut values still sit
  // unmutated in the live frame, so the live freeze sees them too.
  snapWrap(nextE: () => void): number {
    // A K_SPILL cell {K_SPILL, snapshot, null, next} chained in front of a
    // split site's rest fragment. The snapshot freezes the values the rest
    // fragment reloads from operand-spill slots: a copy of the current frame
    // image taken at the split site (per capture — this cell is allocated at
    // runtime on every site execution and copied into every continuation
    // captured here, so multi-shot resumes each see the values this execution
    // had built up, matching the interpreter's CPS accs). Nested split sites
    // inside a fragment re-emission freeze the live frame too — see above.
    const b = this.body;
    const ksp = this.anyref(), snapv = this.anyref();
    // Fresh $FRAME {same parent, slots array copied via array.copy} — the
    // per-capture freeze (shallow slot copy, same as the old block copy).
    b.localGet(0); b.structGet(4, 1); b.arrayLen();
    b.arrayNew(1);
    b.localSet(snapv);
    b.localGet(snapv);
    b.refCast(1, true);
    b.i32Const(0);
    b.localGet(0); b.structGet(4, 1);
    b.i32Const(0);
    b.localGet(0); b.structGet(4, 1); b.arrayLen();
    b.arrayCopy(1, 1);
    b.localGet(0); b.structGet(4, 0);
    b.localGet(snapv);
    b.refCast(1, true);
    b.structNew(4);
    b.localSet(snapv);
    b.i32Const(w.K_SPILL);
    b.refI31();
    b.localGet(snapv);
    b.refNull(w.ANYREF); // b unused (was UNIT_CELL)
    nextE();
    b.refCast(5, true);
    b.structNew(5);
    b.localSet(ksp);
    return ksp;
  }
}

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
  | {k: "g", gi: number}   // static anyref global (§5)
  | {k: "bool", v: 0 | 1}  // i31 bool
  | {k: "local", l: number}   // anyref local (single-use)
  | {k: "slot", i: number}    // frame slot i of local 0's frame
  | {k: "snapSlot", snap: number, i: number}; // frozen-frame slot (fragment re-emission)

// Initializer descriptor of one static global (§5): the data buildModule
// turns into a GC constant expression. Statics are immutable, so
// instantiation itself builds the value — no runtime fill.
type StaticDesc =
  | {t: "null"}                       // unit
  | {t: "i31", v: number}             // true/false
  | {t: "num", v: number}             // $NUM box (number literals, PI)
  | {t: "str", s: string}             // $STR code-unit array
  | {t: "clo", fni: number, fsize: number} // builtin $CLO
  | {t: "elems", ws: number[]};       // handler case table ($ELEMS i31s)


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

// --- compiler ---------------------------------------------------------------

export function compile(src: string): Uint8Array {
  return compileWithOps(src).bytes;
}

// compile + the effect op table (opid → name) the host needs to interpret
// ef_perform calls. The table is built by the same discovery pass that emits
// the code, so the wasm module and the host agree on op numbering.
export function compileWithOps(src: string): {bytes: Uint8Array, ops: string[]} {
  const prog = new Parser(src).parseProgram();
  // One compile at a time runs in-process; bind the module for the Buf
  // emitters (they construct binaryen expressions without threading it
  // through every call).
  const mod = new binaryen.Module();
  mod.setFeatures(BIN_FEATURES);
  MOD = mod;
  // Phase pipeline (free functions over plain artifact records),
  // then emission (one local Emit context) and assembly.
  const d = discover(prog);
  const o = optimize(prog);
  const ix = assignIndices(prog, d, o);
  const lay = layoutStatics(d, ix, o);
  const funcs = emit(prog, d, o, ix, lay);
  return {bytes: buildModule(mod, o, lay, funcs), ops: d.effOps};
}

// The binaryen shrink pass runs inside buildModule (the module is built via
// binaryen's API, optimized in place at shrink level 2, then emitted).
// EF_SKIP_WASM_OPT=1 bypasses the shrink pass: a binaryen abort is total
// (every compile fails until process exit), so there must be an escape
// hatch from day one.

// Feature set to read with: exactly what the emitter emits — WasmGC value
// plane (structs/arrays/i31), funcref table (reference-types) +
// return_call_indirect (tail-call) + MVP basics.
export const BIN_FEATURES = binaryen.Features.MVP | binaryen.Features.ReferenceTypes |
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


// --- compile phases ----------------------------------------------------------
// The backend pipeline is a composition of free functions over plain artifact
// records: each phase returns a fresh record with its additions, and no phase
// mutates an artifact it did not create (shared entities — Fn, Scope — stay
// mutable in place as before). compileWithOps composes the pipeline; the
// emission phase at the bottom owns one local Emit context.

// Phase 1 — discovery: typecheck, effect-op interning, handler-presence
// pre-scan, then the scope/slot/literal/split-site walk over the whole
// program. Written once; read by every later phase and by emission.
type Discovery = {
  // Scope per lambda/block (ExprID → its Scope).
  scopes: Map<ExprID, Scope>,
  globalScope: Scope,
  // Literal presence maps (value → placeholder -1; static layout resolves
  // the global indices into Layout.numStatics/strStatics).
  numLits: Map<number, number>,
  strLits: Map<string, number>,
  // App nodes whose call is a non-builtin (lambda) call: split sites (§3
  // emitCall). map/each/flatmap are builtins but land-style too.
  landCalls: Set<ExprID>,
  // Per-handle discovery records (§4.4): op cases + explicit Return case +
  // the hframe scope bounding the case params/resume names + npMax. Case-fn
  // funcref indices land in Indices (assignIndices), the case-table static
  // global in Layout (layoutStatics) — neither is written here.
  hdlCases: Map<ExprID, {
    cases: {
      op: string,
      opid: number,
      fn: Fn,
      fsize: number,
      nparams: number,
      body: ExprID,
    }[],
    retCase: {
      fn: Fn,
      fsize: number,
      nparams: number,
      body: ExprID,
    } | null,
    npMax: number,
    scope: Scope,
  }>,
  // True iff the program contains any `handle` node. K_HDL cells are pushed
  // only by handle emission, so a handle-free program's k chains hold
  // K_RET/K_SPILL cells only and emitDispatch can skip the handler
  // case-table scan.
  hasHandle: boolean,
  // Effect op table: builtin ops pre-seeded (analysis.ts EFFECT_OPS,
  // builtins.ts table order); the program's performed/handled ops intern in
  // first-appearance AST order. Returned to the host by compileWithOps.
  effOps: string[],
  effOpIds: Map<string, number>,
};

// Phase 2 — module-level optimization facts (OPT_PASSES at the bottom of the file).
// Ordered passes over the program; each records facts the emitters
// consume, and index assignment derives helper/lambda/builtin funcref
// indices from the live import count (that ordering constraint is dataflow
// here: assignIndices takes Opt).
type Opt = {
  // Builtins referenced as VALUES (analysis.ts builtinValueUses —
  // treeShakeBuiltins): $CLO pool closures are emitted only for these;
  // call-only builtins are called directly via builtinFnIdx instead, and
  // operator trampolines exist only when the operator is value-referenced.
  valueBuiltins: Set<string>,
  // Builtins the program references at all (values + call sites,
  // shadowing-correct): layoutStatics/emitBuiltins emit only these.
  usedBuiltins: Set<string>,
  // Live host imports (dropDeadHostImports) — a subset of HOST_IMPORTS in
  // original order — and each name's funcref index. Defined-function
  // indices: helpers first (they always follow the imports), then lambdas,
  // then handler case functions, builtins, main.
  liveImports: string[],
  impIdx: Map<string, number>,
};

// Phase 3 — funcref index assignment (helpers, lambdas, spills, handler case
// functions, builtin trampolines), deterministic AST order.
type Indices = {
  // funcref index → typeIdx (direct CALL targets resolve their signatures
  // through it; indirect calls carry the type index in the stream).
  funcRefTypes: Map<number, number>,
  // Helper funcref indices: helpers always follow the live imports.
  fTruthy: number,
  fEq: number,
  fBox: number,
  fCapture: number,
  fLambda0: number,
  // Lambda funcref index per lambda node (deterministic AST order).
  lambdaIdx: Map<ExprID, number>,
  // Perform spilling (§4.2): perform node → frame slot of its args cell.
  // The cell must survive the handler walk and stay reachable from the
  // after-perform fragment through the RET cell's frame pointer (cell.b).
  spillOf: Map<ExprID, number>,
  // Perform/handle node → frame slot of its result value, spilled eagerly
  // whenever the node's value is substituted into a rest-of-site fragment
  // so later splits (and resumes) reload it instead of re-running it. For a
  // handle node this slot holds the installed K_HDL cell until the handle
  // completes (a split inside its body reloads the cell from here).
  valSpill: Map<ExprID, number>,
  // Impure child node → frame slot of its already-computed value, allocated
  // for children that run before a split deeper in the same expression
  // (sibling operands of enclosing apps/arr literals). Pure children re-emit
  // observably identically; impure ones reload from here instead.
  operandSpill: Map<ExprID, number>,
  // frame → spill slots appended after its named slots (folded into the
  // lambda's frameSize / the global frame's allocation; see frameSizeOf).
  spillTotals: Map<{slots: number}, number>,
  // Shared default-Return case function, used only by handlers with npMax 0:
  // reads the Return value emitDispatch stashed in hframe slot 1 and
  // dispatches it through its k — eval.ts:132's `(v, k2) => k2(v)`.
  identityRet: Fn,
  // Shared resume-closure fn (§4.6): the T_KABI fn every perform site's
  // boxed resume binder points at.
  resumeFn: Fn,
  // Total count of handler case functions (idf + per-handler fns + rf).
  caseFnTotal: number,
  // Per-handler default-Return identity fns: for handlers without an
  // explicit Return case and with npMax > 0 — with nparams = npMax,
  // emitDispatch stashes the Return value at hframe slot npMax + 1 where
  // the fn reads it (the shared npMax=0 identity fn would clobber
  // param/resume slots).
  hdlIdRet: Map<ExprID, Fn>,
  // Builtin trampolines: funcref index of the first builtin / first land
  // thunk, and trampoline funcref index per emitted builtin (direct builtin
  // call sites target these instead of loading a $CLO and dispatching
  // through the table).
  builtin0: number,
  thunk0: number,
  builtinFnIdx: Map<string, number>,
};

// Phase 4 — static layout (§5): immutable anyref globals with constant
// initializers — deduped number literals, PI, string literals, true/false
// i31s, unit, one $CLO per surviving builtin, and per-handle case tables
// ($ELEMS of flat [opid, fnIdx, fsize, nparams] i31 quadruples). Every
// static allocates one global index; buildModule turns its descriptor into
// the initializer.
type Layout = {
  statics: StaticDesc[],
  // Unit/bool statics (unit = the global's initial ref.null any).
  unitRef: ValueRef,
  trueRef: ValueRef,
  falseRef: ValueRef,
  // PI constant global (only when the program references PI).
  piG: number,
  numStatics: Map<number, number>,   // literal value → static global idx
  strStatics: Map<string, number>,   // literal value → static global idx
  cloOffsets: Map<string, number>,   // builtin name → static $CLO global idx
  hdlTableOff: Map<ExprID, number>,  // handle → case-table static global idx
};

// --- phase functions ---------------------------------------------------------

function discover(prog: Program): Discovery {
  // Typecheck first: rejects ill-typed programs and stamps the runtime
  // markers this backend reads (`div` on applications of `/`, `idx` on
  // field accesses).
  checkProgram(prog);
  const globalFrame = {slots: 0};
  const d: Discovery = {
    scopes: new Map(),
    globalScope: {frame: globalFrame, parent: null, map: new Map()},
    numLits: new Map(),
    strLits: new Map(),
    landCalls: new Set(),
    hdlCases: new Map(),
    hasHandle: prog.nodes.some(n => n.t === "handle"),
    effOps: [...EFFECT_OPS],
    effOpIds: new Map(EFFECT_OPS.map((op, i) => [op, i])),
  };
  // Effect op discovery (analysis.ts): builtin ops are pre-seeded above; the
  // program's performed/handled ops intern in first-appearance AST order —
  // before the walk below, whose handler records read effOpIds.
  for (const op of collectEffectOps(prog))
    if (!d.effOpIds.has(op)) {
      d.effOpIds.set(op, d.effOps.length);
      d.effOps.push(op);
    }
  // Scope discovery: scopes per lambda/block, slot numbering, literals,
  // split sites, handler records.
  const rec = (id: ExprID, sc: Scope): void => {
    const e = prog.nodes[id];
    switch (e.t) {
      case "num":
        d.numLits.set(e.v, -1);
        break;
      case "str":
        d.strLits.set(e.v, -1);
        break;
      case "lambda": {
        const frame = {slots: 0};
        const s: Scope = {frame, parent: sc, map: new Map()};
        for (const p of e.params) s.map.set(p.name, frame.slots++);
        d.scopes.set(id, s);
        rec(e.body, s);
        break;
      }
      // Blocks share the enclosing wasm frame: their lets just take further
      // slots (the interpreter's block env is a child of the current env).
      case "block": {
        const s: Scope = {frame: sc.frame, parent: sc, map: new Map()};
        d.scopes.set(id, s);
        for (const stmt of e.stmts) rec(stmt, s);
        break;
      }
      case "let":
        sc.map.set(e.name, sc.frame.slots++);
        rec(e.val, sc);
        break;
      case "dlet":
        for (const fd of e.fields) sc.map.set(fd.name, sc.frame.slots++);
        rec(e.val, sc);
        break;
      case "assign":
        rec(e.val, sc);
        break;
      case "if":
        rec(e.c, sc);
        rec(e.a, sc);
        rec(e.b, sc);
        break;
      case "while":
        rec(e.c, sc);
        rec(e.body, sc);
        break;
      case "app": {
        // Mark non-builtin calls as split sites (§3 emitCall); the same
        // predicate the app case/emitCallClosure use for the land convention.
        // map/each/flatmap are builtins but land-style too: their result
        // dispatches through the caller's continuation and a performing
        // callback must see the caller's handler chain.
        // (cloOffsets is only filled at static layout, later than this
        // pass, so match against the BUILTINS name list here.)
        const fne = prog.nodes[e.fn];
        const name = fne.t === "sym" ? fne.v : null;
        const isBuiltin = name !== null && resolve(sc, name) === null &&
          BUILTINS.some(b => b.name === name);
        if (name === null || !isBuiltin || MAP_LIKE.has(name)) {
          d.landCalls.add(id);
        }
        rec(e.fn, sc);
        for (const a of e.args) rec(a, sc);
        break;
      }
      case "arr":
        for (const el of e.elems) rec(el, sc);
        break;
      case "field":
        rec(e.obj, sc);
        d.strLits.set(e.name, -1); // for the out-of-bounds message
        break;
      case "perform":
        for (const a of e.args) rec(a, sc);
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
              opid: d.effOpIds.get(c.op)!,
              fn: new Fn(2),
              fsize: 0,
              nparams: c.params.length,
              body: c.body,
            });
          }
        }
        frame.slots = npMax + 2;
        d.hdlCases.set(id, {cases, retCase, npMax, scope: hs});
        // The handler body binds into the enclosing frame (it runs inline
        // there); case bodies bind into the hframe.
        rec(e.body, sc);
        for (const c of e.cases) rec(c.body, hs);
        break;
      }
      case "sym":
      case "bool":
      case "unit":
        break;
    }
  };
  for (const it of prog.items) {
    if ("e" in it) rec(it.e, d.globalScope);
  }
  return d;
}

function optimize(prog: Program): Opt {
  const o: Opt = {
    valueBuiltins: new Set(),
    usedBuiltins: new Set(),
    liveImports: [...HOST_IMPORTS],
    impIdx: new Map(HOST_IMPORTS.map((n, i): [string, number] => [n, i])),
  };
  for (const pass of OPT_PASSES)
    pass(prog, o);
  return o;
}

function assignIndices(prog: Program, d: Discovery, o: Opt): Indices {
  // 2b. Helper funcref indices: helpers always follow the live imports.
  const ix: Indices = {
    funcRefTypes: new Map(),
    fTruthy: o.liveImports.length,
    fEq: o.liveImports.length + 1,
    fBox: o.liveImports.length + 2,
    fCapture: o.liveImports.length + 3,
    fLambda0: o.liveImports.length + 4,
    lambdaIdx: new Map(),
    spillOf: new Map(),
    valSpill: new Map(),
    operandSpill: new Map(),
    spillTotals: new Map(),
    identityRet: undefined!, // set in 2e
    resumeFn: undefined!,
    caseFnTotal: 0,
    hdlIdRet: new Map(),
    builtin0: 0,
    thunk0: 0,
    builtinFnIdx: new Map(),
  };
  // 2c. Function index assignment (deterministic AST order).
  const assignLambdas = (id: ExprID): void => {
    const e = prog.nodes[id];
    switch (e.t) {
      case "lambda":
        ix.lambdaIdx.set(id, ix.fLambda0 + ix.lambdaIdx.size);
        ix.funcRefTypes.set(ix.lambdaIdx.get(id)!, w.T_KABI); // sigs resolve before emission
        assignLambdas(e.body);
        break;
      case "let":
      case "assign":
      case "dlet":
        assignLambdas(e.val);
        break;
      case "block":
        for (const stmt of e.stmts) assignLambdas(stmt);
        break;
      case "if":
        assignLambdas(e.c);
        assignLambdas(e.a);
        assignLambdas(e.b);
        break;
      case "while":
        assignLambdas(e.c);
        assignLambdas(e.body);
        break;
      case "app":
        assignLambdas(e.fn);
        for (const a of e.args) assignLambdas(a);
        break;
      case "arr":
        for (const el of e.elems) assignLambdas(el);
        break;
      case "field":
        assignLambdas(e.obj);
        break;
      case "handle":
        assignLambdas(e.body);
        for (const c of e.cases) assignLambdas(c.body);
        break;
      case "perform":
        for (const a of e.args) assignLambdas(a);
        break;
    }
  };
  for (const it of prog.items) {
    if ("e" in it) assignLambdas(it.e);
  }
  // 2d. Spill slots for perform/handle sites (§4.2/§4.4): each perform gets
  // an args-cell slot and a result-value slot, each handle a result-value
  // slot, folded into the enclosing frame's size (case-body spills go into
  // the handler's hframe).
  const addOperandSpill = (id: ExprID, frame: {slots: number}): void => {
    ix.operandSpill.set(id, frame.slots + (ix.spillTotals.get(frame) ?? 0));
    ix.spillTotals.set(frame, (ix.spillTotals.get(frame) ?? 0) + 1);
  };
  const computeSpills = (): void => {
    const walk = (id: ExprID, frame: {slots: number}): void => {
      const e = prog.nodes[id];
      switch (e.t) {
        case "lambda":
          walk(e.body, d.scopes.get(id)!.frame);
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
          if (splits(prog, d, e.c) || splits(prog, d, e.a) || splits(prog, d, e.b)) {
            // A split-mode if (splitting arms): the condition reloads in
            // the fragment, and an arm before the cut site reloads too.
            // Every child spills — including pure ones: a multi-shot resume
            // re-runs the fragment after the first resume mutated the frame,
            // so re-emitting a sym/lambda/arr-literal child would observe
            // post-mutation state (or a fresh cell identity) where the
            // interpreter's CPS acc froze the pre-perform value.
            addOperandSpill(e.c, frame);
            addOperandSpill(e.a, frame);
            addOperandSpill(e.b, frame);
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
          if (kids.some(k2 => splits(prog, d, k2))) {
            for (const k2 of kids) {
              addOperandSpill(k2, frame);
            }
          }
          for (const k2 of kids) walk(k2, frame);
          break;
        }
        case "arr": {
          const elems = e.elems;
          if (elems.some(el => splits(prog, d, el))) {
            for (const el of elems) {
              addOperandSpill(el, frame);
            }
          }
          for (const el of elems) walk(el, frame);
          break;
        }
        case "field":
          walk(e.obj, frame);
          break;
        case "perform": {
          ix.spillOf.set(id, frame.slots + (ix.spillTotals.get(frame) ?? 0));
          ix.spillTotals.set(frame, (ix.spillTotals.get(frame) ?? 0) + 1);
          ix.valSpill.set(id, frame.slots + (ix.spillTotals.get(frame) ?? 0));
          ix.spillTotals.set(frame, (ix.spillTotals.get(frame) ?? 0) + 1);
          const flags = e.args.map(a => splits(prog, d, a));
          if (flags.some(Boolean)) {
            for (const a of e.args) {
              addOperandSpill(a, frame);
            }
          }
          for (const a of e.args) walk(a, frame);
          break;
        }
        case "handle": {
          ix.valSpill.set(id, frame.slots + (ix.spillTotals.get(frame) ?? 0));
          ix.spillTotals.set(frame, (ix.spillTotals.get(frame) ?? 0) + 1);
          walk(e.body, frame);
          // Case bodies run over the handler's shared hframe, so their
          // perform spills land there (folded into the table's fsize).
          const info = d.hdlCases.get(id)!;
          for (const c of info.cases) walk(c.body, info.scope.frame);
          if (info.retCase !== null) walk(info.retCase.body, info.scope.frame);
          break;
        }
        default:
          break; // num/str/bool/unit/sym: no children
      }
    };
    for (const it of prog.items) {
      if ("e" in it) walk(it.e, d.globalScope.frame);
    }
  };
  computeSpills();
  // 2e. Handler case functions: funcref indices + hframe sizes, plus the
  // default-Return identity functions (shared npMax=0 one, per-handler ones
  // for npMax > 0). Case functions run over the handler's shared hframe, so
  // every case of one handler shares its fsize.
  const idf = new Fn(2);
  idf.idx = ix.fLambda0 + ix.lambdaIdx.size;
  ix.identityRet = idf;
  ix.funcRefTypes.set(idf.idx, w.T_KABI);
  let next = idf.idx + 1;
  for (const [hdlId, info] of d.hdlCases) {
    const fs = frameSizeOf(ix, info.scope);
    for (const c of info.cases) {
      c.fn.idx = next++;
      ix.funcRefTypes.set(c.fn.idx, w.T_KABI);
      c.fsize = fs;
    }
    if (info.retCase !== null) {
      info.retCase.fn.idx = next++;
      ix.funcRefTypes.set(info.retCase.fn.idx, w.T_KABI);
      info.retCase.fsize = fs;
    } else if (info.npMax > 0) {
      const idr = new Fn(2);
      idr.idx = next++;
      ix.funcRefTypes.set(idr.idx, w.T_KABI);
      ix.hdlIdRet.set(hdlId, idr);
    }
  }
  const rf = new Fn(2);
  rf.idx = next++;
  ix.funcRefTypes.set(rf.idx, w.T_KABI);
  ix.resumeFn = rf;
  ix.caseFnTotal = next - idf.idx;
  // Land thunks occupy the table slots between builtins and main; builtin
  // trampolines (must match emitBuiltins' emission order: BUILTINS filtered
  // by usedBuiltins).
  const builtins = BUILTINS.filter(b => o.usedBuiltins.has(b.name));
  ix.builtin0 = ix.fLambda0 + ix.lambdaIdx.size + ix.caseFnTotal;
  ix.thunk0 = ix.builtin0 + builtins.length;
  for (let i = 0; i < builtins.length; i++) {
    ix.builtinFnIdx.set(builtins[i].name, ix.builtin0 + i);
    ix.funcRefTypes.set(ix.builtin0 + i, w.T_KABI); // sigs resolve before emission
  }
  return ix;
}

function layoutStatics(d: Discovery, ix: Indices, o: Opt): Layout {
  const lay: Layout = {
    statics: [],
    unitRef: {k: "g", gi: 0},
    trueRef: {k: "g", gi: 0},
    falseRef: {k: "g", gi: 0},
    piG: -1,
    numStatics: new Map(),
    strStatics: new Map(),
    cloOffsets: new Map(),
    hdlTableOff: new Map(),
  };
  const newStatic = (desc: StaticDesc): number => {
    lay.statics.push(desc);
    return lay.statics.length - 1;
  };
  // Unit: ref.null any.
  lay.unitRef = {k: "g", gi: newStatic({t: "null"})};
  // Bools: i31(0/1).
  lay.trueRef = {k: "g", gi: newStatic({t: "i31", v: 1})};
  lay.falseRef = {k: "g", gi: newStatic({t: "i31", v: 0})};
  // Number literals (deduped by value).
  for (const [v] of d.numLits)
    lay.numStatics.set(v, newStatic({t: "num", v}));
  // PI constant (only when the program references it).
  if (o.usedBuiltins.has("PI"))
    lay.piG = newStatic({t: "num", v: Math.PI});
  // String literals (field names included — same constant pool).
  for (const [v] of d.strLits)
    lay.strStatics.set(v, newStatic({t: "str", s: v}));
  // Builtin closures: $CLO {fnIdx, env = null, fsize = params + map-like
  // extras} — only VALUE-referenced builtins get one (treeShakeBuiltins +
  // builtinValueUses): call-only builtins are called directly via
  // builtinFnIdx, so no closure object is materialized. `list` keeps fsize
  // 0: its slot count is exactly argc, which the trampoline reads back via
  // array.len.
  for (const bi of BUILTINS) {
    if (!o.valueBuiltins.has(bi.name)) continue;
    const fni = ix.builtinFnIdx.get(bi.name);
    if (fni === undefined) throw new WasmError(`internal: no trampoline for builtin ${bi.name}`);
    lay.cloOffsets.set(bi.name, newStatic({t: "clo", fni, fsize: bi.params + mapLikeFrameWords(bi.name)}));
  }
  // PI is a float *value* (the checker types it `float`, not
  // `() -> float`), so bind the name to the constant global, not to a
  // closure.
  if (o.usedBuiltins.has("PI")) {
    lay.cloOffsets.set("PI", lay.piG);
  }
  // Handler case tables (§4.4): flat [opid, fnIdx, fsize, nparams]* i31s.
  // The Return entry (opid -1) always goes last — an explicit case fn when
  // the handler declares one (its nparams = npMax puts the value at slot
  // npMax+1), otherwise an identity fn with matching nparams (the shared
  // npMax=0 fn puts the value at slot 1 where it reads it back; handlers
  // with npMax > 0 get a per-handler fn so param/resume slots stay
  // intact). The perform walk reads these at runtime, so all facts are
  // data, not immediates.
  for (const [hdlId, info] of d.hdlCases) {
    const entries = info.cases.map(c => ({opid: c.opid, fn: c.fn, fsize: c.fsize, nparams: c.nparams}));
    if (info.retCase !== null) {
      entries.push({opid: -1, fn: info.retCase.fn, fsize: info.retCase.fsize, nparams: info.retCase.nparams});
    } else if (info.npMax === 0) {
      entries.push({opid: -1, fn: ix.identityRet, fsize: frameSizeOf(ix, info.scope), nparams: 0});
    } else {
      entries.push({opid: -1, fn: ix.hdlIdRet.get(hdlId)!, fsize: frameSizeOf(ix, info.scope), nparams: info.npMax});
    }
    const words: number[] = [];
    for (const en of entries)
      words.push(en.opid, en.fn.idx, en.fsize, en.nparams);
    lay.hdlTableOff.set(hdlId, newStatic({t: "elems", ws: words}));
  }
  return lay;
}

// Cut-site query: does this subtree contain a split site (perform/handle/land call)?
// Reads Discovery's split-site set; shared by assignIndices'
// spill walk and the emitters' cut machinery.
function splits(prog: Program, d: Discovery, id: ExprID): boolean {
  const e = prog.nodes[id];
  switch (e.t) {
    case "perform":
    case "handle":
      return true;
    case "lambda":
      return false;
    case "block":
      return e.stmts.some(st2 => splits(prog, d, st2));
    case "let":
    case "assign":
    case "dlet":
      return splits(prog, d, e.val);
    case "if":
      return splits(prog, d, e.c) || splits(prog, d, e.a) || splits(prog, d, e.b);
    case "while":
      return splits(prog, d, e.c) || splits(prog, d, e.body);
    case "app":
      return d.landCalls.has(id) || splits(prog, d, e.fn) || e.args.some(a => splits(prog, d, a));
    case "arr":
      return e.elems.some(el => splits(prog, d, el));
    case "field":
      return splits(prog, d, e.obj);
    default:
      return false; // num/str/bool/unit/sym
  }
}

// Frame size of a scope's frame: named slots + perform spill slots (§4.2).
// Everything that allocates a frame (lambda closure fsize, the global frame
// in emitMain) must go through this so spilled values fit.
function frameSizeOf(ix: Indices, sc: Scope): number {
  return sc.frame.slots + (ix.spillTotals.get(sc.frame) ?? 0);
}

function resolve(sc: Scope, name: string): {d: number, i: number} | null {
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

// --- assembly -----------------------------------------------------------------

function staticInit(m: binaryen.Module, d: StaticDesc): binaryen.ExpressionRef {
  const {HT} = _T;
  switch (d.t) {
    case "null": return m.ref.null(binaryen.anyref);
    case "i31": return m.ref.i31(m.i32.const(d.v));
    case "num": return m.struct.new([m.f64.const(d.v)], HT[0]);
    case "str": {
      const cs: binaryen.ExpressionRef[] = [];
      for (let i = 0; i < d.s.length; i++) cs.push(m.i32.const(d.s.charCodeAt(i)));
      return m.array.new_fixed(HT[2], cs);
    }
    case "clo":
      return m.struct.new([
        m.ref.i31(m.i32.const(d.fni)),
        m.ref.null(w.heapTypes(4).n), // env: builtins run over the call frame itself
        m.ref.i31(m.i32.const(d.fsize)),
      ], HT[6]);
    case "elems":
      return m.array.new_fixed(HT[1], d.ws.map((w) => m.ref.i31(m.i32.const(w))));
  }
}

function buildModule(m: binaryen.Module, o: Opt, lay: Layout, funcs: Fn[]): Uint8Array {
  // import section
  for (let i = 0; i < o.liveImports.length; i++) {
    const n = o.liveImports[i];
    const sig = SIGS[w.impType(n)];
    m.addFunctionImport(`f${i}`, "env", n,
      binaryen.createType(sig.p.map(vt)), sig.r === null ? binaryen.none : vt(sig.r));
  }
  // global section: immutable statics, each initialized by a GC constant
  // expression (§5) — instantiation builds the value, no runtime fill.
  for (let i = 0; i < lay.statics.length; i++)
    m.addGlobal(`g${i}`, binaryen.anyref, false, staticInit(m, lay.statics[i]));
  // table + functions + identity element segment (slot i → func i).
  const total = o.liveImports.length + funcs.length;
  m.addTable("t0", total, total);
  for (let i = 0; i < funcs.length; i++) {
    const f = funcs[i];
    const funcrefIdx = o.liveImports.length + i;
    const sig = SIGS[f.typeIdx] as {p: (number | number[])[], r: number | number[] | null} | undefined;
    if (sig === undefined) throw new WasmError(`internal: fn ${funcrefIdx} has unknown type ${f.typeIdx}`);
    m.addFunction(`f${funcrefIdx}`, binaryen.createType(sig.p.map(vt)),
      sig.r === null ? binaryen.none : vt(sig.r), f.locals, f.body.finish());
  }
  m.addActiveElementSegment("t0", "e0",
    Array.from({length: total}, (_, i) => `f${i}`), m.i32.const(0));
  // exports: run + the 12 accessors (§4) — the last 13 functions
  const expNames = ["run", "__tag", "__num", "__str_len", "__str_get",
    "__arr_len", "__arr_get", "__mk_num", "__mk_bool", "__str_new",
    "__str_set", "__arr_new", "__arr_set"];
  for (let i = 0; i < expNames.length; i++)
    m.addFunctionExport(`f${total - expNames.length + i}`, expNames[i]);
  // shrink pass (wasm-opt in-process; shrink level 2 alone matches -Oz
  // output size on our modules at ~1/3 the cost of full -Oz).
  if (process.env["EF_SKIP_WASM_OPT"] !== "1") {
    binaryen.setOptimizeLevel(0);
    binaryen.setShrinkLevel(2);
    m.optimize();
  }
  if (m.validate() === 0) {
    if (DBGEMIT) console.error(m.emitText());
    throw new WasmError("binaryen: compiled module failed validation");
  }
  const bytes = m.emitBinary();
  m.dispose();
  return bytes;
}

// --- emission -----------------------------------------------------------------
// Emission is free functions over one local Emit context, created inside
// emit() and dropped when it returns: nothing outside emission can touch
// this state. Each function takes `em` first; the per-node emission mode
// (ambient continuation cell + cut path) stays in the Ctx parameter.


// Split machinery (§3-§6b): the compile-time state of the cut path — the AST
// path currently being emitted (cutStack, snapshotted by split sites as their
// fragment's re-emission chain), the enclosing body roots a split-mode if
// fills its arm fragments against (bodyRoots), the rest fragments already
// filled (filledRests — a handle's after-rest is thrown to fillRest from
// every fragment re-emission of that handle, but only the first fill must
// land), the split chains already assigned a rest fragment (restByChain —
// a site's chain determines its fragment's content: the re-emission from
// that chain's body root is deterministic, so re-encountering a site during
// a later re-emission reuses the first fragment instead of re-filling),
// the re-emission root the innermost in-progress fillRest is filling
// against (restRoot — a land site discovered inside that re-emission must
// sync-fill against THIS root, not the bodyRoots top: synthetic arm
// re-emissions root at the arm, which is not a body-root statement),
// the after-handle rest fragments (hdlRest) and the split-mode while
// fragments (ctlLoops). One bundle, one lifetime.
type Splits = {
  cutStack: ExprID[],
  bodyRoots: {stmts: ExprID[], sc: Scope, tail: boolean, savedCut: ExprID[]}[],
  filledRests: Set<Fn>,
  restByChain: Map<string, Fn>,
  restRoot: {stmts: ExprID[], sc: Scope, tail: boolean, cutBase: ExprID[]} | null,
  hdlRest: Map<ExprID, Fn>,
  ctlLoops: Map<ExprID, {entry: Fn, rest: Fn}>,
};

// Emission context: created inside emit() and dropped when it returns.
// Carries the program (nodes is an alias of prog.nodes — the emitters read
// it constantly), the read-only phase artifacts, the code under construction
// and the split machinery.
type Emit = {
  prog: Program,
  nodes: Expr[],
  d: Discovery,
  o: Opt,
  ix: Indices,
  lay: Layout,
  // Code under construction: emitted functions, and the land thunks
  // (T_III_I) appended between builtins and main.
  funcs: Fn[],
  thunks: Fn[],
  // Split machinery (see Splits).
  sp: Splits,
};

function emit(prog: Program, d: Discovery, o: Opt, ix: Indices, lay: Layout): Fn[] {
  const em: Emit = {
    prog,
    nodes: prog.nodes,
    d, o, ix, lay,
    funcs: [],
    thunks: [],
    sp: {
      cutStack: [],
      bodyRoots: [],
      filledRests: new Set(),
      restByChain: new Map(),
      restRoot: null,
      hdlRest: new Map(),
      ctlLoops: new Map(),
    },
  };
  // Helpers (right after the live imports), lambdas, builtin trampolines,
  // then main (last; run/accessors follow in buildModule).
  em.funcs.push(...emitHelpers(em));
  for (const it of prog.items) {
    if ("e" in it) emitLambdas(em, it.e);
  }
  emitCaseFns(em);
  em.funcs.push(...emitBuiltins(em, ix.builtin0));
  const main = new Fn(2, em);
  emitMain(em, main);
  // Thunks are appended after all emission (emitMain's top-level calls
  // create thunks too); main stays the last program function (exported
  // as run — the run wrapper is assembled after it).
  em.funcs.push(...em.thunks);
  em.funcs.push(main);
  emitInits(em);
  return em.funcs;
}

// Signature of a direct-call target by funcref index: imports carry their
// type by name; defined functions registered at index assignment.
function sigOf(em: Emit, funcrefIdx: number): {ps: binaryen.Type[], r: binaryen.Type | null} {
  const typeIdx = funcrefIdx < em.o.liveImports.length
    ? w.impType(em.o.liveImports[funcrefIdx])
    : em.ix.funcRefTypes.get(funcrefIdx);
  const sig = SIGS[typeIdx!] as {p: (number | number[])[], r: number | number[] | null} | undefined;
  if (sig === undefined) {
    if (DBGEMIT)
      console.error("sigOf miss f" + String(funcrefIdx), "liveImports", em.o.liveImports.length,
        "types:", [...em.ix.funcRefTypes.entries()].map(([k, v]) => `${k}:${v}`).join(","));
    throw new WasmError(`internal: no sig for funcref ${funcrefIdx} (type ${typeIdx})`);
  }
  return {ps: sig.p.map((t) => vt(t)), r: sig.r === null ? null : vt(sig.r)};
}

function emitLambdas(em: Emit, id: ExprID): void {
  const e = em.nodes[id];
  switch (e.t) {
    case "lambda": {
      const f = new Fn(2, em);
      f.idx = em.ix.lambdaIdx.get(id)!; // funcref index (assignLambdas order)
      em.ix.funcRefTypes.set(f.idx, w.T_KABI);
      // bodyCatch emits the body and its completion dispatch (dead when
      // the body ended in a tail call or split).
      bodyCatch(em, e.body, f, em.d.scopes.get(id)!, true, INLINE);
      em.funcs.push(f);
      emitLambdas(em, e.body);
      break;
    }
    case "let":
    case "assign":
    case "dlet":
      emitLambdas(em, e.val);
      break;
    case "block":
      for (const stmt of e.stmts) emitLambdas(em, stmt);
      break;
    case "if":
      emitLambdas(em, e.c);
      emitLambdas(em, e.a);
      emitLambdas(em, e.b);
      break;
    case "while":
      emitLambdas(em, e.c);
      emitLambdas(em, e.body);
      break;
    case "app":
      emitLambdas(em, e.fn);
      for (const a of e.args) emitLambdas(em, a);
      break;
    case "arr":
      for (const el of e.elems) emitLambdas(em, el);
      break;
    case "field":
      emitLambdas(em, e.obj);
      break;
    case "handle":
      emitLambdas(em, e.body);
      for (const c of e.cases) emitLambdas(em, c.body);
      break;
    case "perform":
      for (const a of e.args) emitLambdas(em, a);
      break;
  }
}

// 4b. Handler case function bodies (§4.4). Each case body runs over the
// handler's shared hframe (its frame param) with k = HDL.next — the
// two-k rule: the ambient continuation is the one captured OUTSIDE the
// handler, so a perform inside a case body walks from there and never
// re-enters its own handler, and a case body finishing normally
// dispatches straight through it (no Return re-wrap). The identity fns
// dispatch their frame's Return value (slot 1 for the shared npMax=0 fn,
// slot npMax+1 for a per-handler fn — where emitDispatch stashes it for
// the matching nparams) through their k — eval.ts:132's (v, k2) => k2(v).
function emitCaseFns(em: Emit): void {
  const idf = em.ix.identityRet;
  idf.em = em;
  {
    const b = idf.body;
    const v = idf.anyref();
    b.localGet(0);
    b.structGet(4, 1);
    b.i32Const(1);
    b.arrayGet(1); // hframe slot 1: the Return value
    b.localSet(v);
    emitDispatch(em, idf, v);
  }
  em.funcs.push(idf);
  for (const [hdlId, info] of em.d.hdlCases) {
    for (const c of info.cases) {
      c.fn.em = em;
      bodyCatch(em, c.body, c.fn, info.scope, true, INLINE);
      em.funcs.push(c.fn);
    }
    if (info.retCase !== null) {
      info.retCase.fn.em = em;
      bodyCatch(em, info.retCase.body, info.retCase.fn, info.scope, true, INLINE);
      em.funcs.push(info.retCase.fn);
    } else if (info.npMax > 0) {
      const idr = em.ix.hdlIdRet.get(hdlId)!;
      idr.em = em;
      const b = idr.body;
      const v = idr.anyref();
      b.localGet(0);
      b.structGet(4, 1);
      b.i32Const(info.npMax + 1); // hframe Return slot (nparams = npMax)
      b.arrayGet(1);
      b.localSet(v);
      emitDispatch(em, idr, v);
      em.funcs.push(idr);
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
  const rf = em.ix.resumeFn;
  rf.em = em;
  {
    const b = rf.body;
    const v = rf.anyref(), rec = rf.anyref(), slice = rf.anyref(), hdl = rf.anyref();
    const copy = rf.anyref(), fresh = rf.anyref(), cur = rf.anyref();
    b.localGet(0);
    b.structGet(4, 1);
    b.i32Const(0);
    b.arrayGet(1);
    b.localSet(v); // the resumed value: the closure call frame's slot 0
    b.localGet(0);
    b.structGet(4, 0); // the capture record (env frame)
    b.localSet(rec);
    b.localGet(rec);
    b.refCast(4, true);
    b.structGet(4, 1);
    b.i32Const(1);
    b.arrayGet(1);
    b.localSet(slice);
    b.localGet(rec);
    b.refCast(4, true);
    b.structGet(4, 1);
    b.i32Const(2);
    b.arrayGet(1);
    b.localSet(hdl);
    b.localGet(slice);
    b.refCast(5, true);
    b.localGet(hdl);
    b.refCast(5, true);
    b.u8(w.CALL);
    b.lebU(em.ix.fCapture);
    b.localSet(copy);
    b.i32Const(w.K_HDL);
    b.refI31();
    b.localGet(hdl);
    b.refCast(5, true);
    b.structGet(5, 1); // a = the matched handler's case table
    b.localGet(rec);
    b.refCast(4, true);
    b.structGet(4, 1);
    b.i32Const(3);
    b.arrayGet(1); // b = the invocation's hframe copy (rec slot 3)
    b.localGet(1); // next = the k this closure was invoked with
    b.structNew(5);
    b.localSet(fresh);
    b.localGet(copy);
    b.localSet(cur);
    b.u8(w.BLOCK);
    b.u8(0x40);
    b.u8(w.LOOP);
    b.u8(0x40);
    b.localGet(cur);
    b.refCast(5, true);
    b.structGet(5, 3);
    b.localGet(hdl);
    b.refCast(5, true);
    b.refEq();
    b.u8(w.BR_IF);
    b.lebU(1); // cur is the bottom copy (its next is the old HDL)
    b.localGet(cur);
    b.refCast(5, true);
    b.structGet(5, 3);
    b.localSet(cur);
    b.u8(w.BR);
    b.lebU(0);
    b.u8(w.END);
    b.u8(w.END);
    b.localGet(cur);
    b.refCast(5, true);
    b.localGet(fresh);
    b.refCast(5, true);
    b.structSet(3);
    emitDispatch(em, rf, v, copy); // k = the closure's own k param
  }
  em.funcs.push(rf);
}

function emitStmtSeq(em: Emit, stmts: ExprID[], f: Fn, sc: Scope, tail: boolean, ctx: Ctx): void {
  const b = f.body;
  if (stmts.length === 0) {
    const v = f.anyref();
    f.pushRef(em.lay.unitRef);
    b.localSet(v);
    emitDispatch(em, f, v, ctx.kL);
    return;
  }
  for (let k = 0; k < stmts.length; k++) {
    const r = expr(em, stmts[k], f, sc, tail && k === stmts.length - 1, ctx);
    if (k === stmts.length - 1) {
      f.pushRef(r);
      const v = f.anyref();
      b.localSet(v);
      emitDispatch(em, f, v, ctx.kL);
    }
  }
}

// Emit a lambda/case body, catching the Split of a perform/handle site
// inside it and filling that site's rest-of-site fragment (see fillRest).
// Lambda and case bodies are split boundaries: the chain never crosses a
// lambda call, so each body's catcher owns its sites' fragments.
function bodyCatch(em: Emit, bodyId: ExprID, f: Fn, sc: Scope, tail: boolean, ctx: Ctx): void {
  const savedCut = em.sp.cutStack;
  const bodyE = em.nodes[bodyId];
  const stmts = bodyE.t === "block" ? bodyE.stmts : [bodyId];
  const bsc = em.d.scopes.get(bodyId) ?? sc;
  em.sp.bodyRoots.push({stmts, sc: bsc, tail, savedCut: [...savedCut]});
  try {
    try {
      emitStmtSeq(em, stmts, f, bsc, tail, ctx);
    } catch (sp) {
      em.sp.cutStack = savedCut;
      if (!(sp instanceof Split)) throw sp;
      fillRest(em, sp, stmts, bsc, tail);
      return;
    }
    em.sp.cutStack = savedCut;
  } finally {
    em.sp.bodyRoots.pop();
  }
}

// Fill a split's rest-of-site fragment (T_III_I: frame, v, kNext) by
// re-emitting from the body root along the split's chain: statements
// before the cut already executed (skipped; surviving values reload from
// spill slots), the cut site continues the fragment with its value being
// the v param, statements after it re-emit inline. A further split during
// re-emission chains another fragment off this one's split site.
function fillRest(em: Emit, sp: Split, root: ExprID[], sc: Scope, tail: boolean): void {
  const gf = sp.restFn;
  if (DBGEMIT) console.error("FILL_REST fn=", gf.idx, "root=", root.length, "chain=", sp.chain.length, "types=", "[" + sp.chain.map((x) => em.nodes[x]?.t).join(",") + "]", "tail=", tail);
  // A shared after-rest fragment (e.g. a handle's) may be routed here
  // again by a later re-emission of the same site; its content is already
  // correct, so re-filling would only append a duplicate tail.
  if (em.sp.filledRests.has(gf)) return;
  em.sp.filledRests.add(gf);
  // Publish this fill's root/sc/tail/cutStack-base: a land site discovered
  // inside the re-emission below sync-fills against THESE (see Splits.restRoot
  // and emitCallClosure) — the bodyRoots top is wrong for synthetic arm
  // re-emissions, whose root is the arm subtree.
  const prevRoot = em.sp.restRoot;
  em.sp.restRoot = {stmts: root, sc, tail, cutBase: [...em.sp.cutStack]};
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
  b.localGet(2);
  b.u8(0xd1); // ref.is_null: k = null → nothing froze a snapshot
  b.u8(w.IF);
  b.u8(0x40);
  b.localGet(0); // live frame: snapSlot reads hit the frame param
  b.localSet(snap);
  b.u8(w.ELSE);
  b.localGet(2);
  b.refCast(5, true);
  b.structGet(5, 0);
  b.i31Get();
  b.i32Const(w.K_SPILL);
  b.u8(w.EQ);
  b.u8(w.IF);
  b.u8(0x40);
  b.localGet(2);
  b.refCast(5, true);
  b.structGet(5, 1); // a = the frozen $FRAME snapshot
  b.localSet(snap);
  b.localGet(2);
  b.refCast(5, true);
  b.structGet(5, 3);
  b.localSet(2);
  b.u8(w.END);
  b.u8(w.END);
  const ci = root.indexOf(sp.chain[0]);
  if (ci < 0) throw new WasmError("internal: split chain root mismatch");
  const savedCut = em.sp.cutStack;
  try {
    for (let k = 0; k < root.length; k++) {
      if (k < ci) continue; // executed before the split
      const r = (k === ci)
        ? expr(em, sp.chain[0], gf, sc, tail && k === root.length - 1, {kL: 2, cut: sp.chain.slice(1), snap})
        : expr(em, root[k], gf, sc, tail && k === root.length - 1, {kL: 2, snap});
      if (k === root.length - 1) {
        gf.pushRef(r);
        const v = gf.anyref();
        gf.body.localSet(v);
        emitDispatch(em, gf, v, 2); // kNext param
      }
    }
  } catch (sp2) {
    em.sp.cutStack = savedCut;
    if (!(sp2 instanceof Split)) throw sp2;
    // The re-emitted code ended at another split site: this fragment is
    // complete (it ends at that site's host boundary / case invocation);
    // the rest after it chains into the new site's fragment.
    if (DBGEMIT) console.error("  NESTED_SPLIT in fn=", gf.idx, "-> chain=", "[" + sp2.chain.map((x) => em.nodes[x]?.t).join(",") + "]");
    em.sp.restRoot = prevRoot;
    fillRest(em, sp2, root, sc, tail);
    return;
  }
  em.sp.cutStack = savedCut;
  em.sp.restRoot = prevRoot;
}

// Fragment re-emission of a statement sequence from a cut statement:
// statements before index ci already executed (skipped — surviving values
// reload from spill slots), stmts[ci] continues the fragment with its
// value being the fragment's v param, statements after it re-emit inline.
// Returns the last statement's ref; pushRef it where the caller needs the
// legacy stack operand (handle/while-cut do, block-cut returns it).
function emitStmtsFrom(em: Emit, stmts: ExprID[], f: Fn, s: Scope, ctx: Ctx, ci: number, cut: ExprID[], tail: boolean): ValueRef {
  let r: ValueRef = em.lay.unitRef;
  for (let k = ci; k < stmts.length; k++) {
    r = (k === ci)
      ? expr(em, stmts[k], f, s, tail && k === stmts.length - 1, {kL: ctx.kL, cut: cut.slice(1)})
      : expr(em, stmts[k], f, s, tail && k === stmts.length - 1, {kL: ctx.kL});
  }
  return r;
}

function emitHelpers(em: Emit): Fn[] {
  // $truthy(v: anyref) -> i32: JS truthiness — 0 only for unit (ref.null
  // any) and the bool i31 0 (matches `c !== false && c !== null`); every
  // $NUM (including 0.0), $STR, $ARR and $CLO is truthy.
  const truthy = new Fn(1, em);
  truthy.typeIdx = w.T_TRUTHY;
  em.ix.funcRefTypes.set(em.ix.fTruthy, w.T_TRUTHY);
  {
    const b = truthy.body;
    b.localGet(0);
    b.u8(0xd1); // ref.is_null
    b.u8(w.IF);
    b.u8(0x7f);
    b.i32Const(0);
    b.u8(w.ELSE);
    b.localGet(0);
    b.refTest(w.I31REF, true); // ref.test (ref null i31)
    b.u8(w.IF);
    b.u8(0x7f);
    b.localGet(0);
    b.refCast(w.I31REF, false);
    b.i31Get(); // i31.get_u
    b.u8(w.ELSE);
    b.i32Const(1);
    b.u8(w.END);
    b.u8(w.END);
  }
  // $eq(a: anyref, b: anyref) -> anyref bool: JS === — nums by f64
  // payload, bools by i31 payload, strings by i16 content, arrays/
  // tuples/closures by identity (ref.cast (ref null eq) + ref.eq;
  // identity survives `set` growth because growth repoints the wrapper's
  // backing, not the wrapper), unit (null) equal only to unit.
  const eq = new Fn(2, em);
  eq.typeIdx = w.T_EQ;
  em.ix.funcRefTypes.set(em.ix.fEq, w.T_EQ);
  {
    const b = eq.body;
    const res = eq.i32();
    // decided: a typed path (or the null mismatch) already answered.
    const decided = eq.i32();
    b.i32Const(0);
    b.localSet(decided);
    // null ladder: equal nulls → true, one null → false.
    b.localGet(0);
    b.u8(0xd1);
    b.localGet(1);
    b.u8(0xd1);
    b.u8(w.EQ);
    b.u8(w.IF);
    b.u8(0x7f);
    b.localGet(0);
    b.u8(0xd1);
    b.u8(w.ELSE);
    b.i32Const(0);
    b.u8(w.END);
    b.localSet(res);
    // one null, one not: the ladder answered (false).
    b.localGet(0);
    b.u8(0xd1);
    b.localGet(1);
    b.u8(0xd1);
    b.u8(w.EQ);
    b.u8(w.EQZ);
    b.localSet(decided);
    // bool == bool: i31 payloads.
    b.localGet(0);
    b.refTest(w.I31REF, true);
    b.localGet(1);
    b.refTest(w.I31REF, true);
    b.u8(w.AND);
    b.u8(w.IF);
    b.u8(0x40);
    b.localGet(0);
    b.refCast(w.I31REF, false);
    b.i31Get();
    b.localGet(1);
    b.refCast(w.I31REF, false);
    b.i31Get();
    b.u8(w.EQ);
    b.localSet(res);
    // decided: the bool path answered.
    b.localGet(0);
    b.refTest(w.I31REF, true);
    b.localGet(1);
    b.refTest(w.I31REF, true);
    b.u8(w.AND);
    b.localGet(decided);
    b.u8(w.OR); // i32.or
    b.localSet(decided);
    b.u8(w.END);
    // num == num: f64 payloads.
    b.localGet(0);
    b.refTest(0, true);
    b.localGet(1);
    b.refTest(0, true);
    b.u8(w.AND);
    b.u8(w.IF);
    b.u8(0x40);
    b.localGet(0);
    b.refCast(0, true);
    b.structGet(0, 0);
    b.localGet(1);
    b.refCast(0, true);
    b.structGet(0, 0);
    b.u8(w.FEQ);
    b.localSet(res);
    // decided: the num path answered.
    b.localGet(0);
    b.refTest(0, true);
    b.localGet(1);
    b.refTest(0, true);
    b.u8(w.AND);
    b.localGet(decided);
    b.u8(w.OR); // i32.or
    b.localSet(decided);
    b.u8(w.END);
    // str == str: i16 content.
    b.localGet(0);
    b.refTest(2, true);
    b.localGet(1);
    b.refTest(2, true);
    b.u8(w.AND);
    b.u8(w.IF);
    b.u8(0x40);
    const la = eq.i32(), lb = eq.i32();
    b.localGet(0);
    b.refCast(2, true);
    b.arrayLen();
    b.localSet(la);
    b.localGet(1);
    b.refCast(2, true);
    b.arrayLen();
    b.localSet(lb);
    b.localGet(la);
    b.localGet(lb);
    b.u8(w.EQ);
    b.localSet(res);
    eq.loop(() => {
      b.localGet(la);
    }, i => {
      b.localGet(res);
      b.localGet(0);
      b.refCast(2, true);
      b.localGet(i);
      b.arrayGet(2);
      b.localGet(1);
      b.refCast(2, true);
      b.localGet(i);
      b.arrayGet(2);
      b.u8(w.EQ);
      b.u8(w.AND);
      b.localSet(res);
    });
    b.u8(w.END);
    // Mixed/same-shape-arr/clo → identity (both operands cast through
    // (ref null eq); a nullable cast accepts null but the null ladder
    // already left). Only runs when no typed path answered.
    b.localGet(decided);
    b.u8(w.EQZ);
    b.u8(w.IF);
    b.u8(0x40);
    b.localGet(0);
    b.refCast(w.EQREF, true);
    b.localGet(1);
    b.refCast(w.EQREF, true);
    b.refEq();
    b.localSet(res);
    b.u8(w.END);
    b.localGet(res);
    b.refI31();
  }
  // $box(x: f64) -> anyref: number struct.
  const box = new Fn(1, em);
  box.typeIdx = w.T_BOX;
  em.ix.funcRefTypes.set(em.ix.fBox, w.T_BOX);
  box.body.localGet(0);
  box.body.structNew(0);
  // $captureSlice(k: (ref null $K), until: (ref null $K)) -> (ref null $K):
  // fresh copies of the cells from k up to (excluding) until, each
  // {kind, a, b} verbatim; the bottom copy chains to `until`. Two passes:
  // count (n ≥ 1: the slice always starts at a RET cell), then allocate
  // n cells into a temp $ELEMS and link them (a $K cell is singly linked
  // forward, so the copies are chained bottom-up out of the temp array).
  const capture = new Fn(2, em);
  capture.typeIdx = w.T_CAPTURE;
  em.ix.funcRefTypes.set(em.ix.fCapture, w.T_CAPTURE);
  {
    const b = capture.body;
    const n = capture.i32(), cur = capture.anyref(), tmp = capture.anyref();
    const i = capture.i32(), src = capture.anyref(), cell = capture.anyref();
    b.i32Const(0);
    b.localSet(n);
    b.localGet(0);
    b.localSet(cur);
    b.u8(w.BLOCK);
    b.u8(0x40);
    b.u8(w.LOOP);
    b.u8(0x40);
    b.localGet(cur);
    b.refCast(5, true);
    b.localGet(1);
    b.refEq();
    b.u8(w.BR_IF);
    b.lebU(1);
    b.localGet(n);
    b.i32Const(1);
    b.u8(w.ADD);
    b.localSet(n);
    b.localGet(cur);
    b.refCast(5, true);
    b.structGet(5, 3);
    b.localSet(cur);
    b.u8(w.BR);
    b.lebU(0);
    b.u8(w.END);
    b.u8(w.END);
    b.localGet(n);
    b.arrayNew(1);
    b.localSet(tmp);
    b.localGet(0);
    b.localSet(src);
    b.i32Const(0);
    b.localSet(i);
    b.u8(w.BLOCK);
    b.u8(0x40);
    b.u8(w.LOOP);
    b.u8(0x40);
    b.localGet(i);
    b.localGet(n);
    b.u8(w.GEU);
    b.u8(w.BR_IF);
    b.lebU(1);
    b.localGet(tmp);
    b.refCast(1, true);
    b.localGet(i);
    b.localGet(src);
    b.refCast(5, true);
    b.structGet(5, 0);
    b.localGet(src);
    b.refCast(5, true);
    b.structGet(5, 1);
    b.localGet(src);
    b.refCast(5, true);
    b.structGet(5, 2);
    b.refNull(5);
    b.structNew(5);
    b.arraySet();
    b.localGet(i);
    b.i32Const(1);
    b.u8(w.ADD);
    b.localSet(i);
    b.localGet(src);
    b.refCast(5, true);
    b.structGet(5, 3);
    b.localSet(src);
    b.u8(w.BR);
    b.lebU(0);
    b.u8(w.END);
    b.u8(w.END);
    b.i32Const(0);
    b.localSet(i);
    b.u8(w.BLOCK);
    b.u8(0x40);
    b.u8(w.LOOP);
    b.u8(0x40);
    b.localGet(i);
    b.localGet(n);
    b.u8(w.GEU);
    b.u8(w.BR_IF);
    b.lebU(1);
    b.localGet(tmp);
    b.refCast(1, true);
    b.localGet(i);
    b.arrayGet(1);
    b.refCast(5, true);
    b.localSet(cell); // the cell is read as a statement: Buf statements run
    // before pending ops, so a local.set must bind it before i++ mutates i
    // (an op-pushed read would re-read the incremented i at its consumer).
    b.localGet(i);
    b.i32Const(1);
    b.u8(w.ADD);
    b.localSet(i);
    b.localGet(cell);
    b.refCast(5, true); // the local is anyref; struct.set needs the exact $K type
    b.localGet(i);
    b.localGet(n);
    b.u8(w.GEU);
    b.u8(w.IF);
    b.u8(0x63);
    b.u8(5); // next = until (the bottom of the slice)
    b.localGet(1);
    b.u8(w.ELSE);
    b.localGet(tmp);
    b.refCast(1, true);
    b.localGet(i);
    b.arrayGet(1);
    b.refCast(5, true);
    b.u8(w.END);
    b.structSet(3);
    b.u8(w.BR);
    b.lebU(0);
    b.u8(w.END);
    b.u8(w.END);
    b.localGet(tmp);
    b.refCast(1, true);
    b.i32Const(0);
    b.arrayGet(1);
    b.refCast(5, true);
  }
  return [truthy, eq, box, capture];
}

// Returns the anyref value of `name` as a ValueRef: a frame slot for the
// current frame, a fresh local for parent frames (the frame walk balances
// its own stack), or a static global for placed closures.
function emitSym(em: Emit, f: Fn, sc: Scope, name: string): ValueRef {
  const b = f.body;
  const r = resolve(sc, name);
  if (r !== null) {
    if (r.d === 0) return {k: "slot", i: r.i};
    const v = f.anyref();
    b.localGet(0);
    for (let k = 0; k < r.d; k++) b.structGet(4, 0); // walk parent frames (typed field)
    b.structGet(4, 1);
    b.i32Const(r.i);
    b.arrayGet(1);
    b.localSet(v);
    return {k: "local", l: v};
  }
  const clo = em.lay.cloOffsets.get(name);
  if (clo !== undefined) return {k: "g", gi: clo};
  throw new WasmError(`Unbound symbol: ${name}`);
}

// `direct` (direct builtin call specialization): when set, the callee is
// a known builtin trampoline — skip the $CLO load (env = null, static
// fsize, funcref index known) and emit a direct call instead of reading
// the code index and dispatching through the table. The frame/k
// convention is identical in both modes.
function emitCallClosure(em: Emit, f: Fn, fc: number, argc: number, argEmit: (k: number, ffp: number) => void, tail = false, land = false, kL = 1, noSplit = false, landA?: number, direct?: {idx: number, fsize: number}): void {
  const b = f.body;
  const clob = f.anyref(), idx = f.i32(), cf = f.anyref(), fs = f.i32(),
    maxL = f.i32(), slots = f.anyref(), ffp = f.anyref();
  if (direct === undefined) {
    b.localGet(fc);
    b.localSet(clob);
    b.localGet(clob); b.refCast(6, true); b.structGet(6, 0); b.i31Get();
    b.localSet(idx);
    b.localGet(clob); b.refCast(6, true); b.structGet(6, 1);
    b.localSet(cf);
    b.localGet(clob); b.refCast(6, true); b.structGet(6, 2); b.i31Get();
    b.localSet(fs);
  } else {
    b.i32Const(direct.idx);
    b.localSet(idx);
    b.refNull(4); // env: builtins run over the call frame itself
    b.localSet(cf);
    b.i32Const(direct.fsize);
    b.localSet(fs);
  }
  // Slot count = max(fs, argc) — the slots array holds the params and the
  // body's lets (fs) or all the args, whichever is longer. (argc readers
  // use array.len instead of a stored argc field — valid only because the
  // sole argc reader is `list`, whose fsize is 0.)
  b.localGet(fs);
  b.i32Const(argc);
  b.localGet(fs);
  b.i32Const(argc);
  b.u8(w.GTU);
  b.u8(w.SELECT);
  b.localSet(maxL);
  b.localGet(maxL);
  b.arrayNew(1);
  b.localSet(slots);
  b.localGet(cf);
  b.refCast(4, true);
  b.localGet(slots);
  b.refCast(1, true);
  b.structNew(4); // {parent, slots}
  b.localSet(ffp);
  for (let k = 0; k < argc; k++) argEmit(k, ffp);
  b.localGet(ffp);
  b.refCast(4, true); // the call's frame param (ffp is an anyref local)
  let splitAt: Split | null = null;
  if (tail) { b.localGet(kL); b.refCast(5, true); } // tail call: pass the ambient continuation through
  else if (land) {
    if (noSplit) {
      // Land-style RET cell ending the caller's body: used inside
      // loop-entry thunks (map-like builtins), where the callback's result
      // lands in the per-iteration thunk `landA` instead of the generic
      // per-site dispatcher and the loop continues from there. The call is
      // a tail call: the callback's completion always tails into landA
      // (never returns here), and a terminal k=0 return must unwind past
      // the whole loop to the caller's own call site.
      b.localGet(f.retCell(landA!, () => b.localGet(kL))); // next = ambient k
      b.refCast(5, true);
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
      // Fragments are memoized by chain: the same site re-encountered during
      // a later fillRest of a sibling site has the same chain and the same
      // content, so it reuses the first fragment fn (whose fill may still be
      // in progress — fragments are pure code over their own frame/v/kNext
      // params, so sharing one fn across invocations, resumptions
      // included, aliases no state). Without the memo the re-emitted
      // sibling site would fill a fresh fragment from the same body root,
      // whose re-emission hits this site again — exponential blowup.
      const chain = [...em.sp.cutStack];
      const key = chain.join(",");
      let rest = em.sp.restByChain.get(key);
      if (rest === undefined) {
        rest = makeRestThunk(em, "handle:after-handle");
        em.sp.restByChain.set(key, rest);
      }
      const ksp = f.snapWrap(() => b.localGet(kL));
      b.localGet(f.retCell(rest.idx, () => b.localGet(ksp))); // next = K_SPILL{frozen frame, ambient k}
      b.refCast(5, true);
      if (DBGEMIT) console.error("THROW handle-split cutStack=", em.sp.cutStack.length);
      splitAt = new Split(rest, chain);
    }
  } else b.refNull(5); // k=0 (ref.null $K): the callee's dispatch returns its value inline
  if (direct === undefined) {
    b.localGet(idx);
    b.u8(tail || land ? w.RETURN_CALL_INDIRECT : w.CALL_INDIRECT); // noSplit land calls tail too (see above)
    b.lebU(w.T_KABI);
    b.lebU(0);
  } else {
    b.u8(tail || land ? w.RETURN_CALL : w.CALL); // direct: fn index is static, not a stack operand
    b.lebU(direct.idx);
  }
  if (splitAt !== null) {
    // Fill the rest-of-site fragment directly at the land call site.
    // Cut-stack baseline: the same value the enclosing catcher restored
    // before its fillRest call, so nested splits during the fill re-discover
    // clean chains from that fill's root. Inside a re-emission (restRoot
    // set) that root is the in-progress fill's — the bodyRoots top is wrong
    // for synthetic arm re-emissions, whose chain does not start at a
    // body-root statement.
    const active = em.sp.restRoot;
    const savedCut = em.sp.cutStack;
    try {
      if (active !== null) {
        em.sp.cutStack = [...active.cutBase];
        fillRest(em, splitAt, active.stmts, active.sc, active.tail);
      } else {
        const root = em.sp.bodyRoots[em.sp.bodyRoots.length - 1];
        em.sp.cutStack = [...root.savedCut];
        fillRest(em, splitAt, root.stmts, root.sc, root.tail);
      }
    } finally {
      em.sp.cutStack = savedCut;
    }
  }
}

// One rest-of-site fragment: a T_III_I function (frame, v, kNext) -> i32
// registered in the funcref table. Filled later by the body-level catcher
// that catches this site's Split (bodyCatch/emitMain/fillRest).
function makeRestThunk(em: Emit, role?: string): Fn {
  const f = new Fn(3, em);
  f.typeIdx = w.T_III_I;
  f.idx = em.ix.thunk0 + em.thunks.length;
  em.ix.funcRefTypes.set(f.idx, w.T_III_I);
  if (DBGEMIT && role !== undefined) console.error("THUNK", f.idx, role);
  em.thunks.push(f);
  return f;
}

function emitDispatch(em: Emit, f: Fn, v: number, k = 1): void {
  const b = f.body;
  const kind = () => { b.localGet(k); b.refCast(5, true); b.structGet(5, 0); b.i31Get(); };
  const i31of = () => { b.refCast(w.I31REF, false); b.i31Get(); }; // anyref → i32 (i31 payload)
  b.u8(w.BLOCK);
  b.u8(w.ANYREF); // block (result anyref)
  b.u8(w.LOOP);
  b.u8(0x40);
  b.localGet(k);
  b.u8(0xd1); // ref.is_null: final return → the value itself
  b.u8(w.IF);
  b.u8(0x40);
  b.localGet(v);
  b.u8(w.BR); b.lebU(2); // leave the block with v
  b.u8(w.END);
  kind(); b.i32Const(w.K_RET); b.u8(w.EQ);
  b.u8(w.IF);
  b.u8(0x40);
  b.localGet(k); b.refCast(5, true); b.structGet(5, 2); b.refCast(4, true);
  b.localGet(v);
  b.localGet(k); b.refCast(5, true); b.structGet(5, 3);
  b.localGet(k); b.refCast(5, true); b.structGet(5, 1); i31of();
  b.u8(w.RETURN_CALL_INDIRECT);
  b.lebU(w.T_III_I);
  b.lebU(0);
  b.u8(w.END);
  // K_HDL: scan the case table at k.a (a $ELEMS of flat [opid, fnIdx,
  // fsize, nparams] i31 quadruples; the Return case, opid -1, goes last).
  // A K_SPILL cell (a rest fragment's frozen-frame marker) is transparent:
  // it carries no handler — skip it and walk on. Only kind==K_HDL scans.
  // The scan is emitted only when the program contains a handle: K_HDL
  // cells enter a chain solely via handle emission, so a handle-free
  // program's scan is dead code — skipping it drops a nested scan loop
  // (plus ~30 instructions of table probing) from every dispatch site.
  if (em.d.hasHandle) {
    kind(); b.i32Const(w.K_HDL); b.u8(w.EQ);
    b.u8(w.IF);
    b.u8(0x40);
    const tbl = f.anyref(), nL = f.i32(), iL = f.i32(), found = f.i32(),
      fnIdx = f.i32(), nparams = f.i32(), ent = f.i32();
    b.localGet(k); b.refCast(5, true); b.structGet(5, 1); b.localSet(tbl);
    b.localGet(tbl); b.refCast(1, true); b.arrayLen(); b.i32Const(4); b.u8(w.DIVU); b.localSet(nL);
    b.i32Const(0); b.localSet(found);
    b.i32Const(0); b.localSet(iL);
    b.u8(w.BLOCK);
    b.u8(0x40);
    b.u8(w.LOOP);
    b.u8(0x40);
    b.localGet(iL); b.localGet(nL); b.u8(w.GEU); b.u8(w.BR_IF); b.lebU(1);
    b.localGet(iL); b.i32Const(4); b.u8(w.MUL); b.localSet(ent);
    b.localGet(tbl); b.refCast(1, true); b.localGet(ent); b.arrayGet(1); i31of();
    b.i32Const(-1); b.u8(w.EQ);
    b.u8(w.IF);
    b.u8(0x40);
    b.i32Const(1); b.localSet(found);
    b.localGet(tbl); b.refCast(1, true); b.localGet(ent); b.i32Const(1); b.u8(w.ADD); b.arrayGet(1); i31of(); b.localSet(fnIdx);
    b.localGet(tbl); b.refCast(1, true); b.localGet(ent); b.i32Const(3); b.u8(w.ADD); b.arrayGet(1); i31of(); b.localSet(nparams);
    b.u8(w.BR); b.lebU(2); // exit the scan block
    b.u8(w.END);
    b.localGet(iL); b.i32Const(1); b.u8(w.ADD); b.localSet(iL);
    b.u8(w.BR); b.lebU(0);
    b.u8(w.END);
    b.u8(w.END);
    b.localGet(found);
    b.u8(w.IF);
    b.u8(0x40);
    // Return case: store v into the hframe's Return param slot, then
    // tail-call the case body as (hframe, k.next); funcref index last.
    b.localGet(k); b.refCast(5, true); b.structGet(5, 2); b.refCast(4, true); b.structGet(4, 1);
    b.localGet(nparams); b.i32Const(1); b.u8(w.ADD);
    b.localGet(v);
    b.arraySet();
    b.localGet(k); b.refCast(5, true); b.structGet(5, 2); b.refCast(4, true);
    b.localGet(k); b.refCast(5, true); b.structGet(5, 3);
    b.localGet(fnIdx);
    b.u8(w.RETURN_CALL_INDIRECT);
    b.lebU(w.T_KABI);
    b.lebU(0);
    b.u8(w.END);
    b.u8(w.END); // kind==K_HDL guard
  }
  // No Return case (or a skipped K_SPILL): k = k.next and dispatch again.
  b.localGet(k); b.refCast(5, true); b.structGet(5, 3); b.localSet(k);
  b.u8(w.BR); b.lebU(0);
  b.u8(w.END); // loop
  b.u8(0x00); // unreachable: the loop exits only through the k==0 branch
  b.u8(w.END); // block
}

// Calls ef_fail(code, name, a, b); the import throws, so unreachable.
// `name` is a $STR static global index (field-access failures) or null.
function emitFail(em: Emit, f: Fn, code: number, nameG: number | null, pushA: () => void, pushB: () => void): void {
  const b = f.body;
  b.i32Const(code);
  if (nameG === null) b.refNull(w.ANYREF);
  else b.globalGet(nameG);
  pushA();
  pushB();
  b.u8(w.CALL);
  b.lebU(em.o.impIdx.get("ef_fail")!);
  b.u8(0x00); // unreachable
}

// true/false i31 selected by the i32 condition emitted by emitCond.
function selectBool(em: Emit, f: Fn, emitCond: () => void): void {
  const b = f.body;
  const t = f.i32();
  emitCond();
  b.localSet(t);
  f.pushRef(em.lay.trueRef);
  f.pushRef(em.lay.falseRef);
  b.localGet(t);
  b.typedSelect(); // typed select (result anyref)
}

// Persist a ref into the operand spill slot computeSpills allocated for
// `id` (if any) and return the slot ref: a value that must survive a
// later split is read back from the frame by the fragment machinery.
function keepRef(em: Emit, id: ExprID, f: Fn, r: ValueRef): ValueRef {
  const sp = em.ix.operandSpill.get(id);
  if (sp === undefined) return r;
  const b = f.body;
  f.pushRef(r);
  const t = f.anyref();
  b.localSet(t);
  b.localGet(0); b.structGet(4, 1); b.i32Const(sp); b.localGet(t); b.arraySet();
  return {k: "slot", i: sp};
}

function preCut(em: Emit, id: ExprID, f: Fn, s: Scope, ctx: Ctx): ValueRef {
  const sp = em.ix.operandSpill.get(id) ?? em.ix.valSpill.get(id);
  if (sp !== undefined) {
    if (ctx.snap !== undefined) return {k: "snapSlot", snap: ctx.snap, i: sp};
    return {k: "slot", i: sp};
  }
  return expr(em, id, f, s, false, {kL: ctx.kL, snap: ctx.snap});
}

// Inline operator computation (§OPERATOR_OPS): the operands' refs are
// computed and spilled first (same discipline as `/`), then the operator
// computation runs on the caller's operand stack — no call, no frame.
// Mirrors each operator's $-trampoline body in emitBuiltins (same dynamic
// dispatch: `+` falls back to string concat then null). Leaves the boxed
// result on the stack; the wrapper dispatches it (never return_call $box:
// a raw tail return would bypass the caller's RET cell).
function emitOperatorInline(em: Emit, f: Fn, name: string, e: Expr & {t: "app"}, s: Scope, ctx: Ctx, ci: number): void {
  const b = f.body;
  // Operand cut modes, mirroring the `/` path: the arg holding the cut
  // site continues the fragment ("cut"), an earlier sibling reloads its
  // spill ("pre"), a later sibling re-emits fresh ("post").
  const argMode = (i: number): "cut" | "pre" | "post" =>
    ci === i + 1 ? "cut" : i === 0 && ci > 1 ? "pre" : "post";
  const pushArg = (i: number): void => {
    f.pushRef(cutChildRef(em, e.args[i], f, s, ctx, argMode(i)));
  };
  switch (name) {
    case "+": {
      const a = f.anyref(), bv = f.anyref();
      pushArg(0); b.localSet(a);
      pushArg(1); b.localSet(bv);
      b.localGet(a); b.refTest(0, false); b.localGet(bv); b.refTest(0, false);
      b.u8(w.AND); b.u8(w.IF); b.u8(w.ANYREF);
      b.localGet(a); b.refCast(0, false); b.structGet(0, 0);
      b.localGet(bv); b.refCast(0, false); b.structGet(0, 0);
      b.u8(w.FADD);
      b.u8(w.CALL); b.lebU(em.ix.fBox);
      b.u8(w.ELSE);
      b.localGet(a); b.refTest(2, false); b.localGet(bv); b.refTest(2, false); b.u8(w.AND);
      b.u8(w.IF); b.u8(w.ANYREF);
      f.emitStrCat(a, bv);
      b.u8(w.ELSE); b.refNull(w.ANYREF); b.u8(w.END); b.u8(w.END);
      break;
    }
    case "-": case "*": case "%": {
      const x = f.f64(), y = f.f64();
      pushArg(0); b.refCast(0, false); b.structGet(0, 0); b.localSet(x);
      pushArg(1); b.refCast(0, false); b.structGet(0, 0); b.localSet(y);
      if (name === "%") {
        // JS fmod: a - b * trunc(a/b)
        const t = f.f64();
        b.localGet(x); b.localGet(y); b.u8(w.FDIV); b.u8(w.FTRUNC); b.localSet(t);
        b.localGet(x); b.localGet(y); b.localGet(t); b.u8(w.FMUL); b.u8(w.FSUB);
      } else {
        b.localGet(x); b.localGet(y); b.u8(name === "-" ? w.FSUB : w.FMUL);
      }
      b.u8(w.CALL); b.lebU(em.ix.fBox);
      break;
    }
    case "neg": {
      pushArg(0); b.refCast(0, false); b.structGet(0, 0);
      b.u8(w.FNEG);
      b.u8(w.CALL); b.lebU(em.ix.fBox);
      break;
    }
    case "<": case ">": case "<=": case ">=": {
      const x = f.anyref(), y = f.anyref();
      pushArg(0); b.localSet(x);
      pushArg(1); b.localSet(y);
      const cmp = name === "<" ? w.FLT : name === ">" ? w.FGT : name === "<=" ? w.FLE : w.FGE;
      selectBool(em, f, () => {
        b.localGet(x); b.refCast(0, false); b.structGet(0, 0);
        b.localGet(y); b.refCast(0, false); b.structGet(0, 0);
        b.u8(cmp);
      });
      break;
    }
    case "==": {
      pushArg(0); pushArg(1);
      b.u8(w.CALL); b.lebU(em.ix.fEq);
      break;
    }
    case "!=": {
      pushArg(0); pushArg(1);
      b.u8(w.CALL); b.lebU(em.ix.fEq);
      b.refCast(w.I31REF, false); // eq result's i31 bool payload
      b.i31Get();
      b.u8(w.EQZ); // 1 when $eq said false
      selectBool(em, f, () => {});
      break;
    }
    case "not": {
      pushArg(0);
      b.u8(w.CALL); b.lebU(em.ix.fTruthy);
      b.u8(w.EQZ);
      selectBool(em, f, () => {});
      break;
    }
    default:
      throw new WasmError(`internal: no inline emitter for operator ${name}`);
  }
}

// One child of a cut node, ref-native — also used for fresh emission
// (mode "post"), so fresh and cut bodies can share one shape.
// "cut": the child holding the deeper split site — continues the fragment
// chain (its value is the fragment's v param). "pre": a sibling evaluated
// BEFORE the cut child — a slot ref into its spill, or re-emit pure code
// inline (preCut). "post": a sibling evaluated AFTER the cut child (or no
// cut at all) — re-emit inline, with the caller's tail flag. Persists any
// mapped operand spill slot.
function cutChildRef(em: Emit, child: ExprID, f: Fn, s: Scope, ctx: Ctx, mode: "cut" | "pre" | "post", tail = false): ValueRef {
  if (mode === "cut") return keepRef(em, child, f, expr(em, child, f, s, false, {kL: ctx.kL, cut: ctx.cut!.slice(1), snap: ctx.snap}));
  if (mode === "pre") return keepRef(em, child, f, preCut(em, child, f, s, ctx));
  return keepRef(em, child, f, expr(em, child, f, s, tail, {kL: ctx.kL, snap: ctx.snap}));
}

// The split site is this node itself inside a fragment: its value is the
// fragment's v param (local 1), persisted for later fragments that reload it.
function fragV(em: Emit, id: ExprID, f: Fn): ValueRef {
  return keepRef(em, id, f, {k: "local", l: 1});
}

function expr(em: Emit, id: ExprID, f: Fn, sc?: Scope, tail = false, ctx: Ctx = INLINE): ValueRef {
  const e = em.nodes[id];
  // Lambda/block nodes carry their own scope; other nodes inherit sc.
  const s = em.d.scopes.get(id) ?? sc;
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
  const pushed = em.sp.cutStack[em.sp.cutStack.length - 1] !== id;
  if (pushed) em.sp.cutStack.push(id);
  // try/finally: a child's Split (or error) unwinds through this frame —
  // the push must not survive, or the next Split captures a stale chain
  // whose head re-routes fillRest through the same (already handled)
  // site forever.
  try {
  switch (e.t) {
    case "num":
      return {k: "g", gi: em.lay.numStatics.get(e.v)!};
    case "str":
      return {k: "g", gi: em.lay.strStatics.get(e.v)!};
    case "bool":
      return {k: "bool", v: e.v ? 1 : 0};
    case "unit":
      return em.lay.unitRef;
    case "sym":
      return emitSym(em, f, s, e.v);
    case "lambda": {
      // immutable $CLO {fnIdx, env = current frame, fsize}
      const clo = f.anyref();
      b.i32Const(em.ix.lambdaIdx.get(id)!);
      b.refI31();
      b.localGet(0); // captured frame = the frame param
      b.i32Const(frameSizeOf(em.ix, em.d.scopes.get(id)!)); // params + body lets + perform spills
      b.refI31();
      b.structNew(6);
      b.localSet(clo);
      return {k: "local", l: clo};
    }
    case "let": {
      // Binds in the current frame (mirrors the interpreter: the binding
      // exists before the value is computed, so `let x = x` sees null —
      // a null slot read normalizes to unit inside the module).
      const slot = s.map.get(e.name)!;
      const vr = expr(em, e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1), snap: ctx.snap});
      b.localGet(0); b.structGet(4, 1);
      b.i32Const(slot);
      f.pushRef(vr);
      b.arraySet();
      return em.lay.unitRef;
    }
    case "dlet": {
      const blk = f.anyref();
      const vr = expr(em, e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1), snap: ctx.snap});
      f.pushRef(vr);
      b.refCast(3, true);
      b.structGet(3, 0);
      b.localSet(blk);
      for (let k = 0; k < e.fields.length; k++) {
        const slot = s.map.get(e.fields[k].name)!;
        // tuple element k → frame slot (balances its stack in place)
        b.localGet(0); b.structGet(4, 1);
        b.i32Const(slot);
        b.localGet(blk);
        b.refCast(1, true);
        b.i32Const(k);
        b.arrayGet(1);
        b.arraySet();
      }
      return em.lay.unitRef;
    }
    case "assign": {
      const r = resolve(s, e.name);
      if (r === null) throw new WasmError(`Assignment to unbound symbol: ${e.name}`);
      const vr = expr(em, e.val, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1), snap: ctx.snap});
      b.localGet(0);
      for (let k = 0; k < r.d; k++) b.structGet(4, 0);
      b.structGet(4, 1);
      b.i32Const(r.i);
      f.pushRef(vr);
      b.arraySet();
      return em.lay.unitRef;
    }
    case "if": {
      if (cut !== undefined && cut.length === 0) {
        // The split site itself inside a fragment: a split-mode if's
        // value arrives via the after-if fragment's v param.
        return fragV(em, id, f);
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
        ? (ci !== 0 || splits(em.prog, em.d, e.a) || splits(em.prog, em.d, e.b))
        : (splits(em.prog, em.d, e.a) || splits(em.prog, em.d, e.b))) {
        emitIfDispatch(em, id, e, f, s, ctx, ci);
        return em.lay.unitRef; // unreachable: the dispatch-shape if throws Split
      }
      // Value shape — shared by fresh emission (ci undefined) and
      // fragment re-emission (no arm can split): condition and both arms
      // are value-explicit; each arm's ref is pushed as the IF block's
      // result value. Fragment re-emission never tail-calls the arms.
      const at = ci === undefined && tail;
      f.pushRef(cutChildRef(em, e.c, f, s, ctx, ci === undefined ? "post" : ci === 0 ? "cut" : "pre"));
      b.u8(w.CALL);
      b.lebU(em.ix.fTruthy);
      b.u8(w.IF);
      b.u8(0x6e); // result anyref
      f.pushRef(cutChildRef(em, e.a, f, s, ctx, ci === undefined ? "post" : ci === 1 ? "cut" : ci === 2 ? "pre" : "post", at));
      b.u8(w.ELSE);
      f.pushRef(cutChildRef(em, e.b, f, s, ctx, ci === undefined ? "post" : ci === 2 ? "cut" : "post", at));
      b.u8(w.END);
      const v = f.anyref();
      b.localSet(v);
      return keepRef(em, id, f, {k: "local", l: v});
    }
    case "while": {
      if (cut !== undefined && cut.length === 0) {
        // The loop exited: its unit value is the fragment's v param.
        return fragV(em, id, f);
      }
      if (splits(em.prog, em.d, e.c) || splits(em.prog, em.d, e.body)) {
        emitWhileCPS(em, id, e, f, s, ctx, cut);
        return em.lay.unitRef; // unreachable: the split-mode while throws Split
      }
      if (cut !== undefined) throw new WasmError("internal: split crossing a while");
      b.u8(w.BLOCK);
      b.u8(0x40);
      b.u8(w.LOOP);
      b.u8(0x40);
      f.pushRef(expr(em, e.c, f, s, false, ctx));
      b.u8(w.CALL);
      b.lebU(em.ix.fTruthy);
      b.u8(w.EQZ);
      b.u8(w.BR_IF);
      b.lebU(1);
      expr(em, e.body, f, s, false, ctx); // body value dropped: nothing on the stack
      b.u8(w.BR);
      b.lebU(0);
      b.u8(w.END);
      b.u8(w.END);
      return em.lay.unitRef;
    }
    case "block": {
      if (cut === undefined) {
        let last: ValueRef = em.lay.unitRef;
        for (let k = 0; k < e.stmts.length; k++) {
          // Dropped statements leave nothing on the stack.
          last = expr(em, e.stmts[k], f, s, tail && k === e.stmts.length - 1, ctx);
        }
        return last;
      }
      // Cut path through the block: statements before the cut site already
      // executed (skipped), the cut statement continues the fragment with
      // its value from the fragment's v param, the rest re-emits inline.
      const ci = e.stmts.indexOf(cut[0]);
      if (ci < 0) throw new WasmError("internal: split chain root mismatch");
      return emitStmtsFrom(em, e.stmts, f, s, ctx, ci, cut, tail);
    }
    case "arr": {
      const blk = f.anyref();
      b.i32Const(e.elems.length);
      b.arrayNew(1);
      b.localSet(blk);
      const ci = cut === undefined ? -1 : e.elems.indexOf(cut[0]);
      if (cut !== undefined && ci < 0) throw new WasmError("internal: split chain root mismatch");
      for (let k = 0; k < e.elems.length; k++) {
        // Value-explicit element order: the child's ref is computed BEFORE
        // the destination address is pushed, so a split inside the child
        // aborts on a clean operand stack (same ordering as the app
        // case's args).
        // Elements after the cut child have NOT run yet: they re-emit
        // inline ("post"), never reload a never-written spill slot ("pre").
        const r = cutChildRef(em, e.elems[k], f, s, ctx,
          cut === undefined ? "post" : k === ci ? "cut" : k < ci ? "pre" : "post");
        b.localGet(blk);
        b.refCast(1, true);
        b.i32Const(k);
        f.pushRef(r);
        b.arraySet();
      }
      b.localGet(blk);
      b.refCast(1, true);
      b.structNew(3); // $ARR wrapper
      const v = f.anyref();
      b.localSet(v);
      return {k: "local", l: v};
    }
    case "field": {
      const blk = f.anyref();
      f.pushRef(expr(em, e.obj, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1)}));
      b.refCast(3, true);
      b.structGet(3, 0);
      b.localSet(blk);
      // len <= idx → out of bounds
      b.localGet(blk);
      b.refCast(1, true);
      b.arrayLen();
      b.i32Const(e.idx!);
      b.u8(w.LEU);
      b.u8(w.IF);
      b.u8(0x40);
      emitFail(em, 
        f, 2, em.lay.strStatics.get(e.name)!,
        f.constF64(e.idx!),
        f.constF64(-1),
      );
      b.u8(w.END);
      b.localGet(blk);
      b.refCast(1, true);
      b.i32Const(e.idx!);
      b.arrayGet(1);
      const v = f.anyref();
      b.localSet(v);
      return {k: "local", l: v};
    }
    case "perform":
      if (cut !== undefined && cut.length === 0) {
        // The split site itself inside a fragment: its value is the
        // fragment's v param (the value the case body or host resumed
        // with).
        return fragV(em, id, f);
      }
      emitPerform(em, id, e, f, s, ctx);
      return em.lay.unitRef; // unreachable: perform always ends at its split site
    case "handle":
      if (cut !== undefined && cut.length === 0) {
        // The split site itself inside a fragment: its value is the
        // handle's value delivered by the after-handle fragment chain.
        return fragV(em, id, f);
      }
      if (cut !== undefined) {
        // A perform inside the body split: emit the body's remainder with
        // the fragment's ambient continuation (kNext) — the perform-site
        // RET cell carries it: the handler cell the walk started from in
        // the original flow, or the fresh §4.6 chain (whose copied HDLs
        // keep every enclosing handler live around the resumed segment)
        // when the fragment runs from a resume closure.
        const bodyE = em.nodes[e.body];
        const stmts = bodyE.t === "block" ? bodyE.stmts : [e.body];
        const bsc = em.d.scopes.get(e.body) ?? s;
        const ci = stmts.indexOf(cut[0]);
        if (ci < 0) throw new WasmError("internal: split chain root mismatch");
        f.pushRef(emitStmtsFrom(em, stmts, f, bsc, ctx, ci, cut, false));
        const v = f.anyref();
        b.localSet(v);
        emitDispatch(em, f, v, ctx.kL);
        // The dispatch tail-calls away (every table carries a Return
        // entry); the after-handle rest chains from the split site.
        throw new Split(em.sp.hdlRest.get(id)!, [...em.sp.cutStack]);
      }
      emitHandle(em, id, e, f, s, ctx);
      return em.lay.unitRef; // unreachable: the body's dispatch tail-calls away
    case "app": {
      if (cut !== undefined && cut.length === 0) {
        // The split site itself inside a fragment: the call's result is
        // the fragment's v param (the caller's body ended at the call's
        // return_call, §3 emitCall).
        return fragV(em, id, f);
      }
      // One shape for fresh emission and fragment re-emission: children
      // before the cut site reload (or, if pure, re-emit), the cut child
      // continues with the fragment's v param, children after re-emit
      // inline; fresh emission evaluates everything (mode "post").
      const kids = [e.fn, ...e.args];
      const ci = cut === undefined ? -1 : kids.indexOf(cut[0]);
      if (cut !== undefined && ci < 0) throw new WasmError("internal: split chain root mismatch");
      // Direct builtin reference: the callee sym resolves to no user
      // binding and names a builtin with a trampoline. Operators compile
      // inline (no call at all, like `/` below); other builtins call their
      // trampoline directly (no $CLO load, no table dispatch). `/` is
      // checker-stamped instead (e.div) and keeps its own inline path.
      const fne = em.nodes[e.fn];
      const bname = e.div === undefined && fne.t === "sym" &&
        resolve(s, fne.v) === null && BUILTINS.some(bb => bb.name === fne.v) ? fne.v : null;
      // Inline paths compute right here, so at a tail position the boxed
      // value must be DISPATCHED through the ambient continuation by the
      // enclosing wrapper (emitStmtSeq bridges + emitDispatch) — the value
      // must never return raw past the enclosing function, or a land
      // site's RET cell would be bypassed (the callee is "supposed" to
      // dispatch, but there is no callee).
      if (e.div !== undefined) {
        // `/` is stamped by the checker (int vs float truncation); the
        // fn is the `/` sym itself, so the cut site is always in an
        // operand (ci >= 1). Value-explicit operand order: both child
        // refs are computed (and spilled) before either is materialized,
        // so a split inside a child aborts on a clean operand stack.
        // A non-number operand traps at the ref.cast (frozen deviation —
        // the checker rejects non-num arithmetic statically).
        if (ci === 0) throw new WasmError("internal: split chain root mismatch");
        f.pushRef(cutChildRef(em, e.args[0], f, s, ctx, ci === 1 ? "cut" : ci < 0 ? "post" : "pre"));
        b.refCast(0, false);
        b.structGet(0, 0);
        f.pushRef(cutChildRef(em, e.args[1], f, s, ctx, ci === 2 ? "cut" : "post"));
        b.refCast(0, false);
        b.structGet(0, 0);
        b.u8(w.FDIV);
        if (e.div === "int") b.u8(w.FTRUNC);
        // Box inline (never return_call $box: at a tail position the raw
        // return would bypass the caller's RET cell — the wrapper's
        // dispatch must see the value).
        b.u8(w.CALL);
        b.lebU(em.ix.fBox);
      } else if (bname !== null && OPERATOR_OPS.has(bname)) {
        emitOperatorInline(em, f, bname, e, s, ctx, ci);
      } else if (bname !== null && em.ix.builtinFnIdx.has(bname)) {
        // Direct builtin call: static funcref index + fsize, env = null.
        const bi = BUILTINS.find(bb => bb.name === bname)!;
        emitCallClosure(em, f, 0, e.args.length, (k, ffp) => {
          const r = cutChildRef(em, e.args[k], f, s, ctx,
            k + 1 === ci ? "cut" : k + 1 < ci ? "pre" : "post");
          b.localGet(ffp); b.refCast(4, true); b.structGet(4, 1);
          b.i32Const(k);
          f.pushRef(r);
          b.arraySet();
        }, cut === undefined && tail,
        em.d.landCalls.has(id),
        ctx.kL,
        undefined,
        undefined,
        {idx: em.ix.builtinFnIdx.get(bname)!, fsize: bi.params + mapLikeFrameWords(bname)});
      } else {
        const fc = f.anyref();
        f.pushRef(cutChildRef(em, e.fn, f, s, ctx, ci === 0 ? "cut" : ci < 0 ? "post" : "pre"));
        b.localSet(fc);
        emitCallClosure(em, f, fc, e.args.length, (k, ffp) => {
          // Value-explicit arg order: the child's ref is computed (and
          // spilled) BEFORE the destination address is pushed, so a split
          // inside the child aborts on a clean operand stack (blocker (b)
          // by construction).
          const r = cutChildRef(em, e.args[k], f, s, ctx,
            k + 1 === ci ? "cut" : k + 1 < ci ? "pre" : "post");
          b.localGet(ffp); b.refCast(4, true); b.structGet(4, 1);
          b.i32Const(k);
          f.pushRef(r);
          b.arraySet();
        }, cut === undefined && tail,
        // Builtins never perform or capture, so they keep the k=0
        // trampoline convention; every other (lambda) call site lands
        // through a RET cell and is a split site (§3 emitCall).
        em.d.landCalls.has(id),
        ctx.kL);
      }
      // emitCallClosure leaves the landed result on the stack (or
      // tail-returns, making this capture unreachable); the inline paths
      // leave the computed value on the stack — at a tail position the
      // enclosing wrapper (emitStmtSeq / fillRest) dispatches it through
      // the ambient continuation, exactly like any non-call tail value.
      const v = f.anyref();
      b.localSet(v);
      return {k: "local", l: v};
    }
    default:
      // Unreachable: the switch covers every Expr variant, but a try/finally
      // wrapper defeats TS's exhaustiveness-based end-of-function check.
      throw new WasmError(`internal: no emitter for node ${id}`);
  }
  } finally {
    if (pushed) em.sp.cutStack.pop();
  }
}

function emitPerform(em: Emit, id: ExprID, e: Expr & {t: "perform"}, f: Fn, s: Scope, ctx: Ctx): void {
  const b = f.body;
  const blk = f.anyref(), cell = f.anyref();
  b.i32Const(e.args.length);
  b.arrayNew(1);
  b.localSet(blk);
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
      ? cutChildRef(em, e.args[k], f, s, ctx, "cut")
      : k < ci
        ? cutChildRef(em, e.args[k], f, s, ctx, "pre")
        : cutChildRef(em, e.args[k], f, s, ctx, "post");
    b.localGet(blk);
    b.refCast(1, true);
    b.i32Const(k);
    f.pushRef(r);
    b.arraySet();
  }
  b.localGet(blk);
  b.refCast(1, true);
  b.structNew(3); // $ARR wrapper
  b.localSet(cell);
  const spillSlot = em.ix.spillOf.get(id)!;
  b.localGet(0); b.structGet(4, 1);
  b.i32Const(spillSlot);
  b.localGet(cell);
  b.arraySet();
  // Handler walk: kL walks the k chain; the first K_HDL whose case table
  // (flat [opid, fnIdx, fsize, nparams]* i31s) contains opid wins. The
  // pre-walk ambient continuation (amb) is what the RET cell carries:
  // fragments re-dispatch through their kNext, so a resumed segment
  // follows the fresh §4.6 chain (copied HDLs + kCaller) instead of
  // skipping it.
  const opid = em.d.effOpIds.get(e.op)!;
  const restFn = makeRestThunk(em, "perform:rest op=" + e.op);
  const kL = f.anyref(), hdl = f.anyref(), found = f.i32();
  const tbl = f.anyref(), nL = f.i32(), ent = f.i32();
  const fnIdx = f.i32(), fsz = f.i32(), nparams = f.i32(), amb = f.anyref();
  const i31of = () => { b.refCast(w.I31REF, false); b.i31Get(); }; // anyref → i32 (i31 payload)
  b.localGet(ctx.kL); // the ambient continuation
  b.localSet(kL);
  b.localGet(ctx.kL);
  b.localSet(amb);
  b.i32Const(0);
  b.localSet(found);
  b.u8(w.BLOCK);
  b.u8(0x40);
  b.u8(w.LOOP);
  b.u8(0x40);
  b.localGet(kL);
  b.u8(0xd1); // ref.is_null: k=0 → no handler anywhere → host fallback
  b.u8(w.BR_IF);
  b.lebU(1);
  b.localGet(kL); b.refCast(5, true); b.structGet(5, 0); b.i31Get();
  b.i32Const(w.K_HDL);
  b.u8(w.EQ);
  b.u8(w.IF);
  b.u8(0x40);
  b.localGet(kL); b.refCast(5, true); b.structGet(5, 1);
  b.localSet(tbl);
  b.localGet(tbl); b.refCast(1, true); b.arrayLen(); b.i32Const(4); b.u8(w.DIVU);
  b.localSet(nL);
  f.loop(() => {
    b.localGet(nL);
  }, i => {
    b.localGet(i); b.i32Const(4); b.u8(w.MUL);
    b.localSet(ent);
    b.localGet(tbl); b.refCast(1, true); b.localGet(ent); b.arrayGet(1); i31of();
    b.i32Const(opid);
    b.u8(w.EQ);
    b.u8(w.IF);
    b.u8(0x40);
    b.i32Const(1);
    b.localSet(found);
    b.localGet(kL);
    b.localSet(hdl);
    b.localGet(tbl); b.refCast(1, true); b.localGet(ent); b.i32Const(1); b.u8(w.ADD); b.arrayGet(1); i31of();
    b.localSet(fnIdx);
    b.localGet(tbl); b.refCast(1, true); b.localGet(ent); b.i32Const(2); b.u8(w.ADD); b.arrayGet(1); i31of();
    b.localSet(fsz);
    b.localGet(tbl); b.refCast(1, true); b.localGet(ent); b.i32Const(3); b.u8(w.ADD); b.arrayGet(1); i31of();
    b.localSet(nparams);
    b.u8(w.BR);
    b.lebU(2); // exit the table scan
    b.u8(w.END);
  });
  b.localGet(found);
  b.u8(w.BR_IF);
  b.lebU(2); // matched handler → leave the walk
  b.u8(w.END);
  b.localGet(kL); b.refCast(5, true); b.structGet(5, 3);
  b.localSet(kL);
  b.u8(w.BR);
  b.lebU(0);
  b.u8(w.END);
  b.u8(w.END);
  // Freeze the frame image for this capture and chain the rest fragment
  // behind a K_SPILL cell carrying it: the fragment's pre-cut operand
  // reloads read the frozen values, so a multi-shot resume re-runs the
  // rest against the pre-perform state (the interpreter's CPS accs),
  // not the frame as mutated by earlier resumes / loop iterations.
  const ksp = f.snapWrap(() => {
    b.localGet(amb);
  });
  b.localGet(found);
  b.u8(w.IF);
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
  b.localGet(hdl); b.refCast(5, true); b.structGet(5, 2); b.refCast(4, true);
  b.localSet(hfsrc);
  b.localGet(hfsrc); b.refCast(4, true); b.structGet(4, 0); // parent (unchanged)
  b.localGet(fsz);
  b.arrayNew(1);
  b.localSet(hfs);
  f.loop(() => {
    b.localGet(fsz);
  }, i => {
    b.localGet(hfs);
    b.refCast(1, true);
    b.localGet(i);
    b.localGet(hfsrc); b.refCast(4, true); b.structGet(4, 1);
    b.localGet(i);
    b.arrayGet(1);
    b.arraySet();
  });
  b.localGet(hfs);
  b.refCast(1, true);
  b.structNew(4);
  b.localSet(hfc);
  // Push this perform's RET cell; the slice below is captured as if this
  // cell had been pushed before the walk (scan-first). Its next is the
  // K_SPILL cell (the rest fragment's prologue loads the snapshot and
  // skips the cell before dispatching, so K_SPILL stays invisible to
  // every other dispatch and to fCapture's slice walk).
  const ret = f.retCell(restFn.idx, () => {
    b.localGet(ksp); // next = K_SPILL{frozen frame image, pre-walk ambient}
  }); // b = the current frame (holds the spilled args cell)
  // Capture the slice above the handler into fresh cells (originals
  // untouched; the resume closure copies again on every call).
  const slice = f.anyref();
  b.localGet(ret);
  b.refCast(5, true);
  b.localGet(hdl);
  b.refCast(5, true);
  b.u8(w.CALL);
  b.lebU(em.ix.fCapture);
  b.localSet(slice);
  // The resume binder (§4.6): a $CLO over the shared resume fn and a
  // capture-record frame {slot 1 = the slice, slot 2 = the matched HDL
  // (the capture sentinel), slot 3 = this invocation's hframe copy}. The
  // resume fn copies the slice afresh per call (sentinel = slot 2) and
  // re-chains its bottom to a fresh HDL {slot 2's table, slot 3's frame,
  // next = the k the closure was invoked with}, so the resumed segment
  // runs against the caller's continuation and its Return lands in the
  // invocation's frame copy.
  const recs = f.anyref(), rec = f.anyref(), rclo = f.anyref();
  b.i32Const(4);
  b.arrayNew(1);
  b.localSet(recs);
  b.localGet(recs); b.refCast(1, true); b.i32Const(0); b.refNull(w.ANYREF); b.arraySet(); // slot 0 unused
  b.localGet(recs); b.refCast(1, true); b.i32Const(1); b.localGet(slice); b.arraySet(); // slot 1: the captured slice
  b.localGet(recs); b.refCast(1, true); b.i32Const(2); b.localGet(hdl); b.arraySet(); // slot 2: the matched HDL (sentinel)
  b.localGet(recs); b.refCast(1, true); b.i32Const(3); b.localGet(hfc); b.arraySet(); // slot 3: this invocation's hframe copy
  b.refNull(4); // parent = none
  b.localGet(recs);
  b.refCast(1, true);
  b.structNew(4);
  b.localSet(rec);
  b.i32Const(em.ix.resumeFn.idx);
  b.refI31();
  b.localGet(rec);
  b.refCast(4, true); // env = the resume record's $FRAME (rec is an anyref local)
  b.i32Const(1); // fsize (call frame size hint: slot 0 = the resumed value)
  b.refI31();
  b.structNew(6);
  b.localSet(rclo);
  // Case invocation over the handler's shared hframe copy (hdl.b): bind
  // the case params from the args cell, the resume binder to the boxed
  // resume closure, then tail-call the case body
  // with (hframe, hdl.next) — its continuation never contains this
  // handler (two-k rule).
  b.localGet(hfc); b.refCast(4, true); b.structGet(4, 1);
  f.loop(() => {
    b.localGet(nparams);
  }, i2 => {
    b.localGet(hfc); b.refCast(4, true); b.structGet(4, 1);
    b.localGet(i2);
    b.localGet(cell); b.refCast(3, true); b.structGet(3, 0);
    b.localGet(i2);
    b.arrayGet(1);
    b.arraySet();
  });
  b.localGet(hfc); b.refCast(4, true); b.structGet(4, 1);
  b.localGet(nparams);
  b.localGet(rclo);
  b.arraySet();
  b.localGet(hfc);
  b.refCast(4, true);
  b.localGet(hdl); b.refCast(5, true); b.structGet(5, 3);
  b.localGet(fnIdx);
  b.u8(w.RETURN_CALL_INDIRECT);
  b.lebU(w.T_KABI);
  b.lebU(0);
  b.u8(w.ELSE);
  // No matching handler: bare host call, then the rest-of-site fragment —
  // the SAME fragment the RET cell carries — continues with the resumed
  // value over this frame and the ambient continuation. The args cell is
  // reloaded from its spill slot, the pattern the fragment itself uses.
  const v = f.anyref();
  b.i32Const(opid);
  b.localGet(0); b.structGet(4, 1); b.i32Const(spillSlot); b.arrayGet(1);
  b.u8(w.CALL);
  b.lebU(em.o.impIdx.get("ef_perform")!);
  b.localSet(v);
  b.localGet(0); b.structGet(4, 1); b.i32Const(em.ix.valSpill.get(id)!);
  b.localGet(v);
  b.arraySet();
  b.localGet(0);
  b.localGet(v);
  b.localGet(ksp);
  b.refCast(5, true);
  b.i32Const(restFn.idx);
  b.u8(w.RETURN_CALL_INDIRECT);
  b.lebU(w.T_III_I);
  b.lebU(0);
  b.u8(w.END);
  b.u8(0x00); // unreachable: both arms end in a tail call
  // The inline body ends at the split site; the catcher fills restFn.
  if (DBGEMIT) console.error("THROW perform-split op=", e.op, "cut=", em.sp.cutStack.length, "[" + em.sp.cutStack.map((x) => em.nodes[x]?.t).join(",") + "]");
  throw new Split(restFn, [...em.sp.cutStack]);
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
function emitHandle(em: Emit, id: ExprID, e: Expr & {t: "handle"}, f: Fn, s: Scope, ctx: Ctx): void {
  const b = f.body;
  const info = em.d.hdlCases.get(id)!;
  const restFn = makeRestThunk(em, "handle:restFn");
  em.sp.hdlRest.set(id, restFn);
  const hf = f.anyref(), hdl = f.anyref();
  b.localGet(0); // parent = the frame at the handle site
  b.i32Const(frameSizeOf(em.ix, info.scope));
  b.arrayNew(1);
  b.structNew(4);
  b.localSet(hf);
  // K_SPILL cell freezing the pre-handle frame image: the after-handle
  // rest's pre-cut operand reloads (chain levels above the handle, e.g.
  // sibling operands of `s + handle {...}`) must see the values as of
  // the install, not as mutated by the handler body / resumes.
  const ksp = f.snapWrap(() => {
    b.localGet(ctx.kL);
  });
  // RET cell over the handle-site frame; next = the continuation outside
  // the handler (the two-k rule: the case body's ambient continuation is
  // the one captured OUTSIDE the handler).
  const ret = f.retCell(restFn.idx, () => {
    b.localGet(ksp);
  });
  b.i32Const(w.K_HDL);
  b.refI31();
  b.globalGet(em.lay.hdlTableOff.get(id)!); // a = the case table
  b.localGet(hf);
  b.localGet(ret); b.refCast(5, true);
  b.structNew(5);
  b.localSet(hdl);
  const sp = em.ix.valSpill.get(id);
  if (sp !== undefined) {
    b.localGet(0); b.structGet(4, 1);
    b.i32Const(sp);
    b.localGet(hdl);
    b.arraySet();
  }
  // Body with the handler cell as the ambient continuation: no tail calls
  // through the k param here — every value flows through the handler.
  const bodyE = em.nodes[e.body];
  const stmts = bodyE.t === "block" ? bodyE.stmts : [e.body];
  emitStmtSeq(em, stmts, f, em.d.scopes.get(e.body) ?? s, false, {kL: hdl});
  // The completion dispatch tail-calls the Return case (every table
  // carries one); control never returns here. The after-handle rest is
  // in restFn — the catcher that receives this Split fills it, re-emitting
  // this node as the chain's split site (its value = the fragment's v).
  throw new Split(restFn, [...em.sp.cutStack]);
}

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
function emitIfDispatch(em: Emit, id: ExprID, e: Expr & {t: "if"}, f: Fn, s: Scope, ctx: Ctx, ci?: number): void {
  const b = f.body;
  // The split chain for this if: the path from the body root to here.
  // Frames pushed while emitting the arms (nested re-emissions) are not
  // part of it.
  const chainToIf = [...em.sp.cutStack];
  const restAfterIf = makeRestThunk(em, "if:after");
  // K_SPILL cell freezing the pre-if frame image for the after-if rest's
  // pre-cut operand reloads (see snapWrap).
  const ksp = f.snapWrap(() => {
    b.localGet(ctx.kL); // the ambient continuation
  });
  const ifk = f.retCell(restAfterIf.idx, () => {
    b.localGet(ksp); // next = K_SPILL{frozen frame image, ambient k}
  });
  // Inside the dispatch shape the arms' ambient continuation is the arm
  // completion cell: every split site in an arm (perform/land/...) must
  // chain its rest fragment through ifk, or the resumed value bypasses
  // the after-if rest entirely. The condition keeps the outer kL — its
  // completion is the fTruthy call, not the arm dispatch.
  const ctxArm: Ctx = {...ctx, kL: ifk};
  let condSplit: Split | null = null;
  try {
    if (ci === undefined) f.pushRef(cutChildRef(em, e.c, f, s, ctx, "post"));
    else f.pushRef(cutChildRef(em, e.c, f, s, ctx, ci === 0 ? "cut" : "pre"));
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
    // Baseline: inside a re-emission (restRoot set) the fill runs against
    // that fill's root and cutStack base — the bodyRoots top and its
    // savedCut describe the outer fresh emission, not this re-emission.
    em.sp.cutStack.pop(); // fragments must not see the if's own frame
    const activeC = em.sp.restRoot;
    const rootC = activeC !== null
      ? {stmts: activeC.stmts, sc: activeC.sc, tail: activeC.tail, savedCut: activeC.cutBase}
      : em.sp.bodyRoots[em.sp.bodyRoots.length - 1];
    const savedCutC = em.sp.cutStack;
    em.sp.cutStack = [...rootC.savedCut];
    try {
      fillRest(em, new Split(restAfterIf, chainToIf), rootC.stmts, rootC.sc, rootC.tail);
    } finally {
      em.sp.cutStack = savedCutC;
    }
    b.u8(w.UNREACHABLE); // close the aborted fragment (the condition never falls through)
    throw condSplit;
  }
  b.u8(w.CALL);
  b.lebU(em.ix.fTruthy);
  b.u8(w.IF);
  b.u8(0x40); // void: each arm ends in dispatch + return
  const arm = (armE: ExprID, cutArm: boolean): Split | null => {
    const va = f.anyref();
    let sp: Split | null = null;
    try {
      if (cutArm) {
        f.pushRef(cutChildRef(em, armE, f, s, ctxArm, "cut"));
      } else {
        // The other arm re-emits without the cut: the cut path belongs to
        // the cut arm's subtree only.
        f.pushRef(cutChildRef(em, armE, f, s, ctxArm, "post"));
      }
      b.localSet(va);
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
        // The synthetic root is the arm, not this if: the fill below runs
        // with an empty cut stack (the re-emission rebuilds the path from
        // the arm), and the ambient path — this if's frame included — is
        // restored afterwards, so later split sites in the sibling arm (and
        // the tail pop below) still record chains rooted at the body root.
        const savedCutA = em.sp.cutStack;
        em.sp.cutStack = [];
        try {
          fillRest(em, new Split(sp.restFn, sp.chain.slice(1)), [sp.chain[1]], s, false);
        } finally {
          em.sp.cutStack = savedCutA;
        }
      }
      b.u8(w.UNREACHABLE);
      return cutArm ? sp : null; // fresh arm: filled locally, arm "completes"
    }
    emitDispatch(em, f, va, ifk);
    b.u8(w.RETURN); // the dispatch's result is this function's result
    return null;
  };
  const spA = arm(e.a, ci === 1);
  b.u8(w.ELSE);
  const spB = arm(e.b, ci === 2);
  b.u8(w.END);
  b.u8(w.UNREACHABLE); // unreachable: each arm returned or trapped
  const root = em.sp.bodyRoots[em.sp.bodyRoots.length - 1];
  // This if's own expr frame is still on the cut stack; the arm fragment
  // re-emissions must not see it (they push a fresh if frame along the
  // re-emitted chain).
  em.sp.cutStack.pop();
  // Baseline: inside a re-emission (restRoot set) the arm fragments fill
  // against that fill's root and cutStack base — a stale ambient path (this
  // re-emission's frames above the baseline) would leak into the chains the
  // fills record, corrupting later fragments filled from them.
  const activeT = em.sp.restRoot;
  const rootT = activeT !== null
    ? {stmts: activeT.stmts, sc: activeT.sc, tail: activeT.tail, savedCut: activeT.cutBase}
    : root;
  const baseT = [...rootT.savedCut];
  if (spA !== null) { em.sp.cutStack = baseT; fillRest(em, spA, rootT.stmts, rootT.sc, rootT.tail); }
  if (spB !== null) { em.sp.cutStack = baseT; fillRest(em, spB, rootT.stmts, rootT.sc, rootT.tail); }
  em.sp.cutStack.push(id);
  // The code after the if chains through restAfterIf: the enclosing
  // body-level catcher fills it with the if's value as v.
  if (DBGEMIT) console.error("THROW if-split");
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
function emitWhileCPS(em: Emit, id: ExprID, e: Expr & {t: "while"}, f: Fn, s: Scope, ctx: Ctx, cut?: ExprID[]): void {
  const b = f.body;
  if (cut === undefined) {
    const chainToWhile = [...em.sp.cutStack];
    const restAfter = makeRestThunk(em, "while:after");
    const loopEntry = makeRestThunk(em, "while:loopEntry");
    em.sp.ctlLoops.set(id, {entry: loopEntry, rest: restAfter});
    let inner: Split | null = null;
    try {
      emitLoopPass(em, loopEntry, e, s, 2, loopEntry.idx);
    } catch (sp) {
      if (!(sp instanceof Split)) throw sp;
      inner = sp;
    }
    // K_SPILL cell freezing the pre-loop frame image for the after-while
    // rest's pre-cut operand reloads (see snapWrap).
    const ksp = f.snapWrap(() => {
      b.localGet(ctx.kL); // the ambient continuation
    });
    const ifk = f.retCell(restAfter.idx, () => {
      b.localGet(ksp); // next = K_SPILL{frozen frame image, ambient k}
    });
    const loopk = f.retCell(loopEntry.idx, () => {
      b.localGet(ifk); // next = the after-while cell
    });
    const u = f.anyref();
    f.pushRef(em.lay.unitRef);
    b.localSet(u);
    emitDispatch(em, f, u, loopk); // enter the loop (tail call)
    // The loop pass's emission ends at a split site inside it (that is
    // what makes the while split-mode): that site's rest fragment is
    // filled by the enclosing body-level catcher along the chain through
    // this while; this loop's own after-rest chains when the cut path
    // re-emits (below). The throw is unreachable in practice.
    if (inner !== null) throw inner;
    if (DBGEMIT) console.error("THROW while-cond-split");
    throw new Split(restAfter, chainToWhile);
  }
  const loop = em.sp.ctlLoops.get(id);
  if (loop === undefined) throw new WasmError("internal: split chain root mismatch");
  if (DBGEMIT) console.error("WHILE_CUT cond=", cut[0] === e.c, "body=", cut[0] === e.body, "cutlen=", cut.length);
  if (cut[0] === e.c) {
    // The condition continues the fragment with the fragment's v, then one
    // loop pass re-runs over the ambient continuation (fresh loop-back
    // cell inside emitLoopPass).
    emitLoopPass(em, f, e, s, ctx.kL, loop.entry.idx, cut.slice(1), ctx.snap);
    b.u8(w.UNREACHABLE); // each path dispatched (loop back / exit)
    throw new Split(loop.rest, [...em.sp.cutStack]);
  }
  if (cut[0] === e.body) {
    // Mid-iteration re-entry with a non-block body: it continues the
    // fragment with the cut site's value.
    const bsc = em.d.scopes.get(e.body) ?? s;
    f.pushRef(expr(em, e.body, f, bsc, false, {kL: ctx.kL, cut: cut.slice(1)}));
  } else {
    // Mid-iteration re-entry: skip the condition (already run). Like
    // handler bodies, a block body is bypassed by emitStmtSeq, so the
    // chain's next element is a statement of the body block: statements
    // before the cut site executed, it continues with the fragment's v,
    // statements after it re-emit inline.
    const bodyE = em.nodes[e.body];
    if (bodyE.t !== "block") throw new WasmError("internal: split chain root mismatch");
    const stmts = bodyE.stmts;
    const bsc = em.d.scopes.get(e.body) ?? s;
    const ci = stmts.indexOf(cut[0]);
    if (ci < 0) throw new WasmError("internal: split chain root mismatch");
    f.pushRef(emitStmtsFrom(em, stmts, f, bsc, ctx, ci, cut, false));
  }
  const v = f.anyref();
  b.localSet(v);
  emitDispatch(em, f, v, ctx.kL); // loop back through the k chain
  b.u8(w.UNREACHABLE);
  throw new Split(loop.rest, [...em.sp.cutStack]);
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
function emitLoopPass(em: Emit, f: Fn, e: Expr & {t: "while"}, s: Scope, kNext: number, entryIdx: number, condCut?: ExprID[], snap?: number): void {
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
      ? keepRef(em, e.c, f, expr(em, e.c, f, s, false, {kL: kNext}))
      : condCut.length === 0
        ? keepRef(em, e.c, f, {k: "local", l: 1}) // cond is the split site: v param
        // condCut[0] is a descendant of the cond (e.g. a perform inside
        // the comparison), not the cond itself — pass the cut through
        // intact; cutChildRef's slice(1) would drop the site and the
        // cond would collapse to bare fragV.
        : keepRef(em, e.c, f, expr(em, e.c, f, s, false, {kL: kNext, cut: condCut, snap}));
  } catch (sp) {
    if (!(sp instanceof Split)) throw sp;
    b.u8(w.UNREACHABLE); // the pass never completes inline at this site
    throw sp;
  }
  f.pushRef(condRef);
  b.u8(w.CALL);
  b.lebU(em.ix.fTruthy);
  b.u8(w.IF);
  b.u8(0x40); // void: the body path tails into the loop-back cell
  try {
    // RET cell over the pass's frame; next = the after-loop continuation
    const lb = f.retCell(entryIdx, () => {
      b.localGet(kNext);
    });
    const bodyE = em.nodes[e.body];
    const stmts = bodyE.t === "block" ? bodyE.stmts : [e.body];
    const bsc = em.d.scopes.get(e.body) ?? s;
    emitStmtSeq(em, stmts, f, bsc, false, {kL: lb});
    // The body's completion dispatch left the dispatch walk's block
    // result on the stack (the k=0 terminal-return value): consume it as
    // this pass's return. When the body splits, the catch below closes
    // the arm before this line.
    b.u8(w.RETURN);
  } catch (sp) {
    if (!(sp instanceof Split)) throw sp;
    b.u8(w.UNREACHABLE); // the body never completes inline at this site
    b.u8(w.END);
    const u = f.anyref();
    f.pushRef(em.lay.unitRef);
    b.localSet(u);
    emitDispatch(em, f, u, kNext); // condition false: exit
    throw sp;
  }
  b.u8(w.END);
  const u = f.anyref();
  f.pushRef(em.lay.unitRef);
  b.localSet(u);
  emitDispatch(em, f, u, kNext); // condition false: exit
}

function emitBuiltins(em: Emit, builtin0: number): Fn[] {
  const out: Fn[] = [];
  for (const {name} of BUILTINS) {
    if (!em.o.usedBuiltins.has(name)) continue;
    const f = new Fn(2, em); // (frame, k): builtins are T_KABI trampolines
    f.typeIdx = w.T_KABI;
    f.idx = builtin0 + out.length; // matches the push order (usedBuiltins filter)
    em.ix.funcRefTypes.set(f.idx, w.T_KABI);
    const b = f.body;
    const box = () => {
      b.u8(w.CALL);
      b.lebU(em.ix.fBox);
    };
    switch (name) {
      case "+": {
        const a = f.anyref(), bv = f.anyref();
        f.slot(0);
        b.localSet(a);
        f.slot(1);
        b.localSet(bv);
        b.localGet(a);
        b.refTest(0, false);
        b.localGet(bv);
        b.refTest(0, false);
        b.u8(w.AND);
        b.u8(w.IF);
        b.u8(0x6e); // result anyref
        b.localGet(a);
        b.refCast(0, false);
        b.structGet(0, 0);
        b.localGet(bv);
        b.refCast(0, false);
        b.structGet(0, 0);
        b.u8(w.FADD);
        box();
        b.u8(w.ELSE);
        b.localGet(a);
        b.refTest(2, false);
        b.localGet(bv);
        b.refTest(2, false);
        b.u8(w.AND);
        b.u8(w.IF);
        b.u8(0x6e);
        f.emitStrCat(a, bv);
        b.u8(w.ELSE);
        b.refNull(w.ANYREF);
        b.u8(w.END);
        b.u8(w.END);
        break;
      }
      case "-": {
        const x = f.slotF64(0), y = f.slotF64(1);
        b.localGet(x);
        b.localGet(y);
        b.u8(w.FSUB);
        box();
        break;
      }
      case "*": {
        const x = f.slotF64(0), y = f.slotF64(1);
        b.localGet(x);
        b.localGet(y);
        b.u8(w.FMUL);
        box();
        break;
      }
      case "%": {
        // JS fmod: a - b * trunc(a/b)
        const x = f.slotF64(0), y = f.slotF64(1), t = f.f64();
        b.localGet(x);
        b.localGet(y);
        b.u8(w.FDIV);
        b.u8(w.FTRUNC);
        b.localSet(t);
        b.localGet(x);
        b.localGet(y);
        b.localGet(t);
        b.u8(w.FMUL);
        b.u8(w.FSUB);
        box();
        break;
      }
      case "neg": {
        const x = f.slotF64(0);
        b.localGet(x);
        b.u8(w.FNEG);
        box();
        break;
      }
      case "<":
      case ">":
      case "<=":
      case ">=": {
        const x = f.slotF64(0), y = f.slotF64(1);
        const cmp = name === "<" ? w.FLT : name === ">" ? w.FGT : name === "<=" ? w.FLE : w.FGE;
        selectBool(em, f, () => {
          b.localGet(x);
          b.localGet(y);
          b.u8(cmp);
        });
        break;
      }
      case "==": {
        f.slot(0);
        f.slot(1);
        b.u8(w.CALL);
        b.lebU(em.ix.fEq);
        break;
      }
      case "!=": {
        f.slot(0);
        f.slot(1);
        b.u8(w.CALL);
        b.lebU(em.ix.fEq);
        b.refCast(w.I31REF, false); // eq result's i31 bool payload
        b.i31Get();
        b.u8(w.EQZ); // 1 when $eq said false
        selectBool(em, f, () => {});
        break;
      }
      case "not": {
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.ix.fTruthy);
        b.u8(w.EQZ);
        selectBool(em, f, () => {});
        break;
      }
      case "list": {
        // The frame has fsize 0, so the slots array length IS argc — the
        // only argc reader in the backend (do not generalize).
        const n = f.i32();
        b.localGet(0);
        b.structGet(4, 1);
        b.arrayLen();
        b.localSet(n);
        const blk = f.allocArrBlk(n);
        f.loop(() => {
          b.localGet(n);
        }, i => {
          f.elemAddr(blk, i);
          f.slot(i);
          b.arraySet();
        });
        f.boxArr(blk);
        break;
      }
      case "head": {
        const blk = f.anyref();
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(blk);
        b.localGet(blk);
        b.refCast(1, true);
        b.arrayLen();
        b.u8(w.EQZ);
        b.u8(w.IF);
        b.u8(0x40);
        emitFail(em, f, 0, null, f.constF64(0), f.constF64(0));
        b.u8(w.END);
        b.localGet(blk);
        b.refCast(1, true);
        b.i32Const(0);
        b.arrayGet(1);
        break;
      }
      case "tail": {
        const blk = f.anyref(), len = f.i32(), n1 = f.i32();
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(blk);
        b.localGet(blk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(len);
        b.localGet(len);
        b.u8(w.EQZ);
        b.u8(w.IF);
        b.u8(0x7f);
        b.i32Const(0);
        b.u8(w.ELSE);
        b.localGet(len);
        b.i32Const(1);
        b.u8(w.SUB);
        b.u8(w.END);
        b.localSet(n1);
        f.emitArrCopy(blk, 1, n1);
        break;
      }
      case "concat": {
        const aBlk = f.anyref(), bBlk = f.anyref(), la = f.i32(), lb = f.i32(), n = f.i32();
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(aBlk);
        f.slot(1);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(bBlk);
        b.localGet(aBlk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(la);
        b.localGet(bBlk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(lb);
        b.localGet(la);
        b.localGet(lb);
        b.u8(w.ADD);
        b.localSet(n);
        const blk = f.allocArrBlk(n);
        f.loop(() => {
          b.localGet(la);
        }, i => {
          f.elemAddr(blk, i);
          f.elemAddr(aBlk, i);
          b.arrayGet(1);
          b.arraySet();
        });
        f.loop(() => {
          b.localGet(lb);
        }, i => {
          f.elemAddr(blk, i);
          b.localGet(la);
          b.u8(w.ADD);
          f.elemAddr(bBlk, i);
          b.arrayGet(1);
          b.arraySet();
        });
        f.boxArr(blk);
        break;
      }
      case "flat": {
        const xss = f.anyref(), n = f.i32(), total = f.i32();
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(xss);
        b.localGet(xss);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(n);
        b.i32Const(0);
        b.localSet(total);
        // JS Array.prototype.flat parity: non-array elements pass through
        // instead of being read as inner arrays (a resumed scalar flowing
        // back through a map-like land path lands exactly here).
        f.loop(() => {
          b.localGet(n);
        }, k => {
          const cell = f.anyref();
          f.elemAddr(xss, k);
          b.arrayGet(1);
          b.localSet(cell);
          b.localGet(cell);
          b.refTest(3, false); // is $ARR?
          b.u8(w.IF);
          b.u8(0x40);
          b.localGet(cell);
          b.refCast(3, true);
          b.structGet(3, 0);
          b.refCast(1, true);
          b.arrayLen(); // inner len
          b.localGet(total);
          b.u8(w.ADD);
          b.localSet(total);
          b.u8(w.ELSE);
          b.localGet(total);
          b.i32Const(1);
          b.u8(w.ADD);
          b.localSet(total);
          b.u8(w.END);
        });
        const blk = f.allocArrBlk(total);
        const ww = f.i32();
        b.i32Const(0);
        b.localSet(ww);
        f.loop(() => {
          b.localGet(n);
        }, k => {
          const cell = f.anyref(), xb = f.anyref(), xl = f.i32();
          f.elemAddr(xss, k);
          b.arrayGet(1);
          b.localSet(cell);
          b.localGet(cell);
          b.refTest(3, false);
          b.u8(w.IF);
          b.u8(0x40);
          b.localGet(cell);
          b.refCast(3, true);
          b.structGet(3, 0);
          b.localSet(xb);
          b.localGet(xb);
          b.refCast(1, true);
          b.arrayLen();
          b.localSet(xl);
          f.loop(() => {
            b.localGet(xl);
          }, j => {
            f.elemAddr(blk, ww);
            f.elemAddr(xb, j);
            b.arrayGet(1);
            b.arraySet();
            b.localGet(ww);
            b.i32Const(1);
            b.u8(w.ADD);
            b.localSet(ww);
          });
          b.u8(w.ELSE);
          f.elemAddr(blk, ww);
          b.localGet(cell);
          b.arraySet();
          b.localGet(ww);
          b.i32Const(1);
          b.u8(w.ADD);
          b.localSet(ww);
          b.u8(w.END);
        });
        f.boxArr(blk);
        break;
      }
      case "len": {
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.refCast(1, true);
        b.arrayLen();
        b.u8(w.CONV_I32);
        box();
        break;
      }
      case "strlen": {
        f.slot(0);
        b.refCast(2, true);
        b.arrayLen();
        b.u8(w.CONV_I32);
        box();
        break;
      }
      case "PI":
        b.globalGet(em.lay.piG);
        break;
      case "cos":
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_cos")!);
        break;
      case "sin":
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_sin")!);
        break;
      case "sqrt": {
        const x = f.slotF64(0);
        b.localGet(x);
        b.u8(w.FSQRT);
        box();
        break;
      }
      case "abs": {
        const x = f.slotF64(0);
        b.localGet(x);
        b.u8(w.FABS);
        box();
        break;
      }
      case "round": {
        const x = f.slotF64(0);
        b.localGet(x);
        b.f64Const(0.5);
        b.u8(w.FADD);
        b.u8(w.FFLOOR);
        box();
        break;
      }
      case "range": {
        const s = f.slotF64(0), e = f.slotF64(1), stepv = f.slotF64(2);
        const n = f.i32();
        b.localGet(stepv);
        b.f64Const(0);
        b.u8(w.FEQ);
        b.u8(w.IF);
        b.u8(0x7f);
        b.i32Const(0);
        b.u8(w.ELSE);
        b.localGet(e);
        b.localGet(s);
        b.u8(w.FSUB);
        b.localGet(stepv);
        b.u8(w.FDIV);
        b.u8(w.FCEIL);
        b.f64Const(0);
        b.u8(w.FGT);
        b.u8(w.IF);
        b.u8(0x7f);
        b.localGet(e);
        b.localGet(s);
        b.u8(w.FSUB);
        b.localGet(stepv);
        b.u8(w.FDIV);
        b.u8(w.FCEIL);
        b.u8(w.TRUNC_F64);
        b.u8(w.ELSE);
        b.i32Const(0);
        b.u8(w.END);
        b.u8(w.END);
        b.localSet(n);
        const blk = f.allocArrBlk(n);
        f.loop(() => {
          b.localGet(n);
        }, k => {
          f.elemAddr(blk, k);
          b.localGet(s);
          b.localGet(k);
          b.u8(w.CONV_I32);
          b.localGet(stepv);
          b.u8(w.FMUL);
          b.u8(w.FADD);
          box();
          b.arraySet();
        });
        f.boxArr(blk);
        break;
      }
      case "char":
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_char")!);
        break;
      case "number":
        f.slot(0);
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_number")!);
        break;
      case "args":
        b.u8(w.CALL);
        b.lebU(em.o.impIdx.get("ef_args")!);
        break;
      case "get": {
        const blk = f.anyref(), len = f.i32(), idx = f.i32();
        const idxF = f.slotF64(1);
        f.slot(0);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(blk);
        b.localGet(blk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(len);
        b.localGet(idxF);
        b.u8(w.TRUNC_F64);
        b.localSet(idx);
        b.localGet(idx);
        b.i32Const(0);
        b.u8(w.LTS); // idx < 0
        b.localGet(idx);
        b.localGet(len);
        b.u8(w.GEU); // idx >= len
        b.u8(w.OR);
        b.u8(w.IF);
        b.u8(0x40);
        emitFail(em, f, 1, null, () => {
          b.localGet(idxF);
        }, () => {
          b.localGet(len);
          b.u8(w.CONV_I32);
        });
        b.u8(w.END);
        f.elemAddr(blk, idx);
        b.arrayGet(1);
        break;
      }
      case "set": {
        const xs = f.anyref(), blk = f.anyref(), len = f.i32(), idx = f.i32(), v = f.anyref();
        const idxF = f.slotF64(1);
        f.slot(0);
        b.localSet(xs);
        b.localGet(xs);
        b.refCast(3, true);
        b.structGet(3, 0);
        b.localSet(blk);
        b.localGet(blk);
        b.refCast(1, true);
        b.arrayLen();
        b.localSet(len);
        b.localGet(idxF);
        b.u8(w.TRUNC_F64);
        b.localSet(idx);
        f.slot(2);
        b.localSet(v);
        b.localGet(idx);
        b.localGet(len);
        b.u8(w.LTU); // idx < len → in-place
        b.u8(w.IF);
        b.u8(0x40);
        f.elemAddr(blk, idx);
        b.localGet(v);
        b.arraySet();
        b.u8(w.ELSE);
        // grow: fresh slots array of len idx+1, copy old, fill holes with
        // unit, repoint the wrapper's backing (aliases share the wrapper,
        // so they all see the growth — §7.1).
        const nb = f.anyref(), nlen = f.i32();
        b.localGet(idx);
        b.i32Const(1);
        b.u8(w.ADD);
        b.localSet(nlen);
        b.localGet(nlen);
        b.arrayNew(1);
        b.localSet(nb);
        f.loop(() => {
          b.localGet(nlen);
        }, k => {
          b.localGet(nb);
          b.refCast(1, true);
          b.localGet(k);
          b.localGet(k);
          b.localGet(len);
          b.u8(w.LTU); // k < old len → copy
          b.u8(w.IF);
          b.u8(0x6e); // result anyref
          f.elemAddr(blk, k);
          b.arrayGet(1);
          b.u8(w.ELSE);
          b.refNull(w.ANYREF);
          b.u8(w.END);
          b.arraySet();
        });
        b.localGet(nb);
        b.refCast(1, true);
        b.localGet(idx);
        b.localGet(v);
        b.arraySet();
        b.localGet(xs);
        b.refCast(3, true);
        b.localGet(nb);
        b.refCast(1, true);
        b.structSet(0); // point the wrapper at the new backing
        b.u8(w.END);
        b.refNull(w.ANYREF);
        break;
      }
      case "map":
      case "each":
      case "flatmap":
        emitMapLike(em, f, name);
        break;
      default:
        throw new WasmError(`internal: builtin ${name} not implemented`);
    }
    // Complete with the ABI's dispatch: builtins are called with k=0, so
    // dispatch(0, v) just returns the computed value.
    const v = f.anyref();
    b.localSet(v);
    emitDispatch(em, f, v);
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
function emitMapLike(em: Emit, f: Fn, name: string): void {
  const b = f.body;
  const resSlot = name === "each" ? -1 : 2; // map: res, flatmap: tmp
  const iSlot = name === "each" ? 2 : 3;
  const loopEntry = makeRestThunk(em, "maplike:loopEntry");
  const iterLand = makeRestThunk(em, "maplike:iterLand");
  // Per-iteration land: store the callback result (map/flatmap), bump the
  // counter, continue the loop. frame = the entry frame, v = the callback
  // result, k = the ambient continuation (passed to the next iteration).
  {
    const t = iterLand, tb = t.body;
    if (name !== "each") {
      const blk = t.anyref(), iL = t.i32();
      t.slot(resSlot);
      tb.refCast(3, true);
      tb.structGet(3, 0);
      tb.localSet(blk);
      t.slot(iSlot);
      tb.refCast(0, false);
      tb.structGet(0, 0);
      tb.u8(w.TRUNC_F64);
      tb.localSet(iL);
      t.elemAddr(blk, iL);
      tb.localGet(1);
      tb.arraySet();
    }
    // counter += 1 (boxed back into the slot)
    tb.localGet(0); tb.structGet(4, 1);
    tb.i32Const(iSlot);
    t.slot(iSlot);
    tb.refCast(0, false);
    tb.structGet(0, 0);
    tb.f64Const(1);
    tb.u8(w.FADD);
    tb.u8(w.CALL);
    tb.lebU(em.ix.fBox);
    tb.arraySet();
    tb.localGet(0);
    t.pushRef(em.lay.unitRef);
    tb.localGet(2);
    tb.u8(w.RETURN_CALL);
    tb.lebU(loopEntry.idx);
  }

  // Loop entry: done → finalize (box the result / flatmap copy) and
  // dispatch through this thunk's k; else call the callback on element i.
  {
    const t = loopEntry, tb = t.body;
    const xb = t.anyref(), n = t.i32(), iL = t.i32(), fc = t.anyref();
    t.slot(1); // the xs wrapper (arg 1) → its backing array and length
    tb.refCast(3, true);
    tb.structGet(3, 0);
    tb.localSet(xb);
    tb.localGet(xb);
    tb.refCast(1, true);
    tb.arrayLen();
    tb.localSet(n);
    t.slot(iSlot);
    tb.refCast(0, false);
    tb.structGet(0, 0);
    tb.u8(w.TRUNC_F64);
    tb.localSet(iL);
    tb.localGet(iL);
    tb.localGet(n);
    tb.u8(w.GEU);
    tb.u8(w.IF);
    tb.u8(0x40);
    const v = t.anyref();
    if (name === "map") {
      const res = t.anyref();
      t.slot(resSlot);
      tb.refCast(3, true);
      tb.structGet(3, 0);
      tb.localSet(res);
      t.boxArr(res);
    } else if (name === "each") {
      t.pushRef(em.lay.unitRef);
    } else {
      // flatmap: total = Σ per-element lengths; allocate; copy; box.
      const tmp = t.anyref(), total = t.i32();
      t.slot(resSlot);
      tb.refCast(3, true);
      tb.structGet(3, 0);
      tb.localSet(tmp);
      tb.i32Const(0);
      tb.localSet(total);
      t.loop(() => {
        tb.localGet(n);
      }, i => {
        // total += len of callback result i: elem → its backing array →
        // len (scalar elements count as 1 — the tag test, not the value).
        const cell = t.anyref();
        t.elemAddr(tmp, i);
        tb.arrayGet(1);
        tb.localSet(cell);
        tb.localGet(cell);
        tb.refTest(3, false);
        tb.u8(w.IF);
        tb.u8(0x40);
        tb.localGet(cell);
        tb.refCast(3, true);
        tb.structGet(3, 0);
        tb.refCast(1, true);
        tb.arrayLen();
        tb.localGet(total);
        tb.u8(w.ADD);
        tb.localSet(total);
        tb.u8(w.ELSE);
        tb.localGet(total);
        tb.i32Const(1);
        tb.u8(w.ADD);
        tb.localSet(total);
        tb.u8(w.END);
      });
      const res = t.allocArrBlk(total);
      const ww = t.i32();
      tb.i32Const(0);
      tb.localSet(ww);
      t.loop(() => {
        tb.localGet(n);
      }, i => {
        const xb2 = t.anyref(), xl = t.i32();
        const cell = t.anyref();
        t.elemAddr(tmp, i);
        tb.arrayGet(1);
        tb.localSet(cell);
        tb.localGet(cell);
        tb.refTest(3, false);
        tb.u8(w.IF);
        tb.u8(0x40);
        tb.localGet(cell);
        tb.refCast(3, true);
        tb.structGet(3, 0);
        tb.localSet(xb2);
        tb.localGet(xb2);
        tb.refCast(1, true);
        tb.arrayLen();
        tb.localSet(xl);
        t.loop(() => {
          tb.localGet(xl);
        }, j => {
          // dst = res[w], src = xb2[j] (element values, same layout the
          // box/collect path reads back).
          t.elemAddr(res, ww);
          t.elemAddr(xb2, j);
          tb.arrayGet(1);
          tb.arraySet();
          tb.localGet(ww);
          tb.i32Const(1);
          tb.u8(w.ADD);
          tb.localSet(ww);
        });
        tb.u8(w.ELSE);
        t.elemAddr(res, ww);
        tb.localGet(cell);
        tb.arraySet();
        tb.localGet(ww);
        tb.i32Const(1);
        tb.u8(w.ADD);
        tb.localSet(ww);
        tb.u8(w.END);
      });
      t.boxArr(res);
    }
    tb.localSet(v);
    emitDispatch(em, t, v, 2); // k = this thunk's k param
    tb.u8(w.RETURN); // only the k=0 branch reaches here, with the value
    tb.u8(w.ELSE);
    // Iteration: elem = xs[i]; the callback's RET cell lands in iterLand
    // (landA) over this thunk's frame, with next = this thunk's k.
    t.slot(0);
    tb.localSet(fc);
    const elem = t.anyref();
    t.elemAddr(xb, iL);
    tb.arrayGet(1);
    tb.localSet(elem);
    emitCallClosure(em, t, fc, name === "map" ? 1 : 2, (k, ffp) => {
      // Suspension-safe as-is: elem/iL are locals set before the call, and
      // fBox cannot suspend, so no operand spans a suspension point.
      tb.localGet(ffp); tb.refCast(4, true); tb.structGet(4, 1);
      tb.i32Const(k);
      if (k === 0) tb.localGet(elem);
      else {
        tb.localGet(iL);
        tb.u8(w.CONV_I32);
        tb.u8(w.CALL);
        tb.lebU(em.ix.fBox);
      }
      tb.arraySet();
    }, false, true, 2, true, iterLand.idx);
    tb.u8(w.UNREACHABLE); // the callback always tails into iterLand
    tb.u8(w.END);
    tb.u8(w.UNREACHABLE); // both if arms diverge; keep the implicit end typed
  }
  // Entry (this builtin Fn): allocate the result array, init the counter,
  // tail-call the loop entry.
  const xb = f.anyref(), n = f.i32();
  f.slot(1);
  b.refCast(3, true);
  b.structGet(3, 0);
  b.localSet(xb);
  b.localGet(xb);
  b.refCast(1, true);
  b.arrayLen();
  b.localSet(n);
  if (resSlot >= 0) {
    const res = f.allocArrBlk(n);
    b.localGet(0); b.structGet(4, 1);
    b.i32Const(resSlot);
    f.boxArr(res); // the slot holds the $ARR wrapper (iterLand + the
                         // done path read it back as a wrapper)
    b.arraySet();
  }
  b.localGet(0); b.structGet(4, 1);
  b.i32Const(iSlot);
  b.i32Const(0);
  b.u8(w.CONV_I32);
  b.u8(w.CALL);
  b.lebU(em.ix.fBox);
  b.arraySet();
  b.localGet(0);
  f.pushRef(em.lay.unitRef);
  b.localGet(1);
  b.u8(w.RETURN_CALL);
  b.lebU(loopEntry.idx);
}

function emitMain(em: Emit, f: Fn): void {
  const b = f.body;
  // The global frame is allocated by run() (the frame param is local 0).
  const exprs = em.prog.items.filter((it): it is {e: ExprID} => "e" in it);
  const v = f.anyref();
  if (exprs.length === 0) {
    f.pushRef(em.lay.unitRef);
    b.localSet(v);
  } else {
    // Same split protocol as bodyCatch: a perform/handle at the top level
    // ends the inline body; its fragment re-emits the remaining items.
    const savedCut = em.sp.cutStack;
    const roots = exprs.map(it => it.e);
    em.sp.bodyRoots.push({stmts: roots, sc: em.d.globalScope, tail: false, savedCut: [...savedCut]});
    try {
      try {
        for (let k = 0; k < exprs.length; k++) {
          const r = expr(em, exprs[k].e, f, em.d.globalScope);
          if (k < exprs.length - 1) { /* dropped: nothing on the stack */ }
          else { f.pushRef(r); b.localSet(v); }
        }
      } catch (sp) {
        em.sp.cutStack = savedCut;
        if (!(sp instanceof Split)) throw sp;
        fillRest(em, sp, roots, em.d.globalScope, false);
        return; // the body ends at the split site (both paths tail-call)
      }
      em.sp.cutStack = savedCut;
    } finally {
      em.sp.bodyRoots.pop();
    }
  }
  // run() calls main with k = ref.null $K, so dispatch(null, v) returns
  // the top-level value.
  emitDispatch(em, f, v);
}

// run (allocates the global frame, calls main with k = null) and the
// 12 host accessors (§4 — JS cannot read GC fields directly). Appended
// after main; indices computed here.
function emitInits(em: Emit): void {
  const mainIdx = em.o.liveImports.length + em.funcs.length - 1; // main is last
  em.ix.funcRefTypes.set(mainIdx, w.T_KABI); // main's funcref slot (after thunks)
  const run = new Fn(0, em);
  run.typeIdx = w.T_RUN;
  run.idx = mainIdx + 1;
  em.ix.funcRefTypes.set(run.idx, w.T_RUN);
  {
    const b = run.body;
    b.refNull(4); // global frame parent = null
    b.i32Const(frameSizeOf(em.ix, em.d.globalScope));
    b.arrayNew(1);
    b.structNew(4);
    b.refNull(5); // k = null: main's dispatch returns its value
    b.u8(w.CALL);
    b.lebU(mainIdx);
  }
  em.funcs.push(run);
  const acc = (params: number, typeIdx: number, emit: (b: Buf, f: Fn) => void): Fn => {
    const f = new Fn(params, em);
    f.typeIdx = typeIdx;
    f.idx = em.o.liveImports.length + em.funcs.length;
    em.ix.funcRefTypes.set(f.idx, typeIdx);
    emit(f.body, f);
    em.funcs.push(f);
    return f;
  };
  // __tag(v) -> i32: 0 unit (null) 1 num 2 bool 3 str 4 arr 5 clo
  acc(1, 14, (b) => {
    b.localGet(0);
    b.u8(0xd1);
    b.u8(w.IF);
    b.u8(0x7f);
    b.i32Const(0);
    b.u8(w.ELSE);
    const tag = (ht: number, t: number) => {
      b.localGet(0);
      b.refTest(ht, false);
      b.u8(w.IF);
      b.u8(0x7f);
      b.i32Const(t);
      b.u8(w.ELSE);
    };
    tag(w.I31REF, 2);
    tag(0, 1); // $NUM
    tag(2, 3); // $STR
    tag(3, 4); // $ARR
    b.localGet(0);
    b.refTest(6, false); // $CLO
    b.u8(w.IF);
    b.u8(0x7f);
    b.i32Const(5);
    b.u8(w.ELSE);
    b.u8(w.UNREACHABLE);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
    b.u8(w.END);
  });
  // __num(v) -> f64
  acc(1, 19, (b) => {
    b.localGet(0);
    b.refCast(0, false);
    b.structGet(0, 0);
  });
  // __str_len(v) -> i32
  acc(1, 14, (b) => {
    b.localGet(0);
    b.refCast(2, false);
    b.arrayLen();
  });
  // __str_get(v, i) -> i32
  acc(2, 20, (b) => {
    b.localGet(0);
    b.refCast(2, false);
    b.localGet(1);
    b.arrayGet(2);
  });
  // __arr_len(v) -> i32
  acc(1, 14, (b) => {
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 0);
    b.arrayLen();
  });
  // __arr_get(v, i) -> anyref
  acc(2, 22, (b) => {
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 0);
    b.localGet(1);
    b.arrayGet(1);
  });
  // __mk_num(x) -> anyref
  acc(1, 13, (b) => {
    b.localGet(0);
    b.structNew(0);
  });
  // __mk_bool(b) -> anyref
  acc(1, 12, (b) => {
    b.localGet(0);
    b.refI31();
  });
  // __str_new(n) -> anyref
  acc(1, 12, (b) => {
    b.localGet(0);
    b.arrayNew(2);
  });
  // __str_set(v, i, u) -> ()
  acc(3, 21, (b) => {
    b.localGet(0);
    b.refCast(2, false);
    b.localGet(1);
    b.localGet(2);
    b.arraySet();
  });
  // __arr_new(n) -> anyref
  acc(1, 12, (b) => {
    b.localGet(0);
    b.arrayNew(1);
    b.structNew(3);
  });
  // __arr_set(v, i, x) -> ()
  acc(3, 23, (b) => {
    b.localGet(0);
    b.refCast(3, false);
    b.structGet(3, 0);
    b.localGet(1);
    b.localGet(2);
    b.arraySet();
  });
}

// --- module-level optimization pipeline ---------------------------------------

// Ordered passes over the program (run in optimize()); each records facts the
// emitters consume, and index assignment derives helper/lambda/builtin
// funcref indices from the live import count (dataflow: assignIndices takes
// Opt). The AST walks themselves live in analysis.ts (shared with
// interpreter-side consumers); planned for this seam: helper-function
// reachability, function-body dedup.
const OPT_PASSES: ((prog: Program, o: Opt) => void)[] = [
  treeShakeBuiltins,
  dropDeadHostImports,
];

// Marks every builtin the program references as a value (analysis.ts
// builtinRefs — shadowing-correct, checker-mirroring binding order):
// layoutStatics/emitBuiltins emit only these.
function treeShakeBuiltins(prog: Program, o: Opt): void {
  o.valueBuiltins = builtinValueUses(prog);
  const refs = builtinRefs(prog);
  // Trampolines: every referenced non-operator (their direct call sites
  // still call them); operators only when used as values, since operator
  // call sites compile inline.
  o.usedBuiltins = new Set([...refs].filter(n => o.valueBuiltins.has(n) || !OPERATOR_OPS.has(n)));
}

// Drops dead host imports: a builtin-served import is live iff its builtin
// is in usedBuiltins (treeShakeBuiltins — shadowing-correct); ef_perform is
// live iff the program contains any perform node (analysis.ts performsAnyOp
// — any op, even inside a handler's body or a case body; handlers don't
// prove non-performance); ef_fail stays live at this pass level — proving it
// dead needs reachability analysis over the bounds checks in
// get/len/head/tail/set AND the inline index/field-access bounds checks
// (deferred to the helper-reachability pass — the binaryen shrink pass
// performs the proof downstream for modules whose unreferenced code it can
// see through, e.g. operator-only programs with no bounds checks left).
// Live imports keep their HOST_IMPORTS order.
function dropDeadHostImports(prog: Program, o: Opt): void {
  const live = HOST_IMPORTS.filter(n =>
    n === "ef_perform" ? performsAnyOp(prog) :
    n === "ef_fail" ? true :
    Object.hasOwn(BUILTIN_IMPORTS, n) &&
      o.usedBuiltins.has(BUILTIN_IMPORTS[n]));
  if (DBGEMIT)
    console.error("dropDeadHostImports:", JSON.stringify(live), "used:", [...o.usedBuiltins].join(","));
  o.liveImports = live;
  o.impIdx = new Map(live.map((n, i): [string, number] => [n, i]));
}
