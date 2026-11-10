export const KEYWORDS = new Set([
  "fn", "if", "else", "while", "handle", "case",
  "true", "false", "unit", "effect", "type",
]);
// Token character tables (shared with the playground's line tokenizer).
// `::` and `:=` are declaration operators (const / mutable), so they must lex
// as single tokens before `:`.
export const TWO = ["::", ":=", "==", "!=", "<=", ">=", "&&", "||", "=>"];
export const ONE = "()[]{},;<>+-*/!=:%.@";

// A source position: 1-indexed line and column.
export type Pos = { line: number, col: number };
export type Tok = { v: string, pos: Pos };

export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  // Indices where each line begins (line 1 at 0); lets us map a char index to
  // {line, col} without threading counters through the scanner.
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const posAt = (i: number): Pos => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((lineStarts[mid] ?? 0) <= i) lo = mid; else hi = mid - 1; }
    return {line: lo + 1, col: i - lineStarts[lo] + 1};
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (" \t\n\r".includes(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\"") {
      const start = i;
      let j = i + 1;
      while (j < src.length && src[j] !== "\"") {
        if (src[j] === "\\") j++;
        j++;
      }
      toks.push({v: src.slice(start, j + 1), pos: posAt(start)});
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO.includes(two)) {
      toks.push({v: two, pos: posAt(i)});
      i += 2;
      continue;
    }
    if (ONE.includes(c)) {
      toks.push({v: c, pos: posAt(i)});
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({v: src.slice(start, j), pos: posAt(start)});
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({v: src.slice(start, j), pos: posAt(start)});
      i = j;
      continue;
    }
    throw new Error("Bad char: " + c);
  }
  return toks;
}
