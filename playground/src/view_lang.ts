// view_lang.ts — pure data for the view editors' monaco grammars and hover
// docs, kept monaco-free so tests can import it directly (views.ts does the
// monaco registration). One ef-ir grammar serves both the AST and CPS views:
// the compilers' dumps are S-expr-flavored — node tags as keywords,
// converter-generated $-names in a distinct hue (tag), numeric widths as
// types.

// Hover targets are word-based: grammar keywords/types plus bare words the
// printers emit that aren't grammar keywords (`k`, `exit` in the handle line).
export const NODE_DOCS: Record<string, string> = {
  // CPS term nodes
  "letk": "Continuation binding — `letk k (v): body` names the rest of the computation after a suspension point; the value arrives as `v`. The dedented lines after the body run in parallel, not 'after'.",
  "let": "Binding. In the AST view a source binding (`::` const, `:=` mutable); in the CPS view an internal frame temp the optimizer fuses or drops when no suspension needs it frozen.",
  "bind": "Frame-slot write for a source variable — stays live across suspensions so a resumed continuation still sees it.",
  "mkfn": "Closure creation: binds a name to the converted function `fn $n`, capturing the listed variables.",
  "call": "Suspending call: the callee is handed the continuation after `->`, and its result arrives through that continuation's parameter.",
  "dcall": "Direct call into a pure closure — nothing inside can suspend, so the result binds straight to the name.",
  "perform": "Effect operation: control jumps to the nearest handler, carrying the continuation after `->` — the reified rest of this computation, which the handler's `resume` receives.",
  "handle": "Effect handler: the listed continuations are the runtime-bound delivery, abort, and ambient paths; the `case`s below handle each op.",
  "case": "Handler case for one op: `params` bind the op's arguments, `resume` names the captured continuation.",
  "resume": "The continuation captured at the perform site — calling it resumes the body with the given value.",
  "if": "Branch on a condition value.",
  "else": "The if-false branch.",
  "scope": "Frame-discipline region: operands needed after a suspension are bound before it, so a resume replays with exactly the frozen set.",
  "dlet": "Destructuring bind: unpacks an array/tuple into the listed frame slots.",
  "assign": "Mutation of an existing frame slot.",
  "jump": "Tail-deliver a value into a continuation — what a return compiles to.",
  "dret": "Return of a pure (direct-style) function.",
  "halt": "End of the top-level term.",
  "fn": "Converted function body: `(captures) (params)` — the params group is always last, so a lone group is the declared params. Captures are filled in by the `mkfn` that creates the closure.",
  "top": "The module's top-level term (top-level statements and the final expression).",
  "direct": "Pure-function marker: never suspends, so it converts direct-style with a `dret` boundary.",
  "k": "The body's ambient continuation: the rest of the handled body after the current perform.",
  "exit": "Abort path: runs when an op escapes the handler unhandled.",
  // AST node tags
  "effect": "Effect declaration: the op's name, argument types, and the type a resume injects.",
  "alias": "Type alias declaration (`Name :: type`).",
  "lambda": "Anonymous function; effectful ones carry `: ret ! { ops }` annotations.",
  "block": "Statement sequence; evaluates to its last expression.",
  "while": "Loop: repeats the body while the condition holds.",
  "app": "Function application.",
  "sym": "Variable reference.",
  "num": "Numeric literal.",
  "str": "String literal.",
  "bool": "Boolean literal.",
  "unit": "Unit — the absence of a value.",
  "arr": "Array literal (homogeneous).",
  "tup": "Tuple literal (heterogeneous; fields accessed as `.0`/`.name`).",
  "field": "Field or index access.",
  "as": "`@as` conversion — the one numeric/bool width conversion.",
  // numeric widths (grammar "type" tokens)
  "u8": "8-bit unsigned byte width (0..255, wrapping) — element type of `bytes`.",
  "i32": "32-bit signed integer width.",
  "i64": "64-bit signed integer width — the default for untyped integer literals.",
  "u32": "32-bit unsigned integer width.",
  "u64": "64-bit unsigned integer width — exact to 2^53, no wraparound.",
  "f32": "32-bit float width — values round to f32 precision at every producing node.",
  "f64": "64-bit float width — the default for untyped float literals.",
};

