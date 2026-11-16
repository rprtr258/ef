// Every program in this suite is a fixture on disk: examples/*.ef (the
// user-facing examples) and compiler/backend/testdata/*.ef (fine-grained
// language-feature, regression, and wasm-internal parity fixtures). Two
// tables — EXAMPLES and FIXTURES — list one row per scenario, and a single
// runner generates every test body from those rows:
//
// 1. Each test runs the program through both backends in-process and
//    asserts they agree on everything observable: the full stdout (every
//    Println!/Out! effect, interleaved with the top-level result's show()
//    line), the exit code, and error lines ("ERR: <message>").
// 2. The interpreter's result must match the row's expected stdout (want,
//    or wantFile for a huge golden output) and exit code (code, default 0).
//
// A fixture without a table row (and a row without its fixture) fails the
// per-table coverage guard, in both directions.
//
// Exit! is intercepted with a thrown sentinel (the default host
// interpretation is process.exit, which would kill the test runner) and
// Random! is driven by a local seed-42 mulberry32, so Random!-driven
// programs (approx_pi.ef) are reproducible and parity-checked exactly like
// the rest. The CLI executable surface itself (argv, exit codes, stderr)
// is smoke-tested separately in cli.test.ts.
//
// star.ef is the exception in shape, not in coverage: it is an infinite
// animation loop, so its row compares a bounded output prefix across
// backends instead of pinning exact stdout.
import {test, expect, describe} from "bun:test";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {run} from "./interpreter/eval.ts";
import {runWasm} from "./wasm/wasm_host.ts";
import {num, show, type Value} from "../env.ts";

const compilerDir = join(import.meta.dir, ".."); // compiler/ — cli.ts and examples/ are relative to it
const examplesDir = join(compilerDir, "..", "examples");
const testdataDir = join(import.meta.dir, "testdata");

type RunResult = {stdout: string, code: number};

// The default host interpretation of Exit! is process.exit, which would
// kill the test runner; runOnce swaps it for this sentinel and maps it back
// to an exit code at its boundary.
class ExitSignal extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

// Local mulberry32 PRNG seeded with 42, standing in for Math.random(): the
// interpreter and the wasm host would otherwise draw from the same global
// Math.random() stream sequentially, so Random!-driven programs would fail
// their parity check. A fresh stream per run keeps backend parity exact.
function mulberry42(): () => number {
  let a = 42 | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One backend run of src, capturing the stdout the CLI would print:
// Println!'s console.log lines, Out!'s raw process.stdout.write chunks,
// then the top-level result's show() line. A thrown error (a failed check,
// a runtime trap) becomes an "ERR: <message>" line with exit code 1, so
// error output is asserted with the same machinery as values and effects.
function runOnce(mode: "run" | "runwasm", src: string, file: string, args: string[]): RunResult {
  const rand = mulberry42();
  const chunks: string[] = [];
  const realLog = console.log.bind(console);
  const realWrite = process.stdout.write.bind(process.stdout);
  const savedArgv = process.argv;
  console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(" ") + "\n"); };
  process.stdout.write = (s: string) => { chunks.push(s); return true; };
  process.argv = [process.argv[0], join(compilerDir, "cli.ts"), mode, file, ...args];
  try {
    let value: Value;
    try {
      value = mode === "run"
        ? run(src, {Exit: a => { throw new ExitSignal(num(a[0])); }, Random: (_a, k) => k(rand())}, args)
        : runWasm(src, {Exit: a => { throw new ExitSignal(num(a[0])); }, Random: (_a, k) => k(rand())}, args);
    } catch (e) {
      if (e instanceof ExitSignal) return {stdout: chunks.join(""), code: e.code};
      return {stdout: chunks.join("") + "ERR: " + (e as Error).message + "\n", code: 1};
    }
    return {stdout: chunks.join("") + show(value) + "\n", code: 0};
  } finally {
    console.log = realLog;
    process.stdout.write = realWrite;
    process.argv = savedArgv;
  }
}

type Row = {
  file: string,
  label?: string, // test name; defaults to the fixture filename
  args?: string[],
  want?: string, // exact expected stdout (effects + result line + ERR lines)
  wantFile?: string, // gzip-compressed golden file in testdata/ holding the expected stdout
  code?: number, // expected exit code, default 0
  bounded?: true, // star.ef: compare a bounded output prefix instead of exact stdout
};

