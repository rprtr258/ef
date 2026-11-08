// ef playground — a small multi-file ef IDE in the browser.
//
// The ef compiler's TypeScript frontend runs natively in the bundle
// (parse → check → lint are live; wasm emit lazily loads the binaryen chunk).
// A "project" of several .ef files is one compilation unit: files are
// concatenated in order, so top-level bindings are mutually visible. ef has no
// `fun main()` — the program value is the last top-level expression, so the
// entry file is the last one whose last item is a bare expression.
//
// Run compiles the project through the wasm backend and executes it in the
// browser's WebAssembly (streaming Out!/Println! into the output pane) —
// O(1) stack via wasm tail calls, unlike the CPS interpreter which leans on
// JSC tail calls and overflows V8. Build emits the same WasmGC main.wasm
// (downloadable). Performed ops — a typecheck byproduct, not a wasm artifact
// — are reported by both run and build.
//
// Shell: "Instrument" — explorer tree | editor + tabbed output | insight rail
// (BUILD / OUTLINE cards), Ctrl+K command palette, light/dark themes
// (system-following, toggle persisted).

import * as monaco from "monaco-editor/esm/vs/editor/editor.main.js";
import {
  buildWasm, concatProject, entryFile, ExitSignal, outline, problems,
  runWasmProgram, tokenize, type OutlineItem, type Problem,
} from "./bridge.ts";
import {show} from "../../compiler/env.ts";
import {showT} from "../../compiler/types.ts";

const $ = (s: string) => document.querySelector(s) as HTMLElement;

const LS_KEY = "ef.playground.project.v1";
const THEME_KEY = "ef.playground.theme";

// --- default project --------------------------------------------------------

const DEFAULT_PROJECT: Project = {
  name: "welcome",
  files: [
    {
      name: "effects.ef",
      code: `# Algebraic effects in ef: declare with \`effect\`, perform with Op!(...),
# interpret with handle ... case Op(...) => k { ... }.
effect Choose(lo: int, hi: int): int;
effect Emit(t: [int]): unit;

# Nondeterministic search: the Choose handler resumes the continuation once
# per option, so pyth branches into every path (examples/amb.ef has the tour).
let pyth = fn(n: int): unit ! { Choose, Emit } {
  let a = Choose!(1, n);
  let b = Choose!(a + 1, n);
  let c = Choose!(b + 1, n);
  if (a * a + b * b == c * c) {
    Emit!([a, b, c])
  } else {
    unit
  }
};

# Interprets nondeterminism only; emitted solutions propagate outward.
let solutions = fn(n: int): unit ! { Emit } {
  handle {
    pyth(n)
  } case Choose(lo, hi) => k {
    each(fn(x, _) { k(x) }, range(lo, hi + 1, 1))
  }
};

# Gathers every value emitted across all branches.
let triples = fn(n: int): [[int]] {
  handle {
    solutions(n)
  } case Emit(t) => k {
    concat([t], k(unit))
  } case Return(v) => k {
    []
  }
};`,
    },
    {
      name: "state.ef",
      code: `# Builtin effects interpreted by handlers instead of the host:
# Tick! performs, the handler owns the count in a cell and resumes with
# the next value. Resume k is multi-shot, so map over Tick! just works.
effect Tick(): int;

let counter = fn(steps: int): [int] {
  let cell = list();
  set(cell, 0, 0);
  handle {
    map(fn(_) { Tick!() }, range(0, steps, 1))
  } case Tick() => r {
    set(cell, 0, get(cell, 0) + 1);
    r(get(cell, 0))
  }
};

# Random! interpreted deterministically: every draw resumes with 0.42.
let deterministic = fn(n: int): [float] {
  handle {
    map(fn(_) { Random!() }, range(0, n, 1))
  } case Random() => r {
    r(0.42)
  }
};`,
    },
    {
      name: "main.ef",
      code: `# The entry file: ef runs top-level items in order and the program's value
# is the last top-level expression — this file sits last, so it wins.
each(fn(t: [int], _) { Println!(t) }, triples(14));
Println!(counter(5));
Println!(deterministic(8));
Out!("welcome to ef\\n");`,
    },
  ],
};

// --- state ------------------------------------------------------------------

type Project = {name: string, files: {name: string, code: string}[]};
type Tab = "output" | "problems";
type Theme = "light" | "dark";

type State = {
  project: Project,
  active: string,
  tab: Tab,
  wasm: {bytes: Uint8Array} | null,
  buildMs: number | null, // last successful build's time (BUILD stats)
  runMs: number | null, // last successful run's time (RUN stats)
  runOps: string[] | null, // performed/handled ops of the last successful run
  lastKind: "run" | "build" | null, // last successful action, drives the statusbar
};

