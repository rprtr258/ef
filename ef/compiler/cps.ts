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
// stamp: the resumed/returned value must normalize to that width at the site
// (matching eval.ts's per-node evalE wrap), and a shared tail continuation
// can't absorb a per-site stamp.

import type {Expr, ExprID, Program} from "./parser.ts";
import type {CAtom, CCase, CFn, CIr, CPrim, CTerm} from "./cps_ir.ts";
import {assertNever} from "./assert.ts";

// The function-body continuation, bound by apply at call entry.
export const RET = "$ret";

// Ops the checker stamps with a compute width (widthOp path). Unstamped
// operator apps fall through to the value-dispatch natives in env.ts
// (string +, polymorphic ==, untyped / %).
const NUM_OPS = new Set(["+", "-", "*", "<", ">", "<=", ">=", "==", "!=", "neg"]);

type K = {t: "fn", f: (v: CAtom) => CTerm} | {t: "tail", name: string};

const UNIT: CAtom = {t: "lit", v: null};

class Converter {
  funcs: CFn[] = [];
  private n = 0;
  private prog: Program;
  // Value temps ($t prim results, $f closures): bind-once per activation, so
  // a continuation reading one across a suspension must freeze it (see
  // cps_ir.ts's letk.freeze).
  private temps = new Set<string>();

  constructor(prog: Program) {
    this.prog = prog;
  }

  private fresh(prefix: string): string {
    return `${prefix}${this.n++}`;
  }

  // Cross-suspension temps of a letk body: the body's free vars that are
  // converter-generated value temps, captured at letk execution.
  private freezeFor(body: CTerm): {name: string, val: CAtom}[] | undefined {
    const crossing = freeVars(body, new Set()).filter(nm => this.temps.has(nm));
    if (crossing.length === 0) return undefined;
    return crossing.map(nm => ({name: nm, val: {t: "var", name: nm}}));
  }

  private kap(k: K, v: CAtom): CTerm {
    return k.t === "tail"
      ? {t: "jump", k: {t: "var", name: k.name}, arg: v}
      : k.f(v);
  }

  // Left-to-right argument evaluation, each bound to a temp before the next
  // (a suspension mid-list captures the rest of the list, exactly like
  // eval.ts's evalArgs acc).
  private convArgs(args: ExprID[], kk: (vas: CAtom[]) => CTerm): CTerm {
    const go = (i: number, acc: CAtom[]): CTerm =>
      i === args.length
        ? kk(acc)
        : this.convert(args[i], {t: "fn", f: (v) => go(i + 1, acc.concat([v]))});
    return go(0, []);
  }

  // Bind a primitive result, then continue with its var. Prims never
  // suspend; they may throw (÷0, index out of bounds).
  private primLet(rhs: CPrim, k: K): CTerm {
    const name = this.fresh("$t");
    this.temps.add(name);
    return {t: "let", name, rhs, rest: this.kap(k, {t: "var", name})};
  }

  // The value-delivering tail of a call/perform site. Tail positions jump
  // the named continuation directly unless the site's numKind needs a norm
  // wrap (a shared tail continuation can't absorb a per-site width).
  private callTail(k: K, norm: string | undefined, mk: (kk: CAtom) => CTerm): CTerm {
    if (k.t === "tail" && norm === undefined)
      return mk({t: "var", name: k.name});
    const kc = this.fresh("$k");
    const rv = this.fresh("$v");
    const body = this.kap(k, {t: "var", name: rv});
    return {
      t: "letk", name: kc, param: rv, norm, freeze: this.freezeFor(body),
      body,
      rest: mk({t: "var", name: kc}),
    };
  }

