// The compile pipeline of the wasm backend: discovery (§2), optimization
// passes, funcref index assignment, static layout and module assembly —
// free functions over plain artifact records, composed by compileWithOps
// (wasm.ts). The §-numbered design doc for the whole backend lives at the
// top of wasm.ts.
import binaryen from "binaryen";
import {exprChildren, type Expr, type Program, type ExprID} from "./parser.ts";
import {BUILTINS, EFFECT_OPS, builtinRefs, builtinValueUses, collectEffectOps, performsAnyOp} from "./analysis.ts";
import {_T, Scope, StaticDesc, ValueRef, WasmError} from "./wasm_types.ts";
import {BUILTIN_IMPORTS, DBGEMIT, HOST_IMPORTS, MAP_LIKE, OPERATOR_OPS, SIGS, mapLikeFrameWords, vt} from "./wasm_tables.ts";
import {Fn} from "./wasm_body.ts";
import * as w from "./wasm_consts.ts";
import {assertNever} from "./assert.ts";

// --- compile phases ----------------------------------------------------------
// The backend pipeline is a composition of free functions over plain artifact
// records: each phase returns a fresh record with its additions, and no phase
// mutates an artifact it did not create (shared entities — Fn, Scope — stay
// mutable in place as before). compileWithOps composes the pipeline; the
// emission phase at the bottom owns one local Emit context.

