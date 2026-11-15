// type_display: the rendering surface over the type system — showT (formats
// a deep-resolved type for display), showEffRow (canonical member order for
// one effect row, shared with the playground's renderers), TypeError_ (the
// located error class the checker and the unifier throw; the LSP anchors its
// diagnostics on `pos`), and showErr (line-oriented frontend rendering:
// message + source caret).
// A leaf below unify.ts: showT reads only the `Type` shape (type-only,
// erased at runtime), so unify's failure paths import showT/TypeError_ from
// here without a runtime cycle — the runtime edge runs unify →
// type_display → lexer.
import {ParseError, type Loc} from "./lexer.ts";
import type {Effs, Type} from "./unify.ts";

// 1-based source position of the innermost expression being checked when
// the error was thrown (set by infer's wrapper; undefined for whole-program
// failures with no single blame site). Display sites read it directly: the
// LSP anchors its diagnostic there; showErr prefixes it for the REPL.
export class TypeError_ extends Error {
  pos?: Loc;
}

// Format a type for display. Expects a *deep-resolved* type (see
// `Unifier.deepRes`): any variable shown is a genuinely unbound one.
// Type variables display as letters (a, b, ..., z, a1, b1, ...) in order of
// first appearance, so the same variable always prints the same letter.
// `pnames` optionally names the top-level fun's params (`x: T`); nested fun
// types stay anonymous (names exist only for the hovered signature).
// `varNames` pre-assigns variable ids to names before the first-appearance
// letters (alias tparams print under their declared names).
export function showT(t: Type, pnames?: (string | null)[], varNames?: Map<number, string>): string {
  const names = varNames ?? new Map<number, string>();
  // Unbound effect variables display as e1, e2, ... (first appearance,
  // deterministic per call), kept visually distinct from the type variables'
  // letter sequence. Type-var ids and effect-var ids come from separate
  // counters, so each gets its own map and its own counter.
  const effNames = new Map<number, string>();
  let seq = names.size;
  let effSeq = 0;
  const nextLetter = (): string => {
    const i = seq++;
    const l = String.fromCharCode(97 + (i % 26));
    return i < 26 ? l : `${l}${Math.floor(i / 26)}`;
  };
  const go = (t: Type, pns?: (string | null)[]): string => {
    switch (t.tag) {
      case "prim": return t.name === "int" ? "i64" : t.name === "float" ? "f64" : t.name;
      case "arr": return "[" + go(t.elem) + "]";
      case "tup":
        return "[" + t.fields.map(f =>
          f.name === null ? go(f.type) : f.name + ": " + go(f.type)).join(", ") + "]";
      case "any": return "any";
      case "var": {
        let n = names.get(t.id);
        if (n === undefined) {
          n = nextLetter();
          names.set(t.id, n);
        }
        return n;
      }
      case "fun": {
        const ps = t.params.map((p, i) => {
          const n = pns !== undefined && i < pns.length ? pns[i] : null;
          return (n !== null && n !== "_" ? n + ": " : "") + go(p);
        }).join(", ");
        // Rows are deep-resolved by the time showT runs (deepRes flattens
        // bound variables), so members are op names and unbound row variables.
        const effStr = (v: { id: number }): string => {
          let n = effNames.get(v.id);
          if (n === undefined) {
            n = `e${++effSeq}`;
            effNames.set(v.id, n);
          }
          return n;
        };
        const e = t.effs.ops.size > 0 || t.effs.vars.size > 0
          ? " ! { " + showEffRow(t.effs, effStr) + " }"
          : "";
        return "(" + ps + ") -> " + go(t.ret) + e;
      }
    }
  };
  return go(t, pnames);
}

// Members of one effect row in canonical display order: unbound variables
// first by their e-number (two generic rows always read `e1, e2`, whatever
// the set's insertion order), then concrete op names sorted alphabetically.
// `effStr` names one unbound variable; the numbering lives with the
// enclosing display call so the same variable prints the same number across
// a whole type.
export function showEffRow(row: Effs, effStr: (v: { id: number }) => string): string {
  const vars = [...row.vars].map(effStr);
  const ops = [...row.ops];
  vars.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  ops.sort();
  return [...vars, ...ops].join(", ");
}

// Render an error for the line-oriented frontends (REPL, CLI): ef errors
// carry a structured 1-based pos (ParseError's token start, TypeError_'s
// located expression) — when the source text is supplied the offending line
// is quoted with a caret under the error column, followed by the located
// message. The LSP reads `pos` directly and must not scrape this format back
// out.
export function showErr(err: unknown, src?: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const pos = err instanceof ParseError ? err.pos : err instanceof TypeError_ ? err.pos : undefined;
  if (pos === undefined) return msg;
  const head = `at line ${pos.line}, col ${pos.col}: ${msg}`;
  if (src === undefined) return head;
  return srcLine(src, pos) + "\n" + head;
}

// The offending source line, then a caret pointing at the column:
//   2 | y :: 2;
//     | ^
function srcLine(src: string, pos: Loc): string {
  const text = (src.split("\n").at(pos.line - 1) ?? "").replace(/\r$/, "");
  const ln = String(pos.line);
  const gut = " ".repeat(ln.length);
  return `${ln} | ${text}\n${gut} | ${" ".repeat(pos.col - 1)}^`;
}
