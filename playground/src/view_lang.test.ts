import {describe, expect, test} from "bun:test";
import {
  DOLLAR_DOCS, docFor, EF_IR_KEYWORDS, EF_IR_RULES, EF_IR_TYPES,
  NODE_DOCS, WAT_RULES,
} from "./view_lang.ts";

describe("view_lang", () => {
  test("every ef-ir keyword/type has a hover doc", () => {
    for (const w of [...EF_IR_KEYWORDS, ...EF_IR_TYPES]) {
      expect(docFor(w)).toBeDefined();
    }
  });

  test("every documented word is reachable: a grammar keyword/type or a bare word the printers emit", () => {
    // `k` and `exit` are printed by cps_view's handle line, not grammar keywords
    const emittedBare = new Set(["k", "exit"]);
    for (const w of Object.keys(NODE_DOCS)) {
      expect(EF_IR_KEYWORDS.includes(w) || EF_IR_TYPES.includes(w) || emittedBare.has(w)).toBe(true);
    }
  });

  test("$-names resolve by specific prefix before the generic $ rule", () => {
    expect(docFor("$hret9")).toBe(DOLLAR_DOCS[0][1]);
    expect(docFor("$xit10")).toBe(DOLLAR_DOCS[1][1]);
    expect(docFor("$k3")).toBe(DOLLAR_DOCS[2][1]);
  });

  test("unknown words resolve to nothing", () => {
    expect(docFor("plain")).toBeUndefined();
    expect(docFor("$plain")).toBe(DOLLAR_DOCS[2][1]); // any $-word gets the generic doc
  });

  test("ef-ir rules carry the keyword/type rules built from the arrays", () => {
    const toks = EF_IR_RULES.map(([, t]) => t);
    expect(toks).toContain("keyword");
    expect(toks).toContain("type");
    const kwRule = EF_IR_RULES.find(([, t]) => t === "keyword")![0];
    for (const w of [...EF_IR_KEYWORDS, ...EF_IR_TYPES]) {
      expect(kwRule.test(w) || EF_IR_RULES.find(([, t]) => t === "type")![0].test(w)).toBe(true);
    }
  });

  test("wat rules: dotted mnemonics precede the bare-keyword rule", () => {
    const dottedIdx = WAT_RULES.findIndex(([re]) => re.source.includes("\\.["));
    const bareIdx = WAT_RULES.findIndex(([re, t]) => t === "keyword" && !re.source.includes("\\.["));
    expect(dottedIdx).toBeGreaterThanOrEqual(0);
    expect(bareIdx).toBeGreaterThanOrEqual(0);
    expect(dottedIdx).toBeLessThan(bareIdx);
  });
});
