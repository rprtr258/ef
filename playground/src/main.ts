// ef playground — a small multi-file ef IDE in the browser.
//
// The ef compiler's TypeScript frontend runs natively in the bundle
// (parse → check → lint are live; wasm emit lazily loads the binaryen chunk).
// Each .ef file is its own compilation unit and entrypoint (like `ef run
// <file>`): Run/Build compile only the open file — ef has no import mechanism
// yet, so files cannot see each other's bindings. ef has no `fun main()`
// either — the program value is the file's last top-level expression, and a
// file whose last top-level expression isn't unit-typed isn't an entry
// (Run/Build disabled).
//
// Run compiles the open file through the wasm backend and executes it in the
// browser's WebAssembly (streaming Out!/Println! into the output pane) —
// O(1) stack via wasm tail calls, unlike the CPS interpreter which leans on
// JSC tail calls and overflows V8. Build emits the same WasmGC main.wasm
// (downloadable). The Pipeline card's ops row shows the active file's
// residual effect row — the ops that reach the top level, the `_` line of
// `ef types` — while build reports the open file's performed ops (a typecheck
// byproduct, not a wasm artifact).
//
// Shell: "Instrument" — explorer tree | editor + tabbed output | insight rail
// (BUILD / OUTLINE cards), Ctrl+K command palette, light/dark themes
// (system-following, toggle persisted).
//
// Split into strictly-layered sub-modules (no import cycles):
// - project.ts       — Project type + the default welcome project (leaf)
// - state.ts         — app state, DOM registry (els), persisted prefs
// - format.ts        — fmtMs/fmtBytes (leaf)
// - statusbar.ts     — the bottom statusbar
// - theme.ts         — monaco theme definition + light/dark application
// - editor.ts        — monaco editor creation, ef line tokenizer
// - output.ts        — output pane lines + the panel tab strip
// - views.ts          — AST/CPS/WAT views shown in place of the editor
//                       (+ ast_view/cps_view printers)
// - pipeline_card.ts — Pipeline card stage row (Lex/Parse/Check)
// - tree.ts          — explorer tree (src/ + build/ rows)
// - rail.ts          — BUILD / OUTLINE insight cards
// - problems.ts      — problems pane (parse/check/lint diagnostics)
// - downloads.ts     — file/wasm download helpers
// - splits.ts        — draggable pane splits
// - panes.ts          — pane fold/show toggles (tree, bottom panel, rail)
// - modal.ts         — name-prompt modal
// - actions.ts       — run/build/recompute/openFile (the controller)
// - palette.ts       — Ctrl+K command palette
// main.ts itself is the composition root: boot() wires events and renders.

import * as monaco from "monaco-editor/esm/vs/editor/editor.main.js";
import {build, onEdit, openFile, run} from "./actions.ts";
import {editor, refreshTokens, setupMonaco} from "./editor.ts";
import {closeModal, setupModal} from "./modal.ts";
import {clearOutput, outLine, setTab} from "./output.ts";
import {closePalette, openPalette, setupPalette} from "./palette.ts";
import {setupPanes} from "./panes.ts";
import {renderStages} from "./pipeline_card.ts";
import {renderBuildCard} from "./rail.ts";
import {setupSplits} from "./splits.ts";
import {els, state} from "./state.ts";
import {setView} from "./views.ts";
import {applyTheme, toggleTheme} from "./theme.ts";

function boot(): void {
  applyTheme();
  setupMonaco();
  refreshTokens();

  editor?.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run());
  editor?.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => build());

  els.runBtn.addEventListener("click", () => run());
  els.buildBtn.addEventListener("click", () => build());
  els.themeBtn.addEventListener("click", () => toggleTheme());
  els.paletteBtn.addEventListener("click", () => openPalette());
  els.clearBtn.addEventListener("click", () => clearOutput());
  setupSplits();
  setupPanes();
  setupModal();
  setupPalette();
  els.tabOutput.addEventListener("click", () => setTab("output"));
  els.tabProblems.addEventListener("click", () => setTab("problems"));
  // Editor-title view tabs: click to show, click again (or the filename) to
  // return to the editor.
  els.viewAst.addEventListener("click", () => setView(state.view === "ast" ? "editor" : "ast"));
  els.viewCps.addEventListener("click", () => setView(state.view === "cps" ? "editor" : "cps"));
  els.viewWat.addEventListener("click", () => setView(state.view === "wat" ? "editor" : "wat"));
  els.crumbFile.addEventListener("click", () => setView("editor"));

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      openPalette();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      run();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      build();
      e.preventDefault();
    } else if (e.key === "Escape") {
      closePalette();
      closeModal();
    }
  });

  editor?.onDidChangeModelContent(() => onEdit());

  openFile(state.active);
  setTab("output");
  renderStages(true);
  renderBuildCard();
  outLine("ef playground ready — Ctrl+K for commands, Ctrl+↩ to run, Ctrl+B to build wasm.", "dim");
  outLine(`project “${state.project.name}” · ${state.project.files.length} files · ef compiler running in your browser.`, "dim");
}

boot();
