// Shared value-plane emission of the wasm backend: helper functions ($eq,
// $truthy, $num64, the width ladders), the dispatch walk,
// the boxed call ABI, and the failure/bool idioms.
// The control plane — the IR term walk, perform/handle, case functions —
// lives in wasm_term.ts. The design doc for the whole backend
// lives at the top of wasm.ts.
import {_T} from "./wasm_types.ts";
import {DBGEMIT, DBGTRACE, MOD, TRACE_SITES} from "./wasm_tables.ts";
import {Buf, Fn} from "./wasm_body.ts";
import {type Discovery, type Indices, type IndexRegistrar, type Layout, type Opt} from "./wasm_pipeline.ts";
import type {TermPlan} from "./wasm_term.ts";
import * as w from "./wasm_consts.ts";

// ValueRef = one of: const (immediate cell), local (wasm local index,
// single-use), slot (frame slot: $fp + offset — suspension-stable).
// Emitters never leave implicit operands on the stack across emitter
// calls. Short-lived stack use is allowed ONLY inside a helper that fully
// balances before returning (pushRef materializes a ref onto the stack at
// its consume point).
// --- emission -----------------------------------------------------------------
// Emission is free functions over one local Emit context, created inside
// emit() and dropped when it returns: nothing outside emission can touch
// this state. Each function takes `em` first.


export type Emit = {
  d: Discovery,
  o: Opt,
  ix: Indices,
  reg: IndexRegistrar,
  lay: Layout,
  // Code under construction: emitted functions, and the thunks (T_III_I —
  // letk continuations and map-like land cells) appended between builtins
  // and main.
  funcs: Fn[],
  thunks: Fn[],
  // Per-site tight map/each/flatmap loop fns (wasm_devirt.ts-proven pure
  // direct callbacks): created by wasm_term.ts at the call site, bodies
  // filled by emitTightMaps (emitMapLike lives above wasm_term's layer).
  tightMaps: {f: Fn, name: string, cb: {idx: number, fsize: number}}[],
  // The IR plan (scopes, escapes, handle registry) — set by wasm.ts's emit.
  plan: TermPlan,
  // The program-term function (set by emitMain; run's call target).
  mainFn: Fn,
};
export const i31of = (b: Buf): void => { b.refCast(w.I31REF, false); b.i31Get(); };

// Number-box shape by width name ($F64 is shape 0, the per-width boxes 7..11).
export function boxShapeOf(wkn: string): number {
  switch (wkn) {
    case "i32": return 7;
    case "u32": return 8;
    case "i64": return 9;
    case "u64": return 10;
    case "f32": return 11;
    default: return 0; // $F64
  }
}

// Box the width-typed value on the stack (the f64 plane rides $box).
export function rebox(em: Emit, f: Fn, wkn: string): void {
  if (wkn === "f64") f.body.callFn(em.ix.fBox);
  else f.body.structNew(boxShapeOf(wkn));
}

// A raw value of the width's machine type, fresh scratch local.
export function planeLocal(f: Fn, wkn: string): number {
  return wkn === "f32" ? f.f32()
    : wkn === "i64" || wkn === "u64" ? f.i64()
    : wkn === "f64" ? f.f64() // the f64 plane's scratch holds raw f64 payloads
    : f.i32(); // i32/u32-plane scratch
}

// A raw call result (numeric entry's return valtype) parked in a fresh
// plane local — reboxed at the same width by default (the anyref the boxed
// call paths produce); `raw` skips the rebox and returns the unboxed
// plane local (a typed destination slot takes it directly).
export function reboxCallResult(em: Emit, f: Fn, rW: string, raw = false): number {
  const b = f.body;
  const pl = planeLocal(f, rW);
  b.localSet(pl);
  if (raw) return pl;
  b.localGet(pl);
  rebox(em, f, rW);
  const v = f.anyref();
  b.localSet(v);
  return v;
}

// K_HDL case-table read: the table at k.a is a flat $ELEMS of i31
// quadruples [opid, fnIdx, fsize, nparams]; entryI31 reads word `off` of
// the entry at word index `ent`.
const entryI31 = (b: Buf, tbl: number, ent: number, off: number): void => {
  b.localGet(tbl);
  b.refCast(1, true);
  b.localGet(ent);
  if (off !== 0) { b.i32Const(off); b.num(w.ADD); }
  b.arrayGet(1);
  i31of(b);
};

// k-cell field read: cast the local to the $K cell type (shape 5:
// {kind, a, frame, next}) and read `field`.
const cellGet = (b: Buf, cell: number, field: number): void => {
  b.localGet(cell);
  b.refCast(5, true);
  b.structGet(5, field);
};

