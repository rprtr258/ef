// editor.ts — the monaco editor: creation and the ef line tokenizer.
// Tokenization is line-based and stateless (ef has no line-spanning
// constructs); the provider walks lines in model order and indexes the
// precomputed line tokens, refreshed on every edit.
import * as monaco from "monaco-editor/esm/vs/editor/editor.main.js";
import {tokenize} from "./bridge.ts";
import {activeFile, els} from "./state.ts";

export let editor: monaco.editor.IStandaloneCodeEditor | null = null;

// The tokens provider reads precomputed line tokens; the state carries the
// line index (ef has no line-spanning constructs, so tokenization is
// stateless per line).
class EfState implements monaco.languages.IState {
  constructor(public line = 0) {}
  clone(): EfState {
    return new EfState(this.line);
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof EfState && other.line === this.line;
  }
}

export function setupMonaco(): void {
  monaco.languages.register({id: "ef", extensions: [".ef"]});
  self.MonacoEnvironment = {
    getWorker: () => new Worker("./worker.js", {type: "module"}),
  };
  editor = monaco.editor.create(els.edhost, {
    value: "",
    language: "ef",
    theme: "ef-studio",
    fontSize: 13,
    lineHeight: 20,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    tabSize: 2,
    insertSpaces: true,
    renderWhitespace: "none",
    guides: {indentation: true},
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  });

  editor.onDidChangeCursorPosition((e) => {
    els.crumbPos.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });
  monaco.languages.setTokensProvider("ef", {
    getInitialState: () => new EfState(0),
    tokenize(_line: string, st: monaco.languages.IState): monaco.languages.ILineTokens {
      const s = st instanceof EfState ? st : new EfState(0);
      const toks = tokenLines[s.line] ?? [];
      return {
        tokens: toks.map((t) => ({startIndex: t.start, scopes: t.scope})),
        endState: new EfState(s.line + 1),
      };
    },
  });
}

let tokenLines: {start: number, len: number, scope: string}[][] = [];

export function refreshTokens(): void {
  tokenLines = tokenize(editor === null ? activeFile().code : editor.getValue());
}
