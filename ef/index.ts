// A tiny interpreted language with algebraic effects, C/Go-flavoured syntax.
// Two passes: a static type checker (bidirectional + union-find unification,
// with monomorphic effect tracking), then a CPS evaluator whose continuation
// is a plain JS function — giving true multi-shot `resume`.

import {readFileSync, writeFileSync} from "node:fs";
import * as readline from "node:readline";

// --- Values (runtime) ---

type Value =
  | number
  | string
  | boolean
  | null
  | Value[]
  | Closure
  | Native;

type Closure = {
  tag: "fn";
  params: string[];
  body: Expr;
  env: Env;
  typ?: FunT;
};
type Native = {
  tag: "native";
  fn: (args: Value[], k: Cont) => Outcome;
};

class Env {
  vars = new Map<string, Value>();
  constructor(public parent: Env | null) {}
}
function lookup(env: Env, name: string): Value {
  let e: Env | null = env;
  while (e) {
    if (e.vars.has(name)) return e.vars.get(name) as Value;
    e = e.parent;
  }
  throw new Error("Unbound symbol: " + name);
}
// Assign to the nearest enclosing scope that already binds `name`.
function assignVar(env: Env, name: string, v: Value): void {
  let e: Env | null = env;
  while (e) {
    if (e.vars.has(name)) { e.vars.set(name, v); return; }
    e = e.parent;
  }
  throw new Error("Assignment to unbound symbol: " + name);
}
function extend(parent: Env): Env {
  return new Env(parent);
}

// --- Outcomes & continuations ---

type Outcome =
  | { tag: "done"; value: Value }
  | { tag: "eff"; op: string; args: Value[]; k: Cont };

type Cont = (v: Value) => Outcome;

// --- Types ---

type Type = Prim | ArrT | FunT | Var | AnyT;
type Prim = { tag: "prim"; name: "int" | "float" | "string" | "bool" | "unit" };
type ArrT = { tag: "arr"; elem: Type };
// Effect rows: a concrete `Set<string>` of performed effects, or an
// unbound effect variable (row polymorphism). Effect variables unify by
// union-find; a variable unifies with a concrete set by binding to it; two
// concrete sets unify by equality. This lets higher-order builtins be
// effect-polymorphic: `map : ((a) -> b ! e, [a]) -> [b] ! e` for a fresh `e`.
type EffVar = { tag: "effvar"; id: number };
type Effs = Set<string> | EffVar;
type FunT = { tag: "fun"; params: Type[]; ret: Type; effs: Effs };
type Var = { tag: "var"; id: number };
type AnyT = { tag: "any" };

const TINT: Prim = { tag: "prim", name: "int" };
const TFLOAT: Prim = { tag: "prim", name: "float" };
const TSTR: Prim = { tag: "prim", name: "string" };
const TBOOL: Prim = { tag: "prim", name: "bool" };
const TNULL: Prim = { tag: "prim", name: "unit" };
const TANY: AnyT = { tag: "any" };

function tArr(elem: Type): ArrT { return { tag: "arr", elem }; }
function tFun(params: Type[], ret: Type, effs: Effs): FunT {
  return { tag: "fun", params, ret, effs };
}

export function showT(t: Type): string {
  switch (t.tag) {
    case "prim": return t.name;
    case "arr": return "[" + showT(t.elem) + "]";
    case "any": return "any";
    case "var": {
      const r = res(t);
      return r.tag === "var" ? "t" + r.id : showT(r);
    }
    case "fun": {
      const ps = t.params.map(showT).join(", ");
      const er = resEff(t.effs);
      const e = er instanceof Set
        ? (er.size ? " ! { " + [...er].join(", ") + " }" : "")
        : " ! { e" + er.id + " }";
      return "(" + ps + ") -> " + showT(t.ret) + e;
    }
  }
}

// True if `t` contains an `any` (the absorbing escape type). Used to warn when
// `any` is *inferred* (e.g. from `list(...)` / `head` of an `[any]`) rather than
// explicitly written, so silent escapes are visible. `res` is applied so bound
// type variables are resolved before checking.
function containsAny(t: Type): boolean {
  const r = res(t);
  if (r.tag === "any") return true;
  if (r.tag === "arr") return containsAny(r.elem);
  if (r.tag === "fun") return r.params.some(containsAny) || containsAny(r.ret);
  return false;
}

function warnInferredAny(name: string, t: Type): void {
  console.warn(
    `warning: \`${name}\` inferred as \`${showT(res(t))}\` (contains \`any\`); ` +
    `add an explicit annotation to silence`,
  );
}

// Effect declaration: parameter types + the type the resumed continuation yields.
type EffectSig = {
  params: Type[];
  ret: Type;
};

// --- AST ---

type Expr =
  | { t: "num"; v: number; isFloat: boolean }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "unit" }
  | { t: "sym"; v: string }
  | { t: "lambda"; params: Param[]; retTyp: Type | null; retEffs: Set<string> | null; body: Expr; typ?: FunT }
  | { t: "let"; name: string; typ: Type | null; val: Expr }
  | { t: "if"; c: Expr; a: Expr; b: Expr }
  | { t: "while"; c: Expr; body: Expr }
  | { t: "assign"; name: string; val: Expr }
  | { t: "block"; stmts: Expr[] }
  | { t: "perform"; op: string; args: Expr[] }
  | { t: "handle"; body: Expr; cases: HandlerCase[] }
  | { t: "app"; fn: Expr; args: Expr[]; div?: "int" | "float" };

type Param = { name: string; typ: Type | null; pos?: Pos };

type HandlerCase = {
  op: string;
  params: Param[];
  resume: string;
  body: Expr;
};

// A top-level program item: an expression or an effect declaration.
type Item = { e: Expr } | { effect: string; sig: EffectSig };

// --- Lexer ---

const KEYWORDS = new Set([
  "let", "fn", "if", "else", "while", "handle", "case",
  "true", "false", "unit", "effect",
]);
const TWO = ["==", "!=", "<=", ">=", "&&", "||", "=>"];
const ONE = "()[]{},;<>+-*/!=:%";

// A source position: 1-indexed line and column.
export type Pos = { line: number; col: number };
type Tok = { v: string; pos: Pos };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  // Indices where each line begins (line 1 at 0); lets us map a char index to
  // {line, col} without threading counters through the scanner.
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const posAt = (i: number): Pos => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((lineStarts[mid] ?? 0) <= i) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: i - lineStarts[lo]! + 1 };
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (" \t\n\r".includes(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      toks.push({ v: src.slice(start, j + 1), pos: posAt(start) });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO.includes(two)) {
      toks.push({ v: two, pos: posAt(i) });
      i += 2;
      continue;
    }
    if (ONE.includes(c)) {
      toks.push({ v: c, pos: posAt(i) });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      toks.push({ v: src.slice(start, j), pos: posAt(start) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push({ v: src.slice(start, j), pos: posAt(start) });
      i = j;
      continue;
    }
    throw new Error("Bad char: " + c);
  }
  return toks;
}

// --- Parser (recursive descent + Pratt for infix) ---

// Unescape a string literal token (with surrounding quotes).
function parseStr(t: string): string {
  const s = t.slice(1, -1);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c !== "\\") { out += c; i++; continue; }
    const n = s[i + 1]!;
    if (n === "n") { out += "\n"; i += 2; }
    else if (n === "t") { out += "\t"; i += 2; }
    else if (n === "r") { out += "\r"; i += 2; }
    else if (n === "\\") { out += "\\"; i += 2; }
    else if (n === "\"") { out += "\""; i += 2; }
    else if (n === "x") { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; }
    else if (n === "u") { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; }
    else { out += n; i += 2; }
  }
  return out;
}

