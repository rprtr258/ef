// actions.ts — the controller: everything downstream of the source text
// (recompute → tokens/tree/outline/ops/problems), the open-file flow, and
// the two entry actions — Run (compile to wasm and execute, streaming
// output) and Build (emit main.wasm).
import {buildWasm, ExitSignal, isEntryFile, runWasmProgram} from "./bridge.ts";
import {show} from "../../compiler/env.ts";
import {showT} from "../../compiler/types.ts";
import {editor, refreshTokens} from "./editor.ts";
import {fmtBytes, fmtMs} from "./format.ts";
import {outLine, clearOutput, setTab} from "./output.ts";
import {stagesBusy, stagesDone, stagesError} from "./pipeline_card.ts";
import {liveProblems} from "./problems.ts";
import {renderBuildCard, renderOpsStat, renderOutlineCard} from "./rail.ts";
import {renderStatusbar} from "./statusbar.ts";
import {renderTree} from "./tree.ts";
import {renderInsp, renderWat} from "./views.ts";
import {activeFile, els, saveProject, state} from "./state.ts";

// Re-derive everything downstream of the source text.
function recompute(): void {
  refreshTokens();
  saveProject();
  renderTree(openFile);
  renderOutlineCard();
  renderOpsStat();
  liveProblems();
  renderInsp();
  refreshActions();
}

// Run/Build act on the open file as the entry; the last top-level expression
// must be unit-typed (effects don't matter) — disable the actions otherwise.
function refreshActions(): void {
  const entry = isEntryFile(activeFile().code);
  els.runBtn.disabled = !entry;
  els.buildBtn.disabled = !entry;
  const why = entry ? "" : " — last expression must have type unit";
  els.runBtn.title = `Ctrl+↩${why}`;
  els.buildBtn.title = `Ctrl+B${why}`;
}

export function openFile(name: string): void {
  const f = state.project.files.find((f) => f.name === name);
  if (f === undefined) return;
  state.active = name;
  editor?.setValue(f.code);
  els.crumbFile.textContent = name;
  const isEntry = isEntryFile(f.code);
  els.crumbEntry.textContent = isEntry ? "entry" : "";
  els.crumbEntry.classList.toggle("entry-badge", isEntry);
  recompute();
  if (state.view === "wat") renderWat(); // the view is open — compile the new file now
}

let debounce = 0;

export function onEdit(): void {
  const f = activeFile();
  if (editor !== null) f.code = editor.getValue();
  refreshTokens(); // cheap — keeps highlighting exact while typing
  window.clearTimeout(debounce);
  debounce = window.setTimeout(recompute, 250);
}

function onEditNow(): void {
  const f = activeFile();
  if (editor !== null) f.code = editor.getValue();
  window.clearTimeout(debounce);
  recompute();
}

export function run(): void {
  if (!isEntryFile(activeFile().code)) return; // last expression isn't unit — nothing to run
  onEditNow();
  clearOutput();
  setTab("output");
  stagesBusy();
  const src = activeFile().code;
  const t0 = performance.now();
  try {
    const r = runWasmProgram(src, (s) => {
      const parts = s.split("\n");
      if (parts[parts.length - 1] === "") parts.pop();
      for (const line of parts) outLine(line);
    });
    const ms = performance.now() - t0;
    outLine(`⇒ ${show(r.value)} · ${showT(r.type)}`, "result");
    stagesDone(ms);
    els.buildStatus.textContent = `ran in ${fmtMs(ms)} · ${showT(r.type)}`;
    state.runMs = ms;
    state.lastKind = "run";
    renderBuildCard();
    renderStatusbar();
  } catch (e) {
    const ms = performance.now() - t0;
    stagesError();
    if (e instanceof ExitSignal) {
      outLine(`⇒ exit ${e.code}`, "err");
      els.buildStatus.textContent = `exited ${e.code} in ${fmtMs(ms)}`;
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      outLine(msg, "err");
      els.buildStatus.textContent = `failed in ${fmtMs(ms)}`;
    }
  }
}

export async function build(): Promise<void> {
  if (!isEntryFile(activeFile().code)) return; // last expression isn't unit — nothing to build
  onEditNow();
  clearOutput();
  setTab("output");
  stagesBusy();
  const src = activeFile().code;
  const t0 = performance.now();
  try {
    const {bytes, ops} = await buildWasm(src);
    const ms = performance.now() - t0;
    state.wasm = {bytes};
    stagesDone(ms);
    outLine(`main.wasm · ${fmtBytes(bytes.length)} · ops: ${ops.length === 0 ? "none" : ops.join(", ")}`);
    outLine(`⇒ download from the build/ tree or the palette`, "dim");
    els.buildStatus.textContent = `built in ${fmtMs(ms)}`;
    state.buildMs = ms;
    state.lastKind = "build";
    renderBuildCard();
    renderTree(openFile);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outLine(msg, "err");
    stagesError();
    els.buildStatus.textContent = "build failed";
  }
}
