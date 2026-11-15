// Bundles the ef VS Code extension into dist/: the client (src/extension.ts)
// and the language server (../compiler/lsp.ts — the same entry `ef lsp`
// serves). esbuild JS API so the bun test suite can rebuild the server
// on demand before spawning it.
import {build, BuildOptions} from "esbuild";

const here = import.meta.dir;

// CommonJS: VS Code's extension host loads `main` as CJS; the server bundle
// is spawned as a plain node script. `vscode` stays external for the client
// (provided by the extension host at runtime).
const common: BuildOptions = {bundle: true, platform: "node", format: "cjs", target: "node18", sourcemap: false, logLevel: "warning"} as const;

export async function buildServer(): Promise<void> {
  await build({
    ...common,
    entryPoints: [`${here}/server.ts`],
    outfile: `${here}/../dist/server.cjs`,
  });
}

export async function buildClient(): Promise<void> {
  await build({
    ...common,
    entryPoints: [`${here}/../src/extension.ts`],
    outfile: `${here}/../dist/extension.cjs`,
    external: ["vscode"],
  });
}

export async function buildAll(): Promise<void> {
  await buildServer();
  await buildClient();
}

if (import.meta.main) await buildAll();