const els = {
  topbar: $("#topbar"),
  brand: $("#brand"),
  paletteBtn: $("#palette-btn"),
  runBtn: $("#run-btn"),
  buildBtn: $("#build-btn"),
  themeBtn: $("#theme-btn"),
  tree: $("#tree"),
  crumbFile: $("#crumb-file"),
  crumbEntry: $("#crumb-entry"),
  crumbPos: $("#crumb-pos"),
  chip: $("#chip"),
  edhost: $("#edhost"),
  panel: $("#panel"),
  tabOutput: $("#tab-output"),
  tabProblems: $("#tab-problems"),
  tabProblemsCount: $("#tab-problems-count"),
  buildStatus: $("#build-status"),
  clearBtn: $("#clear-btn"),
  out: $("#out"),
  statBuildTime: $("#stat-build-time"),
  statSize: $("#stat-size"),
  statRunTime: $("#stat-run-time"),
  statOps: $("#stat-ops"),
  stages: $("#stages"),
  rail: $("#rail"),
  buildCard: $("#build-card"),
  outlineCard: $("#outline-card"),
  statusbar: $("#statusbar"),
  statusLeft: $("#status-left"),
  statusRight: $("#status-right"),
  palette: $("#palette"),
  paletteInput: $("#palette-input") as HTMLInputElement,
  paletteList: $("#palette-list"),
  modal: $("#modal"),
  modalTitle: $("#modal-title"),
  modalInput: $("#modal-input") as HTMLInputElement,
  modalOk: $("#modal-ok"),
  modalCancel: $("#modal-cancel"),
};

const bootProject = loadProject();
const state: State = {
  project: bootProject,
  active: bootProject.files[bootProject.files.length - 1].name,
  tab: "output",
  wasm: null,
  buildMs: null,
  runMs: null,
  runOps: null,
  lastKind: null,
};

function loadProject(): Project {
  const raw = localStorage.getItem(LS_KEY);
  if (raw === null) return DEFAULT_PROJECT;
  try {
    const p = JSON.parse(raw) as Project;
    if (Array.isArray(p.files) && typeof p.name === "string" && p.files.every((f) => typeof f.name === "string" && typeof f.code === "string") && p.files.length > 0)
      return p;
  } catch {
    // fall through to default
  }
  return DEFAULT_PROJECT;
}

function saveProject(): void {
  localStorage.setItem(LS_KEY, JSON.stringify(state.project));
}

const codes = (): string[] => state.project.files.map((f) => f.code);
const activeFile = (): {name: string, code: string} => {
  const f = state.project.files.find((f) => f.name === state.active);
  return f ?? state.project.files[0];
};

function concatLines(codes: string[]): {file: number, line: number}[] {
  // Map a line number in the concatenation back to (file, line) — 1-indexed.
  const map: {file: number, line: number}[] = [];
  for (let fi = 0; fi < codes.length; fi++) {
    const n = codes[fi].split("\n").length;
    for (let l = 1; l <= n; l++) map.push({file: fi, line: l});
    // blank separator line between files
    if (fi < codes.length - 1) map.push({file: fi, line: n + 1});
  }
  return map;
}

// --- theme ------------------------------------------------------------------

const mq = window.matchMedia("(prefers-color-scheme: dark)");
function themePref(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : (mq.matches ? "dark" : "light");
}
let theme = themePref();

const MONACO_COLORS = {
  light: {
    base: "ffffff", ink: "14171c", faint: "6b7280", line: "e5e7eb",
    sel: "dbeafe", cursor: "1d4ed8",
    kw: "7c3aed", str: "0f766e", num: "b45309", com: "9ca3af",
    typ: "1d4ed8", tag: "be185d", op: "4b5563", id: "14171c", delim: "6b7280",
  },
  dark: {
    base: "14171c", ink: "e7eaf0", faint: "8b93a1", line: "262b36",
    sel: "1e3a5f", cursor: "93c5fd",
    kw: "c4b5fd", str: "5eead4", num: "fcd34d", com: "565f6e",
    typ: "93c5fd", tag: "f9a8d4", op: "b7bfc9", id: "e7eaf0", delim: "8b93a1",
  },
};