// star.ef spins forever, so its self-run crosses backend processes with an
// output-bounded read: stdout is read until the 3000-char cap is reached,
// then the child is killed. Bytes are load-independent: slower machines
// just take longer to fill the cap. If star ever stops producing output (a
// real regression), the read blocks until the test-level timeout fails the
// test. Only a prefix inside the first frame is compared: later frames
// diverge by wall clock (the animation spins unbounded).
async function boundedPrefix(file: string, args: string[]): Promise<boolean> {
  const runBounded = async (mode: string): Promise<string> => {
    const p = Bun.spawn(
      ["bun", "run", "cli.ts", mode, file, ...args],
      {cwd: compilerDir, stdout: "pipe", stderr: "ignore"},
    );
    const reader = p.stdout.getReader();
    const decode = new TextDecoder();
    let out = "";
    while (out.length < 3000) {
      const {done, value} = await reader.read();
      if (done) break;
      out += decode.decode(value, {stream: true});
    }
    p.kill();
    await p.exited;
    return out.slice(0, 3000);
  };
  const [interp, wasm] = [await runBounded("run"), await runBounded("runwasm")];
  const prefixLen = Math.min(interp.length, wasm.length);
  expect(prefixLen).toBeGreaterThanOrEqual(1000);
  expect(wasm.slice(0, prefixLen)).toBe(interp.slice(0, prefixLen));
  return true;
}

