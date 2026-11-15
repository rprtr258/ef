// ef language server: LSP over stdio wrapping the ef parser + checker.
//
// Diagnostics are fail-fast: `prepare` throws on the first error, so each
// publish carries at most one diagnostic. Errors carry a 1-based source pos
// as data — parse errors via ParseError's token extent (underlined), checker
// errors via TypeError_.pos (zero-width marker). Only whole-program failures
// with no single blame site (e.g. a recursive type alias) anchor at 0:0. Hover
// shows the
// innermost checked subexpression under the cursor (binder sites show the
// bound value's type); a document that doesn't check has no types to show.
// Go-to-definition is parse-only (navigation works on documents that fail
// the check): effect names jump to their `effect` item, alias names to their
// alias item, value names to the unique binding site — the checker's
// no-shadowing rule makes a non-`_` name's binder unambiguous.
//
// Transport: explicit stdin/stdout — one code path for `ef lsp`, the test
// harness, and the VS Code client (which spawns the server with
// TransportKind.stdio). The extension bundles this file; `bun`/`node` run it
// via the CLI.
import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  MarkupKind,
  type Diagnostic,
  type Hover,
  type InitializeResult,
  type Location,
  type SemanticTokens,
  type SemanticTokensParams,
} from "vscode-languageserver/node";
import {Parser, type Alias, type ExprID, type Program, type TypeTok} from "./frontend/parser.ts";
import {showT, TypeError_} from "./frontend/type_display.ts";
import {type Unifier} from "./frontend/unify.ts";
import {tFun, TANY, rowOf} from "./prims.ts";
import type {Checked, EffectSig} from "./frontend/types.ts";
import {prepare} from "./frontend/pipeline.ts";
import {builtinParamNames} from "./builtins.ts";
import {forEachBinder} from "./frontend/walk.ts";
import {ParseError, type Loc} from "./frontend/lexer.ts";

// Parse errors carry the offending token's 1-based extent — underlined.
// Checker errors carry a bare 1-based pos with no token extent — a zero-width
// marker. Position-less errors (whole-program failures) anchor at 0:0, the
// anchor for "somewhere in this document".
function diagnosticOf(err: unknown): Diagnostic {
  const msg = err instanceof Error ? err.message : String(err);
  const p = err instanceof ParseError ? err.pos : err instanceof TypeError_ ? err.pos : undefined;
  const start = {line: (p?.line ?? 1) - 1, character: (p?.col ?? 1) - 1};
  const end = err instanceof ParseError
    ? {line: err.end.line - 1, character: err.end.col - 1}
    : start;
  return {severity: DiagnosticSeverity.Error, range: {start, end}, message: msg, source: "ef"};
}

// Semantic token kinds: one constant feeds both the capability legend and
// the emitted tokenType indices (they must match byte-for-byte).
const TOKEN_KINDS = ["type", "typeParameter", "macro", "function", "variable"] as const;
const KIND_INDEX: Record<TypeTok["kind"], number> = {type: 0, typeParameter: 1, macro: 2, function: 3, variable: 4};

// LSP delta-encoded semantic tokens for the document. Empty when the document
// fails to parse or check (consistent with the fail-fast diagnostics — no
// highlights on top of an error).
function semanticTokens(src: string): SemanticTokens {
  try {
    const {prog, checked} = prepare(src);
    // Parser typeToks (type/effect surface) + checker semToks (value
    // identifiers), one position-sorted delta-encoded stream.
    const toks = [...prog.typeToks, ...checked.semToks].sort((a, b) =>
      a.pos.line !== b.pos.line ? a.pos.line - b.pos.line : a.pos.col - b.pos.col);
    const data: number[] = [];
    let pl = 0, pc = 0;
    for (const t of toks) {
      const line = t.pos.line - 1, col = t.pos.col - 1; // 1-based → 0-based
      data.push(line - pl, pl === line ? col - pc : col, t.len, KIND_INDEX[t.kind], 0);
      pl = line;
      pc = col;
    }
    return {data};
  } catch {
    return {data: []};
  }
}

function checkDoc(src: string): Diagnostic[] {
  try {
    prepare(src);
    return [];
  } catch (err) {
    return [diagnosticOf(err)];
  }
}