  // All expr items chained: each item's value (discarded, except the last)
  // flows into the next; the last delivers to the program boundary. Items
  // bind into the caller's env (no scopes between items — top-level REPL
  // bindings land in ctx.env exactly like eval.ts's per-item eval did).
  program(): CTerm {
    const exprs: ExprID[] = [];
    for (const it of this.prog.items)
      if ("e" in it) exprs.push(it.e);
    if (exprs.length === 0) return {t: "halt", v: UNIT};
    let term = this.convert(exprs[exprs.length - 1], {t: "fn", f: (v) => ({t: "halt", v})});
    for (let i = exprs.length - 2; i >= 0; i--)
      term = this.convert(exprs[i], {t: "fn", f: () => term});
    return term;
  }

  private convert(id: ExprID, k: K): CTerm {
    const e: Expr = this.prog.nodes[id];
    switch (e.t) {
      case "num":
        // i64/u64 literals materialize from the raw lexeme at runtime (a JS
        // number loses bits beyond 2^53); the stamp normalizes.
        return this.kap(k, {t: "lit", v: e.v, raw: e.raw, stamp: e.numKind});
      case "str":
      case "bool":
        return this.kap(k, {t: "lit", v: e.v});
      case "unit":
        return this.kap(k, UNIT);
      case "sym": {
        // Force the read into a bind-once temp at walk position: every value
        // read before a possible suspension becomes a temp, and freezeFor
        // then freezes exactly the ones crossing it — the closure-argument
        // discipline of the pre-IR evaluator (an operand read pre-perform is
        // frozen; a post-resume read in a case body binds its temp at
        // execution time and stays live).
        const name = this.fresh("$t");
        this.temps.add(name);
        return {
          t: "bind", name,
          val: {t: "var", name: e.v, stamp: (e as Expr & {numKind?: string}).numKind},
          rest: this.kap(k, {t: "var", name}),
        };
      }
      case "lambda": {
        const params = e.params.map(p => p.name);
        const body = this.convert(e.body, {t: "tail", name: RET});
        const fun = this.funcs.length;
        this.funcs.push({
          params,
          capts: freeVars(body, new Set([RET, ...params])),
          body,
          typ: e.typ ?? undefined,
        });
        const name = this.fresh("$f");
        this.temps.add(name);
        return {
          t: "mkfn", name, params, capts: this.funcs[fun].capts, fun,
          rest: this.kap(k, {t: "var", name}),
        };
      }
      case "let":
        return this.convert(e.val, {t: "fn", f: (v) => ({
          t: "bind", name: e.name, val: v, rest: this.kap(k, UNIT),
        })});
      case "dlet":
        return this.convert(e.val, {t: "fn", f: (v) => ({
          t: "dlet", val: v, fields: e.fields.map(fd => fd.name), rest: this.kap(k, UNIT),
        })});
      case "assign":
        return this.convert(e.val, {t: "fn", f: (v) => ({
          t: "assign", name: e.name, val: v, rest: this.kap(k, UNIT),
        })});
      case "if": {
        // Tail positions: both arms jump the same named continuation — no
        // join needed. Otherwise bind a join letk so the (duplicated) rest
        // term isn't copied into both arms.
        if (k.t === "tail")
          return this.convert(e.c, {t: "fn", f: (cc) => ({
            t: "if", c: cc, a: this.convert(e.a, k), b: this.convert(e.b, k),
          })});
        const join = this.fresh("$k");
        const jv = this.fresh("$v");
        const jbody = k.f({t: "var", name: jv});
        return {
          t: "letk", name: join, param: jv, freeze: this.freezeFor(jbody), body: jbody, rest:
          this.convert(e.c, {t: "fn", f: (cc) => ({
            t: "if", c: cc,
            a: this.convert(e.a, {t: "tail", name: join}),
            b: this.convert(e.b, {t: "tail", name: join}),
          })}),
        };
        // Arms need no width wrap at the join: their producing nodes carry
        // the if node's own stamp (same type), so values arrive normalized.
      }
      case "while": {
        // Recursive continuation: $ka re-checks the condition; the body
        // jumps back to it; a false condition exits through $kx with unit.
        const kx = this.fresh("$k");
        const ka = this.fresh("$k");
        const vu = this.fresh("$v");
        const again: CTerm = {t: "jump", k: {t: "var", name: ka}, arg: UNIT};
        const condTerm = this.convert(e.c, {t: "fn", f: (cc) => ({
          t: "if", c: cc,
          a: this.convert(e.body, {t: "fn", f: () => again}),
          b: {t: "jump", k: {t: "var", name: kx}, arg: UNIT},
        })});
        const xbody = this.kap(k, {t: "var", name: vu});
        return {
          t: "letk", name: kx, param: vu, freeze: this.freezeFor(xbody), body: xbody, rest:
          {t: "letk", name: ka, param: vu, freeze: this.freezeFor(condTerm), body: condTerm, rest: again},
        };
      }
      case "block": {
        if (e.stmts.length === 0) return this.kap(k, UNIT);
        const go = (i: number): CTerm =>
          i === e.stmts.length - 1
            ? this.convert(e.stmts[i], k)
            : this.convert(e.stmts[i], {t: "fn", f: () => go(i + 1)});
        return {t: "scope", rest: go(0)};
      }
      case "perform":
        // k names the reified continuation: what resume injects into. When
        // the perform is itself the tail, that's the named tail directly.
        return this.callTail(k, (e as Expr & {numKind?: string}).numKind, (kk) =>
          this.convArgs(e.args, (vas) => ({t: "perform", op: e.op, args: vas, k: kk})));
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
        const ret = this.fresh("$hret");
        const exit = this.fresh("$xit");
        const cases: CCase[] = e.cases.map(c => ({
          op: c.op,
          params: c.params.map(p => p.name),
          resume: c.resume,
          body: this.convert(c.body, {t: "tail", name: exit}),
        }));
        return this.callTail(k, undefined, (kk) => ({
          t: "handle", ret, exit, k: kk, cases,
          body: this.convert(e.body, {t: "tail", name: ret}),
        }));
      }
      case "app": {
        // Operator fast path: dispatch on the app node's width stamp. `/`/`%`
        // add the division stamp (nk ?? div ?? "f64") — integer division
        // truncates and traps on ÷0 and INT_MIN÷-1 like wasm's div/rem ops.
        // The app node's own stamp (norm) re-normalizes the result.
        const fn = this.prog.nodes[e.fn];
        if (fn.t === "sym") {
          const op = fn.v;
          const nk = e.numKind;
          if (op === "/" || op === "%") {
            const stamp = nk ?? e.div ?? "f64";
            return this.convArgs(e.args, (vas) =>
              this.primLet({t: "op", op, args: vas, stamp, norm: nk}, k));
          }
          if (nk !== undefined && NUM_OPS.has(op))
            return this.convArgs(e.args, (vas) =>
              this.primLet({t: "op", op, args: vas, stamp: nk, norm: nk}, k));
        }
        // General call: fn first, then args left-to-right, then the call.
        return this.convert(e.fn, {t: "fn", f: (vf) =>
          this.convArgs(e.args, (vas) =>
            this.callTail(k, e.numKind, (kk) => ({t: "call", fn: vf, args: vas, k: kk})))});
      }
      case "as": {
        const asKind = e.asKind;
        const stamp = (e as Expr & {numKind?: string}).numKind;
        return this.convert(e.e, {t: "fn", f: (v) => {
          // No asKind and no stamp: a pure pass-through conversion.
          if (asKind === undefined && stamp === undefined)
            return this.kap(k, v);
          return this.primLet({t: "as", arg: v, asKind, stamp}, k);
        }});
      }
      case "arr":
        return this.convArgs(e.elems, (vas) =>
          this.primLet({t: "arr", args: vas, kind: e.arrKind === "tup" ? "tup" : "arr"}, k));
      case "field":
        return this.convert(e.obj, {t: "fn", f: (vo) =>
          this.primLet({t: "field", obj: vo, idx: e.idx!, name: e.name}, k)});
      default:
        return assertNever(e);
    }
  }
}

export function toCps(prog: Program): CIr {
  const c = new Converter(prog);
  return {funcs: c.funcs, term: c.program()};
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
