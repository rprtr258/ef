import {writeFileSync} from "node:fs";
// The compile pipeline of the wasm backend: discovery, optimization
// passes, funcref index assignment, static layout and module assembly —
// free functions over plain artifact records, composed by compileWithOps
// (wasm.ts). The design doc for the whole backend lives at the
// top of wasm.ts.
import binaryen from "binaryen";
import {type Program} from "./parser.ts";
import {BUILTINS, EFFECT_OPS, builtinRefs, builtinValueUses, collectEffectOps, performsAnyOp} from "./analysis.ts";
import {_T, StaticDesc, ValueRef, WasmError} from "./wasm_types.ts";
import {BUILTIN_IMPORTS, DBGEMIT, DBGTRACE, HOST_IMPORTS, OPERATOR_OPS, SIGS, mapLikeFrameWords, vt} from "./wasm_tables.ts";
import {Fn} from "./wasm_body.ts";
import {type CIr, type CAtom, type CPrim, type CTerm} from "./cps_ir.ts";
import {type TermPlan} from "./wasm_term.ts";
import * as w from "./wasm_consts.ts";

// --- compile phases ----------------------------------------------------------
// The backend pipeline is a composition of free functions over plain artifact
// records: each phase returns a fresh record with its additions, and no phase
// mutates an artifact it did not create (shared entities — Fn, Scope — stay
// mutable in place as before). compileWithOps composes the pipeline; the
// emission phase at the bottom owns one local Emit context.

// Phase 1 — discovery: effect-op interning (AST ops), handler-presence and
// literal collection over the CPS IR. Written once; read by every later
// phase and by emission.
export type Discovery = {
  // Literal presence maps (keys only; static layout resolves the global
  // indices into Layout.numStatics/strStatics).
  // "width:lexeme" → width — number literals with their stamped width (the
  // f64 0.1 and the f32 0.1 are distinct statics; i64/u64 keys carry the
  // raw source lexeme — a JS number loses bits beyond 2^53).
  numLits: Map<string, string>,
  // String literals + field names (field-access failure messages).
  strLits: Set<string>,
  // True iff the IR contains any `handle` node. K_HDL cells are pushed
  // only by handle emission, so a handle-free program's k chains hold
  // K_RET cells only and emitDispatch can skip the handler
  // case-table scan.
  hasHandle: boolean,
  // Effect op table: builtin ops pre-seeded (analysis.ts EFFECT_OPS,
  // builtins.ts table order); the program's performed/handled ops intern in
  // first-appearance AST order (insertion order = the op table order).
  // Returned to the host by compileWithOps as [...effOpIds.keys()].
  effOpIds: Map<string, number>,
};

