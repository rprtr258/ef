// A tiny interpreted language with algebraic effects, C/Go-flavoured syntax.
// Two passes: a static type checker (bidirectional + union-find unification,
// with monomorphic effect tracking), then a CPS evaluator whose continuation
// is a plain JS function — giving true multi-shot `resume`.

import {readFileSync, writeFileSync} from "node:fs";

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
type FunT = { tag: "fun"; params: Type[]; ret: Type; effs: Set<string> };
type Var = { tag: "var"; id: number };
type AnyT = { tag: "any" };

const TINT: Prim = { tag: "prim", name: "int" };
const TFLOAT: Prim = { tag: "prim", name: "float" };
const TSTR: Prim = { tag: "prim", name: "string" };
const TBOOL: Prim = { tag: "prim", name: "bool" };
const TNULL: Prim = { tag: "prim", name: "unit" };
const TANY: AnyT = { tag: "any" };

function tArr(elem: Type): ArrT { return { tag: "arr", elem }; }
function tFun(params: Type[], ret: Type, effs: Set<string>): FunT {
  return { tag: "fun", params, ret, effs };
}

function showT(t: Type): string {
  switch (t.tag) {
    case "prim": return t.name;
    case "arr": return "[" + showT(t.elem) + "]";
    case "any": return "any";
    case "var": return "t" + t.id;
    case "fun": {
      const ps = t.params.map(showT).join(", ");
      const e = t.effs.size ? " ! { " + [...t.effs].join(", ") + " }" : "";
      return "(" + ps + ") -> " + showT(t.ret) + e;
    }
  }
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
  | { t: "lambda"; params: Param[]; retTyp: Type | null; retEffs: Set<string> | null; body: Expr }
  | { t: "let"; name: string; typ: Type | null; val: Expr }
  | { t: "letrec"; name: string; typ: Type | null; val: Expr }
  | { t: "if"; c: Expr; a: Expr; b: Expr }
  | { t: "while"; c: Expr; body: Expr }
  | { t: "assign"; name: string; val: Expr }
  | { t: "block"; stmts: Expr[] }
  | { t: "perform"; op: string; args: Expr[] }
  | { t: "handle"; body: Expr; cases: HandlerCase[] }
  | { t: "app"; fn: Expr; args: Expr[] };

type Param = { name: string; typ: Type | null };

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
  "let", "letrec", "fn", "if", "else", "while", "perform", "handle", "case",
  "true", "false", "unit", "effect",
]);
const TWO = ["==", "!=", "<=", ">=", "&&", "||", "=>"];
const ONE = "()[]{},;<>+-*/!=:%";

