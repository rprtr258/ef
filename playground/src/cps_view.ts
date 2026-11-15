// cps_view.ts — the CPS tab's text: the checked AST converted to the shared
// CPS IR (cps_ir.ts — the term eval.ts interprets and the wasm backend
// defunctionalizes). One line per node; letk/handle/if nest their sub-terms
// on the following lines, everything else flows into `rest` at the same
// indentation. `fn $n` bodies are the lambdas' conversions (mkfn binds them).
import {prepare} from "../../compiler/frontend/pipeline.ts";
import {toCps} from "../../compiler/frontend/cps.ts";
import type {CAtom, CPrim, CTerm, CIr} from "../../compiler/frontend/cps_ir.ts";
import {show} from "../../compiler/env.ts";
import {assertNever} from "../../compiler/assert.ts";

const IND = "  ";

export function showCps(src: string): string {
  const {prog, checked} = prepare(src);
  return showIr(toCps(prog, checked.stamps));
}

function showIr(ir: CIr): string {
  const out: string[] = [];
  for (const [i, f] of ir.funcs.entries()) {
    out.push(`fn $${i} ${fnHead(f.capts, f.params)}${f.direct === true ? " [direct]" : ""}`);
    term(f.body, 1, out);
    out.push("");
  }
  out.push("top:");
  term(ir.term, 1, out);
  return out.join("\n").replace(/\n+$/, "");
}

// `(captures) (params)` — the captures group renders only when non-empty,
// and the params group is always last, so a lone group is the declared
// params (a capture-only function shows as `(x) ()`).
function fnHead(capts: string[], params: string[]): string {
  const cs = capts.length > 0 ? `(${capts.join(", ")}) ` : "";
  return `${cs}(${params.join(", ")})`;
}

function atom(a: CAtom): string {
  switch (a.t) {
    case "lit": return a.raw !== undefined ? a.raw : show(a.v);
    case "var": return a.name;
    default: return assertNever(a);
  }
}

function prim(p: CPrim): string {
  switch (p.t) {
    case "op": return `(${p.op} ${p.args.map(atom).join(" ")})`;
    case "arr": return `(${p.kind === "tup" ? "tup" : "arr"} ${p.args.map(atom).join(" ")})`;
    case "as": return `(@as ${atom(p.arg)})`;
    case "field": return `(field ${atom(p.obj)}.${p.name})`;
    default: return assertNever(p);
  }
}

function term(t: CTerm, ind: number, out: string[]): void {
  const pad = IND.repeat(ind);
  const args = (as: CAtom[]) => as.map(atom).join(", ");
  switch (t.t) {
    case "letk":
      out.push(`${pad}letk ${t.name} (${t.param}):`);
      term(t.body, ind + 1, out);
      term(t.rest, ind, out);
      return;
    case "let":
      out.push(`${pad}let ${t.name} = ${prim(t.rhs)}`);
      term(t.rest, ind, out);
      return;
    case "bind":
      out.push(`${pad}bind ${t.name} = ${atom(t.val)}`);
      term(t.rest, ind, out);
      return;
    case "mkfn":
      out.push(`${pad}mkfn ${t.name} = fn $${t.fun} ${fnHead(t.capts, t.params)}`);
      term(t.rest, ind, out);
      return;
    case "call":
      out.push(`${pad}call ${atom(t.fn)}(${args(t.args)}) -> ${atom(t.k)}`);
      return;
    case "dcall":
      out.push(`${pad}dcall ${atom(t.fn)}(${args(t.args)}) -> ${t.name}`);
      term(t.rest, ind, out);
      return;
    case "perform":
      out.push(`${pad}perform ${t.op}(${args(t.args)}) -> ${atom(t.k)}`);
      return;
    case "handle": {
      out.push(`${pad}handle -> ${t.ret} (exit ${t.exit}, k ${atom(t.k)}):`);
      for (const c of t.cases) {
        out.push(`${pad}${IND}case ${c.op} (${c.params.join(", ")}) resume ${c.resume}:`);
        term(c.body, ind + 2, out);
      }
      term(t.body, ind + 1, out);
      return;
    }
    case "if":
      out.push(`${pad}if ${atom(t.c)}:`);
      term(t.a, ind + 1, out);
      out.push(`${pad}else:`);
      term(t.b, ind + 1, out);
      return;
    case "scope":
      out.push(`${pad}scope:`);
      term(t.rest, ind + 1, out);
      return;
    case "dlet":
      out.push(`${pad}dlet [${t.fields.join(", ")}] = ${atom(t.val)}`);
      term(t.rest, ind, out);
      return;
    case "assign":
      out.push(`${pad}${t.name} := ${atom(t.val)}`);
      term(t.rest, ind, out);
      return;
    case "jump":
      out.push(`${pad}jump ${atom(t.k)}(${atom(t.arg)})`);
      return;
    case "dret":
      out.push(`${pad}dret ${atom(t.v)}`);
      return;
    case "halt":
      out.push(`${pad}halt ${atom(t.v)}`);
      return;
    default: return assertNever(t);
  }
}