// Phase 2 — module-level optimization facts (OPT_PASSES at the bottom of the file).
// Ordered passes over the program; each records facts the emitters
// consume, and index assignment derives helper/lambda/builtin funcref
// indices from the live import count (that ordering constraint is dataflow
// here: assignIndices takes Opt).
export type Opt = {
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

// Phase 3 — funcref index assignment (helpers, lambdas, handler case
// functions, ret-resume functions, builtin trampolines), deterministic
// IR-plan order.
export type Indices = {
  // funcref index → typeIdx (direct CALL targets resolve their signatures
  // through it; indirect calls carry the type index in the stream).
  funcRefTypes: Map<number, number>,
  // Helper funcref indices: helpers always follow the live imports.
  fTruthy: number,
  fEq: number,
  fBox: number,
  fNum64: number,
  fF32of: number,
  fI32of: number,
  fU32of: number,
  fI64of: number,
  fU64of: number,
  // CFn funcref base: funcref(lambda i) = lambda0 + i (ir.funcs order).
  lambda0: number,
  // Numeric direct-ABI entry base: dense block over the eligible CFns in
  // ir.funcs order (numFn maps CFn index → its entry's funcref; CFns
  // without an entry own no slot).
  dnum0: number,
  numFn: Map<number, number>,
  // Shared default-Return case function, used only by handlers with npMax 0:
  // reads the Return value emitDispatch stashed in hframe slot 1 and
  // dispatches it through its k — eval.ts's `(v, k2) => k2(v)`.
  identityRet: Fn,
  // Case-function funcref base: funcref(plan case #i) = case0 + i.
  case0: number,
  // Identity-ret funcref base (per-handle no-Return-case identities).
  idRet0: number,
  // Ret-resume funcref base (per-handle Return-case identity resumes).
  retRes0: number,
  // Shared resume-closure fn: the T_KABI fn every perform site's
  // boxed resume binder points at.
  resumeFn: Fn,
  // Terminal-return fragment: a T_III_I thunk returning its param — the
  // direct-fn dcall fallbacks' terminal chain link.
  terminalRet: Fn,
  // Builtin trampolines: funcref index of the first builtin / first land
  // thunk, and trampoline funcref index per emitted builtin (direct builtin
  // call sites target these instead of loading a $CLO and dispatching
  // through the table).
  builtin0: number,
  thunk0: number,
  builtinFnIdx: Map<string, number>,
};

// Phase 4 — static layout: immutable anyref globals with constant
// initializers — deduped number literals, PI, string literals, true/false
// i31s, unit, one $CLO per surviving builtin, and per-handle case tables
// ($ELEMS of flat [opid, fnIdx, fsize, nparams] i31 quadruples). Every
// static allocates one global index; buildModule turns its descriptor into
// the initializer.
export type Layout = {
  statics: StaticDesc[],
  // Unit/bool statics (unit = the global's initial ref.null any).
  unitRef: ValueRef,
  trueRef: ValueRef,
  falseRef: ValueRef,
  // PI constant global (only when the program references PI).
  piG: number,
  numStatics: Map<string, number>,   // "width:value" literal key → static global idx
  strStatics: Map<string, number>,   // literal value → static global idx
  cloOffsets: Map<string, number>,   // builtin name → static $CLO global idx
  hdlTableOff: Map<number, number>,  // handle plan index → case-table static global idx
  // Terminal K_RET cell (direct-fn dcall fallbacks chain here; its fragment
  // returns the param the dispatcher delivered).
  terminalCellG: number,
  // Handler-boundary sentinel (immutable K_BND cell) and the mutable
  // hctx global (the innermost $HDLCTX entry; null at top level). The
  // sentinel's global index comes after every static; hctx after it.
  bndG: number,
  ctxG: number,
};

// --- phase functions ---------------------------------------------------------

export function discover(ir: CIr, prog: Program): Discovery {
  const d: Discovery = {
    numLits: new Map(),
    strLits: new Set(),
    hasHandle: false,
    effOpIds: new Map(EFFECT_OPS.map((op, i) => [op, i])),
  };
  // Effect op discovery (analysis.ts, AST): builtin ops are pre-seeded
  // above; the program's performed/handled ops intern in first-appearance
  // order — the op table the host's interpretation and the perform walks
  // share.
  for (const op of collectEffectOps(prog))
    if (!d.effOpIds.has(op)) d.effOpIds.set(op, d.effOpIds.size);
  // Literal + handle collection over the IR (field names ride strLits for
  // the OOB failure messages).
  const atom = (a: CAtom): void => {
    if (a.t === "lit") {
      if (typeof a.v === "number") {
        const key = `${a.stamp ?? "f64"}:${a.raw ?? String(a.v)}`;
        if (!d.numLits.has(key)) d.numLits.set(key, a.stamp ?? "f64");
      } else if (typeof a.v === "string") {
        d.strLits.add(a.v);
      }
    }
  };
  const prim = (p: CPrim): void => {
    if (p.t === "op" || p.t === "arr") for (const a of p.args) atom(a);
    else if (p.t === "as") atom(p.arg);
    else {
      atom(p.obj);
      d.strLits.add(p.name);
    }
  };
  const walk = (t: CTerm): void => {
    switch (t.t) {
      case "letk":
        walk(t.body);
        walk(t.rest);
        if (t.freeze !== undefined) for (const fr of t.freeze) atom(fr.val);
        break;
      case "let":
        prim(t.rhs);
        walk(t.rest);
        break;
      case "bind":
        atom(t.val);
        walk(t.rest);
        break;
      case "mkfn":
        walk(t.rest);
        break;
      case "call":
        atom(t.fn);
        for (const a of t.args) atom(a);
        atom(t.k);
        break;
      case "dcall":
        atom(t.fn);
        for (const a of t.args) atom(a);
        walk(t.rest);
        break;
      case "perform":
        for (const a of t.args) atom(a);
        atom(t.k);
        break;
      case "handle":
        d.hasHandle = true;
        atom(t.k);
        walk(t.body);
        for (const c of t.cases) walk(c.body);
        break;
      case "if":
        atom(t.c);
        walk(t.a);
        walk(t.b);
        break;
      case "scope":
        walk(t.rest);
        break;
      case "dlet":
        atom(t.val);
        walk(t.rest);
        break;
      case "assign":
        atom(t.val);
        walk(t.rest);
        break;
      case "jump":
        atom(t.k);
        atom(t.arg);
        break;
      case "halt":
        atom(t.v);
        break;
      case "dret":
        atom(t.v);
        break;
    }
  };
  walk(ir.term);
  for (const fn of ir.funcs) walk(fn.body);
  return d;
}

export function optimize(prog: Program): Opt {
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

export function assignIndices(ir: CIr, plan: TermPlan, o: Opt): Indices {
  // 2b. Helper funcref indices: helpers always follow the live imports
  // (must match emitHelpers' push order).
  const ix: Indices = {
    funcRefTypes: new Map(),
    fTruthy: o.liveImports.length,
    fEq: o.liveImports.length + 1,
    fBox: o.liveImports.length + 2,
    fNum64: o.liveImports.length + 3,
    fF32of: o.liveImports.length + 4,
    fI32of: o.liveImports.length + 5,
    fU32of: o.liveImports.length + 6,
    fI64of: o.liveImports.length + 7,
    fU64of: o.liveImports.length + 8,
    lambda0: o.liveImports.length + 9,
    dnum0: 0,
    numFn: new Map(),
    identityRet: undefined!,
    case0: 0,
    idRet0: 0,
    retRes0: 0,
    resumeFn: undefined!,
    terminalRet: undefined!,
    builtin0: 0,
    thunk0: 0,
    builtinFnIdx: new Map(),
  };
  // Helper sigs resolve before emission (a CALL's signature lookup is
  // eager — $eq's body calls $num64, which is emitted later).
  ix.funcRefTypes.set(ix.fNum64, 19); // __num's shape: (anyref) -> f64
  ix.funcRefTypes.set(ix.fF32of, w.T_F32); // (anyref) -> f32
  ix.funcRefTypes.set(ix.fI32of, w.T_GETI32); // (anyref) -> i32
  ix.funcRefTypes.set(ix.fU32of, w.T_GETI32); // (anyref) -> i32
  ix.funcRefTypes.set(ix.fI64of, w.T_GETI64); // (anyref) -> i64
  ix.funcRefTypes.set(ix.fU64of, w.T_GETI64); // (anyref) -> i64
  // 2c. CFn funcref indices (ir.funcs order; sigs resolve before emission).
  for (let i = 0; i < ir.funcs.length; i++)
    ix.funcRefTypes.set(ix.lambda0 + i, w.T_KABI);
  // 2e. Case-function block: numeric direct-ABI entries (one per eligible
  // CFn, ir.funcs order — emitCfns pushes them in the same order right
  // after the boxed entries), then identityRet, per-handle case fns + ret
  // cases + identity rets, ret resumes, then the shared resume fn. The
  // order must match emitCaseFns/emitRetResumes' push order exactly.
  let next = ix.lambda0 + ir.funcs.length;
  ix.dnum0 = next;
  next += plan.numEntry.filter(n => n !== null).length;
  // Dense funcref assignment matching emitCfns' push order (one slot per
  // eligible CFn, ir.funcs order — no holes).
  let dn = 0;
  for (let i = 0; i < ir.funcs.length; i++) {
    if (plan.numEntry[i] === null) continue;
    ix.numFn.set(i, ix.dnum0 + dn);
    dn++;
  }
  const idf = new Fn(2);
  idf.idx = next++;
  ix.identityRet = idf;
  ix.funcRefTypes.set(idf.idx, w.T_KABI);
  ix.case0 = next;
  next += plan.caseCount;
  ix.idRet0 = next;
  next += plan.idRetCount;
  ix.retRes0 = next;
  next += plan.retResCount;
  const rf = new Fn(2);
  rf.idx = next++;
  ix.funcRefTypes.set(rf.idx, w.T_KABI);
  ix.resumeFn = rf;
  // The terminal-return fragment (direct-fn dcall fallbacks chain here):
  // a T_III_I thunk that just returns its param (local 1) — the completion's
  // value unwinds as each fragment's result.
  const tf = new Fn(3);
  tf.idx = next++;
  tf.typeIdx = w.T_III_I;
  ix.funcRefTypes.set(tf.idx, w.T_III_I);
  ix.terminalRet = tf;
  // Builtin trampolines (must match emitBuiltins' emission order: BUILTINS
  // filtered by usedBuiltins); land thunks follow them, main is last.
  const builtins = BUILTINS.filter(b => o.usedBuiltins.has(b.name));
  ix.builtin0 = next;
  ix.thunk0 = ix.builtin0 + builtins.length;
  for (let i = 0; i < builtins.length; i++) {
    ix.builtinFnIdx.set(builtins[i].name, ix.builtin0 + i);
    ix.funcRefTypes.set(ix.builtin0 + i, w.T_KABI); // sigs resolve before emission
  }
  return ix;
}

export function layoutStatics(d: Discovery, ix: Indices, o: Opt, plan: TermPlan): Layout {
  const statics: StaticDesc[] = [];
  const newStatic = (desc: StaticDesc): number => statics.push(desc) - 1;
  const lay: Layout = {
    statics,
    // Unit: ref.null any; bools: i31(1)/i31(0).
    unitRef: {k: "g", gi: newStatic({t: "null"})},
    trueRef: {k: "g", gi: newStatic({t: "i31", v: 1})},
    falseRef: {k: "g", gi: newStatic({t: "i31", v: 0})},
    piG: -1,
    numStatics: new Map(),
    strStatics: new Map(),
    cloOffsets: new Map(),
    hdlTableOff: new Map(),
    terminalCellG: -1,
    bndG: -1,
    ctxG: -1,
  };
  // Number literals (deduped by width + value; the Discovery keys carry both).
  for (const [k, w] of d.numLits) {
    const lex = k.slice(k.indexOf(":") + 1);
    lay.numStatics.set(k, newStatic({t: "num", w, v: Number(lex),
      big: w === "i64" || w === "u64" ? BigInt(lex) : undefined}));
  }
  // PI constant (only when the program references it).
  if (o.usedBuiltins.has("PI"))
    lay.piG = newStatic({t: "num", w: "f64", v: Math.PI});
  // String literals (field names included — same constant pool).
  for (const v of d.strLits)
    lay.strStatics.set(v, newStatic({t: "str", s: v}));
  // Builtin closures: $CLO {fnIdx, env = null, fsize = params + map-like
  // extras} — only VALUE-referenced builtins get one (treeShakeBuiltins +
  // builtinValueUses): call-only builtins are called directly via
  // builtinFnIdx, so no closure object is materialized.
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
  // Handler case tables: flat [opid, fnIdx, fsize, nparams]* i31s.
  // The Return entry (opid -1) always goes last — an explicit case fn when
  // the handler declares one, otherwise an identity fn with matching
  // nparams (the shared npMax=0 fn puts the value at slot 1 where it reads
  // it back; handlers with npMax > 0 get a per-handler fn so param/resume
  // slots stay intact). Funcref indices are plan-order-based (case0/idRet0).
  // The perform walk reads these at runtime, so all facts are data.
  for (const hdl of plan.hdlOrder) {
    const hp = hdl.__p!;
    const npMax = Math.max(0, ...hdl.cases.map(c => c.params.length));
    const entries: {opid: number, fn: number, fsize: number, nparams: number}[] = [];
    let ci = 0;
    for (const c of hdl.cases) {
      if (c.op === "Return") continue;
      const opid = d.effOpIds.get(c.op);
      if (opid === undefined) throw new WasmError(`internal: unnumbered op ${c.op}`);
      entries.push({opid, fn: ix.case0 + hp.caseP[ci++].fnIdx, fsize: hp.hframeSize, nparams: c.params.length});
    }
    const retCase = hdl.cases.find(c => c.op === "Return");
    if (retCase !== undefined) {
      entries.push({opid: -1, fn: ix.case0 + hp.retP!.fnIdx, fsize: hp.hframeSize, nparams: npMax});
    } else if (npMax === 0) {
      entries.push({opid: -1, fn: ix.identityRet.idx, fsize: hp.hframeSize, nparams: 0});
    } else {
      entries.push({opid: -1, fn: ix.idRet0 + hp.idRetIdx!, fsize: hp.hframeSize, nparams: npMax});
    }
    const words: number[] = [];
    for (const en of entries)
      words.push(en.opid, en.fn, en.fsize, en.nparams);
    lay.hdlTableOff.set(hp.hdlIdx, newStatic({t: "elems", ws: words}));
  }
  // The terminal return-cell (direct-fn dcall fallbacks chain here): a K_RET
  // cell whose fragment is the terminal-return thunk — (frame, v, k) returns
  // the param the dispatcher delivered as v.
  lay.terminalCellG = newStatic({t: "kret", fni: ix.terminalRet.idx});
  // The handler-boundary sentinel (a dead-end K_BND cell) + the mutable hctx
  // global after it — hctx's index is statics.length at build time.
  lay.bndG = newStatic({t: "kbnd"});
  lay.ctxG = statics.length;
  return lay;
}

// --- assembly -----------------------------------------------------------------

function staticInit(m: binaryen.Module, d: StaticDesc): binaryen.ExpressionRef {
  const {HT} = _T;
  switch (d.t) {
    case "null": return m.ref.null(binaryen.anyref);
    case "i31": return m.ref.i31(m.i32.const(d.v));
    case "num": {
      // Per-width const form + box shape: f32 as $F32, i32/u32 as their
      // own narrow boxes.
      if (d.w === "f32") return m.struct.new([m.f32.const(d.v)], HT[11]);
      if (d.w === "i32") return m.struct.new([m.i32.const(d.v)], HT[7]);
      if (d.w === "u32") return m.struct.new([m.i32.const(d.v)], HT[8]);
      // The 64-bit widths are exact beyond 2^53: the const form reads the
      // literal's full lexeme as a BigInt (m.i64.const takes bigint).
      if (d.w === "i64") return m.struct.new([m.i64.const(d.big ?? BigInt(d.v))], HT[9]);
      if (d.w === "u64") return m.struct.new([m.i64.const(d.big ?? BigInt(d.v))], HT[10]);
      return m.struct.new([m.f64.const(d.v)], HT[0]);
    }
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
        m.ref.i31(m.i32.const(d.direct === 1 ? 1 : 0)),
        m.ref.i31(m.i32.const(0)), // no numeric entry (builtin trampolines)
        m.ref.i31(m.i32.const(0)),
      ], HT[6]);
    case "elems":
      return m.array.new_fixed(HT[1], d.ws.map((w) => m.ref.i31(m.i32.const(w))));
    case "kret":
      // {K_RET, fragIdx, frame = null, next = null}: the frame/next are dead —
      // the identityRet fragment reads only the param (hframe slot 1) that
      // the dispatcher delivered as v.
      return m.struct.new([
        m.ref.i31(m.i32.const(0)),
        m.ref.i31(m.i32.const(d.fni)),
        m.ref.null(w.heapTypes(4).n),
        m.ref.null(w.heapTypes(5).n),
      ], HT[5]);
    case "kbnd":
      // The handler-boundary sentinel: a dead-end K_BND cell — its a/b/next
      // are dead; dispatch resolves it through the hctx global.
      return m.struct.new([
        m.ref.i31(m.i32.const(2)),
        m.ref.null(w.heapTypes(4).n),
        m.ref.null(w.heapTypes(4).n),
        m.ref.null(w.heapTypes(5).n),
      ], HT[5]);
  }
}