// Phase 1 — discovery: effect-op interning, handler-presence pre-scan, then
// the scope/slot/literal/split-site walk over the whole (pre-checked)
// program. Written once; read by every later phase and by emission.
export type Discovery = {
  // Scope per lambda/block (ExprID → its Scope).
  scopes: Map<ExprID, Scope>,
  globalScope: Scope,
  constLambdas: Map<Scope, Map<string, {id: ExprID, free: boolean}>>,
  // Literal presence maps (keys only; static layout resolves the global
  // indices into Layout.numStatics/strStatics).
  // "width:value" → width — number literals with their stamped width (the
  // f64 0.1 and the f32 0.1 are distinct statics).
  numLits: Map<string, string>,
  strLits: Set<string>,
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
  calleeOf: Map<ExprID, ExprID>,
  calleeSyms: Set<ExprID>,
  lambdaValueUsed: Set<ExprID>,
  pureLambdas: Set<ExprID>,
  typedLambdas: Map<ExprID, string>,
  lambdaCalleeFree: Map<ExprID, boolean>,
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

// Phase 3 — funcref index assignment (helpers, lambdas, spills, handler case
// functions, builtin trampolines), deterministic AST order.
export type Indices = {
  // funcref index → typeIdx (direct CALL targets resolve their signatures
  // through it; indirect calls carry the type index in the stream).
  funcRefTypes: Map<number, number>,
  // Helper funcref indices: helpers always follow the live imports.
  fTruthy: number,
  fEq: number,
  fBox: number,
  fCapture: number,
  fNum64: number,
  fF32of: number,
  fI32of: number,
  fU32of: number,
  fI64of: number,
  fU64of: number,
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
  lambdaWrapIdx: Map<ExprID, number>,
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
  hdlTableOff: Map<ExprID, number>,  // handle → case-table static global idx
  poolGlobals: Map<string, {list: number, cnt: number}>,
};

// --- phase functions ---------------------------------------------------------

export function discover(prog: Program): Discovery {
  // `prog` must be pre-checked: the caller (compileWithOps, tests) runs
  // checkProgram before the pipeline, which stamps the runtime markers this
  // phase reads (`div` on applications of `/`, `idx` on field accesses).
  const globalFrame = {slots: 0};
  const d: Discovery = {
    scopes: new Map(),
    globalScope: {frame: globalFrame, parent: null, map: new Map()},
    constLambdas: new Map(),
    numLits: new Map(),
    strLits: new Set(),
    landCalls: new Set(),
    hdlCases: new Map(),
    hasHandle: prog.nodes.some(n => n.t === "handle"),
    calleeOf: new Map(),
    calleeSyms: new Set<ExprID>(),
    lambdaValueUsed: new Set<ExprID>(),
    pureLambdas: new Set<ExprID>(),
    typedLambdas: new Map(),
    lambdaCalleeFree: new Map<ExprID, boolean>(),
    effOpIds: new Map(EFFECT_OPS.map((op, i) => [op, i])),
  };
  // Effect op discovery (analysis.ts): builtin ops are pre-seeded above; the
  // program's performed/handled ops intern in first-appearance AST order —
  // before the walk below, whose handler records read effOpIds.
  for (const op of collectEffectOps(prog))
    if (!d.effOpIds.has(op)) d.effOpIds.set(op, d.effOpIds.size);
  // Scope discovery: scopes per lambda/block, slot numbering, literals,
  // split sites, handler records.
  const rec = (id: ExprID, sc: Scope): void => {
    const e = prog.nodes[id];
    switch (e.t) {
      case "num": {
        // Dedup key includes the node's stamped width: the f64 literal 0.1
        // and the f32 literal 0.1 are distinct statics (different boxes and
        // const forms). Untyped literals carry their default (i64/f64 → the
        // f64 plane in step 2).
        const w = e.numKind === "i32" || e.numKind === "u32" || e.numKind === "f32"
          || e.numKind === "i64" || e.numKind === "u64" ? e.numKind : "f64";
        // The raw lexeme (int literals keep it) is the exactness source:
        // Number(lex) rounds beyond 2^53, BigInt(lex) does not.
        const lex = e.raw ?? String(e.v);
        d.numLits.set(`${w}:${lex}`, w);
        break;
      }
      case "str":
        d.strLits.add(e.v);
        break;
      case "lambda": {
        const frame = {slots: 0};
        const s: Scope = {frame, parent: sc, map: new Map()};
        for (const p of e.params) s.map.set(p.name, frame.slots++);
        d.scopes.set(id, s);
        rec(e.body, s);
        return;
      }
      // Blocks share the enclosing wasm frame: their lets just take further
      // slots (the interpreter's block env is a child of the current env).
      case "block": {
        const s: Scope = {frame: sc.frame, parent: sc, map: new Map()};
        d.scopes.set(id, s);
        for (const stmt of e.stmts) rec(stmt, s);
        return;
      }
      case "let": {
        sc.map.set(e.name, sc.frame.slots++);
        if (!e.mut && prog.nodes[e.val].t === "lambda") {
          let defs = d.constLambdas.get(sc);
          if (defs === undefined) { defs = new Map(); d.constLambdas.set(sc, defs); }
          defs.set(e.name, {id: e.val, free: true});
        }
        break;
      }
      case "dlet":
        for (const fd of e.fields) sc.map.set(fd.name, sc.frame.slots++);
        break;
      case "assign":
      case "if":
      case "while":
        break; // children only — see exprChildren
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
        const cdef = fne.t === "sym" ? constLamOf(d, sc, fne.v) : undefined;
        if (cdef !== undefined) {
          d.calleeOf.set(id, cdef.id);
          d.calleeSyms.add(e.fn);
        }
        break;
      }
      case "arr":
      case "as":
      case "perform":
        break; // children only — see exprChildren
      case "field":
        rec(e.obj, sc);
        d.strLits.add(e.name); // for the out-of-bounds message
        return;
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
        return;
      }
      case "sym": {
        if (!d.calleeSyms.has(id)) {
          const cdef = constLamOf(d, sc, e.v);
          if (cdef !== undefined) d.lambdaValueUsed.add(cdef.id);
        }
        break;
      }
      case "bool":
      case "unit":
        break;
      default:
        assertNever(e);
    }
    for (const k of exprChildren(e)) rec(k, sc);
  };
  for (const it of prog.items) {
    if ("e" in it) rec(it.e, d.globalScope);
  }
  for (const defs of d.constLambdas.values())
    for (const info of defs.values())
      info.free = lambdaCapturesFree(prog, d, info.id);
  planTypedLambdas(prog, d);
  return d;
}

