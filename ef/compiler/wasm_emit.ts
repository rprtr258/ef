// Expression and statement emission of the wasm backend: every AST node
// compiles through expr() (§3) and the effect machinery emitters (perform
// §4.2, handle §4.4, split-mode if/while §6), plus the helper/case/lambda
// function bodies. The §-numbered design doc for the whole backend lives
// at the top of wasm.ts.
import {type Expr, type ExprID, type Program} from "./parser.ts";
import {BUILTINS} from "./analysis.ts";
import {Ctx, INLINE, Scope, ValueRef, WasmError, _T} from "./wasm_types.ts";
import {DBGEMIT, OPERATOR_OPS, mapLikeFrameWords} from "./wasm_tables.ts";
import {Fn} from "./wasm_body.ts";
import {frameSizeOf, resolve, splits, type Discovery, type Indices, type Layout, type Opt} from "./wasm_pipeline.ts";
import * as w from "./wasm_consts.ts";
import {assertNever} from "./assert.ts";

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
// Signature of a direct-call target by funcref index: imports carry their
// type by name; defined functions registered at index assignment.





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
export class Split extends Error {
  constructor(
    public restFn: Fn,
    public chain: ExprID[],
  ) { super("internal: compile-time split"); }
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
export type Splits = {
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
export type Emit = {
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
export function emitLambdas(em: Emit, id: ExprID): void {
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
    case "as":
      emitLambdas(em, e.e);
      break;
    case "handle":
      emitLambdas(em, e.body);
      for (const c of e.cases) emitLambdas(em, c.body);
      break;
    case "perform":
      for (const a of e.args) emitLambdas(em, a);
      break;
    case "num":
    case "str":
    case "bool":
    case "unit":
    case "sym":
      break;
    default:
      assertNever(e);
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
export function emitCaseFns(em: Emit): void {
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
export function fillRest(em: Emit, sp: Split, root: ExprID[], sc: Scope, tail: boolean): void {
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

export function emitHelpers(em: Emit): Fn[] {
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
    // num == num: adaptive unbox ($F64 payload or promoted $F32 payload —
    // the promote is exact, so f64 comparison of promoted f32s matches f32
    // equality) then f64 compare.
    b.localGet(0);
    b.refTest(0, true);
    b.localGet(1);
    b.refTest(0, true);
    b.u8(w.OR);
    b.u8(w.IF);
    b.u8(0x40);
    b.localGet(0);
    b.u8(w.CALL);
    b.lebU(em.ix.fNum64);
    b.localGet(1);
    b.u8(w.CALL);
    b.lebU(em.ix.fNum64);
    b.u8(w.FEQ);
    b.localSet(res);
    // decided: the num path answered.
    b.localGet(0);
    b.refTest(0, true);
    b.localGet(1);
    b.refTest(0, true);
    b.u8(w.OR);
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
  // $num64(v: anyref) -> f64: adaptive numeric unbox for the f64 plane —
  // $F64 payload as-is; an $F32 box promotes (exact). Typed-widths step 2:
  // float-wildcard values can flow into f64-plane positions (builtin params,
  // counters), so numeric unboxes must accept both shapes.
  const num64 = new Fn(1, em);
  num64.typeIdx = 19; // __num's shape: (anyref) -> f64 (sig pre-registered in assignIndices)
  {
    const b = num64.body;
    b.localGet(0);
    b.refTest(11, false);
    b.u8(w.IF);
    b.u8(0x7c);
    b.localGet(0);
    b.refCast(11, false);
    b.structGet(11, 0);
    b.u8(w.F64_PROMOTE);
    b.u8(w.ELSE);
    b.localGet(0);
    b.refCast(0, false);
    b.structGet(0, 0);
    b.u8(w.END);
  }
  // $f32of(v: anyref) -> f32: adaptive numeric unbox for f32 sites — $F32
  // payload as-is; an $F64 box demotes (the operand-width adaptation for
  // wildcard values that flexed into f32 positions; matches the
  // interpreter's fround normalization of f32-stamped reads).
  const f32of = new Fn(1, em);
  f32of.typeIdx = w.T_F32; // (anyref) -> f32 (sig pre-registered in assignIndices)
  {
    const b = f32of.body;
    b.localGet(0);
    b.refTest(11, false);
    b.u8(w.IF);
    b.u8(0x7d);
    b.localGet(0);
    b.refCast(11, false);
    b.structGet(11, 0);
    b.u8(w.ELSE);
    b.localGet(0);
    b.refCast(0, false);
    b.structGet(0, 0);
    b.u8(w.F32_DEMOTE);
    b.u8(w.END);
  }
  return [truthy, eq, box, capture, num64, f32of];
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
export function emitCallClosure(em: Emit, f: Fn, fc: number, argc: number, argEmit: (k: number, ffp: number) => void, tail = false, land = false, kL = 1, noSplit = false, landA?: number, direct?: {idx: number, fsize: number}): void {
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
export function makeRestThunk(em: Emit, role?: string): Fn {
  const f = new Fn(3, em);
  f.typeIdx = w.T_III_I;
  f.idx = em.ix.thunk0 + em.thunks.length;
  em.ix.funcRefTypes.set(f.idx, w.T_III_I);
  if (DBGEMIT && role !== undefined) console.error("THUNK", f.idx, role);
  em.thunks.push(f);
  return f;
}

export function emitDispatch(em: Emit, f: Fn, v: number, k = 1): void {
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
export function emitFail(em: Emit, f: Fn, code: number, nameG: number | null, pushA: () => void, pushB: () => void): void {
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
export function selectBool(em: Emit, f: Fn, emitCond: () => void): void {
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
  // Typed-widths step 2: f32-stamped sites compute with the f32 opcode
  // family on $F32 boxes; everything else stays on the f64 plane (steps 3-4
  // grow the int widths). Operand unboxing goes through $f32of/$num64, the
  // adaptive helpers: a wildcard value that flexed into an f32 position may
  // still sit in an $F64 box.
  const f32 = e.numKind === "f32";
  // Operand cut modes, mirroring the `/` path: the arg holding the cut
  // site continues the fragment ("cut"), an earlier sibling reloads its
  // spill ("pre"), a later sibling re-emits fresh ("post").
  const argMode = (i: number): "cut" | "pre" | "post" =>
    ci === i + 1 ? "cut" : i === 0 && ci > 1 ? "pre" : "post";
  const pushArg = (i: number): void => {
    f.pushRef(cutChildRef(em, e.args[i], f, s, ctx, argMode(i)));
  };
  // Unbox the just-pushed operand ref to an f32/f64 local.
  const unbox = (_i: number, loc: number): void => {
    if (f32) {
      b.u8(w.CALL);
      b.lebU(em.ix.fF32of);
    } else {
      b.u8(w.CALL);
      b.lebU(em.ix.fNum64);
    }
    b.localSet(loc);
  };
  switch (name) {
    case "+": {
      if (f32) {
        const x = f.f32(), y = f.f32();
        pushArg(0); unbox(0, x);
        pushArg(1); unbox(1, y);
        b.localGet(x); b.localGet(y); b.u8(w.F32_ADD);
        b.structNew(11);
        break;
      }
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
      const x = f32 ? f.f32() : f.f64(), y = f32 ? f.f32() : f.f64();
      pushArg(0); unbox(0, x);
      pushArg(1); unbox(1, y);
      if (name === "%") {
        // JS fmod: a - b * trunc(a/b)
        const t = f.f64();
        b.localGet(x); b.localGet(y); b.u8(f32 ? w.F32_DIV : w.FDIV); b.u8(f32 ? w.F32_TRUNC : w.FTRUNC); b.localSet(t);
        b.localGet(x); b.localGet(y); b.localGet(t); b.u8(f32 ? w.F32_MUL : w.FMUL); b.u8(f32 ? w.F32_SUB : w.FSUB);
      } else {
        b.localGet(x); b.localGet(y); b.u8(name === "-" ? (f32 ? w.F32_SUB : w.FSUB) : (f32 ? w.F32_MUL : w.FMUL));
      }
      if (f32) b.structNew(11);
      else { b.u8(w.CALL); b.lebU(em.ix.fBox); }
      break;
    }
    case "neg": {
      const x = f32 ? f.f32() : f.f64();
      pushArg(0); unbox(0, x);
      b.localGet(x);
      b.u8(f32 ? w.F32_NEG : w.FNEG);
      if (f32) b.structNew(11);
      else { b.u8(w.CALL); b.lebU(em.ix.fBox); }
      break;
    }
    case "<": case ">": case "<=": case ">=": {
      const x = f32 ? f.f32() : f.f64(), y = f32 ? f.f32() : f.f64();
      pushArg(0); unbox(0, x);
      pushArg(1); unbox(1, y);
      const cmp = name === "<" ? (f32 ? w.F32_LT : w.FLT) : name === ">" ? (f32 ? w.F32_GT : w.FGT) : name === "<=" ? (f32 ? w.F32_LE : w.FLE) : (f32 ? w.F32_GE : w.FGE);
      selectBool(em, f, () => {
        b.localGet(x);
        b.localGet(y);
        b.u8(cmp);
      });
      break;
    }
    case "==": case "!=": {
      if (f32) {
        const x = f.f32(), y = f.f32();
        pushArg(0); unbox(0, x);
        pushArg(1); unbox(1, y);
        selectBool(em, f, () => {
          b.localGet(x); b.localGet(y); b.u8(w.F32_EQ);
        });
        if (name === "!=") {
          // negate: the i31 bool payload flips
          b.refCast(w.I31REF, false);
          b.i31Get();
          b.u8(w.EQZ);
          selectBool(em, f, () => {});
        }
        break;
      }
      pushArg(0); pushArg(1);
      b.u8(w.CALL); b.lebU(em.ix.fEq);
      if (name === "!=") {
        b.refCast(w.I31REF, false); // eq result's i31 bool payload
        b.i31Get();
        b.u8(w.EQZ); // 1 when $eq said false
        selectBool(em, f, () => {});
      }
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

export function expr(em: Emit, id: ExprID, f: Fn, sc?: Scope, tail = false, ctx: Ctx = INLINE): ValueRef {
  // Typed-widths step 2 removed the old implicit f32 demote/promote
  // round-trip that used to live here: f32-stamped nodes now produce real
  // $F32 boxes (typed ops, $F32 statics, explicit @as conversions) and
  // operand-width adaptation happens in $f32of/$num64 at unbox sites.
  return exprInner(em, id, f, sc, tail, ctx);
}

function exprInner(em: Emit, id: ExprID, f: Fn, sc?: Scope, tail = false, ctx: Ctx = INLINE): ValueRef {
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
      // The static's key carries the node's stamped width (f32 literals box
      // as $F32; everything else rides the f64 plane in step 2).
      return {k: "g", gi: em.lay.numStatics.get(`${e.numKind === "f32" ? "f32" : "f64"}:${e.v}`)!};
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
    case "as": {
      // @as conversion, per-width (typed-widths step 2 implements the float
      // half; int↔int lands in steps 3-4). Box shapes adapt at the unbox:
      // a wildcard value that flexed into an f32-typed slot still sits in
      // an $F64 box, so f32 reads go through $f32of (whose $F64 arm applies
      // the f32 rounding the interpreter's f32-stamped reads apply) and
      // f64-plane reads through $num64 (promote arm for real $F32 boxes).
      const targetW = e.typ.tag === "prim" ? e.typ.name : "";
      const childF32 = (em.nodes[e.e] as Expr & {numKind?: string}).numKind === "f32";
      const v = f.anyref();
      const childRef = expr(em, e.e, f, s, false, cut === undefined ? ctx : {kL: ctx.kL, cut: cut.slice(1)});
      if (targetW === "f32") {
        if (e.asKind === "boolnum") {
          f.pushRef(childRef);
          b.refCast(w.I31REF, false); // boolnum: i31 bool payload -> 0/1
          b.i31Get();
          b.u8(w.CONV_I32); // f64.convert_i32_s
          b.u8(w.F32_DEMOTE);
          b.structNew(11);
          b.localSet(v);
          return {k: "local", l: v};
        }
        if (childF32) {
          // f32 -> f32: forward (the box shape adapts at the next unbox).
          return childRef;
        }
        // f64-plane source -> f32: adapt + rebox ($f32of's $F64 arm is the
        // explicit demote this conversion performs).
        f.pushRef(childRef);
        b.u8(w.CALL);
        b.lebU(em.ix.fF32of);
        b.structNew(11);
        b.localSet(v);
        return {k: "local", l: v};
      }
      if (childF32) {
        // f32-typed source -> f64-plane target: adapt to the f32-rounded
        // payload ($f32of), widen exactly, then the f64-plane path.
        f.pushRef(childRef);
        b.u8(w.CALL);
        b.lebU(em.ix.fF32of);
        b.u8(w.F64_PROMOTE);
        if (e.asKind === "trunc") b.u8(w.FTRUNC);
        b.u8(w.CALL);
        b.lebU(em.ix.fBox);
        b.localSet(v);
        return {k: "local", l: v};
      }
      if (e.asKind === "trunc") {
        f.pushRef(childRef);
        b.refCast(0, false);
        b.structGet(0, 0);
        b.u8(w.FTRUNC);
        b.u8(w.CALL);
        b.lebU(em.ix.fBox);
        b.localSet(v);
        return {k: "local", l: v};
      }
      if (e.asKind === "boolnum") {
        f.pushRef(childRef);
        b.refCast(w.I31REF, false); // boolnum: i31 bool payload -> f64 0/1
        b.i31Get();
        b.u8(w.CONV_I32);
        b.u8(w.CALL);
        b.lebU(em.ix.fBox);
        b.localSet(v);
        return {k: "local", l: v};
      }
      // Value-preserving into the f64 plane from an f64 source: forward the
      // child ref (already an $F64 box or non-numeric).
      return childRef;
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
        // the checker rejects non-num arithmetic statically). f32-stamped
        // sites compute typed f32 division (step 2); int/float on the f64
        // plane keep the f64 path with the int truncation stamp.
        const f32Div = e.numKind === "f32";
        if (ci === 0) throw new WasmError("internal: split chain root mismatch");
        f.pushRef(cutChildRef(em, e.args[0], f, s, ctx, ci === 1 ? "cut" : ci < 0 ? "post" : "pre"));
        if (f32Div) {
          b.u8(w.CALL);
          b.lebU(em.ix.fF32of);
        } else {
          b.refCast(0, false);
          b.structGet(0, 0);
        }
        f.pushRef(cutChildRef(em, e.args[1], f, s, ctx, ci === 2 ? "cut" : "post"));
        if (f32Div) {
          b.u8(w.CALL);
          b.lebU(em.ix.fF32of);
        } else {
          b.refCast(0, false);
          b.structGet(0, 0);
        }
        b.u8(f32Div ? w.F32_DIV : w.FDIV);
        if (!f32Div && e.div === "int") b.u8(w.FTRUNC);
        // Box inline (never return_call $box: at a tail position the raw
        // return would bypass the caller's RET cell — the wrapper's
        // dispatch must see the value).
        if (f32Div) b.structNew(11);
        else {
          b.u8(w.CALL);
          b.lebU(em.ix.fBox);
        }
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
    default: {
      // Exhaustive per Expr: a new variant must add a case above (the
      // try/finally wrapper defeats TS's end-of-function reachability
      // check, so the never-assertion is the exhaustiveness guard here).
      assertNever(e);
      throw new WasmError(`internal: no emitter for node ${id}`);
    }
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
