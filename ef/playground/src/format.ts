// format.ts — shared human-readable formatting (leaf module).

export function fmtMs(ms: number): string {
  return ms >= 100 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
}
