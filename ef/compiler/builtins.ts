// builtins: the runtime half of the builtin table — impls for the
// declarative rows in builtin_table.ts (plain closures, CPS natives, effect
// interps). Adding a builtin means one entry there plus one impl row here.
import {readFileSync, writeFileSync} from "node:fs";
import {sleepSync} from "bun";
import {apply} from "./eval.ts";
import {BUILTIN_TABLE} from "./builtin_table.ts";
import {num, show, asSlice, mkSlice, sliceElems, type Cont, type Outcome, type Value} from "./env.ts";
import {type Unifier, type EffectSig, type Type} from "./types.ts";

export type Builtin =
  // A plain builtin: lifted to a runtime native as `k(fn(...args))`. `t` is its
  // checker signature — a thunk for polymorphic builtins (fresh vars per use).
  | {
    kind: "fn",
    name: string,
    t: Type | ((u: Unifier) => Type),
    pnames?: string[], // display-only param names — LSP hover text
    fn: (...args: Value[]) => Value,
  }
  // A builtin value: bound in the runtime env as the value itself (`fn()`),
  // not as a native fn. `t` is its non-function checker type.
  | {
    kind: "value",
    name: string,
    t: Type | ((u: Unifier) => Type),
    fn: Value,
  }
  // A builtin that calls ef closures mid-flight (map/each/flatmap): CPS native.
  | {
    kind: "native",
    name: string,
    t: Type | ((u: Unifier) => Type),
    pnames?: string[], // display-only param names — LSP hover text
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

// Impls keyed by builtin name, one row per table entry (analysis.test.ts's
// IMPL_KEYS audit pins the name sets together per kind). Plain fns lift to
// runtime natives as `k(fn(...args))`; values bind as the value itself;
// natives and effect interps are CPS functions.
const FN_IMPLS: Record<string, (...args: Value[]) => Value> = {
  not: a => (a === false || a === null ? true : false),
  sub: (xs, fv, tv) => {
    // Zero-copy view of [from, to): shares the backing, offset shifts.
    const s = asSlice(xs);
    const from = num(fv), to = num(tv);
    if (from < 0 || to < from || to > s.len)
      throw new Error(`sub: range [${from}, ${to}) out of bounds [0, ${s.len})`);
    return mkSlice(s.data, s.off + from, to - from);
  },
  concat: (a, b) =>
    // Append: always a fresh backing — the only way a slice grows, and it
    // never aliases its operands.
    mkSlice([...sliceElems(asSlice(a)), ...sliceElems(asSlice(b))]),
  flat: xs => {
    const out: Value[] = [];
    for (const inner of sliceElems(asSlice(xs))) {
      // Scalar passthrough (JS flat parity — a resumed scalar can flow
      // back through a map-like land path); slices contribute their window.
      if (inner !== null && typeof inner === "object" && inner.tag === "slice")
        out.push(...sliceElems(inner));
      else out.push(inner);
    }
    return mkSlice(out);
  },
  len: xs => asSlice(xs).len,
  strlen: s => (s as string).length,
  cos: a => Math.cos(num(a)),
  sin: a => Math.sin(num(a)),
  abs: a => Math.abs(num(a)),
  round: a => Math.round(num(a)),
  sqrt: a => Math.sqrt(num(a)),
  range: (a, b, c) => {
    const s = num(a), e = num(b), st = num(c);
    const n = st === 0 ? 0 : Math.max(0, Math.ceil((e - s) / st));
    return mkSlice(Array.from({length: n}, (_, k) => s + k * st));
  },
  char: a => String.fromCodePoint(num(a) | 0),
  number: a => parseFloat(a as string),
  args: () => mkSlice(process.argv.slice(2)),
  get: (xs, i) => {
    const s = asSlice(xs);
    const idx = num(i);
    if (idx < 0 || idx >= s.len || !Number.isInteger(idx))
      throw new Error(`get: index ${idx} out of bounds [0, ${s.len})`);
    return s.data[s.off + idx]!;
  },
  set: (xs, i, v) => {
    // Strictly in-window write through the view into the shared backing —
    // growth is concat's job only.
    const s = asSlice(xs);
    const idx = num(i);
    if (idx < 0 || idx >= s.len || !Number.isInteger(idx))
      throw new Error(`set: index ${idx} out of bounds [0, ${s.len})`);
    s.data[s.off + idx] = v;
    return null;
  },
};

const VALUE_IMPLS: Record<string, Value> = {PI: Math.PI};

const NATIVE_IMPLS: Record<string, (args: Value[], k: Cont) => Outcome> = {
  map: (args, k) => {
    const f = args[0]!;
    const s = asSlice(args[1]);
    const out = new Array<Value>(s.len);
    function go(i: number): Outcome {
      if (i >= s.len)
        return k(mkSlice(out));
      return apply(f, [s.data[s.off + i]!], v => { out[i] = v; return go(i + 1); });
    }
    return go(0);
  },
  each: (args, k) => {
    const f = args[0]!, s = asSlice(args[1]);
    function go(i: number): Outcome {
      if (i >= s.len)
        return k(null);
      return apply(f, [s.data[s.off + i]!, i], () => go(i + 1));
    }
    return go(0);
  },
  flatmap: (args, k) => {
    const f = args[0]!, s = asSlice(args[1]);
    const acc: Value[] = [];
    function go(i: number): Outcome {
      if (i >= s.len)
        return k(mkSlice(acc));
      return apply(f, [s.data[s.off + i]!, i], v => {
        acc.push(...sliceElems(asSlice(v)));
        return go(i + 1);
      });
    }
    return go(0);
  },
};

// The builtin effects' default CPS interpretations — each calls k exactly
// once and synchronously (Exit terminates the process and never calls k).
// eval.ts's runTop consumes these directly for unhandled effects.
const INTERPS: Record<string, (args: Value[], k: Cont) => Outcome> = {
  Read: (args, k) => k(readFileSync(args[0] as string, "utf8")),
  Write: (args, k) => {
    writeFileSync(args[0] as string, args[1] as string);
    return k(null);
  },
  Println: (args, k) => {
    console.log(show(args[0] ?? null));
    return k(null);
  },
  Out: (args, k) => {
    process.stdout.write(args[0] as string);
    return k(null);
  },
  Exit: args => process.exit(num(args[0])),
  Wait: (args, k) => {
    sleepSync(num(args[0]) * 1000);
    return k(null);
  },
  Random: (_args, k) => k(Math.random()),
};

// Audit surface for analysis.test.ts: the impl keys per kind, so the test
// can catch an impl row whose key has no matching table row — orphaned
// dead code the `FN_IMPLS[d.name]` spreads above would silently skip.
export const IMPL_KEYS: {
  fn: string[], value: string[], native: string[], effect: string[],
} = {
  fn: Object.keys(FN_IMPLS),
  value: Object.keys(VALUE_IMPLS),
  native: Object.keys(NATIVE_IMPLS),
  effect: Object.keys(INTERPS),
};

// The one shared runtime table: declarative rows from builtin_table.ts plus
// the impls above, keyed by name. Polymorphic `t` thunks instantiate fresh
// vars per use, so entries are immutable and safe to share across programs.
export const builtins: Builtin[] = BUILTIN_TABLE.map((d): Builtin => {
  switch (d.kind) {
    case "fn": return {...d, fn: FN_IMPLS[d.name]};
    case "value": return {...d, fn: VALUE_IMPLS[d.name]};
    case "native": return {...d, fn: NATIVE_IMPLS[d.name]};
    case "effect": return {...d, interp: INTERPS[d.name]};
  }
});

// Direct-style default interpretation of the builtin effects, derived from
// the CPS `interp` entries above: every builtin effect calls k exactly once
// and synchronously, so the wrapper just unwraps the outcome (Exit never
// returns). Used by the wasm host boundary (wasm.ts), where there are no
// continuations to resume; runTop consumes the CPS interps directly.
export const builtinEffectHosts: Record<string, (args: Value[]) => Value> =
  Object.fromEntries(builtins
    .filter(b => b.kind === "effect")
    .map(b => [b.name, (args: Value[]): Value => {
      const out = b.interp(args, v => ({tag: "done", value: v}));
      if (out.tag !== "done")
        throw new Error(`builtin effect ${b.name} suspended`);
      return out.value;
    }]));

// The builtin effects' default CPS interpretations by op name — identity
// over the effect entries — consumed by eval.ts's runTop for unhandled
// effects. Top-level const is entry-order safe only because it lives in the
// same module as the `builtins` array (a same-module read always follows
// the array's initialization; deriving this in eval.ts instead would be
// TDZ-sensitive there, since builtins.ts imports eval.ts back).
export const builtinInterps: Record<string, (args: Value[], k: Cont) => Outcome> =
  Object.fromEntries(builtins.filter(b => b.kind === "effect").map(b => [b.name, b.interp]));

// Display-only param names for a builtin fn (LSP hover). Names live on the
// entries themselves so adding a builtin stays a one-entry change; this is
// just the name → names lookup. Value/effect entries have no `pnames`.
export function builtinParamNames(name: string): string[] | undefined {
  const b = builtins.find(b => b.name === name);
  return b !== undefined && "pnames" in b ? b.pnames : undefined;
}
