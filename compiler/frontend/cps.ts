// CPS conversion: checked AST → the cps_ir.ts term. This is the one
// conversion both backends consume (eval.ts interprets it; wasm defunctionalizes
// it) — effect/resume/multi-shot semantics live here, not per backend.
//
// Conversion is ANF-style: every compound value binds to a fresh `$`-temp
// before flowing on, so operands computed before a perform that are needed
// after it are let-bound before it — the continuation parameters and in-scope
// bindings are exactly the frozen accs a multi-shot resume must honor.
//
// The converter's own continuation K is either a meta function (build the
// rest term from the value's atom) or a tail position naming an existing
// continuation (the value jumps straight there — no wrapper letk). Wrapper
// letks are emitted for call/perform sites whose node carries a numKind
// stamp (Checked.stamps — the checker's per-node stamps side-table): the
// resumed/returned value must normalize to that width at the site
// (matching eval.ts's per-node evalE wrap), and a shared tail continuation
// can't absorb a per-site stamp.

import type {Expr, ExprID, Program} from "./parser.ts";
import type {CAtom, CCase, CFn, CIr, CPrim, CTerm} from "./cps_ir.ts";
import {optimizeCps} from "./cps_opt.ts";
import type {NodeStamps} from "../stamps.ts";
import {BUILTINS} from "./analysis.ts";
import {assertNever} from "../assert.ts";
import {OP_ADD, OP_DIV, OP_EQ, OP_GE, OP_GT, OP_LE, OP_LT, OP_MUL, OP_NE, OP_NEG, OP_REM, OP_SUB} from "../ops.ts";

// Builtin names the emitter specializes at direct call sites (analysis.ts's
// surface table — parser-types-only, so no import-order hazards).
const BUILTIN_NAMES = new Set(BUILTINS.map(b => b.name));
const isDirectBuiltinName = (n: string): boolean => BUILTIN_NAMES.has(n);

// The function-body continuation, bound by apply at call entry.
export const RET = "$ret";

// Ops the checker stamps with a compute width (widthOp path). Unstamped
// operator apps fall through to the value-dispatch natives in env.ts
// (string +, polymorphic ==, untyped / %).
const NUM_OPS = new Set([OP_ADD, OP_SUB, OP_MUL, OP_LT, OP_GT, OP_LE, OP_GE, OP_EQ, OP_NE, OP_NEG]);

type K = {t: "fn", f: (v: CAtom) => CTerm} | {t: "tail", name: string, dret?: true};

// The unit atom: its raw JS null must ride an i64 stamp so the wasm push
// boxes it (a stampless literal pushes raw — ref.null any — and unit-typed
// params become null frames).
const UNIT: CAtom = {t: "lit", v: null, stamp: "i64"};

function kap(k: K, v: CAtom): CTerm {
  if (k.t === "tail")
    return k.dret === true ? {t: "dret", v} : {t: "jump", k: {t: "var", name: k.name}, arg: v};
  return k.f(v);
}

// Direct-boundary classification: the lambda's resolved effect row is empty
// AND no suspending call sits in the body's tail chain. An empty row means
// every perform in the body is lexically under a covering handler (a
// suspending call or uncovered perform would land in the row), so mixed
// functions — row {} with internal handles — keep the direct boundary and
// their islands run over the ambient chain like any CPS region. The tail
// guard closes the row's blind spot: a resume binder's type performs
// nothing (contCall stamps an empty row) and an `any` callee's row is
// unread, so a tail call to either would flow the never-set $ret into a
// callee that can suspend, severing the ambient chain its performs walk.
// Unstamped or any-absorbed lambdas default to CPS.
function isDirectFn(prog: Program, stamps: readonly (NodeStamps | undefined)[], id: ExprID): boolean {
  const typ = stamps[id]?.typ;
  if (typ === undefined || typ.effs.ops.size !== 0 || typ.effs.vars.size !== 0) return false;
  return !tailSusCall(prog, stamps, (prog.nodes[id] as Expr & {t: "lambda"}).body);
}

