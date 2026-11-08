// CI gate: every bare package import reachable from the runtime entry points
// (ENTRIES) must be declared in package.json "dependencies". devDependencies are
// for the dev toolchain only (eslint config, typings, tests). Static walk over
// literal import specifiers — the only kind this repo uses (no computed dynamic
// imports); node:/bun: builtins are skipped, dynamic import() counts too.
import {builtinModules} from "node:module";
import {existsSync, statSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import pkgJson from "../package.json";

const ENTRIES = ["cli.ts"]; // runtime entry points; extend when a new one is added

type PkgJson = {
  dependencies?: Record<string, string>,
  devDependencies?: Record<string, string>,
};
const pkg: PkgJson = pkgJson;
const deps = new Set(Object.keys(pkg.dependencies ?? {}));
const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
const builtins = new Set([...builtinModules, "bun"]);

const transpiler = new Bun.Transpiler({loader: "ts"});

function pkgName(spec: string): string {
  return spec.startsWith("@") ?
    spec.split("/").slice(0, 2).join("/") :
    spec.split("/")[0];
}

function resolveRel(fromAbs: string, spec: string): string {
  const base = resolve(dirname(fromAbs), spec);
  if (existsSync(base) && statSync(base).isFile())
    return base;
  const candidates = [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find(existsSync) ?? base;
}

const bare = new Map<string, string>(); // package name -> first runtime importer
const visited = new Set<string>();
async function walk(abs: string, from: string): Promise<void> {
  if (visited.has(abs))
    return;
  visited.add(abs);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`unresolved import "${abs}" (from ${relative(process.cwd(), from)})`);
  }
  for (const {path: spec} of transpiler.scanImports(await Bun.file(abs).text())) {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      await walk(resolveRel(abs, spec), abs);
    } else if (!spec.startsWith("node:") && !builtins.has(spec)) {
      const name = pkgName(spec);
      if (!bare.has(name))
        bare.set(name, abs);
    }
  }
}

for (const entry of ENTRIES)
  await walk(resolve(import.meta.dir, "..", entry), process.cwd()); // ENTRIES are relative to the package root (script lives in scripts/)

const problems = [...bare.entries()].filter(([name]) => !deps.has(name));
if (problems.length > 0) {
  const p = problems
    .map(([name, from]) => `${name}: imported at runtime by ${relative(process.cwd(), from)} but ${devDeps.has(name) ? `declared as devDependency (move to "dependencies")` : `not declared in package.json`}`)
    .sort()
    .map(p => `  - ${p}`)
    .join("\n");
  console.error(`runtime dependency check failed:\n${p}`);
  process.exit(1);
}
