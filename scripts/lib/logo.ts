/**
 * @file scripts/lib/logo.ts
 * @description Generate the app icon as a PNG, with no image dependency.
 *
 * Draws a rounded tile with a check mark inside a ring — "verified, and the
 * verification is bounded". Rendered at 4x and downsampled so the curves are
 * antialiased rather than jagged, which is the difference between an icon that
 * looks deliberate in the Zendesk apps list and one that looks unfinished.
 *
 * This is still generated artwork, not brand design. Drop a real
 * apps/sidebar/assets/logo.png in place and the packager will prefer it.
 */
import * as zlib from "zlib";

const BRAND: RGB = [31, 115, 183]; // Zendesk blue
const INK: RGB = [255, 255, 255];

type RGB = [number, number, number];

interface Canvas {
  size: number;
  pixels: Float64Array; // RGBA, premultiplied coverage in alpha
}

function createCanvas(size: number): Canvas {
  return { size, pixels: new Float64Array(size * size * 4) };
}

function paint(canvas: Canvas, x: number, y: number, color: RGB): void {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  canvas.pixels[i] = color[0];
  canvas.pixels[i + 1] = color[1];
  canvas.pixels[i + 2] = color[2];
  canvas.pixels[i + 3] = 255;
}

/** Filled rounded rectangle covering the whole tile. */
function fillRoundedTile(canvas: Canvas, radius: number, color: RGB): void {
  const { size } = canvas;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Distance into the nearest corner's rounding box.
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) {
        paint(canvas, x, y, color);
      }
    }
  }
}

/** Stroked circle, used as the ring around the mark. */
function strokeCircle(
  canvas: Canvas,
  cx: number,
  cy: number,
  radius: number,
  width: number,
  color: RGB
): void {
  const outer = radius + width / 2;
  const inner = radius - width / 2;

  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= outer && d >= inner) paint(canvas, x, y, color);
    }
  }
}

/** Round-capped line segment. */
function strokeSegment(
  canvas: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  color: RGB
): void {
  const half = width / 2;
  const minX = Math.floor(Math.min(x0, x1) - half);
  const maxX = Math.ceil(Math.max(x0, x1) + half);
  const minY = Math.floor(Math.min(y0, y1) - half);
  const maxY = Math.ceil(Math.max(y0, y1) + half);

  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // Distance from the point to the segment.
      let t = lengthSquared === 0 ? 0 : ((x - x0) * dx + (y - y0) * dy) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
      if (d <= half) paint(canvas, x, y, color);
    }
  }
}

/**
 * Average each scale×scale block down to one RGBA pixel.
 *
 * Output keeps alpha rather than compositing onto a background: the rounded
 * corners have to actually be transparent, or the tile reads as a plain square
 * on every surface Zendesk draws it on.
 */
function downsample(canvas: Canvas, scale: number): Buffer {
  const out = canvas.size / scale;
  const raw = Buffer.alloc((out * 4 + 1) * out);
  const samples = scale * scale;
  let offset = 0;

  for (let y = 0; y < out; y++) {
    raw[offset++] = 0; // PNG filter: none
    for (let x = 0; x < out; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const i = ((y * scale + sy) * canvas.size + (x * scale + sx)) * 4;
          const alpha = canvas.pixels[i + 3] / 255;
          r += canvas.pixels[i] * alpha;
          g += canvas.pixels[i + 1] * alpha;
          b += canvas.pixels[i + 2] * alpha;
          a += alpha;
        }
      }

      const coverage = a / samples;
      // Un-premultiply so partially covered edge pixels keep their true colour.
      const channel = (sum: number): number =>
        coverage === 0 ? 0 : Math.round(Math.min(255, sum / samples / coverage));

      raw[offset++] = channel(r);
      raw[offset++] = channel(g);
      raw[offset++] = channel(b);
      raw[offset++] = Math.round(coverage * 255);
    }
  }

  return raw;
}

// ─── PNG container ────────────────────────────────────────────────────────────

let crcTable: number[] | null = null;

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return crc ^ 0xffffffff;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(raw: Buffer, size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Render the app icon. Zendesk asks for 320×320.
 */
export function renderLogo(size = 320): Buffer {
  const scale = 4;
  const big = size * scale;
  const canvas = createCanvas(big);

  fillRoundedTile(canvas, big * 0.22, BRAND);

  const cx = big / 2;
  const cy = big / 2;

  strokeCircle(canvas, cx, cy, big * 0.29, big * 0.045, INK);

  // Check mark, proportioned to sit optically centred inside the ring.
  const stroke = big * 0.062;
  strokeSegment(canvas, cx - big * 0.13, cy + big * 0.01, cx - big * 0.035, cy + big * 0.115, stroke, INK);
  strokeSegment(canvas, cx - big * 0.035, cy + big * 0.115, cx + big * 0.145, cy - big * 0.105, stroke, INK);

  return encodePng(downsample(canvas, scale), size);
}
