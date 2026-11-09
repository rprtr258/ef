// Function-body emission primitives of the wasm backend: Buf (the streaming
// bytecode→binaryen assembler) and Fn (one function's emitter: locals, frame
// slots, scope tracking). The §-numbered design doc for the whole backend
// lives at the top of wasm.ts.
import binaryen from "binaryen";
import {ValueRef, _T, WasmError} from "./wasm_types.ts";
import {DBGEMIT, MOD, SIGS, STRUCT_FIELDS, vt} from "./wasm_tables.ts";
import * as w from "./wasm_consts.ts";

// The slice of the emission context (Emit, wasm_emit.ts) that body emission
// reaches through: direct-call signature resolution. Defined structurally so
// this module stays decoupled from the higher layers — Emit satisfies it.
export type FnOwner = {
  o: {liveImports: string[]},
  ix: {funcRefTypes: Map<number, number>},
};

// --- binaryen-backed body emitter -------------------------------------------

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


export class Buf {
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
      case w.GTS: bin((l, r) => MOD.i32.gt_s(l, r)); return;
      case w.GTU: bin((l, r) => MOD.i32.gt_u(l, r)); return;
      case w.LES: bin((l, r) => MOD.i32.le_s(l, r)); return;
      case w.LEU: bin((l, r) => MOD.i32.le_u(l, r)); return;
      case w.GES: bin((l, r) => MOD.i32.ge_s(l, r)); return;
      case w.GEU: bin((l, r) => MOD.i32.ge_u(l, r)); return;
      case w.ADD: bin((l, r) => MOD.i32.add(l, r)); return;
      case w.SUB: bin((l, r) => MOD.i32.sub(l, r)); return;
      case w.MUL: bin((l, r) => MOD.i32.mul(l, r)); return;
      case w.DIVS: bin((l, r) => MOD.i32.div_s(l, r)); return;
      case w.DIVU: bin((l, r) => MOD.i32.div_u(l, r)); return;
      case w.REMS: bin((l, r) => MOD.i32.rem_s(l, r)); return;
      case w.REMU: bin((l, r) => MOD.i32.rem_u(l, r)); return;
      case w.AND: bin((l, r) => MOD.i32.and(l, r)); return;
      case w.OR: bin((l, r) => MOD.i32.or(l, r)); return;
      case w.I64_ADD: bin((l, r) => MOD.i64.add(l, r)); return;
      case w.I64_SUB: bin((l, r) => MOD.i64.sub(l, r)); return;
      case w.I64_MUL: bin((l, r) => MOD.i64.mul(l, r)); return;
      case w.I64_DIVS: bin((l, r) => MOD.i64.div_s(l, r)); return;
      case w.I64_DIVU: bin((l, r) => MOD.i64.div_u(l, r)); return;
      case w.I64_REMS: bin((l, r) => MOD.i64.rem_s(l, r)); return;
      case w.I64_REMU: bin((l, r) => MOD.i64.rem_u(l, r)); return;
      case w.I64_EQ: bin((l, r) => MOD.i64.eq(l, r)); return;
      case w.I64_NE: bin((l, r) => MOD.i64.ne(l, r)); return;
      case w.I64_XOR: bin((l, r) => MOD.i64.xor(l, r)); return;
      case w.I64_LTS: bin((l, r) => MOD.i64.lt_s(l, r)); return;
      case w.I64_LTU: bin((l, r) => MOD.i64.lt_u(l, r)); return;
      case w.I64_GTS: bin((l, r) => MOD.i64.gt_s(l, r)); return;
      case w.I64_GTU: bin((l, r) => MOD.i64.gt_u(l, r)); return;
      case w.I64_LES: bin((l, r) => MOD.i64.le_s(l, r)); return;
      case w.I64_LEU: bin((l, r) => MOD.i64.le_u(l, r)); return;
      case w.I64_GES: bin((l, r) => MOD.i64.ge_s(l, r)); return;
      case w.I64_GEU: bin((l, r) => MOD.i64.ge_u(l, r)); return;
      case w.I64_EXTEND_I32_S: un((v) => MOD.i64.extend_s(v)); return;
      case w.I64_EXTEND_I32_U: un((v) => MOD.i64.extend_u(v)); return;
      case w.I64_EQZ: un((v) => MOD.i64.eqz(v)); return;
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
      case w.F32_ADD: bin((l, r) => MOD.f32.add(l, r)); return;
      case w.F32_SUB: bin((l, r) => MOD.f32.sub(l, r)); return;
      case w.F32_MUL: bin((l, r) => MOD.f32.mul(l, r)); return;
      case w.F32_DIV: bin((l, r) => MOD.f32.div(l, r)); return;
      case w.F32_EQ: bin((l, r) => MOD.f32.eq(l, r)); return;
      case w.F32_LT: bin((l, r) => MOD.f32.lt(l, r)); return;
      case w.F32_GT: bin((l, r) => MOD.f32.gt(l, r)); return;
      case w.F32_LE: bin((l, r) => MOD.f32.le(l, r)); return;
      case w.F32_GE: bin((l, r) => MOD.f32.ge(l, r)); return;
      case w.F32_ABS: un((v) => MOD.f32.abs(v)); return;
      case w.F32_NEG: un((v) => MOD.f32.neg(v)); return;
      case w.F32_TRUNC: un((v) => MOD.f32.trunc(v)); return;
      case w.F32_SQRT: un((v) => MOD.f32.sqrt(v)); return;
      case w.I64_TRUNC_F64: un((v) => MOD.i64.trunc_s.f64(v)); return;
      case w.I32_WRAP_I64: un((v) => MOD.i32.wrap(v)); return;
      case w.TRUNC_F64: un((v) => MOD.i32.trunc_s.f64(v)); return;
      case w.CONV_I32: un((v) => MOD.f64.convert_s.i32(v)); return;
      case w.CONV_I32_U: un((v) => MOD.f64.convert_u.i32(v)); return;
      case w.CONV_F32_I32: un((v) => MOD.f32.convert_s.i32(v)); return;
      case w.CONV_F32_U32: un((v) => MOD.f32.convert_u.i32(v)); return;
      case w.CONV_F32_I64: un((v) => MOD.f32.convert_s.i64(v)); return;
      case w.CONV_F32_U64: un((v) => MOD.f32.convert_u.i64(v)); return;
      case w.CONV_F64_I64: un((v) => MOD.f64.convert_s.i64(v)); return;
      case w.CONV_F64_U64: un((v) => MOD.f64.convert_u.i64(v)); return;
      case w.F32_DEMOTE: un((v) => MOD.f32.demote(v)); return;
      case w.F64_PROMOTE: un((v) => MOD.f64.promote(v)); return;
      default: throw new WasmError(`internal: unknown opcode 0x${op.toString(16)}`);
    }
  }

  // --- instruction emit methods ---------------------------------------------

  i32Const(n: number): void { this.push(MOD.i32.const(n)); }
  i64Const(v: bigint): void { this.push(MOD.i64.const(v)); }
  f64Const(x: number): void { this.push(MOD.f64.const(x)); }
  // Box a small int (K-cell tags, bools): i31.new of a constant.
  i31Const(v: number): void { this.i32Const(v); this.refI31(); }
  // ref.is_null of local i (0xd1).
  localIsNull(i: number): void { this.localGet(i); this.u8(0xd1); }
  // Direct call to the helper/trampoline at funcref index idx.
  callFn(idx: number): void { this.u8(w.CALL); this.lebU(idx); }
  // Numeric-box payload read: cast to the box shape's (ref ht), read field 0.
  readBoxPayload(ht: number): void { this.refCast(ht, false); this.structGet(ht, 0); }
  localGet(i: number): void { this.push(MOD.local.get(i, this.localType(i))); }
  localSet(i: number): void { this.stmt(MOD.local.set(i, this.pop())); }
  globalGet(gi: number): void { this.push(MOD.global.get(`g${gi}`, binaryen.anyref)); }
  // Control-scope openers: opcode + blocktype immediate in one call
  // (0x40 void, 0x7f i32, 0x7e i64, 0x6e anyref).
  block(bt = 0x40): void { this.u8(w.BLOCK); this.u8(bt); }
  loop(bt = 0x40): void { this.u8(w.LOOP); this.u8(bt); }
  if(bt = 0x40): void { this.u8(w.IF); this.u8(bt); }
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