function applyTheme(): void {
  document.documentElement.dataset["theme"] = theme;
  const c = MONACO_COLORS[theme];
  monaco.editor.defineTheme("ef-studio", {
    base: theme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      {token: "keyword", foreground: c.kw},
      {token: "string", foreground: c.str},
      {token: "number", foreground: c.num},
      {token: "comment", foreground: c.com, fontStyle: "italic"},
      {token: "type", foreground: c.typ},
      {token: "tag", foreground: c.tag},
      {token: "operator", foreground: c.op},
      {token: "delimiter", foreground: c.delim},
      {token: "identifier", foreground: c.id},
    ],
    colors: {
      "editor.background": "#" + c.base,
      "editor.foreground": "#" + c.ink,
      "editorLineNumber.foreground": "#" + c.faint,
      "editorLineNumber.activeForeground": "#" + c.ink,
      "editor.lineHighlightBackground": "#" + c.line + "55",
      "editor.selectionBackground": "#" + c.sel,
      "editorCursor.foreground": "#" + c.cursor,
      "editorIndentGuide.background1": "#" + c.line,
    },
  });
  monaco.editor.setTheme("ef-studio");
  localStorage.setItem(THEME_KEY, theme);
  renderStatusbar();
}

// --- monaco -----------------------------------------------------------------

let editor: monaco.editor.IStandaloneCodeEditor | null = null;

// The tokens provider reads precomputed line tokens; the state carries the
// line index (ef has no line-spanning constructs, so tokenization is
// stateless per line).
class EfState implements monaco.languages.IState {
  constructor(public line = 0) {}
  clone(): EfState {
    return new EfState(this.line);
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof EfState && other.line === this.line;
  }
}

