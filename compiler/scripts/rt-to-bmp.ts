/**
 * Render an ef raytracer output to a color BMP image.
 *
 * Usage:
 *   bun scripts/rt-to-bmp.ts <in.txt> [out.bmp]
 *
 * Parses the raytracer output (R,G,B triples + -1 row separators)
 * and writes a 24-bit BMP.
 */

import {readFileSync, writeFileSync} from "fs";
import {clamp, Grid, parseRaytracerOutput} from "./rt-lib.ts";

/** Write a 24-bit BMP (BITMAPINFOHEADER, uncompressed, bottom-up rows). */
function writeBmp(
  path: string,
  grid: Grid,
  channels: 3 | 4,
): void {
  const [width, height] = [grid.cols, grid.rows];
  const pixelData = new Uint8Array(grid.cols * grid.rows * channels);
  for (let gy = 0; gy < grid.rows; gy++) {
    for (let gx = 0; gx < grid.cols; gx++) {
      const [r, g, b] = grid.pixels[gy * grid.cols + gx];
      const idx = (gy * grid.cols + gx) * channels;
      pixelData[idx] = clamp(0, 255, Math.round(r * 255));     // R
      pixelData[idx + 1] = clamp(0, 255, Math.round(g * 255)); // G
      pixelData[idx + 2] = clamp(0, 255, Math.round(b * 255)); // B
    }
  }

  const rowSize = Math.ceil((width * channels) / 4) * 4; // padded to 4 bytes
  const pixelArraySize = rowSize * height;
  const headerSize = 14 + 40;
  const fileSize = headerSize + pixelArraySize;

  const buf = new Uint8Array(fileSize);
  const dv = new DataView(buf.buffer);

  // --- BITMAPFILEHEADER (14 bytes) ---
  dv.setUint16(0, 0x4d42, true); // "BM"
  dv.setUint32(2, fileSize, true); // file size
  dv.setUint16(6, 0, true); // reserved1
  dv.setUint16(8, 0, true); // reserved2
  dv.setUint32(10, headerSize, true); // offset to pixel data

  // --- BITMAPINFOHEADER (40 bytes) ---
  dv.setUint32(14, 40, true); // header size
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true); // positive = bottom-up
  dv.setUint16(26, 1, true); // planes
  dv.setUint16(28, channels * 8, true); // bits per pixel
  dv.setUint32(30, 0, true); // compression (BI_RGB)
  dv.setUint32(34, 0, true); // size image (0 is ok for BI_RGB)
  dv.setInt32(38, 2835, true); // X pixels per meter (~72 DPI)
  dv.setInt32(42, 2835, true); // Y pixels per meter
  dv.setUint32(46, 0, true); // colors used
  dv.setUint32(50, 0, true); // important colors

  // --- Pixel data (bottom-up: row 0 of pixelData = bottom row) ---
  for (let y = 0; y < height; y++) {
    // BMP stores rows bottom-up: source row (height - 1 - y) → dest row y
    const srcRow = height - 1 - y;
    const srcOffset = srcRow * width * channels;
    const dstOffset = headerSize + y * rowSize;

    for (let x = 0; x < width; x++) {
      const si = srcOffset + x * channels;
      const di = dstOffset + x * channels;
      // BMP pixel data is BGR order (B, G, R)
      buf[di] = pixelData[si + 2];     // B
      buf[di + 1] = pixelData[si + 1]; // G
      buf[di + 2] = pixelData[si];     // R
    }
  }

  writeFileSync(path, buf);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun scripts/rt-to-bmp.ts <in.txt> [out.bmp]");
  process.exit(1);
}

const inputFile = args[0];
const outputFile = args[1] ?? inputFile.replace(/\.txt$/, ".bmp");

const output = readFileSync(inputFile, "utf8");
const grid = parseRaytracerOutput(output);
const channels = 3; // RGB

writeBmp(outputFile, grid, channels);
console.log(`Wrote ${grid.cols}×${grid.rows} BMP to ${outputFile}`);