class Parser {
  toks: Tok[];
  i = 0;
  constructor(src: string) {
    this.toks = lex(src);
  }
  peek(o = 0): string | undefined {
    return this.toks[this.i + o]?.v;
  }
  next(): string {
    return this.toks[this.i++]!.v;
  }
  // Position of the token at offset `o` from the cursor (undefined past EOF).
  pos(o = 0): Pos | undefined {
    return this.toks[this.i + o]?.pos;
  }
  eat(s: string): void {
    if (this.peek() !== s) throw new Error(`Expected "${s}", got "${this.peek()}"`);
    this.i++;
  }
  is(s: string): boolean {
    return this.peek() === s;
  }
  isKw(kw: string): boolean {
    return this.peek() === kw && KEYWORDS.has(kw);
  }
  atEnd(): boolean {
    return this.i >= this.toks.length;
  }

  parseProgram(): Item[] {
    const out: Item[] = [];
    while (!this.atEnd()) {
      if (this.isKw("effect")) out.push(this.parseEffect());
      else out.push({ e: this.parseStmt() });
    }
    return out;
  }
  parseEffect(): Item {
    this.next(); // effect
    const name = this.next();
    const params = this.parseParams();
    this.eat(":");
    const ret = this.parseType();
    this.eat(";");
    return { effect: name, sig: { params: params.map(p => p.typ ?? freshVar()), ret } };
  }

  parseStmt(): Expr {
    let e: Expr;
    if (this.isKw("let")) {
      this.next();
      const name = this.next();
      const typ = this.is(":") ? (this.next(), this.parseType()) : null;
      this.eat("=");
      const val = this.parseExpr();
      this.eat(";");
      e = { t: "let", name, typ, val };
    } else if (!KEYWORDS.has(this.peek() ?? "") && this.peek(1) === "=") {
      const name = this.next();
      this.next(); // =
      const val = this.parseExpr();
      if (this.is(";")) this.i++;
      e = { t: "assign", name, val };
    } else {
      e = this.parseExpr();
      if (this.is(";")) this.i++;
      else if (!isBlocky(e) && !this.is("}") && !this.atEnd()) this.eat(";");
    }
    return e;
  }

  parseParams(): Param[] {
    this.eat("(");
    const params: Param[] = [];
    while (!this.is(")")) {
      const pos = this.pos();
      const name = this.next();
      const typ = this.is(":") ? (this.next(), this.parseType()) : null;
      params.push({ name, typ, pos });
      if (this.is(",")) this.i++;
    }
    this.eat(")");
    return params;
  }
  parseArgs(): Expr[] {
    this.eat("(");
    const args: Expr[] = [];
    while (!this.is(")")) {
      args.push(this.parseExpr());
      if (this.is(",")) this.i++;
    }
    this.eat(")");
    return args;
  }
  parseBlock(): Expr {
    this.eat("{");
    const stmts: Expr[] = [];
    while (!this.is("}")) stmts.push(this.parseStmt());
    this.eat("}");
    return { t: "block", stmts };
  }

  // optional `! { op, op, ... }` effect annotation on a fn return type
  parseEffAnnot(): Set<string> | null {
    if (!this.is("!")) return null;
    this.next();
    this.eat("{");
    const effs = new Set<string>();
    while (!this.is("}")) {
      effs.add(this.next());
      if (this.is(",")) this.i++;
    }
    this.eat("}");
    return effs;
  }

  // types
  parseType(): Type {
    if (this.is("[")) {
      this.next();
      const e = this.parseType();
      this.eat("]");
      return tArr(e);
    }
    if (this.is("(")) {
      this.next();
      const ps: Type[] = [];
      while (!this.is(")")) {
        ps.push(this.parseType());
        if (this.is(",")) this.i++;
      }
      this.eat(")");
      this.eat("-");
      this.eat(">");
      const ret = this.parseType();
      const effs = new Set<string>();
      if (this.is("!")) {
        this.next();
        this.eat("{");
        while (!this.is("}")) {
          effs.add(this.next());
          if (this.is(",")) this.i++;
        }
        this.eat("}");
      }
      return tFun(ps, ret, effs);
    }
    const name = this.next();
    switch (name) {
      case "int": return TINT;
      case "float": return TFLOAT;
      case "string": return TSTR;
      case "bool": return TBOOL;
      case "unit": return TNULL;
      case "any": return TANY;
      default: throw new Error("Unknown type: " + name);
    }
  }

  // --- Pratt ---
  static PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
  binOps = new Set(Object.keys(Parser.PREC));

  parseExpr(): Expr {
    return this.parseBinary(0);
  }
  parseBinary(min: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek();
      if (!op || !this.binOps.has(op)) break;
      const prec = Parser.PREC[op]!;
      if (prec < min) break;
      this.next();
      const right = this.parseBinary(prec + 1);
      if (op === "&&") left = { t: "if", c: left, a: right, b: { t: "bool", v: false } };
      else if (op === "||") left = { t: "if", c: left, a: { t: "bool", v: true }, b: right };
      else left = { t: "app", fn: { t: "sym", v: op }, args: [left, right] };
    }
    return left;
  }
  parseUnary(): Expr {
    if (this.is("-")) {
      this.next();
      return { t: "app", fn: { t: "sym", v: "neg" }, args: [this.parseUnary()] };
    }
    if (this.is("!")) {
      this.next();
      return { t: "app", fn: { t: "sym", v: "not" }, args: [this.parseUnary()] };
    }
    return this.parsePostfix();
  }
  parsePostfix(): Expr {
    let e = this.parsePrimary();
    // perform: `Op!(args)` (postfix `!` after an effect name).
    if (e.t === "sym" && this.is("!") && this.peek(1) === "(") {
      const op = e.v;
      this.next(); // !
      const args = this.parseArgs();
      e = { t: "perform", op, args };
    }
    while (this.is("(")) {
      const args = this.parseArgs();
      e = { t: "app", fn: e, args };
    }
    return e;
  }
  parsePrimary(): Expr {
    const t = this.peek();
    if (t === undefined) throw new Error("Unexpected EOF");
    if (/^-?\d/.test(t)) {
      this.next();
      return { t: "num", v: Number(t), isFloat: t.includes(".") };
    }
    if (t.startsWith('"')) {
      this.next();
      return { t: "str", v: parseStr(t) };
    }
    if (t === "true") {
      this.next();
      return { t: "bool", v: true };
    }
    if (t === "false") {
      this.next();
      return { t: "bool", v: false };
    }
    if (t === "unit") {
      this.next();
      return { t: "unit" };
    }
    if (t === "(") {
      this.next();
      const e = this.parseExpr();
      this.eat(")");
      return e;
    }
    if (t === "[") {
      this.next();
      const els: Expr[] = [];
      while (!this.is("]")) {
        els.push(this.parseExpr());
        if (this.is(",")) this.i++;
      }
      this.eat("]");
      return { t: "app", fn: { t: "sym", v: "list" }, args: els };
    }
    if (this.isKw("fn")) {
      this.next();
      const params = this.parseParams();
      const retTyp = this.is(":") ? (this.next(), this.parseType()) : null;
      const retEffs = this.parseEffAnnot();
      const body = this.parseBlock();
      return { t: "lambda", params, retTyp, retEffs, body };
    }
    if (this.isKw("if")) {
      this.next();
      this.eat("(");
      const c = this.parseExpr();
      this.eat(")");
      const a = this.parseBlock();
      let b: Expr = { t: "unit" };
      if (this.isKw("else")) {
        this.next();
        b = this.isKw("if") ? this.parsePrimary() : this.parseBlock();
      } else if (this.is(";")) {
        this.i++;
      }
      return { t: "if", c, a, b };
    }
    if (this.isKw("while")) {
      this.next();
      this.eat("(");
      const c = this.parseExpr();
      this.eat(")");
      const body = this.parseBlock();
      return { t: "while", c, body };
    }
    if (this.isKw("handle")) {
      this.next();
      const body = this.parseBlock();
      const cases: HandlerCase[] = [];
      while (this.isKw("case")) {
        this.next();
        const op = this.next();
        const params = this.parseParams();
        this.eat("=>");
        const resume = this.next();
        const cbody = this.parseBlock();
        cases.push({ op, params, resume, body: cbody });
      }
      return { t: "handle", body, cases };
    }
    this.next();
    return { t: "sym", v: t };
  }
}

