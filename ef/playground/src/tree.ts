// tree.ts — the explorer tree: src/ file rows (entry badges) and the
// build/ main.wasm row (click to download).
import {isEntryFile} from "./bridge.ts";
import {downloadWasm} from "./downloads.ts";
import {fmtBytes} from "./format.ts";
import {els, state} from "./state.ts";

export function renderTree(onOpen: (name: string) => void): void {
  const tree = els.tree;
  tree.replaceChildren();

  const group = (label: string) => {
    const g = document.createElement("div");
    g.className = "tree-group";
    g.textContent = label;
    tree.appendChild(g);
  };

  group("src");
  for (const f of state.project.files) {
    const row = document.createElement("div");
    row.className = "tree-file" + (f.name === state.active ? " on" : "");
    const dot = document.createElement("span");
    dot.className = "tree-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = f.name;
    row.append(dot, name);
    if (isEntryFile(f.code)) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "entry";
      badge.title = "entry — running this file evaluates to its last top-level expression";
      row.appendChild(badge);
    }
    row.addEventListener("click", () => onOpen(f.name));
    tree.appendChild(row);
  }

  if (state.wasm !== null) {
    group("build");
    const row = document.createElement("div");
    row.className = "tree-file wasm";
    const dot = document.createElement("span");
    dot.className = "tree-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = "main.wasm";
    const n = document.createElement("span");
    n.className = "tree-lines";
    n.textContent = fmtBytes(state.wasm.bytes.length);
    row.append(dot, name, n);
    row.title = "click to download";
    row.addEventListener("click", () => downloadWasm());
    tree.appendChild(row);
  }
}
