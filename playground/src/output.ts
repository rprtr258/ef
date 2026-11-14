// output.ts — the output pane: streamed lines and the output/problems tabs.
import {els, state, type Tab} from "./state.ts";

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

const PANES: {tab: Tab, btn: HTMLElement, pane: HTMLElement}[] = [
  {tab: "output", btn: els.tabOutput, pane: els.out},
  {tab: "problems", btn: els.tabProblems, pane: els.problems},
];

export function setTab(t: Tab): void {
  state.tab = t;
  for (const p of PANES) {
    p.btn.classList.toggle("on", p.tab === t);
    p.pane.classList.toggle("hidden", p.tab !== t);
  }
}