// $HDLCTX field read (shape 21: {tag, tab, hframe, outer, kret}).
export const hdlGet = (b: Buf, entry: number, field: number): void => {
  b.localGet(entry);
  b.refCast(21, true);
  b.structGet(21, field);
};

// k-cell's frame field (slot 2) cast to the $FRAME shape (4).
const cellFrame = (b: Buf, cell: number): void => {
  b.localGet(cell);
  b.refCast(5, true);
  b.structGet(5, 2);
  b.refCast(4, true);
};

// Handler case-table scan, shared by the dispatch walk (emitDispatch,
// matching the trailing Return entry, opid -1) and the perform walk
// (emitPerform, matching the performed op): scan the flat [opid, fnIdx,
// fsize, nparams]* i31 table at `tbl` for the first entry whose word 0
// equals the i32 `want` pushes; on the first match set `found`, read
// fnIdx/fsize/nparams into fresh scan locals (returned), and break out of
// the scan. The caller branches on `found` afterwards.
export function emitCaseScan(f: Fn, tbl: number, want: () => void): {found: number, fnIdx: number, fsz: number, nparams: number} {
  const b = f.body;
  const found = f.i32(), fnIdx = f.i32(), fsz = f.i32(),
    nparams = f.i32(), ent = f.i32();
  const nL = f.i32();
  b.localGet(tbl); b.refCast(1, true); b.arrayLen(); b.i32Const(4); b.num(w.DIVU);
  b.localSet(nL);
  b.i32Const(0);
  b.localSet(found);
  f.loop(() => {
    b.localGet(nL);
  }, i => {
    b.localGet(i); b.i32Const(4); b.num(w.MUL);
    b.localSet(ent);
    entryI31(b, tbl, ent, 0);
    want();
    b.num(w.EQ);
    b.if();
    b.i32Const(1);
    b.localSet(found);
    entryI31(b, tbl, ent, 1); b.localSet(fnIdx);
    entryI31(b, tbl, ent, 2); b.localSet(fsz);
    entryI31(b, tbl, ent, 3); b.localSet(nparams);
    b.br(2); // exit the scan
    b.end();
  });
  return {found, fnIdx, fsz, nparams};
}

function unboxArm(b: Buf, ret: number, ht: number, ops: number[], at = 0, nullable = false): void {
  b.localGet(at);
  b.refTest(ht, nullable);
  b.if(ret);
  b.localGet(at);
  b.readBoxPayload(ht);
  for (const op of ops) b.num(op);
  b.els();
}

// The shape of one adaptive unbox ladder: the arm list (box shape +
// conversion ops, in test order) and the trap-at-default arm. $num64,
// $f32of/$i32of/$u32of/$i64of/$u64of and the host __num accessor all
// share this one structure.
type LadderSpec = {
  ret: number,           // arm/default block result valtype byte
  arms: [number, number[]][],
  defOps: number[],      // ops over the default ($F64) payload read
};

// Emit one ladder body into `b` (shared by the helper Fns and __num).
export function ladderBody(b: Buf, spec: LadderSpec): void {
  for (const [shape, ops] of spec.arms) unboxArm(b, spec.ret, shape, ops);
  b.localGet(0); // default: trap (non-number)
  b.readBoxPayload(0);
  for (const op of spec.defOps) b.num(op);
  for (let i = 0; i < spec.arms.length; i++) b.end();
}

// Helper fn declarations: created + registered here (context-free) so their
// funcref indices and sigs exist before any call site resolves them; bodies
// are filled by emitHelpers in the same order.
export function registerHelpers(reg: IndexRegistrar, ix: Indices): void {
  const truthy = new Fn(1); ix.fTruthy = reg.register("fTruthy", truthy, w.T_TRUTHY);
  const eq = new Fn(2); ix.fEq = reg.register("fEq", eq, w.T_EQ);
  const box = new Fn(1); ix.fBox = reg.register("fBox", box, w.T_BOX);
  const num64 = new Fn(1); ix.fNum64 = reg.register("fNum64", num64, w.T_NUM64);
  const f32of = new Fn(1); ix.fF32of = reg.register("fF32of", f32of, w.T_F32);
  const i32of = new Fn(1); ix.fI32of = reg.register("fI32of", i32of, w.T_GETI32);
  const u32of = new Fn(1); ix.fU32of = reg.register("fU32of", u32of, w.T_GETI32);
  const i64of = new Fn(1); ix.fI64of = reg.register("fI64of", i64of, w.T_GETI64);
  const u64of = new Fn(1); ix.fU64of = reg.register("fU64of", u64of, w.T_GETI64);
  ix.helpers = [truthy, eq, box, num64, f32of, i32of, u32of, i64of, u64of];
}

