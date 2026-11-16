import {
  type TupField, type Type, type Var,
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

type Param = { name: string, typ: Type | null, pos?: Loc };

type HandlerCase = {
  op: string,
  params: Param[],
  resume: string,
  resumePos: Loc, // the resume binder token's start — not an Expr node; the LSP hovers it with the checker's resume type
  body: ExprID,
};

type Item =
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
  | { t: "num", v: number, isFloat: boolean, raw?: string }
  | { t: "str", v: string }
  | { t: "bool", v: boolean }
  | { t: "unit" }
  | { t: "sym", v: string }
  | { t: "lambda", params: Param[], retTyp: Type | null, retEffs: Set<string> | null, body: ExprID }
  | { t: "let", name: string, typ: Type | null, val: ExprID, mut: boolean } // `name := e;` / `name :: e;` / `name: T = e;` / `name: T : e;`
  | { t: "dlet", fields: { name: string, typ: Type | null, pos?: Loc }[], val: ExprID, mut: boolean } // `[a, b] := val;` / `[a, b] :: val;` destructuring bind; field pos: the field name token (go-to-definition target).
  | { t: "assign", name: string, val: ExprID }
  | { t: "if", c: ExprID, a: ExprID, b: ExprID }
  | { t: "while", c: ExprID, body: ExprID }
  | { t: "block", stmts: ExprID[], semi: boolean }
  | { t: "perform", op: string, args: ExprID[] }
  | { t: "handle", body: ExprID, cases: HandlerCase[] }
  | { t: "app", fn: ExprID, args: ExprID[] } // width/suspension stamps live in Checked.stamps (stamps.ts), not on the node
  | { t: "as", e: ExprID, typ: Type } // `@as(expr, T)` numeric cast; asKind rides Checked.stamps (stamps.ts), not the node.
  | { t: "arr", elems: ExprID[] } // `[a, b, c]` literal: array if homogeneous, tuple if heterogeneous. arrKind rides Checked.stamps (stamps.ts), not the node.
  | { t: "field", obj: ExprID, name: string } // `obj.x` / `obj.0` field access; the resolved field index rides Checked.stamps (stamps.ts), not the node.
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

// Parser state (recursive descent + Pratt for infix): plain data threaded
// through the free functions below.
type Parser = {
  toks: Tok[],
  i: number,
  // Parametric type aliases, registered top-down as `type` items are parsed.
  // `typeParamStack` lets an alias body reference its own type params as type
  // variables (e.g. `type Pair(a, b) = [a, b]`).
  aliases: Map<string, Alias>,
  typeParamStack: Map<string, Var>[],
  // Type/effect name occurrences, pushed in source order while parsing.
  typeToks: TypeTok[],
  // Whether the most recent parseStmt expression statement consumed a
  // trailing `;` — parseBlock reads it to decide if the block's last
  // expression is its value (no `;`) or discarded (unit).
  stmtSemi: boolean,
  // Flat node arena: every parsed expression is pushed here once and referred
  // to by `ExprID` (its index) from parents, items, and closures.
  nodes: Expr[],
  // Node source extents, parallel to `nodes`: each expression's start and
  // exclusive end token — undefined only on synthesized nodes (the operator
  // `sym`s and bools desugared from `&&`/`||`/`!`). Backends ignore it.
  locs: (LocRange | undefined)[],
};

function newParser(src: string): Parser {
  return {toks: lex(src), i: 0, aliases: new Map(), typeParamStack: [], typeToks: [], stmtSemi: false, nodes: [], locs: []};
}

export function parseProgram(src: string): Program {
  return program(newParser(src));
}
  // Record the token just consumed (name = its text: the extent and the
  // effect-sig hover lookup).
function recordTypeTok(st: Parser, kind: TypeTok["kind"], name: string): void {
  st.typeToks.push({pos: st.toks[st.i - 1].pos, len: name.length, kind, name});
}
function peek(st: Parser, o = 0): string | undefined {
  return st.toks[st.i + o]?.v;
}
function next(st: Parser): string {
  return st.toks[st.i++].v;
}
// Position of the token at offset `o` from the cursor (undefined past EOF).
function pos(st: Parser, o = 0): Loc | undefined {
  return st.toks[st.i + o]?.pos;
}
function eat(st: Parser, s: string): void {
  if (peek(st) !== s) fail(st, `Expected "${s}", got "${peek(st)}"`);
  st.i++;
}
// Every comma-separated list (args, params, fn types, effect rows, bracket
// literals/patterns) shares one rule: the comma is required between
// elements, and a `,` directly before the close delimiter is the optional
// trailing comma. At the close delimiter itself this is a no-op, leaving
// the caller's `while (!is(st, close))` loop to exit.
function listSep(st: Parser, close: string): void {
  if (is(st, ",")) st.i++;
  else if (!is(st, close)) fail(st, `Expected "," or "${close}", got "${peek(st)}"`);
}
// Throw a ParseError anchored at the token `o` offsets from the cursor
// (negative = an already-consumed token). Past EOF the error is zero-width
// at the last token's end — where input ran out.
function fail(st: Parser, msg: string, o = 0): never {
  const t = st.toks.at(st.i + o);
  if (t !== undefined) throw new ParseError(msg, t.pos, t.end);
  const end = st.toks.at(-1)?.end ?? {line: 1, col: 1};
  throw new ParseError(msg, end, end);
}
function is(st: Parser, s: string): boolean {
  return peek(st) === s;
}
function isKw(st: Parser, kw: string): boolean {
  return peek(st) === kw && KEYWORDS.has(kw);
}
function atEnd(st: Parser): boolean {
  return st.i >= st.toks.length;
}

// Flat node arena: every parsed expression is pushed here once and referred
// to by `ExprID` (its index) from parents, items, and closures.
function add(st: Parser, e: Expr, pos?: Loc): ExprID {
  st.nodes.push(e);
  // Every add site consumes the node's final token before adding (parents
  // are added after their children; statement binders add before eating
  // the trailing `;`), so the last consumed token's end is the node's end.
  st.locs.push(pos === undefined ? undefined : {start: pos, end: st.toks[st.i - 1].end});
  return st.nodes.length - 1;
}

function program(st: Parser): Program {
  const items: Item[] = [];
  while (!atEnd(st)) {
    if (peek(st, 1) === "::" && peek(st, 2) === "effect") items.push(parseEffect(st));
    else {
      const al = tryParseAliasItem(st);
      items.push(al ?? {e: parseStmt(st)});
    }
  }
  return {nodes: st.nodes, locs: st.locs, items, typeToks: st.typeToks};
}
// Effect declarations, in the uniform `E :: effect(A): B;` binding form — the
// same `name :: ...` convention as type aliases, with `effect` keywording the
// RHS. The declared name is a regular binding in the separate effect
// namespace.
function parseEffect(st: Parser): Item {
  const p = pos(st);
  const name = next(st);
  recordTypeTok(st, "macro", name);
  eat(st, "::");
  next(st); // effect
  const params = parseParams(st);
  eat(st, ":");
  const ret = parseType(st);
  eat(st, ";");
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
function tryParseAliasItem(st: Parser): Item | null {
  const name = peek(st);
  if (name === undefined || KEYWORDS.has(name)) return null;
  const save = st.i;
  const toksLen = st.typeToks.length;
  const p = pos(st);
  next(st); // name
  recordTypeTok(st, "type", name);
  if (!is(st, "::")) {
    st.i = save;
    st.typeToks.length = toksLen;
    return null;
  }
  next(st); // ::
  let pushed = false;
  try {
    if (isKw(st, "fn")) {
      next(st); // fn
      eat(st, "(");
      const tparams = new Map<string, Var>();
      while (!is(st, ")")) {
        const p = next(st);
        if (KEYWORDS.has(p)) throw Error("not a type fn");
        recordTypeTok(st, "typeParameter", p);
        eat(st, ":");
        if (!isKw(st, "type")) throw Error("not a type fn");
        next(st); // type
        tparams.set(p, parserVar());
        listSep(st, ")");
      }
      eat(st, ")");
      eat(st, ":");
      if (!isKw(st, "type")) throw Error("not a type fn");
      next(st); // type
      eat(st, "{");
        st.typeParamStack.push(tparams);
        pushed = true;
        const body = parseType(st);
        st.typeParamStack.pop();
        pushed = false;
        eat(st, "}");
      eat(st, ";");
      const alias = {name, tparams, body};
      st.aliases.set(name, alias);
      return {alias, pos: p};
    }
    // Nullary: the RHS is any type shape — bracket/paren/fn-type forms,
    // plus bare names (`s32 :: i32`) and alias applications (`t :: V2[i64]`)
    // — resolved by the same parseType fallback that throws on unknown
    // names.
    const body = parseType(st);
    eat(st, ";");
    const alias = {name, tparams: new Map<string, Var>(), body};
    st.aliases.set(name, alias);
    return {alias, pos: p};
    } catch {
    if (pushed) st.typeParamStack.pop();
    st.i = save;
    st.typeToks.length = toksLen;
    return null;
  }
}

function parseStmt(st: Parser): ExprID {
  const p = pos(st);
  st.stmtSemi = false;
  let e: ExprID;
  const nonKw = peek(st) !== undefined && !KEYWORDS.has(peek(st)!);
  if (nonKw && peek(st, 1) === ":=") {
    // `name := val;` — mutable, inferred type.
    const name = next(st);
    next(st); // :=
    const val = parseExpr(st);
    e = add(st, {t: "let", name, typ: null, val, mut: true}, p);
    eat(st, ";");
    } else if (nonKw && peek(st, 1) === "::") {
    // `name :: val;` — const, inferred type.
    const name = next(st);
    next(st); // ::
    const val = parseExpr(st);
    e = add(st, {t: "let", name, typ: null, val, mut: false}, p);
    eat(st, ";");
    } else if (nonKw && peek(st, 1) === ":") {
    // `name: T = val;` — mutable, annotated; `name: T : val;` — const, annotated.
    const name = next(st);
    next(st); // :
    const typ = parseType(st);
    const isConst = is(st, ":");
    if (isConst) next(st);
    else eat(st, "=");
    const val = parseExpr(st);
    e = add(st, {t: "let", name, typ, val, mut: !isConst}, p);
    eat(st, ";");
    } else if (is(st, "[")) {
    // Destructuring bind (`[a: T, b] := val;` / `[a: T, b] : val;`) or an
    // array literal as an expression statement (`[x, y]` as a block tail).
    // The bracketed prefix is ambiguous, so try destructuring and backtrack
    // to an expression unless a bind operator follows `]`.
    const save = st.i;
    try {
      next(st);
      const fields: { name: string, typ: Type | null, pos?: Loc }[] = [];
      while (!is(st, "]")) {
        const at = pos(st);
        const name = next(st);
        const typ = is(st, ":") ? (next(st), parseType(st)) : null;
        fields.push({name, typ, pos: at});
        listSep(st, "]");
      }
      eat(st, "]");
      // Typed fields bind the value with `:` (const) or `:=` (mut);
      // untyped fields keep the `::` / `:=` pair.
      const isConst = fields.some((f) => f.typ !== null) ? is(st, ":") : is(st, "::");
      if (isConst) next(st);
      else eat(st, ":=");
      const val = parseExpr(st);
      e = add(st, {t: "dlet", fields, val, mut: !isConst}, p);
      eat(st, ";");
      } catch {
      st.i = save;
      e = parseExpr(st);
      st.stmtSemi = is(st, ";");
      if (st.stmtSemi)
      st.i++;
      else if (!isBlocky(st.nodes[e]) && !is(st, "}") && !atEnd(st))
    eat(st, ";");
  }
  } else if (nonKw && peek(st, 1) === "=") {
  const name = next(st);
  next(st); // =
  const val = parseExpr(st);
  e = add(st, {t: "assign", name, val}, p);
  if (is(st, ";"))
  st.i++;
  } else {
  e = parseExpr(st);
  st.stmtSemi = is(st, ";");
  if (st.stmtSemi)
  st.i++;
  else if (!isBlocky(st.nodes[e]) && !is(st, "}") && !atEnd(st))
eat(st, ";");
}
return e;
}

function parseParams(st: Parser): Param[] {
eat(st, "(");
const params: Param[] = [];
while (!is(st, ")")) {
const at = pos(st);
const name = next(st);
const typ = is(st, ":") ? (next(st), parseType(st)) : null;
params.push({name, typ, pos: at});
listSep(st, ")");
}
eat(st, ")");
return params;
}

function parseArgs(st: Parser): ExprID[] {
eat(st, "(");
const args: ExprID[] = [];
while (!is(st, ")")) {
args.push(parseExpr(st));
listSep(st, ")");
}
eat(st, ")");
return args;
}

function parseBlock(st: Parser): ExprID {
const p = pos(st);
eat(st, "{");
const stmts: ExprID[] = [];
let semi = false;
while (!is(st, "}")) {
stmts.push(parseStmt(st));
semi = st.stmtSemi;
}
eat(st, "}");
return add(st, {t: "block", stmts, semi}, p);
}

// optional `! { op, op, ... }` effect annotation on a fn return type
function parseEffAnnot(st: Parser): Set<string> | null {
if (!is(st, "!")) return null;
next(st);
eat(st, "{");
const effs = new Set<string>();
while (!is(st, "}")) {
const eff = next(st);
recordTypeTok(st, "macro", eff);
effs.add(eff);
listSep(st, "}");
}
eat(st, "}");
return effs;
}

// types
// Parse a single tuple field: `name: T` (named) or `T` (unnamed).
function parseTupField(st: Parser): TupField {
if (peek(st) !== undefined && /[A-Za-z_]/.test(peek(st)![0]) && peek(st, 1) === ":") {
const name = next(st);
next(st); // :
return {name, type: parseType(st)};
}
return {name: null, type: parseType(st)};
}

function parseType(st: Parser): Type {
if (is(st, "[")) {
next(st);
const first = parseTupField(st);
if (is(st, ",")) {
// tuple: `[T1, T2, ...]` (named or unnamed)
const fields = [first];
while (is(st, ",")) {
st.i++;
if (is(st, "]")) break; // trailing comma tolerance
fields.push(parseTupField(st));
}
eat(st, "]");
return tTup(fields);
}
eat(st, "]");
if (first.name !== null)
fail(st, "array type cannot have a named element", -1); // the `]`
return tArr(first.type);
}
if (is(st, "(")) {
next(st);
const ps: Type[] = [];
while (!is(st, ")")) {
ps.push(parseType(st));
listSep(st, ")");
}
eat(st, ")");
eat(st, "-");
eat(st, ">");
const ret = parseType(st);
return tFun(ps, ret, rowOf(parseEffAnnot(st) ?? undefined));
}
const name = next(st);
// type parameter of an enclosing alias body → a type variable.
for (const m of st.typeParamStack)
if (m.has(name)) {
recordTypeTok(st, "typeParameter", name);
return m.get(name)!;
}
// Every other name consumed in type position — prims (incl. `unit`,
// `any`, the `type`-of-types keyword), alias uses, and names that turn
// out unknown (thrown below; the LSP discards tokens when a program
// fails to check).
recordTypeTok(st, "type", name);
// alias instantiation: `Name(T1, T2)` (or nullary `Name`). In a type
// position `Name(...)` has no other reading, so the call-like form is
// unambiguous.
const al = st.aliases.get(name);
if (al !== undefined) {
const args: Type[] = [];
if (is(st, "(")) {
next(st);
while (!is(st, ")")) {
args.push(parseType(st));
listSep(st, ")");
}
eat(st, ")");
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
default: fail(st, "Unknown type: " + name, -1); // the name token
}
}

// --- Pratt ---
function parseExpr(st: Parser): ExprID {
return parseBinary(st, 0);
}

function parseBinary(st: Parser, min: number): ExprID {
let left = parseUnary(st);
while (true) {
const op = peek(st);
if (op === undefined || !binOps.has(op))
break;
const prec = PREC[op];
if (prec < min)
break;
next(st);
const right = parseBinary(st, prec + 1);
if (op === "&&")
left = add(st, {t: "if", c: left, a: right, b: add(st, {t: "bool", v: false})}, st.locs[left]?.start);
else if (op === "||")
left = add(st, {t: "if", c: left, a: add(st, {t: "bool", v: true}), b: right}, st.locs[left]?.start);
else
left = add(st, {t: "app", fn: add(st, {t: "sym", v: op}), args: [left, right]}, st.locs[left]?.start);
}
return left;
}

function parseUnary(st: Parser): ExprID {
const p = pos(st);
if (is(st, "-")) {
next(st);
return add(st, {t: "app", fn: add(st, {t: "sym", v: OP_NEG}), args: [parseUnary(st)]}, p);
}
if (is(st, "!")) {
next(st);
return add(st, {t: "app", fn: add(st, {t: "sym", v: OP_NOT}), args: [parseUnary(st)]}, p);
}
return parsePostfix(st);
}

function parsePostfix(st: Parser): ExprID {
let e = parsePrimary(st);
// perform: `Op!(args)` (postfix `!` after an effect name).
const prim = st.nodes[e];
if (prim.t === "sym" && is(st, "!") && peek(st, 1) === "(") {
const op = prim.v;
recordTypeTok(st, "macro", op);
next(st); // !
const args = parseArgs(st);
e = add(st, {t: "perform", op, args}, st.locs[e]?.start);
}
while (is(st, "(")) {
const args = parseArgs(st);
e = add(st, {t: "app", fn: e, args}, st.locs[e]?.start);
}
// field access: `obj.x` (named) or `obj.0` (positional). The lexer
// reads `0.0` as a single float token, so a chained `m.0.0` arrives as
// one field name; split it into successive accesses.
while (is(st, ".")) {
next(st);
const name = next(st);
for (const part of name.split(".")) e = add(st, {t: "field", obj: e, name: part}, st.locs[e]?.start);
}
return e;
}

function parsePrimary(st: Parser): ExprID {
const t = peek(st);
if (t === undefined) fail(st, "Unexpected EOF");
const p = pos(st);
if (t === "@") {
// `@as(expr, T)` — the one explicit numeric cast.
next(st);
const name = next(st);
if (name !== "as") fail(st, `Unknown @-form: @${name}`, -1); // the form name
eat(st, "(");
const e = parseExpr(st);
eat(st, ",");
const typ = parseType(st);
eat(st, ")");
return add(st, {t: "as", e, typ}, p);
}
if (/^-?\d/.test(t)) {
next(st);
return add(st, {t: "num", v: Number(t), isFloat: t.includes("."), raw: t.includes(".") ? undefined : t}, p);
}
if (t.startsWith("\"")) {
next(st);
return add(st, {t: "str", v: parseStr(t)}, p);
}
if (t === "true") {
next(st);
return add(st, {t: "bool", v: true}, p);
}
if (t === "false") {
next(st);
return add(st, {t: "bool", v: false}, p);
}
if (t === "unit") {
next(st);
return add(st, {t: "unit"}, p);
}
if (t === "(") {
next(st);
const e = parseExpr(st);
eat(st, ")");
return e;
}
if (t === "[") {
next(st);
const els: ExprID[] = [];
while (!is(st, "]")) {
els.push(parseExpr(st));
listSep(st, "]");
}
eat(st, "]");
return add(st, {t: "arr", elems: els}, p);
}
if (isKw(st, "fn")) {
next(st);
const params = parseParams(st);
const retTyp = is(st, ":") ? (next(st), parseType(st)) : null;
const retEffs = parseEffAnnot(st);
const body = parseBlock(st);
return add(st, {t: "lambda", params, retTyp, retEffs, body}, p);
}
if (isKw(st, "if")) {
next(st);
eat(st, "(");
const c = parseExpr(st);
eat(st, ")");
const a = parseBlock(st);
let b: ExprID = add(st, {t: "unit"}, p);
if (isKw(st, "else")) {
next(st);
b = isKw(st, "if") ? parsePrimary(st) : parseBlock(st);
} else if (is(st, ";")) {
st.i++;
}
return add(st, {t: "if", c, a, b}, p);
}
if (isKw(st, "while")) {
next(st);
eat(st, "(");
const c = parseExpr(st);
eat(st, ")");
const body = parseBlock(st);
return add(st, {t: "while", c, body}, p);
}
if (isKw(st, "handle")) {
next(st);
const body = parseBlock(st);
const cases: HandlerCase[] = [];
while (isKw(st, "case")) {
next(st);
const op = next(st);
recordTypeTok(st, "macro", op);
const params = parseParams(st);
eat(st, "=>");
const resume = next(st);
const resumePos = st.toks[st.i - 1].pos;
const cbody = parseBlock(st);
cases.push({op, params, resume, resumePos, body: cbody});
}
return add(st, {t: "handle", body, cases}, p);
}
// Fallthrough is ident-shaped tokens only (mirrors the lexer's ident
// rule): every other token kind has a branch above. A stray punctuation
// token must fail here as a parse error — as a `sym` node it surfaced
// later as a baffling type error ("literal arity 6 ≠ tuple 2" for
// `[x: 1, y: 2]`).
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) fail(st, `Unexpected token "${t}"`);
next(st);
return add(st, {t: "sym", v: t}, p);
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
