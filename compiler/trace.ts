// trace.ts — the run trace: an ordered log of every builtin-effect host
// interpretation reaching a backend's boundary (Read/Write/Println/Out/
// Exit/Wait/Random and any custom op the caller's interp covers), one
// event per perform carrying the op name, the serialized arguments, and
// the delivered result. This is the observation contract the backends are
// judged on: parity.test.ts compares the interpreter's and the wasm host's
// traces, so ordering and value divergences a stdout-only comparison
// misses (Out!/Println! interleavings, Read! contents, Random! draw
// counts) fail the gate. Leaf module over env.ts: only the Value/Outcome/
// Cont plumbing types.
import {type Cont, type Outcome, type Value, show} from "./env.ts";

type TraceEvent = {op: string, args: string, result: string};
export type RunTrace = TraceEvent[];

// `result: "<no result>"` survives only for hosts that terminate the
// process without returning (the default Exit! interpretation in CLI runs).
export function showTrace(t: RunTrace): string {
  return t.map(e => `${e.op}(${e.args}) -> ${e.result}`).join("\n");
}

// One traced host interpretation: the event is pushed before the host
// runs (a throwing host — the tests' Exit! sentinel, a failed Read! —
// still records its usage), and the host's delivered value lands in the
// event's result at delivery time. Tracing is opt-in: trace === undefined
// runs the host directly, zero-cost.
export function runTraced(op: string, args: Value[], k: Cont, host: (args: Value[], k: Cont) => Outcome, trace?: RunTrace): Outcome {
  if (trace === undefined) return host(args, k);
  const ev: TraceEvent = {op, args: args.map(show).join(", "), result: "<no result>"};
  trace.push(ev);
  try {
    return host(args, v => { ev.result = show(v); return k(v); });
  } catch (e) {
    ev.result = "throw: " + (e as Error).message;
    throw e;
  }
}