// The adaptive arms $num64 and the host __num accessor share (everything
// but the $F64 box: num64 takes it as an identity fast arm, __num as the
// default payload read).
export const NUM64_ARMS: [number, number[]][] = [
  [11, [w.F64_PROMOTE]], [7, [w.CONV_I32]], [8, [w.CONV_I32_U]], [9, [w.CONV_F64_I64]], [10, [w.CONV_F64_U64]],
];

export function emitHelpers(em: Emit): Fn[] {
  const [truthy, eq, box, num64, f32of, i32of, u32of, i64of, u64of] = em.ix.helpers;
  for (const f of em.ix.helpers) f.em = em;
  // $truthy(v: anyref) -> i32: JS truthiness — 0 only for unit (ref.null
  // any) and the bool i31 0 (matches `c !== false && c !== null`); every
  // $NUM (including 0.0), $STR, $ARR and $CLO is truthy.
  {
    const b = truthy.body;
    b.localIsNull(0); // ref.is_null
    b.if(0x7f);
    b.i32Const(0);
    b.els();
    b.localGet(0);
    b.refTest(w.I31REF, true); // ref.test (ref null i31)
    b.if(0x7f);
    b.localGet(0);
    i31of(b); // i31.get_u
    b.els();
    b.i32Const(1);
    b.end();
    b.end();
  }
  // $eq(a: anyref, b: anyref) -> anyref bool: JS === — nums by f64
  // payload, bools by i31 payload, strings by i16 content, slices/tuples/
  // closures by identity (ref.cast (ref null eq) + ref.eq; a slice's
  // identity is its immutable wrapper), unit (null) equal only to unit.
  {
    const b = eq.body;
    const res = eq.i32();
    // decided: a typed path (or the null mismatch) already answered.
    const decided = eq.i32();
    // both: both operands are bool i31s (shared by the IF and decided).
    const both = eq.i32();
    b.i32Const(0);
    b.localSet(decided);
    // null ladder: equal nulls → true, one null → false.
    b.localIsNull(0);
    b.localIsNull(1);
    b.num(w.EQ);
    b.if(0x7f);
    b.localIsNull(0);
    b.els();
    b.i32Const(0);
    b.end();
    b.localSet(res);
    // one null, one not: the ladder answered (false).
    b.localIsNull(0);
    b.localIsNull(1);
    b.num(w.EQ);
    b.num(w.EQZ);
    b.localSet(decided);
    // bool == bool: i31 payloads (the shape test is computed once and
    // reused for the decided flag below).
    b.localGet(0);
    b.refTest(w.I31REF, true);
    b.localGet(1);
    b.refTest(w.I31REF, true);
    b.num(w.AND);
    b.localSet(both);
    b.localGet(both);
    b.if();
    b.localGet(0);
    i31of(b);
    b.localGet(1);
    i31of(b);
    b.num(w.EQ);
    b.localSet(res);
    // decided: the bool path answered.
    b.localGet(both);
    b.localGet(decided);
    b.num(w.OR); // i32.or
    b.localSet(decided);
    b.end();
    // Numeric equality matches the interpreter's JS === on values exactly
    // (any-typed sites land here; same-width sites are decided statically):
    //   wide ($I64/$U64) vs wide — same shape: bitwise i64.eq (equal bits
    //     ⟺ equal values within one width); mixed shapes: bits equal AND
    //     the signed side non-negative (JS compares the BigInt values —
    //     -1n is not 18446744073709551615n even though the bits match);
    //   wide vs f64-family ($F64/$F32/$I32/$U32): never equal (BigInt is
    //     never === a Number);
    //   f64-family vs f64-family: adaptive read to f64, f64.eq (the JS
    //     Number ===: +0 == -0, NaN != NaN; i32/u32/f32 payloads promote
    //     exactly).
    {
      // shapeBit(v, shapes, bit, extra?): bit = OR of ref.test(v) over
      // shapes (and extra, e.g. the wide bit for isNum) — instructions
      // chain on the stack, one local.set at the end.
      const shapeBit = (v: number, shapes: number[], bit: number, extra?: number): void => {
        b.localGet(v);
        b.refTest(shapes[0], true);
        for (let i = 1; i < shapes.length; i++) { b.localGet(v); b.refTest(shapes[i], true); b.num(w.OR); }
        if (extra !== undefined) { b.localGet(extra); b.num(w.OR); }
        b.localSet(bit);
      };
      const aW = eq.i32(), bW = eq.i32(), aN = eq.i32(), bN = eq.i32();
      shapeBit(0, [9, 10], aW);
      shapeBit(1, [9, 10], bW);
      shapeBit(0, [0, 7, 8, 11], aN, aW);
      shapeBit(1, [0, 7, 8, 11], bN, bW);
      // Both numeric? the numeric ladder answers (decided = 1).
      b.localGet(aN);
      b.localGet(bN);
      b.num(w.AND);
      b.if();
      b.i32Const(1);
      b.localGet(decided);
      b.num(w.OR);
      b.localSet(decided);
      b.localGet(aW);
      b.localGet(bW);
      b.num(w.AND);
      b.if();
      // wide vs wide: payloads (the raw bits), then the mixed-shape rule.
      // readWide leaves v's raw i64 payload on the stack ($I64 box or the
      // $U64 box reinterpreted bitwise).
      const readWide = (v: number): void => {
        unboxArm(b, 0x7e, 9, [], v, true); // $I64 payload; else $U64
        b.localGet(v);
        b.readBoxPayload(10);
        b.end();
      };
      const pa = eq.i64(), pb = eq.i64(), bitsEq = eq.i32();
      readWide(0);
      b.localSet(pa);
      readWide(1);
      b.localSet(pb);
      // res = bits equal AND the signed side (if any) is non-negative.
      b.localGet(pa);
      b.localGet(pb);
      b.num(w.I64_EQ);
      b.localSet(bitsEq);
      // signedNeg: whichever operand sits in an $I64 box reads as a signed
      // BigInt — a negative one is never === the unsigned reinterpretation.
      b.localGet(0);
      b.refTest(9, true);
      b.if(0x7f);
      b.localGet(pa);
      b.i64Const(0n);
      b.num(w.I64_LTS);
      b.els();
      b.localGet(1);
      b.refTest(9, true);
      b.if(0x7f);
      b.localGet(pb);
      b.i64Const(0n);
      b.num(w.I64_LTS);
      b.els();
      b.i32Const(0);
      b.end();
      b.end();
      b.num(w.EQZ);
      b.localGet(bitsEq);
      b.num(w.AND);
      b.localSet(res);
      b.els();
      // not both wide: exactly one wide → BigInt is never === a Number;
      // both f64-family → adaptive reads + f64 compare (Number ===).
      b.localGet(aW);
      b.localGet(bW);
      b.num(w.OR);
      b.if();
      b.i32Const(0);
      b.localSet(res);
      b.els();
      // f64-family vs f64-family: adaptive reads + f64 compare.
      b.localGet(0);
      b.callFn(em.ix.fNum64);
      b.localGet(1);
      b.callFn(em.ix.fNum64);
      b.num(w.FEQ);
      b.localSet(res);
      b.end();
      b.end();
      b.end();
    }
    // str == str: i16 content.
    b.localGet(0);
    b.refTest(2, true);
    b.localGet(1);
    b.refTest(2, true);
    b.num(w.AND);
    b.if();
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
    b.num(w.EQ);
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
      b.num(w.EQ);
      b.num(w.AND);
      b.localSet(res);
    });
    b.end();
    // Mixed/same-shape-arr/clo → identity (both operands cast through
    // (ref null eq); a nullable cast accepts null but the null ladder
    // already left). Only runs when no typed path answered.
    b.localGet(decided);
    b.num(w.EQZ);
    b.if();
    b.localGet(0);
    b.refCast(w.EQREF, true);
    b.localGet(1);
    b.refCast(w.EQREF, true);
    b.refEq();
    b.localSet(res);
    b.end();
    b.localGet(res);
    b.refI31();
  }
  // $box(x: f64) -> anyref: number struct.
  box.body.localGet(0);
  box.body.structNew(0);
  // $num64(v: anyref) -> f64: adaptive numeric unbox for the f64 plane —
  // $F64 payload as-is; an $F32 box promotes (exact): float-wildcard
  // values can flow into f64-plane positions (builtin params,
  // counters), so numeric unboxes must accept both shapes.
  ladderBody(num64.body, {
    ret: 0x7c, // __num's shape: (anyref) -> f64
    // $F64 first (the common case for well-typed f64 sites pays one
    // refTest), then $F32 promotes, the int boxes convert (each box's own
    // signedness); a non-number still traps at the default cast.
    arms: [[0, []], ...NUM64_ARMS],
    defOps: [],
  });
  // Adaptive unbox helpers. Each reads ANY of the
  // numeric box shapes into its width, applying the conversion the
  // interpreter's per-node normalization applies when a value that flexed
  // into a narrower/wider position arrives in a foreign box:
  //   $f32of: $F32 payload; $F64 demotes; $I32/$U32/I64/U64 convert
  //           (signed per the box's own width);
  //   $i32of/$u32of: $I32/$U32 payload (the bits are the value); $I64/$U64
  //           wrap to the low 32 bits (signedness-free); $F64 truncates;
  //   $i64of/$u64of: $I64/$U64 payload; $I32 sign-extends / $U32
  //           zero-extends (the box's own semantics); $F64 truncates.
  // A non-number operand still traps at the default ref.cast (the frozen
  // deviation for dynamically non-numeric values).
  ladderBody(f32of.body, {
    ret: 0x7d,
    arms: [[11, []], [7, [w.CONV_F32_I32]], [8, [w.CONV_F32_U32]], [9, [w.CONV_F32_I64]], [10, [w.CONV_F32_U64]]],
    defOps: [w.F32_DEMOTE], // default: $F64 demote
  });
  // The signed/unsigned of-family: own box leads, the sibling shape is
  // arm 2, the remaining int boxes convert (the box's own signedness);
  // the default reads $F64 and truncates (wrapping to 32 bits too there).
  const ofPair = (f: Fn, ret: number, own: number, sib: number, conv: [number, number[]][], defOps: number[]): void =>
    ladderBody(f.body, {ret, arms: [[own, []], [sib, []], ...conv], defOps});
  ofPair(i32of, 0x7f, 7, 8, [[9, [w.I32_WRAP_I64]], [10, [w.I32_WRAP_I64]]], [w.I64_TRUNC_F64, w.I32_WRAP_I64]);
  ofPair(u32of, 0x7f, 8, 7, [[9, [w.I32_WRAP_I64]], [10, [w.I32_WRAP_I64]]], [w.I64_TRUNC_F64, w.I32_WRAP_I64]);
  ofPair(i64of, 0x7e, 9, 10, [[7, [w.I64_EXTEND_I32_S]], [8, [w.I64_EXTEND_I32_U]]], [w.I64_TRUNC_F64]);
  ofPair(u64of, 0x7e, 10, 9, [[7, [w.I64_EXTEND_I32_S]], [8, [w.I64_EXTEND_I32_U]]], [w.I64_TRUNC_F64]);
  return [truthy, eq, box, num64, f32of, i32of, u32of, i64of, u64of];
}