function isBlocky(e: Expr): boolean {
  return e.t === "block" || e.t === "if" || e.t === "while" || e.t === "handle" || e.t === "lambda";
}

// --- Type checker ---

// Union-find over type variables; substitution stored in `binds`.
class Uni {
  parent = new Map<number, number>();
  n = 0;
  fresh(): Var {
    const id = this.n++;
    this.parent.set(id, id);
    return { tag: "var", id };
  }
  find(id: number): number {
    let r = id;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    while (this.parent.get(id) !== r) {
      const nx = this.parent.get(id)!;
      this.parent.set(id, r);
      id = nx;
    }
    return r;
  }
}
const uni = new Uni();
function freshVar(): Var { return uni.fresh(); }
const binds = new Map<number, Type>();

// --- Effect variables (row polymorphism) ---
// Separate union-find from type variables: effect rows resolve to `Set<string>`
// (or stay unbound variables), not to `Type`s.
let effCounter = 0;
const effParent = new Map<number, number>();
const effBinds = new Map<number, Set<string>>();
function freshEff(): EffVar {
  const id = effCounter++;
  effParent.set(id, id);
  return { tag: "effvar", id };
}
function effFind(id: number): number {
  let r = id;
  while (effParent.get(r) !== r) r = effParent.get(r)!;
  let c = id;
  while (effParent.get(c) !== r) {
    const nx = effParent.get(c)!;
    effParent.set(c, r);
    c = nx;
  }
  return r;
}
// Resolve an effect row: follow the union-find; if bound, return the concrete
// set (and further resolve any set-of... sets are always ground). Unbound →
// the canonical variable.
function resEff(e: Effs): Effs {
  if (e instanceof Set) return e;
  const r = effFind(e.id);
  const b = effBinds.get(r);
  return b ?? { tag: "effvar", id: r };
}
// Unify two effect rows. var+var union; var+set binds; set+set requires
// equality — except the empty set `∅` is the polymorphic bottom: a function
// typed `... ! ∅` performs no effects and may be used wherever *any* effect
// set is expected (it is refined to the other set). This keeps unannotated
// HOF parameters flexible without let-generalization.
function unifyEff(a: Effs, b: Effs): void {
  const ra = resEff(a), rb = resEff(b);
  if (!(ra instanceof Set) && !(rb instanceof Set)) {
    effParent.set(effFind(ra.id), effFind(rb.id));
    return;
  }
  if (!(ra instanceof Set)) { effBinds.set(effFind(ra.id), rb as Set<string>); return; }
  if (!(rb instanceof Set)) { effBinds.set(effFind(rb.id), ra as Set<string>); return; }
  if (ra.size === 0) return; // ∅ unifies with anything (refine to rb)
  if (rb.size === 0) return;
  if (ra.size !== rb.size || ![...ra].every(op => rb.has(op)))
    throw new TypeError_(
      `effect mismatch: { ${[...ra].join(", ")} } ≠ { ${[...rb].join(", ")} }`);
}

function occurs(id: number, t: Type): boolean {
  switch (t.tag) {
    case "var": return uni.find(t.id) === id;
    case "arr": return occurs(id, t.elem);
    case "fun": return t.params.some(p => occurs(id, p)) || occurs(id, t.ret);
    default: return false;
  }
}
function bindVar(id: number, t: Type): void {
  const r = uni.find(id);
  if (occurs(r, t)) throw new TypeError_("recursive type");
  binds.set(r, t);
}
function res(t: Type): Type {
  if (t.tag !== "var") return t;
  const r = uni.find(t.id);
  const b = binds.get(r);
  return b ? res(b) : { tag: "var", id: r };
}

class TypeError_ extends Error {}

// Format a unification failure as a multi-line "Type mismatch" report. When
// `name` is supplied (e.g. the callee in a non-function call) the actual type
// is labelled with it, otherwise it is shown as `got`.
function typeMismatch(actual: Type, expected: Type, name?: string): TypeError_ {
  const a = showT(res(actual)), e = showT(res(expected));
  const lhs = name ? `${name} : ${a}` : `got      : ${a}`;
  return new TypeError_(`Type mismatch:\n${lhs}\nexpected : ${e}`);
}

function unify(a: Type, b: Type): void {
  const ra = res(a), rb = res(b);
  if (ra.tag === "any" || rb.tag === "any") return;
  if (ra.tag === "var" && rb.tag === "var") {
    uni.parent.set(uni.find(ra.id), uni.find(rb.id));
    return;
  }
  if (ra.tag === "var") { bindVar(ra.id, rb); return; }
  if (rb.tag === "var") { bindVar(rb.id, ra); return; }
  if (ra.tag === "prim" && rb.tag === "prim") {
    // int and float are compatible: numeric widening lets an int flow where a
    // float is expected and vice versa (value kept at runtime either way).
    const nums = new Set(["int", "float"]);
    if (ra.name !== rb.name && !(nums.has(ra.name) && nums.has(rb.name)))
      throw typeMismatch(ra, rb);
    return;
  }
  if (ra.tag === "arr" && rb.tag === "arr") { unify(ra.elem, rb.elem); return; }
  if (ra.tag === "fun" && rb.tag === "fun") {
    if (ra.params.length !== rb.params.length)
      throw new TypeError_(`arity ${ra.params.length} ≠ ${rb.params.length}`);
    for (let i = 0; i < ra.params.length; i++) unify(ra.params[i]!, rb.params[i]!);
    unify(ra.ret, rb.ret);
    unifyEff(ra.effs, rb.effs);
    return;
  }
  throw typeMismatch(ra, rb);
}

