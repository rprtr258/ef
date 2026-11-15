import {test, expect, describe} from "bun:test";
import {lint} from "./lint.ts";

describe("unused-arg", () => {
  for (const [label, src, who, argname, pos] of [
    [
    "flags an unused named function argument", 
    `f :: fn(x: i64, y: i64): i64 { x };`,
    "function `f`", "y", {line: 1, col: 17},
    ],
    [
    "a shadowing inner binding does not count as using the parameter", 
    `s :: fn(x: i64): i64 { x :: 10; x };`,
    "function `s`", "x", {line: 1, col: 9},
    ],
    [
    "an inner lambda reusing the param name does not count as using the outer one", 
    `o :: fn(x: i64): i64 { inner :: fn(x: i64): i64 { x }; inner(5) };`,
    "function `o`", "x", {line: 1, col: 9},
    ],
    [
    "anonymous lambdas are reported without a name", 
    `v :: (fn(a: i64, b: i64): i64 { a })(1, 2);`,
    "anonymous function", "b", {line: 1, col: 18},
    ],
    [
    "positions are 1-indexed and track lines",
    `first :: 1;\nf :: fn(x: i64, y: i64): i64 { x };`,
    "function `f`", "y", {line: 2, col: 17},
    ],
  ] as [string, string, string, string, {line: number, col: number}][]) {
    test(label, () => {
    expect(lint(src))
        .toEqual([{rule: "unused-arg", who, argname, pos}]);
    });
  }
  test("stays silent when all arguments are used", () => {
    expect(lint(`g :: fn(x: i64, y: i64): i64 { x + y };`))
    .toEqual([]);
  });
});

describe("unused-arg traversal", () => {
  // Walker-arm coverage: each shape must traverse silently (no false
  // positives) when every lambda parameter is used.
  for (const [label, src] of [
    ["lambdas in assign/if/while positions", `
      f :: fn(x: i64): i64 {
        a := fn(z: i64): i64 { z };
        a = fn(z: i64): i64 { z };
        c := if (true) { a } else { a };
        while (false) { a = fn(z: i64): i64 { z } };
        c + x
      };
    `],
    ["lambdas in perform args", `
      effect Ask(n: i64): i64;
      f :: fn(x: i64): i64 ! { Ask } {
        Ask!(fn(u: i64): i64 { u }, x)
      };
    `],
    ["lambdas in arr/field/as/dlet positions", `
      f :: fn(x: i64): i64 {
        xs := [fn(a: i64): i64 { a }];
        t: [i64, string] : [1, "s"];
        y := t.0;
        z := @as(@as(y, f64), i64);
        [q, r] := [x, z];
        q + r + y + z + xs.0
      };
    `],
    ["the _ discard is exempt", `d :: fn(_: i64): i64 { 0 };`],
  ] as [string, string][]) {
    test(label, () => {
      expect(lint(src)).toEqual([]);
    });
  }

  for (const [label, src, who, argname, pos] of [
    [
    "params inside handler case bodies are linted; resume and case params shadow",
    `
      effect Ask(n: i64): i64;
      f :: fn(x: i64): i64 {
        handle {
          Ask!(x)
        } case Ask(n) => k {
          fn(h: i64): i64 { n }
        }
      };
    `,
    "anonymous function", "h", {line: 7, col: 14},
    ],
    [
    "a dlet field shadows an outer parameter (the param is the unused one)",
    `
      f :: fn(v: i64): i64 {
        [v, n] := [1, 2];
        n
      };
    `,
    "function \`f\`", "v", {line: 2, col: 15},
    ],
    [
    "duplicate parameter names are only reported once",
    `h :: fn(x: i64, x: i64): i64 { 0 };`,
    "function \`h\`", "x", {line: 1, col: 9},
    ],
  ] as [string, string, string, string, {line: number, col: number}][]) {
    test(label, () => {
      expect(lint(src)).toEqual([{rule: "unused-arg", who, argname, pos}]);
    });
  }
});