type CallOpts = {
  tail?: boolean,      // statement-tail position: pass the ambient k through
  land?: boolean,      // lambda call site: land through a RET cell
  kL?: number,         // the ambient continuation local (default 1)
  landA?: number,      // explicit per-iteration land cell (map/each/flatmap)
  landFrameE?: () => void, // the land cell's frame operand (map-like loops:
                       // a fresh per-iteration $FRAME; default: local 0)
  direct?: {idx: number, fsize: number, envClo?: boolean}, // direct builtin: static funcref + fsize
  dabi?: true,         // the callee entry is ((ref null $FRAME)) -> anyref:
                       // no continuation operand; tail keeps the result as
                       // this fn's return, non-tail leaves it on the stack
                       // (the returned local) for the caller to store
};

export function emitCallClosure(f: Fn, fc: number, argc: number, argEmit: (k: number, ffp: number) => void, opts: CallOpts = {}): number | undefined {
  const {tail = false, land = false, kL = 1, landA, landFrameE, direct} = opts;
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
    if (direct.envClo === true) {
      b.localGet(fc);
      b.refCast(6, true);
      b.structGet(6, 1);
      b.localSet(cf);
    } else {
      b.refNull(4); // env: builtins run over the call frame itself
      b.localSet(cf);
    }
    b.i32Const(direct.fsize);
    b.localSet(fs);
  }
  // Slot count = max(fs, argc) — the slots array holds the params and the
  // body's lets (fs) or all the args, whichever is longer. (argc readers
  // use array.len instead of a stored argc field — valid only because the
  // sole argc reader is `list`, whose fsize is 0.)
  const allocFrame = (): void => {
    b.localGet(fs);
    b.i32Const(argc);
    b.localGet(fs);
    b.i32Const(argc);
    b.num(w.GTU);
    b.select();
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
  };
  allocFrame();
  for (let k = 0; k < argc; k++) argEmit(k, ffp);
  b.localGet(ffp);
  b.refCast(4, true); // the call's frame param (ffp is an anyref local)
  if (opts.dabi === true) {
    // Direct ABI: no continuation operand. The frame alloc + arg stores
    // above are shared with the generic path.
    if (direct === undefined) {
      b.localGet(idx);
      b.callIndirect(w.T_DABI, tail);
    } else {
      b.callFn(direct.idx, tail);
    }
    if (tail) return undefined;
    const r = f.anyref();
    b.localSet(r);
    return r;
  }
  // Continuation selection: tail calls pass the ambient/resolved k through
  // (the IR's only shape — the term has nothing after a call); map-like
  // loop-entry thunks land the callback's completion in their per-iteration
  // cell (landA) with next = the ambient k.
  if (tail) { b.localGet(kL); b.refCast(5, true); } // tail call: pass the ambient continuation through
  else if (land) {
    // Land-style RET cell ending the caller's body: used inside loop-entry
    // thunks (map-like builtins), where the callback's result lands in the
    // per-iteration thunk `landA` instead of the generic per-site dispatcher
    // and the loop continues from there. The call is a tail call: the
    // callback's completion always tails into landA (never returns here),
    // and a terminal k=0 return must unwind past the whole loop to the
    // caller's own call site.
    b.localGet(f.retCell(landA!, () => b.localGet(kL), 0, landFrameE)); // next = ambient k
    b.refCast(5, true);
  } else b.refNull(5); // k=0 (ref.null $K): the callee's dispatch returns its value inline
  if (direct === undefined) {
    b.localGet(idx);
    b.callIndirect(w.T_KABI, tail || land);
  } else {
    b.callFn(direct.idx, tail || land);
  }
  return undefined;
}