// A checker-stamped suspending app anywhere in the AST tail chain — exactly
// the call shapes the converter emits as `call {k: $ret}` (non-tail sites
// become dcall with a materialized land cell).
function tailSusCall(prog: Program, stamps: readonly (NodeStamps | undefined)[], id: ExprID): boolean {
  const e = prog.nodes[id];
  switch (e.t) {
    case "app": return stamps[id]?.sus === true;
    case "if": return tailSusCall(prog, stamps, e.a) || tailSusCall(prog, stamps, e.b);
    case "block": return e.stmts.length > 0 && tailSusCall(prog, stamps, e.stmts[e.stmts.length - 1]);
    case "as": return tailSusCall(prog, stamps, e.e);
    default: return false;
  }
}

// Conversion state: plain data threaded through the free functions below —
// emitted fns, the temp counter and bind-once temp set, the program slice,
// and the checker's per-node stamps.
type Converter = {
  funcs: CFn[],
  n: number,
  prog: Program,
  // Value temps ($t prim results, $f closures): bind-once per activation, so
  // a continuation reading one across a suspension must freeze it (see
  // cps_ir.ts's letk.freeze).
  temps: Set<string>,
  stamps: readonly (NodeStamps | undefined)[],
};

function newConverter(prog: Program, stamps: readonly (NodeStamps | undefined)[] = []): Converter {
  return {funcs: [], n: 0, prog, temps: new Set<string>(), stamps};
}

function fresh(c: Converter, prefix: string): string {
  return `${prefix}${c.n++}`;
}

// Cross-suspension temps of a letk body: the body's free vars that are
// converter-generated value temps, captured at letk execution.
function freezeFor(c: Converter, body: CTerm): {name: string, val: CAtom}[] | undefined {
  const crossing = freeVars(body, new Set()).filter(nm => c.temps.has(nm));
  if (crossing.length === 0)
  return undefined;
  return crossing.map(nm => ({name: nm, val: {t: "var", name: nm}}));
}

// Left-to-right argument evaluation, each bound to a temp before the next
// (a suspension mid-list captures the rest of the list, exactly like
// eval.ts's evalArgs acc).
function convArgs(c: Converter, args: ExprID[], kk: (vas: CAtom[]) => CTerm): CTerm {
  const go = (i: number, acc: CAtom[]): CTerm =>
  i === args.length
  ? kk(acc)
  : convert(c, args[i], {t: "fn", f: (v) => go(i + 1, acc.concat([v]))});
  return go(0, []);
}

// Bind a primitive result, then continue with its var. Prims never
// suspend; they may throw (÷0, index out of bounds).
function primLet(c: Converter, rhs: CPrim, k: K): CTerm {
  const name = fresh(c, "$t");
  c.temps.add(name);
  return {t: "let", name, rhs, rest: kap(k, {t: "var", name})};
}

// The value-delivering tail of a call/perform site. Tail positions jump
// the named continuation directly unless the site's numKind needs a norm
// wrap (a shared tail continuation can't absorb a per-site width).
function callTail(c: Converter, k: K, norm: string | undefined, mk: (kk: CAtom) => CTerm): CTerm {
  if (k.t === "tail" && norm === undefined)
  return mk({t: "var", name: k.name});
  const kc = fresh(c, "$k");
  const rv = fresh(c, "$v");
  const body = kap(k, {t: "var", name: rv});
  return {
    t: "letk", name: kc, param: rv, norm, freeze: freezeFor(c, body),
    body,
    rest: mk({t: "var", name: kc}),
    };
}

// All expr items chained: each item's value (discarded, except the last)
// flows into the next; the last delivers to the program boundary. Items
// bind into the caller's env (no scopes between items — top-level REPL
// bindings land in ctx.env exactly like eval.ts's per-item eval did).
function program(c: Converter): CTerm {
  const exprs: ExprID[] = [];
  for (const it of c.prog.items)
  if ("e" in it) exprs.push(it.e);
  if (exprs.length === 0) return {t: "halt", v: UNIT};
  let term = convert(c, exprs[exprs.length - 1], {t: "fn", f: (v) => ({t: "halt", v})});
  for (let i = exprs.length - 2; i >= 0; i--)
  term = convert(c, exprs[i], {t: "fn", f: () => term});
  return term;
}

