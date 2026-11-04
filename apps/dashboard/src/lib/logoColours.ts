/**
 * logoColours.ts — A605 (owner, 2026-10-28: "match colors perfectly, give them a feel of their brand"): the colours of the
 * shop's own logo, so the owner can take the brand colours straight from it ("Use colours from my logo" on Branding), and
 * which surface the logo itself sits best on (a white logo on a dark chip, a dark one on white).
 *
 *  logoColoursFromPixels is PURE (RGBA pixels in, colours out) and tested on synthetic images
 *  (tests/brand-palette-a605.test.mjs). logoColoursFromDataUri is the browser's half: it draws the logo on a canvas.
 *
 *  How: sample up to ~20,000 pixels; skip transparent ones and the near-white / near-black of a background or outline;
 *  count the rest in coarse colour boxes (16 levels a channel) and take each box's average (a flat logo colour comes out
 *  exactly); rank by how many pixels and how colourful; drop any colour too close to one already taken (OKLab 0.09).
 */
import { oklab, oklch, type Hex } from '@zaptill/core/themes';

export interface LogoColours {
  /** 0–5 dominant colours, most important first (#rrggbb). */
  colours: Hex[];
  /** The chip the logo reads best on: 'dark' for a light logo on a transparent background, else 'light' (white). */
  chip: 'light' | 'dark';
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
const toHex = (r: number, g: number, b: number): Hex => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export function logoColoursFromPixels(data: ArrayLike<number>, width: number, height: number, max = 5): LogoColours {
  const w = Math.max(0, Math.floor(width)), h = Math.max(0, Math.floor(height));
  if (!w || !h || data.length < w * h * 4) return { colours: [], chip: 'light' };
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
  const boxes = new Map<number, { n: number; r: number; g: number; b: number }>();
  let considered = 0, opaque = 0, lightSum = 0, edge = 0, edgeClear = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4, a = data[i + 3];
      const onEdge = x < step || y < step || x >= w - step || y >= h - step;
      if (onEdge) { edge++; if (a < 128) edgeClear++; }
      if (a < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const hex = toHex(r, g, b);
      const [L] = oklab(hex);
      opaque++; lightSum += L;
      const { C } = oklch(hex);
      if (C < 0.05 && (L > 0.93 || L < 0.18)) continue;   // background white, outline black
      considered++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const box = boxes.get(key);
      if (box) { box.n++; box.r += r; box.g += g; box.b += b; } else boxes.set(key, { n: 1, r, g, b });
    }
  }
  const transparentEdge = edge > 0 && edgeClear / edge > 0.5;
  const chip: 'light' | 'dark' = transparentEdge && opaque > 0 && lightSum / opaque > 0.78 ? 'dark' : 'light';
  const minCount = Math.max(1, considered * 0.005);
  const ranked = [...boxes.values()].filter((x) => x.n >= minCount).map((x) => {
    const hex = toHex(x.r / x.n, x.g / x.n, x.b / x.n);
    return { hex, lab: oklab(hex), score: x.n * (0.35 + Math.min(1, oklch(hex).C / 0.12)) };
  }).sort((p, q) => q.score - p.score);
  const picked: Array<{ hex: Hex; lab: [number, number, number] }> = [];
  for (const c of ranked) {
    if (picked.length >= max) break;
    if (picked.some((p) => Math.hypot(p.lab[0] - c.lab[0], p.lab[1] - c.lab[1], p.lab[2] - c.lab[2]) < 0.09)) continue;
    picked.push(c);
  }
  return { colours: picked.map((p) => p.hex), chip };
}

/** The browser's half: the logo (a data URI) drawn at most 160 px across, then logoColoursFromPixels. */
export async function logoColoursFromDataUri(uri: string, max = 5): Promise<LogoColours> {
  const img = new Image();
  img.decoding = 'async';
  img.src = uri;
  await img.decode();
  const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { colours: [], chip: 'light' };
  ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  return logoColoursFromPixels(ctx.getImageData(0, 0, w, h).data, w, h, max);
}
