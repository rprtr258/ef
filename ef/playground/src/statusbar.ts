// statusbar.ts — the bottom statusbar: project summary, last run/build
// timing, wasm size, current theme.
import {fmtBytes, fmtMs} from "./format.ts";
import {els, state, theme} from "./state.ts";

export function renderStatusbar(): void {
  els.statusLeft.textContent = `${state.project.name} · ${state.project.files.length} file${state.project.files.length === 1 ? "" : "s"}`;
  const bits = [];
  if (state.lastKind === "run" && state.runMs !== null) bits.push(`run ${fmtMs(state.runMs)}`);
  else if (state.lastKind === "build" && state.buildMs !== null) bits.push(`build ${fmtMs(state.buildMs)}`);
  if (state.wasm !== null) bits.push(`wasm ${fmtBytes(state.wasm.bytes.length)}`);
  bits.push(theme);
  els.statusRight.textContent = bits.join(" · ");
  els.chip.textContent = "Ctrl+↩ run · Ctrl+B build";
}
