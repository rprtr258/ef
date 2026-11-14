// rail.ts — the insight rail's cards: BUILD (last build/run stats + wasm
// size), the active file's residual ops row, and the OUTLINE card
// (jump-to-line top-level bindings).
import {outline, topLevelEffs, type OutlineItem} from "./bridge.ts";
import {editor} from "./editor.ts";
import {fmtBytes, fmtMs} from "./format.ts";
import {$, activeFile, els, state} from "./state.ts";

export function renderBuildCard(): void {
  els.statBuildTime.textContent = state.buildMs === null ? "—" : fmtMs(state.buildMs);
  els.statSize.textContent = state.wasm === null ? "—" : fmtBytes(state.wasm.bytes.length);
  els.statRunTime.textContent = state.runMs === null ? "—" : fmtMs(state.runMs);
}

// ops stat: the active file's residual top-level effect row — the same set
// `ef types` prints on its `_` line (ops reaching the top level; internally
// handled ops excluded). "—" when the file alone doesn't parse/check (e.g.
// it references other files' bindings — those errors live in Problems).
export function renderOpsStat(): void {
  let effs: string[] | null = null;
  try {
    effs = topLevelEffs(activeFile().code);
  } catch {
    effs = null;
  }
  els.statOps.textContent = effs === null || effs.length === 0 ? "—" : `{ ${effs.join(", ")} }`;
}

export function renderOutlineCard(): void {
  const list = $("#outline-rows");
  list.replaceChildren();
  let items: OutlineItem[] = [];
  try {
    items = outline(activeFile().code);
  } catch {
    items = []; // parse error — outline goes blank until it parses again
  }
  if (items.length === 0) {
    const d = document.createElement("div");
    d.className = "rail-row dim";
    d.textContent = "no top-level bindings";
    list.appendChild(d);
    return;
  }
  for (const it of items) {
    const r = document.createElement("div");
    r.className = "rail-row outline-row";
    const k = document.createElement("span");
    k.className = "k " + it.kind;
    // one-letter kind badge: fn → f, let → l, effect → e, type → t
    k.textContent = {fn: "f", let: "l", effect: "e", type: "t"}[it.kind];
    const n = document.createElement("span");
    n.className = "name";
    // with a resolved type, the effect row is part of it — no separate effs
    n.textContent = it.name + (it.typ !== null || it.effs === null ? "" : ` ${it.effs}`);
    r.append(k, n);
    if (it.typ !== null) {
      const ty = document.createElement("span");
      ty.className = "mono ty";
      ty.textContent = it.typ;
      r.appendChild(ty);
    }
    if (it.line !== null) {
      r.title = `line ${it.line}`;
      r.addEventListener("click", () => {
        editor?.revealLineInCenter(it.line ?? 1);
        editor?.setPosition({lineNumber: it.line ?? 1, column: 1});
        editor?.focus(); // cursor is only painted on a focused editor
      });
    }
    list.appendChild(r);
  }
}
