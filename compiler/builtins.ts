// builtins: the runtime half of the builtin table — impls for the
// declarative rows in builtin_table.ts (plain closures, CPS natives, effect
// interps). Adding a builtin means one entry there plus one impl row here.
import {readFileSync, writeFileSync} from "node:fs";
import {apply} from "./backend/interpreter/eval.ts";
import {BUILTIN_TABLE} from "./builtin_table.ts";
import {num, show, asSlice, mkSlice, sliceElems, type Cont, type Outcome, type Value} from "./env.ts";
import {errIndexOOB, errSubRangeOOB} from "./ops.ts";
import {type Unifier, type Type} from "./frontend/unify.ts";
import type {EffectSig} from "./frontend/types.ts";

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

// Program args behind `args` / the wasm host's ef_args import: everything
// after the source path on the ef command line (cli.ts's run/runwasm, the
// benchmark precompile runner). Set by the runners at their boundary —
// REPL, tests, and direct run()/runModule() calls default to []. The
// builtins table is a module-level constant with no ctx access, so the
// value has to ride in here rather than on Ctx.
let programArgs: string[] = [];
export function setProgramArgs(argv: string[]): void { programArgs = argv; }

// Impls keyed by builtin name, one row per table entry (analysis.test.ts's
// IMPL_KEYS audit pins the name sets together per kind). Plain fns lift to
// runtime natives as `k(fn(...args))`; values bind as the value itself;
// natives and effect interps are CPS functions.
const FN_IMPLS: Record<string, (...args: Value[]) => Value> = {
  sub: (xs, fv, tv) => {
    // Zero-copy view of [from, to): shares the backing, offset shifts.
    const s = asSlice(xs);
    const from = num(fv), to = num(tv);
    if (from < 0 || to < from || to > s.len)
      throw new Error(errSubRangeOOB(from, to, s.len));
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
  len: xs => BigInt(asSlice(xs).len),
  strlen: s => BigInt((s as string).length),
  cos: a => Math.cos(num(a)),
  sin: a => Math.sin(num(a)),
  abs: a => Math.abs(num(a)),
  round: a => BigInt(Math.round(num(a))),
  sqrt: a => Math.sqrt(num(a)),
  range: (a, b, c) => {
    const s = num(a), e = num(b), st = num(c);
    const n = st === 0 ? 0 : Math.max(0, Math.ceil((e - s) / st));
    // Declared [TI64] — elements are BigInts like every i64 value.
    return mkSlice(Array.from({length: n}, (_, k) => BigInt(s + k * st)));
  },
  char: a => String.fromCodePoint(num(a) | 0),
  number: a => parseFloat(a as string),
  args: () => mkSlice(programArgs),
  get: (xs, i) => {
    const s = asSlice(xs);
    const idx = num(i);
    if (idx < 0 || idx >= s.len || !Number.isInteger(idx))
      throw new Error(errIndexOOB("get", idx, s.len));
    return s.data[s.off + idx]!;
  },
  set: (xs, i, v) => {
    // Strictly in-window write through the view into the shared backing —
    // growth is concat's job only.
    const s = asSlice(xs);
    const idx = num(i);
    if (idx < 0 || idx >= s.len || !Number.isInteger(idx))
      throw new Error(errIndexOOB("set", idx, s.len));
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
      // The index param is typed i64 — hand the closure a BigInt.
      return apply(f, [s.data[s.off + i]!, BigInt(i)], () => go(i + 1));
    }
    return go(0);
  },
  flatmap: (args, k) => {
    const f = args[0]!, s = asSlice(args[1]);
    const acc: Value[] = [];
    function go(i: number): Outcome {
      if (i >= s.len)
        return k(mkSlice(acc));
      // The index param is typed i64 — hand the closure a BigInt.
      return apply(f, [s.data[s.off + i]!, BigInt(i)], v => {
        acc.push(...sliceElems(asSlice(v)));
        return go(i + 1);
      });
    }
    return go(0);
  },
};

// The builtin effects' default CPS interpretations. eval.ts's runTop
// consumes these directly for unhandled effects; the host derivation below
// derives the wasm-side direct shape from them.
// Synchronous sleep for the `Wait` host, portable across runtimes.
// Atomics.wait blocks the thread without spinning on Node/Bun main threads;
// the Date.now spin covers environments where SharedArrayBuffer or
// main-thread Atomics.wait is unavailable (browser main threads).
function sleepSync(secs: number): void {
  const ms = secs * 1000;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

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
// dead code the lookups in `builtins` would never reach. The reverse gap
// (a table row with no impl row) throws at init in `builtins` below.
export const IMPL_KEYS: {
  fn: string[], value: string[], native: string[], effect: string[],
} = {
  fn: Object.keys(FN_IMPLS),
  value: Object.keys(VALUE_IMPLS),
  native: Object.keys(NATIVE_IMPLS),
  effect: Object.keys(INTERPS),
};

// An impl lookup must resolve: a table row with no impl row throws here at
// module init, so adding a builtin cannot forget its host row.
function impl<T>(row: T | undefined, name: string): T {
  if (row === undefined) throw new Error(`builtin ${name}: missing impl row in builtins.ts`);
  return row;
}

// The one shared runtime table: declarative rows from builtin_table.ts plus
// the impls above, keyed by name. Polymorphic `t` thunks instantiate fresh
// vars per use, so entries are immutable and safe to share across programs.
export const builtins: Builtin[] = BUILTIN_TABLE.map((d): Builtin => {
  switch (d.kind) {
    case "fn": return {...d, fn: impl(FN_IMPLS[d.name], d.name)};
    case "value": return {...d, fn: impl(VALUE_IMPLS[d.name], d.name)};
    case "native": return {...d, fn: impl(NATIVE_IMPLS[d.name], d.name)};
    case "effect": return {...d, interp: impl(INTERPS[d.name], d.name)};
  }
});

// The builtin effects' two host shapes, derived here from the effect rows
// of `builtins` (table rows × the INTERPS impls above): `builtinInterps` is
// the CPS shape eval.ts's runTop consumes for unhandled effects;
// `builtinEffectHosts` is the direct shape wasm_run.ts's hostFor adapter
// wraps into deliveries ((args, k) => k(bi(args))). Soundness of the direct
// shape: every INTERPS interp calls k exactly once and synchronously (Exit
// terminates the process instead of calling k), so the wrapper only ever
// unwraps an already-delivered outcome. Both consts are entry-order safe
// because they live in the same module as the `builtins` array they read
// (deriving them in eval.ts instead would be TDZ-sensitive there, since
// builtins.ts imports eval.ts back).
const effectRows = builtins.filter(b => b.kind === "effect");
export const builtinInterps: Record<string, (args: Value[], k: Cont) => Outcome> =
  Object.fromEntries(effectRows.map(b => [b.name, b.interp]));
export const builtinEffectHosts: Record<string, (args: Value[]) => Value> =
  Object.fromEntries(effectRows.map(b => [b.name, (args: Value[]): Value => {
    const out = b.interp(args, v => ({tag: "done", value: v}));
    if (out.tag !== "done")
      throw new Error(`builtin effect ${b.name} suspended`);
    return out.value;
  }]));

// Display-only param names for a builtin fn (LSP hover). Names live on the
// entries themselves so adding a builtin stays a one-entry change; this is
// just the name → names lookup. Value/effect entries have no `pnames`.
export function builtinParamNames(name: string): string[] | undefined {
  const b = builtins.find(b => b.name === name);
  return b !== undefined && "pnames" in b ? b.pnames : undefined;
}