function constLamOf(d: Discovery, sc: Scope, name: string): {id: ExprID, free: boolean} | undefined {
  for (let cur: Scope | null = sc; cur !== null; cur = cur.parent) {
    if (cur.map.has(name)) return d.constLambdas.get(cur)?.get(name);
  }
  return undefined;
}

// Unboxed calling convention (v1): the single seam comment for the whole
// optimization.
//
// WHAT: a `::`-const lambda that qualifies is emitted twice — a TYPED body
// function over a per-plane unboxed frame ($UF_I32/$UF_I64/$UF_F32/$UF_F64,
// shapes 13–16, slots a raw (array i32/i64/f32/f64), wasm types 17–20) plus
// a boxed T_KABI wrapper that unboxes the boxed frame's arg slots into a
// fresh typed frame and tail-calls the typed body. Inside a typed body,
// params/lets live raw in the typed frame, operators/comparisons compute on
// raw wasm values (no box per op), and the result is boxed once at return.
// Call sites in BOXED code (expr()'s app case) reach the qualified callee
// through the wrapper — the land/RET/K_SPILL protocol there is unchanged.
//
// QUALIFICATION PREDICATE (per const lambda, all conservative):
// - referenced only as a callee (never as a value), and its only possible
//   free-variable references are const-lambda callee syms (resolved
//   statically via calleeOf — typed bodies never read a parent frame, so
//   env = null is exact for them);
// - all params AND the return annotated-and-resolved to concrete numeric
//   widths of ONE plane group ({i32,u32}→i32, {i64,u64}→i64, f32, f64);
//   every `let` binding in the body stamps to that same group. Bools are
//   NOT representable: any bool-typed binding/param (bools are i31s in the
//   boxed world) disqualifies; raw comparisons produce i32 0/1 conditions
//   consumed immediately by `if`/`@as(…, T)`.
// - body over the emitter's node whitelist (num/sym/app/if/as/let/assign/
//   block; no while, no inner lambda, no handler binder or resume, no
//   dlet/arr/str/field/perform/handle), and every call inside the body
//   targets a non-map-like builtin or a PURE const lambda (see
//   pureLambdas) — so the whole dynamic extent of a qualified call is
//   statically effect-op-free.
//
// BOUNDARY/DEOPT RULE (values cross into the anyref world exactly at):
// calls to boxed callees (builtins, pure boxed lambdas) — args boxed at the
// call, results unboxed on assignment; the single boxing at the typed
// function's return; anyref containers (none can occur inside a qualified
// body) and host accessors; and handler capture points — which cannot
// occur, since the qualification's op-freeness makes the k=null (inline,
// non-land) call convention sound: no perform can ever walk the k chain
// out of a qualified call, so no typed K_RET/K_SPILL cells are needed and
// multi-shot resume never sees a typed frame. The interpreter and checker
// are untouched; the host ABI only ever sees boxed returns.
function planTypedLambdas(prog: Program, d: Discovery): void {
  const lamIds: ExprID[] = [];
  const lamFree = new Map<ExprID, boolean>();
  for (const defs of d.constLambdas.values())
    for (const info of defs.values()) {
      lamIds.push(info.id);
      lamFree.set(info.id, info.free);
    }
  if (lamIds.length === 0) return;
  for (const id2 of lamFree.keys()) d.lambdaCalleeFree.set(id2, calleeFreeOf(prog, d, id2));
  const SIX = new Set(["i32", "u32", "i64", "u64", "f32", "f64"]);
  const groupOf = (w2: string): string =>
    w2 === "i32" || w2 === "u32" ? "i32" : w2 === "i64" || w2 === "u64" ? "i64" : w2;
  const marked = new Set<ExprID>();
  const edges = new Map<ExprID, Set<ExprID>>();
  const walkPure = (owner: ExprID, wid: ExprID, sc: Scope): void => {
    const e2 = prog.nodes[wid];
    switch (e2.t) {
      case "lambda":
        return;
      case "perform":
      case "handle":
        marked.add(owner);
        return;
      case "app": {
        const callee = d.calleeOf.get(wid);
        if (callee !== undefined) {
          if (!edges.has(owner)) edges.set(owner, new Set());
          edges.get(owner)!.add(callee);
        } else {
          const fne = prog.nodes[e2.fn];
          const isBuiltin = fne.t === "sym" && resolve(sc, fne.v) === null &&
            BUILTINS.some(bb => bb.name === fne.v);
          if (!isBuiltin || MAP_LIKE.has(fne.v)) {
            marked.add(owner);
            return;
          }
        }
        for (const k of exprChildren(e2)) walkPure(owner, k, sc);
        return;
      }
      default:
        for (const k of exprChildren(e2)) walkPure(owner, k, sc);
    }
  };
  for (const id of lamIds)
    walkPure(id, (prog.nodes[id] as Expr & {t: "lambda"}).body, d.scopes.get(id)!);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, tos] of edges)
      for (const to of tos)
        if (marked.has(to) && !marked.has(from)) {
          marked.add(from);
          changed = true;
        }
  }
  for (const id of lamIds)
    if (!marked.has(id)) d.pureLambdas.add(id);
  const okValue = (wid: ExprID, sc: Scope, grp: string): boolean => {
    const e2 = prog.nodes[wid];
    switch (e2.t) {
      case "num":
        return true;
      case "sym": {
        const r = resolve(sc, e2.v);
        if (r !== null) return r.d === 0;
        return e2.v === "PI";
      }
      case "as": {
        if (!(e2.typ.tag === "prim" && SIX.has(e2.typ.name))) return false;
        if (e2.asKind === "boolnum") return okBool(e2.e, sc, grp);
        return okValue(e2.e, sc, grp);
      }
      case "if": {
        const ifW = (e2 as Expr & {numKind?: string}).numKind;
        const arm = (aw: ExprID): boolean => {
          const ae = prog.nodes[aw];
          if (ae.t !== "block") return okValue(aw, sc, grp);
          for (let k = 0; k < ae.stmts.length - 1; k++)
            if (!okStmt(ae.stmts[k], d.scopes.get(aw) ?? sc, grp)) return false;
          return ae.stmts.length > 0 &&
            okValue(ae.stmts[ae.stmts.length - 1], d.scopes.get(aw) ?? sc, grp);
        };
        return ifW !== undefined && SIX.has(ifW) && okBool(e2.c, sc, grp) &&
          arm(e2.a) && arm(e2.b);
      }
      case "app": {
        if (e2.div !== undefined)
          return e2.numKind !== undefined && SIX.has(e2.numKind) &&
            okValue(e2.args[0], sc, grp) && okValue(e2.args[1], sc, grp);
        const fn3 = prog.nodes[e2.fn];
        if (fn3.t !== "sym") return false;
        const callee = d.calleeOf.get(wid);
        if (callee !== undefined)
          return d.pureLambdas.has(callee) && d.lambdaCalleeFree.get(callee) === false &&
            e2.args.every(a => okValue(a, sc, grp));
        if (resolve(sc, fn3.v) === null && BUILTINS.some(bb => bb.name === fn3.v) &&
          !MAP_LIKE.has(fn3.v))
          return e2.args.every(a => okValue(a, sc, grp));
        return false;
      }
      default:
        return false;
    }
  };
  const okBool = (wid: ExprID, sc: Scope, grp: string): boolean => {
    const e2 = prog.nodes[wid];
    if (e2.t === "bool") return true;
    if (e2.t === "if") return okBool(e2.c, sc, grp) && okBool(e2.a, sc, grp) && okBool(e2.b, sc, grp);
    if (e2.t === "app") {
      const fn3 = prog.nodes[e2.fn];
      if (fn3.t !== "sym") return false;
      if (resolve(sc, fn3.v) === null && BUILTINS.some(bb => bb.name === fn3.v)) {
        if (fn3.v === "not") return okBool(e2.args[0], sc, grp);
        if (fn3.v === "<" || fn3.v === ">" || fn3.v === "<=" || fn3.v === ">=" ||
          fn3.v === "==" || fn3.v === "!=")
          return e2.numKind !== undefined && SIX.has(e2.numKind) &&
            okValue(e2.args[0], sc, grp) && okValue(e2.args[1], sc, grp);
      }
      const callee = d.calleeOf.get(wid);
      if (callee !== undefined)
        return d.pureLambdas.has(callee) && d.lambdaCalleeFree.get(callee) === false &&
          e2.args.every(a => okValue(a, sc, grp));
      if (resolve(sc, fn3.v) === null && BUILTINS.some(bb => bb.name === fn3.v) &&
        !MAP_LIKE.has(fn3.v))
        return e2.args.every(a => okValue(a, sc, grp));
      return false;
    }
    return false;
  };
  const okStmt = (wid: ExprID, sc: Scope, grp: string): boolean => {
    const e2 = prog.nodes[wid];
    switch (e2.t) {
      case "let": {
        const vk = (prog.nodes[e2.val] as Expr & {numKind?: string}).numKind;
        return vk !== undefined && SIX.has(vk) && groupOf(vk) === grp &&
          okValue(e2.val, sc, grp);
      }
      case "assign": {
        const r = resolve(sc, e2.name);
        const vk = (prog.nodes[e2.val] as Expr & {numKind?: string}).numKind;
        return r !== null && r.d === 0 && vk !== undefined && SIX.has(vk) &&
          groupOf(vk) === grp && okValue(e2.val, sc, grp);
      }
      case "if": {
        const ifW = (e2 as Expr & {numKind?: string}).numKind;
        if (ifW !== undefined && SIX.has(ifW))
          return okBool(e2.c, sc, grp) && okValue(e2.a, sc, grp) && okValue(e2.b, sc, grp);
        return okBool(e2.c, sc, grp) && okStmt(e2.a, sc, grp) && okStmt(e2.b, sc, grp);
      }
      case "block": {
        const bs = d.scopes.get(wid) ?? sc;
        for (const st of e2.stmts)
          if (!okStmt(st, bs, grp)) return false;
        return true;
      }
      default:
        return okValue(wid, sc, grp);
    }
  };
  for (const id of lamIds) {
    const e = prog.nodes[id] as Expr & {t: "lambda"};
    if (d.lambdaValueUsed.has(id) || lamFree.get(id) === undefined) continue;
    if (d.lambdaCalleeFree.get(id) !== false) continue;
    if (!d.pureLambdas.has(id) || e.typ === undefined) continue;
    const ft = e.typ;
    if (!(ft.effs instanceof Set) || ft.effs.size > 0) continue;
    let group: string | null = null;
    let ok = true;
    for (const p of ft.params) {
      if (!(p.tag === "prim" && SIX.has(p.name))) { ok = false; break; }
      const g = groupOf(p.name);
      if (group === null) group = g;
      else if (group !== g) { ok = false; break; }
    }
    if (!(ok && group !== null && ft.ret.tag === "prim" && SIX.has(ft.ret.name) && group === groupOf(ft.ret.name))) continue;
    const body = prog.nodes[e.body].t === "block" ? (prog.nodes[e.body] as {stmts: ExprID[]}).stmts : [e.body];
    const bsc = d.scopes.get(e.body) ?? d.scopes.get(id)!;
    ok = body.length > 0;
    for (let k = 0; k < body.length - 1; k++)
      if (!okStmt(body[k], bsc, group)) { ok = false; break; }
    if (ok && !okValue(body[body.length - 1], bsc, group)) ok = false;
    if (ok) d.typedLambdas.set(id, group);
  }
}