function lex(src: string): string[] {
  const toks: string[] = [];
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
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      toks.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO.includes(two)) {
      toks.push(two);
      i += 2;
      continue;
    }
    if (ONE.includes(c)) {
      toks.push(c);
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      toks.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push(src.slice(i, j));
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
  toks: string[];
  i = 0;
  constructor(src: string) {
    this.toks = lex(src);
  }
  peek(o = 0): string | undefined {
    return this.toks[this.i + o];
  }
  next(): string {
    return this.toks[this.i++]!;
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
    } else if (this.isKw("letrec")) {
      this.next();
      const name = this.next();
      const typ = this.is(":") ? (this.next(), this.parseType()) : null;
      this.eat("=");
      const val = this.parseExpr();
      this.eat(";");
      e = { t: "letrec", name, typ, val };
    } else if (this.isKw("fn") && this.peek(1) !== "(") {
      // named declaration: `fn name(params): T { body }` (recursive)
      this.next();
      const name = this.next();
      const params = this.parseParams();
      const ret = this.is(":") ? (this.next(), this.parseType()) : null;
      const retEffs = this.parseEffAnnot();
      const body = this.parseBlock();
      e = { t: "letrec", name, typ: null, val: { t: "lambda", params, retTyp: ret, retEffs, body } };
      if (this.is(";")) this.i++;
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
      const name = this.next();
      const typ = this.is(":") ? (this.next(), this.parseType()) : null;
      params.push({ name, typ });
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
    if (this.isKw("perform")) {
      this.next();
      const op = this.next();
      const args = this.parseArgs();
      return { t: "perform", op, args };
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
      throw new TypeError_(`${showT(ra)} ≠ ${showT(rb)}`);
    return;
  }
  if (ra.tag === "arr" && rb.tag === "arr") { unify(ra.elem, rb.elem); return; }
  if (ra.tag === "fun" && rb.tag === "fun") {
    if (ra.params.length !== rb.params.length)
      throw new TypeError_(`arity ${ra.params.length} ≠ ${rb.params.length}`);
    for (let i = 0; i < ra.params.length; i++) unify(ra.params[i]!, rb.params[i]!);
    unify(ra.ret, rb.ret);
    return;
  }
  throw new TypeError_(`${showT(ra)} ≠ ${showT(rb)}`);
}

type Scheme = () => Type; // polymorphic type scheme, instantiated fresh per use

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

// Operators handled by special-casing in `infer` (numeric widening), not BINOPS.
const NUMOPS = new Set(["+", "-", "*", "/", "%"]);
const CMPOPS = new Set(["<", ">", "<=", ">="]);
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

const BINOPS: Record<string, [Type, Type, Type]> = {
  "==": [TANY, TANY, TBOOL], "!=": [TANY, TANY, TBOOL],
};

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
      // Effect annotations are mandatory: a body with any effect must declare
      // a superset of it. Omitting `! { ... }` is only allowed for pure bodies.
      if (innerEffs.size > 0 && !e.retEffs)
        throw new TypeError_(`effect ${[...innerEffs].join(", ")} not declared in signature (annotation required)`);
      if (e.retEffs) {
        const decl = [...e.retEffs].join(", ") || "∅";
        for (const op of innerEffs)
          if (!e.retEffs.has(op))
            throw new TypeError_(`effect ${op} not declared in signature (declared: ${decl})`);
      }
      return tFun(ps, e.retTyp ?? ret, e.retEffs ?? innerEffs);
    }
    case "let": {
      const vt = infer(e.val, env, effs, effects);
      if (e.typ) { unify(e.typ, vt); env.vars.set(e.name, e.typ); }
      else env.vars.set(e.name, vt);
      return TNULL;
    }
    case "letrec": {
      const declared = e.typ ?? freshVar();
      env.vars.set(e.name, declared);
      const vt = infer(e.val, env, effs, effects);
      unify(declared, vt);
      env.vars.set(e.name, res(declared));
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
      // Numeric operators (+ - * /) and comparisons (< > <= >=) widen int/float;
      // unary neg is handled below. Kept out of BINOPS so they get this logic.
      if (e.fn.t === "sym" && (NUMOPS.has(e.fn.v) || CMPOPS.has(e.fn.v))) {
        const at = infer(e.args[0]!, env, effs, effects);
        const bt = infer(e.args[1]!, env, effs, effects);
        const widened = numeric(at, bt, e.fn.v);
        return CMPOPS.has(e.fn.v) ? TBOOL : widened;
      }
      if (e.fn.t === "sym" && e.fn.v === "neg") {
        const at = infer(e.args[0]!, env, effs, effects);
        return numeric(at, at, "neg");
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
        for (const op of fr.effs) effs.add(op);
        return res(ret);
      }
      if (fr.tag === "any") return TANY;
      unify(ft, tFun(argTs, ret, new Set()));
      return res(ret);
    }
  }
}