// The direct-ABI branch shared by every unknown-kind call site: the
// closure's flag said direct — build the callee frame over its env (the
// same alloc the generic path makes), call the T_DABI entry, and deliver
// the result the way the site's continuation would: through the ambient
// chain head, through an explicit land cell, or — at a tail — as this fn's
// own return. `st` (devirt provenance) makes the call static: fun/fsize
// come from the plan, only the env still reads off the closure value —
// envs differ per activation even when the fun index is known.
export function emitDirectEntryCall(
  em: Emit, f: Fn, clob: number, argc: number, argEmit: (k: number, ffp: number) => void,
  deliver: {kind: "k", kL: number} | {kind: "land", landA: number, kL: number, landFrameE?: () => void} | {kind: "tail"} | {kind: "raw"},
  st?: {idx: number, fsize: number, noEnv?: true},
): number {
  const b = f.body;
  const idx = f.i32(), cf = f.anyref(), fs = f.i32(),
    maxL = f.i32(), slots = f.anyref(), ffp = f.anyref();
  // The callee's frame parent = the closure's captured env: a direct body's
  // scopes chain from its own (caller-allocated) frame up through the
  // frames live at its mkfn site — exactly the $CLO's env. The caller's
  // current local 0 would be wrong (deeper scopes since the mkfn ran).
  // With st.noEnv the callee has no capts — nothing outside its own frame
  // is ever read — so the parent is a plain null.
  if (st?.noEnv === true) {
    b.refNull(4);
    b.localSet(cf);
  } else {
    b.localGet(clob); b.refCast(6, true); b.structGet(6, 1); b.localSet(cf);
  }
  if (st === undefined) {
    b.localGet(clob); b.refCast(6, true); b.structGet(6, 0); b.i31Get();
    b.localSet(idx);
    b.localGet(clob); b.refCast(6, true); b.structGet(6, 2); b.i31Get();
    b.localSet(fs);
  } else {
    b.i32Const(st.idx);
    b.localSet(idx);
    b.i32Const(st.fsize);
    b.localSet(fs);
  }
  b.localGet(fs); b.i32Const(argc);
  b.localGet(fs); b.i32Const(argc);
  b.num(w.GTU);
  b.select();
  b.localSet(maxL);
  b.localGet(maxL);
  b.arrayNew(1);
  b.localSet(slots);
  b.localGet(cf);
  b.refCast(4, true);
  b.localGet(slots);
  b.refCast(1, true);
  b.structNew(4);
  b.localSet(ffp);
  for (let k = 0; k < argc; k++) argEmit(k, ffp);
  b.localGet(ffp);
  b.refCast(4, true);
  if (deliver.kind === "tail") {
    if (st === undefined) {
      b.localGet(idx);
      b.callIndirect(w.T_DABI, true);
    } else {
      b.callFn(st.idx, true);
    }
    return -1;
  }
  if (st === undefined) {
    b.localGet(idx);
    b.callIndirect(w.T_DABI, false);
  } else {
    b.callFn(st.idx);
  }
  const v = f.anyref();
  b.localSet(v);
  if (deliver.kind === "k") {
    emitDispatch(em, f, v, deliver.kL);
  } else if (deliver.kind === "raw") {
    return v; // the caller owns the result local
  } else {
    const cell = f.retCell(deliver.landA, () => b.localGet(deliver.kL), 0, deliver.landFrameE);
    emitDispatch(em, f, v, cell);
  }
  return v;
}

