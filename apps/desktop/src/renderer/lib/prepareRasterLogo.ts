/**
 * prepareRasterLogo.ts — A301. Turn a client's PNG/JPEG into a stored branding logo:
 * downscale to fit, re-encode to transparent PNG, keep it under the 250 KB row cap.
 *
 * SHRINK, NEVER CROP. The lock-screen logo-card uses object-fit: contain, so any aspect
 * ratio already seats correctly — cropping would only mutilate the mark. We preserve aspect
 * and reduce the longest edge; we do NOT change the shape of anyone's logo.
 *
 * Renderer-only: it needs the DOM (createImageBitmap + <canvas>), so — like the future SVG
 * sanitiser and unlike the pure contrast.ts — it is NOT a shared synced helper. Using the
 * browser image decoder also means a PNG/JPEG can't execute anything on decode, which is why
 * raster is safe to ship now while SVG waits for its sanitiser slice.
 *
 * The bytes this produces are re-checked at the persist boundary by brandingGuard.ts /
 * setBranding — the renderer is not the security boundary; the main-process write is.
 *
 * SVG is rejected here with a clear message; callers should not offer it yet.
 */
import { MAX_LOGO_BYTES } from '../../main/brandingGuard';

const MAX_EDGE = 1024; // spec max longest edge
const MIN_EDGE = 128; // spec min before we warn about blur
const HARD_REJECT_EDGE = 2048; // spec hard ceiling for raster
const STEP_EDGES = [1024, 768, 512, 384, 256]; // step down re-encoding until under the cap
const ACCEPT_TYPES = ['image/png', 'image/jpeg'];

export interface PreparedLogo {
  /** data:image/png;base64,… ready to hand to posApi.branding.set. */
  logoPng: string;
  /** Non-fatal advisories to surface to the client (e.g. small source → may look blurry). */
  warnings: string[];
}

function dataUriBytes(dataUri: string): number {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

function drawToDataUri(bitmap: ImageBitmap, longestEdge: number): string {
  const scale = Math.min(1, longestEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('logo: could not get a 2D canvas context to resize the image');
  ctx.clearRect(0, 0, w, h); // transparent base, so PNG output keeps transparency
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL('image/png'); // always PNG out — preserves transparency on the white card
}

/**
 * Validate, decode, downscale and re-encode a raster logo file. Throws Error (verbatim
 * message, rule 7) on anything we cannot store. Never upscales; never crops.
 */
export async function prepareRasterLogo(file: File): Promise<PreparedLogo> {
  const warnings: string[] = [];

  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    throw new Error('SVG logos are not accepted yet — upload a PNG or JPEG for now.');
  }
  if (!ACCEPT_TYPES.includes(file.type)) {
    throw new Error(`Unsupported logo type "${file.type || file.name}" — use PNG or JPEG.`);
  }
  // Sanity ceiling BEFORE decode, purely as an abuse/DoS bound — no real logo is this big.
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('Logo file is over 10 MB — that is far larger than any logo needs to be.');
  }

  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest > HARD_REJECT_EDGE * 2) {
      // Extremely large canvases are refused rather than silently re-sized to mud.
      throw new Error(
        `Logo is ${bitmap.width}×${bitmap.height}px — too large to process; ` +
          'downscale it below ~2048px and try again.',
      );
    }
    if (longest < MIN_EDGE) {
      warnings.push(
        `Logo is only ${longest}px on its longest side; it may look blurry on the card ` +
          '(around 512px is ideal).',
      );
    }

    // Start at min(source, MAX_EDGE) — never upscale — then step down until under the cap.
    const startEdge = Math.min(longest, MAX_EDGE);
    const ladder = [startEdge, ...STEP_EDGES.filter((e) => e < startEdge)];
    let out = '';
    for (const edge of ladder) {
      out = drawToDataUri(bitmap, edge);
      if (dataUriBytes(out) <= MAX_LOGO_BYTES) {
        if (edge < startEdge) {
          warnings.push(
            `Logo was reduced to ${edge}px on its longest side to fit the ` +
              `${MAX_LOGO_BYTES / 1024} KB limit.`,
          );
        }
        return { logoPng: out, warnings };
      }
    }
    // Even at the smallest rung it will not fit — the mark is too detailed to store as raster.
    throw new Error(
      `This logo is too detailed to store under ${MAX_LOGO_BYTES / 1024} KB even at ` +
        `${STEP_EDGES[STEP_EDGES.length - 1]}px. Use a simpler mark (or an SVG once supported).`,
    );
  } finally {
    bitmap.close();
  }
}
