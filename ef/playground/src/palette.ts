// palette.ts — the Ctrl+K command palette: every studio command in one
// filterable list. setupPalette wires the input/backdrop listeners.
import {isEntryFile} from "./bridge.ts";
import {build, openFile, run} from "./actions.ts";
import {downloadActive, downloadWasm} from "./downloads.ts";
import {editor} from "./editor.ts";
import {fmtBytes} from "./format.ts";
import {openModal} from "./modal.ts";
import {setTab} from "./output.ts";
import {activeFile, els, state, theme} from "./state.ts";
import {toggleTheme} from "./theme.ts";

type Cmd = {label: string, hint: string, run: () => void};

function commands(): Cmd[] {
  const f = activeFile();
  return [
    {label: "Run", hint: isEntryFile(f.code) ? "Ctrl+↩ — compile to wasm and run, streaming Out!/Println!" : "no top-level expressions — the open file isn't an entry", run: () => void run()},
    {label: "Build wasm", hint: isEntryFile(f.code) ? "Ctrl+B — emit WasmGC main.wasm (binaryen shrink)" : "no top-level expressions — the open file isn't an entry", run: () => void build()},
    {label: "New file…", hint: "add a .ef file to src/", run: () =>
      openModal({title: "New file", value: "untitled.ef", ok: "Create", onOk: (v) => {
        const name = v.trim();
        if (name === "" || !name.endsWith(".ef")) return;
        if (state.project.files.some((x) => x.name === name)) return;
        state.project.files.push({name, code: "# new file\n"});
        state.active = name;
        openFile(name);
      }})},
    {label: `Rename ${f.name}…`, hint: "rename the active file", run: () =>
      openModal({title: "Rename file", value: f.name, ok: "Rename", onOk: (v) => {
        const name = v.trim();
        if (name === "" || !name.endsWith(".ef") || state.project.files.some((x) => x.name === name)) return;
        f.name = name;
        state.active = name;
        openFile(name);
      }})},
    {label: `Delete ${f.name}`, hint: state.project.files.length <= 1 ? "the last file cannot go" : "remove the active file", run: () =>
      openModal({title: `Delete ${f.name}?`, value: "", ok: "Delete", onOk: () => {
        const i = state.project.files.findIndex((x) => x.name === f.name);
        state.project.files.splice(i, 1);
        const ni = Math.max(0, i - 1);
        openFile(state.project.files[ni].name);
      }})},
    {label: "New project…", hint: "reset to the default welcome project", run: () =>
      openModal({title: "New project name", value: "scratch", ok: "Create", onOk: (v) => {
        const name = v.trim();
        if (name === "") return;
        state.project = {name, files: [{name: "main.ef", code: `# ${name}\n\n1 + 1\n`}]};
        state.wasm = null;
        state.buildMs = null;
        state.runMs = null;
        state.lastKind = null;
        openFile("main.ef");
      }})},
    {label: "Download main.wasm", hint: state.wasm === null ? "build first" : `${fmtBytes(state.wasm.bytes.length)}`, run: () => downloadWasm()},
    {label: `Download ${f.name}`, hint: "save the active file", run: () => downloadActive()},
    {label: "Toggle theme", hint: `currently ${theme}`, run: () => toggleTheme()},
    {label: "Show output", hint: "switch the bottom pane", run: () => setTab("output")},
    {label: "Show problems", hint: "parse/check/lint diagnostics", run: () => setTab("problems")},
  ];
}

let paletteItems: Cmd[] = [];
let paletteSel = 0;

function renderPalette(): void {
  const q = els.paletteInput.value.toLowerCase();
  paletteItems = commands().filter((c) => c.label.toLowerCase().includes(q));
  paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
  els.paletteList.replaceChildren();
  for (const [i, c] of paletteItems.entries()) {
    const r = document.createElement("div");
    r.className = "pal-row" + (i === paletteSel ? " on" : "");
    const l = document.createElement("span");
    l.textContent = c.label;
    const h = document.createElement("span");
    h.className = "hint";
    h.textContent = c.hint;
    r.append(l, h);
    r.addEventListener("click", () => {
      closePalette();
      c.run();
    });
    els.paletteList.appendChild(r);
  }
}

export function openPalette(): void {
  els.palette.classList.remove("hidden");
  paletteSel = 0;
  els.paletteInput.value = "";
  renderPalette();
  els.paletteInput.focus();
}

export function closePalette(): void {
  els.palette.classList.add("hidden");
  editor?.focus();
}

export function setupPalette(): void {
  els.paletteInput.addEventListener("input", () => {
    paletteSel = 0;
    renderPalette();
  });
  els.palette.addEventListener("click", (e) => {
    if (e.target === els.palette) closePalette();
  });
  els.paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1);
      renderPalette();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      paletteSel = Math.max(paletteSel - 1, 0);
      renderPalette();
      e.preventDefault();
    } else if (e.key === "Enter") {
      const c = paletteItems[paletteSel];
      closePalette();
      c.run();
      e.preventDefault();
    } else if (e.key === "Escape") {
      closePalette();
    }
  });
}