export class Fn {
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
  constructor(public params: number, public em?: FnOwner) {
    this.body = new Buf(this);
  }
  i32(): number { return this.typed(binaryen.i32); }
  i64(): number { return this.typed(binaryen.i64); }
  f64(): number { return this.typed(binaryen.f64); }
  f32(): number { return this.typed(binaryen.f32); }
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

  // Store pushVal() into frame slot i of this fn's frame (local 0) — the
  // write half of slot().
  storeSlot(i: number, pushVal: () => void): void {
    this.body.localGet(0);
    this.body.structGet(4, 1);
    this.body.i32Const(i);
    pushVal();
    this.body.arraySet();
  }

  // f64 payload of slot i's number; ref.cast traps on non-numbers (the
  // frozen §7.7 deviation — unreachable in well-typed programs).
  slotF64(i: number): number {
    const l = this.f64();
    this.slot(i);
    this.body.readBoxPayload(0);
    this.body.localSet(l);
    return l;
  }

  // f32 payload of slot i's number ($F32 box). Same trap semantics as
  // slotF64; used by f32-dispatched trampoline arms.
  slotF32(i: number): number {
    const l = this.f32();
    this.slot(i);
    this.body.readBoxPayload(11);
    this.body.localSet(l);
    return l;
  }

  // Unbox the $ARR wrapper on the stack → backing $ELEMS in local `into`
  // (shared prologue of the array builtins and the emitters' array paths;
  // pushRef(...)/slot(i) precedes for the wrapper's source).
  unboxArr(into: number): void {
    this.body.refCast(3, true);
    this.body.structGet(3, 0);
    this.body.localSet(into);
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
    b.block();
    b.loop();
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

  // Pointer-walk loop: BLOCK { LOOP { cond; br_if out; body; br; } } —
  // cond pushes an i32 (nonzero exits); body is one walk step. The
  // counting-loop analogue is loop().
  walkLoop(cond: () => void, body: () => void): void {
    const b = this.body;
    b.block();
    b.loop();
    cond();
    b.u8(w.BR_IF);
    b.lebU(1);
    body();
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
    b.i31Const(w.K_RET);
    b.i31Const(fragIdx);
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
    b.i31Const(w.K_SPILL);
    b.localGet(snapv);
    b.refNull(w.ANYREF); // b unused (was UNIT_CELL)
    nextE();
    b.refCast(5, true);
    b.structNew(5);
    b.localSet(ksp);
    return ksp;
  }
}


function sigOf(em: FnOwner, funcrefIdx: number): {ps: binaryen.Type[], r: binaryen.Type | null} {
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
