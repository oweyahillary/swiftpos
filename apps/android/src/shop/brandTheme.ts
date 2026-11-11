/**
 * brandTheme.ts — paint the Android SHELL (the PIN pad, the start and setup screens) in the client's brand colours, so
 * the app wears their palette from the moment the device is registered, not the fixed ZapTill teal. A requirement, not a
 * nice-to-have (owner, 2026-11-09): the colours load among the first things after a device is linked to a business.
 *
 * Where the colours come from (two sources, both already on the device):
 *   • enrolment — tillSession.cacheBranding() fetches pos/init with the till's own token right after joining and writes
 *     'swiftpos_shop_brand' (+ 'swiftpos_shop_logo'); so a freshly-registered device is branded before anyone signs in;
 *   • each sign-in — the web POS (CashierScreen) re-writes the same keys from pos/init, as the desktop lock screen caches
 *     its logo (A368).
 *
 * The POS screens themselves are themed by the web POS (usePOSData → posColours); this file is only the native shell.
 */

interface ShopBrand { primary?: string | null; secondary?: string | null; accent?: string | null }

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A lighter tint of a #rrggbb colour (for the brand-light accent on borders and the logo chip). */
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 0xff), g = mix((n >> 8) & 0xff), b = mix(n & 0xff);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Read the cached brand colours and set the shell's CSS variables. No cache yet (brand-new device) → the teal stays. */
export function applyShopBrand(): void {
  let brand: ShopBrand | null = null;
  try {
    const raw = localStorage.getItem('swiftpos_shop_brand');
    brand = raw ? (JSON.parse(raw) as ShopBrand) : null;
  } catch { brand = null; }
  if (!brand) return;
  const accent = [brand.accent, brand.primary, brand.secondary].find((c) => typeof c === 'string' && HEX.test(c));
  if (!accent) return;
  const root = document.documentElement;
  root.style.setProperty('--brand', accent);
  root.style.setProperty('--brand-light', lighten(accent, 0.4));
}