// Fine-grained fixtures: one .ef file per scenario under testdata/. Each
// file's header comment says what the fixture locks; every fixture is
// asserted through the same two checks (backend parity, then exact stdout
// + exit code), values, effects, and errors alike.
const FIXTURES: Row[] = [
  {file: "arith-i64-div-truncs.ef", want: "3\n"},
  {file: "arith-f64-div.ef", want: "3.5\n"},
  {file: "arith-neg-then-add.ef", want: "-2\n"},
  {file: "handler-arity-mix-resume.ef", want: "3\n"},
  {file: "handler-second-resume-reperform.ef", want: "1\n"},
  {file: "handler-tail-resume-loop.ef", want: "0\n"},
  {file: "arith-i64-rem.ef", want: "2\n"},
  {file: "arith-i64-div-by-zero-traps.ef", want: "ERR: integer divide by zero\n", code: 1},
  {file: "arith-i64-div-neg-truncs.ef", want: "-3\n"},
  {file: "str-concat-unstamped-site.ef", want: "\"ab\"\n"},
  {file: "str-lt-unstamped-host-err.ef", want: "ERR: Expected number, got \"a\"\n", code: 1},
  {file: "str-gt-unstamped-host-err.ef", want: "ERR: Expected number, got \"z\"\n", code: 1},
  {file: "cmp-if-branches.ef", want: "10\n"},
  {file: "cmp-string-eq.ef", want: "true\n"},
  {file: "cmp-string-neq.ef", want: "true\n"},
  {file: "cmp-array-identity.ef", want: "false\n"},
  {file: "cmp-i64-neq.ef", want: "true\n"},
  {file: "any-eq-f64.ef", want: "true\n"},
  {file: "any-eq-f32.ef", want: "true\n"},
  {file: "any-eq-i32-u32.ef", want: "true\n"},
  {file: "any-eq-i32.ef", want: "true\n"},
  {file: "any-eq-i64-u64.ef", want: "true\n"},
  {file: "any-eq-i64-neg1-u64-max.ef", want: "false\n"},
  {file: "any-eq-i64-vs-f64.ef", want: "false\n"},
  {file: "any-eq-i32-vs-i64.ef", want: "false\n"},
  {file: "any-eq-bool.ef", want: "true\n"},
  {file: "any-eq-string.ef", want: "true\n"},
  {file: "any-eq-distinct-numbers.ef", want: "false\n"},
  {file: "tail-op-land-div.ef", want: "6\n"},
  {file: "tail-op-land-mul.ef", want: "22\n"},
  {file: "tail-op-performing-operand.ef", want: "6\n"},
  {file: "str-concat-literals.ef", want: "\"abcd\"\n"},
  {file: "len-rejects-strings.ef", want: "ERR: Type mismatch:\ngot      : [a]\nexpected : string\n", code: 1},
  {file: "strlen-counts-chars.ef", want: "5\n"},
  {file: "while-sums-0-to-4.ef", want: "10\n"},
  {file: "block-lambda-lets-share-frame.ef", want: "6\n"},
  {file: "arr-get.ef", want: "20\n"},
  {file: "arr-set-strict-window.ef", want: "ERR: set: index 3 out of bounds [0, 1)\n", code: 1},
  {file: "arr-sub-view-write-through.ef", want: "[99, 3]\n"},
  {file: "arr-sub-oob.ef", want: "ERR: sub: range [5, 6) out of bounds [0, 3)\n", code: 1},
  {file: "arr-get-huge-index.ef", want: "ERR: get: index 4294967296 out of bounds [0, 3)\n", code: 1},
  {file: "arr-flat-len.ef", want: "3\n"},
  {file: "arr-concat.ef", want: "[1, 2, 3]\n"},
  {file: "arr-map-range-squares.ef", want: "[0, 1, 4, 9]\n"},
  {file: "arr-nested-get.ef", want: "3\n"},
  {file: "closure-addn-returned-call.ef", want: "15\n"},
  {file: "closure-counter-state.ef", want: "3\n"},
  {file: "closure-curried-three.ef", want: "6\n"},
  {file: "closure-id-as-value.ef", want: "3\n"},
  {file: "rec-fib-15.ef", want: "610\n"},
  {file: "rec-tail-100k.ef", want: "5000050000\n"},
  {file: "math-sqrt-abs.ef", want: "144\n"},
  {file: "math-cos-sin-zero.ef", want: "10\n"},
  {file: "math-pi-value.ef", want: "314\n"},
  {file: "f32-add-rounds.ef", want: "0.30000001192092896\n"},
  {file: "f32-literal-sum-demotes.ef", want: "0.30000001192092896\n"},
  {file: "f32-third.ef", want: "0.3333333432674408\n"},
  {file: "f32-eq-after-sum.ef", want: "true\n"},
  {file: "f64-sum-keeps-precision.ef", want: "0.30000000000000004\n"},
  {file: "f32-typed-lets.ef", want: "0.30000001192092896\n"},
  {file: "f32-param-sig.ef", want: "6.050000190734863\n"},
  {file: "f32-num-adapts.ef", want: "2\n"},
  {file: "f32-map-squares-elem0.ef", want: "0.25\n"},
  {file: "f32-sqrt.ef", want: "2\n"},
  {file: "f32-neg.ef", want: "-1.5\n"},
  {file: "f32-mul.ef", want: "9.051400184631348\n"},
  {file: "f32-to-f64-promotes.ef", want: "0.10000000149011612\n"},
  {file: "f64-to-f32-demotes.ef", want: "0.10000000149011612\n"},
  {file: "f32-lt.ef", want: "true\n"},
  {file: "f32-div.ef", want: "0.3333333432674408\n"},
  {file: "f32-rem.ef", want: "1.5\n"},
  {file: "f32-rem-via-fn.ef", want: "1.3000001907348633\n"},
  {file: "i32-add-wraps.ef", want: "-2147483648\n"},
  {file: "i32-sub-wraps.ef", want: "2147483647\n"},
  {file: "i32-mul-wraps.ef", want: "-2\n"},
  {file: "u32-add-wraps.ef", want: "0\n"},
  {file: "u32-sub-wraps.ef", want: "4294967295\n"},
  {file: "u32-mul-wraps.ef", want: "410065408\n"},
  {file: "i32-cmp-signed.ef", want: "true\n"},
  {file: "u32-cmp-unsigned.ef", want: "true\n"},
  {file: "i32-u32-mixed-cmp-err.ef", want: "ERR: <: i32 and u32 are different numeric widths (use @as to convert)\n", code: 1},
  {file: "as-wrap-down-i32.ef", want: "1\n"},
  {file: "as-wrap-down-u32.ef", want: "1\n"},
  {file: "as-neg1-i32.ef", want: "-1\n"},
  {file: "as-neg1-u32.ef", want: "4294967295\n"},
  {file: "as-i32-to-i64.ef", want: "5\n"},
  {file: "as-neg5-i32-to-i64.ef", want: "-5\n"},
  {file: "as-u32-max-to-i64.ef", want: "4294967295\n"},
  {file: "i32-eq-payload-bits.ef", want: "true\n"},
  {file: "i32-eq-distinct-payloads.ef", want: "false\n"},
  {file: "i32-div-zero-err.ef", want: "ERR: integer divide by zero\n", code: 1},
  {file: "i32-rem-zero-err.ef", want: "ERR: integer divide by zero\n", code: 1},
  {file: "u32-div-zero-err.ef", want: "ERR: integer divide by zero\n", code: 1},
  {file: "i32-min-div-neg1-err.ef", want: "ERR: integer overflow\n", code: 1},
  {file: "i32-min-rem-neg1-zero.ef", want: "0\n"},
  {file: "i64-add-wraps.ef", want: "-9223372036854775808\n"},
  {file: "i64-sub-wraps.ef", want: "9223372036854775807\n"},
  {file: "i64-mul-wraps-2p62.ef", want: "-9223372036854775808\n"},
  {file: "i64-mul-wraps-2p64.ef", want: "0\n"},
  {file: "u64-add-wraps.ef", want: "0\n"},
  {file: "u64-sub-wraps.ef", want: "18446744073709551615\n"},
  {file: "i64-exact-beyond-2p53.ef", want: "9007199254740993\n"},
  {file: "i64-cmp-positive.ef", want: "true\n"},
  {file: "i64-2p63-compares-negative.ef", want: "true\n"},
  {file: "u64-2p63-compares-positive.ef", want: "true\n"},
  {file: "i64-u64-mixed-cmp-err.ef", want: "ERR: <: i64 and u64 are different numeric widths (use @as to convert)\n", code: 1},
  {file: "as-i64-no-trunc.ef", want: "4294967297\n"},
  {file: "as-u64-max-to-u32.ef", want: "4294967295\n"},
  {file: "as-i64-to-u64.ef", want: "5\n"},
  {file: "i64-eq-payload-bits.ef", want: "true\n"},
  {file: "i64-eq-beyond-2p53.ef", want: "true\n"},
  {file: "i64-neq-beyond-2p53.ef", want: "false\n"},
  {file: "i64-div-zero-err.ef", want: "ERR: integer divide by zero\n", code: 1},
  {file: "u64-rem-zero-err.ef", want: "ERR: integer divide by zero\n", code: 1},
  {file: "i64-min-div-neg1-err.ef", want: "ERR: integer overflow\n", code: 1},
  {file: "builtin-as-arg.ef", want: "3\n"},
  {file: "builtin-two-as-args.ef", want: "6\n"},
  {file: "builtin-returned-and-called.ef", want: "3\n"},
  {file: "err-unbound-var.ef", want: "ERR: Unbound: nope\n", code: 1},
  {file: "err-mixed-add.ef", want: "ERR: +: i64 and string are not both numeric or both string\n", code: 1},
  {file: "err-get-oob.ef", want: "ERR: get: index 9 out of bounds [0, 2)\n", code: 1},
  {file: "err-unbound-head.ef", want: "ERR: Unbound: head\n", code: 1},
  // Mutable (:=) lambda bindings stay monomorphic — assignment must inform
  // later uses (the stale-scheme hole: checker saw the old type while the
  // runtime ran the new closure).
  {file: "assign-lam-rebind-type-err.ef", want: "ERR: Type mismatch:\ngot      : i64\nexpected : string\n", code: 1},
  {file: "assign-lam-rebind-call-ok.ef", want: "2\n"},
  {file: "assign-lam-rebind-captured-type-err.ef", want: "ERR: Type mismatch:\ngot      : string\nexpected : i64\n", code: 1},
  {file: "lam-immutable-generalizes.ef", want: "[\"s\", 1]\n"},
  {file: "handle-const-case.ef", want: "7\n"},
  {file: "handle-resume-twice.ef", want: "6\n"},
  {file: "handle-lambda-perform-nonresume.ef", want: "1\n"},
  {file: "handle-return-case-passthrough.ef", want: "5\n"},
  {file: "handle-propagates-past-inner.ef", want: "5\n"},
  {file: "handle-inner-matches-first.ef", want: "10\n"},
  {file: "handle-multishot-choose.ef", want: "[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]\n"},
  {file: "handle-nonresume-aborts.ef", want: "[\"div by zero\"]\n"},
  {file: "handle-deep-log-nesting.ef", want: "[\"a\", \"b\", \"42\"]\n"},
  {file: "handle-propagates-from-case-body.ef", want: "[\"hi\"]\n"},
  {file: "handle-inner-return-wraps-resume.ef", want: "[4]\n"},
  {file: "handle-intercepts-builtin-read.ef", want: "41\n"},
  {file: "handle-exit-no-resume.ef", want: "\"pre\"\n42\n"},
  {file: "handle-perform-in-call-args.ef", want: "6\n"},
  {file: "mixed-island-dret-boundary.ef", want: "72\n"},
  {file: "mixed-tail-handle.ef", want: "42\n"},
  {file: "mixed-inside-foreign-island.ef", want: "108\n"},
  {file: "mixed-multishot-amb-shape.ef", want: "[[1], [2]]\n"},
  {file: "reg-multi-param-two-shot.ef", want: "3\n"},
  {file: "reg-single-param-two-shot.ef", want: "10\n"},
  {file: "reg-flat-scalar-passthrough.ef", want: "[7, 8]\n"},
  {file: "reg-flatmap-no-handler.ef", want: "[1, 10, 2, 20, 3, 30]\n"},
  {file: "reg-arr-lit-perform-head.ef", want: "[7, 7]\n"},
  {file: "reg-arr-lit-perform-mid.ef", want: "[1, 2, 7, 7]\n"},
  {file: "reg-arr-lit-perform-nested.ef", want: "[[7, 1], [2, [7]]]\n"},
  {file: "reg-div-cut-f64-both-operands.ef", want: "0.5\n"},
  {file: "reg-div-cut-i64-both-operands.ef", want: "1\n"},
  {file: "reg-while-cond-resuming.ef", want: "3\n"},
  {file: "reg-while-cond-nonresuming.ef", want: "0\n"},
  {file: "reg-while-cond-and-body-perform.ef", want: "7\n"},
  {file: "reg-while-cond-two-performs.ef", want: "4\n"},
  {file: "reg-handle-stmt-in-while-body.ef", want: "20\n"},
  {file: "reg-dlet-destructure-performs.ef", want: "52\n"},
  {file: "reg-loop-frozen-reload.ef", want: "23\n"},
  {file: "reg-loop-frozen-reload-as.ef", want: "23\n"},
  {file: "reg-abort-idiom-kfree-case.ef", want: "42\n"},
  {file: "reg-transforming-len-outside.ef", want: "2\n"},
  {file: "reg-multishot-map-deliveries.ef", want: "[11, 11]\n"},
  {file: "reg-each-multishot-index-land.ef", want: "[7, 8, 9]\n"},
  {file: "reg-flatmap-multishot-land.ef", want: "[11, 0, 12, 1]\n"},
  {file: "reg-each-multishot-unit-shape.ef", want: "35\n"},
  {file: "split-if-both-arms-print.ef", want: "\"else-arm\"\n\"after-else\"\n\"after\"\nunit\n"},
  {file: "split-if-one-arm-tail-print.ef", want: "\"then\"\n\"tail\"\nunit\n"},
  {file: "split-nested-operand-land.ef", want: "-18.740000000000002\nunit\n"},
  {file: "devirt-mutual-nested-closures.ef", want: "[4, 0, 9]\n"},
  {file: "devirt-inline-rest-while.ef", want: "15\n"},
  {file: "devirt-dcall-on-resumed-path.ef", want: "4\n"},
  {file: "devirt-captured-assign-after-dcall.ef", want: "[43, 42]\n"},
  {file: "devirt-map-pure-direct.ef", want: "[2, 3, 4]\n"},
  {file: "devirt-each-pure-direct.ef", want: "unit\n"},
  {file: "devirt-flatmap-pure-direct.ef", want: "[1, 1, 2, 2]\n"},
  {file: "devirt-each-performing-generic.ef", want: "unit\n"},
  {file: "devirt-each-multishot-land-reenter.ef", want: "0\n"},
  {file: "devirt-map-single-resume.ef", want: "[10, 10]\n"},
  {file: "numabi-i32.ef", want: "42\n"},
  {file: "numabi-u32.ef", want: "42\n"},
  {file: "numabi-i64.ef", want: "42\n"},
  {file: "numabi-u64.ef", want: "42\n"},
  {file: "numabi-f32-double.ef", want: "3\n"},
  {file: "numabi-f64-double.ef", want: "3\n"},
  {file: "numabi-multiarg-div.ef", want: "3\n"},
  {file: "numabi-div-zero-err.ef", want: "ERR: integer divide by zero\n", code: 1},
  {file: "numabi-u64-div.ef", want: "9223372036854775807\n"},
  {file: "numabi-mixed-string-param.ef", want: "42\n"},
  {file: "numabi-poly-boxed-i64.ef", want: "7\n"},
  {file: "numabi-poly-boxed-f64.ef", want: "2.5\n"},
  {file: "numabi-poly-boxed-string.ef", want: "\"s\"\n"},
  {file: "numabi-handler-island.ef", want: "17\n"},
  {file: "numabi-closure-env-capts.ef", want: "203\n"},
  {file: "host-arr-field-oob-err.ef", want: "ERR: .5: index 5 out of bounds [0, 2)\n", code: 1},
  {file: "wasm-shadow-builtin-len-err.ef", want: "ERR: cannot shadow builtin 'len'\n", code: 1},
  {file: "wasm-unhandled-effect-static-reject.ef", want: "ERR: Unhandled effect: Foo\n", code: 1},
  {file: "wasm-handle-operator-operand.ef", want: "8\n"},
  {file: "wasm-served-builtin-char.ef", want: "\"a\"\n"},
  {file: "wasm-served-builtin-round-cos.ef", want: "100\n"},
  {file: "wasm-args-builtin-len.ef", args: ["a", "b"], want: "2\n"},
  {file: "wasm-shadow-served-char-err.ef", want: "ERR: cannot shadow builtin 'char'\n", code: 1},
  {file: "wasm-every-served-builtin.ef", want: "13\n13\n"},
  {file: "wasm-binaryen-shrink-preserves-semantics.ef", want: "\"hi\"\n21\n42\n"},
  {file: "wasm-split-nested-if-else-land.ef", want: "1\nunit\n"},
  {file: "wasm-devirt-mixed-dcall.ef", want: "[102, 103]\n"},
  {file: "wasm-numeric-entry-shape-tag.ef", want: "45\n"},
  {file: "wasm-typed-slots-i64-assign-exact.ef", want: "1\n2\n9007199254740995\n"},
  {file: "wasm-typed-slots-scope-elision.ef", want: "3\n"},
  {file: "wasm-typed-slots-rest-thunk-read.ef", want: "12\n"},
  {file: "wasm-typed-slots-escaping-closure.ef", want: "7\n"},
  {file: "wasm-typed-slots-casefn-depth-read.ef", want: "11\n"},
  {file: "wasm-typed-slots-toplevel-assign.ef", want: "[1, 3, 3]\n"},
  {file: "wasm-typed-slots-f32-fround.ef", want: "true\n"},
  {file: "wasm-typed-slots-numeric-join.ef", want: "6\n"},
];

