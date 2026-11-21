// views.ts — the AST/CPS/WAT inspection views shown in place of the editor
// (tabs in the editor title, content in a read-only monaco editor with
// monarch highlighting). AST/CPS re-render on every source change (parse +
// check + CPS, cheap); WAT compiles lazily — a full wasm build runs only
// when the WAT view is active with stale source.
import * as monaco from "monaco-editor/esm/vs/editor/editor.main.js";
import {showAst} from "./ast_view.ts";
import {showCps} from "./cps_view.ts";
import {compileWat} from "compiler/backend/wasm/wasm.ts";
import {prepare} from "compiler/frontend/pipeline.ts";
import {docFor, EF_IR_RULES, WAT_RULES} from "./view_lang.ts";
import {activeFile, els, state, type View} from "./state.ts";

type Inspect = Exclude<View, "editor">;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The compilers' dumps are S-expr-flavored: node tags as keywords,
// converter-generated $-names read best in a distinct hue (tag), and the
// numeric widths as types. Grammar rules and hover docs live in view_lang.ts
// (monaco-free, test-importable); this is the registration.
monaco.languages.register({id: "ef-ir"});
monaco.languages.setMonarchTokensProvider("ef-ir", {tokenizer: {root: EF_IR_RULES}});

// Subset of the WAT the backend emits (WasmGC: structs, arrays, ref casts);
// unlisted mnemonics simply stay plain text.
monaco.languages.register({id: "wat"});
monaco.languages.setMonarchTokensProvider("wat", {tokenizer: {root: WAT_RULES}});

// One hover provider serves both the AST and CPS views (same ef-ir
// language); word-based docs live in view_lang.ts.
monaco.languages.registerHoverProvider("ef-ir", {
  provideHover(model, position) {
    const w = model.getWordAtPosition(position);
    if (w === null) return null;
    const doc = docFor(w.word);
    if (doc === undefined) return null;
    return {
      range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn),
      contents: [{value: `**${w.word}** — ${doc}`}],
    };
  },
});

// One read-only editor for all three views, created on first activation and
// swapped between models (one per view — each keeps its language).
let viewEditor: monaco.editor.IStandaloneCodeEditor | null = null;
const models: Partial<Record<Inspect, monaco.editor.ITextModel>> = {};

function ensureEditor(): monaco.editor.IStandaloneCodeEditor {
  if (viewEditor !== null) return viewEditor;
  viewEditor = monaco.editor.create(els.viewhost, {
    model: null,
    theme: "ef-studio",
    readOnly: true,
    automaticLayout: true,
    fontSize: 13,
    lineHeight: 20,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    lineNumbers: "off",
    folding: false,
    renderLineHighlight: "none",
    guides: {indentation: false},
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  });
  return viewEditor;
}

function modelOf(v: Inspect): monaco.editor.ITextModel {
  const m = models[v];
  if (m !== undefined) return m;
  const nm = monaco.editor.createModel("", v === "wat" ? "wat" : "ef-ir");
  models[v] = nm;
  return nm;
}

// Re-derive the AST/CPS text for the open file. Called from recompute() (the
// edit debounce) and from onEditNow() (Run/Build's sync source update).
export function renderInsp(): void {
  const src = activeFile().code;
  for (const [v, f] of [["ast", showAst], ["cps", showCps]] as const) {
    try {
      modelOf(v).setValue(f(src));
    } catch (e) {
      modelOf(v).setValue(errText(e));
    }
  }
}

// The source the current WAT text was compiled from; null forces a recompile
// (including after a failed one — parse/check failures are cheap to retry).
let watSrc: string | null = null;

export function renderWat(): void {
  const src = activeFile().code;
  if (watSrc === src) return;
  try {
    modelOf("wat").setValue(compileWat(prepare(src)));
    watSrc = src;
  } catch (e) {
    modelOf("wat").setValue(errText(e));
    watSrc = null;
  }
}

// Show `v` in the editor area. Clicking the filename or the active view tab
// again returns to the editor (wired in main.ts).
export function setView(v: View): void {
  state.view = v;
  els.edhost.classList.toggle("hidden", v !== "editor");
  els.viewhost.classList.toggle("hidden", v === "editor");
  els.viewAst.classList.toggle("on", v === "ast");
  els.viewCps.classList.toggle("on", v === "cps");
  els.viewWat.classList.toggle("on", v === "wat");
  if (v === "editor") return;
  if (v === "wat") renderWat(); else renderInsp();
  ensureEditor().setModel(modelOf(v));
}