type Scheme = () => Type; // polymorphic type scheme, instantiated fresh per use

// Collect the free type- and effect-variable roots of a type into `tvs`/`evs`.
function collectVars(t: Type, tvs: Set<number>, evs: Set<number>): void {
  const r = res(t);
  if (r.tag === "var") tvs.add(uni.find(r.id));
  else if (r.tag === "arr") collectVars(r.elem, tvs, evs);
  else if (r.tag === "fun") {
    for (const p of r.params) collectVars(p, tvs, evs);
    collectVars(r.ret, tvs, evs);
    const er = resEff(r.effs);
    if (!(er instanceof Set)) evs.add(effFind(er.id));
  }
}

// Rebuild `t` substituting the given type/effect var roots with fresh copies.
function copyScheme(t: Type, tm: Map<number, Type>, em: Map<number, Effs>): Type {
  const r = res(t);
  switch (r.tag) {
    case "var": return tm.get(uni.find(r.id)) ?? r;
    case "arr": return tArr(copyScheme(r.elem, tm, em));
    case "fun":
      return tFun(
        r.params.map(p => copyScheme(p, tm, em)),
        copyScheme(r.ret, tm, em),
        copyEff(r.effs, em),
      );
    default: return r;
  }
}
function copyEff(e: Effs, em: Map<number, Effs>): Effs {
  const r = resEff(e);
  return r instanceof Set ? r : (em.get(effFind(r.id)) ?? r);
}

// HM let-generalization: abstract the type/effect vars of `t` that are not
// free in the environment. Returns a concrete `Type` (nothing to generalize)
// or a `Scheme` thunk that instantiates fresh copies per use. Builtins are
// already stored as such thunks; user `let` now gets the same treatment.
function generalize(env: TEnv, t: Type): Type | Scheme {
  const envTvs = new Set<number>();
  const envEvs = new Set<number>();
  for (let e: TEnv | null = env; e; e = e.parent)
    for (const v of e.vars.values())
      if (typeof v !== "function") collectVars(v, envTvs, envEvs);
  const tvs = new Set<number>();
  const evs = new Set<number>();
  collectVars(t, tvs, evs);
  const gtvs = [...tvs].filter(id => !envTvs.has(id));
  const gevs = [...evs].filter(id => !envEvs.has(id));
  if (gtvs.length === 0 && gevs.length === 0) return res(t);
  return () => {
    const tm = new Map<number, Type>();
    const em = new Map<number, Effs>();
    for (const id of gtvs) tm.set(id, freshVar());
    for (const id of gevs) em.set(id, freshEff());
    return copyScheme(t, tm, em);
  };
}

class TEnv {
  vars = new Map<string, Type | Scheme>();
  constructor(public parent: TEnv | null) {}
}
function tlookup(env: TEnv, name: string): Type | Scheme | undefined {
  let e: TEnv | null = env;
  while (e) {
    if (e.vars.has(name)) return e.vars.get(name);
    e = e.parent;
  }
  return undefined;
}
function textend(parent: TEnv): TEnv {
  return new TEnv(parent);
}

// Operators handled by special-casing in `infer` (numeric widening / same-type
// equality), not via the generic function-application path. `+` is NOT here —
// it is overloaded with string concatenation (see `plusType`).
const NUMOPS = new Set(["-", "*", "/", "%"]);
const CMPOPS = new Set(["<", ">", "<=", ">="]);
// Equality ops require both operands to share a type (numeric widening still
// lets `int ~ float`); cross-type comparisons like `"a" == 1` are rejected.
const EQOPS = new Set(["==", "!="]);
function isNum(t: Type): t is Prim {
  return t.tag === "prim" && (t.name === "int" || t.name === "float");
}
// Unify two operand types under a numeric op and return the widened result
// (float if either side is float, else int; `any` if either is `any`).
function numeric(a: Type, b: Type, op: string): Type {
  const ra = res(a), rb = res(b);
  if (ra.tag === "any" || rb.tag === "any") return TANY;
  if (isNum(ra) && isNum(rb))
    return ra.name === "float" || rb.name === "float" ? TFLOAT : TINT;
  if (isNum(ra) && rb.tag === "var") { unify(rb, ra); return ra; }
  if (isNum(rb) && ra.tag === "var") { unify(ra, rb); return rb; }
  if (ra.tag === "var" && rb.tag === "var") { unify(ra, rb); return res(ra); }
  if (ra.tag === "var") { unify(ra, TINT); return TINT; }
  if (rb.tag === "var") { unify(rb, TINT); return TINT; }
  throw new TypeError_(`${op}: ${showT(ra)} and ${showT(rb)} are not numeric`);
}

// `+` is overloaded: num+num (numeric widening) or string+string -> string.
// Mixed (`"a" + 1`) is a type error. `any` on either side stays `any`.
function plusType(a: Type, b: Type): Type {
  const ra = res(a), rb = res(b);
  if (ra.tag === "any" || rb.tag === "any") return TANY;
  const sa = isNum(ra), sb = isNum(rb);
  if (sa && sb)
    return ra.name === "float" || rb.name === "float" ? TFLOAT : TINT;
  const stra = ra.tag === "prim" && ra.name === "string";
  const strb = rb.tag === "prim" && rb.name === "string";
  if (stra && strb) return TSTR;
  if (sa && rb.tag === "var") { unify(rb, ra); return ra; }
  if (sb && ra.tag === "var") { unify(ra, rb); return rb; }
  if (stra && rb.tag === "var") { unify(rb, ra); return ra; }
  if (strb && ra.tag === "var") { unify(ra, rb); return rb; }
  if (ra.tag === "var" && rb.tag === "var") { unify(ra, rb); return res(ra); }
  throw new TypeError_(`+: ${showT(ra)} and ${showT(rb)} are not both numeric or both string`);
}

// `==` / `!=` are special-cased in `infer` (see EQOPS): they are NOT installed
// as ordinary `(any, any) -> bool` function bindings, so they can't be used as
// first-class values and can't silently compare unrelated types.

