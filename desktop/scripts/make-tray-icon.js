/**
 * Generate the menu-bar icon as a macOS *template* image.
 *
 * Committed as a generator rather than a hand-drawn binary so the icon can be
 * regenerated (and reviewed as a diff) instead of being an opaque blob nobody
 * can change. Zero dependencies: a template image is greyscale + alpha, which
 * is the one PNG colour type simple enough to hand-encode with node's zlib.
 *
 * macOS template rule: pixels are BLACK, and the alpha channel is the artwork.
 * The system tints it for the light/dark menu bar, which is why the file must
 * not contain any colour of its own.
 *
 *   node scripts/make-tray-icon.js
 */

const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.join(__dirname, "..", "assets");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number[][]} alpha rows of 0..255 */
function encodeGrayAlphaPng(alpha) {
  const h = alpha.length;
  const w = alpha[0].length;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 4; // colour type: greyscale + alpha
  const raw = Buffer.alloc(h * (1 + w * 2));
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    raw[p] = 0; // filter: none
    p += 1;
    for (let x = 0; x < w; x += 1) {
      raw[p] = 0; // grey = black, per the template rule
      raw[p + 1] = alpha[y][x];
      p += 2;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A ring with a filled centre — presence, at 16px. Supersampled 4× per axis so
 * the curve does not read as a staircase in the menu bar.
 */
function draw(size) {
  const S = 4;
  const c = size / 2;
  const ringOuter = size * 0.42;
  const ringInner = size * 0.30;
  const pupil = size * 0.14;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px = x + (sx + 0.5) / S - c;
          const py = y + (sy + 0.5) / S - c;
          const d = Math.hypot(px, py);
          if ((d <= ringOuter && d >= ringInner) || d <= pupil) hits += 1;
        }
      }
      row.push(Math.round((hits / (S * S)) * 255));
    }
    rows.push(row);
  }
  return rows;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [size, name] of [
  [16, "trayTemplate.png"],
  [32, "trayTemplate@2x.png"],
]) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, encodeGrayAlphaPng(draw(size)));
  console.log(`wrote ${file}`);
}
