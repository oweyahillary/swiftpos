/**
 * loginBrand.ts — A424 (owner, 2026-10-10: "use the client's branding colour … the content overflows, can we find a
 * better way, something classy and presentable"). The colours of the sign-in page from the client's accent (A378,
 * /api/tenant/:subdomain), or ZapTill's own teal on the main address.
 *
 *   · `accent`  — the client's colour, lifted toward white until it shows on the page's near-black (≥ 3:1), so a navy
 *                 or black brand colour still reads as a button and a focus ring;
 *   · `text`    — black or white on the accent, whichever reads better (contrast.ts pickButtonText);
 *   · `raw`     — the client's colour as given, for the brand panel's wash (behind it, never under text).
 */
import { DEFAULT_ACCENT, normalizeHex, contrastRatio, pickButtonText } from '@zaptill/core/contrast';

export const LOGIN_BG = '#080c14';

function mixWithWhite(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

export function loginBrand(accent: string | null | undefined): { raw: string; accent: string; text: '#000000' | '#ffffff' } {
  const raw = (accent && normalizeHex(accent)) || DEFAULT_ACCENT;
  let shown = raw;
  for (let t = 0.1; contrastRatio(shown, LOGIN_BG) < 3 && t <= 1.0001; t += 0.1) shown = mixWithWhite(raw, t);
  return { raw, accent: shown, text: pickButtonText(shown).text };
}
