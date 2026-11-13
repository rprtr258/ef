// panes.ts — fold/show toggles for the shell's three collapsible panes
// (explorer tree, bottom output/problems panel, insight rail). Folding keeps
// a slim residual strip hosting the pane's toggle button — a 28px column for
// the side panes (studio.css), the title bar alone for the bottom panel —
// instead of letting the button overlap the editor. #main's tree-folded /
// rail-folded classes resize the grid tracks to the strip; the split handle
// hides with the pane (a folded pane is not draggable). Fold state persists
// in localStorage.
import {els} from "./state.ts";

type PaneKey = "tree" | "panel" | "rail";

type Pane = {
  btn: HTMLElement,
  pane: HTMLElement,
  handle: HTMLElement,
  grid: string | null,  // #main class resizing the grid tracks to the strip
};

const PANES: Record<PaneKey, Pane> = {
  tree: {btn: els.paneTreeBtn, pane: els.tree, handle: els.splitTree, grid: "tree-folded"},
  panel: {btn: els.panePanelBtn, pane: els.panel, handle: els.splitPanel, grid: null},
  rail: {btn: els.paneRailBtn, pane: els.rail, handle: els.splitRail, grid: "rail-folded"},
};

const PANES_KEY = "ef.playground.panes";

function loadFolded(): Record<PaneKey, boolean> {
  try {
    const p = JSON.parse(localStorage.getItem(PANES_KEY) ?? "") as Partial<Record<PaneKey, boolean>>;
    return {tree: p.tree === true, panel: p.panel === true, rail: p.rail === true};
  } catch {
    return {tree: false, panel: false, rail: false};
  }
}

const folded: Record<PaneKey, boolean> = loadFolded();

function apply(k: PaneKey): void {
  const p = PANES[k];
  p.pane.classList.toggle("folded", folded[k]);
  p.handle.classList.toggle("hidden", folded[k]);
  if (p.grid !== null) els.main.classList.toggle(p.grid, folded[k]);
  p.btn.classList.toggle("off", folded[k]);
}

function setPane(k: PaneKey, v: boolean): void {
  folded[k] = v;
  localStorage.setItem(PANES_KEY, JSON.stringify(folded));
  apply(k);
}

export function setupPanes(): void {
  for (const [k, p] of Object.entries(PANES) as [PaneKey, Pane][]) {
    p.btn.addEventListener("click", () => setPane(k, !folded[k]));
    apply(k);
  }
}
