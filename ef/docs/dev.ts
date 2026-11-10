// docs/dev.ts — build once, watch sources, rebuild on change, serve dist/ with
// live-reload. Same protocol as the playground's dev server (`bun run dev`
// inside docs/): open tabs long-poll /__reload and reload themselves after
// each successful rebuild.
import {watch} from "node:fs";
import {build} from "./build.ts";

await build();

const port = 8918;
const root = new URL("./dist", import.meta.url).pathname;

let version = 0;
const waiters: Array<() => void> = [];

const reloadScript = (v: number) => `<script>(async v => {
  for (;;) {
    try { await fetch("/__reload?v=" + v); location.reload(); return; }
    catch { await new Promise(r => setTimeout(r, 1e3)); }
  }
})(${v})</script>`;

Bun.serve({
  port,
  idleTimeout: 0, // long-polls on /__reload may wait indefinitely
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/__reload") {
      const v = Number(new URL(req.url).searchParams.get("v"));
      if (v < version) return new Response(String(version));
      await new Promise<void>((wake) => waiters.push(wake));
      return new Response(String(version));
    }
    const rel = p === "/" ? "/index.html" : p;
    if (rel === "/index.html") {
      const html = await Bun.file(root + rel).text();
      return new Response(html.replace("</body>", `${reloadScript(version)}</body>`), {
        headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"},
      });
    }
    const file = Bun.file(root + rel);
    if (await file.exists())
      return new Response(file);
    return new Response("not found", {status: 404});
  },
});

console.log(`ef docs → http://localhost:${port}`);

// --- watch & rebuild --------------------------------------------------------
// content/**, site.css, and the playground stylesheet the tokens are lifted
// from — a palette change in the playground must reach the docs on rebuild.
const here = new URL(".", import.meta.url).pathname;
for (const path of [`${here}content`, `${here}site.css`, `${here}../playground/studio.css`])
  watch(path, {recursive: true}, () => schedule());

let timer: ReturnType<typeof setTimeout> | undefined;
let building = false;
let queued = false;

function schedule() {
  if (building) {
    queued = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(rebuild, 100);
}

async function rebuild() {
  building = true;
  try {
    await build();
    version++;
    for (const wake of waiters.splice(0)) wake();
  } catch (e) {
    console.error("rebuild failed — still serving last good dist/:", e);
  } finally {
    building = false;
  }
  if (queued) {
    queued = false;
    schedule();
  }
}