// The numeric direct-ABI entry of a devirt-annotated callee: the closure's
// env is the frame operand (the entry extends it into its activation frame
// itself — the call allocates nothing and boxes nothing), the args ride as
// raw operands at the entry's param widths, and the raw result comes back
// reboxed at the entry's return width. Signature and funcref index come
// from the plan (the boxed entry's st is not consulted).
export function emitNumericEntryCall(
  em: Emit, f: Fn, clob: number, argc: number, argRaw: (k: number) => void,
  deliver: {kind: "raw"} | {kind: "k", kL: number},
  num: {ws: string[], r: string, funcref: number, noEnv?: true},
  rawRet?: string,
): number {
  const b = f.body;
  const cf = f.anyref();
  if (num.noEnv === true) {
    b.refNull(4);
    b.localSet(cf);
  } else {
    b.localGet(clob); b.refCast(6, true); b.structGet(6, 1); b.localSet(cf);
  }
  b.localGet(cf);
  b.refCast(4, true);
  for (let k = 0; k < argc; k++) argRaw(k);
  b.callFn(num.funcref);
  // rawRet (a typed destination slot at the entry's return width) parks
  // the raw valtype in its plane local — no rebox round trip; the caller
  // stores it with raw: true.
  const v = rawRet === undefined ? reboxCallResult(em, f, num.r) : reboxCallResult(em, f, rawRet, true);
  if (deliver.kind === "k") emitDispatch(em, f, v, deliver.kL);
  return v;
}

