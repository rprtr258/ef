// Builds the playground into dist/: the studio app (monaco + the ef compiler
// bundled for the browser) and the monaco editor worker. node-only corners of
// the compiler (node:fs, `bun`) are replaced with inert stubs — their functions
// are reachable only through unhandled-effect default paths the playground
// preempts (see src/shim.ts + src/bridge.ts).
import {copyFileSync, mkdirSync} from "node:fs";
import {join} from "node:path";
const here = (p: string) => join(import.meta.dir, p);
const dist = here("../dist");

const STUBS: Record<string, string> = {
  "node:fs": [
    "export function readFileSync(): string {",
    "  throw new Error(\"Read!/Write! (file fs) is not available in the browser playground\");",
    "}",
    "export function writeFileSync(): void {",
    "  throw new Error(\"Read!/Write! (file fs) is not available in the browser playground\");",
    "}",
  ].join("\n"),
  "bun": [
    "export function sleepSync(): void {",
    "  throw new Error(\"Wait! fell through to the node shim — interpreted by the playground instead\");",
    "}",
  ].join("\n"),
};

const stubPlugin: Bun.BunPlugin = {
  name: "browser-stubs",
  setup(build) {
    build.onResolve({filter: /^(node:fs|bun)$/}, (args) => ({path: args.path, namespace: "stub"}));
    build.onLoad({filter: /.*/, namespace: "stub"}, (args) => ({
      contents: STUBS[args.path] ?? "",
      loader: "ts",
    }));
  },
};

export async function build(): Promise<boolean> {
  mkdirSync(dist, {recursive: true});

const result = await Bun.build({
  entrypoints: [here("../src/main.ts"), here("../src/worker.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: false,
  sourcemap: "external",
  plugins: [stubPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  return false;
}

copyFileSync(here("../index.html"), join(dist, "index.html"));
copyFileSync(here("../studio.css"), join(dist, "studio.css"));

// Bun emits CSS bundles (monaco's imports) as dist/*.css; index.html must link
// the entry one or the editor renders without its stylesheet (unclipped,
// overlapping the shell). Shared-chunk css (chunk-*) duplicates the entry css
// and loads with its lazy chunk, so only entry-level css is checked.
const html = await Bun.file(join(dist, "index.html")).text();
for (const f of await Array.fromAsync(new Bun.Glob("*.css").scan({cwd: dist})))
  if (!f.startsWith("chunk-") && !html.includes(f))
    console.warn(`WARNING: ${f} emitted but not referenced by index.html`);

console.log(`built playground → ${dist} (${result.outputs.length} files)`);
return true;
}

if (import.meta.main) {
  if (!await build()) process.exit(1);
}