function convert(c: Converter, id: ExprID, k: K): CTerm {
  const e: Expr = c.prog.nodes[id];
  switch (e.t) {
    case "num":
    // i64/u64 literals materialize from the raw lexeme at runtime (a JS
    // number loses bits beyond 2^53); the stamp normalizes.
    return kap(k, {t: "lit", v: e.v, raw: e.raw, stamp: c.stamps[id]?.numKind});
    case "str":
    case "bool":
    return kap(k, {t: "lit", v: e.v});
    case "unit":
    return kap(k, UNIT);
    case "sym": {
      // Force the read into a bind-once temp at walk position: every value
      // read before a possible suspension becomes a temp, and freezeFor
      // then freezes exactly the ones crossing it (an operand read
      // pre-perform is frozen; a post-resume read in a case body binds
      // its temp at execution time and stays live).
      const name = fresh(c, "$t");
      c.temps.add(name);
      return {
        t: "bind", name,
        val: {t: "var", name: e.v, stamp: c.stamps[id]?.numKind,
          adaptFrom: (e as Expr & {adaptFrom?: string}).adaptFrom},
        rest: kap(k, {t: "var", name}),
        };
    }
    case "lambda": {
      const params = e.params.map(p => p.name);
      const direct = isDirectFn(c.prog, c.stamps, id);
      const body = convert(c, e.body, direct ? {t: "tail", name: RET, dret: true} : {t: "tail", name: RET});
      const fun = c.funcs.length;
      c.funcs.push({
        params,
        capts: freeVars(body, new Set([RET, ...params])),
        body,
        typ: c.stamps[id]?.typ,
        direct: direct || undefined,
        });
      const name = fresh(c, "$f");
      c.temps.add(name);
      return {
        t: "mkfn", name, params, capts: c.funcs[fun].capts, fun,
        rest: kap(k, {t: "var", name}),
        };
    }
    case "let":
    return convert(c, e.val, {t: "fn", f: (v) => ({
        t: "bind", name: e.name, val: v, rest: kap(k, UNIT),
        })});
    case "dlet":
    return convert(c, e.val, {t: "fn", f: (v) => ({
        t: "dlet", val: v, fields: e.fields.map(fd => fd.name), rest: kap(k, UNIT),
        })});
    case "assign":
    return convert(c, e.val, {t: "fn", f: (v) => ({
        t: "assign", name: e.name, val: v, rest: kap(k, UNIT),
        })});
    case "if": {
      // Tail positions: both arms jump the same named continuation — no
      // join needed. Otherwise bind a join letk so the (duplicated) rest
      // term isn't copied into both arms.
      if (k.t === "tail")
      return convert(c, e.c, {t: "fn", f: (cc) => ({
          t: "if", c: cc, a: convert(c, e.a, k), b: convert(c, e.b, k),
          })});
      const join = fresh(c, "$k");
      const jv = fresh(c, "$v");
      const jbody = k.f({t: "var", name: jv});
      return {
        t: "letk", name: join, param: jv, freeze: freezeFor(c, jbody), body: jbody, rest:
        convert(c, e.c, {t: "fn", f: (cc) => ({
            t: "if", c: cc,
            a: convert(c, e.a, {t: "tail", name: join}),
            b: convert(c, e.b, {t: "tail", name: join}),
            })}),
        };
      // Arms need no width wrap at the join: their producing nodes carry
      // the if node's own stamp (same type), so values arrive normalized.
    }
    case "while": {
      // Recursive continuation: $ka re-checks the condition; the body
      // jumps back to it; a false condition exits through $kx with unit.
      const kx = fresh(c, "$k");
      const ka = fresh(c, "$k");
      const vu = fresh(c, "$v");
      const again: CTerm = {t: "jump", k: {t: "var", name: ka}, arg: UNIT};
      const condTerm = convert(c, e.c, {t: "fn", f: (cc) => ({
          t: "if", c: cc,
          a: convert(c, e.body, {t: "fn", f: () => again}),
          b: {t: "jump", k: {t: "var", name: kx}, arg: UNIT},
          })});
      const xbody = kap(k, {t: "var", name: vu});
      return {
        t: "letk", name: kx, param: vu, freeze: freezeFor(c, xbody), body: xbody, rest:
        {t: "letk", name: ka, param: vu, freeze: freezeFor(c, condTerm), body: condTerm, rest: again},
        };
    }
    case "block": {
      if (e.stmts.length === 0) return kap(k, UNIT);
      const go = (i: number): CTerm =>
      i === e.stmts.length - 1
      // A `;` after the tail expression discards its value: the block
      // completes with unit after the statement finishes evaluating.
      ? e.semi
      ? convert(c, e.stmts[i], {t: "fn", f: () => kap(k, UNIT)})
      : convert(c, e.stmts[i], k)
      : convert(c, e.stmts[i], {t: "fn", f: () => go(i + 1)});
      return {t: "scope", rest: go(0)};
    }
    case "perform":
    // k names the reified continuation: what resume injects into. When
    // the perform is itself the tail, that's the named tail directly.
    return callTail(c, k, c.stamps[id]?.numKind, (kk) =>
    convArgs(c, e.args, (vas) => ({t: "perform", op: e.op, args: vas, k: kk})));
    case "handle": {
      // $hret: the handled body's exit — the runtime binds it to the
      // done-wrapper. $xit: each case's exit — the runtime rebinds it per
      // run() to the current continuation (it differs on resume
      // re-entries). Case bodies jump $xit; the handled body jumps $hret.
      // Case resume binders keep the user's name (checker-guaranteed
      // shadowing-free): the case body references it, and the runtime
      // binds the resume native under exactly that name. The handle's own
      // κ goes through callTail like any value-delivering site — its
      // completion paths are runtime-driven, so the continuation must be
      // a resolvable operand, not the ambient.
      const ret = fresh(c, "$hret");
      const exit = fresh(c, "$xit");
      const cases: CCase[] = e.cases.map(hc => ({
        op: hc.op,
        params: hc.params.map(p => p.name),
        resume: hc.resume,
        body: convert(c, hc.body, {t: "tail", name: exit}),
        }));
      return callTail(c, k, undefined, (kk) => ({
        t: "handle", ret, exit, k: kk, cases,
        body: convert(c, e.body, {t: "tail", name: ret}),
        }));
    }
    case "app": {
      // Operator fast path: dispatch on the app node's width stamp. `/`/`%`
      // add the division stamp (nk ?? div ?? "f64") — integer division
      // truncates and traps on ÷0 and INT_MIN÷-1 like wasm's div/rem ops.
      // The app node's own stamp (norm) re-normalizes the result.
      const nk = c.stamps[id]?.numKind;
      const fn = c.prog.nodes[e.fn];
      if (fn.t === "sym") {
        const op = fn.v;
        if (op === OP_DIV || op === OP_REM) {
          const stamp = nk ?? c.stamps[id]?.div ?? "f64";
          return convArgs(c, e.args, (vas) =>
          primLet(c, {t: "op", op, args: vas, stamp, norm: nk}, k));
        }
        if (nk !== undefined && NUM_OPS.has(op))
        return convArgs(c, e.args, (vas) =>
        primLet(c, {t: "op", op, args: vas, stamp: nk, norm: nk}, k));
      }
      // Classified-pure callee (checker stamp): a direct call — the result
      // binds in-frame and the term continues, with no continuation
      // machinery at the site. Builtin-sym callees stay unbound names (the
      // emitter specializes them), like the generic paths below.
      if (c.stamps[id]?.sus === false) {
        const dcallK = (vf: CAtom) => (vas: CAtom[]): CTerm => {
          const name = fresh(c, "$c");
          c.temps.add(name);
          return {t: "dcall", fn: vf, args: vas, name, norm: nk, rest: kap(k, {t: "var", name})};
          };
        if (fn.t === "sym" && isDirectBuiltinName(fn.v))
        return convArgs(c, e.args, (vas) => dcallK({t: "var", name: fn.v})(vas));
        return convert(c, e.fn, {t: "fn", f: (vf) => convArgs(c, e.args, (vas) => dcallK(vf)(vas))});
      }
      // General call: fn first, then args left-to-right, then the call.
      // A sym naming a builtin in callee position stays an unbound name:
      // the emitter specializes it to the builtin's trampoline
      // (directBuiltin) — temp-binding it would strand the name in a
      // slot no runtime value ever fills.
      if (fn.t === "sym" && isDirectBuiltinName(fn.v)) {
        return convArgs(c, e.args, (vas) =>
        callTail(c, k, nk, (kk) =>
        ({t: "call", fn: {t: "var", name: fn.v}, args: vas, k: kk, rstamp: nk})));
      }
      return convert(c, e.fn, {t: "fn", f: (vf) =>
        convArgs(c, e.args, (vas) =>
        callTail(c, k, nk, (kk) => ({t: "call", fn: vf, args: vas, k: kk, rstamp: nk})))});
    }
    case "as": {
      const asKind = c.stamps[id]?.asKind;
      const stamp = c.stamps[id]?.numKind;
      return convert(c, e.e, {t: "fn", f: (v) => {
          // No asKind and no stamp: a pure pass-through conversion.
          if (asKind === undefined && stamp === undefined)
          return kap(k, v);
          return primLet(c, {t: "as", arg: v, asKind, stamp}, k);
          }});
    }
    case "arr":
    return convArgs(c, e.elems, (vas) =>
    primLet(c, {t: "arr", args: vas, kind: c.stamps[id]?.arrKind === "tup" ? "tup" : "arr"}, k));
    case "field": {
      // Checked programs always stamp fieldIdx here; unchecked ones (the
      // cps_opt tests' bare toCps) legitimately flow undefined, like e.idx
      // did when it lived on the node.
      const idx = c.stamps[id]?.fieldIdx as number;
      return convert(c, e.obj, {t: "fn", f: (vo) =>
        primLet(c, {t: "field", obj: vo, idx, name: e.name}, k)});
    }
    default:
    return assertNever(e);
  }
}

