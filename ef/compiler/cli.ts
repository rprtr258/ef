// ef CLI. `ef run <file>` typechecks then evaluates a source file.
// `ef runwasm <file>` compiles the file to WebAssembly and runs it on the
// embedded host runtime (same observable output as `ef run`).
// `ef buildwasm <file> [out]` compiles the file to a binary .wasm module and
// writes it to `out` (default: the input path with `.ef` replaced by `.wasm`).
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
import {run} from "./eval.ts";
import {compile} from "./wasm.ts";
import {runWasm} from "./wasm_host.ts";
import {type Type, showT, showErr, checkProgram} from "./types.ts";
import {lint} from "./lint.ts";
import {repl} from "./repl.ts";
import {startLsp} from "./lsp.ts";
import {show} from "./env.ts";
import {Parser, type ExprID} from "./parser.ts";

// types: typecheck a source file; return every top-level symbol (let) with
// its inferred type, plus the whole program's result type and its residual
// top-level effect row (Checked.unhandled — the ops that reach the runner).
function types(src: string): {syms: {name: string, type: Type}[], result: Type, effs: Set<string>} {
  const prog = new Parser(src).parseProgram();
  const checked = checkProgram(prog);
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

function main(cmd: string, args: string[]) {
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
    const result = run(src);
    console.log(show(result));
    return;
  }
  case "runwasm": {
    if (args.length === 0) {
      break;
    }
    const src = readFileSync(args[0]).toString();
    const result = runWasm(src);
    console.log(show(result));
    return;
  }
  case "buildwasm": {
    if (args.length === 0) {
      break;
    }
    const src = readFileSync(args[0]).toString();
    const out = args[1] ??
      (args[0].endsWith(".ef") ? args[0].slice(0, -3) + ".wasm" : args[0] + ".wasm");
    const bytes = compile(src);
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
      console.log(`${loc}${styleText("yellow", i.rule)}: ${i.who} has unused argument ${styleText("red", i.argname)}`);
    }
    process.exit(1);
  }
  }
  console.error("Usage: ef run <file> [args...] | ef buildwasm <file> [out] | ef runwasm <file> | ef types <file> | ef lint <file> | ef repl | ef lsp");
  process.exit(2);
}

const [, , cmd, ...rest] = process.argv;
// One-line errors on stderr with exit 1 (what the uncaught default printed,
// minus the stack), quoting the offending source line when the file is
// readable — checker/parse errors arrive located.
try { main(cmd, rest); }
catch (e) {
  let src: string | undefined;
  const file = rest.at(0);
  try { if (file !== undefined) src = readFileSync(file).toString(); } catch { /* nothing to quote */ }
  console.error(showErr(e, src));
  process.exit(1);
}