// One rest-of-site fragment: a T_III_I function (frame, v, kNext) -> anyref
// registered in the funcref table. The IR emitter uses these as letk
// continuation thunks; the map-like builtins as loop-entry/iteration land
// cells.
export function makeRestThunk(em: Emit, role?: string): Fn {
  const f = new Fn(3, em);
  em.reg.register(`thunk${em.thunks.length}`, f, w.T_III_I);
  if (DBGEMIT && role !== undefined) console.error("THUNK", f.idx, role);
  em.thunks.push(f);
  return f;
}

// Runtime trace point (EFTRACE=1): one ef_trace(site, val) host call; the
// host keeps a ring buffer of (site, val) and prints it when a runtime
// trap escapes (a trap otherwise loses all location info). `label` names
// the site in TRACE_SITES; `pushVal` emits the val operand (0 when
// omitted). No-op (and free) when tracing is off.
export function tracePoint(em: Emit, f: Fn, label: string, pushVal?: () => void): void {
  if (!DBGTRACE) return;
  const imp = em.o.impIdx.get("ef_trace");
  if (imp === undefined) return;
  const id = TRACE_SITES.push(label) - 1;
  const b = f.body;
  b.i32Const(id);
  if (pushVal === undefined) b.i32Const(0);
  else pushVal();
  b.callFn(imp);
}

