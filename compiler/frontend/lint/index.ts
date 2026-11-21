// lint: run a sequence of lint passes over a parsed program and report issues.
import {parseProgram} from "../parser.ts";
import {checkProgram, Checked} from "../types.ts";
import lintUnusedArgs from "./unused_args.ts";
import lintDerivedAny from "./derived_any.ts";

// Add more passes to LINT_PASSES; an entry maps the rule name to its pass,
// and each pass's Issue payload is picked up from its generator's yield type,
// so a new pass is one entry here. Passes yield their findings without the
// rule name — index.ts owns it and tags every issue below.
// `lint` typechecks best-effort first: a type-aware pass sees
// per-node inferred types, but a program that fails to check still gets its
// AST-level passes run (the unused-arg rules deliberately cover unchecked
// inputs like shadowing/duplicate params).
const LINT_PASSES = {
  "unused-arg": lintUnusedArgs,
  "derived-any": lintDerivedAny,
};

type LintIssue = {
  [K in keyof typeof LINT_PASSES]: ReturnType<typeof LINT_PASSES[K]> extends Generator<infer Issue>
    ? {rule: K} & Issue
    : never;
}[keyof typeof LINT_PASSES];

export default function(src: string): LintIssue[] {
  const prog = parseProgram(src);
  let checked: Checked | undefined;
  try {
    checked = checkProgram(prog);
  } catch { /* unchecked programs still get their AST passes */ }
  return Object.entries(LINT_PASSES).flatMap(([rule, pass]) =>
    // Object.entries widens the key to string; the cast restores the rule
    // literal — each entry's key and pass come from the same record.
    [...pass(prog, checked)].map((issue) => ({rule, ...issue}) as LintIssue));
}
