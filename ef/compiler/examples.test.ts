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
import {run} from "./eval.ts";
import {runWasm} from "./wasm_host.ts";
import {num, show, type Value} from "./env.ts";

const compilerDir = import.meta.dir; // every path below is relative to this source file's directory

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
            Random: () => rand(),
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
    timeout: 15000,
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
    timeout: 15000, // ~4s alone; tips over the 5s default under full-suite load
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
      // i32/u32 wraparound (step 3): native mod-2^32 ops in both backends.
      expect(lines[16]).toBe("-2147483648"); // INT_MAX + 1
      expect(lines[17]).toBe("2147483647"); // INT_MIN - 1
      expect(lines[18]).toBe("-2"); // INT_MAX * 2
      expect(lines[19]).toBe("0"); // u32 4294967295 + 1 wraps to 0
      expect(lines[20]).toBe("4294967295"); // u32 0 - 1 wraps to 2^32 - 1
      // Signed vs unsigned ordering of the same bits.
      expect(lines[22]).toBe("true");
      expect(lines[23]).toBe("true");
      // i64/u64 exactness beyond 2^53 (step 4): BigInt at the wasm
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
    label: "element store and sub-range",
    body: res => expect(res.stdout).toBe("0\n"),
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
      // 3000-char cap is reached, then kill the child. A time budget here
      // (the old timeout 8) flaked under parallel test load — startup plus
      // wasm compile could eat the whole window and yield 0 bytes. Bytes
      // are load-independent: slower machines just take longer to fill the
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
    timeout: 25000,
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