export function emitDispatch(em: Emit, f: Fn, v: number, k = 1): void {
  const b = f.body;
  const kind = () => { cellGet(b, k, 0); b.i31Get(); };
  b.block(w.ANYREF); // block (result anyref)
  b.loop();
  b.localIsNull(k); // ref.is_null: final return → the value itself
  b.if();
  tracePoint(em, f, `d f${f.fid}(idx${f.idx}) null-k`);
  b.localGet(v);
  b.br(2); // leave the block with v
  b.end();
  kind(); b.i32Const(w.K_RET); b.num(w.EQ);
  b.if();
  tracePoint(em, f, `d f${f.fid}(idx${f.idx}) K_RET`);
  cellFrame(b, k);
  b.localGet(v);
  cellGet(b, k, 3);
  cellGet(b, k, 1); i31of(b);
  b.callIndirect(w.T_III_I, true);
  b.end();
  // K_BND: the handler-boundary sentinel — resolve the Return delivery
  // through the hctx global's innermost $HDLCTX entry (handler boundaries
  // never sit in K-cell chains). Only kind==K_BND scans. The arm is emitted
  // only when the program contains a handle: sentinel cells enter a chain
  // solely via handle emission, so a handle-free program's scan is dead
  // code — skipping it drops a nested scan loop (plus ~30 instructions of
  // table probing) from every dispatch site.
  if (em.d.hasHandle) {
    kind(); b.i32Const(w.K_BND); b.num(w.EQ);
    b.if();
    tracePoint(em, f, `d f${f.fid}(idx${f.idx}) K_BND`);
    const entry = f.anyref(), tbl = f.anyref();
    b.globalGet(em.lay.ctxG);
    b.localSet(entry);
    hdlGet(b, entry, 1);
    b.localSet(tbl);
    const {found, fnIdx, nparams} = emitCaseScan(f, tbl, () => b.i32Const(-1));
    b.localGet(found);
    b.if();
    // Return case: store v into the hframe's Return param slot, pop the
    // boundary (hctx := outer), then tail-call the case body as
    // (hframe, kret) — the paper's ret clause discarding the effect
    // continuation. kret is the entry's delivery target: the handle's own
    // continuation on the first run, the resumer's k2 on a fresh entry.
    const hf = f.typed(_T.RF[4]);
    hdlGet(b, entry, 2);
    b.refCast(4, true);
    b.localSet(hf);
    b.localGet(hf);
    b.structGet(4, 1);
    b.localGet(nparams); b.i32Const(1); b.num(w.ADD);
    b.localGet(v);
    b.arraySet();
    const outer = f.anyref();
    hdlGet(b, entry, 3);
    b.localSet(outer);
    b.localGet(outer);
    b.globalSet(em.lay.ctxG);
    const kn = f.typed(_T.RF[5]);
    hdlGet(b, entry, 4);
    b.localSet(kn);
    b.localGet(hf);
    b.localGet(kn);
    b.localGet(fnIdx);
    b.callIndirect(w.T_KABI, true);
    b.end();
    // The table always ends with a -1 row (explicit Return, identityRet,
    // or idRet) — the scan cannot miss.
    b.unreachable();
    b.end(); // kind==K_BND guard
  }
  // No Return case: k = k.next and dispatch again.
  cellGet(b, k, 3);
  b.localSet(k);
  b.br(0);
  b.end(); // loop
  b.unreachable(); // unreachable: the loop exits only through the k==0 branch
  b.end(); // block
}

// Calls ef_fail(code, name, a, b, c); the import throws, so unreachable.
// `name` is a $STR static global index (field-access failures) or null; a/b/c
// carry f64 payloads (indices converted from i64/i32; sub's message needs
// all three: from, to, len).
export function emitFail(em: Emit, f: Fn, code: number, nameG: number | null, pushA: () => void, pushB: () => void, pushC: () => void): void {
  const b = f.body;
  b.i32Const(code);
  if (nameG === null) b.refNull(w.ANYREF);
  else b.globalGet(nameG);
  pushA();
  pushB();
  pushC();
  b.callFn(em.o.impIdx.get("ef_fail")!);
  b.unreachable(); // unreachable
}

// true/false i31 selected by the i32 condition emitted by emitCond.
// `emitCond` pushes the i32 condition; omit it when the condition is
// already on the stack.
export function selectBool(em: Emit, f: Fn, emitCond?: () => void): void {
  const b = f.body;
  const t = f.i32();
  emitCond?.();
  b.localSet(t);
  f.pushRef(em.lay.trueRef);
  f.pushRef(em.lay.falseRef);
  b.localGet(t);
  const cond = b.pop(), v2 = b.pop(), v1 = b.pop();
  b.push(MOD.if(cond, v1, v2)); // ref select: binaryen's select() is numeric-only
}

export const CMP_OPS: Record<string, Record<string, number>> = {
  "<":  {f32: w.F32_LT, i32: w.LTS, u32: w.LTU, i64: w.I64_LTS, u64: w.I64_LTU, f64: w.FLT},
  ">":  {f32: w.F32_GT, i32: w.GTS, u32: w.GTU, i64: w.I64_GTS, u64: w.I64_GTU, f64: w.FGT},
  "<=": {f32: w.F32_LE, i32: w.LES, u32: w.LEU, i64: w.I64_LES, u64: w.I64_LEU, f64: w.FLE},
  ">=": {f32: w.F32_GE, i32: w.GES, u32: w.GEU, i64: w.I64_GES, u64: w.I64_GEU, f64: w.FGE},
};