// Lexicographic Loc comparison (1-based line/col).
function posLE(a: Loc, b: Loc): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col);
}
function posLT(a: Loc, b: Loc): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

// Effect sigs render function-style, like fns: `Choose : () -> bool`, with
// the op's declared param names when present (`Read : (path: string) -> string`).
// The sig's params/ret are deep-resolved so a use site's unifications (args
// unified against the sig during checking) show concretely.
function effSigText(uni: Unifier, sig: EffectSig): string {
  return showT(uni.deepRes(tFun(sig.params.map(p => p ?? TANY), sig.ret, rowOf())), sig.names);
}

// Alias definition: `Pair(a, b) = [fst: a, snd: b]` — tuple fields render
// with their names, and the body's parser-level tparam Vars print under
// their declared names via showT's var-name seed.
function aliasText(al: Alias): string {
  const varNames = new Map<number, string>();
  for (const [n, v] of al.tparams) varNames.set(v.id, n);
  const ps = [...al.tparams.keys()];
  return `${al.name}${ps.length > 0 ? `(${ps.join(", ")})` : ""} = ${showT(al.body, undefined, varNames)}`;
}

// Param names for a function-typed name: its unique `:: fn(…)` binder (the
// no-shadowing rule keeps value bindings unique), else the builtin's
// declared names. Display-only — absent names render bare types.
function fnPNames(prog: Program, name: string): string[] | undefined {
  for (const b of prog.nodes) {
    if (b.t !== "let" || b.name !== name) continue;
    const lam = prog.nodes[b.val];
    if (lam.t === "lambda") return lam.params.map(p => p.name);
  }
  return builtinParamNames(name);
}

// Hover payload: markdown in an `ef` code fence, so it's syntax-highlighted
// with the same grammar as the editor.
function hoverMd(text: string): Hover {
  return {contents: {kind: MarkupKind.Markdown, value: "```ef\n" + text + "\n```"}};
}

// Display text for one candidate node, or null to fall through to the next
// containing node. Typed syms show `name : Type` (instantiated for
// polymorphic uses), with the fn's param names when known (binder lambda or
// builtin table); binder nodes record unit, so they display the bound
// value's type (annotated/num-typed vals are pinned to the binding's resolved
// width by the checker) as `name : Type`; everything else the bare type.
function hoverText(prog: Program, checked: Checked, id: ExprID, c: Loc): string | null {
  const e = prog.nodes[id], uni = checked.uni;
  if (e.t === "sym") {
    const names = fnPNames(prog, e.v);
    const nt = checked.nodeTypes[id];
    if (nt !== undefined) return `${e.v} : ${showT(uni.deepRes(nt), names)}`;
    // Callee syms the checker never infers (structural operators like `+`):
    // env lookup.
    return checked.env.lookup(e.v) === undefined
      ? null : `${e.v} : ${showT(checked.env.lookupResolved(e.v), names)}`;
  }
  const nt = checked.nodeTypes[id];
  if (nt === undefined) return null;
  // Performs display the op's signature (function-style), not just the result
  // the perform expression evaluates to — same info as hovering the op name.
  if (e.t === "perform") {
    const sig = checked.effects.get(e.op);
    if (sig !== undefined) return `${e.op} : ${effSigText(uni, sig)}`;
  }
  // Resume binders (`case … => k { … }`) aren't expression nodes; their type
  // is the checker's resume: (sig.ret) -> case result (Return's resume takes
  // the handle body's type). The enclosing handle is the innermost node here.
  if (e.t === "handle") {
    for (const cse of e.cases) {
      if (cse.resumePos.line !== c.line ||
          c.col < cse.resumePos.col || cse.resumePos.col + cse.resume.length <= c.col) continue;
      const bt = checked.nodeTypes[cse.body];
      const argT = cse.op === "Return" ? checked.nodeTypes[e.body] : checked.effects.get(cse.op)?.ret;
      if (bt === undefined || argT === undefined) return null;
      return `${cse.resume} : (${showT(uni.deepRes(argT))}) -> ${showT(uni.deepRes(bt))}`;
    }
  }
  if (e.t === "let" || e.t === "assign" || e.t === "dlet") {
    const vt = checked.nodeTypes[e.val];
    if (vt === undefined) return null;
    const lam = prog.nodes[e.val];
    const s = showT(uni.deepRes(vt), lam.t === "lambda" ? lam.params.map(p => p.name) : undefined);
    return e.t === "dlet" ? s : `${e.name} : ${s}`;
  }
  return showT(uni.deepRes(nt), e.t === "lambda" ? e.params.map(p => p.name) : undefined);
}