// The examples: one row per scenario over examples/*.ef. Expected stdout is
// exact for every deterministic example (widths, newton and approx_pi are
// fully pinned too: the seeded Random! makes each run identical).
const EXAMPLES: Row[] = [
  {file: "amb.ef", label: "nondeterministic search finds Pythagorean triples",
    want: "[3, 4, 5]\n[5, 12, 13]\n[6, 8, 10]\nunit\n"},
  {file: "apply.ef", label: "polymorphic apply calls functions stored in values",
    want: "42\n\"n=7\"\n99\nunit\n"},
  {file: "bitwise.ef", label: "logical bool ops; widths with @as; shifts as arithmetic",
    want: "25\n"},
  {file: "bool_equality.ef", label: "bool equality converted to int via @as",
    want: "1\n"},
  {file: "bool_logic.ef", label: "&& / || classification",
    want: "6\n"},
  {file: "bracketed_expr.ef", label: "parenthesized grouping",
    want: "8\n"},
  {file: "cast_roundtrip.ef", label: "i64 -> f64 -> +1 -> i64 via @as",
    want: "42\n"},
  {file: "widths.ef", label: "f32 precision, @as conversions, division and wraparound parity",
    want: "0.30000001192092896\n0.30000000000000004\n0.3333333432674408\n0.3333333333333333\n10\n0.03333333507180214\n0.06666667014360428\ntrue\n9007\n-3\n-1\n1\n3\n-3\n3.5\n1\n-2147483648\n2147483647\n-2\n0\n4294967295\n410065408\ntrue\ntrue\n-2147483648\n9007199254740993\nfalse\n-9223372036854775808\n0\ntrue\ntrue\n0\nunit\n"},
  {file: "approx_pi.ef", label: "Monte Carlo pi estimate (Random!) needs an n argument",
    want: "Usage: ef run examples/approx_pi.ef <n>\n", code: 1},
  {file: "approx_pi.ef", label: "converges toward pi for large n", args: ["10000"],
    want: "3.1576\nunit\n"},
  {file: "block.ef", label: "a block runs statements in order and yields the last value",
    want: "42\n99\n123\nunit\n"},
  {file: "closure_capture.ef", label: "closure reads enclosing binding",
    want: "10\n"},
  {file: "closure_make_adder.ef", label: "returned closure adds 3",
    want: "7\n"},
  {file: "closure_make_adder2.ef", label: "returned closure adds 10",
    want: "15\n"},
  {file: "closure_nested.ef", label: "apply_twice(inc)(5)",
    want: "7\n"},
  {file: "closure_no_capture.ef", label: "closure without captures",
    want: "1\n"},
  {file: "collatz.ef", label: "Println! from nested while/if loops",
    want: `${[7, 22, 11, 34, 17, 52, 26, 13, 40, 20, 10, 5, 16, 8, 4, 2, 1, 55].join("\n")}\n1\n`},
  {file: "comments.ef", label: "comments plus naive Fibonacci",
    want: "55\n"},
  {file: "complex_indexing.ef", label: "expression as element index",
    want: "3\n"},
  {file: "control_constructs.ef", label: "if/while nesting, done-flag break",
    want: `${[
      1234, 617, 1852, 926, 463, 1390, 695, 2086, 1043, 3130,
      1565, 4696, 2348, 1174, 587, 1762, 881, 2644, 1322, 661,
      1984, 992, 496, 248, 124, 62, 31, 94, 47, 142,
      71, 214, 107, 322, 161, 484, 242, 121, 364, 182,
      91, 274, 137, 412, 206, 103, 310, 155, 466, 233,
      700, 350, 175, 526, 263, 790, 395, 1186, 593, 1780,
      890, 445, 1336, 668, 334, 167, 502, 251, 754, 377,
      1132, 566, 283, 850, 425, 1276, 638, 319, 958, 479,
      1438, 719, 2158, 1079, 3238, 1619, 4858, 2429, 7288, 3644,
      1822, 911, 2734, 1367, 4102, 2051, 6154, 3077, 9232, 4616,
      2308, 1154, 577, 1732, 866, 433, 1300, 650, 325, 976,
      488, 244, 122, 61, 184, 92, 46, 23, 70, 35,
      106, 53, 160, 80, 40, 20, 10, 5, 16, 8,
      4, 2,
    ].join("\n")}\n44\n`},
  {file: "closure.ef", label: "a returned closure keeps reading its captured environment",
    want: "7\nunit\n"},
  {file: "example.ef", label: "handler loops over a whole search space",
    want: "[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]\n"},
  {file: "equality_all_types.ef", label: "int equality",
    want: "1\n"},
  {file: "expression_indexing.ef", label: "variable as element index",
    want: "20\n"},
  {file: "extended_access.ef", label: "element store through a variable index",
    want: "43\n"},
  {file: "external_function.ef", label: "Println! then a discarded value",
    want: "42\n0\n"},
  {file: "f32_arithmetic.ef", label: "f32 addition rounds to f32 precision",
    want: "6\n"},
  {file: "f64_comparison.ef", label: "f64 comparison converted to int via @as",
    want: "1\n"},
  {file: "factorial.ef", label: "recursion via if expression",
    want: "120\n"},
  {file: "fibonacci_function.ef", label: "fib(10)",
    want: "55\n"},
  {file: "functional.ef", label: "let-generalized polymorphic id",
    want: "1\n0\n"},
  {file: "fib.ef", label: "exponential recursion through the CPS evaluator",
    want: "196418\nunit\n"},
  {file: "gc.ef", label: "aliases, slices, element reads",
    want: "115\n"},
  {file: "gc_alias.ef", label: "aliasing plus identity tuple equality",
    want: "79\n"},
  {file: "incA.ef", label: "mutable state via a state effect",
    want: "9\nunit\n"},
  {file: "ignore_value.ef", label: "discarded expression statements",
    want: "42\n0\n"},
  {file: "ignore_value_basic.ef", label: "one discarded expression",
    want: "42\n0\n"},
  {file: "just_main.ef", label: "minimal program value",
    want: "0\n"},
  {file: "local_decl.ef", label: "a := binding inside a block is local to that block",
    want: "5\nunit\n"},
  {file: "literals.ef", label: "decimal rewrites of binary/hex/scientific forms across the six widths",
    want: "1571\n"},
  {file: "named_struct.ef", label: "named-tuple field access",
    want: "25\n"},
  {file: "nested_break_continue.ef", label: "flag replaces break/continue",
    want: "15\n"},
  {file: "man_or_boy.ef", label: "Knuth's man-or-boy test: mutable capture across recursive closures",
    want: "-67\n"},
  {file: "newton.ef", label: "iterative numeric effect loop",
    want: "1.4142156862745097\nunit\n"},
  {file: "point.ef", label: "alias, identity equality, one-element array",
    want: "42\n"},
  {file: "parametric_alias.ef", label: "parametric aliases substitute into annotations and signatures",
    want: "21\n"},
  {file: "pointer_operations.ef", label: "dereferences as binding aliases",
    want: "52\n"},
  {file: "poly_id_breaks.ef", label: "deliberately ill-typed, but runs under `any`",
    want: "5\nunit\n"},
  {file: "reference_null.ef", label: "no null in ef: direct field read",
    want: "10\n"},
  {file: "return_literals.ef", label: "literal-returning functions",
    want: "255\n"},
  {file: "raytracer.ef", label: "renders two spheres over a checkerboard plane",
    wantFile: "raytracer.expected.txt.gz"},
  {file: "sieve.ef", label: "effectful pipeline produces primes up to 100",
    want: `${[
      2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47,
      53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
    ].join("\n")}\nunit\n`},
  {file: "simple_add.ef", label: "Apply effect via the default host interpretation",
    want: "2\nunit\n"},
  {file: "slice_usage.ef", label: "len/get/sub on a three-element array",
    want: "5\n"},
  {file: "squares_sum.ef", label: "final expression evaluates to 30",
    want: "30\n"},
  {file: "star.ef", label: "renders identically in interpreter and wasm (bounded prefix)",
    args: ["6", "2"], bounded: true},
  {file: "struct_allocation.ef", label: "separately built tuples differ",
    want: "0\n"},
  {file: "sum_to_n.ef", label: "recursive sum via if expression",
    want: "55\n"},
  {file: "tco.ef", label: "deep tail recursion does not overflow",
    want: "0\nunit\n"},
  {file: "tuples.ef", label: "positional literals, named access, vec3_add",
    want: "41\n"},
  {file: "two_prints.ef", label: "top-level statements run in order",
    want: "6\n7\nunit\n"},
  {file: "unary.ef", label: "! and unary minus, @as as bool-to-int cast",
    want: "-5\n"},
  {file: "unify.ef", label: "type unifier picks the right branch",
    want: "2\nunit\n"},
];

