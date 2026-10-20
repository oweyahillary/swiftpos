/**
 * raster — a monochrome bitmap the printer can take as-is (A310, SCOPE-A295 §5).
 *
 * WHY THIS SHAPE
 * A thermal printer prints 1-bit rasters. Neither Electron's main process nor the
 * cloud has a PNG decoder or a canvas, and this package must stay DOM-free (its
 * tests run under plain node in CI). So the colour→mono decision is made ONCE,
 * where a canvas exists (the tech feed on the till, the web Branding page), and
 * the result is stored as packed bits. A till never decodes an image at print
 * time; it copies bytes into a GS v 0 command.
 *
 * Both DOM callers hand their canvas's RGBA pixels to monoRasterFromRGBA() below,
 * so there is ONE thresholding rule. Two copies would drift, and a logo that
 * previews crisp on the web and prints grey on the till is exactly the bug the
 * receipt preview exists to prevent (SCOPE addendum §C).
 *
 * ENCODING (portable, storable in a text column on both sides)
 *   "mono1:<width>:<height>:<base64 of packed rows>"
 *   rows are MSB-first, 1 = black, padded to a whole byte — the exact layout
 *   GS v 0 wants, so emit is a memcpy.
 */

export interface MonoRaster {
  /** Pixels. Must not exceed the narrowest paper the logo can meet: 384 dots
   *  (58 mm) fits every printer this package targets; 576 is the 80 mm head. */
  width: number;
  height: number;
  /** Packed 1-bpp rows, MSB first, each row padded to a byte boundary. */
  bytes: Uint8Array;
}

/** 58 mm heads print 384 dots; a logo prepared at this width fits all paper. */
export const RECEIPT_LOGO_MAX_WIDTH = 384;
/** Hard ceiling: an 80 mm head. Anything wider is a malformed job, never sent. */
export const PRINTER_MAX_DOTS = 576;
/** The tallest logo STORED (an upload is fitted to it). 0.6.25: 240 → 288 dots (30 → 36 mm), the owner asked that the
 *  printed logo not be too small. A530: storage stays at 288 (owner, 2026-10-19: "that's okay" — so 'receipt_full_logo'
 *  can print any client's logo at its full size); the receipt PRINTS at RECEIPT_LOGO_PRINT_MAX_HEIGHT unless it is on. */
export const RECEIPT_LOGO_MAX_HEIGHT = 288;
/** A530 (owner, 2026-10-19: "I feel the receipt is too long wasting paper"): the receipt prints the logo at most
 *  120 dots tall (15 mm), shrunk at print time by fitMonoRaster — unless the client has 'receipt_full_logo'. A538 keeps
 *  this small logo on the standard (classic-layout) receipt. */
export const RECEIPT_LOGO_PRINT_MAX_HEIGHT = 120;
export const DEFAULT_THRESHOLD = 128;

export const bytesPerRow = (width: number): number => Math.ceil(width / 8);

export interface MonoOptions {
  /** 0-255. Luminance strictly below this prints black. Default 128. */
  threshold?: number;
  /** Downsample (box average) to at most this many dots wide. Default 384. */
  maxWidth?: number;
  /** Downsample to at most this many rows. Default RECEIPT_LOGO_MAX_HEIGHT (288). */
  maxHeight?: number;
}

/**
 * RGBA (as a canvas returns it: 4 bytes per pixel, row-major) → MonoRaster.
 * Transparent pixels are composited onto WHITE first, so a transparent-background
 * mark prints as black on paper, not as a black rectangle.
 */
