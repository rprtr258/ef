// wasm_host.ts — host runtime for the WebAssembly backend: instantiates the
// module built by wasm.ts's compileWithOps, rebuilds interpreter Values
// across the WasmGC boundary through the module's 12 exported accessor
// functions (the accessor ABI — see wasm.ts's module docstring), and
// implements the host imports, including effects that reach the host with
// no matching handler (builtins.ts's builtinEffectHosts, optionally
// overridden per-op through the `interp` argument).
import {type Value, show, asSlice, mkSlice, mkTup, sliceElems} from "./env.ts";
import {builtinEffectHosts} from "./builtins.ts";
import {compileWithOps} from "./wasm.ts";
import {DBGTRACE, TRACE_SITES} from "./wasm_tables.ts";

// The accessor ABI: exported accessor functions — the only way JS can touch
// GC structs. hostBox/hostUnbox rebuild interpreter Values through them; the
// field names are the wasm export names.
type Accessors = {
  __tag(v: unknown): number,
  __num(v: unknown): number,
  __f32(v: unknown): number,
  __i32(v: unknown): number,
  __u32(v: unknown): number,
  __i64(v: unknown): bigint,
  __u64(v: unknown): bigint,
  __str_len(v: unknown): number,
  __str_get(v: unknown, i: number): number,
  __arr_len(v: unknown): number,
  __arr_get(v: unknown, i: number): unknown,
  __mk_num(x: number): unknown,
  __mk_f32(x: number): unknown,
  __mk_i32(x: number): unknown,
  __mk_u32(x: number): unknown,
  __mk_i64(x: bigint): unknown,
  __mk_u64(x: bigint): unknown,
  __mk_bool(b: number): unknown,
  __str_new(n: number): unknown,
  __str_set(v: unknown, i: number, u: number): void,
  __arr_new(n: number): unknown,
  __arr_set(v: unknown, i: number, x: unknown): void,
  __tup_len(v: unknown): number,
  __tup_get(v: unknown, i: number): unknown,
  __tup_new(n: number): unknown,
  __tup_set(v: unknown, i: number, x: unknown): void,
};

const accessorsOf = (inst: WebAssembly.Instance): Accessors =>
  inst.exports as unknown as Accessors;

// Interpreter Value → anyref (via the accessors).
function hostBox(ex: Accessors, v: Value): unknown {
  if (v === null)
    return null;
  if (typeof v === "boolean") return ex.__mk_bool(v ? 1 : 0);
  if (typeof v === "number") return ex.__mk_num(v);
  if (typeof v === "bigint") {
    // i64 values span [-2^63, 2^63); u64 values that reached the host are
    // already normalized to [0, 2^64) — everything >= 2^63 is a u64. Below
    // 2^63 both boxes carry the same bit pattern.
    return v >= (1n << 63n) ? ex.__mk_u64(v) : ex.__mk_i64(BigInt.asIntN(64, v));
  }
  if (typeof v === "string") {
    const s = ex.__str_new(v.length);
    for (let i = 0; i < v.length; i++)
      ex.__str_set(s, i, v.charCodeAt(i));
    return s;
  }
  if (v.tag === "slice") {
    // Boundary copies the view's window — the wasm side never sees the
    // interpreter's backing, matching the unbox direction.
    const a = ex.__arr_new(v.len);
    for (let i = 0; i < v.len; i++)
      ex.__arr_set(a, i, hostBox(ex, v.data[v.off + i]));
    return a;
  }
  if (v.tag === "tup") {
    const a = ex.__tup_new(v.elems.length);
    for (let i = 0; i < v.elems.length; i++)
      ex.__tup_set(a, i, hostBox(ex, v.elems[i]));
    return a;
  }
  throw new Error("wasm host: cannot box value " + show(v));
}

// anyref → interpreter Value (via the accessors; i31 bools cross the JS
// boundary as Numbers).
function hostUnbox(ex: Accessors, v: unknown): Value {
  if (v === null)
    return null;
  switch (ex.__tag(v)) {
    case 1: return ex.__num(v);
    case 2: return (v as number) !== 0;
    case 3: return hostStr(ex, v);
    case 4: {
      const n = ex.__arr_len(v);
      const out: Value[] = [];
      for (let i = 0; i < n; i++)
        out.push(hostUnbox(ex, ex.__arr_get(v, i)));
      return mkSlice(out);
    }
    case 11: {
      const n = ex.__tup_len(v);
      const elems: Value[] = [];
      for (let i = 0; i < n; i++)
        elems.push(hostUnbox(ex, ex.__tup_get(v, i)));
      return mkTup(elems);
    }
    case 5: return {tag: "fn"} as Value; // closures display as [fn]
    case 10: return ex.__f32(v); // $F32 box
    case 6: return ex.__i32(v); // $I32 box
    // JS i32 returns are already sign-extended; u32 masks the raw bits.
    // The 64-bit widths cross as BigInt (the standard wasm JS-BigInt
    // integration); u64 masks the raw two's-complement bits.
    case 7: return ex.__u32(v) >>> 0; // $U32 box (masked)
    case 8: return BigInt.asIntN(64, ex.__i64(v)); // $I64 box: BigInt
    case 9: return BigInt.asUintN(64, ex.__u64(v)); // $U64 box: BigInt masked
  }
  throw new Error(`wasm host: unknown anyref tag ${ex.__tag(v)}`);
}

