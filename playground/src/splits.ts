// splits.ts — draggable pane splits. The minikotlin studio's divider
// pattern: a handle captures the pointer on press, re-derives its CSS
// variable per move (--tree-w/--rail-w on #main, --panel-h on #center),
// and releases on up. Arrows repeat the drag in 16px steps for keyboard
// users.
import {els} from "./state.ts";

function setTreeW(w: number): void {
  const max = Math.round(els.main.clientWidth / 2);
  els.main.style.setProperty("--tree-w", `${Math.round(Math.max(148, Math.min(max, w)))}px`);
}

function setRailW(w: number): void {
  const max = Math.round(els.main.clientWidth / 2);
  els.main.style.setProperty("--rail-w", `${Math.round(Math.max(180, Math.min(max, w)))}px`);
}

function setPanelH(h: number): void {
  const max = Math.round(els.center.clientHeight * 0.6);
  els.center.style.setProperty("--panel-h", `${Math.round(Math.max(112, Math.min(max, h)))}px`);
}

function dragSplit(el: HTMLElement, size: (e: PointerEvent) => void): void {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    document.body.classList.add("splitting");
    const up = () => {
      el.classList.remove("dragging");
      document.body.classList.remove("splitting");
      el.removeEventListener("pointermove", size);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", size);
    el.addEventListener("pointerup", up);
  });
}

// current size in px for the arrow keys; falls back to the CSS defaults
// before the first drag
function curPx(el: HTMLElement, name: string, fallback: number): number {
  const v = parseInt(el.style.getPropertyValue(name), 10);
  return Number.isNaN(v) ? fallback : v;
}

export function setupSplits(): void {
  dragSplit(els.splitTree, (e) =>
    setTreeW(e.clientX - els.main.getBoundingClientRect().left - 3));
  dragSplit(els.splitRail, (e) =>
    setRailW(els.main.getBoundingClientRect().right - e.clientX - 3));
  dragSplit(els.splitPanel, (e) =>
    setPanelH(els.center.getBoundingClientRect().bottom - e.clientY - 3));

  els.splitTree.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") setTreeW(curPx(els.main, "--tree-w", 228) + 16);
    else if (e.key === "ArrowLeft") setTreeW(curPx(els.main, "--tree-w", 228) - 16);
    else return;
    e.preventDefault();
  });
  els.splitRail.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") setRailW(curPx(els.main, "--rail-w", 288) + 16);
    else if (e.key === "ArrowRight") setRailW(curPx(els.main, "--rail-w", 288) - 16);
    else return;
    e.preventDefault();
  });
  els.splitPanel.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") setPanelH(curPx(els.center, "--panel-h", 240) + 16);
    else if (e.key === "ArrowDown") setPanelH(curPx(els.center, "--panel-h", 240) - 16);
    else return;
    e.preventDefault();
  });
}