export function toCps(prog: Program, stamps: readonly (NodeStamps | undefined)[] = []): CIr {
  const c = newConverter(prog, stamps);
  // The optimization passes are the conversion's final stage: every consumer
  // of toCps (interpreter, wasm backend) sees the same optimized term, and
  // none of them knows the passes exist.
  return optimizeCps({funcs: c.funcs, term: program(c)});
}

// Free value variables of a term (wasm's captured-frame-slot set; the
// closure interpreter just uses env chains). Continuation names count as
// bound only where the runtime binds them: letk names, `$ret`, handle
// ret/exit, case params/resumes.
function freeVars(t: CTerm, bound: Set<string>): string[] {
  const free = new Set<string>();
  const walk = (t: CTerm, bound: Set<string>): void => {
    // Defined inside walk so they see THIS term's bound set, not the
    // initial one.
    const atom = (a: CAtom): void => {
      if (a.t === "var" && !bound.has(a.name)) free.add(a.name);
    };
    const withB = (names: string[]): Set<string> => {
      const b = new Set(bound);
      for (const nm of names) b.add(nm);
      return b;
    };
    switch (t.t) {
      case "letk":
        walk(t.body, withB([t.name, t.param]));
        walk(t.rest, withB([t.name]));
        return;
      case "let":
        for (const a of t.rhs.t === "op" ? t.rhs.args : t.rhs.t === "arr" ? t.rhs.args : [t.rhs.t === "as" ? t.rhs.arg : t.rhs.obj])
          atom(a);
        walk(t.rest, withB([t.name]));
        return;
      case "bind":
        atom(t.val);
        walk(t.rest, withB([t.name]));
        return;
      case "mkfn":
        walk(t.rest, withB([t.name]));
        return;
      case "call":
        atom(t.fn);
        for (const a of t.args) atom(a);
        atom(t.k);
        return;
      case "dcall":
        atom(t.fn);
        for (const a of t.args) atom(a);
        walk(t.rest, withB([t.name]));
        return;
      case "dret":
        atom(t.v);
        return;
      case "perform":
        for (const a of t.args) atom(a);
        atom(t.k);
        return;
      case "handle": {
        walk(t.body, withB([t.ret]));
        for (const c of t.cases)
          walk(c.body, withB([t.exit, c.resume, ...c.params]));
        return;
      }
      case "if":
        atom(t.c);
        walk(t.a, bound);
        walk(t.b, bound);
        return;
      case "scope":
        walk(t.rest, bound);
        return;
      case "dlet":
        atom(t.val);
        walk(t.rest, withB(t.fields));
        return;
      case "assign":
        atom(t.val);
        walk(t.rest, bound);
        return;
      case "jump":
        atom(t.k);
        atom(t.arg);
        return;
      case "halt":
        atom(t.v);
        return;
      default:
        assertNever(t);
    }
  };
  walk(t, bound);
  return [...free];
}
