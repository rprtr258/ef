// Build once, watch sources, rebuild on change, serve dist/ with live-reload —
// `bun run dev` inside playground/. Open tabs reload themselves after each
// successful rebuild (long-poll on /__reload).
import {watch} from "node:fs";
import {build} from "./scripts/build.ts";

if (!await build()) process.exit(1);

const port = 8917;
const root = new URL("./dist", import.meta.url).pathname;

// Live-reload: the served index.html polls /__reload?v=<version>; the request
// hangs until the next successful rebuild bumps the version, then the page
// reloads itself. Failed rebuilds don't bump — tabs keep the last good build.
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
      // Injected per request (dev only — dist/index.html stays clean) and sent
      // uncached, so a reload always re-bakes the current version.
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

console.log(`ef playground → http://localhost:${port}`);

// --- watch & rebuild -------------------------------------------------------
// Bundle inputs: playground/src/**, compiler/**, plus index.html/studio.css
// copied verbatim. dist/ itself is never watched (no feedback loop).
const here = new URL(".", import.meta.url).pathname;
for (const path of [`${here}src`, `${here}../compiler`, `${here}index.html`, `${here}studio.css`])
  watch(path, {recursive: true}, () => schedule());

// Debounce bursts of fs events; never build concurrently (queued → rebuild again).
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
    if (await build()) {
      version++;
      for (const wake of waiters.splice(0)) wake();
    } else {
      console.log("rebuild failed — still serving last good dist/");
    }
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