function setupMonaco(): void {
  monaco.languages.register({id: "ef", extensions: [".ef"]});
  self.MonacoEnvironment = {
    getWorker: () => new Worker("./worker.js", {type: "module"}),
  };
  editor = monaco.editor.create(els.edhost, {
    value: "",
    language: "ef",
    theme: "ef-studio",
    fontSize: 13,
    lineHeight: 20,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    tabSize: 2,
    insertSpaces: true,
    renderWhitespace: "none",
    guides: {indentation: true},
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  });

  editor.onDidChangeCursorPosition((e) => {
    els.crumbPos.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => build());
}

// Tokenization is line-based and stateless (ef has no line-spanning
// constructs); the provider walks lines in model order and indexes the
// precomputed line tokens, refreshed on every edit.
let tokenLines: {start: number, len: number, scope: string}[][] = [];

function refreshTokens(): void {
  tokenLines = tokenize(editor === null ? activeFile().code : editor.getValue());
}

function installTokens(): void {
  monaco.languages.setTokensProvider("ef", {
    getInitialState: () => new EfState(0),
    tokenize(_line: string, st: monaco.languages.IState): monaco.languages.ILineTokens {
      const s = st instanceof EfState ? st : new EfState(0);
      const toks = tokenLines[s.line] ?? [];
      return {
        tokens: toks.map((t) => ({startIndex: t.start, scopes: t.scope})),
        endState: new EfState(s.line + 1),
      };
    },
  });
}

// --- output pane ------------------------------------------------------------

function outLine(s: string, cls = ""): void {
  const div = document.createElement("div");
  div.className = "out-line" + (cls === "" ? "" : " " + cls);
  div.textContent = s === "" ? " " : s;
  els.out.appendChild(div);
  els.out.scrollTop = els.out.scrollHeight;
}

function clearOutput(): void {
  els.out.replaceChildren();
}

function setTab(t: Tab): void {
  state.tab = t;
  els.tabOutput.classList.toggle("on", t === "output");
  els.tabProblems.classList.toggle("on", t === "problems");
  els.out.classList.toggle("hidden", t !== "output");
  $("#problems").classList.toggle("hidden", t !== "problems");
}

// --- pipeline card ----------------------------------------------------------

// ef's stages run inside one synchronous call (runWasmProgram / compileWithOps), so
// per-stage times are a proportional split of the real measured total
// (deterministic weights).
const PIPE_W = [0.22, 0.31, 0.47];

function renderStages(reset: boolean): void {
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

function stagesBusy(): void {
  renderStages(true);
  for (const [i, r] of [...els.stages.children].entries()) {
    r.className = "stage" + (i === 0 ? " busy" : "");
    const msEl = r.querySelector(".sms");
    if (msEl !== null) msEl.textContent = i === 0 ? "…" : "—";
  }
}

function stagesDone(totalMs: number): void {
  const total = Math.max(1, Math.round(totalMs));
  const parts = PIPE_W.map((w) => Math.max(1, Math.round(total * w)));
  parts[parts.length - 1] += total - parts.reduce((a, b) => a + b, 0);
  for (const [i, r] of [...els.stages.children].entries()) {
    r.className = "stage done";
    const msEl = r.querySelector(".sms");
    if (msEl !== null) msEl.textContent = fmtMs(Math.max(1, parts[i] ?? 1));
  }
}

function stagesError(): void {
  for (const [i, r] of [...els.stages.children].entries()) {
    r.className = "stage" + (i === 0 ? " err" : "");
    const msEl = r.querySelector(".sms");
    if (msEl !== null) msEl.textContent = i === 0 ? "×" : "—";
  }
}

function fmtMs(ms: number): string {
  return ms >= 100 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

// --- tree -------------------------------------------------------------------

function renderTree(): void {
  const codesL = codes();
  const entryIdx = entryFile(codesL);
  const tree = els.tree;
  tree.replaceChildren();

  const group = (label: string) => {
    const g = document.createElement("div");
    g.className = "tree-group";
    g.textContent = label;
    tree.appendChild(g);
  };

  group("src");
  for (const [i, f] of state.project.files.entries()) {
    const row = document.createElement("div");
    row.className = "tree-file" + (f.name === state.active ? " on" : "");
    const dot = document.createElement("span");
    dot.className = "tree-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = f.name;
    row.append(dot, name);
    if (i === entryIdx) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "entry";
      badge.title = "entry — last top-level expression lives here";
      row.appendChild(badge);
    }
    const n = document.createElement("span");
    n.className = "tree-lines";
    n.textContent = `${f.code.split("\n").length}L`;
    row.appendChild(n);
    row.addEventListener("click", () => openFile(f.name));
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

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
}

// --- rail cards -------------------------------------------------------------

function renderBuildCard(): void {
  els.statBuildTime.textContent = state.buildMs === null ? "—" : fmtMs(state.buildMs);
  els.statSize.textContent = state.wasm === null ? "—" : fmtBytes(state.wasm.bytes.length);
  els.statRunTime.textContent = state.runMs === null ? "—" : fmtMs(state.runMs);
  els.statOps.textContent = state.runOps === null || state.runOps.length === 0 ? "—" : state.runOps.join(", ");
}

function renderOutlineCard(): void {
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

// --- problems ---------------------------------------------------------------

function renderProblems(ps: Problem[]): void {
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
  const lineMap = concatLines(codes());
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
    if (p.line !== null && p.line <= lineMap.length) {
      const at = lineMap[p.line - 1];
      const fname = state.project.files[at.file].name;
      r.title = `${fname}:${at.line} — click to jump`;
      r.addEventListener("click", () => {
        if (state.active !== fname) openFile(fname);
        setTimeout(() => {
          editor?.revealLineInCenter(at.line);
          editor?.setPosition({lineNumber: at.line, column: 1});
          editor?.focus();
        }, 0);
      });
    }
    box.appendChild(r);
  }
}

function liveProblems(): void {
  const ps = problems(concatProject(codes()));
  renderProblems(ps);
  setTab(state.tab);
}

// --- actions ----------------------------------------------------------------

// Re-derive everything downstream of the source text.
function recompute(): void {
  refreshTokens();
  saveProject();
  renderTree();
  renderOutlineCard();
  liveProblems();
}

function openFile(name: string): void {
  const f = state.project.files.find((f) => f.name === name);
  if (f === undefined) return;
  state.active = name;
  editor?.setValue(f.code);
  els.crumbFile.textContent = name;
  const es = entryFile(codes());
  const isEntry = state.project.files[es]?.name === name;
  els.crumbEntry.textContent = isEntry ? "entry" : "";
  els.crumbEntry.classList.toggle("entry-badge", isEntry);
  recompute();
}

let debounce = 0;
function onEdit(): void {
  const f = activeFile();
  if (editor !== null) f.code = editor.getValue();
  refreshTokens(); // cheap — keeps highlighting exact while typing
  window.clearTimeout(debounce);
  debounce = window.setTimeout(recompute, 250);
}

function run(): void {
  onEditNow();
  clearOutput();
  setTab("output");
  stagesBusy();
  const src = concatProject(codes());
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
    state.runOps = r.ops;
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

function onEditNow(): void {
  const f = activeFile();
  if (editor !== null) f.code = editor.getValue();
  window.clearTimeout(debounce);
  recompute();
}

async function build(): Promise<void> {
  onEditNow();
  clearOutput();
  setTab("output");
  stagesBusy();
  const src = concatProject(codes());
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
    renderTree();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outLine(msg, "err");
    stagesError();
    els.buildStatus.textContent = "build failed";
  }
}

function download(name: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], {type: mime}));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadWasm(): void {
  if (state.wasm === null) return;
  download("main.wasm", state.wasm.bytes as BlobPart, "application/wasm");
}

function downloadActive(): void {
  const f = activeFile();
  download(f.name, f.code, "text/plain");
}

// --- modal ------------------------------------------------------------------

type ModalSpec = {title: string, value: string, ok: string, onOk: (v: string) => void};

let modalOnOk: ((v: string) => void) | null = null;

function openModal(spec: ModalSpec): void {
  modalOnOk = spec.onOk;
  els.modalTitle.textContent = spec.title;
  els.modalInput.value = spec.value;
  els.modalOk.textContent = spec.ok;
  els.modal.classList.remove("hidden");
  els.modalInput.focus();
  els.modalInput.select();
}

function closeModal(): void {
  els.modal.classList.add("hidden");
  modalOnOk = null;
  editor?.focus();
}

// --- palette ----------------------------------------------------------------

type Cmd = {label: string, hint: string, run: () => void};

function commands(): Cmd[] {
  const f = activeFile();
  return [
    {label: "Run", hint: "Ctrl+↩ — compile to wasm and run, streaming Out!/Println!", run: () => void run()},
    {label: "Build wasm", hint: "Ctrl+B — emit WasmGC main.wasm (binaryen shrink)", run: () => void build()},
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
        state.runOps = null;
        state.lastKind = null;
        openFile("main.ef");
      }})},
    {label: "Download main.wasm", hint: state.wasm === null ? "build first" : `${fmtBytes(state.wasm.bytes.length)}`, run: () => downloadWasm()},
    {label: `Download ${f.name}`, hint: "save the active file", run: () => downloadActive()},
    {label: "Toggle theme", hint: `currently ${theme}`, run: () => {
      theme = theme === "dark" ? "light" : "dark";
      applyTheme();
    }},
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

