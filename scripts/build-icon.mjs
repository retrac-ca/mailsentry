import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Generate MailSentry PNG/ICO assets without external image dependencies.
 * The source is drawn at 4x and box-filtered down for smooth edges.
 */
const SIZE = 512;
const SUPERSAMPLE = 4;
const WORK = SIZE * SUPERSAMPLE;
const pixels = new Uint8ClampedArray(WORK * WORK * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= WORK || y >= WORK) return;
  const i = (y * WORK + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = a;
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (
    (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 ||
    (x >= left + radius && x <= right - radius) ||
    (y >= top + radius && y <= bottom - radius)
  );
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawLine(x1, y1, x2, y2, width, color) {
  const half = width / 2;
  for (let y = Math.floor(Math.min(y1, y2) - half); y <= Math.ceil(Math.max(y1, y2) + half); y += 1) {
    for (let x = Math.floor(Math.min(x1, x2) - half); x <= Math.ceil(Math.max(x1, x2) + half); x += 1) {
      if (segmentDistance(x, y, x1, y1, x2, y2) <= half) set(x, y, ...color);
    }
  }
}

function fillCircle(cx, cy, radius, color) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) set(x, y, ...color);
    }
  }
}

const scale = (value) => Math.round(value * SUPERSAMPLE);

// Rounded teal tile with a subtle vertical gradient.
for (let y = 0; y < WORK; y += 1) {
  for (let x = 0; x < WORK; x += 1) {
    if (!insideRoundedRect(x, y, 0, 0, WORK - 1, WORK - 1, scale(96))) continue;
    const t = y / WORK;
    set(x, y, Math.round(13 + 9 * (1 - t)), Math.round(111 - 15 * t), Math.round(102 - 13 * t));
  }
}

const white = [255, 255, 255];
const teal = [15, 111, 102];

// Envelope outline and flap.
const left = scale(108);
const right = scale(404);
const top = scale(176);
const bottom = scale(340);
const stroke = scale(16);
drawLine(left, top, right, top, stroke, white);
drawLine(left, bottom, right, bottom, stroke, white);
drawLine(left, top, left, bottom, stroke, white);
drawLine(right, top, right, bottom, stroke, white);
drawLine(scale(124), scale(192), scale(256), scale(286), stroke, white);
drawLine(scale(388), scale(192), scale(256), scale(286), stroke, white);

// Check badge.
fillCircle(scale(366), scale(354), scale(72), white);
drawLine(scale(330), scale(354), scale(354), scale(378), scale(22), teal);
drawLine(scale(354), scale(378), scale(404), scale(322), scale(22), teal);

function downsample(target) {
  const ratio = WORK / target;
  const out = Buffer.alloc(target * target * 4);
  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = 0; yy < ratio; yy += 1) {
        for (let xx = 0; xx < ratio; xx += 1) {
          const i = ((y * ratio + yy) * WORK + (x * ratio + xx)) * 4;
          const alpha = pixels[i + 3] / 255;
          r += pixels[i] * alpha;
          g += pixels[i + 1] * alpha;
          b += pixels[i + 2] * alpha;
          a += alpha;
        }
      }
      const count = ratio * ratio;
      const outIndex = (y * target + x) * 4;
      if (a === 0) {
        out.fill(0, outIndex, outIndex + 4);
      } else {
        out[outIndex] = Math.round(r / a);
        out[outIndex + 1] = Math.round(g / a);
        out[outIndex + 2] = Math.round(b / a);
        out[outIndex + 3] = Math.round((a / count) * 255);
      }
    }
  }
  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const rgba = downsample(size);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png512 = png(512);
const png256 = png(256);
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; // 256 pixels
entry[1] = 0;
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png256.length, 8);
entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([icoHeader, entry, png256]);

const out = resolve(process.cwd(), "build");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "icon.png"), png512);
writeFileSync(resolve(out, "icon.ico"), ico);
process.stdout.write(`Generated ${resolve(out, "icon.png")} and ${resolve(out, "icon.ico")}\n`);
