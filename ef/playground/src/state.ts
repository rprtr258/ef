// state.ts — the app's shared core: mutable state, the DOM registry (els),
// and persisted preferences (project in localStorage, light/dark theme).
import {type Project, DEFAULT_PROJECT, File} from "./project.ts";

const LS_KEY = "ef.playground.project.v1";
export const THEME_KEY = "ef.playground.theme";

export type Tab = "output" | "problems";
export type Theme = "light" | "dark";

export type State = {
  project: Project,
  active: string,
  tab: Tab,
  wasm: {bytes: Uint8Array} | null,
  buildMs: number | null, // last successful build's time (BUILD stats)
  runMs: number | null, // last successful run's time (RUN stats)
  lastKind: "run" | "build" | null, // last successful action, drives the statusbar
};

export const $ = (s: string) => document.querySelector(s) as HTMLElement;

export const els = {
  paletteBtn: $("#palette-btn"),
  runBtn: $("#run-btn") as HTMLButtonElement,
  buildBtn: $("#build-btn") as HTMLButtonElement,
  themeBtn: $("#theme-btn"),
  main: $("#main"),
  tree: $("#tree"),
  center: $("#center"),
  splitTree: $("#split-tree"),
  crumbFile: $("#crumb-file"),
  crumbEntry: $("#crumb-entry"),
  crumbPos: $("#crumb-pos"),
  chip: $("#chip"),
  edhost: $("#edhost"),
  splitPanel: $("#split-panel"),
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
  splitRail: $("#split-rail"),
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
export const state: State = {
  project: bootProject,
  active: bootProject.files[bootProject.files.length - 1].name,
  tab: "output",
  wasm: null,
  buildMs: null,
  runMs: null,
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

export function saveProject(): void {
  localStorage.setItem(LS_KEY, JSON.stringify(state.project));
}

export function activeFile(): File {
  const f = state.project.files.find(f => f.name === state.active);
  return f ?? state.project.files[0];
}

const mq = window.matchMedia("(prefers-color-scheme: dark)");
function themePref(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : (mq.matches ? "dark" : "light");
}
export let theme = themePref();
export function setTheme(t: Theme): void {
  theme = t;
}
