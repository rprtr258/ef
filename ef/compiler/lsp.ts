// ef language server: LSP over stdio wrapping the ef parser + checker.
//
// Diagnostics are fail-fast: `checkProgram` throws on the first error, so each
// publish carries at most one diagnostic. Type errors arrive located — the
// checker's infer wrapper prefixes messages with `at line L, col C: `
// (1-based); parse errors carry no position and anchor at 0:0. Hover shows the
// innermost checked subexpression under the cursor (binder sites show the
// bound value's type); a document that doesn't check has no types to show.
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
  type SemanticTokens,
  type SemanticTokensParams,
} from "vscode-languageserver/node";
import {Parser, type ExprID, type Program, type TypeTok} from "./parser.ts";
import {checkProgram, showT, TANY, type Checked, type EffectSig, type Unifier} from "./types.ts";
import type {Pos} from "./lexer.ts";

// `at line L, col C: ` — the located-prefix format stamped onto type errors.
const LOC = /^at line (\d+), col (\d+): /;

// Zero-width diagnostic: VS Code renders a marker at the position; the
// checker gives no token extent to underline.
function diagnosticOf(err: unknown): Diagnostic {
  const msg = err instanceof Error ? err.message : String(err);
  const m = LOC.exec(msg);
  const line = m !== null ? Number(m[1]) - 1 : 0;
  const col = m !== null ? Number(m[2]) - 1 : 0;
  return {
    severity: DiagnosticSeverity.Error,
    range: {start: {line, character: col}, end: {line, character: col}},
    message: m !== null ? msg.slice(m[0].length) : msg,
    source: "ef",
  };
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
    const prog = new Parser(src).parseProgram();
    const checked = checkProgram(prog);
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
    checkProgram(new Parser(src).parseProgram());
    return [];
  } catch (err) {
    return [diagnosticOf(err)];
  }
}

// Lexicographic Pos comparison (1-based line/col).
function posLE(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col);
}
function posLT(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

// Effect sigs render function-style, like fns: `Choose : () -> bool`. The
// sig's params/ret are deep-resolved so a use site's unifications (args
// unified against the sig during checking) show concretely.
function effSigText(uni: Unifier, sig: EffectSig): string {
  return `(${sig.params.map(p => showT(uni.deepRes(p ?? TANY))).join(", ")}) -> ${showT(uni.deepRes(sig.ret))}`;
}

// Display text for one candidate node, or null to fall through to the next
// containing node. Typed syms show `name : Type` (instantiated for
// polymorphic uses); binder nodes record unit, so they display the bound
// value's type (annotated/wildcard vals are pinned to the binding's resolved
// width by the checker) as `name : Type`; everything else the bare type.
function hoverText(prog: Program, checked: Checked, id: ExprID, c: Pos): string | null {
  const e = prog.nodes[id], uni = checked.uni;
  if (e.t === "sym") {
    const nt = uni.nodeTypes.get(id);
    if (nt !== undefined) return `${e.v} : ${showT(uni.deepRes(nt))}`;
    // Callee syms the checker never infers (list's app case): env lookup.
    return checked.env.lookup(e.v) === undefined
      ? null : `${e.v} : ${showT(checked.env.lookupResolved(e.v))}`;
  }
  const nt = uni.nodeTypes.get(id);
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
      const bt = uni.nodeTypes.get(cse.body);
      const argT = cse.op === "Return" ? uni.nodeTypes.get(e.body) : checked.effects.get(cse.op)?.ret;
      if (bt === undefined || argT === undefined) return null;
      return `${cse.resume} : (${showT(uni.deepRes(argT))}) -> ${showT(uni.deepRes(bt))}`;
    }
  }
  if (e.t === "let" || e.t === "assign" || e.t === "dlet") {
    const vt = uni.nodeTypes.get(e.val);
    if (vt === undefined) return null;
    const s = showT(uni.deepRes(vt));
    return e.t === "dlet" ? s : `${e.name} : ${s}`;
  }
  return showT(uni.deepRes(nt));
}

// Hover: the innermost checked subexpression whose source extent covers the
// cursor — nodes carry a start pos and `prog.ends` the exclusive end, and the
// checker records every inferred node's type in `uni.nodeTypes`. Candidates
// also include untyped sym nodes (display falls through to the env for those).
function hoverAt(src: string, line: number, col: number): Hover | null {
  let prog: Program, checked: Checked;
  try {
    prog = new Parser(src).parseProgram();
    checked = checkProgram(prog);
  } catch {
    return null;
  }
  // 1-based cursor, matching Pos.
  const c = {line: line + 1, col: col + 1};
  // Effect-name occurrences (decls, `! { … }` rows, performs, case labels)
  // are recorded as macro typeToks; hovering one shows the op's signature.
  // This safely preempts the node search: no expression node lies inside an
  // identifier, and value references are never recorded as typeToks. Every
  // macro occurrence in a checked program names a declared effect, so the
  // sig lookup succeeds.
  for (const t of prog.typeToks) {
    if (t.kind !== "macro" || t.pos.line !== c.line ||
        c.col < t.pos.col || t.pos.col + t.len <= c.col) continue;
    const sig = checked.effects.get(t.name);
    if (sig !== undefined)
      return {contents: {kind: MarkupKind.Markdown, value: "```ef\n" + `${t.name} : ${effSigText(checked.uni, sig)}` + "\n```"}};
  }
  const cands: ExprID[] = [];
  for (let id = 0; id < prog.nodes.length; id++) {
    const e = prog.nodes[id];
    if (e.pos === undefined || !posLE(e.pos, c) || !posLT(c, prog.ends[id])) continue;
    if (checked.uni.nodeTypes.has(id) || e.t === "sym") cands.push(id);
  }
  // Innermost first: greatest start, then smallest extent.
  cands.sort((a, b) => {
    const sa = prog.nodes[a].pos!, sb = prog.nodes[b].pos!;
    if (sa.line !== sb.line) return sb.line - sa.line;
    if (sa.col !== sb.col) return sb.col - sa.col;
    const ea = prog.ends[a], eb = prog.ends[b];
    if (ea.line !== eb.line) return ea.line - eb.line;
    return ea.col - eb.col;
  });
  for (const id of cands) {
    const text = hoverText(prog, checked, id, c);
    if (text !== null)
      return {contents: {kind: MarkupKind.Markdown, value: "```ef\n" + text + "\n```"}};
  }
  return null;
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
  connection.languages.semanticTokens.on((p: SemanticTokensParams): SemanticTokens => {
    const src = docs.get(p.textDocument.uri);
    return src === undefined ? {data: []} : semanticTokens(src);
  });
  connection.listen();
}