function lambdaCapturesFree(prog: Program, d: Discovery, id: ExprID): boolean {
  const lam = prog.nodes[id];
  if (lam.t !== "lambda") throw new WasmError("internal: const value is not a lambda");
  let free = false;
  const walk = (wid: ExprID, sc: Scope): void => {
    const e = prog.nodes[wid];
    const ws = d.scopes.get(wid) ?? sc;
    if (e.t === "sym") {
      const r = resolve(ws, e.v);
      if (r !== null && r.d > 0) free = true;
      return;
    }
    if (e.t === "assign") {
      const r = resolve(ws, e.name);
      if (r !== null && r.d > 0) free = true;
    }
    for (const k of exprChildren(e)) walk(k, ws);
  };
  walk(lam.body, d.scopes.get(id)!);
  return free;
}

function calleeFreeOf(prog: Program, d: Discovery, id: ExprID): boolean {
  const lam = prog.nodes[id];
  if (lam.t !== "lambda") throw new WasmError("internal: const value is not a lambda");
  let free = false;
  const walk = (wid: ExprID, sc: Scope): void => {
    const e = prog.nodes[wid];
    const ws = d.scopes.get(wid) ?? sc;
    if (e.t === "sym") {
      if (d.calleeSyms.has(wid)) return;
      const r = resolve(ws, e.v);
      if (r !== null && r.d > 0) free = true;
      return;
    }
    if (e.t === "assign") {
      const r = resolve(ws, e.name);
      if (r !== null && r.d > 0) free = true;
    }
    for (const k of exprChildren(e)) walk(k, ws);
  };
  walk(lam.body, d.scopes.get(id)!);
  return free;
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

export function assignIndices(prog: Program, d: Discovery, o: Opt): Indices {
  // 2b. Helper funcref indices: helpers always follow the live imports.
  const ix: Indices = {
    funcRefTypes: new Map(),
    fTruthy: o.liveImports.length,
    fEq: o.liveImports.length + 1,
    fBox: o.liveImports.length + 2,
    fCapture: o.liveImports.length + 3,
    fNum64: o.liveImports.length + 4,
    fF32of: o.liveImports.length + 5,
    fI32of: o.liveImports.length + 6,
    fU32of: o.liveImports.length + 7,
    fI64of: o.liveImports.length + 8,
    fU64of: o.liveImports.length + 9,
    fLambda0: o.liveImports.length + 10,
    lambdaIdx: new Map(),
    lambdaWrapIdx: new Map(),
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
  // Helper sigs resolve before emission (a CALL's signature lookup is
  // eager — $eq's body calls $num64, which is emitted later).
  ix.funcRefTypes.set(ix.fNum64, 19); // __num's shape: (anyref) -> f64
  ix.funcRefTypes.set(ix.fF32of, w.T_F32); // (anyref) -> f32
  ix.funcRefTypes.set(ix.fI32of, w.T_GETI32); // (anyref) -> i32
  ix.funcRefTypes.set(ix.fU32of, w.T_GETI32); // (anyref) -> i32
  ix.funcRefTypes.set(ix.fI64of, w.T_GETI64); // (anyref) -> i64
  ix.funcRefTypes.set(ix.fU64of, w.T_GETI64); // (anyref) -> i64
  // 2c. Function index assignment (deterministic AST order).
  let nextLam = ix.fLambda0;
  const assignLambdas = (id: ExprID): void => {
    const e = prog.nodes[id];
    if (e.t === "lambda") {
      ix.lambdaIdx.set(id, nextLam++);
      const plane = d.typedLambdas.get(id);
      ix.funcRefTypes.set(ix.lambdaIdx.get(id)!, plane === undefined ? w.T_KABI // sigs resolve before emission
        : plane === "i32" ? w.T_UKABI_I32 : plane === "i64" ? w.T_UKABI_I64
        : plane === "f32" ? w.T_UKABI_F32 : w.T_UKABI_F64);
      if (plane !== undefined) {
        ix.lambdaWrapIdx.set(id, nextLam++);
        ix.funcRefTypes.set(ix.lambdaWrapIdx.get(id)!, w.T_KABI);
      }
    }
    for (const k of exprChildren(e)) assignLambdas(k);
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
          return;
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
          break;
        case "app": {
          const kids = [e.fn, ...e.args];
          // Any splitting child (land call, perform, handle) ends the
          // inline body: every sibling's value must survive in a spill
          // slot so the fragment reloads it instead of re-running it.
          // Pure children spill too — see the if case (multi-shot freeze).
          if (kids.some(k2 => splits(prog, d, k2)))
            for (const k2 of kids) addOperandSpill(k2, frame);
          break;
        }
        case "arr":
          if (e.elems.some(el => splits(prog, d, el)))
            for (const el of e.elems) addOperandSpill(el, frame);
          break;
        case "perform": {
          ix.spillOf.set(id, frame.slots + (ix.spillTotals.get(frame) ?? 0));
          ix.spillTotals.set(frame, (ix.spillTotals.get(frame) ?? 0) + 1);
          ix.valSpill.set(id, frame.slots + (ix.spillTotals.get(frame) ?? 0));
          ix.spillTotals.set(frame, (ix.spillTotals.get(frame) ?? 0) + 1);
          if (e.args.some(a => splits(prog, d, a)))
            for (const a of e.args) addOperandSpill(a, frame);
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
          return;
        }
        case "block": case "let": case "assign": case "dlet": case "while":
        case "field": case "as":
          break; // children only — see exprChildren
        case "num": case "str": case "bool": case "unit": case "sym":
          break; // no children
        default:
          assertNever(e);
      }
      for (const k of exprChildren(e)) walk(k, frame);
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
  idf.idx = nextLam;
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
  ix.builtin0 = idf.idx + ix.caseFnTotal;
  ix.thunk0 = ix.builtin0 + builtins.length;
  for (let i = 0; i < builtins.length; i++) {
    ix.builtinFnIdx.set(builtins[i].name, ix.builtin0 + i);
    ix.funcRefTypes.set(ix.builtin0 + i, w.T_KABI); // sigs resolve before emission
  }
  return ix;
}

export function layoutStatics(d: Discovery, ix: Indices, o: Opt): Layout {
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
    poolGlobals: new Map(),
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
export function splits(prog: Program, d: Discovery, id: ExprID): boolean {
  const e = prog.nodes[id];
  if (e.t === "lambda") return false; // lambdas bound their own frames
  if (e.t === "perform" || e.t === "handle") return true;
  return (e.t === "app" && d.landCalls.has(id)) ||
    exprChildren(e).some(k => splits(prog, d, k));
}

// Frame size of a scope's frame: named slots + perform spill slots (§4.2).
// Everything that allocates a frame (lambda closure fsize, the global frame
// in emitMain) must go through this so spilled values fit.
export function frameSizeOf(ix: Indices, sc: Scope): number {
  return sc.frame.slots + (ix.spillTotals.get(sc.frame) ?? 0);
}

export function resolve(sc: Scope, name: string): {d: number, i: number} | null {
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
    case "num": {
      // Per-width const form + box shape. Step 2 boxes f32 as $F32; every
      // other width still rides the f64 plane ($F64) until steps 3-4.
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
      ], HT[6]);
    case "elems":
      return m.array.new_fixed(HT[1], d.ws.map((w) => m.ref.i31(m.i32.const(w))));
  }
}

export function buildModule(m: binaryen.Module, o: Opt, lay: Layout, funcs: Fn[]): Uint8Array<ArrayBuffer> {
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
  for (const g of lay.poolGlobals.values()) {
    m.addGlobal(`g${g.list}`, _T.RF[1], true, m.ref.null(w.heapTypes(1).n));
    m.addGlobal(`g${g.cnt}`, binaryen.i32, true, m.i32.const(0));
  }
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
  // exports: run + the 17 accessors (§4) — the last 19 functions (main + these)
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
  if (m.validate() === 0) {
    if (DBGEMIT) console.error(m.emitText());
    throw new WasmError("binaryen: compiled module failed validation");
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
    Object.hasOwn(BUILTIN_IMPORTS, n) &&
      o.usedBuiltins.has(BUILTIN_IMPORTS[n]));
  if (DBGEMIT)
    console.error("dropDeadHostImports:", JSON.stringify(live), "used:", [...o.usedBuiltins].join(","));
  o.liveImports = live;
  o.impIdx = new Map(live.map((n, i): [string, number] => [n, i]));
}
