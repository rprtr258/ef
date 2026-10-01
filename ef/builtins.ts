// builtins: the one table describing every ef builtin.
// Adding a builtin means adding one entry here.
import {readFileSync, writeFileSync} from "node:fs";
import {sleepSync} from "bun";
import {apply} from "./eval.ts";
import {num, show, type Cont, type Outcome, type Value} from "./env.ts";
import {
  freshEff, freshVar, tArr, tFun,
  type EffectSig, type Type,
} from "./types.ts";
import {TANY, TBOOL, TFLOAT, TINT, TNULL, TSTR} from "./prims.ts";

export type Builtin =
  // A plain builtin: lifted to a runtime native as `k(fn(...args))`. `t` is its
  // checker signature — a thunk for polymorphic builtins (fresh vars per use).
  | {
    kind: "fn",
    name: string,
    t: Type | (() => Type),
    fn: (...args: Value[]) => Value,
  }
  // A builtin that calls ef closures mid-flight (map/each/flatmap): CPS native.
  | {
    kind: "native",
    name: string,
    t: Type | (() => Type),
    fn: (args: Value[], k: Cont) => Outcome,
  }
  // A builtin effect: declared to the checker via `sig`, and given a default
  // host interpretation used by `runTop` when left unhandled.
  | {
    kind: "effect",
    name: string,
    sig: EffectSig,
    interp: (args: Value[], k: Cont) => Outcome,
  }
;

