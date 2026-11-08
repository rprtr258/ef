// output.ts — the output pane: streamed lines and the output/problems tabs.
import {$, els, state, type Tab} from "./state.ts";

export function outLine(s: string, cls = ""): void {
  const div = document.createElement("div");
  div.className = "out-line" + (cls === "" ? "" : " " + cls);
  div.textContent = s === "" ? " " : s;
  els.out.appendChild(div);
  els.out.scrollTop = els.out.scrollHeight;
}

export function clearOutput(): void {
  els.out.replaceChildren();
}

export function setTab(t: Tab): void {
  state.tab = t;
  els.tabOutput.classList.toggle("on", t === "output");
  els.tabProblems.classList.toggle("on", t === "problems");
  els.out.classList.toggle("hidden", t !== "output");
  $("#problems").classList.toggle("hidden", t !== "problems");
}