// infer: returns the type, side-effecting `effs` with performed effects.
function infer(e: Expr, env: TEnv, effs: Set<string>, effects: Map<string, EffectSig>): Type {
  switch (e.t) {
    case "num": return e.isFloat ? TFLOAT : TINT;
    case "str": return TSTR;
    case "bool": return TBOOL;
    case "unit": return TNULL;
    case "sym": {
      const s = tlookup(env, e.v);
      if (s === undefined) throw new TypeError_("Unbound: " + e.v);
      return typeof s === "function" ? s() : s;
    }
    case "lambda": {
      const n = textend(env);
      const ps: Type[] = [];
      for (const p of e.params) {
        const pt = p.typ ?? freshVar();
        n.vars.set(p.name, pt);
        ps.push(pt);
      }
      const innerEffs = new Set<string>();
      const ret = infer(e.body, n, innerEffs, effects);
      if (e.retTyp) unify(e.retTyp, ret);
      // Effect annotation is optional: if `! { ... }` is omitted, the
      // function's effect set is derived from the body's performed effects.
      // If present, it must be a superset of the body's effects.
      if (e.retEffs) {
        const decl = [...e.retEffs].join(", ") || "∅";
        for (const op of innerEffs)
          if (!e.retEffs.has(op))
            throw new TypeError_(`effect ${op} not declared in signature (declared: ${decl})`);
      }
      const ft = tFun(ps, e.retTyp ?? ret, e.retEffs ?? innerEffs);
      e.typ = ft;
      return ft;
    }
    case "let": {
      // Recursive binding: the name is in scope in its own value, so
      // `let f = fn(...){...}` can call itself.
      const declared = e.typ ?? freshVar();
      env.vars.set(e.name, declared);
      const vt = infer(e.val, env, effs, effects);
      unify(declared, vt);
      const rt = res(declared);
      // Exclude the self-binding from the free-var context before
      // generalizing (otherwise its own vars read as free-in-env → no-op).
      env.vars.delete(e.name);
      // Value restriction: generalize only lambda values (literals carry no
      // type vars; array literals desugar to `list(...)` calls = non-values).
      // This keeps mutable-array/assign soundness (no `let x = []` : [a]).
      env.vars.set(e.name, e.typ ? rt : (e.val.t === "lambda" ? generalize(env, rt) : rt));
      if (!e.typ && containsAny(rt)) warnInferredAny(e.name, rt);
      return TNULL;
    }
    case "if": {
      const c = infer(e.c, env, effs, effects);
      unify(c, TBOOL);
      const a = infer(e.a, env, effs, effects);
      const b = infer(e.b, env, effs, effects);
      unify(a, b);
      return res(a);
    }
    case "while": {
      const c = infer(e.c, env, effs, effects);
      unify(c, TBOOL);
      infer(e.body, env, effs, effects);
      return TNULL;
    }
    case "assign": {
      const cur = tlookup(env, e.name);
      if (cur === undefined) throw new TypeError_(`Assignment to unbound symbol: ${e.name}`);
      const vt = infer(e.val, env, effs, effects);
      // Unify against the declared type so `let guess: float` keeps its type.
      unify(typeof cur === "function" ? cur() : cur, vt);
      return TNULL;
    }
    case "block": {
      const n = textend(env);
      let last: Type = TNULL;
      for (const s of e.stmts) last = infer(s, n, effs, effects);
      return last;
    }
    case "perform": {
      const sig = effects.get(e.op);
      if (!sig) throw new TypeError_(`Unknown effect: ${e.op} (declare with: effect ${e.op}(...);)`);
      if (e.args.length !== sig.params.length)
        throw new TypeError_(`effect ${e.op}: ${sig.params.length} args, got ${e.args.length}`);
      const argTs = e.args.map(a => infer(a, env, effs, effects));
      for (let i = 0; i < sig.params.length; i++) unify(sig.params[i]!, argTs[i]!);
      effs.add(e.op);
      return sig.ret;
    }
    case "handle": {
      const bodyEffs = new Set<string>();
      const bodyT = infer(e.body, env, bodyEffs, effects);
      let resultT: Type | null = null;
      for (const c of e.cases) {
        const n = textend(env);
        const sig = effects.get(c.op);
        if (!sig && c.op !== "Return")
          throw new TypeError_(`Handler for unknown effect: ${c.op}`);
        if (c.op === "Return") {
          n.vars.set(c.params[0]!.name, res(bodyT));
        } else {
          for (let i = 0; i < c.params.length; i++) {
            n.vars.set(c.params[i]!.name, sig!.params[i] ?? TANY);
          }
        }
        // resume: (sig.ret) -> resultT ; Return's resume is identity over bodyT
        const resumeT = c.op === "Return"
          ? tFun([res(bodyT)], freshVar(), new Set())
          : tFun([sig!.ret], freshVar(), new Set());
        n.vars.set(c.resume, resumeT);
        const ct = infer(c.body, n, new Set<string>(), effects);
        if (resultT === null) resultT = ct;
        else unify(resultT, ct);
        unify(resumeT.ret, ct);
      }
      for (const c of e.cases) bodyEffs.delete(c.op);
      for (const op of bodyEffs) effs.add(op);
      return resultT ?? TNULL;
    }
    case "app": {
      // Array literals desugar to list(...); type as homogeneous [T].
      if (e.fn.t === "sym" && e.fn.v === "list") {
        const elem = freshVar();
        for (const a of e.args) unify(elem, infer(a, env, effs, effects));
        return tArr(res(elem));
      }
      // `+` is overloaded: numeric widening or string concatenation.
      if (e.fn.t === "sym" && e.fn.v === "+") {
        const at = infer(e.args[0]!, env, effs, effects);
        const bt = infer(e.args[1]!, env, effs, effects);
        return plusType(at, bt);
      }
      // Numeric operators (- * / %) and comparisons (< > <= >=) widen int/float;
      // unary neg is handled below. Kept out of BINOPS so they get this logic.
      if (e.fn.t === "sym" && (NUMOPS.has(e.fn.v) || CMPOPS.has(e.fn.v))) {
        const at = infer(e.args[0]!, env, effs, effects);
        const bt = infer(e.args[1]!, env, effs, effects);
        const widened = numeric(at, bt, e.fn.v);
        if (CMPOPS.has(e.fn.v)) return TBOOL;
        // `/` is type-preserving: int/int -> int (truncated at runtime),
        // float/float -> float, and any-operand -> float (don't truncate
        // unknowns). The checker stamps which division this is on the node so
        // the evaluator (which sees untyped JS numbers) knows whether to truncate.
        if (e.fn.v === "/") { e.div = widened === TINT ? "int" : "float"; return widened; }
        return widened;
      }
      if (e.fn.t === "sym" && e.fn.v === "neg") {
        const at = infer(e.args[0]!, env, effs, effects);
        return numeric(at, at, "neg");
      }
      // Equality: both operands must share a type (numeric widening lets
      // `int ~ float`). Cross-type (`"a" == 1`) is a type error.
      if (e.fn.t === "sym" && EQOPS.has(e.fn.v)) {
        const at = infer(e.args[0]!, env, effs, effects);
        const bt = infer(e.args[1]!, env, effs, effects);
        unify(at, bt);
        return TBOOL;
      }
      const ft = infer(e.fn, env, effs, effects);
      const argTs = e.args.map(a => infer(a, env, effs, effects));
      const ret = freshVar();
      const fr = res(ft);
      if (fr.tag === "fun") {
        if (fr.params.length !== argTs.length)
          throw new TypeError_(`arity ${fr.params.length} ≠ ${argTs.length}`);
        for (let i = 0; i < argTs.length; i++) unify(fr.params[i]!, argTs[i]!);
        unify(fr.ret, ret);
        // The callee's effect row is unified with each callback argument's
        // effect row via the param unification above (polymorphic builtins
        // share one effect variable between the callback and the result).
        // Whatever the callee's row resolves to now is what the call performs.
        const er = resEff(fr.effs);
        if (er instanceof Set) for (const op of er) effs.add(op);
        return res(ret);
      }
      if (fr.tag === "any") return TANY;
      const expected = tFun(argTs, ret, new Set());
      try { unify(ft, expected); }
      catch (err) {
        if (err instanceof TypeError_ && e.fn.t === "sym")
          throw typeMismatch(ft, expected, e.fn.v);
        throw err;
      }
      return res(ret);
    }
  }
}

