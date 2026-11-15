import {
  type FunT, type NumName, type TupField, type Type, type Var,
} from "./unify.ts";
import {
  TI32, TI64, TU32, TU64, TF32, TF64, TSTR, TBOOL, TUNIT, TANY, TTYPE,
  rowOf, tArr, tTup, tFun,
} from "../prims.ts";
import type {EffectSig} from "./types.ts";
import {KEYWORDS, lex, ParseError, type Loc, type LocRange, type Tok} from "./lexer.ts";
import {assertNever} from "../assert.ts";
import {OP_NEG, OP_NOT} from "../ops.ts";

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

export type Param = { name: string, typ: Type | null, pos?: Loc };

type HandlerCase = {
  op: string,
  params: Param[],
  resume: string,
  resumePos: Loc, // the resume binder token's start — not an Expr node; the LSP hovers it with the checker's resume type
  body: ExprID,
};

export type Item =
  | { e: ExprID }
  | { effect: string, sig: EffectSig, pos?: Loc } // pos: the effect name token — go-to-definition's target for effect-name occurrences
  | { alias: Alias, pos?: Loc }; // pos: the alias name token — go-to-definition's target for alias-name occurrences

// --- AST ---
// Flat node slice: expressions reference their children by `ExprID` (an index
// into `Program.nodes`), not by embedding child nodes.
export type ExprID = number;
export type Program = { nodes: Expr[], locs: (LocRange | undefined)[], items: Item[], typeToks: TypeTok[] };

// TypeTok: a type/effect name occurrence recorded while parsing — consumed by
// the LSP's semantic-tokens provider (type/effect highlighting) and, for the
// `macro` kind (effect decls, `! { … }` rows, performs, case labels), by the
// effect-signature hover. Both backends ignore it. `len` is the token's
// source length; pos is 1-based.
export type TypeTok = {pos: Loc, len: number, kind: "type" | "typeParameter" | "macro" | "function" | "variable", name: string};
// Node source extents live in Program.locs (parallel to nodes), not
// here; a node's own `pos`-like fields (dlet field names, Param) are binder
// name tokens, a different concern.
export type Expr =
  | { t: "num", v: number, isFloat: boolean, raw?: string, numKind?: string }
  | { t: "str", v: string }
  | { t: "bool", v: boolean }
  | { t: "unit" }
  | { t: "sym", v: string }
  | { t: "lambda", params: Param[], retTyp: Type | null, retEffs: Set<string> | null, body: ExprID, typ?: FunT,
      // Checker-stamped (width-ambiguity rule): unannotated params' type-var
      // ids, and the union-find roots of those vars that numeric ops touched
      // during body inference.
      unannParams?: {name: string, id: number}[], numTouched?: Set<number>, }
  | { t: "let", name: string, typ: Type | null, val: ExprID, mut: boolean } // `name := e;` / `name :: e;` / `name: T = e;` / `name: T :: e;`
  | { t: "dlet", fields: { name: string, typ: Type | null, pos?: Loc }[], val: ExprID, mut: boolean, shape?: "tup" | "arr" } // `[a, b] := val;` / `[a, b] :: val;` destructuring bind; field pos: the field name token (go-to-definition target). The checker stamps `shape` (tuple fields vs array window) for the evaluators.
  | { t: "assign", name: string, val: ExprID }
  | { t: "if", c: ExprID, a: ExprID, b: ExprID }
  | { t: "while", c: ExprID, body: ExprID }
  | { t: "block", stmts: ExprID[], semi: boolean }
  | { t: "perform", op: string, args: ExprID[] }
  | { t: "handle", body: ExprID, cases: HandlerCase[] }
  | { t: "app", fn: ExprID, args: ExprID[], div?: NumName, numKind?: string,
      // Checker-stamped (stampSuspension): false — dcall — when the callee's
      // resolved FunT proves the call cannot suspend; true/absent otherwise.
      sus?: boolean,
    }
  | { t: "as", e: ExprID, typ: Type, asKind?: "trunc" | "boolnum" } // `@as(expr, T)` numeric cast; asKind stamped by the checker.
  | { t: "arr", elems: ExprID[], arrKind?: "arr" | "tup" } // `[a, b, c]` literal: array if homogeneous, tuple if heterogeneous. The checker stamps `arrKind` so the evaluator picks the runtime shape.
  | { t: "field", obj: ExprID, name: string, idx?: number, shape?: "tup" | "arr" } // `obj.x` / `obj.0` field access; `idx` is resolved by the checker, `shape` stamped by it too.
