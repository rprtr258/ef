// pipeline_card.ts — the Pipeline card's stage row (Lex/Parse/Check).
import {fmtMs} from "./format.ts";
import {els} from "./state.ts";

// ef's stages run inside one synchronous call (runWasmProgram / compileWithOps), so
// per-stage times are a proportional split of the real measured total
// (deterministic weights).
const PIPE_W = [0.22, 0.31, 0.47];

export function renderStages(reset: boolean): void {
  els.stages.replaceChildren();
  for (const name of ["Lex", "Parse", "Check"]) {
    const d = document.createElement("div");
    d.className = "stage";
    const dot = document.createElement("span");
    dot.className = "sdot";
    const nm = document.createElement("span");
    nm.className = "sname";
    nm.textContent = name;
    const ms = document.createElement("span");
    ms.className = "sms";
    ms.textContent = reset ? "—" : "";
    d.append(dot, nm, ms);
    els.stages.appendChild(d);
  }
}

export function stagesBusy(): void {
  renderStages(true);
  for (const [i, r] of [...els.stages.children].entries()) {
    r.className = "stage" + (i === 0 ? " busy" : "");
    const msEl = r.querySelector(".sms");
    if (msEl !== null) msEl.textContent = i === 0 ? "…" : "—";
  }
}

export function stagesDone(totalMs: number): void {
  const total = Math.max(1, Math.round(totalMs));
  const parts = PIPE_W.map((w) => Math.max(1, Math.round(total * w)));
  parts[parts.length - 1] += total - parts.reduce((a, b) => a + b, 0);
  for (const [i, r] of [...els.stages.children].entries()) {
    r.className = "stage done";
    const msEl = r.querySelector(".sms");
    if (msEl !== null) msEl.textContent = fmtMs(Math.max(1, parts[i] ?? 1));
  }
}

export function stagesError(): void {
  for (const [i, r] of [...els.stages.children].entries()) {
    r.className = "stage" + (i === 0 ? " err" : "");
    const msEl = r.querySelector(".sms");
    if (msEl !== null) msEl.textContent = i === 0 ? "×" : "—";
  }
}