// Converter-generated names get prefix-matched (their numeric suffixes vary);
// most specific prefix first, generic `$` last.
export const DOLLAR_DOCS: [string, string][] = [
  ["$hret", "Delivery continuation: receives the handled body's completion value."],
  ["$xit", "Abort continuation: runs when an op escapes the handler unhandled."],
  ["$", "Converter-generated name — `$`-prefixed names can never collide with source identifiers (`$k` continuations, `$v` values/params, `$t` temps, `$f` closure names)."],
];

// Indexing a Record<string, string> claims to always return a string, but a
// missing key is undefined at runtime — the function return type keeps the
// type honest for the ?? chain.
export function docFor(word: string): string | undefined {
  return NODE_DOCS[word] ?? (word.startsWith("$")
    ? DOLLAR_DOCS.find(([p]) => word.startsWith(p))?.[1]
    : undefined);
}

export const EF_IR_KEYWORDS = [
  // CPS term nodes
  "letk", "let", "bind", "mkfn", "call", "dcall", "perform", "handle", "case",
  "resume", "if", "else", "scope", "dlet", "assign", "jump", "dret", "halt",
  "fn", "top", "direct",
  // AST node tags
  "effect", "alias", "lambda", "block", "while", "app", "sym", "num", "str",
  "bool", "unit", "arr", "tup", "field", "as",
];

export const EF_IR_TYPES = ["u8", "i32", "i64", "u32", "u64", "f32", "f64"];

type Rule = [RegExp, string];

// Rule order matters: monarch takes the first matching rule (floats before
// ints; the generic identifier after all keywords).
export const EF_IR_RULES: Rule[] = [
  [/\s+/, "white"],
  [/[()]/, "delimiter"],
  [/"(?:[^"\\\n]|\\.)*"/, "string"],
  [/[$][\w.!?<>*/#+-]*/, "tag"],
  [/-?\d+\.\d*(?:[eE][-+]?\d+)?/, "number"],
  [/-?\d+/, "number"],
  [new RegExp(`\\b(?:${EF_IR_KEYWORDS.join("|")})\\b`), "keyword"],
  [new RegExp(`\\b(?:${EF_IR_TYPES.join("|")})\\b`), "type"],
  [/[a-zA-Z_][\w.]*/, "identifier"],
  [/[:=,;<>{}[\]!+*/%&|^-]+/, "operator"],
  [/@.]/, "operator"],
];

// Subset of the WAT the backend emits (WasmGC: structs, arrays, ref casts);
// unlisted mnemonics simply stay plain text. Dotted mnemonics match before
// the bare-keyword rule, so ref.cast/array.new_default/i31.get_s highlight
// whole instead of splitting after the prefix.
export const WAT_RULES: Rule[] = [
  [/\s+/, "white"],
  [/;;.*/, "comment"],
  [/[()]/, "delimiter"],
  [/"(?:[^"\\\n]|\\.)*"/, "string"],
  [/[$][\w.!?<>*/#+-]*/, "tag"],
  [/-?0x[0-9a-fA-F]+/, "number"],
  [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|nan|inf/, "number"],
  [/\b(?:local|global|memory|table|struct|array|ref|i31|any|extern|data|elem|br_on)\.[\w]+/, "keyword"],
  [/\b[iuf]\d+\.[\w]+/, "keyword"],
  [/\b(?:module|rec|type|func|param|result|field|struct|array|mut|ref|sub|null|final|export|import|table|memory|global|elem|data|start|block|loop|br|br_if|br_table|br_on_cast|br_on_cast_fail|br_on_null|br_on_non_null|return|call|call_indirect|unreachable|nop|drop|select|if|then|else)\b/, "keyword"],
  [/\b(?:i32|i64|f32|f64|anyref|eqref|i31ref|structref|arrayref|funcref|externref|nullref|nullfuncref|nullexternref)\b/, "type"],
  [/\b[iuf]\d+\b/, "type"],
];
