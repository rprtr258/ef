import {
  type FunT, type Type, type EffectSig, type Alias, type Var, type TupField,
  TINT, TFLOAT, TSTR, TBOOL, TNULL, TANY,
  tArr, tTup, tFun, freshVar, instantiateAlias,
} from "./types.ts";
import {KEYWORDS, lex, type Pos, type Tok} from "./lexer.ts";

export type Param = { name: string, typ: Type | null, pos?: Pos };

export type HandlerCase = {
  op: string,
  params: Param[],
  resume: string,
  body: Expr,
};

export type Item =
  | { e: Expr }
  | { effect: string, sig: EffectSig }
  | { alias: Alias };

// --- AST ---
export type Expr =
  | { t: "num", v: number, isFloat: boolean, pos?: Pos }
  | { t: "str", v: string, pos?: Pos }
  | { t: "bool", v: boolean, pos?: Pos }
  | { t: "unit", pos?: Pos }
  | { t: "sym", v: string, pos?: Pos }
  | { t: "lambda", params: Param[], retTyp: Type | null, retEffs: Set<string> | null, body: Expr, typ?: FunT, pos?: Pos }
  | { t: "let", name: string, typ: Type | null, val: Expr, pos?: Pos }
  | { t: "if", c: Expr, a: Expr, b: Expr, pos?: Pos }
  | { t: "while", c: Expr, body: Expr, pos?: Pos }
  | { t: "assign", name: string, val: Expr, pos?: Pos }
  | { t: "block", stmts: Expr[], pos?: Pos }
  | { t: "perform", op: string, args: Expr[], pos?: Pos }
  | { t: "handle", body: Expr, cases: HandlerCase[], pos?: Pos }
  | { t: "app", fn: Expr, args: Expr[], div?: "int" | "float", pos?: Pos }
  | { t: "arr", elems: Expr[], pos?: Pos } // `[a, b, c]` literal: array if homogeneous, tuple if heterogeneous.
  | { t: "field", obj: Expr, name: string, idx?: number, pos?: Pos } // `obj.x` / `obj.0` field access; `idx` is resolved by the checker.
  | { t: "dlet", fields: { name: string, typ: Type | null }[], val: Expr, pos?: Pos }; // `let [a, b] = val;` tuple/array destructuring bind.

// Unescape a string literal token (with surrounding quotes).
function parseStr(t: string): string {
  const s = t.slice(1, -1);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== "\\") { out += c; i++; continue; }
    const n = s[i + 1];
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

// Parser (recursive descent + Pratt for infix)
export class Parser {
  toks: Tok[];
  i = 0;
  // Parametric type aliases, registered top-down as `type` items are parsed.
  // `typeParamStack` lets an alias body reference its own type params as type
  // variables (e.g. `type Pair(a, b) = [a, b]`).
  aliases = new Map<string, Alias>();
  typeParamStack: Map<string, Var>[] = [];
  constructor(src: string) {
    this.toks = lex(src);
  }
  peek(o = 0): string | undefined {
    return this.toks[this.i + o]?.v;
  }
  next(): string {
    return this.toks[this.i++].v;
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
      else if (this.isKw("type")) out.push(this.parseAlias());
      else out.push({e: this.parseStmt()});
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
    return {effect: name, sig: {params: params.map(p => p.typ ?? freshVar()), ret}};
  }

  // `type Name(p1, p2) = <body>;` — params are type variables scoped to body.
  // Nullary aliases `type V = ...;` (no param list) are also allowed.
  parseAlias(): Item {
    this.next(); // type
    const name = this.next();
    const tparams = new Map<string, Var>();
    if (this.is("(")) {
      this.next();
      while (!this.is(")")) {
        const p = this.next();
        tparams.set(p, freshVar());
        if (this.is(",")) this.i++;
      }
      this.eat(")");
    }
    this.eat("=");
    this.typeParamStack.push(tparams);
    const body = this.parseType();
    this.typeParamStack.pop();
    this.eat(";");
    const alias = {name, tparams, body};
    this.aliases.set(name, alias);
    return {alias};
  }

