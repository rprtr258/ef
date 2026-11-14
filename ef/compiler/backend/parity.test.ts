// Every file in examples/ is exercised by a test: one entry per file in the
// EXAMPLES table below, keyed by the example filename. The test bodies are
// generated from the table, and the coverage guard at the bottom asserts
// that the table's keys are exactly the .ef files on disk — so a new example
// file without a table entry (and the real test body the entry carries)
// fails the run, and a stale entry for a deleted file fails too.
//
// Tests run the compiler in-process (run / runWasm), capturing the stdout
// the CLI would print: Println!'s console.log lines, Out!'s raw
// process.stdout.write chunks, then the top-level result's show() line (see
// runOne). Each test also runs the wasm backend and asserts the wasm result
// coincides with the interpreter's (runExample). Exit! is intercepted with
// a thrown sentinel (the default host interpretation is process.exit, which
// would kill the test runner) and Random! is driven by a local seed-42
// mulberry32, so Random!-driven examples (approx_pi.ef) are reproducible
// and parity-checked exactly like the rest. The CLI executable surface
// itself (argv, exit codes, stderr) is smoke-tested separately in
// cli.test.ts.
//
// star.ef is the exception in shape, not in coverage: it is an infinite
// animation loop, so instead of runExample it is compared against the
// interpreter over a bounded output prefix (compile health for every
// example, star included, is asserted in wasm.test.ts).
import {test, expect, describe} from "bun:test";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {run} from "./interpreter/eval.ts";
import {runWasm} from "./wasm/wasm_host.ts";
import {num, show, type Value} from "../env.ts";

// The value-level interpreter↔wasm parity check: for the same program,
// `run(src)` (the interpreter) and `runWasm(src)` must produce the same
// `show()` rendering — values AND error messages.
function parity(src: string) {
  const interpOut = ((): string => {
    try {
      return show(run(src));
    } catch (e) {
      return "ERR: " + (e as Error).message;
    }
  })();
  const wasm = ((): string => {
    try {
      return show(runWasm(src));
    } catch (e) {
      return "ERR: " + (e as Error).message;
    }
  })();
  expect(wasm).toBe(interpOut);
  return interpOut;
}

const compilerDir = join(import.meta.dir, ".."); // compiler/ — cli.ts and the examples/ paths below are relative to it

type RunResult = {stdout: string, code: number};

// The default host interpretation of Exit! is process.exit, which would
// kill the test runner; runOne swaps it for this sentinel and maps it back
// to an exit code at its boundary.
class ExitSignal extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

// Local mulberry32 PRNG seeded with 42, standing in for Math.random(): the
// interpreter and the wasm host would otherwise draw from the same global
// Math.random() stream sequentially, so Random!-driven examples would fail
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

// Runs one example through one backend in-process and returns the stdout
// the CLI would print, plus the exit code (Exit! mapped from the sentinel).
// Printed output is captured by swapping console.log (Println!) and
// process.stdout.write (Out!) around the run, then the top-level result is
// appended as the CLI's final show() line. argv mimics the CLI's shape —
// the `args` builtin and wasm's ef_args host import read
// process.argv.slice(2) at call time, and approx_pi.ef counts the
// subcommand as part of its argv.
function runOne(mode: "run" | "runwasm", example: string, args: string[]): RunResult {
  const file = join(compilerDir, "..", "examples", example);
  const src = readFileSync(file, "utf8");
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
        ? run(src, {
            Exit: a => { throw new ExitSignal(num(a[0])); },
            Random: (_a, k) => k(rand()),
          })
        : runWasm(src, {
            Exit: a => { throw new ExitSignal(num(a[0])); },
            Random: (_a, k) => k(rand()),
          });
    } catch (e) {
      if (e instanceof ExitSignal) return {stdout: chunks.join(""), code: e.code};
      throw e;
    }
    return {stdout: chunks.join("") + show(value) + "\n", code: 0};
  } finally {
    console.log = realLog;
    process.stdout.write = realWrite;
    process.argv = savedArgv;
  }
}

// Runs the example through both backends and asserts the wasm result
// coincides with the interpreter's (stdout + exit code); returns the
// interpreter result.
function runExample(example: string, args: string[] = []): RunResult {
  const interp = runOne("run", example, args);
  const wasm = runOne("runwasm", example, args);
  expect(wasm).toEqual(interp);
  return interp;
}

// One entry per examples/*.ef: the table IS the test suite. The test bodies
// are generated from it (the loop below), and the coverage guard at the
// bottom asserts that the table's keys are exactly the .ef files in
// examples/ — a new example file without an entry (and the real test body
// the entry carries) fails the run, and a stale entry for a deleted file
// fails too. A body receives the interpreter's run result (the wasm backend
// has already been run and parity-checked against it inside runExample);
// `self: true` bodies instead receive the filename and do their own running
// — used only by star.ef, whose infinite animation loop can never run to
// completion. Multiple cases per file are allowed (approx_pi.ef, star.ef);
// only star.ef needs a custom timeout.
type ExampleCase = {
  label: string,
  timeout?: number,
} & (
| {
  // `self?: undefined` + `self: true` is a proper TS discriminant: it
  // lets contextual typing pick the branch for each table entry (and
  // `c.self === true` narrow it in the loop below).
  self?: undefined,
  args?: string[],
  body: (res: RunResult) => void | Promise<void>,
}
| {
  self: true,
  body: (file: string) => void | Promise<void>,
});

