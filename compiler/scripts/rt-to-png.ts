// Convert examples/raytracer.ef's raster output to a PNG.
//
// The example prints each pixel's R, G, B on three lines and closes each
// scanline with a -1.0 separator (see the header of examples/raytracer.ef).
// This script parses that stream (dimensions are derived from the row
// separators), clamps values to [0, 1], and writes a truecolor PNG.
//
//   bun compiler/cli.ts runwasm examples/raytracer.ef > /tmp/rt.txt
//   bun scripts/rt-to-png.ts /tmp/rt.txt /tmp/raytracer.png
import {readFileSync, writeFileSync} from "node:fs";
import {deflateSync} from "node:zlib";
import {clamp, Grid, parseRaytracerOutput} from "./rt-lib.ts";

const crcTable: number[] = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++)
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf)
    c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(
  path: string,
  grid: Grid,
  channels: number,
): void {
  const [width, height] = [grid.cols, grid.rows];
  // Each PNG scanline is prefixed with a filter-type byte; we use 0 (None).
  const stride = grid.cols * channels + 1;
  const pixelData = new Uint8Array(stride * grid.rows);
  for (let gy = 0; gy < grid.rows; gy++) {
    for (let gx = 0; gx < grid.cols; gx++) {
      const [r, g, b] = grid.pixels[gy * grid.cols + gx];
      const idx = gy * stride + 1 + gx * channels;
      pixelData[idx] = clamp(0, 255, Math.round(r * 255));     // R
      pixelData[idx + 1] = clamp(0, 255, Math.round(g * 255)); // G
      pixelData[idx + 2] = clamp(0, 255, Math.round(b * 255)); // B
    }
  }
  // Zero-init buffer: every scanline's leading filter byte is already 0 (None).

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(pixelData)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: bun scripts/rt-to-png.ts <in.txt> <out.png>");
  process.exit(2);
}
const inputFile = args[0];
const outputFile = args[1] ?? inputFile.replace(/\.txt$/, ".png");

const output = readFileSync(inputFile, "utf8");
const grid = parseRaytracerOutput(output);
const channels = 3; // RGB

writePng(outputFile, grid, channels);
console.log(`Wrote ${grid.cols}x${grid.rows} PNG to ${outputFile}`);
