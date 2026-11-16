// Bridge between the browser playground and the ef compiler: parse, check,
// lint, outline, tokenize, wasm run (streaming stdout), and wasm emit.
//
// The compiler's frontend is plain TypeScript, so it runs in the browser as-is;
// the only node-flavored corners are stubbed (`src/shim.ts` + bundle-time
// stubs) and preempted by the browser effect interpreters.

import "./shim.ts";
import {type Program, type Expr, type Alias} from "../../compiler/frontend/parser.ts";
import {showEffRow, showT} from "../../compiler/frontend/type_display.ts";
import {type Effs, type Type} from "../../compiler/frontend/unify.ts";
import {rowOf} from "../../compiler/prims.ts";
import type {Checked, EffectSig} from "../../compiler/frontend/types.ts";
import {lint} from "../../compiler/frontend/lint.ts";
import {exec, newCtx} from "../../compiler/backend/interpreter/eval.ts";
import {prepare, prepareStaged, type EffectInterp} from "../../compiler/frontend/pipeline.ts";
import {num, show, type Cont, type Outcome, type Value} from "../../compiler/env.ts";
import {KEYWORDS, ONE, TWO, lex} from "../../compiler/frontend/lexer.ts";
import {collectEffectOps} from "../../compiler/frontend/analysis.ts";
import {compileWithOps} from "../../compiler/backend/wasm/wasm.ts";
import {runModule} from "../../compiler/backend/wasm/wasm_run.ts";

// --- effect interpretation ------------------------------------------------

// A clean unwind for `Exit!(n)` — thrown out of the CPS run and caught at the
// run boundary (the default interp would call process.exit, which the shim
// turns into an error; we preempt it so the code is honest).
export class ExitSignal extends Error {
  constructor(public code: number) {
    super(`Exit!(${code})`);
  }
}

// Streaming effect interpretation for the browser: Out!/Println! append to the
// output pane, Random!/Wait! work host-style, Exit! raises ExitSignal. File
// fs (Read!/Write!) is intentionally left to the builtin defaults, which throw
// "unavailable in browser" via the bundle-time stubs.
export function browserInterp(out: (s: string) => void): EffectInterp {
  return {
    Out: (args: Value[], k: Cont): Outcome => {
      const s = args[0];
      out(typeof s === "string" ? s : show(s));
      return k(null);
    },
    Println: (args: Value[], k: Cont): Outcome => {
      out(show(args[0]) + "\n");
      return k(null);
    },
    Exit: (args: Value[]): Outcome => {
      throw new ExitSignal(num(args[0]));
    },
    Wait: (args: Value[], k: Cont): Outcome => {
      const until = Date.now() + num(args[0]);
      while (Date.now() < until) {} // busy-wait, mirroring the builtin default
      return k(null);
    },
    Random: (_args: Value[], k: Cont): Outcome => k(Math.random()),
  };
}

// --- compile pipeline -----------------------------------------------------

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type Problem = {stage: "parse" | "check" | "lint", msg: string, line: number | null};

// Statically surface everything wrong with `src` without running it: parse
// errors first (they block the rest), then type errors, then lint. Only lint
// issues carry positions today — the checker's errors are bare messages.
export function problems(src: string): Problem[] {
  const staged = prepareStaged(src);
  if (!staged.ok)
    return [{stage: staged.stage, msg: errText(staged.error), line: null}];
  return lint(src).map((i) => ({
    stage: "lint" as const,
    msg: i.rule === "unused-arg"
      ? `${i.who}: unused argument ${i.argname}`
      : `${i.who}: inferred as ${i.ty} (contains \`any\`)`,
    line: i.pos?.line ?? null,
  }));
}

// Residual top-level effect row of `src` — the ops that reach the runner
// (unhandled builtin effects included, internally-handled ops excluded). The
// row `ef types` prints on its `_` result line. Throws on parse/check errors;
// callers wanting a best-effort row should catch (cross-file references make
// a single file uncheckable on its own).
export function topLevelEffs(src: string): string[] {
  return [...prepare(src).checked.unhandled];
}

export type RunResult = {value: Value, type: Type, ops: string[]};

// Check + evaluate the whole program with the browser interp. Throws on parse
// or type errors; ExitSignal unwinds `Exit!`; other runtime errors propagate.
// `ops` is a parse-time byproduct: performed/handled ops in first-appearance
// order — the same list a build reports.
export function interpret(src: string, out: (s: string) => void): RunResult {
  const {prog, checked} = prepare(src); // rejects parse/type errors before exec runs
  const r = exec(prog, newCtx(browserInterp(out)), checked);
  return {value: r.value, type: r.lastType, ops: collectEffectOps(prog)};
}