export function monoRasterFromRGBA(
  rgba: ArrayLike<number>, width: number, height: number, opts: MonoOptions = {},
): MonoRaster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`raster: bad dimensions ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`raster: expected ${width * height * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}`);
  }
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxW = opts.maxWidth ?? RECEIPT_LOGO_MAX_WIDTH;
  const maxH = opts.maxHeight ?? RECEIPT_LOGO_MAX_HEIGHT;

  // Luminance on white. Rec.601 weights — a logo, not a photograph; nothing
  // finer is visible on a 203 dpi head.
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const r = rgba[p] * a + 255 * (1 - a);
    const g = rgba[p + 1] * a + 255 * (1 - a);
    const b = rgba[p + 2] * a + 255 * (1 - a);
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // Shrink-not-crop, same rule as prepareRasterLogo: one scale for both axes.
  const scale = Math.min(1, maxW / width, maxH / height);
  const outW = Math.max(1, Math.floor(width * scale));
  const outH = Math.max(1, Math.floor(height * scale));

  const out = new Uint8Array(bytesPerRow(outW) * outH);
  const stride = bytesPerRow(outW);
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y / scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) / scale));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x / scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) / scale));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < height; yy++) {
        for (let xx = x0; xx < x1 && xx < width; xx++) { sum += lum[yy * width + xx]; n++; }
      }
      if ((n ? sum / n : 255) < threshold) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width: outW, height: outH, bytes: out };
}

/**
 * A530: a stored 1-bit logo shrunk to fit maxWidth x maxHeight, aspect kept; returned as it is when it already fits.
 *
 * AREA SAMPLING, not nearest neighbour. Each output dot covers a box of the source (2.4 x 2.4 dots when 288 rows become
 * 120) and takes the share of that box that is black, partial source dots weighted by how much of them falls inside.
 * Black when at least FIT_INK_SHARE (40%) of the box is black. Not 50%: a 2-dot stroke (the letters in a logo) can fall
 * across two boxes 1 dot each — 42% of each — and at 50% it would vanish in both; at 40% it survives wherever it lies,
 * a shade bolder. Nearest neighbour would keep one source dot in every 2.4 and drop the rest: a 2-dot stroke between
 * two sampled columns disappears outright.
 */
export const FIT_INK_SHARE = 0.4;

export function fitMonoRaster(r: MonoRaster, maxWidth: number, maxHeight: number): MonoRaster {
  const scale = Math.min(1, maxWidth / r.width, maxHeight / r.height);
  if (scale >= 1) return r;
  const outW = Math.max(1, Math.min(maxWidth, Math.round(r.width * scale)));
  const outH = Math.max(1, Math.min(maxHeight, Math.round(r.height * scale)));
  const sx = r.width / outW, sy = r.height / outH;   // source dots per output dot, each axis
  const inStride = bytesPerRow(r.width), outStride = bytesPerRow(outW);
  const black = (x: number, y: number) => (r.bytes[y * inStride + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  // The overlap of output dot i's box [i*s, (i+1)*s) with each source dot it touches — the same for every row/column.
  const spans = (n: number, s: number, limit: number) => Array.from({ length: n }, (_, i) => {
    const a = i * s, b = Math.min(limit, (i + 1) * s), parts: Array<[number, number]> = [];
    for (let k = Math.floor(a); k < b; k++) parts.push([k, Math.min(b, k + 1) - Math.max(a, k)]);
    return parts;
  });
  const xs = spans(outW, sx, r.width), ys = spans(outH, sy, r.height);
  const out = new Uint8Array(outStride * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let ink = 0, area = 0;
      for (const [yy, wy] of ys[y]) for (const [xx, wx] of xs[x]) { const w = wx * wy; area += w; if (black(xx, yy)) ink += w; }
      if (area > 0 && ink / area >= FIT_INK_SHARE - 1e-9) out[y * outStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width: outW, height: outH, bytes: out };
}

const PREFIX = 'mono1:';

// A316: base64 WITHOUT Buffer or atob/btoa. This file runs in three places —
// the till's main process (Node), and the web's Branding page, POS and reprint
// (a browser, via the esbuild bundle). The bundle's Buffer shim only fakes
// Buffer.from(array); `.toString('base64')` on it gave "255,255,..." and
// Buffer.from(str, 'base64') gave garbage, so every web encode was rejected by
// the cloud and every web decode returned null (2026-09-23). A tiny codec here
// has no environment to differ between. Decoding accepts exactly the alphabet
// and padding the cloud's validator accepts (routes/business.ts), nothing else.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=')
      + (i + 2 < bytes.length ? B64[c & 63] : '=');
  }
  return out;
}

function base64Decode(s: string): Uint8Array | null {
  if (!B64_RE.test(s)) return null;
  // Padding is not trusted either way: the cloud's validator accepts zero, one or
  // two '=' regardless of length and stores what Node's lenient decoder reads,
  // so strip it and re-derive it. A value the cloud stored must never print as
  // "no logo" here.
  s = s.replace(/=+$/, '');
  if (s.length % 4 === 1) return null;              // no valid encoding ends like this
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12)
      | ((s[i + 2] === '=' ? 0 : B64.indexOf(s[i + 2])) << 6) | (s[i + 3] === '=' ? 0 : B64.indexOf(s[i + 3]));
    out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function monoRasterToString(r: MonoRaster): string {
  assertRaster(r);
  return `${PREFIX}${r.width}:${r.height}:${base64Encode(r.bytes)}`;
}

/** null on anything malformed — a bad stored value must print NO logo, never a
 *  garbage block, and never throw inside the print path. */
export function monoRasterFromString(s: string | null | undefined): MonoRaster | null {
  if (!s || !s.startsWith(PREFIX)) return null;
  const parts = s.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const width = Number(parts[0]), height = Number(parts[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width > PRINTER_MAX_DOTS) return null;
  const bytes = base64Decode(parts[2]);
  if (!bytes || bytes.length !== bytesPerRow(width) * height) return null;
  return { width, height, bytes };
}

export function assertRaster(r: MonoRaster): void {
  if (r.width <= 0 || r.width > PRINTER_MAX_DOTS || r.height <= 0) {
    throw new Error(`raster: ${r.width}x${r.height} is outside what a printer accepts`);
  }
  if (r.bytes.length !== bytesPerRow(r.width) * r.height) {
    throw new Error(`raster: ${r.bytes.length} bytes does not match ${r.width}x${r.height}`);
  }
}

/** Rows of '#' and ' ' — for tests and the settings preview. */
export function monoRasterToAscii(r: MonoRaster, black = '#', white = ' '): string[] {
  const stride = bytesPerRow(r.width);
  const rows: string[] = [];
  for (let y = 0; y < r.height; y++) {
    let row = '';
    for (let x = 0; x < r.width; x++) row += (r.bytes[y * stride + (x >> 3)] & (0x80 >> (x & 7))) ? black : white;
    rows.push(row);
  }
  return rows;
}
