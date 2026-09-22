/**
 * brandingGuard.ts — A301. PURE validation for a local branding WRITE (accent + logo).
 *
 * No SQLite, no Electron, no DOM imports — deliberately, so the test drives THIS real
 * code on plain Node (rule 24: pin the thing that actually enforces, not a copy of it),
 * exactly the route contrast.ts / contrast.test.mjs takes.
 *
 * Slice 1 (the desktop-local write path) accepts an accent hex and a RASTER logo only.
 * SVG is rejected here and stays deferred to its own slice: an SVG is code, and making it
 * safe needs an allow-list DOM sanitiser (DOMPurify-class, renderer + server), which is
 * NOT a small pure helper like this one. See docs/A295-SLICE1C-UPLOAD-VALIDATION.md, and
 * rule 20 — do not ship the thing whose guard does not exist yet.
 *
 * This runs at the persist boundary in the main process too (setBranding calls it), not
 * only in the renderer — the renderer is not trusted, per the SVG-upload research: a caller
 * can skip the UI entirely, so the check that protects the row must live where the row is
 * written.
 */

/** Spec cap. Logos ride base64 inside the branding row and sync to every till — keep small. */
export const MAX_LOGO_BYTES = 250 * 1024;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RASTER_DATA_URI = /^data:image\/(?:png|jpeg);base64,/i;
const SVG_DATA_URI = /^data:image\/svg\+xml/i;

export interface BrandingWrite {
  accentHex?: string | null;
  logoPng?: string | null;
  /** A312: the logo's pixels as a canvas returns them (RGBA, row-major). Main thresholds
   *  them into `logo_receipt` via shared/printing raster.ts — the renderer never does. */
  logoRgba?: LogoRgba | null;
  /** A312: the client's opt-in receipt-logo toggle (tech switch; the web page is the client one). */
  receiptLogoEnabled?: boolean;
}

export interface LogoRgba { width: number; height: number; data: ArrayLike<number> }

/** Widest a receipt logo is ever prepared at; raster.ts shrinks further if needed. */
export const RGBA_MAX_WIDTH = 384;
export const RGBA_MAX_HEIGHT = 240;

/**
 * Normalised write. `undefined` is preserved to mean "leave this column as-is" for the
 * merge in setBranding; `null` means "clear it"; a value means "set it".
 */
export interface BrandingClean {
  accentHex: string | null | undefined;
  logoPng: string | null | undefined;
  logoRgba: LogoRgba | null | undefined;
  receiptLogoEnabled: boolean | undefined;
}

/**
 * Decoded byte length of a base64 data-URI payload, computed from the string so we never
 * allocate a multi-hundred-KB Buffer just to measure it.
 */
export function base64Bytes(dataUri: string): number {
  const comma = dataUri.indexOf(',');
  const b64 = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  if (b64.length === 0) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Validate and normalise a branding write. Throws Error with a verbatim, human-readable
 * message (rules 7/11 — no swallowing, no paraphrase) on anything invalid. Returns the
 * fields to persist, with `undefined` preserved for the "leave as-is" merge.
 */
export function validateBrandingWrite(write: BrandingWrite): BrandingClean {
  let accentHex: string | null | undefined = write.accentHex;
  if (accentHex !== undefined && accentHex !== null) {
    const trimmed = accentHex.trim();
    if (!HEX.test(trimmed)) {
      throw new Error(`branding: accent "${accentHex}" is not a #RGB or #RRGGBB hex colour`);
    }
    accentHex = trimmed.toLowerCase();
  }

  let logoPng: string | null | undefined = write.logoPng;
  if (logoPng !== undefined && logoPng !== null) {
    if (SVG_DATA_URI.test(logoPng)) {
      throw new Error(
        'branding: SVG logos are not accepted yet — an SVG needs the sanitiser slice; ' +
          'upload a PNG or JPEG for now',
      );
    }
    if (!RASTER_DATA_URI.test(logoPng)) {
      throw new Error('branding: logo must be a data:image/png or data:image/jpeg base64 data-URI');
    }
    const bytes = base64Bytes(logoPng);
    if (bytes > MAX_LOGO_BYTES) {
      throw new Error(
        `branding: logo is ${(bytes / 1024).toFixed(0)} KB; the cap is ` +
          `${MAX_LOGO_BYTES / 1024} KB — shrink it before upload`,
      );
    }
  }

  // A312: pixels for the receipt raster. Bounded so a renderer cannot hand main a
  // 4K image over IPC; raster.ts caps again, but the cheap check belongs at the door.
  let logoRgba: LogoRgba | null | undefined = write.logoRgba;
  if (logoRgba !== undefined && logoRgba !== null) {
    const { width, height, data } = logoRgba as LogoRgba;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`branding: logo pixels have bad dimensions ${width}x${height}`);
    }
    if (width > RGBA_MAX_WIDTH || height > RGBA_MAX_HEIGHT) {
      throw new Error(`branding: logo pixels ${width}x${height} exceed ${RGBA_MAX_WIDTH}x${RGBA_MAX_HEIGHT} — shrink before sending`);
    }
    if (!data || typeof data.length !== 'number' || data.length !== width * height * 4) {
      throw new Error(`branding: logo pixels must be ${width * height * 4} RGBA bytes, got ${data?.length ?? 'none'}`);
    }
  }
  // Clearing the logo clears its receipt raster too — a raster with no logo behind it is stale.
  if (logoPng === null && logoRgba === undefined) logoRgba = null;

  let receiptLogoEnabled: boolean | undefined = write.receiptLogoEnabled;
  if (receiptLogoEnabled !== undefined && typeof receiptLogoEnabled !== 'boolean') {
    throw new Error('branding: receiptLogoEnabled must be true or false');
  }

  return { accentHex, logoPng, logoRgba, receiptLogoEnabled };
}
