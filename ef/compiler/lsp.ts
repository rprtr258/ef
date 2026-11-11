// ef language server: LSP over stdio wrapping the ef parser + checker.
//
// Diagnostics are fail-fast: `checkProgram` throws on the first error, so each
// publish carries at most one diagnostic. Type errors arrive located — the
// checker's infer wrapper prefixes messages with `at line L, col C: `
// (1-based); parse errors carry no position and anchor at 0:0. Hover resolves
// only top-level bindings and builtins (the checker env holds no local
// frames; effects are a separate namespace and don't resolve).
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
} from "vscode-languageserver/node";
import {Parser} from "./parser.ts";
import {checkProgram, showT} from "./types.ts";

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

function checkDoc(src: string): Diagnostic[] {
  try {
    checkProgram(new Parser(src).parseProgram());
    return [];
  } catch (err) {
    return [diagnosticOf(err)];
  }
}

// wordAt: identifier covering the 0-based (line, col), or null. Textual scan
// (not AST-based), so a word inside a string/comment can resolve if it names
// a binding — accepted v1 imprecision.
function wordAt(src: string, line: number, col: number): string | null {
  const text = src.split("\n")[line] ?? "";
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const start = m.index, end = start + m[0].length;
    if (col >= start && col < end) return m[0];
  }
  return null;
}

// Hover target's type as `name : Type`; showT renders fn effect rows
// (`! { ... }`) itself. A program that doesn't check has no types to show.
function hoverAt(src: string, line: number, col: number): Hover | null {
  const word = wordAt(src, line, col);
  if (word === null)
    return null;
  try {
    const checked = checkProgram(new Parser(src).parseProgram());
    if (checked.env.lookup(word) === undefined) return null;
    const t = checked.env.lookupResolved(word);
    return {contents: {kind: MarkupKind.PlainText, value: `${word} : ${showT(t)}`}};
  } catch {
    return null;
  }
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
  connection.listen();
}
