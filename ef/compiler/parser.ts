import {
  type FunT, type Type, type EffectSig, type Var, type TupField, type NumName,
  TI32, TI64, TU32, TU64, TF32, TF64, TSTR, TBOOL, TNULL, TANY,
  tArr, tTup, tFun,
} from "./types.ts";
import {KEYWORDS, lex, type Pos, type Tok} from "./lexer.ts";
import {assertNever} from "./assert.ts";

// Type variables allocated by the parser: alias type parameters, and
// arguments omitted from a parametric alias use. They live in a negative id
// space so they never collide with a checker `Unifier`'s ids; the unifier
// treats unknown ids as their own root, so parser variables that reach
// checking (only possible via omitted alias args) behave as ordinary
// unbound variables.
let parserVarN = 0;
function parserVar(): Var {
  return {tag: "var", id: --parserVarN};
}

// A top-level program item: a parametric type alias
// (`type Pair(a, b) = [a, b];`). Type parameters are parser-allocated
// variables scoped to the body.
export type Alias = { name: string, tparams: Map<string, Var>, body: Type };

// Instantiate a parametric type alias by substituting its type-parameter
// variables with the given argument types (fresh parser variables for any
// missing/trailing args). Pure substitution — no unifier involved.
// ponytail: no recursion guard — recursive aliases (`type T = [T]`) stack-loop;
// add a depth cap if recursive aliases become needed.
function instantiateAlias(al: Alias, args: Type[]): Type {
  const tm = new Map<number, Type>();
  let i = 0;
  for (const [, v] of al.tparams) tm.set(v.id, args[i++] ?? parserVar());
  return subst(al.body, tm);
}

function subst(t: Type, tm: Map<number, Type>): Type {
  if (t.tag === "var") { const s = tm.get(t.id); return s ?? t; }
  if (t.tag === "arr") return tArr(subst(t.elem, tm));
  if (t.tag === "tup") return tTup(t.fields.map(f => ({name: f.name, type: subst(f.type, tm)})));
  if (t.tag === "fun") return tFun(t.params.map(p => subst(p, tm)), subst(t.ret, tm), t.effs);
  return t;
}

export type Param = { name: string, typ: Type | null, pos?: Pos };

export type HandlerCase = {
  op: string,
  params: Param[],
  resume: string,
  body: ExprID,
};

export type Item =
  | { e: ExprID }
  | { effect: string, sig: EffectSig }
  | { alias: Alias };

// --- AST ---
// Flat node slice: expressions reference their children by `ExprID` (an index
// into `Program.nodes`), not by embedding child nodes.
export type ExprID = number;
export type Program = { nodes: Expr[], items: Item[] };
export type Expr =
  | { t: "num", v: number, isFloat: boolean, raw?: string, numKind?: string, pos?: Pos }
  | { t: "str", v: string, pos?: Pos }
  | { t: "bool", v: boolean, pos?: Pos }
  | { t: "unit", pos?: Pos }
  | { t: "sym", v: string, pos?: Pos }
  | { t: "lambda", params: Param[], retTyp: Type | null, retEffs: Set<string> | null, body: ExprID, typ?: FunT, pos?: Pos,
      // Checker-stamped (width-ambiguity rule): unannotated params' type-var
      // ids, and the union-find roots of those vars that numeric ops touched
      // during body inference.
      unannParams?: {name: string, id: number}[], numTouched?: Set<number>, }
  | { t: "let", name: string, typ: Type | null, val: ExprID, mut: boolean, pos?: Pos } // `name := e;` / `name :: e;` / `name: T = e;` / `name: T :: e;`
  | { t: "if", c: ExprID, a: ExprID, b: ExprID, pos?: Pos }
  | { t: "while", c: ExprID, body: ExprID, pos?: Pos }
  | { t: "assign", name: string, val: ExprID, pos?: Pos }
  | { t: "block", stmts: ExprID[], pos?: Pos }
  | { t: "perform", op: string, args: ExprID[], pos?: Pos }
  | { t: "handle", body: ExprID, cases: HandlerCase[], pos?: Pos }
  | { t: "app", fn: ExprID, args: ExprID[], div?: NumName, numKind?: string, pos?: Pos }
  | { t: "as", e: ExprID, typ: Type, asKind?: "trunc" | "boolnum", pos?: Pos } // `@as(expr, T)` numeric cast; asKind stamped by the checker.
  | { t: "arr", elems: ExprID[], pos?: Pos } // `[a, b, c]` literal: array if homogeneous, tuple if heterogeneous.
  | { t: "field", obj: ExprID, name: string, idx?: number, pos?: Pos } // `obj.x` / `obj.0` field access; `idx` is resolved by the checker.
  | { t: "dlet", fields: { name: string, typ: Type | null }[], val: ExprID, mut: boolean, pos?: Pos }; // `[a, b] := val;` / `[a, b] :: val;` destructuring bind.

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

