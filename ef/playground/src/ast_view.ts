// ast_view.ts — the AST tab's text: an S-expression dump of the flat node
// slice (`Program.nodes` + `ExprID` references). Parse-only — no checker
// stamps — so ill-typed files still print. Type annotations and alias/effect
// signatures render through the checker's showT.
import {Parser, type ExprID, type Program} from "../../compiler/parser.ts";
import {showT, type Type} from "../../compiler/types.ts";
import {assertNever} from "../../compiler/assert.ts";

const IND = "  ";

export function showAst(src: string): string {
  const prog = new Parser(src).parseProgram();
  const lines: string[] = [];
  for (const it of prog.items) {
    if ("e" in it) lines.push(expr(prog, it.e, 0));
    else if ("effect" in it) {
      const ps = it.sig.params.map((p, i) => {
        const n = it.sig.names?.[i];
        return (n !== undefined ? n + ": " : "") + (p !== null ? showT(p) : "_");
      }).join(", ");
      lines.push(`(effect ${it.effect} (${ps}) : ${showT(it.sig.ret)})`);
    } else {
      const tps = [...it.alias.tparams.keys()];
      lines.push(`(alias ${it.alias.name}${tps.length > 0 ? "(" + tps.join(", ") + ")" : ""} = ${showT(it.alias.body)})`);
    }
  }
  return lines.join("\n");
}

// Operator line, children indented one level each on their own line —
// uniform for every compound node, so the tree shape is unambiguous.
function expr(prog: Program, id: ExprID, ind: number): string {
  const e = prog.nodes[id];
  const pad = IND.repeat(ind);
  const kid = (k: ExprID, extra = 1) => expr(prog, k, ind + extra);
  const kids = (ks: ExprID[], extra = 1) => ks.map(k => kid(k, extra)).join("\n");
  const ty = (t: Type | null) => t !== null ? ": " + showT(t) : "";
  switch (e.t) {
    case "num": return pad + `(num ${e.raw ?? String(e.v)})`;
    case "str": return pad + `(str ${JSON.stringify(e.v)})`;
    case "bool": return pad + `(bool ${e.v})`;
    case "unit": return pad + "(unit)";
    case "sym": return pad + `(sym ${e.v})`;
    case "lambda": {
      const ps = e.params.map(p => `${p.name}${ty(p.typ)}`).join(", ");
      const ret = e.retTyp !== null
        ? ` : ${showT(e.retTyp)}${e.retEffs !== null && e.retEffs.size > 0 ? " ! { " + [...e.retEffs].join(", ") + " }" : ""}`
        : "";
      return pad + `(lambda (${ps})${ret}\n${kid(e.body)}\n${pad})`;
    }
    case "let": return pad + `(let ${e.name}${ty(e.typ)} ${e.mut ? ":=" : "::"}\n${kid(e.val)}\n${pad})`;
    case "dlet": return pad + `(dlet [${e.fields.map(f => f.name + ty(f.typ)).join(", ")}] ${e.mut ? ":=" : "::"}\n${kid(e.val)}\n${pad})`;
    case "assign": return pad + `(assign ${e.name}\n${kid(e.val)}\n${pad})`;
    case "if": return pad + `(if\n${kids([e.c, e.a, e.b])}\n${pad})`;
    case "while": return pad + `(while\n${kids([e.c, e.body])}\n${pad})`;
    case "block": return pad + (e.stmts.length === 0 ? "(block)" : `(block\n${kids(e.stmts)}\n${pad})`);
    case "perform": return pad + (e.args.length === 0 ? `(perform ${e.op})` : `(perform ${e.op}\n${kids(e.args)}\n${pad})`);
    case "handle": {
      const cases = e.cases.map(c =>
        `${IND.repeat(ind + 1)}(case ${c.op} (${c.params.map(p => `${p.name}${ty(p.typ)}`).join(", ")}) resume ${c.resume}\n${kid(c.body, 2)}\n${IND.repeat(ind + 1)})`);
      return pad + `(handle\n${kid(e.body)}\n${cases.join("\n")}\n${pad})`;
    }
    case "app": return pad + `(app\n${kids([e.fn, ...e.args])}\n${pad})`;
    case "as": return pad + `(@as ${showT(e.typ)}\n${kid(e.e)}\n${pad})`;
    case "arr": return pad + (e.elems.length === 0 ? "(arr)" : `(arr\n${kids(e.elems)}\n${pad})`);
    case "field": return pad + `(field ${e.name}\n${kid(e.obj)}\n${pad})`;
    default: return assertNever(e);
  }
}