  parseStmt(): Expr {
    const p = this.pos();
    let e: Expr;
    if (this.isKw("let")) {
      this.next();
      if (this.is("[")) {
        // destructuring let: `let [a: T, b] = val;`
        this.next();
        const fields: { name: string, typ: Type | null }[] = [];
        while (!this.is("]")) {
          const name = this.next();
          const typ = this.is(":") ? (this.next(), this.parseType()) : null;
          fields.push({name, typ});
          if (this.is(",")) this.i++;
        }
        this.eat("]");
        this.eat("=");
        const val = this.parseExpr();
        this.eat(";");
        e = {t: "dlet", fields, val, pos: p};
      } else {
        const name = this.next();
        const typ = this.is(":") ? (this.next(), this.parseType()) : null;
        this.eat("=");
        const val = this.parseExpr();
        this.eat(";");
        e = {t: "let", name, typ, val, pos: p};
      }
    } else if (!KEYWORDS.has(this.peek() ?? "") && this.peek(1) === "=") {
      const name = this.next();
      this.next(); // =
      const val = this.parseExpr();
      if (this.is(";"))
        this.i++;
      e = {t: "assign", name, val, pos: p};
    } else {
      e = this.parseExpr();
      if (this.is(";"))
        this.i++;
      else if (!isBlocky(e) && !this.is("}") && !this.atEnd())
        this.eat(";");
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
      params.push({name, typ, pos});
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
    const p = this.pos();
    this.eat("{");
    const stmts: Expr[] = [];
    while (!this.is("}")) stmts.push(this.parseStmt());
    this.eat("}");
    return {t: "block", stmts, pos: p};
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
  // Parse a single tuple field: `name: T` (named) or `T` (unnamed).
  parseTupField(): TupField {
    if (this.peek() !== undefined && /[A-Za-z_]/.test(this.peek()![0]) && this.peek(1) === ":") {
      const name = this.next();
      this.next(); // :
      return {name, type: this.parseType()};
    }
    return {name: null, type: this.parseType()};
  }

  parseType(): Type {
    if (this.is("[")) {
      this.next();
      const first = this.parseTupField();
      if (this.is(",")) {
        // tuple: `[T1, T2, ...]` (named or unnamed)
        const fields = [first];
        while (this.is(",")) {
          this.i++;
          if (this.is("]")) break; // trailing comma tolerance
          fields.push(this.parseTupField());
        }
        this.eat("]");
        return tTup(fields);
      }
      this.eat("]");
      if (first.name !== null)
        throw new Error("array type cannot have a named element");
      return tArr(first.type);
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
    // type parameter of an enclosing alias body → a type variable.
    for (const m of this.typeParamStack) if (m.has(name)) return m.get(name)!;
    // alias instantiation: `Name[T1, T2]` (or nullary `Name`).
    const al = this.aliases.get(name);
    if (al !== undefined) {
      const args: Type[] = [];
      if (this.is("[")) {
        this.next();
        while (!this.is("]")) {
          args.push(this.parseType());
          if (this.is(",")) this.i++;
        }
        this.eat("]");
      }
      return instantiateAlias(al, args);
    }
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
  static PREC: Record<string, number> = {"||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6};
  binOps = new Set(Object.keys(Parser.PREC));

  parseExpr(): Expr {
    return this.parseBinary(0);
  }

  parseBinary(min: number): Expr {
    let left = this.parseUnary();
    while (true) {
      const op = this.peek();
      if (op === undefined || !this.binOps.has(op))
        break;
      const prec = Parser.PREC[op];
      if (prec < min)
        break;
      this.next();
      const right = this.parseBinary(prec + 1);
      if (op === "&&")
        left = {t: "if", c: left, a: right, b: {t: "bool", v: false}, pos: left.pos};
      else if (op === "||")
        left = {t: "if", c: left, a: {t: "bool", v: true}, b: right, pos: left.pos};
      else
        left = {t: "app", fn: {t: "sym", v: op}, args: [left, right], pos: left.pos};
    }
    return left;
  }

  parseUnary(): Expr {
    const p = this.pos();
    if (this.is("-")) {
      this.next();
      return {t: "app", fn: {t: "sym", v: "neg"}, args: [this.parseUnary()], pos: p};
    }
    if (this.is("!")) {
      this.next();
      return {t: "app", fn: {t: "sym", v: "not"}, args: [this.parseUnary()], pos: p};
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
      e = {t: "perform", op, args, pos: e.pos};
    }
    while (this.is("(")) {
      const args = this.parseArgs();
      e = {t: "app", fn: e, args, pos: e.pos};
    }
    // field access: `obj.x` (named) or `obj.0` (positional). The lexer
    // reads `0.0` as a single float token, so a chained `m.0.0` arrives as
    // one field name; split it into successive accesses.
    while (this.is(".")) {
      this.next();
      const name = this.next();
      for (const part of name.split(".")) e = {t: "field", obj: e, name: part, pos: e.pos};
    }
    return e;
  }

  parsePrimary(): Expr {
    const t = this.peek();
    if (t === undefined) throw new Error("Unexpected EOF");
    const p = this.pos();
    if (/^-?\d/.test(t)) {
      this.next();
      return {t: "num", v: Number(t), isFloat: t.includes("."), pos: p};
    }
    if (t.startsWith("\"")) {
      this.next();
      return {t: "str", v: parseStr(t), pos: p};
    }
    if (t === "true") {
      this.next();
      return {t: "bool", v: true, pos: p};
    }
    if (t === "false") {
      this.next();
      return {t: "bool", v: false, pos: p};
    }
    if (t === "unit") {
      this.next();
      return {t: "unit", pos: p};
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
      return {t: "arr", elems: els, pos: p};
    }
    if (this.isKw("fn")) {
      this.next();
      const params = this.parseParams();
      const retTyp = this.is(":") ? (this.next(), this.parseType()) : null;
      const retEffs = this.parseEffAnnot();
      const body = this.parseBlock();
      return {t: "lambda", params, retTyp, retEffs, body, pos: p};
    }
    if (this.isKw("if")) {
      this.next();
      this.eat("(");
      const c = this.parseExpr();
      this.eat(")");
      const a = this.parseBlock();
      let b: Expr = {t: "unit", pos: p};
      if (this.isKw("else")) {
        this.next();
        b = this.isKw("if") ? this.parsePrimary() : this.parseBlock();
      } else if (this.is(";")) {
        this.i++;
      }
      return {t: "if", c, a, b, pos: p};
    }
    if (this.isKw("while")) {
      this.next();
      this.eat("(");
      const c = this.parseExpr();
      this.eat(")");
      const body = this.parseBlock();
      return {t: "while", c, body, pos: p};
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
        cases.push({op, params, resume, body: cbody});
      }
      return {t: "handle", body, cases, pos: p};
    }
    this.next();
    return {t: "sym", v: t, pos: p};
  }
}

function isBlocky(e: Expr): boolean {
  return ["block", "if", "while", "handle", "lambda"].includes(e.t);
}