function checkProgram(
  items: Item[],
  acc?: { env: TEnv; effects: Map<string, EffectSig> },
): { env: TEnv; effects: Map<string, EffectSig>; lastType: Type } {
  let env: TEnv;
  let effects: Map<string, EffectSig>;
  if (acc) {
    env = acc.env;
    effects = acc.effects;
  } else {
  effects = new Map<string, EffectSig>();
  // Builtin effects, interpreted by the runtime when left unhandled.
  // `Read(path): string` reads a file; `Write(path, content): null` writes one.
  // `Println(v: any): null` and `Out(s: string): null` are the console effects.
  // User `effect` decls below may add or override these.
  effects.set("Read", { params: [TSTR], ret: TSTR });
  effects.set("Write", { params: [TSTR, TSTR], ret: TNULL });
  effects.set("Println", { params: [TANY], ret: TNULL });
  effects.set("Out", { params: [TSTR], ret: TNULL });
  // `Exit(code: int): unit` terminates the process by default (never resumes);
  // `Wait(secs: int): unit` blocks for `secs` seconds then resumes with unit.
  // Both are effects so a handler can intercept them.
  effects.set("Exit", { params: [TINT], ret: TNULL });
  effects.set("Wait", { params: [TINT], ret: TNULL });
  // `Random(): float` resumes with a random number in [0, 1).
  effects.set("Random", { params: [], ret: TFLOAT });
  env = new TEnv(null);
  env.vars.set("not", tFun([TBOOL], TBOOL, new Set()));
  env.vars.set("list", tFun([TANY], tArr(TANY), new Set()));
  env.vars.set("head", () => { const a = freshVar(); return tFun([tArr(a)], a, new Set()); });
  env.vars.set("tail", () => { const a = freshVar(); return tFun([tArr(a)], tArr(a), new Set()); });
  env.vars.set("concat", () => { const a = freshVar(); return tFun([tArr(a), tArr(a)], tArr(a), new Set()); });
  env.vars.set("flat", () => { const a = freshVar(); return tFun([tArr(tArr(a))], tArr(a), new Set()); });
  env.vars.set("len", () => { const a = freshVar(); return tFun([tArr(a)], TINT, new Set()); });
  env.vars.set("strlen", tFun([TSTR], TINT, new Set()));
  env.vars.set("map", () => {
    const a = freshVar(), b = freshVar(), e = freshEff();
    return tFun([tFun([a], b, e), tArr(a)], tArr(b), e);
  });
  // --- builtins added for the star.ink port ---
  env.vars.set("PI", TFLOAT);
  env.vars.set("cos", tFun([TFLOAT], TFLOAT, new Set()));
  env.vars.set("sin", tFun([TFLOAT], TFLOAT, new Set()));
  env.vars.set("abs", tFun([TFLOAT], TFLOAT, new Set()));
  env.vars.set("round", tFun([TFLOAT], TINT, new Set()));
  env.vars.set("range", tFun([TINT, TINT, TINT], tArr(TINT), new Set()));
  env.vars.set("char", tFun([TINT], TSTR, new Set()));
  env.vars.set("number", tFun([TSTR], TFLOAT, new Set()));
  env.vars.set("args", tFun([], tArr(TSTR), new Set()));
  env.vars.set("get", () => { const a = freshVar(); return tFun([tArr(a), TINT], a, new Set()); });
  env.vars.set("set", () => { const a = freshVar(); return tFun([tArr(a), TINT, a], TNULL, new Set()); });
  env.vars.set("each", () => {
    const a = freshVar(), b = freshVar(), e = freshEff();
    return tFun([tFun([a, TINT], b, e), tArr(a)], TNULL, e);
  });
  env.vars.set("flatmap", () => {
    const a = freshVar(), b = freshVar(), e = freshEff();
    return tFun([tFun([a, TINT], tArr(b), e), tArr(a)], tArr(b), e);
  });
  }
  for (const it of items) if ("effect" in it) effects.set(it.effect, it.sig);
  let lastType: Type = TNULL;
  for (const it of items.filter(it => "e" in it))
    lastType = infer(it.e, env, new Set(), effects);
  return { env, effects, lastType };
}

// --- Evaluator (CPS) ---

function evalE(e: Expr, env: Env, k: Cont): Outcome {
  switch (e.t) {
    case "num":
    case "str":
    case "bool":
      return k(e.v);
    case "unit":
      return k(null);
    case "sym":
      return k(lookup(env, e.v));
    case "lambda":
      return k({ tag: "fn", params: e.params.map(p => p.name), body: e.body, env, typ: e.typ });
    case "let":
      env.vars.set(e.name, null);
      return evalE(e.val, env, (v) => {
        env.vars.set(e.name, v);
        return k(null);
      });
    case "if":
      return evalE(e.c, env, (c) =>
        evalE(c !== false && c !== null ? e.a : e.b, env, k),
      );
    case "while": {
      const loop = (): Outcome =>
        evalE(e.c, env, (c) =>
          c !== false && c !== null
            ? evalE(e.body, env, () => loop())
            : k(null),
        );
      return loop();
    }
    case "assign":
      return evalE(e.val, env, (v) => {
        assignVar(env, e.name, v);
        return k(null);
      });
    case "block": {
      const n = extend(env);
      return evalSeq(e.stmts, 0, n, k);
    }
    case "perform":
      return evalArgs(e.args, env, [], (args) => ({ tag: "eff", op: e.op, args, k }));
    case "handle":
      return handle(e.body, e.cases, env, k);
    case "app":
      // `/` is stamped by the checker with int vs float division (the runtime
      // can't tell, since JS erases 7 and 7.0 to the same value).
      if (e.fn.t === "sym" && e.fn.v === "/") {
        return evalArgs(e.args, env, [], (args) => {
          const a = args[0]!, b = args[1]!;
          const r = num(a) / num(b);
          return k(e.div === "int" ? Math.trunc(r) : r);
        });
      }
      return evalE(e.fn, env, (f) =>
        evalArgs(e.args, env, [], (args) => apply(f, args, k)),
      );
  }
}

function evalArgs(args: Expr[], env: Env, acc: Value[], k: (vals: Value[]) => Outcome): Outcome {
  if (acc.length === args.length) return k(acc);
  return evalE(args[acc.length]!, env, (v) => evalArgs(args, env, [...acc, v], k));
}
function evalSeq(stmts: Expr[], i: number, env: Env, k: Cont): Outcome {
  if (i >= stmts.length) return k(null);
  if (i === stmts.length - 1) return evalE(stmts[i]!, env, k);
  return evalE(stmts[i]!, env, () => evalSeq(stmts, i + 1, env, k));
}

function isNative(v: Value): v is Native {
  return v !== null && typeof v === "object" && !Array.isArray(v) && v.tag === "native";
}
function isClosure(v: Value): v is Closure {
  return v !== null && typeof v === "object" && !Array.isArray(v) && v.tag === "fn";
}
function apply(f: Value, args: Value[], k: Cont): Outcome {
  if (isNative(f)) return f.fn(args, k);
  if (isClosure(f)) {
    const n = extend(f.env);
    for (let i = 0; i < f.params.length; i++) n.vars.set(f.params[i]!, args[i] ?? null);
    return evalE(f.body, n, k);
  }
  throw new Error("Not callable: " + show(f));
}