export function buildModule(m: binaryen.Module, o: Opt, lay: Layout, funcs: Fn[]): Uint8Array<ArrayBuffer>;
export function buildModule(m: binaryen.Module, o: Opt, lay: Layout, funcs: Fn[], text: true): string;
export function buildModule(m: binaryen.Module, o: Opt, lay: Layout, funcs: Fn[], text?: boolean): Uint8Array<ArrayBuffer> | string {
  // import section
  for (let i = 0; i < o.liveImports.length; i++) {
    const n = o.liveImports[i];
    const sig = SIGS[w.impType(n)];
    m.addFunctionImport(`f${i}`, "env", n,
      binaryen.createType(sig.p.map(vt)), sig.r === null ? binaryen.none : vt(sig.r));
  }
  // global section: immutable statics, each initialized by a GC constant
  // expression — instantiation builds the value, no runtime fill. The hctx
  // global (the innermost $HDLCTX handler boundary; null at top level)
  // trails them as the module's only mutable global.
  for (let i = 0; i < lay.statics.length; i++)
    m.addGlobal(`g${i}`, binaryen.anyref, false, staticInit(m, lay.statics[i]));
  m.addGlobal(`g${lay.ctxG}`, binaryen.anyref, true, m.ref.null(binaryen.anyref));
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
  if (process.env["DBGEMIT"] === "1") console.error(m.emitText());
  // exports: run + the 17 accessors — the last 19 functions (main + these)
  const expNames = ["run", "__tag", "__num", "__str_len", "__str_get",
    "__arr_len", "__arr_get", "__mk_num", "__mk_f32", "__f32", "__mk_i32",
    "__mk_u32", "__i32", "__u32", "__mk_i64", "__mk_u64", "__i64", "__u64",
    "__mk_bool", "__str_new", "__str_set", "__arr_new", "__arr_set",
    "__tup_new", "__tup_len", "__tup_get", "__tup_set"];
  for (let i = 0; i < expNames.length; i++)
    m.addFunctionExport(`f${total - expNames.length + i}`, expNames[i]);
  // shrink pass (wasm-opt in-process; shrink level 2 alone matches -Oz
  // output size on our modules at ~1/3 the cost of full -Oz).
  if (process.env["EF_SKIP_WASM_OPT"] !== "1") {
    binaryen.setOptimizeLevel(0);
    binaryen.setShrinkLevel(2);
    try {
      m.optimize();
    } catch (e) {
      // Binaryen aborts are total (every later compile fails), so dump the
      // module for post-mortem when emission debugging is on.
      if (process.env["DBGEMIT"] === "1") console.error(m.emitText());
      throw e;
    }
  }
  if (process.env["EF_DUMP_TEXT"] === "1") { try { console.error(m.emitText()); } catch (e) { console.error("emitText failed"); } }
  if (m.validate() === 0) {
    if (DBGEMIT) console.error(m.emitText());
    const dumpPath = process.env["EF_DUMP_INVALID"];
    if (dumpPath !== undefined && dumpPath !== "") {
      // emitText aborts on invalid modules (binaryen asserts); emit the
      // binary so wasm-tools print can render it for post-mortem.
      if (dumpPath !== "1") writeFileSync(dumpPath, m.emitBinary());
      console.error(`EF_DUMP_INVALID: wrote ${dumpPath}`);
    } else {
      throw new WasmError("binaryen: compiled module failed validation");
    }
  }
  if (text === true) {
    // The WAT view renders exactly the shipped module: same shrink pass and
    // validation gate, then binaryen's own text emitter.
    const wat = m.emitText();
    m.dispose();
    return wat;
  }
  const bytes = m.emitBinary();
  m.dispose();
  // emitBinary declares a plain Uint8Array (ArrayBufferLike); the buffer is a
  // real ArrayBuffer in every binaryen build we ship, and hosts consume the
  // module through DOM-lib WebAssembly typings that require that distinction.
  return bytes as Uint8Array<ArrayBuffer>;
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
    n === "ef_trace" ? DBGTRACE :
    n === "ef_binop" ? o.usedBuiltins.has("+") || o.usedBuiltins.has("<") ||
      o.usedBuiltins.has(">") || o.usedBuiltins.has("<=") || o.usedBuiltins.has(">=") :
    Object.hasOwn(BUILTIN_IMPORTS, n) &&
      o.usedBuiltins.has(BUILTIN_IMPORTS[n]));
  if (DBGEMIT)
    console.error("dropDeadHostImports:", JSON.stringify(live), "used:", [...o.usedBuiltins].join(","));
  o.liveImports = live;
  o.impIdx = new Map(live.map((n, i): [string, number] => [n, i]));
}
