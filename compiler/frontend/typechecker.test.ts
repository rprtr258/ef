import {test, expect, describe} from "bun:test";
import {prepare} from "./pipeline.ts";
import {showT} from "./type_display.ts";

// typeOf: the checker's resolved type for the program's last expression.
// prepare throws on any type error before reaching this, so a successful
// call is itself the "typechecks" assertion.
function typeOf(src: string): string {
  return showT(prepare(src).checked.lastType);
}

describe("effect rows check by subset, not equality", () => {
  test("a function with fewer effects checks against a parameter typed with more", () => {
    // Contravariant subsumption: the declared row is the context's upper
    // bound, not an exact match.
    expect(() => typeOf(`
      effect E(): i64;
      effect U(): i64;
      run :: fn (f): i64 ! { E, U } { f() };
      g :: fn(): i64 ! { E } { E!() };
      handle { run(g) } case E(n) => k { n } case U(n) => k { n }
    `)).not.toThrow();
  });

  test("a callee performing outside the parameter's row is rejected", () => {
    expect(() => typeOf(`
      effect E(): i64;
      effect U(): i64;
      run :: fn (f): i64 ! { E } { f() };
      g :: fn(): i64 ! { E, U } { E!(); U!() };
      handle { run(g) } case E(n) => k { n } case U(n) => k { n }
    `)).toThrow("effect mismatch: { E } ≠ { E, U }");
  });

  test("the empty row needs no special case: pure fn into an effectful context", () => {
    expect(() => typeOf(`
      effect E(): i64;
      f :: fn(): i64 ! { E } { if (true) { 1 } else { E!(); 2 } };
      g :: fn(): i64 ! { } { 7 };
      h :: fn(p: () -> i64 ! { E }): i64 { p() };
      handle { h(if (true) { f } else { g }) } case E(n) => k { n }
    `)).not.toThrow();
  });

  test("an effectful value against a ∅-typed context is a mismatch", () => {
    // Letting it through would let the value's performed effects vanish
    // from the ambient row — the branch join keeps the FIRST branch's row.
    expect(() => typeOf(`
      effect E(): i64;
      f :: if (true) { fn(): i64 ! { } { 1 } } else { fn(): i64 ! { E } { E!() } };
      handle { f() } case E(n) => k { n }
    `)).toThrow("effect mismatch: {  } ≠ { E }");
  });
});