// Hover: the innermost checked subexpression whose source extent covers the
// cursor — each node's extent in `prog.locs` brackets it (start inclusive,
// end exclusive), and the checker records every inferred node's type in
// `checked.nodeTypes`. Candidates
// also include untyped sym nodes (display falls through to the env for those).
function hoverAt(src: string, line: number, col: number): Hover | null {
  let prog: Program, checked: Checked;
  try {
    ({prog, checked} = prepare(src));
  } catch {
    return null;
  }
  // 1-based cursor, matching Loc.
  const c = {line: line + 1, col: col + 1};
  // Type/effect name occurrences (recorded as typeToks) hover their target:
  // effect names (decls, `! { … }` rows, performs, case labels) → the op's
  // signature; alias names (decls, type uses) → the definition. This safely
  // preempts the node search: no expression node lies inside an identifier,
  // and value references are never recorded as typeToks. Every macro
  // occurrence in a checked program names a declared effect, and parseType
  // rejects unknown alias names, so both lookups succeed.
  for (const t of prog.typeToks) {
    if ((t.kind !== "macro" && t.kind !== "type") || t.pos.line !== c.line ||
        c.col < t.pos.col || t.pos.col + t.len <= c.col) continue;
    if (t.kind === "macro") {
      const sig = checked.effects.get(t.name);
      if (sig !== undefined) return hoverMd(`${t.name} : ${effSigText(checked.uni, sig)}`);
    } else {
      const item = prog.items.find(it => "alias" in it && it.alias.name === t.name);
      if (item !== undefined && "alias" in item) return hoverMd(aliasText(item.alias));
    }
  }
  const cands: ExprID[] = [];
  for (let id = 0; id < prog.nodes.length; id++) {
    const loc = prog.locs[id];
    if (loc === undefined || !posLE(loc.start, c) || !posLT(c, loc.end)) continue;
    if (checked.nodeTypes[id] !== undefined || prog.nodes[id].t === "sym") cands.push(id);
  }
  // Innermost first: greatest start, then smallest extent.
  cands.sort((a, b) => {
    const la = prog.locs[a]!, lb = prog.locs[b]!;
    const sa = la.start, sb = lb.start;
    if (sa.line !== sb.line) return sb.line - sa.line;
    if (sa.col !== sb.col) return sb.col - sa.col;
    if (la.end.line !== lb.end.line) return la.end.line - lb.end.line;
    return la.end.col - lb.end.col;
  });
  for (const id of cands) {
    const text = hoverText(prog, checked, id, c);
    if (text !== null) return hoverMd(text);
  }
  return null;
}

// One value binding site: the binder name token's 1-based extent.
type Binder = {name: string, pos: Loc, len: number};

// All value binding sites — let names, destructuring fields, lambda params,
// handler case params, and resume binders, per node in forEachBinder order
// (nodes in slice order). The binder guard is inherited from walk.ts: a new
// Expr variant must extend forEachBinder, which extends this list.
function binders(prog: Program): Binder[] {
  const out: Binder[] = [];
  for (const [id, e] of prog.nodes.entries())
    forEachBinder(e, prog.locs[id]?.start, (name, pos) => {
      if (pos !== undefined) out.push({name, pos, len: name.length});
    });
  return out;
}

// A name token's LSP location (1-based Loc → 0-based single-line range).
function nameLoc(uri: string, pos: Loc, len: number): Location {
  const start = {line: pos.line - 1, character: pos.col - 1};
  return {uri, range: {start, end: {line: start.line, character: start.character + len}}};
}