;

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
  // Type/effect name occurrences, pushed in source order while parsing.
  typeToks: TypeTok[] = [];
  // Whether the most recent parseStmt expression statement consumed a
  // trailing `;` — parseBlock reads it to decide if the block's last
  // expression is its value (no `;`) or discarded (unit).
  stmtSemi = false;
  constructor(src: string) {
    this.toks = lex(src);
  }
  // Record the token just consumed (name = its text: the extent and the
  // effect-sig hover lookup).
  recordTypeTok(kind: TypeTok["kind"], name: string): void {
    this.typeToks.push({pos: this.toks[this.i - 1].pos, len: name.length, kind, name});
  }
  peek(o = 0): string | undefined {
    return this.toks[this.i + o]?.v;
  }
  next(): string {
    return this.toks[this.i++].v;
  }
  // Position of the token at offset `o` from the cursor (undefined past EOF).
  pos(o = 0): Loc | undefined {
    return this.toks[this.i + o]?.pos;
  }
  eat(s: string): void {
    if (this.peek() !== s) this.fail(`Expected "${s}", got "${this.peek()}"`);
    this.i++;
  }
  // Every comma-separated list (args, params, fn types, effect rows, bracket
  // literals/patterns) shares one rule: the comma is required between
  // elements, and a `,` directly before the close delimiter is the optional
  // trailing comma. At the close delimiter itself this is a no-op, leaving
  // the caller's `while (!this.is(close))` loop to exit.
  listSep(close: string): void {
    if (this.is(",")) this.i++;
    else if (!this.is(close)) this.fail(`Expected "," or "${close}", got "${this.peek()}"`);
  }
  // Throw a ParseError anchored at the token `o` offsets from the cursor
  // (negative = an already-consumed token). Past EOF the error is zero-width
  // at the last token's end — where input ran out.
  fail(msg: string, o = 0): never {
    const t = this.toks.at(this.i + o);
    if (t !== undefined) throw new ParseError(msg, t.pos, t.end);
    const end = this.toks.at(-1)?.end ?? {line: 1, col: 1};
    throw new ParseError(msg, end, end);
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
  // Node source extents, parallel to `nodes`: each expression's start and
  // exclusive end token — undefined only on synthesized nodes (the operator
  // `sym`s and bools desugared from `&&`/`||`/`!`). Backends ignore it.
  locs: (LocRange | undefined)[] = [];
  add(e: Expr, pos?: Loc): ExprID {
    this.nodes.push(e);
    // Every add site consumes the node's final token before adding (parents
    // are added after their children; statement binders add before eating
    // the trailing `;`), so the last consumed token's end is the node's end.
    this.locs.push(pos === undefined ? undefined : {start: pos, end: this.toks[this.i - 1].end});
    return this.nodes.length - 1;
  }

  parseProgram(): Program {
    const items: Item[] = [];
    while (!this.atEnd()) {
      if (this.isKw("effect")) items.push(this.parseEffect());
      else {
        const al = this.tryParseAliasItem();
        items.push(al ?? {e: this.parseStmt()});
      }
    }
    return {nodes: this.nodes, locs: this.locs, items, typeToks: this.typeToks};
  }
  parseEffect(): Item {
    this.next(); // effect
    const p = this.pos();
    const name = this.next();
    this.recordTypeTok("macro", name);
    const params = this.parseParams();
    this.eat(":");
    const ret = this.parseType();
    this.eat(";");
    return {effect: name, sig: {params: params.map(p => p.typ), ret, names: params.map(p => p.name)}, pos: p};
  }

  // Top-level type aliases, keyword-free (`type` is now the type-of-types
  // primitive used in their parameter annotations):
  //   `Name :: <type>;`                               — nullary alias
  //   `Name :: fn(p: type, ...): type { <type> };`    — parametric alias
  // Disambiguation from `name :: expr;` is type-first: the RHS must parse as
  // a type landing on `;` (unknown names throw out of parseType, so
  // `pair :: [a, b];` over value variables and bare `y :: x;` rewind and keep
  // the binding reading). parseType allocates no Expr nodes, so the rewind
  // leaves no orphans. The fn form claims the whole shape — every param and
  // the return `: type` — which no useful term lambda can match, since
  // nothing inhabits `type` at term level.
  tryParseAliasItem(): Item | null {
    const name = this.peek();
    if (name === undefined || KEYWORDS.has(name)) return null;
    const save = this.i;
    const toksLen = this.typeToks.length;
    const p = this.pos();
    this.next(); // name
    this.recordTypeTok("type", name);
    if (!this.is("::")) {
      this.i = save;
      this.typeToks.length = toksLen;
      return null;
    }
    this.next(); // ::
    let pushed = false;
    try {
      if (this.isKw("fn")) {
        this.next(); // fn
        this.eat("(");
        const tparams = new Map<string, Var>();
        while (!this.is(")")) {
          const p = this.next();
          if (KEYWORDS.has(p)) throw Error("not a type fn");
          this.recordTypeTok("typeParameter", p);
          this.eat(":");
          if (!this.isKw("type")) throw Error("not a type fn");
          this.next(); // type
          tparams.set(p, parserVar());
          this.listSep(")");
        }
        this.eat(")");
        this.eat(":");
        if (!this.isKw("type")) throw Error("not a type fn");
        this.next(); // type
        this.eat("{");
        this.typeParamStack.push(tparams);
        pushed = true;
        const body = this.parseType();
        this.typeParamStack.pop();
        pushed = false;
        this.eat("}");
        this.eat(";");
        const alias = {name, tparams, body};
        this.aliases.set(name, alias);
        return {alias, pos: p};
      }
      // Nullary: the RHS is any type shape — bracket/paren/fn-type forms,
      // plus bare names (`s32 :: i32`) and alias applications (`t :: V2[i64]`)
      // — resolved by the same parseType fallback that throws on unknown
      // names.
      const body = this.parseType();
      this.eat(";");
      const alias = {name, tparams: new Map<string, Var>(), body};
      this.aliases.set(name, alias);
      return {alias, pos: p};
    } catch {
      if (pushed) this.typeParamStack.pop();
      this.i = save;
      this.typeToks.length = toksLen;
      return null;
    }
  }

  parseStmt(): ExprID {
    const p = this.pos();
    this.stmtSemi = false;
    let e: ExprID;
    const nonKw = this.peek() !== undefined && !KEYWORDS.has(this.peek()!);
    if (nonKw && this.peek(1) === ":=") {
      // `name := val;` — mutable, inferred type.
      const name = this.next();
      this.next(); // :=
      const val = this.parseExpr();
      e = this.add({t: "let", name, typ: null, val, mut: true}, p);
      this.eat(";");
    } else if (nonKw && this.peek(1) === "::") {
      // `name :: val;` — const, inferred type.
      const name = this.next();
      this.next(); // ::
      const val = this.parseExpr();
      e = this.add({t: "let", name, typ: null, val, mut: false}, p);
      this.eat(";");
    } else if (nonKw && this.peek(1) === ":") {
      // `name: T = val;` — mutable, annotated; `name: T :: val;` — const, annotated.
      const name = this.next();
      this.next(); // :
      const typ = this.parseType();
      const isConst = this.is("::");
      if (isConst) this.next();
      else this.eat("=");
      const val = this.parseExpr();
      e = this.add({t: "let", name, typ, val, mut: !isConst}, p);
      this.eat(";");
    } else if (this.is("[")) {
      // Destructuring bind (`[a: T, b] := val;` / `[a: T, b] :: val;`) or an
      // array literal as an expression statement (`[x, y]` as a block tail).
      // The bracketed prefix is ambiguous, so try destructuring and backtrack
      // to an expression unless a bind operator follows `]`.
      const save = this.i;
      try {
        this.next();
        const fields: { name: string, typ: Type | null, pos?: Loc }[] = [];
        while (!this.is("]")) {
          const pos = this.pos();
          const name = this.next();
          const typ = this.is(":") ? (this.next(), this.parseType()) : null;
          fields.push({name, typ, pos});
          this.listSep("]");
        }
        this.eat("]");
        const isConst = this.is("::");
        if (isConst) this.next();
        else this.eat(":=");
        const val = this.parseExpr();
        e = this.add({t: "dlet", fields, val, mut: !isConst}, p);
        this.eat(";");
      } catch {
        this.i = save;
        e = this.parseExpr();
        this.stmtSemi = this.is(";");
        if (this.stmtSemi)
          this.i++;
        else if (!isBlocky(this.nodes[e]) && !this.is("}") && !this.atEnd())
          this.eat(";");
      }
    } else if (nonKw && this.peek(1) === "=") {
      const name = this.next();
      this.next(); // =
      const val = this.parseExpr();
      e = this.add({t: "assign", name, val}, p);
      if (this.is(";"))
        this.i++;
    } else {
      e = this.parseExpr();
      this.stmtSemi = this.is(";");
      if (this.stmtSemi)
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
      this.listSep(")");
    }
    this.eat(")");
    return params;
  }

  parseArgs(): ExprID[] {
    this.eat("(");
    const args: ExprID[] = [];
    while (!this.is(")")) {
      args.push(this.parseExpr());
      this.listSep(")");
    }
    this.eat(")");
    return args;
  }

  parseBlock(): ExprID {
    const p = this.pos();
    this.eat("{");
    const stmts: ExprID[] = [];
    let semi = false;
    while (!this.is("}")) {
      stmts.push(this.parseStmt());
      semi = this.stmtSemi;
    }
    this.eat("}");
    return this.add({t: "block", stmts, semi}, p);
  }

  // optional `! { op, op, ... }` effect annotation on a fn return type
  parseEffAnnot(): Set<string> | null {
    if (!this.is("!")) return null;
    this.next();
    this.eat("{");
    const effs = new Set<string>();
    while (!this.is("}")) {
      const eff = this.next();
      this.recordTypeTok("macro", eff);
      effs.add(eff);
      this.listSep("}");
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
        this.fail("array type cannot have a named element", -1); // the `]`
      return tArr(first.type);
    }
    if (this.is("(")) {
      this.next();
      const ps: Type[] = [];
      while (!this.is(")")) {
        ps.push(this.parseType());
        this.listSep(")");
      }
      this.eat(")");
      this.eat("-");
      this.eat(">");
      const ret = this.parseType();
      return tFun(ps, ret, rowOf(this.parseEffAnnot() ?? undefined));
    }
    const name = this.next();
    // type parameter of an enclosing alias body → a type variable.
    for (const m of this.typeParamStack)
      if (m.has(name)) {
        this.recordTypeTok("typeParameter", name);
        return m.get(name)!;
      }
    // Every other name consumed in type position — prims (incl. `unit`,
    // `any`, the `type`-of-types keyword), alias uses, and names that turn
    // out unknown (thrown below; the LSP discards tokens when a program
    // fails to check).
    this.recordTypeTok("type", name);
    // alias instantiation: `Name(T1, T2)` (or nullary `Name`). In a type
    // position `Name(...)` has no other reading, so the call-like form is
    // unambiguous.
    const al = this.aliases.get(name);
    if (al !== undefined) {
      const args: Type[] = [];
      if (this.is("(")) {
        this.next();
        while (!this.is(")")) {
          args.push(this.parseType());
          this.listSep(")");
        }
        this.eat(")");
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
      case "unit": return TUNIT;
      case "any": return TANY;
      case "type": return TTYPE;
      default: this.fail("Unknown type: " + name, -1); // the name token
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
        left = this.add({t: "if", c: left, a: right, b: this.add({t: "bool", v: false})}, this.locs[left]?.start);
      else if (op === "||")
        left = this.add({t: "if", c: left, a: this.add({t: "bool", v: true}), b: right}, this.locs[left]?.start);
      else
        left = this.add({t: "app", fn: this.add({t: "sym", v: op}), args: [left, right]}, this.locs[left]?.start);
    }
    return left;
  }

  parseUnary(): ExprID {
    const p = this.pos();
    if (this.is("-")) {
      this.next();
      return this.add({t: "app", fn: this.add({t: "sym", v: OP_NEG}), args: [this.parseUnary()]}, p);
    }
    if (this.is("!")) {
      this.next();
      return this.add({t: "app", fn: this.add({t: "sym", v: OP_NOT}), args: [this.parseUnary()]}, p);
    }
    return this.parsePostfix();
  }

  parsePostfix(): ExprID {
    let e = this.parsePrimary();
    // perform: `Op!(args)` (postfix `!` after an effect name).
    const prim = this.nodes[e];
    if (prim.t === "sym" && this.is("!") && this.peek(1) === "(") {
      const op = prim.v;
      this.recordTypeTok("macro", op);
      this.next(); // !
      const args = this.parseArgs();
      e = this.add({t: "perform", op, args}, this.locs[e]?.start);
    }
    while (this.is("(")) {
      const args = this.parseArgs();
      e = this.add({t: "app", fn: e, args}, this.locs[e]?.start);
    }
    // field access: `obj.x` (named) or `obj.0` (positional). The lexer
    // reads `0.0` as a single float token, so a chained `m.0.0` arrives as
    // one field name; split it into successive accesses.
    while (this.is(".")) {
      this.next();
      const name = this.next();
      for (const part of name.split(".")) e = this.add({t: "field", obj: e, name: part}, this.locs[e]?.start);
    }
    return e;
  }

  parsePrimary(): ExprID {
    const t = this.peek();
    if (t === undefined) this.fail("Unexpected EOF");
    const p = this.pos();
    if (t === "@") {
      // `@as(expr, T)` — the one explicit numeric cast.
      this.next();
      const name = this.next();
      if (name !== "as") this.fail(`Unknown @-form: @${name}`, -1); // the form name
      this.eat("(");
      const e = this.parseExpr();
      this.eat(",");
      const typ = this.parseType();
      this.eat(")");
      return this.add({t: "as", e, typ}, p);
    }
    if (/^-?\d/.test(t)) {
      this.next();
      return this.add({t: "num", v: Number(t), isFloat: t.includes("."), raw: t.includes(".") ? undefined : t}, p);
    }
    if (t.startsWith("\"")) {
      this.next();
      return this.add({t: "str", v: parseStr(t)}, p);
    }
    if (t === "true") {
      this.next();
      return this.add({t: "bool", v: true}, p);
    }
    if (t === "false") {
      this.next();
      return this.add({t: "bool", v: false}, p);
    }
    if (t === "unit") {
      this.next();
      return this.add({t: "unit"}, p);
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
        this.listSep("]");
      }
      this.eat("]");
      return this.add({t: "arr", elems: els}, p);
    }
    if (this.isKw("fn")) {
      this.next();
      const params = this.parseParams();
      const retTyp = this.is(":") ? (this.next(), this.parseType()) : null;
      const retEffs = this.parseEffAnnot();
      const body = this.parseBlock();
      return this.add({t: "lambda", params, retTyp, retEffs, body}, p);
    }
    if (this.isKw("if")) {
      this.next();
      this.eat("(");
      const c = this.parseExpr();
      this.eat(")");
      const a = this.parseBlock();
      let b: ExprID = this.add({t: "unit"}, p);
      if (this.isKw("else")) {
        this.next();
        b = this.isKw("if") ? this.parsePrimary() : this.parseBlock();
      } else if (this.is(";")) {
        this.i++;
      }
      return this.add({t: "if", c, a, b}, p);
    }
    if (this.isKw("while")) {
      this.next();
      this.eat("(");
      const c = this.parseExpr();
      this.eat(")");
      const body = this.parseBlock();
      return this.add({t: "while", c, body}, p);
    }
    if (this.isKw("handle")) {
      this.next();
      const body = this.parseBlock();
      const cases: HandlerCase[] = [];
      while (this.isKw("case")) {
        this.next();
        const op = this.next();
        this.recordTypeTok("macro", op);
        const params = this.parseParams();
        this.eat("=>");
        const resume = this.next();
        const resumePos = this.toks[this.i - 1].pos;
        const cbody = this.parseBlock();
        cases.push({op, params, resume, resumePos, body: cbody});
      }
      return this.add({t: "handle", body, cases}, p);
    }
    // Fallthrough is ident-shaped tokens only (mirrors the lexer's ident
    // rule): every other token kind has a branch above. A stray punctuation
    // token must fail here as a parse error — as a `sym` node it surfaced
    // later as a baffling type error ("literal arity 6 ≠ tuple 2" for
    // `[x: 1, y: 2]`).
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) this.fail(`Unexpected token "${t}"`);
    this.next();
    return this.add({t: "sym", v: t}, p);
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
