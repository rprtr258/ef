// ops.ts — the vocabulary's spellings and trap texts are load-bearing:
// tests across the suite assert them, and the interpreter and the wasm host
// both throw the same trap strings. Pinning them here keeps the derived
// call sites (parser desugaring, checker sets, runtime messages) honest.
// Production consumers of this file's exports: eval.ts's traps,
// wasm_run.ts's hostFor/ef_fail, builtins.ts's impls, pipeline.ts's
// rejectUnhandled, cps_opt.ts's throwFree; this test pins the vocabulary
// itself.
import {describe, expect, test} from "bun:test";
import {
  ARITH_OPS, CMP_OPS, EQ_OPS, STAMPED_OPS, TRAPPING_OPS,
  OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_REM, OP_NEG,
  OP_LT, OP_GT, OP_LE, OP_GE, OP_EQ, OP_NE, OP_NOT,
  errDivByZero, errIntOverflow, errIndexOOB, errSubRangeOOB, errUnhandled,
} from "./ops.ts";

describe("ops vocabulary", () => {
  test("operator spellings", () => {
    expect(OP_ADD).toBe("+");
    expect(OP_SUB).toBe("-");
    expect(OP_MUL).toBe("*");
    expect(OP_DIV).toBe("/");
    expect(OP_REM).toBe("%");
    expect(OP_NEG).toBe("neg");
    expect(OP_LT).toBe("<");
    expect(OP_GT).toBe(">");
    expect(OP_LE).toBe("<=");
    expect(OP_GE).toBe(">=");
    expect(OP_EQ).toBe("==");
    expect(OP_NE).toBe("!=");
    expect(OP_NOT).toBe("not");
  });

  test("classifications", () => {
    expect([...ARITH_OPS].sort()).toEqual(["%", "*", "-", "/"]);
    expect([...CMP_OPS].sort()).toEqual(["<", "<=", ">", ">="]);
    expect([...EQ_OPS].sort()).toEqual(["!=", "=="]);
    expect([...STAMPED_OPS].sort()).toEqual([
      "!=", "%", "*", "+", "-", "/", "<", "<=", "==", ">", ">=", "neg",
    ]);
    expect([...TRAPPING_OPS].sort()).toEqual(["%", "/"]);
  });

  test("trap message texts (interpreter/wasm parity contract)", () => {
    expect(errDivByZero()).toBe("integer divide by zero");
    expect(errIntOverflow()).toBe("integer overflow");
    expect(errIndexOOB(".x", 3, 2)).toBe(".x: index 3 out of bounds [0, 2)");
    expect(errSubRangeOOB(5, 6, 3)).toBe("sub: range [5, 6) out of bounds [0, 3)");
    expect(errUnhandled("T")).toBe("Unhandled effect: T");
  });
});