const EXAMPLES: Record<string, ExampleCase[]> = {
  "amb.ef": [{
    label: "nondeterministic search finds Pythagorean triples",
    timeout: 60000,
    body: res => expect(res.stdout).toBe("[3, 4, 5]\n[5, 12, 13]\n[6, 8, 10]\nunit\n"),
  }],
  "apply.ef": [{
    label: "polymorphic apply calls functions stored in values",
    body: res => expect(res.stdout).toBe("42\n\"n=7\"\n99\nunit\n"),
  }],
  "bitwise.ef": [{
    label: "logical bool ops; widths with @as; shifts as arithmetic",
    body: res => expect(res.stdout).toBe("25\n"),
  }],
  "bool_equality.ef": [{
    label: "bool equality converted to int via @as",
    body: res => expect(res.stdout).toBe("1\n"),
  }],
  "bool_logic.ef": [{
    label: "&& / || classification",
    body: res => expect(res.stdout).toBe("6\n"),
  }],
  "bracketed_expr.ef": [{
    label: "parenthesized grouping",
    body: res => expect(res.stdout).toBe("8\n"),
  }],
  "cast_roundtrip.ef": [{
    label: "i64 -> f64 -> +1 -> i64 via @as",
    body: res => expect(res.stdout).toBe("42\n"),
  }],
  "widths.ef": [{
    label: "f32 precision, @as conversions, division and wraparound parity",
    timeout: 60000, // ~4s alone; tips over the 5s default under full-suite load
    body: res => {
      const lines = res.stdout.split("\n");
      // f32 rounding: 0.1f32 + 0.2f32 != 0.1f64 + 0.2f64.
      expect(lines[0]).toBe("0.30000001192092896");
      expect(lines[1]).toBe("0.30000000000000004");
      expect(lines[2]).toBe("0.3333333432674408");
      // f32 equality is f32-exact (line 8); truncation signs (lines 10-11).
      expect(lines[7]).toBe("true");
      expect(lines[9]).toBe("-3");
      expect(lines[10]).toBe("-1");
      // i32/u32 wraparound: native mod-2^32 ops in both backends.
      expect(lines[16]).toBe("-2147483648"); // INT_MAX + 1
      expect(lines[17]).toBe("2147483647"); // INT_MIN - 1
      expect(lines[18]).toBe("-2"); // INT_MAX * 2
      expect(lines[19]).toBe("0"); // u32 4294967295 + 1 wraps to 0
      expect(lines[20]).toBe("4294967295"); // u32 0 - 1 wraps to 2^32 - 1
      // Signed vs unsigned ordering of the same bits.
      expect(lines[22]).toBe("true");
      expect(lines[23]).toBe("true");
      // i64/u64 exactness beyond 2^53: BigInt at the wasm
      // boundary, wraps at 2^63/2^64, signed vs unsigned ordering.
      expect(lines[25]).toBe("9007199254740993"); // 2^53 + 1 is exact
      expect(lines[26]).toBe("false");
      expect(lines[27]).toBe("-9223372036854775808"); // INT64_MAX + 1 wraps
      expect(lines[28]).toBe("0"); // UINT64_MAX + 1 wraps
      expect(lines[29]).toBe("true"); // 2^63 signed is negative
      expect(lines[30]).toBe("true"); // 2^63 unsigned is positive
    },
  }],
  "approx_pi.ef": [{
    label: "Monte Carlo pi estimate (Random!) needs an n argument",
    body: res => expect(res).toEqual({code: 1, stdout: "Usage: ef run examples/approx_pi.ef <n>\n"}),
  }, {
    label: "converges toward pi for large n",
    args: ["10000"],
    body: res => {
      // runOne seeds Random! with a local seed-42 mulberry32, so both
      // backends sample the same points and must print the same estimate
      // (checked by runExample's parity).
      const pi = Number(res.stdout.split("\n")[0]);
      expect(pi).toBeCloseTo(3.14, 1);
    },
  }],
  "block.ef": [{
    label: "a block runs statements in order and yields the last value",
    body: res => expect(res.stdout).toBe("42\n99\n123\nunit\n"),
  }],
  "closure_capture.ef": [{
    label: "closure reads enclosing binding",
    body: res => expect(res.stdout).toBe("10\n"),
  }],
  "closure_make_adder.ef": [{
    label: "returned closure adds 3",
    body: res => expect(res.stdout).toBe("7\n"),
  }],
  "closure_make_adder2.ef": [{
    label: "returned closure adds 10",
    body: res => expect(res.stdout).toBe("15\n"),
  }],
  "closure_nested.ef": [{
    label: "apply_twice(inc)(5)",
    body: res => expect(res.stdout).toBe("7\n"),
  }],
  "closure_no_capture.ef": [{
    label: "closure without captures",
    body: res => expect(res.stdout).toBe("1\n"),
  }],
  "collatz.ef": [{
    label: "Println! from nested while/if loops",
    body: res => expect(res.stdout).toBe(`${[
      7, 22, 11, 34, 17, 52, 26, 13, 40, 20, 10, 5, 16, 8, 4, 2, 1, 55,
    ].join("\n")}\n1\n`),
  }],
  "comments.ef": [{
    label: "comments plus naive Fibonacci",
    body: res => expect(res.stdout).toBe("55\n"),
  }],
  "complex_indexing.ef": [{
    label: "expression as element index",
    body: res => expect(res.stdout).toBe("3\n"),
  }],
  "control_constructs.ef": [{
    label: "if/while nesting, done-flag break",
    body: res => expect(res.stdout).toBe(`${[
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
    ].join("\n")}\n44\n`),
  }],
  "closure.ef": [{
    label: "a returned closure keeps reading its captured environment",
    body: res => expect(res.stdout).toBe("7\nunit\n"),
  }],
  "example.ef": [{
    label: "handler loops over a whole search space",
    body: res => expect(res.stdout).toBe("[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]\n"),
  }],
  "equality_all_types.ef": [{
    label: "int equality",
    body: res => expect(res.stdout).toBe("1\n"),
  }],
  "expression_indexing.ef": [{
    label: "variable as element index",
    body: res => expect(res.stdout).toBe("20\n"),
  }],
  "extended_access.ef": [{
    label: "element store through a variable index",
    body: res => expect(res.stdout).toBe("43\n"),
  }],
  "external_function.ef": [{
    label: "Println! then a discarded value",
    body: res => expect(res.stdout).toBe("42\n0\n"),
  }],
  "f32_arithmetic.ef": [{
    label: "f32 addition rounds to f32 precision",
    body: res => expect(res.stdout).toBe("6\n"),
  }],
  "f64_comparison.ef": [{
    label: "f64 comparison converted to int via @as",
    body: res => expect(res.stdout).toBe("1\n"),
  }],
  "factorial.ef": [{
    label: "recursion via if expression",
    body: res => expect(res.stdout).toBe("120\n"),
  }],
  "fibonacci_function.ef": [{
    label: "fib(10)",
    body: res => expect(res.stdout).toBe("55\n"),
  }],
  "functional.ef": [{
    label: "let-generalized polymorphic id",
    body: res => expect(res.stdout).toBe("1\n0\n"),
  }],
  "fib.ef": [{
    label: "exponential recursion through the CPS evaluator",
    body: res => expect(res.stdout).toBe("196418\nunit\n"),
  }],
  "gc.ef": [{
    label: "aliases, slices, element reads",
    body: res => expect(res.stdout).toBe("115\n"),
  }],
  "gc_alias.ef": [{
    label: "aliasing plus identity tuple equality",
    body: res => expect(res.stdout).toBe("79\n"),
  }],
  "incA.ef": [{
    label: "mutable state via a state effect",
    body: res => expect(res.stdout).toBe("9\nunit\n"),
  }],
  "ignore_value.ef": [{
    label: "discarded expression statements",
    body: res => expect(res.stdout).toBe("42\n0\n"),
  }],
  "ignore_value_basic.ef": [{
    label: "one discarded expression",
    body: res => expect(res.stdout).toBe("42\n0\n"),
  }],
  "just_main.ef": [{
    label: "minimal program value",
    body: res => expect(res.stdout).toBe("0\n"),
  }],
  "local_decl.ef": [{
    label: "a := binding inside a block is local to that block",
    body: res => expect(res.stdout).toBe("5\nunit\n"),
  }],
  "literals.ef": [{
    label: "decimal rewrites of binary/hex/scientific forms across the six widths",
    body: res => expect(res.stdout).toBe("1571\n"),
  }],
  "named_struct.ef": [{
    label: "named-tuple field access",
    body: res => expect(res.stdout).toBe("25\n"),
  }],
  "nested_break_continue.ef": [{
    label: "flag replaces break/continue",
    body: res => expect(res.stdout).toBe("15\n"),
  }],
  "man_or_boy.ef": [{
    label: "Knuth's man-or-boy test: mutable capture across recursive closures",
    body: res => expect(res.stdout).toBe("-67\n"),
  }],
  "newton.ef": [{
    label: "iterative numeric effect loop",
    body: res => expect(res.stdout).toMatch(/^1\.4142\d*\nunit\n$/),
  }],
  "point.ef": [{
    label: "alias, identity equality, one-element array",
    body: res => expect(res.stdout).toBe("42\n"),
  }],
  "parametric_alias.ef": [{
    label: "parametric aliases substitute into annotations and signatures",
    body: res => expect(res.stdout).toBe("21\n"),
  }],
  "pointer_operations.ef": [{
    label: "dereferences as binding aliases",
    body: res => expect(res.stdout).toBe("52\n"),
  }],
  "poly_id_breaks.ef": [{
    label: "deliberately ill-typed, but runs under `any`",
    body: res => expect(res.stdout).toBe("5\nunit\n"),
  }],
  "reference_null.ef": [{
    label: "no null in ef: direct field read",
    body: res => expect(res.stdout).toBe("10\n"),
  }],
  "return_literals.ef": [{
    label: "literal-returning functions",
    body: res => expect(res.stdout).toBe("255\n"),
  }],
  "raytracer.ef": [{
    label: "renders two spheres over a checkerboard plane",
    timeout: 60000,
    body: res => {
      // The image format: 200 scanlines of 600 R/G/B lines each, closed by
      // a -1 row separator, then the runner's final `unit` echo. All values
      // land in [0, 1.5] — checker grays, clamped shading, and separators.
      const lines = res.stdout.split("\n");
      expect(lines[lines.length - 1]).toBe("");
      expect(lines[lines.length - 2]).toBe("unit");
      const px = lines.slice(0, 200 * 601);
      expect(px.length).toBe(200 * 601);
      let bad = "";
      for (let i = 0; i < px.length && bad === ""; i++) {
        if (i % 601 === 600) {
          if (px[i] !== "-1") bad = `line ${i}: expected -1 separator, got ${px[i]}`;
          continue;
        }
        const v = Number(px[i]);
        if (px[i] === "" || Number.isNaN(v) || v < 0 || v > 1.5) bad = `line ${i}: unexpected ${px[i]}`;
      }
      expect(bad).toBe("");
    },
  }],
  "sieve.ef": [{
    label: "effectful pipeline produces primes up to 100",
    body: res => expect(res.stdout).toBe(`${[
      2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47,
      53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
    ].join("\n")}\nunit\n`),
  }],
  "simple_add.ef": [{
    label: "Apply effect via the default host interpretation",
    body: res => expect(res.stdout).toBe("2\nunit\n"),
  }],
  "slice_usage.ef": [{
    label: "len/get/sub on a three-element array",
    body: res => expect(res.stdout).toBe("5\n"),
  }],
  "squares_sum.ef": [{
    label: "final expression evaluates to 30",
    body: res => expect(res.stdout).toBe("30\n"),
  }],
  // star.ef is an infinite animation loop: it cannot run to completion, so
  // its self: true body (moved here from wasm.test.ts's split re-emission
  // regressions) does its own running — a bounded (timeout + output cap)
  // cross-backend comparison. Compile health for every example (star
  // included) is asserted in wasm.test.ts via assertModule.
  "star.ef": [{
    label: "renders identically in interpreter and wasm (bounded prefix)",
    self: true,
    body: async file => {
      // Output-bounded, not wall-clock-bounded: read stdout until the
      // 3000-char cap is reached, then kill the child. Bytes are
      // load-independent: slower machines just take longer to fill the
      // cap. If star ever stops producing output (a real regression), the
      // read blocks until the test-level timeout fails the test.
      const runBounded = async (mode: string): Promise<string> => {
        const p = Bun.spawn(
          ["bun", "run", "cli.ts", mode, `../examples/${file}`, "6", "2"],
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
      // The first frame is deterministic; later frames diverge only by wall
      // clock (the animation spins unbounded), so compare a prefix inside it.
      const prefixLen = Math.min(interp.length, wasm.length);
      expect(prefixLen).toBeGreaterThanOrEqual(1000);
      expect(wasm.slice(0, prefixLen)).toBe(interp.slice(0, prefixLen));
    },
    timeout: 90000,
  }],
  "struct_allocation.ef": [{
    label: "separately built tuples differ",
    body: res => expect(res.stdout).toBe("0\n"),
  }],
  "sum_to_n.ef": [{
    label: "recursive sum via if expression",
    body: res => expect(res.stdout).toBe("55\n"),
  }],
  "tco.ef": [{
    label: "deep tail recursion does not overflow",
    body: res => expect(res.stdout).toBe("0\nunit\n"),
  }],
  "tuples.ef": [{
    label: "positional literals, named access, vec3_add",
    body: res => expect(res.stdout).toBe("41\n"),
  }],
  "two_prints.ef": [{
    label: "top-level statements run in order",
    body: res => expect(res.stdout).toBe("6\n7\nunit\n"),
  }],
  "unary.ef": [{
    label: "! and unary minus, @as as bool-to-int cast",
    body: res => expect(res.stdout).toBe("-5\n"),
  }],
  "unify.ef": [{
    label: "type unifier picks the right branch",
    body: res => expect(res.stdout).toBe("2\nunit\n"),
  }],
};

for (const [file, cases] of Object.entries(EXAMPLES)) {
  describe(file, () => {
    for (const c of cases) {
      if (c.self === true) {
        const {body, timeout} = c;
        test(c.label, () => body(file), timeout);
      } else {
        const {body, args, timeout} = c;
        test(c.label, () => body(runExample(file, args)), timeout);
      }
    }
  });
}

// Coverage guard: the EXAMPLES table above must name exactly the .ef files
// in examples/. A newly added example without a table entry fails here, and
// so does a stale entry after a file is deleted. (Non-.ef files, e.g. .wasm
// artifacts dropped next to the sources by `buildwasm`, are not examples.)
test("every file in examples/ is exercised by a test", () => {
  const files = readdirSync(join(compilerDir, "..", "examples")).filter(f => f.endsWith(".ef"));
  expect(files.sort()).toEqual(Object.keys(EXAMPLES).sort());
});

// Language-feature parity: one assertion per language construct, both
// backends, via the shared parity() helper (backend/parity.ts). This is the
// fine-grained sibling of the per-example table above; wasm-internal
// assertions (module structure, slots, ABI, host imports) stay in
// wasm.test.ts — those suites use parity() only as the observable.
describe("language-feature parity: interpreter ↔ wasm", () => {
test("arithmetic: i64 / f64 division, neg, mod", () => {
    expect(parity("7 / 2")).toBe("3"); // i64 division truncates
    expect(parity("7.0 / 2")).toBe("3.5");
    expect(parity("-5 + 3")).toBe("-2");
    expect(parity("17 % 5")).toBe("2");
    // Integer division by zero traps instead of producing Infinity.
    expect(() => run("1 / 0")).toThrow(/integer divide by zero/);
  });

test("unstamped operator sites apply the interpreter's own operators via ef_binop", () => {
    // Sites the checker leaves unstamped — string `+` and string
    // comparisons — call the operator's trampoline, which routes through
    // the ef_binop host import: the interpreter's own operator closure
    // runs, so value- and error-parity hold by construction.
    expect(parity("\"a\" + \"b\"")).toBe("\"ab\"");
    expect(parity("Println!(\"a\" < \"b\")")).toBe("ERR: Expected number, got \"a\"");
    expect(parity("Println!(\"z\" > \"b\")")).toBe("ERR: Expected number, got \"z\"");
  });

test("comparisons and equality", () => {
    expect(parity("if (3 < 5) { 10 } else { 20 }")).toBe("10");
    expect(parity("\"ab\" == \"ab\"")).toBe("true");
    expect(parity("\"a\" != \"b\"")).toBe("true");
    expect(parity("[1,2] == [1,2]")).toBe("false"); // arrays by identity
    expect(parity("1 != 2")).toBe("true");
  });

test("any-typed equality is value-based across all six widths", () => {
    // The $eq helper matches the interpreter's JS === on values exactly:
    // same-representation numbers compare by value (f32 promotes, i32/u32
    // convert), BigInt is never === a Number, and mixed i64/u64 compares
    // the BigInt values (not the bits).
    const eq = "eq :: fn(a: any, b: any) { a == b }; ";
    expect(parity(eq + "eq(1.5, 1.5)")).toBe("true");
    expect(parity(eq + "eq(@as(1.5, f32), @as(1.5, f32))")).toBe("true");
    expect(parity(eq + "eq(@as(5, i32), @as(5, u32))")).toBe("true");
    expect(parity(eq + "eq(@as(5, i32), @as(5, i32))")).toBe("true");
    expect(parity(eq + "eq(@as(5, i64), @as(5, u64))")).toBe("true");
    // Same bits, different BigInt values.
    expect(parity(eq + "eq(@as(-1, i64), @as(18446744073709551615, u64))")).toBe("false");
    expect(parity(eq + "eq(@as(5, i64), 5.0)")).toBe("false"); // BigInt vs Number
    expect(parity(eq + "eq(@as(5, i32), @as(5, i64))")).toBe("false");
    expect(parity(eq + "eq(true, true)")).toBe("true");
    expect(parity(eq + "eq(\"x\", \"x\")")).toBe("true");
    expect(parity(eq + "eq(1, 2)")).toBe("false");
  });

test("tail operator after a land call dispatches through the RET cell", () => {
    // The inlined operators share the fixed shape: the tail value returns
    // to the enclosing wrapper, which dispatches it through the
    // continuation.
    expect(parity(`f :: fn(x: i64): i64 { x / 2 };
      y :: f(10);
      y + 1`)).toBe("6");
    expect(parity(`f :: fn(x: i64): i64 { x + 1 };
      y :: f(10);
      y * 2`)).toBe("22");
    // Tail operator with a performing operand: the resumed value must
    // dispatch through the real handler chain, not just a RET cell.
    expect(parity(`effect Op(): i64;
      handle { f :: fn(x: i64): i64 { x / 2 }; f(Op!()) + 1 }
      case Op() => k { k(10) }`)).toBe("6");
  });

test("strings: concat, len", () => {
    expect(parity("\"ab\" + \"cd\"")).toBe("\"abcd\"");
    parity("len(\"héllo\")"); // len is array-only: both reject identically
    expect(parity("strlen(\"héllo\")")).toBe("5");
  });

test("control flow: if / while / blocks", () => {
    expect(parity("i := 0; s := 0; while (i < 5) { s = s + i; i = i + 1 }; s")).toBe("10");
    // blocks with inner lets (lambda body = block sharing the frame)
    expect(parity("f :: fn() { a :: 2; b :: 3; a * b }; f()")).toBe("6");
  });

test("arrays: get/set/sub views, strict set, flat, concat, map", () => {
    expect(parity("get([10,20,30], 1)")).toBe("20");
    // set is strictly in-window: no growth past the end, identical error.
    expect(parity("a :: [1]; set(a, 3, 9)")).toBe("ERR: set: index 3 out of bounds [0, 1)");
    // sub returns a zero-copy view: writes through the original show up.
    expect(parity("s :: [1, 2, 3, 4]; v :: sub(s, 1, 3); set(s, 1, 99); v")).toBe("[99, 3]");
    expect(parity("s :: [1, 2, 3]; sub(s, 5, 6)")).toBe("ERR: sub: range [5, 6) out of bounds [0, 3)");
    // A huge i64 index must not wrap to a small in-bounds i32 (wasm parity).
    expect(parity("get([1, 2, 3], 4294967296)")).toBe("ERR: get: index 4294967296 out of bounds [0, 3)");
    expect(parity("len(flat([[1,2],[3]]))")).toBe("3");
    expect(parity("concat([1], [2,3])")).toBe("[1, 2, 3]");
    expect(parity("map(fn(x) { x * x }, range(0, 4, 1))")).toBe("[0, 1, 4, 9]");
    expect(parity("get(get([[1,2],[3,4]], 1), 0)")).toBe("3");
  });

test("closures: creation, capture, immediate call of a returned closure", () => {
    expect(parity("addn :: fn(n: i64) { fn(x) { x + n } }; addn(10)(5)")).toBe("15");
    expect(parity("mk :: fn() { c := 0; fn() { c = c + 1; c } }; f :: mk(); f(); f(); f()")).toBe("3");
    expect(parity("f :: fn(a: i64) { fn(b: i64) { fn(c: i64) { a + b + c } } }; f(1)(2)(3)")).toBe("6");
    expect(parity("id :: fn(x) { x }; id(id)(3)")).toBe("3");
  });

test("recursion: non-tail and tail (return_call_indirect, O(1) wasm stack)", () => {
    expect(parity("fib :: fn(n: i64) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(15)")).toBe("610");
    expect(parity("lp :: fn(n: i64, acc: i64) { if (n == 0) { acc } else { lp(n - 1, acc + n) } }; lp(100000, 0)")).toBe("5000050000");
  });

test("math builtins", () => {
    expect(parity("round(sqrt(2) * 100) + abs(0 - 3)")).toBe("144");
    expect(parity("round(cos(0) * 10) + round(sin(0) * 10)")).toBe("10");
    // PI is a f64 value per the checker; the interpreter's runtime binds a
    // fn for it (interpreter quirk), so no parity here — pinned value instead.
    expect(show(runWasm("round(PI * 100)"))).toBe("314");
  });

test("f32 precision: typed f32 ops, $F32 boxes and @as conversions", () => {
    // Graduated from the step-1 interp-only block: every case now runs
    // through BOTH backends (parity) — f32 values are real $F32 boxes
    // computed with the f32 opcode family.
    expect(parity("@as(0.1, f32) + @as(0.2, f32)")).toBe("0.30000001192092896");
    expect(parity("@as(0.1 + 0.2, f32)")).toBe("0.30000001192092896");
    expect(parity("@as(1.0 / 3.0, f32)")).toBe("0.3333333432674408");
    expect(parity("@as(0.1, f32) + @as(0.2, f32) == @as(0.3, f32)")).toBe("true");
    // f64 stays f64: the same sum differs in the last digits.
    expect(parity("0.1 + 0.2")).toBe("0.30000000000000004");
    // f32 literals flowing through f32-typed positions (lets, params,
    // arrays) keep their box: the wildcard sources adapt at the unbox.
    expect(parity("a: f32 :: 0.1; b: f32 :: 0.2; a + b")).toBe("0.30000001192092896");
    expect(parity("add :: fn(x: f32, y: f32): f32 { x + y }; add(3.34, 2.71)")).toBe("6.050000190734863");
    expect(parity("x: f32 :: 1; x + 1")).toBe("2");
    expect(parity("map(fn(v: f32): f32 { v * v }, [@as(0.5, f32)]).0")).toBe("0.25");
    expect(parity("sqrt(@as(4.0, f32))")).toBe("2");
    expect(parity("neg(@as(1.5, f32))")).toBe("-1.5");
    expect(parity("@as(3.34, f32) * @as(2.71, f32)")).toBe("9.051400184631348");
    // f32 -> f64 promotes exactly; f64 -> f32 demotes (@as only).
    expect(parity("@as(@as(0.1, f32), f64)")).toBe("0.10000000149011612");
    expect(parity("@as(@as(0.1, f64), f32)")).toBe("0.10000000149011612");
    // Comparisons dispatch on the f32 stamp.
    expect(parity("@as(0.5, f32) < @as(0.7, f32)")).toBe("true");
    // f32 division is f32-precision (no int truncation).
    expect(parity("@as(1.0, f32) / @as(3.0, f32)")).toBe("0.3333333432674408");
    // f32 rem runs in the f64 plane and frounds at the site; the module
    // must validate (parity compiles + runs it, catching opcode type
    // mismatches binaryen rejects).
    expect(parity("@as(7.5, f32) % @as(2.0, f32)")).toBe("1.5");
    expect(parity("r :: fn(x: f32, y: f32): f32 { x % y }; r(@as(7.3, f32), @as(2.0, f32))")).toBe("1.3000001907348633");
  });

test("i32/u32 wraparound: native mod-2^32 ops, comparisons, @as", () => {
    // i32/u32 sites compute with i32.add/sub/mul (the wrap IS the
    // semantics) and the interpreter wraps through BigInt.asIntN/asUintN —
    // parity.
    expect(parity("x: i32 :: 2147483647; x + 1")).toBe("-2147483648");
    expect(parity("x: i32 :: -2147483648; x - 1")).toBe("2147483647");
    expect(parity("x: i32 :: 2147483647; x * 2")).toBe("-2");
    expect(parity("x: u32 :: 4294967295; x + 1")).toBe("0");
    expect(parity("x: u32 :: 0; x - 1")).toBe("4294967295");
    expect(parity("x: u32 :: 3000000000; x * 3")).toBe("410065408");
    // Signed vs unsigned comparison of the same bits (0xFFFFFFFF).
    expect(parity("@as(-1, i32) < @as(1, i32)")).toBe("true");
    expect(parity("@as(4294967295, u32) > @as(1, u32)")).toBe("true");
    // Strict same-width ops (D6): a mixed-width compare is a static type
    // error in both backends — the messages must match exactly.
    expect(parity("@as(-1, i32) < @as(4294967295, u32)")).toBe(
      "ERR: <: i32 and u32 are different numeric widths (use @as to convert)");
    // @as wrap: i64 -> i32 truncates mod 2^32 (asIntN), i64 -> u32 via asUintN.
    expect(parity("@as(4294967297, i32)")).toBe("1");
    expect(parity("@as(4294967297, u32)")).toBe("1");
    expect(parity("@as(-1, i32)")).toBe("-1");
    expect(parity("@as(-1, u32)")).toBe("4294967295");
    expect(parity("@as(@as(5, i32), i64)")).toBe("5");
    expect(parity("@as(@as(-5, i32), i64)")).toBe("-5");
    expect(parity("@as(@as(4294967295, u32), i64)")).toBe("4294967295");
    // Equality on the narrow widths compares the payload bits.
    expect(parity("@as(-1, i32) == @as(4294967295, i32)")).toBe("true");
    expect(parity("@as(-1, i32) == @as(1, i32)")).toBe("false");
  });

test("i32 division guards: divide by zero and INT_MIN / -1 fail identically", () => {
    // The wasm side routes both through ef_fail (not native traps), so the
    // error message and exit code match the interpreter exactly.
    expect(parity("x: i32 :: 1; x / 0")).toBe("ERR: integer divide by zero");
    expect(parity("x: i32 :: 1; x % 0")).toBe("ERR: integer divide by zero");
    expect(parity("x: u32 :: 1; x / 0")).toBe("ERR: integer divide by zero");
    expect(parity("x: i32 :: -2147483648; x / -1")).toBe("ERR: integer overflow");
    expect(parity("x: i32 :: -2147483648; x % -1")).toBe("0"); // rem_i32_s of INT_MIN by -1 is 0, no overflow
    // Untyped literals default to the i64 plane: native integer division,
    // trunc toward zero.
    expect(parity("7 / 2")).toBe("3");
    expect(parity("-7 / 2")).toBe("-3");
  });

test("i64/u64 wraparound: exact 64-bit BigInt arithmetic, comparisons, @as", () => {
    // i64/u64 sites compute with i64.add/sub/mul (the wrap IS the
    // semantics) and the interpreter wraps through BigInt.asIntN/asUintN —
    // parity, exact to 2^63 and beyond 2^53.
    expect(parity("x: i64 :: 9223372036854775807; x + 1")).toBe("-9223372036854775808");
    expect(parity("x: i64 :: -9223372036854775808; x - 1")).toBe("9223372036854775807");
    expect(parity("x: i64 :: 4611686018427387904; x * 2")).toBe("-9223372036854775808"); // 2^62 * 2 wraps to INT64_MIN
    expect(parity("x: i64 :: 4294967296; x * x")).toBe("0"); // 2^64 wraps to 0
    expect(parity("x: u64 :: 18446744073709551615; x + 1")).toBe("0");
    expect(parity("x: u64 :: 0; x - 1")).toBe("18446744073709551615");
    expect(parity("9007199254740993 + 0")).toBe("9007199254740993"); // 2^53 + 1 is exact
    // Signed vs unsigned comparison of the same bits (2^63 - 1 vs 2^63).
    expect(parity("x: i64 :: 9223372036854775807; x > 0")).toBe("true");
    expect(parity("@as(9223372036854775808, i64) < 0")).toBe("true");
    expect(parity("@as(9223372036854775808, u64) > 0")).toBe("true");
    // Strict same-width ops (D6) on the wide widths too.
    expect(parity("@as(1, i64) < @as(2, u64)")).toBe(
      "ERR: <: i64 and u64 are different numeric widths (use @as to convert)");
    // @as wrap: i64 -> i32 truncates mod 2^32 (asIntN), u64 -> u32 via asUintN.
    expect(parity("@as(4294967297, i64)")).toBe("4294967297"); // no truncation i64 -> i64
    expect(parity("@as(4294967297, i32)")).toBe("1");
    expect(parity("@as(18446744073709551615, u32)")).toBe("4294967295");
    expect(parity("@as(@as(5, i64), u64)")).toBe("5");
    // Equality on the wide widths compares the payload bits.
    expect(parity("@as(-1, i64) == @as(18446744073709551615, i64)")).toBe("true");
    expect(parity("9007199254740993 == 9007199254740993")).toBe("true");
    expect(parity("9007199254740993 == 9007199254740992")).toBe("false");
    // Division guards on the wide widths route through ef_fail identically.
    expect(parity("x: i64 :: 1; x / 0")).toBe("ERR: integer divide by zero");
    expect(parity("x: u64 :: 1; x % 0")).toBe("ERR: integer divide by zero");
    expect(parity("@as(-9223372036854775808, i64) / @as(-1, i64)")).toBe("ERR: integer overflow");
  });

test("builtins as values: references beyond call sites keep them emitted", () => {
    // A builtin passed as an argument still needs its closure cell.
    expect(parity("apply1 :: fn(f, x) { f(x) }; apply1(round, 2.6)")).toBe("3");
    // Multiple builtins-as-values, referenced inside lambdas.
    expect(parity(`f :: fn(g, x) { g(x) };
a :: f(round, 2.6);
b :: f(len, [1, 2, 3]);
a + b`)).toBe("6");
    // A builtin returned from a lambda and called at the site.
    expect(parity("mk :: fn() { len }; mk()([7, 8, 9])")).toBe("3");
  });

test("errors surface identically (typecheck + runtime)", () => {
    parity("nope + 1"); // Unbound: nope
    parity("1 + \"a\""); // type error from the check
    parity("get([1,2], 9)"); // get: index 9 out of bounds
    parity("head(1, 2, 3)"); // arity error
  });

test("handlers: user ops, resume, deep nesting, multi-shot", () => {
    // Single op, constant result.
    expect(parity("effect Op(): i64; handle { 1 + Op!() } case Op() => k { 7 }")).toBe("7");
    // Resume with different values.
    expect(parity("effect Op(): i64; handle { Op!() + Op!() } case Op() => k { k(3) }")).toBe("6");
    // Perform inside a lambda called twice; non-resuming case discards the rest.
    expect(parity("effect Op(): i64; handle { f :: fn() { Op!() }; f() + f() } case Op() => k { 1 }")).toBe("1");
    // Return case.
    expect(parity("effect Op(): i64; handle { 5 } case Op() => k { 0 }")).toBe("5");
    // Unhandled effect propagates past a non-matching inner handler.
    expect(parity("effect A(): i64; effect B(): i64; handle { handle { A!() } case B() => k { 99 } } case A() => k { 5 }")).toBe("5");
    // Matching inner handler fires first.
    expect(parity("effect A(): i64; handle { handle { A!() } case A() => k { 10 } } case A() => k { 20 }")).toBe("10");
    // Multi-shot resume via map: cross-product of two choices (the plan target).
    expect(parity(`effect Choose(opts: [i64]): i64;
      handle { x :: Choose!([1,2,3]); y :: Choose!([10,20]); [x, y] }
      case Return(v) => k { [v] }
      case Choose(opts) => k { flat(map(k, opts)) }`)).toBe("[[1, 10], [1, 20], [2, 10], [2, 20], [3, 10], [3, 20]]");
    // Non-resuming case aborts the rest of the body.
    expect(parity(`effect Div(a: i64, b: i64): i64;
      handle { r :: Div!(10, 0); [r] }
      case Div(a, b) => k { if (b == 0) { ["div by zero"] } else { k(a / b) } }`)).toBe("[\"div by zero\"]");
    // Deep handlers: a log threaded through nested resumes (resume in a
    // non-tail position inside concat).
    expect(parity(`effect Log(msg: string): unit;
      effect Result(v: string): unit;
      handle { Log!("a"); Log!("b"); Result!("42") }
      case Log(msg) => k { concat([msg], k(unit)) }
      case Result(v) => k { [v] }`)).toBe("[\"a\", \"b\", \"42\"]");
    // Propagation from inside a case body to the next handler.
    expect(parity(`effect Emit(m: string): unit;
      effect Other(m: string): unit;
      handle { handle { Emit!("hi") } case Other(m) => k { ["should-not-match"] } }
      case Emit(m) => k { [m] }`)).toBe("[\"hi\"]");
    // Inner handler with a Return case stays live around the resumed segment:
    // outer case resumes 3, segment yields 4, inner Return case wraps it.
    expect(parity(`effect A(): i64;
      handle { handle { A!() + 1 } case Return(v) => k { [v] } } case A() => k { k(3) }`)).toBe("[4]");
    // Builtin effect intercepted by a user handler.
    expect(parity("effect Read(): i64; handle { Read!() + 1 } case Read() => k { 41 }")).toBe("41");
    // Exit! intercepted without resuming: the code after it never runs.
    expect(parity(`handle { Out!("pre"); Exit!(42); Out!("post") }
      case Exit(c) => k { c }
      case Out(s) => k { Println!(s); k(unit) }`)).toBe("42");
    // Perform inside call arguments: two invocations get independent frames.
    expect(parity(`effect Op(): i64;
      handle { f :: fn(a: i64, b: i64): i64 { a + b }; f(Op!(), Op!()) }
      case Op() => k { k(3) }`)).toBe("6");
  }, 20000); // parity() spawns both runners per assertion; tips over the 5s default under suite load

test("mixed functions: row-{} body with an internal handle (direct boundary)", () => {
    // Island mid-body, result flows through the dret boundary to a pure call site.
    expect(parity(`effect Tick(n: i64): i64;
      mix :: fn(x: i64): i64 {
        handle { Tick!(x) + 1 } case Tick(n) => k { k(n * 10) }
      };
      mix(3) + mix(4)`)).toBe("72");
    // Tail handle: the HDL's next is the never-set $ret — the emitted cell
    // chains to the terminal return-cell, the case completion returns.
    expect(parity(`effect Tick(n: i64): i64;
      mix :: fn(x: i64): i64 {
        handle { Tick!(x) } case Tick(n) => k { n * 2 }
      };
      mix(21)`)).toBe("42");
    // Mixed callee inside another handler's island (generic-call context).
    expect(parity(`effect Tick(n: i64): i64;
      effect Tock(n: i64): i64;
      mix :: fn(x: i64): i64 {
        handle { Tick!(x) } case Tick(n) => k { n + 100 }
      };
      handle { mix(1) + Tock!(7) } case Tock(n) => k { k(n) }`)).toBe("108");
    // Multi-shot resume inside a mixed function (the amb shape): each Choose
    // resume re-enters the spine through the resume lambda's tail contCall;
    // propagating performs must reach the Emit island across the boundary.
    expect(parity(`effect Choose(lo: i64, hi: i64): i64;
      effect Emit(t: [i64]): unit;
      inner :: fn(n: i64): unit ! { Choose, Emit } {
        a :: Choose!(1, n);
        Emit!([a])
      };
      middle :: fn(n: i64): unit ! { Emit } {
        handle { inner(n) } case Choose(lo, hi) => k {
          each(fn(x, _) { k(x) }, range(lo, hi + 1, 1))
        }
      };
      outer :: fn(n: i64): [[i64]] {
        handle { middle(n) } case Emit(t) => k {
          concat([t], k(unit))
        } case Return(v) => k { [] }
      };
      outer(2)`)).toBe("[[1], [2]]");
  });
});

// Code-path regression parity: the wasm codegen paths' regression locks
// (effect cut modes, spine-gated resume typing, split re-emission,
// devirtualization, numeric ABI, host fail channel) observed through the
// shared parity() helper — the structural/plan-level twins of these suites
// stay in wasm.test.ts.
describe("backend regression parity: interpreter ↔ wasm", () => {
  // --- effect codegen regressions ---

  test("multi-param op: two-shot resume of a 2-param continuation", () => {
    // Return slots for a multi-param op must not alias across resumes.
    expect(parity("effect T(a: i64, b: i64): i64; handle { T!(1, 2) } case T(a, b) => k { x :: k(a); y :: k(b); x + y }")).toBe("3");
  });

  test("single-param op: two-shot resume, no call_indirect trap", () => {
    expect(parity("effect T(n: i64): i64; handle { T!(5) } case T(n) => k { x :: k(n); y :: k(n); x + y }")).toBe("10");
  });

  test("flat: scalar passthrough under a resuming handler", () => {
    // k resumes to a plain scalar; flat must pass scalars through instead of
    // treating them as single-element arrays (broke every flatmap before).
    expect(parity("effect T(): i64; handle { T!() } case T() => k { flat(map(k, [7, 8])) }")).toBe("[7, 8]");
  });

  test("flatmap over ints under no handler", () => {
    expect(parity("flat(map(fn(x: i64): [i64] { [x, x * 10] }, [1, 2, 3]))")).toBe("[1, 10, 2, 20, 3, 30]");
  });

  test("array literal elements survive suspension", () => {
    // Elements emitted before/after a perform inside the same array literal.
    expect(parity("effect Op(): i64; handle { [Op!(), Op!()] } case Op() => k { k(7) }")).toBe("[7, 7]");
    expect(parity("effect Op(): i64; handle { [1, 2, Op!(), Op!()] } case Op() => k { k(7) }")).toBe("[1, 2, 7, 7]");
    expect(parity("effect Op(): i64; handle { [[Op!(), 1], [2, [Op!()]]] } case Op() => k { k(7) }")).toBe("[[7, 1], [2, [7]]]");
  });

  test("div cut modes: performs in both div operand positions", () => {
    // The divisor's cut mode was mis-emitted, silently yielding wrong values.
    expect(parity("effect P(): f64; effect Q(): f64; handle { (7.0 / P!()) / Q!() } case P() => k { k(2.0) } case Q() => k { k(7.0) }")).toBe("0.5");
    expect(parity("effect P(): i64; effect Q(): i64; handle { (7 + P!()) / Q!() } case P() => k { k(2) } case Q() => k { k(7) }")).toBe("1");
  });

  test("perform inside a while condition", () => {
    // Split-mode while: the cond is a legal cut position (the cond-cut path
    // re-runs one pass with the resumed value).
    // A resuming handler drives the loop: the case body returns the live i,
    // so the cond sees 0,1,2 then 3 and the loop exits.
    expect(parity("effect Op(): i64; i := 0; handle { while (Op!() < 3) { i = i + 1 }; i } case Op() => k { k(i) }")).toBe("3");
    // A non-resuming case body abandons the loop: its value is the handle
    // block's value (the continuation is discarded).
    expect(parity("effect Op(): i64; i := 0; handle { while (Op!() < 3) { i = i + 1 }; i } case Op() => k { i }")).toBe("0");
    // Perform in the cond AND a body perform whose case body abandons the
    // continuation (finite: the cond resumes with the live i via the Op arm).
    expect(parity("effect Op(): i64; effect Twice(): i64; i := 0; handle { s := 0; while (Op!() < 3) { s = s + Twice!(); i = i + 1 }; s } case Op() => k { k(i) } case Twice() => k { 7 }")).toBe("7");
    expect(parity("effect Op(): i64; handle { s := 0; i := 0; while (i < 2) { s = s + Op!(); i = i + 1 }; s } case Op() => k { k(2) }")).toBe("4");
  });

  test("handle as a statement inside a while body", () => {
    expect(parity("effect Op(): i64; handle { s := 0; i := 0; while (i < 2) { s = s + handle { Op!() } case Op() => k2 { k2(10) }; i = i + 1 }; s } case Op() => k { k(3) }")).toBe("20");
  });

  test("dlet destructuring whose bound expressions perform", () => {
    // Two performs inside dlet bindings, one resumed non-trivially (k(k(4))).
    expect(parity("effect Op(): i64; handle { [x, y, z] :: [1, Op!(), 3]; [w] :: [x + z + Op!()]; w + y } case Op() => k { k(k(4)) }")).toBe("52");
  });

  test("loop operands reload from the frozen freeze across resumes", () => {
    // A loop-carried operand of a performing app must reload from the
    // letk's frozen freeze, never the live frame: a later loop pass
    // re-stores the temp while an older continuation of the same site is
    // still pending.
    expect(parity("effect Op(): i64; handle { s := 0; i := 0; while (i < 2) { s = s + i + Op!(); i = i + 1 }; s } case Op() => k { k(k(7)) }")).toBe("23");
    // Same reload behind an @as on the expression.
    expect(parity("effect Op(): i64; handle { s := 0; i := 0; while (i < 2) { s = s + @as(i + Op!(), i64); i = i + 1 }; s } case Op() => k { k(k(7)) }")).toBe("23");
  });

  // --- spine-gated resume typing: multi-shot resume over HOF loops ---

  test("abort idiom: a k-free case body skips the delivery constraint", () => {
    expect(parity(`effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
      handle { map(cb, [1, 2]) } case Op() => k { 42 }`)).toBe("42");
  });

  test("transforming handler: len outside, k(10) inside", () => {
    expect(parity(`effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
      len(handle { map(cb, [1, 2]) } case Op() => k { k(10) })`)).toBe("2");
  });

  test("multi-shot delivery over map: both deliveries land at their own element", () => {
    // Per-element land state: each iteration's land cell freezes its own
    // index, so re-delivery of a captured chain re-enters its own slot
    // instead of double-advancing a shared counter (plan repro 2 — a
    // shared-counter land double-advances here and misindexes the stores).
    expect(parity(`effect Op(): i64; cb :: fn(x: i64): i64 { Op!() };
      handle { map(cb, [1, 2]) } case Op() => k { q := k(10); k(11); q }`)).toBe("[11, 11]");
  });

  test("each multi-shot: the callback i argument tracks per-element land state", () => {
    // set()'s index is the callback's i: a shared land state would
    // double-advance past the element and misindex the stores.
    expect(parity(`effect Op(): unit; a := [0, 0, 0];
      cb :: fn(x: i64, i: i64): unit { Op!(); set(a, i, x); unit };
      handle { each(cb, [7, 8, 9]) } case Op() => k { q := k(unit); k(unit); q };
      a`)).toBe("[7, 8, 9]");
  });

  test("flatmap multi-shot: per-element land state (same land structure as map)", () => {
    expect(parity(`effect Op(): i64; cb :: fn(x: i64, i: i64): [i64] { [x + Op!(), i] };
      handle { flatmap(cb, [1, 2]) } case Op() => k { q := k(10); k(20); q }`)).toBe("[11, 0, 12, 1]");
  });

  test("each multi-shot unit shape: a delivery per resume", () => {
    expect(parity(`effect Op(): i64; acc := 0;
      cb :: fn(x: i64, i: i64): unit { acc = acc + x * 10 + i + Op!(); unit };
      handle { each(cb, [1, 2]) } case Op() => k { q := k(1); k(2); q };
      acc`)).toBe("35");
  });

  // --- split re-emission ---

  test("if with split sites in both arms: parity", () => {
    parity(`if (1 < 0) {
  Println!("then-arm");
  Println!("after-then")
} else {
  Println!("else-arm");
  Println!("after-else")
};
Println!("after")`);
  });

  test("if with a split site in one arm and a suspended condition path: parity", () => {
    parity(`x :: 0;
if (x < 1) { Println!("then") } else { Println!("else") };
Println!("tail")`);
  });

  test("nested-operand land call plus a sibling land call in one body: parity", () => {
    // A land-call result consumed as a nested OPERAND of another expression
    // in the same body as a second (bare let-RHS) land call.
    const src = `vDot :: fn(a: [f64], b: [f64]): f64 { (a.0 * b.0) + ((a.1 * b.1) + (a.2 * b.2)) };
sphereT2 :: fn(d: [f64], c: [f64], r: f64): f64 {
  a :: vDot(d, d);
  b :: -2.0 * vDot(d, c);
  a + b
};
Println!(sphereT2([0.1, 0.0, -2.5], [0.0, 0.0, -5.0], 1.5))`;
    // Compiled output must match the interpreter's stdout, not just its value.
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    let interp: string;
    let wasm: string;
    try {
      interp = show(run(src));
      lines.length = 0;
      wasm = show(runWasm(src));
    } finally {
      console.log = orig;
    }
    expect(lines).toEqual(["-18.740000000000002"]);
    expect(wasm).toBe(interp);
    expect(wasm).toBe("unit");
  });

  // --- devirtualization (behavioral half; the plan/annotation locks stay in wasm.test.ts) ---

  test("mutual recursion through nested closures: devirt with capts (env path) + inline rests", () => {
    // up captures down (capts non-empty): the static call still reads the
    // closure's env; down/up's rests inline. down(9) recurses 18 levels.
    const src = `down :: fn(n: i64): i64 {
  up :: fn(m: i64): i64 { if (m == 0) { 100 } else { 1 + down(m - 1) } };
  if (n == 0) { 0 } else { up(n) }
};
[down(4), down(0), down(9)]`;
    expect(parity(src)).toBe("[4, 0, 9]");
  });

  test("inline rest with nesting: while body dcalls, rest jumps back to the loop head", () => {
    const src = `id :: fn(x: i64): i64 { x + 1 };
s := 0;
i := 0;
while (i < 5) { s = s + id(i); i = i + 1 };
s`;
    expect(parity(src)).toBe("15");
  });

  test("dcall site on a resumed path: inline rest runs after a multi-shot resume", () => {
    // The dcall sits inside the continuation the handler resumes into; its
    // rest (`* 2` + boundary) runs inline on that path.
    const src = `effect Op(): i64;
id :: fn(x: i64): i64 { x + 1 };
handle { s := Op!(); id(s) * 2 } case Op() => k { k(1) }`;
    expect(parity(src)).toBe("4");
  });

  test("assign to a captured var after a dcalled pure fn returns (env path sees the write)", () => {
    // g captures k: the static call loads the closure and chains the callee
    // frame through its env; a later assign to k is visible through it.
    const src = `id :: fn(x: i64): i64 { x };
k := 7;
g :: fn(x: i64): i64 { x + k };
k = 42;
[g(1), id(k)]`;
    expect(parity(src)).toBe("[43, 42]");
  });

  test("tight map loop: pure direct callback specializes; performing callback stays generic", () => {
    // inc is pure+direct: map(inc, ...) emits a per-site tight loop fn.
    expect(parity("inc :: fn(x: i64): i64 { x + 1 }; map(inc, [1, 2, 3])")).toBe("[2, 3, 4]");
    expect(parity("inc2 :: fn(x: i64, i: i64): i64 { x + 1 }; each(inc2, [1, 2, 3])")).toBe("unit");
    // flatmap with a pure direct callback takes the tight loop too.
    expect(parity("dup :: fn(x: i64, i: i64): [i64] { [x, x] }; flatmap(dup, [1, 2])")).toBe("[1, 1, 2, 2]");
    // A performing callback: generic loop path under a resuming handler.
    const src = `effect Op(): i64;
performer :: fn(x: i64, i: i64): i64 { Op!() };
handle { each(performer, [1, 2, 3]) } case Op() => k { k(0) }`;
    expect(parity(src)).toBe("unit");
    // each's multi-shot resume re-enters the same land cell per element.
    const srcEach = `effect Op(): i64;
cb :: fn(x: i64, i: i64): i64 { Op!() };
handle { each(cb, [1, 2, 3]); Op!() } case Op() => k { k(k(0)) }`;
    expect(parity(srcEach)).toBe("0");
    // map with a single resume per perform: results collected across them.
    const src2 = `effect Op(): i64;
cb :: fn(x: i64): i64 { Op!() };
handle { map(cb, [1, 2]) } case Op() => k { k(10) }`;
    expect(parity(src2)).toBe("[10, 10]");
  });

  // --- numeric entry ABI (behavioral half; the emitText structural lock stays in wasm.test.ts) ---

  test("specialized calls at all six widths", () => {
    expect(parity("inc :: fn(n: i32): i32 { n + 1 }; inc(41)")).toBe("42");
    expect(parity("inc :: fn(n: u32): u32 { n + 1 }; inc(41)")).toBe("42");
    expect(parity("inc :: fn(n: i64): i64 { n + 1 }; inc(41)")).toBe("42");
    expect(parity("inc :: fn(n: u64): u64 { n + 1 }; inc(41)")).toBe("42");
    // f32 exercises the fround-at-producing-nodes discipline.
    expect(parity("dbl :: fn(n: f32): f32 { n * 2.0 }; dbl(1.5)")).toBe("3");
    expect(parity("dbl :: fn(n: f64): f64 { n * 2.0 }; dbl(1.5)")).toBe("3");
    // Multi-arg + division (traps and truncation stay interpreter-exact).
    expect(parity("f :: fn(a: i64, b: i64): i64 { a / b }; f(7, 2)")).toBe("3");
    expect(parity("f :: fn(a: i64, b: i64): i64 { a / b }; f(7, 0)")).toBe("ERR: integer divide by zero");
    // u64 keeps the unsigned op selection exact through the raw entry.
    expect(parity("f :: fn(a: u64, b: u64): u64 { a / b }; f(18446744073709551615, 2)")).toBe("9223372036854775807");
  });

  test("mixed-signature fn (one boxed param) stays on the boxed static call", () => {
    // A string param makes the signature non-numeric: no numeric entry, the
    // site takes the boxed T_DABI call — values and effects identical.
    expect(parity("f :: fn(n: i64, s: string): i64 { n + strlen(s) }; f(40, \"ab\")")).toBe("42");
  });

  test("polymorphic direct fn gets no numeric entry (boxed static call)", () => {
    // id's checker type keeps quantified type vars: deepRes leaves them
    // unbound, so no entry exists and both instantiations stay boxed.
    expect(parity("id :: fn(x) { x }; id(7)")).toBe("7");
    expect(parity("id :: fn(x) { x }; id(2.5)")).toBe("2.5");
    expect(parity("id :: fn(x) { x }; id(\"s\")")).toBe(String.raw`"s"`);
  });

  test("numeric fn inside a handler island", () => {
    // The handler island performs across the numeric call: the entry stays
    // boxed-free (the callee is handler-free) and the island machinery is
    // untouched.
    expect(parity(`effect Op(): i64;
h :: fn(x: i64): i64 { handle { Op!() + x } case Op() => k { k(2) } };
g :: fn(n: i64): i64 { n * 3 };
h(g(5))`)).toBe("17");
  });

  test("numeric entries carry the closure env for capts", () => {
    // The callee's body reads its captured env through the frame chain
    // (the entry's frame operand is the closure env).
    expect(parity(`k :: 100;
addk :: fn(n: i64): i64 { n + k };
addk(1) + addk(2)`)).toBe("203");
  });

  // --- host boundary ---

  test("array window OOB carries the field name through the fail channel", () => {
    expect(parity(`xs: [i64] :: [1, 2];
xs.5`)).toBe("ERR: .5: index 5 out of bounds [0, 2)");
  });

});

// Parity over the wasm-internal fixtures: the structural locks for these
// programs live in wasm.test.ts (module shape, host imports, plan
// annotations, emitText); these are their behavioral twins — the compiled
// module must still compute the same thing as the interpreter.
describe("parity over wasm-internal fixtures: interpreter ↔ wasm", () => {
  test("builtin shadowing: same checker message in both runners", () => {
    expect(parity("len :: fn(xs: [i64]): i64 { 42 }; len([1, 2, 3])"))
      .toBe("ERR: cannot shadow builtin 'len'");
  });

  test("unhandled user effect: static rejection in both runners", () => {
    // Same unhandled-effect error message as the interpreter, and the same
    // timing: both runners reject statically at their entry (exec / the wasm
    // pipeline) before anything runs.
    parity("effect Foo(n: i64): i64; Foo!(1) + 2");
  });

  test("handle as an operator operand", () => {
    expect(parity("effect Op(): i64; 1 + handle { Op!() } case Op() => k { 7 }")).toBe("8");
  });

  test("served builtins compute through the host imports", () => {
    expect(parity("char(97)")).toBe("\"a\"");
    expect(parity("round(cos(0) * 100)")).toBe("100");
    expect(parity("len(args())")).toBe(String(process.argv.slice(2).length));
  });

  test("shadowing a served builtin: same rejection in both runners", () => {
    expect(parity("char :: fn(x: i64): i64 { x }; char(97)"))
      .toBe("ERR: cannot shadow builtin 'char'");
  });

  test("a program using every served builtin computes", () => {
    parity("x :: round(cos(0) * 10) + round(sin(0) * 10) + strlen(char(97)) + number(\"2\") + len(args()); Println!(x); x");
  });

  test("binaryen shrink pass: semantics preserved", () => {
    parity("Println!(\"hi\"); f :: fn(x: i64): i64 ! { Println } { Println!(x); x * 2 }; f(21)");
  });

  test("split re-emission: land calls in both branches of a nested if-else", () => {
    expect(parity(`g :: fn(x: i64): i64 { x + 1 };
f :: fn(a: i64): i64 {
  if (a == 0) {
    if (g(a) == 1) { 1 } else { 2 }
  } else {
    if (g(a) == 1) { 3 } else { 4 }
  }
};
Println!(f(0))`)).toBe("unit");
  });

  test("devirt: mixed fn (row {} with an internal handle) reached by dcall", () => {
    expect(parity(`effect Op(): i64;
mixed :: fn(x: i64): i64 { handle { x + Op!() } case Op() => k2 { k2(100) } };
caller :: fn(x: i64): i64 { mixed(x) + 1 };
[caller(1), caller(2)]`)).toBe("[102, 103]");
  });

  test("numeric entry: escaping fn called generically rides the shape tag", () => {
    expect(parity(`apply :: fn(f: (i64) -> i64, x: i64): i64 { f(x) };
inc :: fn(n: i64): i64 { n + 1 };
dec :: fn(n: i64): i64 { n - 1 };
a :: inc(41);
apply(inc, 1) + apply(dec, 2) + a`)).toBe("45");
  });

  test("typed slots: while-body i64 assign exactness", () => {
    // 2^53+1 stays exact through the typed op temps and the boxed cells.
    expect(parity(`x := 9007199254740993;
i := 0;
while (i < 2) { x = x + 1; i = i + 1; Println!(i); }
x`)).toBe("9007199254740995");
  });

  test("typed slots: scope-frame elision keeps the resume-side hops right", () => {
    expect(parity(`effect Op(): i64;
s := 0;
handle { while (s < 3) { s = s + Op!() }; s } case Op() => k { k(3) }`)).toBe("3");
  });

  test("typed slots: multi-shot rest-thunk read after resume", () => {
    expect(parity(`effect Op(): i64;
x: i64 :: 10;
handle { Op!() } case Op() => k { k(1); k(2) } + x`)).toBe("12");
  });

  test("typed slots: escaping-closure capture (env path)", () => {
    expect(parity(`mk :: fn() { x: i64 :: 7; fn() { x } };
mk()()`)).toBe("7");
  });

  test("typed slots: case-fn depth>0 read (cross-fn reach)", () => {
    expect(parity(`effect Op(): i64;
y: i64 :: 5;
handle { y + Op!() } case Op() => k { k(y + 1) }`)).toBe("11");
  });

  test("typed slots: top-level captured assign (env path sees it)", () => {
    expect(parity(`acc := 0;
bump :: fn(v: i64): i64 { acc = acc + v; acc };
[bump(1), bump(2), acc]`)).toBe("[1, 3, 3]");
  });

  test("typed slots: f32 fround parity", () => {
    expect(parity(`a: f32 :: 0.1;
b: f32 :: 0.2;
a + b == @as(0.3, f32)`)).toBe("true");
  });

  test("typed slots: numeric entry over typed joins", () => {
    expect(parity(`add3 :: fn(a: i32, b: i32, c: i32): i32 { a + b + c };
add3(1, 2, 3)`)).toBe("6");
  });
});