function openPalette(): void {
  els.palette.classList.remove("hidden");
  paletteSel = 0;
  els.paletteInput.value = "";
  renderPalette();
  els.paletteInput.focus();
}

function closePalette(): void {
  els.palette.classList.add("hidden");
  editor?.focus();
}

// --- statusbar --------------------------------------------------------------

function renderStatusbar(): void {
  els.statusLeft.textContent = `${state.project.name} · ${state.project.files.length} file${state.project.files.length === 1 ? "" : "s"}`;
  const bits = [];
  if (state.lastKind === "run" && state.runMs !== null) bits.push(`run ${fmtMs(state.runMs)}`);
  else if (state.lastKind === "build" && state.buildMs !== null) bits.push(`build ${fmtMs(state.buildMs)}`);
  if (state.wasm !== null) bits.push(`wasm ${fmtBytes(state.wasm.bytes.length)}`);
  bits.push(theme);
  els.statusRight.textContent = bits.join(" · ");
  els.chip.textContent = "Ctrl+↩ run · Ctrl+B build";
}

// --- boot -------------------------------------------------------------------

function boot(): void {
  applyTheme();
  setupMonaco();
  installTokens();
  refreshTokens();

  els.runBtn.addEventListener("click", () => run());
  els.buildBtn.addEventListener("click", () => build());
  els.themeBtn.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    applyTheme();
  });
  els.paletteBtn.addEventListener("click", () => openPalette());
  els.clearBtn.addEventListener("click", () => clearOutput());
  els.tabOutput.addEventListener("click", () => setTab("output"));
  els.tabProblems.addEventListener("click", () => setTab("problems"));

  els.modalOk.addEventListener("click", () => {
    const cb = modalOnOk;
    closeModal();
    cb?.(els.modalInput.value);
  });
  els.modalCancel.addEventListener("click", () => closeModal());
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeModal();
  });
  els.modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const cb = modalOnOk;
      closeModal();
      cb?.(els.modalInput.value);
    } else if (e.key === "Escape") {
      closeModal();
    }
  });

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

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      openPalette();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      run();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      build();
      e.preventDefault();
    } else if (e.key === "Escape") {
      closePalette();
      closeModal();
    }
  });

  editor?.onDidChangeModelContent(() => onEdit());

  openFile(state.active);
  setTab("output");
  renderStages(true);
  renderBuildCard();
  outLine("ef playground ready — Ctrl+K for commands, Ctrl+↩ to run, Ctrl+B to build wasm.", "dim");
  outLine(`project “${state.project.name}” · ${state.project.files.length} files · ef compiler running in your browser.`, "dim");
}

boot();