function handle(body: Expr, cases: HandlerCase[], env: Env, k: Cont): Outcome {
  const handlers = new Map(cases.map((c) => [c.op, c]));
  const ret = handlers.get("Return");
  function run(out: Outcome, kOuter: Cont): Outcome {
    if (out.tag === "done") {
      if (ret) {
        const n = extend(env);
        n.vars.set(ret.params[0]!.name, out.value);
        n.vars.set(ret.resume, { tag: "native", fn: (_a, k2) => k2(out.value) });
        return evalE(ret.body, n, kOuter);
      }
      return kOuter(out.value);
    }
    const h = handlers.get(out.op);
    if (!h) {
      return { tag: "eff", op: out.op, args: out.args, k: (v) => run(out.k(v), kOuter) };
    }
    const resume: Native = {
      tag: "native",
      fn: (args, k2) => run(out.k(args[0] ?? null), k2),
    };
    const n = extend(env);
    n.vars.set(h.resume, resume);
    for (let i = 0; i < h.params.length; i++) n.vars.set(h.params[i]!.name, out.args[i] ?? null);
    return evalE(h.body, n, kOuter);
  }
  return run(evalE(body, env, (v) => ({ tag: "done", value: v })), k);
}

function runTop(out: Outcome): Value {
  for (;;) {
    if (out.tag === "done") return out.value;
    // Builtin effect interpretation: when Read/Write/Println/Out reach the
    // top unhandled, perform real I/O and resume the continuation.
    if (out.op === "Read") { out = out.k(readFileSync(out.args[0] as string, "utf8")); continue; }
    if (out.op === "Write") { writeFileSync(out.args[0] as string, out.args[1] as string); out = out.k(null); continue; }
    if (out.op === "Println") { console.log(show(out.args[0] ?? null)); out = out.k(null); continue; }
    if (out.op === "Out") { process.stdout.write(out.args[0] as string); out = out.k(null); continue; }
    // Exit terminates the process without resuming; Wait blocks then resumes
    // with unit. Both are ordinary effects a handler can intercept.
    if (out.op === "Exit") { process.exit(num(out.args[0]!)); }
    if (out.op === "Wait") {
      const end = Date.now() + num(out.args[0]!) * 1000;
      while (Date.now() < end) { /* busy-wait: synchronous CPS evaluator */ }
      out = out.k(null);
      continue;
    }
    if (out.op === "Random") { out = out.k(Math.random()); continue; }
    throw new Error("Unhandled effect: " + out.op);
  }
}

// --- Builtins ---

function lift(fn: (...a: Value[]) => Value): Native {
  return { tag: "native", fn: (args, k) => k(fn(...args)) };
}
const num = (v: Value): number => {
  if (typeof v !== "number") throw new Error("Expected number, got " + show(v));
  return v;
};

function globalEnv(): Env {
  const g = new Env(null);
  const bin = (s: string, f: (a: Value, b: Value) => Value) => g.vars.set(s, lift(f));
  bin("+", (a, b) =>
    typeof a === "string" || typeof b === "string" ? String(a) + String(b) : num(a) + num(b));
  bin("-", (a, b) => num(a) - num(b));
  bin("*", (a, b) => num(a) * num(b));
  bin("%", (a, b) => num(a) % num(b));
  bin("==", (a, b) => (a === b ? true : false));
  bin("!=", (a, b) => (a !== b ? true : false));
  bin("<", (a, b) => (num(a) < num(b) ? true : false));
  bin(">", (a, b) => (num(a) > num(b) ? true : false));
  bin("<=", (a, b) => (num(a) <= num(b) ? true : false));
  bin(">=", (a, b) => (num(a) >= num(b) ? true : false));
  g.vars.set("neg", lift((a) => -num(a)));
  g.vars.set("not", lift((a) => (a === false || a === null ? true : false)));
  g.vars.set("list", lift((...xs) => xs as Value[]));
  g.vars.set("head", lift((xs) => {
    const a = xs as Value[];
    if (a.length === 0) throw new Error("head of empty array");
    return a[0]!;
  }));
  g.vars.set("tail", lift((xs) => (xs as Value[]).slice(1)));
  g.vars.set("concat", lift((a, b) => (a as Value[]).concat(b as Value[])));
  g.vars.set("flat", lift((xs) => (xs as Value[]).flat() as Value[]));
  g.vars.set("len", lift((xs) => (xs as Value[]).length));
  g.vars.set("strlen", lift((s) => (s as string).length));
  g.vars.set("map", {
    tag: "native",
    fn: (args, k) => {
      const f = args[0]!;
      const xs = args[1] as Value[];
      const out: Value[] = new Array(xs.length);
      function go(i: number): Outcome {
        if (i >= xs.length) return k(out);
        return apply(f, [xs[i]!], (v) => { out[i] = v; return go(i + 1); });
      }
      return go(0);
    },
  });
  // --- builtins added for the star.ink port ---
  g.vars.set("PI", Math.PI);
  g.vars.set("cos", lift((a) => Math.cos(num(a))));
  g.vars.set("sin", lift((a) => Math.sin(num(a))));
  g.vars.set("abs", lift((a) => Math.abs(num(a))));
  g.vars.set("round", lift((a) => Math.round(num(a))));
  g.vars.set("char", lift((a) => String.fromCodePoint(num(a) | 0)));
  g.vars.set("number", lift((a) => parseFloat(a as string)));
  g.vars.set("args", lift(() => process.argv.slice(2) as Value[]));
  g.vars.set("range", lift((a, b, c) => {
    const s = num(a), e = num(b), st = num(c);
    const r: Value[] = [];
    if (st > 0) for (let i = s; i < e; i += st) r.push(i);
    else if (st < 0) for (let i = s; i > e; i += st) r.push(i);
    return r;
  }));
  g.vars.set("get", lift((xs, i) => {
    const a = xs as Value[];
    const idx = num(i);
    if (idx < 0 || idx >= a.length || !Number.isInteger(idx))
      throw new Error(`get: index ${idx} out of bounds [0, ${a.length})`);
    return a[idx]!;
  }));
  g.vars.set("set", lift((xs, i, v) => { (xs as Value[])[num(i)] = v; return null; }));
  g.vars.set("each", {
    tag: "native",
    fn: (args, k) => {
      const f = args[0]!, xs = args[1] as Value[];
      function go(i: number): Outcome {
        if (i >= xs.length) return k(null);
        return apply(f, [xs[i]!, i], () => go(i + 1));
      }
      return go(0);
    },
  });
  g.vars.set("flatmap", {
    tag: "native",
    fn: (args, k) => {
      const f = args[0]!, xs = args[1] as Value[];
      const acc: Value[] = [];
      function go(i: number): Outcome {
        if (i >= xs.length) return k(acc);
        return apply(f, [xs[i]!, i], (v) => { acc.push(...(v as Value[])); return go(i + 1); });
      }
      return go(0);
    },
  });
  return g;
}

