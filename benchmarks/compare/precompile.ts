// Precompiled-module tool for benchmarks/compare/compare.sh.
//
//   precompile.ts build <outdir> <name=src.ef>...
//     Compile each ef source to <outdir>/<name>.wasm plus <name>.ops.json —
//     the wasm pipeline tree-shakes builtin ops, so the module's required op
//     list must be stored next to the binary for the host's effect
//     interpretation.
//   precompile.ts run <base>   (base = path without extension)
//     Execute a precompiled module on the embedded host runtime. Compiles
//     nothing, so timed runs exclude the compiler (and binaryen) entirely.
import {readFileSync, writeFileSync} from "fs";
import {compileWithOps} from "../../compiler/backend/wasm/wasm.ts";
import {runModule} from "../../compiler/backend/wasm/wasm_host.ts";
import {show} from "../../compiler/env.ts";

const argv = process.argv.slice(2);
if (argv[0] === "build") {
  const outdir = argv[1];
  for (const spec of argv.slice(2)) {
    const [name, src = name] = spec.split("=", 2);
    const {bytes, ops} = compileWithOps(readFileSync(src).toString());
    writeFileSync(`${outdir}/${name}.wasm`, bytes);
    writeFileSync(`${outdir}/${name}.ops.json`, JSON.stringify(ops));
    console.log(`${name}: ${bytes.length} bytes, ops: ${ops.join(",")}`);
  }
} else if (argv[0] === "run") {
  const base = argv[1];
  const bytes = readFileSync(base + ".wasm");
  const ops = JSON.parse(readFileSync(base + ".ops.json").toString()) as string[];
  console.log(show(runModule(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), ops)));
} else {
  console.error("usage: precompile.ts build <outdir> <name=src.ef>... | run <base>");
  process.exit(2);
}