// The one shared table: polymorphic `t` thunks instantiate fresh vars per use,
// so entries are immutable and safe to share across programs.
export const builtins: Builtin[] = [
    {kind: "fn", name: "not", t: tFun([TBOOL], TBOOL, new Set()), fn: a => (a === false || a === null ? true : false)},
    {kind: "fn", name: "list", t: tFun([TANY], tArr(TANY), new Set()), fn: (...xs) => xs},
    {kind: "fn", name: "head", t: () => { const a = freshVar(); return tFun([tArr(a)], a, new Set()); }, fn: xs => {
      const a = xs as Value[];
      if (a.length === 0)
        throw new Error("head of empty array");
      return a[0]!;
    }},
    {kind: "fn", name: "tail", t: () => { const a = freshVar(); return tFun([tArr(a)], tArr(a), new Set()); }, fn: xs => (xs as Value[]).slice(1)},
    {kind: "fn", name: "concat", t: () => { const a = freshVar(); return tFun([tArr(a), tArr(a)], tArr(a), new Set()); }, fn: (a, b) => (a as Value[]).concat(b as Value[])},
    {kind: "fn", name: "flat", t: () => { const a = freshVar(); return tFun([tArr(tArr(a))], tArr(a), new Set()); }, fn: xs => (xs as Value[]).flat()},
    {kind: "fn", name: "len", t: () => { const a = freshVar(); return tFun([tArr(a)], TINT, new Set()); }, fn: xs => (xs as Value[]).length},
    {kind: "fn", name: "strlen", t: tFun([TSTR], TINT, new Set()), fn: s => (s as string).length},
    {kind: "native", name: "map", t: () => {
      const a = freshVar(), b = freshVar(), e = freshEff();
      return tFun([tFun([a], b, e), tArr(a)], tArr(b), e);
    }, fn: (args, k) => {
      const f = args[0]!;
      const xs = args[1] as Value[];
      const out = new Array<Value>(xs.length);
      function go(i: number): Outcome {
        if (i >= xs.length)
          return k(out);
        return apply(f, [xs[i]!], v => { out[i] = v; return go(i + 1); });
      }
      return go(0);
    }},

    // --- builtins added for the star.ink port ---
    {kind: "fn", name: "PI", t: TFLOAT, fn: () => Math.PI},
    {kind: "fn", name: "cos", t: tFun([TFLOAT], TFLOAT, new Set()), fn: a => Math.cos(num(a))},
    {kind: "fn", name: "sin", t: tFun([TFLOAT], TFLOAT, new Set()), fn: a => Math.sin(num(a))},
    {kind: "fn", name: "abs", t: tFun([TFLOAT], TFLOAT, new Set()), fn: a => Math.abs(num(a))},
    {kind: "fn", name: "round", t: tFun([TFLOAT], TINT, new Set()), fn: a => Math.round(num(a))},
    {kind: "fn", name: "sqrt", t: tFun([TFLOAT], TFLOAT, new Set()), fn: a => Math.sqrt(num(a))},
    {kind: "fn", name: "range", t: tFun([TINT, TINT, TINT], tArr(TINT), new Set()), fn: (a, b, c) => {
      const s = num(a), e = num(b), st = num(c);
      const n = st === 0 ? 0 : Math.max(0, Math.ceil((e - s) / st));
      return Array.from({length: n}, (_, k) => s + k * st);
    }},
    {kind: "fn", name: "char", t: tFun([TINT], TSTR, new Set()), fn: a => String.fromCodePoint(num(a) | 0)},
    {kind: "fn", name: "number", t: tFun([TSTR], TFLOAT, new Set()), fn: a => parseFloat(a as string)},
    {kind: "fn", name: "args", t: tFun([], tArr(TSTR), new Set()), fn: () => process.argv.slice(2)},
    {kind: "fn", name: "get", t: () => { const a = freshVar(); return tFun([tArr(a), TINT], a, new Set()); }, fn: (xs, i) => {
      const a = xs as Value[];
      const idx = num(i);
      if (idx < 0 || idx >= a.length || !Number.isInteger(idx))
        throw new Error(`get: index ${idx} out of bounds [0, ${a.length})`);
      return a[idx]!;
    }},
    {kind: "fn", name: "set", t: () => { const a = freshVar(); return tFun([tArr(a), TINT, a], TNULL, new Set()); }, fn: (xs, i, v) => {
      (xs as Value[])[num(i)] = v;
      return null;
    }},
    {kind: "native", name: "each", t: () => {
      const a = freshVar(), b = freshVar(), e = freshEff();
      return tFun([tFun([a, TINT], b, e), tArr(a)], TNULL, e);
    }, fn: (args, k) => {
      const f = args[0]!, xs = args[1] as Value[];
      function go(i: number): Outcome {
        if (i >= xs.length)
          return k(null);
        return apply(f, [xs[i]!, i], () => go(i + 1));
      }
      return go(0);
    }},
    {kind: "native", name: "flatmap", t: () => {
      const a = freshVar(), b = freshVar(), e = freshEff();
      return tFun([tFun([a, TINT], tArr(b), e), tArr(a)], tArr(b), e);
    }, fn: (args, k) => {
      const f = args[0]!, xs = args[1] as Value[];
      const acc: Value[] = [];
      function go(i: number): Outcome {
        if (i >= xs.length)
          return k(acc);
        return apply(f, [xs[i]!, i], v => {
          acc.push(...(v as Value[]));
          return go(i + 1);
        });
      }
      return go(0);
    }},

    // Builtin effects, interpreted by the runtime when left unhandled.
    // `Read(path): string` reads a file; `Write(path, content): null` writes one.
    // `Println(v: any): null` and `Out(s: string): null` are the console effects.
    // User `effect` decls may add or override these.
    {kind: "effect", name: "Read", sig: {params: [TSTR], ret: TSTR}, interp: (args, k) => k(readFileSync(args[0] as string, "utf8"))},
    {kind: "effect", name: "Write", sig: {params: [TSTR, TSTR], ret: TNULL}, interp: (args, k) => {
      writeFileSync(args[0] as string, args[1] as string);
      return k(null);
    }},
    {kind: "effect", name: "Println", sig: {params: [TANY], ret: TNULL}, interp: (args, k) => {
      console.log(show(args[0] ?? null));
      return k(null);
    }},
    {kind: "effect", name: "Out", sig: {params: [TSTR], ret: TNULL}, interp: (args, k) => {
      process.stdout.write(args[0] as string);
      return k(null);
    }},
    // `Exit(code: int): unit` terminates the process by default (never resumes);
    // `Wait(secs: int): unit` blocks for `secs` seconds then resumes with unit.
    // Both are effects so a handler can intercept them.
    {kind: "effect", name: "Exit", sig: {params: [TINT], ret: TNULL}, interp: args => process.exit(num(args[0]))},
    {kind: "effect", name: "Wait", sig: {params: [TINT], ret: TNULL}, interp: (args, k) => {
      sleepSync(num(args[0]) * 1000);
      return k(null);
    }},
    // `Random(): float` resumes with a random number in [0, 1).
    {kind: "effect", name: "Random", sig: {params: [], ret: TFLOAT}, interp: (_args, k) => k(Math.random())},
];