export function show(v: Value): string {
  if (v === null) return "unit";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return '"' + v + '"';
  if (Array.isArray(v)) return "[" + v.map(show).join(", ") + "]";
  if (typeof v === "object" && !Array.isArray(v) && v.tag === "fn")
    return v.typ ? "[fn: " + showT(res(v.typ)) + "]" : "[fn]";
  return "[fn]";
}

// run: typecheck first, then evaluate. Throws on type error.
export function run(src: string): Value {
  const items = new Parser(src).parseProgram();
  checkProgram(items);
  let last: Value = null;
  const g = globalEnv();
  for (const it of items) {
    if ("e" in it) last = runTop(evalE(it.e, g, (v) => ({ tag: "done", value: v })));
  }
  return last;
}

// typeOf: return the inferred type of the last expression, as a string.
// Surfaces effect sets in function signatures, e.g. `(int) -> int ! { Emit }`.
export function typeOf(src: string): string {
  const items = new Parser(src).parseProgram();
  return showT(res(checkProgram(items).lastType));
}

// types: typecheck a source file and print every top-level symbol (let)
// along with its inferred type, one per line as `name : type`.
export function types(src: string): {name: string, type: Type}[] {
  const items = new Parser(src).parseProgram();
  const {env} = checkProgram(items);
  const names: string[] = items
    .filter((it): it is {e: Expr & {t: "let"}} => "e" in it && it.e.t === "let")
    .map(it => it.e.name);
  return names.map(n => {
    const t = tlookup(env, n);
    return {name: n, type: res(typeof t === "function" ? t() : t!)};
  });
}

// lint: run a sequence of lint passes over a parsed program and report issues.
// Each pass is an (items) => LintIssue[]; add more passes to LINT_PASSES.
export type LintIssue =
  {rule: "unused-arg"; who: string, argname: string, pos?: Pos};

const LINT_PASSES: ((items: Item[]) => LintIssue[])[] = [lintUnusedArgs];

export function lint(src: string): LintIssue[] {
  const items = new Parser(src).parseProgram();
  return LINT_PASSES.flatMap(pass => pass(items));
}

// unused-arg: a function parameter never referenced in the body (scope-aware:
// inner lambda params, let bindings, and handler-case params/resume
// shadow the outer name and don't count as a use).
function lintUnusedArgs(items: Item[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const it of items.filter(it => "e" in it))
    for (const [lam, fname] of visitLambdas(it.e, null)) {
      const seen = new Set<string>();
      for (const p of lam.params) {
        if (seen.has(p.name) || p.name === "_")
          continue;
        seen.add(p.name);
        const used = freeUses(lam.body, new Set([p.name]));
        if (used.size === 0) {
          const who = fname ? `function \`${fname}\`` : "anonymous function";
          issues.push({rule: "unused-arg", who, argname: p.name, pos: p.pos});
        }
      }
    }
  return issues;
}

// Visit every lambda in an expression. `fname` is the name of the enclosing
// binding when the lambda is the value of a `let`, else null.
function* visitLambdas(
  e: Expr,
  fname: string | null,
): Generator<[lam: Expr & {t: "lambda"}, fname: string | null]> {
  switch (e.t) {
  case "lambda":
    yield [e, fname];
    yield* visitLambdas(e.body, null);
    return;
  case "let":
    yield* visitLambdas(e.val, e.val.t === "lambda" ? e.name : null);
    return;
  case "assign":
    yield* visitLambdas(e.val, null);
    return;
  case "if":
    yield* visitLambdas(e.c, null);
    yield* visitLambdas(e.a, null);
    yield* visitLambdas(e.b, null);
    return;
  case "while":
    yield* visitLambdas(e.c, null);
    yield* visitLambdas(e.body, null);
    return;
  case "perform":
    for (const a of e.args)
      yield* visitLambdas(a, null);
    return;
  case "app":
    yield* visitLambdas(e.fn, null);
    for (const a of e.args)
      yield* visitLambdas(a, null);
    return;
  case "handle":
    yield* visitLambdas(e.body, null);
    for (const c of e.cases)
      yield* visitLambdas(c.body, null);
    return;
  case "block":
    for (const s of e.stmts)
      yield* visitLambdas(s, null);
    return;
  }
}

// Which of `watch` names are referenced (free) in `e`, accounting for shadowing
// by inner binders. `let` names bind only for following block siblings.
function freeUses(e: Expr, watch: Set<string>): Set<string> {
  const out = new Set<string>();
  const go = (e: Expr, w: Set<string>): void => {
    switch (e.t) {
    case "sym": if (w.has(e.v)) out.add(e.v); return;
    case "num": case "str": case "bool": case "unit": return;
    case "lambda": {
      const w2 = new Set(w);
      for (const p of e.params) w2.delete(p.name);
      go(e.body, w2);
      return;
    }
    case "let": { const w2 = new Set(w); w2.add(e.name); go(e.val, w2); return; }
    case "assign": go(e.val, w); return;
    case "if": go(e.c, w); go(e.a, w); go(e.b, w); return;
    case "while": go(e.c, w); go(e.body, w); return;
    case "perform": for (const a of e.args) go(a, w); return;
    case "app": go(e.fn, w); for (const a of e.args) go(a, w); return;
    case "handle":
      go(e.body, w);
      for (const c of e.cases) {
        const w2 = new Set(w);
        for (const p of c.params) w2.delete(p.name);
        w2.delete(c.resume);
        go(c.body, w2);
      }
      return;
    case "block": {
      const w2 = new Set(w);
      for (const s of e.stmts) {
        go(s, w2);
        if (s.t === "let") w2.delete(s.name);
      }
      return;
    }
    }
  };
  go(e, watch);
  return out;
}

// repl: an interactive read-eval-print loop. State (runtime env + type env +
// effect signatures) persists across lines, so `let`/`effect` bindings
// accumulate. Each line is parsed and evaluated as a complete program; ef is
// newline-insensitive so multi-statement blocks fit on one line. Echoes the
// value and inferred type of a bare expression; declarations print nothing.
export function repl(): void {
  const g = globalEnv();
  const acc = checkProgram([]); // seeded with builtins; extended incrementally
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "ef> " });
  const evalLine = (src: string): void => {
    const items = new Parser(src).parseProgram();
    const { lastType } = checkProgram(items, acc);
    let last: Value = null;
    for (const it of items) if ("e" in it) last = runTop(evalE(it.e, g, (v) => ({ tag: "done", value: v })));
    const tail = items[items.length - 1];
    const isExpr = tail && "e" in tail && (tail as { e: Expr }).e.t !== "let";
    if (isExpr && last !== null) console.log(show(last) + " : " + showT(res(lastType)));
  };
  console.log("ef REPL — type :q to quit");
  rl.prompt();
  rl.on("line", (line) => {
    const s = line.trimEnd();
    if (s === ":q" || s === ":quit") { rl.close(); return; }
    if (s === "") { rl.prompt(); return; }
    const src = /[;{}]$/.test(s) ? s : s + ";";
    try { evalLine(src); }
    catch (e) { console.log(String((e as Error).message ?? e)); }
    rl.prompt();
  });
  rl.on("close", () => { process.stdout.write("\n"); process.exit(0); });
}