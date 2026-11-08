// problems.ts — the problems pane: parse/check/lint diagnostics for the
// active file; rows with a line jump to it.
import {problems, type Problem} from "./bridge.ts";
import {editor} from "./editor.ts";
import {setTab} from "./output.ts";
import {$, activeFile, els, state} from "./state.ts";

export function renderProblems(ps: Problem[]): void {
  const box = $("#problems");
  box.replaceChildren();
  els.tabProblemsCount.textContent = ps.length === 0 ? "" : `${ps.length}`;
  if (ps.length === 0) {
    const d = document.createElement("div");
    d.className = "prob-row ok";
    d.textContent = "no issues";
    box.appendChild(d);
    return;
  }
  for (const p of ps) {
    const r = document.createElement("div");
    r.className = "prob-row " + p.stage;
    const loc = document.createElement("span");
    loc.className = "prob-loc";
    loc.textContent = p.stage + (p.line === null ? "" : ` · L${p.line}`);
    const msg = document.createElement("span");
    msg.className = "prob-msg";
    msg.textContent = p.msg;
    r.append(loc, msg);
    if (p.line !== null) {
      const line = p.line;
      r.title = `L${line} — click to jump`;
      r.addEventListener("click", () => {
        setTimeout(() => {
          editor?.revealLineInCenter(line);
          editor?.setPosition({lineNumber: line, column: 1});
          editor?.focus();
        }, 0);
      });
    }
    box.appendChild(r);
  }
}

export function liveProblems(): void {
  const ps = problems(activeFile().code);
  renderProblems(ps);
  setTab(state.tab);
}
