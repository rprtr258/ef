// ef CLI. `ef run <file>` typechecks then evaluates a source file.
// `ef runwasm <file>` compiles the file to WebAssembly and runs it on the
// embedded host runtime (same observable output as `ef run`); `ef runwasm
// <file>.wasm` executes a prebuilt module instead — no compile, no
// binaryen. The module carries its effect op table in an `ef_ops` custom
// section (see wasm_run.ts), so a prebuilt binary is self-contained.
// `ef wasm <file> [out]` compiles the file to a binary .wasm module and
// writes it to `out` (default: the input path with `.ef` replaced by
// `.wasm`).
// `ef types <file>` prints every top-level symbol and its inferred type,
// then the whole program's result type with its residual effect row (the
// ops that reach the top level — unhandled builtin effects included,
// internally-handled ops excluded).
// `ef repl` starts an interactive REPL with persistent bindings.
// `ef lint <file>` runs the lint passes over a source file.
// `ef lsp` starts the language server (stdio; also serves ipc when spawned by
// the VS Code client).
import {readFileSync, writeFileSync} from "fs";
import {styleText} from "util";
import {run} from "./backend/interpreter/eval.ts";
import {prepare, requireUnitEntry} from "./frontend/pipeline.ts";
import {showErr, showT} from "./frontend/type_display.ts";
import {type Type} from "./frontend/unify.ts";
import {lint} from "./frontend/lint.ts";
import {repl} from "./repl.ts";
import {startLsp} from "./lsp.ts";
import {type ExprID} from "./frontend/parser.ts";

// types: typecheck a source file; return every top-level symbol (let) with
// its inferred type, plus the whole program's result type and its residual
// top-level effect row (Checked.unhandled — the ops that reach the runner).
function types(src: string): {syms: {name: string, type: Type}[], result: Type, effs: Set<string>} {
  const {prog, checked} = prepare(src);
  const names: string[] = [];
  for (const it of prog.items.filter((it): it is {e: ExprID} => "e" in it)) {
    const e = prog.nodes[it.e];
    if (e.t === "let")
      names.push(e.name);
  }
  return {
    syms: names.map(n => ({name: n, type: checked.env.lookupResolved(n)})),
    result: checked.lastType,
    effs: checked.unhandled,
  };
}

async function main(cmd: string, args: string[]) {
  switch (cmd) {
  case "repl":
    repl();
    return;
  case "lsp":
    startLsp();
    return;
  case "run": {
    if (args.length === 0) {
      break;
    }

    const src = readFileSync(args[0]).toString();
    // Program args: everything after the source path — the `args` builtin's
    // view of the command line. No result echo: run's entrypoint gate makes
    // the program's value unit.
    run(src, undefined, args.slice(1));
    return;
  }
  case "runwasm": {
    if (args.length === 0) {
      break;
    }
    // Prebuilt module: execute directly — no compile, no binaryen
    // (wasm_run.ts, not wasm_host.ts). The op table comes from the module's
    // own ef_ops custom section; the wasm pipeline tree-shakes builtin ops,
    // so a bare module is not enough for the host's effect interpretation.
    if (args[0].endsWith(".wasm")) {
      const wasmPath = args[0];
      const {runModule, readEmbeddedOps} = await import("./backend/wasm/wasm_run.ts");
      const buf = readFileSync(wasmPath);
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const ops = readEmbeddedOps(bytes);
      if (ops === null) {
        throw new Error(`${wasmPath}: no embedded ops table (ef_ops custom section) — rebuild with ef wasm`);
      }
      runModule(bytes, ops, undefined, args.slice(1));
      return;
    }
    const src = readFileSync(args[0]).toString();
    // Dynamic import: runwasm compiles, so it pays binaryen; the other
    // subcommands must never load it (wasm_host.ts → wasm.ts).
    const {runWasm} = await import("./backend/wasm/wasm_host.ts");
    runWasm(src, undefined, args.slice(1));
    return;
  }
  case "wasm": {
    if (args.length === 0) {
      break;
    }
    const src = readFileSync(args[0]).toString();
    const out = args[1] ?? ((args[0].endsWith(".ef") ? args[0].slice(0, -3) : args[0]) + ".wasm");
    // The entrypoint gate (pipeline.ts's requireUnitEntry): the emitted
    // module is a file entrypoint, so its last expression must be
    // unit-typed — the run/runwasm twins enforce the same rule.
    const pre = prepare(src);
    requireUnitEntry(pre.prog, pre.checked);
    // Dynamic import: wasm is the only compile-only subcommand; the
    // binaryen engine must not initialize for run/types/lint/repl/lsp.
    const {compile} = await import("./backend/wasm/wasm.ts");
    const bytes = compile(pre);
    writeFileSync(out, bytes);
    console.log(`wrote ${out} (${bytes.length} bytes)`);
    return;
  }
  case "types": {
    if (args.length === 0) {
      break;
    }
    const src = readFileSync(args[0]).toString();
    const {syms, result, effs} = types(src);
    const lines = syms.map(({name, type}) => styleText("gray", name) + " : " + showT(type));
    // The whole program's result type, with the residual top-level effect
    // row rendered in showT's `! { ... }` style. `_` is the placeholder
    // label — a name no top-level let can shadow it with, so the line can't
    // be mistaken for a symbol binding.
    const row = effs.size > 0 ? " ! { " + [...effs].join(", ") + " }" : "";
    lines.push(styleText("gray", "_") + " : " + showT(result) + row);
    console.log(lines.join("\n"));
    return;
  }
  case "lint": {
    if (args.length === 0) {
      break;
    }
    const src = readFileSync(args[0]).toString();
    const issues = lint(src);
    if (issues.length === 0) {
      console.log("no issues");
      return;
    }
    for (const i of issues) {
      const loc = i.pos !== undefined ? `${args[0]}:${i.pos.line}:${i.pos.col}: ` : "";
      const msg = i.rule === "unused-arg"
        ? `${i.who} has unused argument ${styleText("red", i.argname)}`
        : `${i.who} is inferred as ${styleText("red", i.ty)} (contains \`any\`); add an explicit annotation to silence`;
      console.log(`${loc}${styleText("yellow", i.rule)}: ${msg}`);
    }
    process.exit(1);
  }
  }
  console.error(`Usage: ef <command> [args]

Commands:
  run <file> [args...]     typecheck and evaluate a source file
  wasm <file> [out]        compile to a .wasm module (default out: <file>.wasm)
  runwasm <file.ef|.wasm>  compile and run, or execute a prebuilt module
  types <file>             print top-level symbols, result type, residual effects
  lint <file>              run the lint passes over a source file
  repl                     interactive REPL with persistent bindings
  lsp                      start the language server (stdio)`);
  process.exit(2);
}

const [, , cmd, ...rest] = process.argv;
// One-line errors on stderr with exit 1 (what the uncaught default printed,
// minus the stack), quoting the offending source line when the file is
// readable — checker/parse errors arrive located.
try { await main(cmd, rest); }
catch (e) {
  let src: string | undefined;
  const file = rest.at(0);
  try { if (file !== undefined) src = readFileSync(file).toString(); } catch { /* nothing to quote */ }
  console.error(showErr(e, src));
  process.exit(1);
}
