// Convert examples/raytracer.ef's raster output to a PNG.
//
// The example prints each pixel's R, G, B on three lines and closes each
// scanline with a -1.0 separator (see the header of examples/raytracer.ef).
// This script parses that stream (dimensions are derived from the row
// separators), clamps values to [0, 1], and writes a truecolor PNG.
//
//   bun run cli.ts runwasm examples/raytracer.ef > /tmp/rt.txt
//   bun scripts/rt-to-png.ts /tmp/rt.txt /tmp/raytracer.png 4
//
// The third argument is an integer upscale factor (nearest neighbor) for
// viewing; default 1 = native resolution.
import {readFileSync, writeFileSync} from "node:fs";
import {deflateSync} from "node:zlib";

const [inPath = "", outPath = "", scaleArg = "1"] = process.argv.slice(2);
if (inPath === "" || outPath === "") {
  console.error("usage: bun scripts/rt-to-png.ts <raytracer-output.txt> <out.png> [scale]");
  process.exit(2);
}
const scale = Math.max(1, Math.floor(Number(scaleArg)));

const lines = readFileSync(inPath, "utf8").split("\n");
// Drop the runner's final echo ("unit") and the trailing empty line: the
// raster is everything through the last -1 separator of the last scanline.
const lastSep = lines.lastIndexOf("-1");
if (lastSep < 0)
  throw new Error("no -1 row separator found — is this raytracer output?");
const values = lines.slice(0, lastSep + 1);

const W = (lastSep + 1 - 200) / 200 / 3; // per row: W pixels × 3 channels + 1 separator
const rows: string[][] = [];
for (let i = 0; i < values.length; i += W * 3 + 1) {
  if (values[i + W * 3] !== "-1")
    throw new Error(`separator missing at line ${i + W * 3}`);
  rows.push(values.slice(i, i + W * 3));
}
const H = rows.length;
if (W !== Math.floor(W) || W < 1) throw new Error(`bad row width ${W}`);

const px = (r: number, c: number, ch: number): number => Number(rows[r][c * 3 + ch]);
const clamp = (v: number): number => Math.max(0, Math.min(1, v));

// --- raster: 1 filter byte per row, 3 bytes per pixel ---
const raw = Buffer.alloc(H * scale * (W * scale * 3 + 1));
let o = 0;
for (let y = 0; y < H * scale; y++) {
  raw[o++] = 0; // filter: none
  const r = Math.floor(y / scale);
  for (let x = 0; x < W * scale; x++) {
    const c = Math.floor(x / scale);
    raw[o++] = Math.round(clamp(px(r, c, 0)) * 255);
    raw[o++] = Math.round(clamp(px(r, c, 1)) * 255);
    raw[o++] = Math.round(clamp(px(r, c, 2)) * 255);
  }
}

// --- PNG chunks (IHDR + IDAT + IEND) ---
const crcTable: number[] = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++)
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf)
    c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W * scale, 0);
ihdr.writeUInt32BE(H * scale, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: truecolor RGB

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${W}x${H} -> ${W * scale}x${H * scale}, ${png.length} bytes)`);