// Definition of the identifier under the cursor, per namespace: effect names
// (macro typeToks — decls, `! { … }` rows, performs, case labels) jump to
// their `effect` item, alias names (type toks) to their alias item, value
// names to the unique binder — a use (`sym`, assign target) or the binder
// itself. Builtin effects/values and unknown names have no site → null.
function definitionAt(uri: string, src: string, line: number, col: number): Location | null {
  let prog: Program;
  try {
    prog = new Parser(src).parseProgram();
  } catch {
    return null;
  }
  // 1-based cursor, matching Loc.
  const c = {line: line + 1, col: col + 1};
  // Decl-site name positions per namespace — effects are hoisted (usable
  // before their item in source order) and alias tparams repeat across
  // aliases, so neither "first matching tok" nor source-order guessing can
  // locate a decl; the parser records the name token's pos on the item.
  const effectDecls = new Map<string, Loc>();
  const aliasDecls = new Map<string, Loc>();
  for (const it of prog.items) {
    if ("effect" in it && it.pos !== undefined) effectDecls.set(it.effect, it.pos);
    if ("alias" in it && it.pos !== undefined) aliasDecls.set(it.alias.name, it.pos);
  }
  const inTok = (pos: Loc, len: number): boolean =>
    pos.line === c.line && pos.col <= c.col && c.col < pos.col + len;
  for (const t of prog.typeToks) {
    if (!inTok(t.pos, t.len)) continue;
    if (t.kind === "macro") {
      const pos = effectDecls.get(t.name);
      return pos === undefined ? null : nameLoc(uri, pos, t.name.length);
    }
    if (t.kind === "type") {
      const pos = aliasDecls.get(t.name);
      return pos === undefined ? null : nameLoc(uri, pos, t.name.length);
    }
  }
  const bs = binders(prog);
  for (const b of bs)
    if (inTok(b.pos, b.len)) return nameLoc(uri, b.pos, b.len);
  let ref: string | undefined;
  for (const [id, e] of prog.nodes.entries()) {
    if (ref !== undefined) break;
    const loc = prog.locs[id];
    if (loc === undefined) continue;
    if (e.t === "sym" && inTok(loc.start, e.v.length)) ref = e.v;
    else if (e.t === "assign" && inTok(loc.start, e.name.length)) ref = e.name;
  }
  if (ref === undefined || ref === "_") return null;
  const b = bs.find(b => b.name === ref);
  return b === undefined ? null : nameLoc(uri, b.pos, b.len);
}

export function startLsp(): void {
  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const docs = new Map<string, string>();

  const publish = (uri: string, src: string): void => {
    void connection.sendDiagnostics({uri, diagnostics: checkDoc(src)});
  };

  connection.onInitialize((): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      hoverProvider: true,
      definitionProvider: true,
      semanticTokensProvider: {
        legend: {tokenTypes: [...TOKEN_KINDS], tokenModifiers: []},
        full: true,
      },
    },
  }));
  connection.onDidOpenTextDocument(p => {
    docs.set(p.textDocument.uri, p.textDocument.text);
    publish(p.textDocument.uri, p.textDocument.text);
  });
  connection.onDidChangeTextDocument(p => {
    // Full sync: the change event carries the whole document text.
    const text = p.contentChanges[p.contentChanges.length - 1].text;
    docs.set(p.textDocument.uri, text);
    publish(p.textDocument.uri, text);
  });
  connection.onDidCloseTextDocument(p => {
    docs.delete(p.textDocument.uri);
    void connection.sendDiagnostics({uri: p.textDocument.uri, diagnostics: []});
  });
  connection.onHover(p => {
    const src = docs.get(p.textDocument.uri);
    return src === undefined ? null : hoverAt(src, p.position.line, p.position.character);
  });
  connection.onDefinition(p => {
    const src = docs.get(p.textDocument.uri);
    return src === undefined ? null : definitionAt(p.textDocument.uri, src, p.position.line, p.position.character);
  });
  connection.languages.semanticTokens.on((p: SemanticTokensParams): SemanticTokens => {
    const src = docs.get(p.textDocument.uri);
    return src === undefined ? {data: []} : semanticTokens(src);
  });
  connection.listen();
}
