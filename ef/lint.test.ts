import {test, expect, describe} from "bun:test";
import {lint} from "./lint.ts";

describe("unused-arg", () => {
  for (const [label, src, who, argname, pos] of [
    [
    "flags an unused named function argument", 
    `let f = fn(x: int, y: int): int { x };`,
    "function `f`", "y", {line: 1, col: 20},
    ],
    [
    "a shadowing inner `let` does not count as using the parameter", 
    `let s = fn(x: int): int { let x = 10; x };`,
    "function `s`", "x", {line: 1, col: 12},
    ],
    [
    "an inner lambda reusing the param name does not count as using the outer one", 
    `let o = fn(x: int): int { let inner = fn(x: int): int { x }; inner(5) };`,
    "function `o`", "x", {line: 1, col: 12},
    ],
    [
    "anonymous lambdas are reported without a name", 
    `let v = (fn(a: int, b: int): int { a })(1, 2);`,
    "anonymous function", "b", {line: 1, col: 21},
    ],
    [
    "positions are 1-indexed and track lines",
    `let first = 1;\nlet f = fn(x: int, y: int): int { x };`,
    "function `f`", "y", {line: 2, col: 20},
    ],
  ] as [string, string, string, string, {line: number, col: number}][]) {
    test(label, () => {
    expect(lint(src))
        .toEqual([{rule: "unused-arg", who, argname, pos}]);
    });
  }
  test("stays silent when all arguments are used", () => {
    expect(lint(`let g = fn(x: int, y: int): int { x + y };`))
    .toEqual([]);
  });
});