function checkProgram(items: Item[]): { effects: Map<string, EffectSig>; lastType: Type } {
  const effects = new Map<string, EffectSig>();
  // Builtin effects, interpreted by the runtime when left unhandled.
  // `Read(path): string` reads a file; `Write(path, content): null` writes one.
  // `Println(v: any): null` and `Out(s: string): null` are the console effects.
  // User `effect` decls below may add or override these.
  effects.set("Read", { params: [TSTR], ret: TSTR });
  effects.set("Write", { params: [TSTR, TSTR], ret: TNULL });
  effects.set("Println", { params: [TANY], ret: TNULL });
  effects.set("Out", { params: [TSTR], ret: TNULL });
  for (const it of items) if ("effect" in it) effects.set(it.effect, it.sig);
  const env = new TEnv(null);
  for (const [op, [a, b, r]] of Object.entries(BINOPS)) {
    env.vars.set(op, tFun([a, b], r, new Set()));
  }
  env.vars.set("not", tFun([TBOOL], TBOOL, new Set()));
  env.vars.set("list", tFun([TANY], tArr(TANY), new Set()));
  env.vars.set("head", () => { const a = freshVar(); return tFun([tArr(a)], a, new Set()); });
  env.vars.set("tail", () => { const a = freshVar(); return tFun([tArr(a)], tArr(a), new Set()); });
  env.vars.set("concat", () => { const a = freshVar(); return tFun([tArr(a), tArr(a)], tArr(a), new Set()); });
  env.vars.set("flat", () => { const a = freshVar(); return tFun([tArr(tArr(a))], tArr(a), new Set()); });
  env.vars.set("len", () => { const a = freshVar(); return tFun([tArr(a)], TINT, new Set()); });
  env.vars.set("map", () => {
    const a = freshVar(), b = freshVar();
    return tFun([tFun([a], b, new Set()), tArr(a)], tArr(b), new Set());
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
  env.vars.set("exit", tFun([TINT], TNULL, new Set()));
  env.vars.set("wait", tFun([TINT], TNULL, new Set()));
  env.vars.set("get", () => { const a = freshVar(); return tFun([tArr(a), TINT], a, new Set()); });
  env.vars.set("set", () => { const a = freshVar(); return tFun([tArr(a), TINT, a], TNULL, new Set()); });
  env.vars.set("each", () => {
    const a = freshVar(), b = freshVar();
    return tFun([tFun([a, TINT], b, new Set()), tArr(a)], TNULL, new Set());
  });
  env.vars.set("flatmap", () => {
    const a = freshVar(), b = freshVar();
    return tFun([tFun([a, TINT], tArr(b), new Set()), tArr(a)], tArr(b), new Set());
  });
  let lastType: Type = TNULL;
  for (const it of items.filter(it => "e" in it))
    lastType = infer(it.e, env, new Set(), effects);
  return { effects, lastType };
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
      return k({ tag: "fn", params: e.params.map(p => p.name), body: e.body, env });
    case "let":
      return evalE(e.val, env, (v) => {
        env.vars.set(e.name, v);
        return k(null);
      });
    case "letrec":
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
  bin("+", (a, b) => num(a) + num(b));
  bin("-", (a, b) => num(a) - num(b));
  bin("*", (a, b) => num(a) * num(b));
  bin("/", (a, b) => num(a) / num(b));
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
  g.vars.set("head", lift((xs) => (xs as Value[])[0] ?? null));
  g.vars.set("tail", lift((xs) => (xs as Value[]).slice(1)));
  g.vars.set("concat", lift((a, b) => (a as Value[]).concat(b as Value[])));
  g.vars.set("flat", lift((xs) => (xs as Value[]).flat() as Value[]));
  g.vars.set("len", lift((xs) => (xs as Value[]).length));
  g.vars.set("map", {
    tag: "native",
    fn: (args, k) => {
      const f = args[0]!;
      const xs = args[1] as Value[];
      function go(i: number, acc: Value[]): Outcome {
        if (i >= xs.length) return k(acc);
        return apply(f, [xs[i]!], (v) => go(i + 1, [...acc, v]));
      }
      return go(0, []);
    },
  });
  // --- builtins added for the star.ink port ---
  g.vars.set("PI", Math.PI);
  g.vars.set("cos", lift((a) => Math.cos(num(a))));
  g.vars.set("sin", lift((a) => Math.sin(num(a))));
  g.vars.set("abs", lift((a) => Math.abs(num(a))));
  g.vars.set("round", lift((a) => Math.round(num(a))));
  g.vars.set("char", lift((a) => String.fromCharCode(num(a) | 0)));
  g.vars.set("number", lift((a) => parseFloat(a as string)));
  g.vars.set("args", lift(() => process.argv.slice(2) as Value[]));
  g.vars.set("range", lift((a, b, c) => {
    const s = num(a), e = num(b), st = num(c);
    const r: Value[] = [];
    if (st > 0) for (let i = s; i < e; i += st) r.push(i);
    else if (st < 0) for (let i = s; i > e; i += st) r.push(i);
    return r;
  }));
  g.vars.set("get", lift((xs, i) => (xs as Value[])[num(i)] ?? null));
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
  g.vars.set("exit", { tag: "native", fn: (args) => { process.exit(num(args[0]!)); } });
  g.vars.set("wait", lift((a) => {
    const end = Date.now() + num(a) * 1000;
    while (Date.now() < end) { /* busy-wait: synchronous CPS evaluator */ }
    return null;
  }));
  return g;
}

export function show(v: Value): string {
  if (v === null) return "unit";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return '"' + v + '"';
  if (Array.isArray(v)) return "[" + v.map(show).join(", ") + "]";
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
