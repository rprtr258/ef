// Build once, then serve dist/ — `bun run dev` inside playground/.
import {build} from "./scripts/build.ts";

await build();

const port = 8917;
const root = new URL("./dist", import.meta.url).pathname;

Bun.serve({
  port,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const rel = p === "/" ? "/index.html" : p;
    const file = Bun.file(root + rel);
    if (await file.exists())
      return new Response(file);
    return new Response("not found", {status: 404});
  },
});

console.log(`ef playground → http://localhost:${port}`);