// Wasm backend emit (parse → check → CPS codegen → binaryen shrink). Reported
// ops are the performed/handled set — the same typecheck byproduct `run`
// shows — not the wasm op table (which pre-seeds every builtin op).
export async function buildWasm(src: string): Promise<{bytes: Uint8Array, ops: string[]}> {
  const pre = prepare(src); // rejects parse/type errors before compile runs
  const {bytes} = compileWithOps(pre);
  return {bytes, ops: collectEffectOps(pre.prog)};
}

// Run the program on the wasm backend: compile (parse → check → CPS codegen →
// binaryen shrink), instantiate, execute in this engine's WebAssembly.
// Unlike the CPS interpreter — which leans on JSC tail calls and overflows
// the V8 stack on deep continuation chains (e.g. naive fib) — wasm tail
// calls are O(1) stack in every WasmGC engine. Throws on parse/type errors;
// ExitSignal unwinds `Exit!`; wasm traps (index OOB) surface as plain
// Errors. One prepare serves the diagnostics (type, ops) and the compile:
// compileWithOps consumes the Prepared artifacts instead of re-parsing.
export function runWasmProgram(src: string, out: (s: string) => void): RunResult {
  const pre = prepare(src);
  const type = pre.checked.lastType;
  const {bytes, ops} = compileWithOps(pre);
  const value = runModule(bytes, ops, browserInterp(out));
  return {value, type, ops: collectEffectOps(pre.prog)};
}

// --- structure ------------------------------------------------------------

export type OutlineItem = {
  kind: "let" | "fn" | "effect" | "type",
  name: string,
  line: number | null,
  effs: string | null, // effect row of a let-bound fn, e.g. "{ Choose, Emit }"
  typ: string | null, // display type; null when the checker fails (names still shown)
};

function effRow(effs: Effs): string | null {
  if (effs.ops.size === 0 && effs.vars.size === 0) return null;
  // Rows can carry unbound effect variables (deepRes flattens bound ones);
  // they print as e1, e2, ... in first-appearance order, matching showT.
  const effNames = new Map<number, string>();
  let effSeq = 0;
  const effStr = (m: { id: number }): string => {
    let n = effNames.get(m.id);
    if (n === undefined) {
      n = `e${++effSeq}`;
      effNames.set(m.id, n);
    }
    return n;
  };
  return "{ " + showEffRow(effs, effStr) + " }";
}

// Effect signature for display: "(i64, string) -> i64". checkProgram has
// replaced unannotated params with fresh vars, so showT prints a letter.
function sigT(sig: EffectSig): string {
  return "(" + sig.params.map((t) => showT(t!)).join(", ") + ") -> " + showT(sig.ret);
}

// Alias body for display, with type parameters shown by their declared names
// (showT's first-appearance lettering would lie for `Swap :: fn(a: type, b: type): type {[b, a]}`).
function aliasT(al: Alias): string {
  const names = new Map<number, string>();
  for (const [n, v] of al.tparams) names.set(v.id, n);
  // Unbound row variables print as e1, e2, ... in first-appearance order
  // across the whole body, matching showT.
  const effNames = new Map<number, string>();
  let effSeq = 0;
  const effStr = (m: { id: number }): string => {
    let n = effNames.get(m.id);
    if (n === undefined) {
      n = `e${++effSeq}`;
      effNames.set(m.id, n);
    }
    return n;
  };
  const go = (t: Type): string => {
    switch (t.tag) {
      case "prim": return t.name;
      case "arr": return "[" + go(t.elem) + "]";
      case "tup":
        return "[" + t.fields.map((f) =>
          f.name === null ? go(f.type) : f.name + ": " + go(f.type)).join(", ") + "]";
      case "fun": {
        // Rows can carry unbound effect variables (deepRes flattens bound
        // ones) — render them like type_display does.
        const e = t.effs.ops.size > 0 || t.effs.vars.size > 0
          ? " ! { " + showEffRow(t.effs, effStr) + " }"
          : "";
        return "(" + t.params.map(go).join(", ") + ") -> " + go(t.ret) + e;
      }
      case "var": return names.get(t.id) ?? "a";
      case "any": return "any";
    }
  };
  return go(al.body);
}

// Effect/type items carry no position in the parser's Item union; find their
// declaration line in the token stream. Effects keep their keyword (keyword +
// name only ever adjoin at the declaration); aliases are keyword-free
// `name ::` — value bindings share that shape, but the name here is a
// declared alias, whose `name ::` site is its declaration.
function declLine(src: string, kw: "effect" | "type", name: string): number | null {
  const toks = lex(src);
  for (let i = 0; i < toks.length - 1; i++) {
    if (kw === "effect" && toks[i].v === "effect" && toks[i + 1].v === name) return toks[i].pos.line;
    if (kw === "type" && toks[i].v === name && toks[i + 1].v === "::") return toks[i].pos.line;
  }
  return null;
}