const PREC: Record<string, number> = {"||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6};
const binOps = new Set(Object.keys(PREC));

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

  // Flat node arena: every parsed expression is pushed here once and referred
  // to by `ExprID` (its index) from parents, items, and closures.
  nodes: Expr[] = [];
  add(e: Expr): ExprID {
    this.nodes.push(e);
    return this.nodes.length - 1;
  }

  parseProgram(): Program {
    const items: Item[] = [];
    while (!this.atEnd()) {
      if (this.isKw("effect")) items.push(this.parseEffect());
      else if (this.isKw("type")) items.push(this.parseAlias());
      else items.push({e: this.parseStmt()});
    }
    return {nodes: this.nodes, items};
  }
  parseEffect(): Item {
    this.next(); // effect
    const name = this.next();
    const params = this.parseParams();
    this.eat(":");
    const ret = this.parseType();
    this.eat(";");
    return {effect: name, sig: {params: params.map(p => p.typ), ret}};
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
        tparams.set(p, parserVar());
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

  parseStmt(): ExprID {
    const p = this.pos();
    let e: ExprID;
    const nonKw = this.peek() !== undefined && !KEYWORDS.has(this.peek()!);
    if (nonKw && this.peek(1) === ":=") {
      // `name := val;` — mutable, inferred type.
      const name = this.next();
      this.next(); // :=
      const val = this.parseExpr();
      this.eat(";");
      e = this.add({t: "let", name, typ: null, val, mut: true, pos: p});
    } else if (nonKw && this.peek(1) === "::") {
      // `name :: val;` — const, inferred type.
      const name = this.next();
      this.next(); // ::
      const val = this.parseExpr();
      this.eat(";");
      e = this.add({t: "let", name, typ: null, val, mut: false, pos: p});
    } else if (nonKw && this.peek(1) === ":") {
      // `name: T = val;` — mutable, annotated; `name: T :: val;` — const, annotated.
      const name = this.next();
      this.next(); // :
      const typ = this.parseType();
      const isConst = this.is("::");
      if (isConst) this.next();
      else this.eat("=");
      const val = this.parseExpr();
      this.eat(";");
      e = this.add({t: "let", name, typ, val, mut: !isConst, pos: p});
    } else if (this.is("[")) {
      // Destructuring bind (`[a: T, b] := val;` / `[a: T, b] :: val;`) or an
      // array literal as an expression statement (`[x, y]` as a block tail).
      // The bracketed prefix is ambiguous, so try destructuring and backtrack
      // to an expression unless a bind operator follows `]`.
      const save = this.i;
      try {
        this.next();
        const fields: { name: string, typ: Type | null }[] = [];
        while (!this.is("]")) {
          const name = this.next();
          const typ = this.is(":") ? (this.next(), this.parseType()) : null;
          fields.push({name, typ});
          if (this.is(",")) this.i++;
        }
        this.eat("]");
        const isConst = this.is("::");
        if (isConst) this.next();
        else this.eat(":=");
        const val = this.parseExpr();
        this.eat(";");
        e = this.add({t: "dlet", fields, val, mut: !isConst, pos: p});
      } catch {
        this.i = save;
        e = this.parseExpr();
        if (this.is(";"))
          this.i++;
        else if (!isBlocky(this.nodes[e]) && !this.is("}") && !this.atEnd())
          this.eat(";");
      }
    } else if (nonKw && this.peek(1) === "=") {
      const name = this.next();
      this.next(); // =
      const val = this.parseExpr();
      if (this.is(";"))
        this.i++;
      e = this.add({t: "assign", name, val, pos: p});
    } else {
      e = this.parseExpr();
      if (this.is(";"))
        this.i++;
      else if (!isBlocky(this.nodes[e]) && !this.is("}") && !this.atEnd())
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

  parseArgs(): ExprID[] {
    this.eat("(");
    const args: ExprID[] = [];
    while (!this.is(")")) {
      args.push(this.parseExpr());
      if (this.is(",")) this.i++;
    }
    this.eat(")");
    return args;
  }

  parseBlock(): ExprID {
    const p = this.pos();
    this.eat("{");
    const stmts: ExprID[] = [];
    while (!this.is("}")) stmts.push(this.parseStmt());
    this.eat("}");
    return this.add({t: "block", stmts, pos: p});
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
      return tFun(ps, ret, this.parseEffAnnot() ?? new Set());
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
      case "i32": return TI32;
      case "i64": return TI64;
      case "u32": return TU32;
      case "u64": return TU64;
      case "f32": return TF32;
      case "f64": return TF64;
      case "string": return TSTR;
      case "bool": return TBOOL;
      case "unit": return TNULL;
      case "any": return TANY;
      default: throw new Error("Unknown type: " + name);
    }
  }

  // --- Pratt ---
  parseExpr(): ExprID {
    return this.parseBinary(0);
  }

  parseBinary(min: number): ExprID {
    let left = this.parseUnary();
    while (true) {
      const op = this.peek();
      if (op === undefined || !binOps.has(op))
        break;
      const prec = PREC[op];
      if (prec < min)
        break;
      this.next();
      const right = this.parseBinary(prec + 1);
      if (op === "&&")
        left = this.add({t: "if", c: left, a: right, b: this.add({t: "bool", v: false}), pos: this.nodes[left].pos});
      else if (op === "||")
        left = this.add({t: "if", c: left, a: this.add({t: "bool", v: true}), b: right, pos: this.nodes[left].pos});
      else
        left = this.add({t: "app", fn: this.add({t: "sym", v: op}), args: [left, right], pos: this.nodes[left].pos});
    }
    return left;
  }

  parseUnary(): ExprID {
    const p = this.pos();
    if (this.is("-")) {
      this.next();
      return this.add({t: "app", fn: this.add({t: "sym", v: "neg"}), args: [this.parseUnary()], pos: p});
    }
    if (this.is("!")) {
      this.next();
      return this.add({t: "app", fn: this.add({t: "sym", v: "not"}), args: [this.parseUnary()], pos: p});
    }
    return this.parsePostfix();
  }

  parsePostfix(): ExprID {
    let e = this.parsePrimary();
    // perform: `Op!(args)` (postfix `!` after an effect name).
    const prim = this.nodes[e];
    if (prim.t === "sym" && this.is("!") && this.peek(1) === "(") {
      const op = prim.v;
      this.next(); // !
      const args = this.parseArgs();
      e = this.add({t: "perform", op, args, pos: prim.pos});
    }
    while (this.is("(")) {
      const args = this.parseArgs();
      e = this.add({t: "app", fn: e, args, pos: this.nodes[e].pos});
    }
    // field access: `obj.x` (named) or `obj.0` (positional). The lexer
    // reads `0.0` as a single float token, so a chained `m.0.0` arrives as
    // one field name; split it into successive accesses.
    while (this.is(".")) {
      this.next();
      const name = this.next();
      for (const part of name.split(".")) e = this.add({t: "field", obj: e, name: part, pos: this.nodes[e].pos});
    }
    return e;
  }

  parsePrimary(): ExprID {
    const t = this.peek();
    if (t === undefined) throw new Error("Unexpected EOF");
    const p = this.pos();
    if (t === "@") {
      // `@as(expr, T)` — the one explicit numeric cast.
      this.next();
      const name = this.next();
      if (name !== "as") throw new Error(`Unknown @-form: @${name}`);
      this.eat("(");
      const e = this.parseExpr();
      this.eat(",");
      const typ = this.parseType();
      this.eat(")");
      return this.add({t: "as", e, typ, pos: p});
    }
    if (/^-?\d/.test(t)) {
      this.next();
      return this.add({t: "num", v: Number(t), isFloat: t.includes("."), raw: t.includes(".") ? undefined : t, pos: p});
    }
    if (t.startsWith("\"")) {
      this.next();
      return this.add({t: "str", v: parseStr(t), pos: p});
    }
    if (t === "true") {
      this.next();
      return this.add({t: "bool", v: true, pos: p});
    }
    if (t === "false") {
      this.next();
      return this.add({t: "bool", v: false, pos: p});
    }
    if (t === "unit") {
      this.next();
      return this.add({t: "unit", pos: p});
    }
    if (t === "(") {
      this.next();
      const e = this.parseExpr();
      this.eat(")");
      return e;
    }
    if (t === "[") {
      this.next();
      const els: ExprID[] = [];
      while (!this.is("]")) {
        els.push(this.parseExpr());
        if (this.is(",")) this.i++;
      }
      this.eat("]");
      return this.add({t: "arr", elems: els, pos: p});
    }
    if (this.isKw("fn")) {
      this.next();
      const params = this.parseParams();
      const retTyp = this.is(":") ? (this.next(), this.parseType()) : null;
      const retEffs = this.parseEffAnnot();
      const body = this.parseBlock();
      return this.add({t: "lambda", params, retTyp, retEffs, body, pos: p});
    }
    if (this.isKw("if")) {
      this.next();
      this.eat("(");
      const c = this.parseExpr();
      this.eat(")");
      const a = this.parseBlock();
      let b: ExprID = this.add({t: "unit", pos: p});
      if (this.isKw("else")) {
        this.next();
        b = this.isKw("if") ? this.parsePrimary() : this.parseBlock();
      } else if (this.is(";")) {
        this.i++;
      }
      return this.add({t: "if", c, a, b, pos: p});
    }
    if (this.isKw("while")) {
      this.next();
      this.eat("(");
      const c = this.parseExpr();
      this.eat(")");
      const body = this.parseBlock();
      return this.add({t: "while", c, body, pos: p});
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
      return this.add({t: "handle", body, cases, pos: p});
    }
    this.next();
    return this.add({t: "sym", v: t, pos: p});
  }
}

function isBlocky(e: Expr): boolean {
  return ["block", "if", "while", "handle", "lambda"].includes(e.t);
}

// Child ExprIDs of a node, in source order — the one AST shape every walker
// agrees on: a node is visited before its children, a handler's case bodies
// after its body. Walkers recurse through this instead of re-listing every
// variant; the assertNever here is the choke point a new Expr variant must
// pass (walkers with per-variant logic keep their own exhaustive switches).
export function exprChildren(e: Expr): ExprID[] {
  switch (e.t) {
    case "lambda": return [e.body];
    case "let": case "assign": case "dlet": return [e.val];
    case "block": return e.stmts;
    case "if": return [e.c, e.a, e.b];
    case "while": return [e.c, e.body];
    case "app": return [e.fn, ...e.args];
    case "arr": return e.elems;
    case "field": return [e.obj];
    case "as": return [e.e];
    case "handle": return [e.body, ...e.cases.map(cse => cse.body)];
    case "perform": return e.args;
    case "num": case "str": case "bool": case "unit": case "sym": return [];
    default:
      return assertNever(e);
  }
}
