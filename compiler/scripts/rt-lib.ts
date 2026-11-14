// ---- parse raytracer output ----
export type Grid = {
  cols: number,
  rows: number,
  /** RGB triples in row-major order, each channel 0.0–1.0. */
  pixels: [number, number, number][],
};

export function parseRaytracerOutput(output: string): Grid {
  const lines = output.trim().split("\n").filter(l => l.length > 0);
  const pixels: [number, number, number][] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i] === "-1") {
      // Row separator
      i++;
      continue;
    }
    // Read R, G, B triple for one pixel
    const r = parseFloat(lines[i]);
    const g = parseFloat(lines[i + 1]);
    const b = parseFloat(lines[i + 2]);
    pixels.push([r, g, b]);
    i += 3;
  }

  // Infer grid size: it's always square for our raytracers
  const side = Math.round(Math.sqrt(pixels.length));
  if (side * side !== pixels.length) {
    throw new Error(`Output has ${pixels.length} pixels (not a perfect square); check raytracer output format`);
  }

  return {cols: side, rows: side, pixels};
}

export function clamp(v0: number, v1: number, v: number): number {
  return Math.max(v0, Math.min(v1, v));
}
