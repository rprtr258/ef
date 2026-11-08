// monaco-editor's bundler entry (esm/vs/editor/editor.main.js) ships no .d.ts;
// its types are the editor.api surface it re-exports.
declare module "monaco-editor/esm/vs/editor/editor.main.js" {
  export * from "monaco-editor/esm/vs/editor/editor.api";
}