function hostStr(ex: Accessors, v: unknown): string {
  const n = ex.__str_len(v);
  let s = "";
  for (let i = 0; i < n; i++)
    s += String.fromCharCode(ex.__str_get(v, i));
  return s;
}

// Host-side effect interpretation for a compiled module: per-op sync
// replacements for builtinEffectHosts (the wasm host's CPS-free interp shape).
export type EffectInterp = Partial<Record<string, (args: Value[]) => Value>>;

export function runWasm(src: string, interp?: EffectInterp): Value {
  const {bytes, ops} = compileWithOps(src);
  return runModule(bytes, ops, interp);
}

// Instantiate and run an already-compiled module: used by runWasm and by hosts
// that compile separately from running (the playground runs through here).
// Last entered emission sites (ef_trace calls), printed when a runtime
// trap escapes under EFTRACE=1.
const traceBuf: number[] = [];

export function runModule(bytes: Uint8Array<ArrayBuffer>, ops: readonly string[], interp?: EffectInterp): Value {
  const mod = new WebAssembly.Module(bytes);
  const imports = {
    ef_perform: (opid: number, args: unknown) => {
      const op = (ops as (string | undefined)[])[opid];
      if (op === undefined) throw new Error(`wasm host: unknown effect opid ${opid}`);
      const argv = sliceElems(asSlice(hostUnbox(ex(), args)));
      const custom = interp?.[op];
      if (custom !== undefined) return hostBox(ex(), custom(argv));
      const bi = (builtinEffectHosts as Record<string, ((args: Value[]) => Value) | undefined>)[op];
      if (bi === undefined) throw new Error("Unhandled effect: " + op);
      return hostBox(ex(), bi(argv));
    },
    ef_char: (v: unknown) => hostBox(ex(), String.fromCodePoint(ex().__num(v) | 0)),
    ef_number: (v: unknown) => hostBox(ex(), parseFloat(hostStr(ex(), v))),
    ef_args: () => hostBox(ex(), mkSlice(process.argv.slice(2))),
    ef_cos: (v: unknown) => hostBox(ex(), Math.cos(ex().__num(v))),
    ef_sin: (v: unknown) => hostBox(ex(), Math.sin(ex().__num(v))),
    ef_fail: (code: number, name: unknown, a: number, b: number, c: number) => {
      // Codes carry the interpreter's exact error messages for parity; c is
      // the third number sub's message needs (from, to, len).
      if (code === 1) throw new Error(`get: index ${a} out of bounds [0, ${b})`);
      if (code === 5) throw new Error(`sub: range [${a}, ${b}) out of bounds [0, ${c})`);
      if (code === 6) throw new Error(`set: index ${a} out of bounds [0, ${b})`);
      // The i32/u32 division guards (emitFail at the
      // / and % sites) reuse this channel; codes 3/4 carry the interpreter's
      // exact trap messages (eval.ts widthOp) for parity. Code 2 is the
      // named field-access OOB (falls to the default template).
      if (code === 3) throw new Error("integer divide by zero");
      if (code === 4) throw new Error("integer overflow");
      throw new Error(`.${hostStr(ex(), name)}: index ${a} out of bounds [0, ${b})`);
    },
    ef_trace: (site: number, val: number) => {
      // Ring buffer of the last entered emission sites (EFTRACE=1 only;
      // the import is dead code otherwise). val carries a runtime value.
      traceBuf.push(site * 100000 + (val | 0));
      if (traceBuf.length > 4096) traceBuf.shift();
    },
  };
  const inst = new WebAssembly.Instance(mod, {env: imports});
  const ex = () => accessorsOf(inst);
  const dumpTrace = (): void => {
    if (!DBGTRACE) return;
    const sites = traceBuf.map((s) => {
      const site = Math.floor(s / 100000), val = s % 100000;
      return (TRACE_SITES[site] ?? `#${site}`) + (val !== 0 ? `=${val}` : "");
    });
    if (process.env["EFTRACE_ALL"] === "1") console.error(`[EFTRACE] all sites: ${sites.join(" -> ")}`);
    else console.error(`[EFTRACE] last sites: ${sites.slice(-16).join(" -> ")}`);
  };
  try {
    const result = (inst.exports["run"] as () => unknown)();
    const v = hostUnbox(ex(), result);
    dumpTrace();
    return v;
  } catch (e) {
    dumpTrace();
    throw e;
  }
}