export function outline(src: string): OutlineItem[] {
  const staged = prepareStaged(src);
  // Parse errors propagate — the rail blanks the outline until it parses
  // again (problems shows the error). A check error still outlines: names
  // with typ null (problems shows the errors).
  if (!staged.ok) {
    if (staged.stage === "parse") throw staged.error;
    return outlineItems(src, staged.prog, null);
  }
  return outlineItems(src, staged.prog, staged.checked);
}

function outlineItems(src: string, prog: Program, checked: Checked | null): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const it of prog.items) {
    if ("e" in it) {
      const e: Expr = prog.nodes[it.e];
      if (e.t === "let") {
        const val: Expr = prog.nodes[e.val];
        items.push({
          kind: val.t === "lambda" ? "fn" : "let",
          name: e.name,
          line: prog.locs[it.e]?.start.line ?? null,
          // The written annotation (retEffs) is available pre-check; the
          // inferred row (stamps.typ.effs) once the checker has run.
          effs: val.t === "lambda" ?
            (val.retEffs !== null ? effRow(rowOf(val.retEffs)) :
              checked?.stamps[e.val]?.typ !== undefined ? effRow(checked.stamps[e.val]!.typ!.effs) : null) : null,
          typ: checked !== null ? showT(checked.env.lookupResolved(e.name)) : null,
        });
      }
    } else if ("effect" in it) {
      const sig = checked?.effects.get(it.effect);
      items.push({
        kind: "effect", name: it.effect,
        line: declLine(src, "effect", it.effect), effs: null,
        typ: sig !== undefined ? sigT(sig) : null,
      });
    } else {
      items.push({
        kind: "type", name: it.alias.name,
        line: declLine(src, "type", it.alias.name), effs: null,
        typ: aliasT(it.alias), // parse-only, needs no checker
      });
    }
  }
  return items;
}

// A file is an "entry" file when its last top-level item is a bare expression
// whose type is unit (ef's program value is the last top-level expression —
// this marks files that produce a value when run); the effects it produces
// don't matter. A file with a parse or check error simply isn't an entry —
// never throws.
export function isEntryFile(src: string): boolean {
  try {
    const {prog, checked} = prepare(src);
    const last = prog.items[prog.items.length - 1];
    if (prog.items.length === 0 || !("e" in last)) return false;
    if (prog.nodes[last.e].t === "let") return false;
    // lastType is the checker-resolved type of the last top-level expression.
    const t = checked.lastType;
    return t.tag === "prim" && t.name === "unit";
  } catch {
    return false;
  }
}

// --- tokens (Monaco highlighting) -----------------------------------------

// Monaco line-token scopes the studio theme maps. ef has no line-spanning
// constructs, so tokenization is stateless per line.
export type LineToken = {start: number, len: number, scope: string};

const OPERATOR_ONE = "=!";

export function tokenize(src: string): LineToken[][] {
  const lines = src.split("\n");
  const out: LineToken[][] = [];
  for (const line of lines) {
    const toks: LineToken[] = [];
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === " " || c === "\t") {
        i++;
        continue;
      }
      if (c === "#") {
        toks.push({start: i, len: line.length - i, scope: "comment"});
        break;
      }
      if (c === "\"") {
        let j = i + 1;
        while (j < line.length && line[j] !== "\"") {
          if (line[j] === "\\") j++;
          j++;
        }
        const len = Math.min(j + 1, line.length) - i;
        toks.push({start: i, len, scope: "string"});
        i += len;
        continue;
      }
      if (c >= "0" && c <= "9") {
        let j = i;
        while (j < line.length && ((line[j] >= "0" && line[j] <= "9") || line[j] === ".")) j++;
        toks.push({start: i, len: j - i, scope: "number"});
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
        const v = line.slice(i, j);
        // `Op!` — an identifier directly followed by `!` performs an effect.
        const performs = line[j] === "!" && line[j + 1] !== "=";
        const scope = performs ? "tag" :
          KEYWORDS.has(v) ? "keyword" :
          /^[A-Z]/.test(v) ? "type" : "identifier";
        toks.push({start: i, len: j - i, scope});
        i = j;
        continue;
      }
      const two = line.slice(i, i + 2);
      if (TWO.includes(two)) {
        toks.push({start: i, len: 2, scope: "operator"});
        i += 2;
        continue;
      }
      if (ONE.includes(c)) {
        toks.push({start: i, len: 1, scope: OPERATOR_ONE.includes(c) ? "operator" : "delimiter"});
        i++;
        continue;
      }
      i++;
    }
    out.push(toks);
  }
  return out;
}
