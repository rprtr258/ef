// downloads.ts — browser download helpers (wasm artifact, active file).
import {activeFile, state} from "./state.ts";

export function download(name: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], {type: mime}));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadWasm(): void {
  if (state.wasm === null) return;
  download("main.wasm", state.wasm.bytes as BlobPart, "application/wasm");
}

export function downloadActive(): void {
  const f = activeFile();
  download(f.name, f.code, "text/plain");
}