// One driver generates the whole suite from the two tables, so the row
// assertion and the completeness check are written exactly once: every row
// becomes a test, and each table also gets a completeness guard asserting
// its files are exactly the .ef files in its directory. A file without a
// table entry fails the guard, and so does a stale entry after a file is
// deleted. (Non-.ef files — the raytracer golden output, .wasm artifacts
// dropped next to the example sources by `ef wasm` — are not programs.)
const TABLES = [
  {name: "fixtures (testdata/*.ef)", dir: testdataDir, rows: FIXTURES},
  {name: "examples (examples/*.ef)", dir: examplesDir, rows: EXAMPLES},
];

for (const {name, dir, rows} of TABLES) {
  describe(name, () => {
    for (const row of rows) {
      // Every row gets the same generous timeout: slow examples (raytracer
      // at ~6s) exceed bun's 5s default, everything else finishes far under.
      test(row.label ?? row.file, async () => {
        if (row.bounded === true) {
          await boundedPrefix(join(dir, row.file), row.args ?? []);
          return;
        }
        const src = readFileSync(join(dir, row.file), "utf8");
        const interp = runOnce("run", src, row.file, row.args ?? []);
        const wasm = runOnce("runwasm", src, row.file, row.args ?? []);
        // The interpreter↔wasm parity check: both backends must agree on
        // the full stdout and exit code — values, every side effect, and
        // error messages alike.
        expect(wasm).toEqual(interp);
        const want = row.wantFile !== undefined
          ? new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(testdataDir, row.wantFile))))
          : row.want;
        if (want === undefined) throw new Error(`no expected output for ${row.file}`);
        expect(interp.stdout).toBe(want);
        expect(interp.code).toBe(row.code ?? 0);
      }, 60000);
    }
    test(`${name}: table files are exactly the directory's .ef files`, () => {
      const files = readdirSync(dir).filter(f => f.endsWith(".ef"));
      expect(files.sort()).toEqual([...new Set(rows.map(r => r.file))].sort());
    });
  });
}

