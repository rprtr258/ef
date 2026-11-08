// theme.ts — light/dark themes (system-following, toggle persisted): the
// monaco "ef-studio" theme is redefined for the current preference and
// applied to the document.
import * as monaco from "monaco-editor/esm/vs/editor/editor.main.js";
import {renderStatusbar} from "./statusbar.ts";
import {setTheme, theme, THEME_KEY} from "./state.ts";

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

export function applyTheme(): void {
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

export function toggleTheme(): void {
  setTheme(theme === "dark" ? "light" : "dark");
  applyTheme();
}
