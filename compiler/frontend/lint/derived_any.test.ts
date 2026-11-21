import {test, expect} from "bun:test";
import lint from "./index.ts";

const preamble = `pull :: fn(x: any): any { x };\n`;
for (const [label, src, diags] of [
  [
    "flags a binding whose inferred type came from an any-typed call",
    `${preamble}y := pull(1);`,
    [["`y`", "any", {line: 2, col: 1}]],
  ],
  [
    "flags tuple fields fed by any-typed values; typed siblings stay silent",
    `${preamble}[a, b, c] := [pull(1), 2, "s"];`,
    [["field `a`", "any", {line: 2, col: 2}]],
  ],
  [
    "flags an array of any-typed elements",
    `${preamble}xs := [pull(1), pull(2)];`,
    [["`xs`", "[any]", {line: 2, col: 1}]],
  ],
  [
    "propagation flags every derived binding in order",
    `${preamble}y := pull(1);\nz := y;`,
    [
      ["`y`", "any", {line: 2, col: 1}],
      ["`z`", "any", {line: 3, col: 1}],
    ],
  ],
  [
    "propagation flags every derived binding in order",
    `${preamble}y := pull(1);\nz := y;`,
    [
      ["`y`", "any", {line: 2, col: 1}],
      ["`z`", "any", {line: 3, col: 1}],
    ],
  ],
  [
    "an explicit annotation silences it",
    `${preamble}y: any = pull(1);`,
    [],
  ],
  [
    "an annotated tuple field silences that field",
    `${preamble}[a: any, b] := [pull(1), 2];`,
    [],
  ],
  [
    "the _ discard is exempt",
    `${preamble}_ := pull(1);`,
    [],
  ],
  // The signature spells out the full type — no any there is derived.
  [
    "a lambda-valued :: binding is skipped",
    `pull :: fn(x: any): any { x };`,
    [],
  ],
  [
    "pure bindings stay silent",
    `x := 1;\nys := [x, x];`,
    [],
  ],
  // inferred `any` is reported by the derived-any lint rule; annotations are silent
  [
    "lambda-valued :: — the signature spells the type out",
    "g :: fn(x: any): any { x };",
    [],
  ],
  [
    "explicit annotation",
    "g: (any) -> any : fn(x: any): any { x };",
    [],
  ],
  [
    "array literal -> [i64]",
    "xs :: [1, 2, 3]; xs",
    [],
  ],
  [
    "call result derived from any",
    "g :: fn(x: any): any { x };\ny := g(1);",
    [["`y`", "any", {line: 2, col: 1}]],
  ],
] as [string, string, [string, string, {line: number, col: number}][]][]) {
  test(label, () => {
    const actual = lint(src);
    const expected = diags.map(([who, ty, pos]) => ({rule: "derived-any" as const, who, ty, pos}));
    expect(actual).toEqual(expected);
  });
}
