/**
 * contrast.ts — WCAG contrast maths + the A295 branding accent resolver.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  SHARED FILE. Byte-identical copies live at:
 *      shared/contrast.ts
 *      apps/desktop/src/shared/contrast.ts   (the renderer / PinPage imports this)
 *      apps/desktop/src/main/contrast.ts     (compiled to dist/main → the unit test)
 *      apps/dashboard/src/lib/contrast.ts    (the web Branding page — A319)
 *  scripts/check-shared-sync.mjs fails CI if they diverge. Edit ONE copy, copy it
 *  to the others verbatim, run the vectors. Do not "fix" one side in place.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 *
 * A295 lets a client set an accent colour (in the web portal) that the desktop
 * app and the portal both adopt. A colour a human picks is not a colour a human
 * can read on: a yellow accent with white button text is 1.79:1 — unreadable.
 * This module is the single gate that decides, from the accent alone, (a) whether
 * a filled control's text must be black or white and (b) whether the accent is
 * legible enough to use at all, or the screen must fall back to the SwiftPOS
 * default. It is pure — no imports, no DOM, no SQLite — so it is unit-testable on
 * plain Node and behaves identically on every surface that renders branding.
 *
 * It does NOT change the theme. DEFAULT_ACCENT is the current shipped accent
 * (green). The surface is passed IN by the caller (the lock card is #0d1424, a
 * till header is gray-900) rather than hardcoded, so the same maths serves every
 * surface and no single "lock surface" constant has to be guessed here.
 */

/** Current-theme default accent (teal-600, #0d9488). Used when a client sets none, or
 *  when a client's accent is rejected as illegible. */
export const DEFAULT_ACCENT = '#0d9488';

/** Minimum contrast we accept for a filled control vs its text, and for an accent
 *  mark vs its surface. 3:1 is the WCAG 2.1 floor for large/bold text and for
 *  non-text UI components (SC 1.4.11) — a keypad Enter label and a divider are
 *  exactly those. */
export const MIN_RATIO = 3;

const HEX6 = /^#([0-9a-fA-F]{6})$/;
const HEX3 = /^#([0-9a-fA-F]{3})$/;

/** Normalise #rgb / #RRGGBB to lowercase #rrggbb, or null if not a valid hex. */
export function normalizeHex(hex: string): string | null {
  if (typeof hex !== 'string') return null;
  const s = hex.trim();
  if (HEX6.test(s)) return s.toLowerCase();
  const m = HEX3.exec(s);
  if (m) return ('#' + m[1].split('').map((c) => c + c).join('')).toLowerCase();
  return null;
}

function channelLinear(srgb: number): number {
  const c = srgb / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a hex colour (0..1). Throws on an invalid hex —
 *  a bad colour here is a programmer error, not client input. */
export function relativeLuminance(hex: string): number {
  const n = normalizeHex(hex);
  if (!n) throw new Error('relativeLuminance: invalid hex ' + JSON.stringify(hex));
  const r = channelLinear(parseInt(n.slice(1, 3), 16));
  const g = channelLinear(parseInt(n.slice(3, 5), 16));
  const b = channelLinear(parseInt(n.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export type ButtonText = '#000000' | '#ffffff';

export interface ButtonTextChoice {
  text: ButtonText;
  ratio: number;
}

/**
 * The readable text colour for a filled control of colour `accent`: black or
 * white, whichever has more contrast. Ties go to black — dark text reads as the
 * calmer, more "brand" choice and matches the current green button, which uses
 * near-black text.
 */
export function pickButtonText(accent: string): ButtonTextChoice {
  const onBlack = contrastRatio(accent, '#000000');
  const onWhite = contrastRatio(accent, '#ffffff');
  return onBlack >= onWhite
    ? { text: '#000000', ratio: onBlack }
    : { text: '#ffffff', ratio: onWhite };
}

export interface ResolvedBranding {
  /** The accent actually used — the client's, or the SwiftPOS default on fallback. */
  accent: string;
  /** Readable text for a filled control of `accent`. */
  buttonText: ButtonText;
  /** Contrast of buttonText on `accent`. */
  buttonRatio: number;
  /** Contrast of `accent` against the surface it marks (divider, active dot). */
  accentOnSurface: number;
  /** True when the client's accent was rejected and the default substituted. */
  usedFallback: boolean;
}

/**
 * Resolve a client accent for a given surface. The client's accent is used only
 * when it is a valid hex, legible against the surface (>= MIN_RATIO), AND its best
 * button text clears MIN_RATIO. Otherwise the SwiftPOS default is used and
 * re-measured (the default is assumed legible, but is measured too so a caller can
 * spot a surface that even the default fails — a surface bug, not an accent one).
 */
export function resolveBranding(
  accent: string | null | undefined,
  surface: string,
  defaultAccent: string = DEFAULT_ACCENT,
): ResolvedBranding {
  const n = accent == null ? null : normalizeHex(accent);
  if (n) {
    const onSurface = contrastRatio(n, surface);
    const btn = pickButtonText(n);
    if (onSurface >= MIN_RATIO && btn.ratio >= MIN_RATIO) {
      return {
        accent: n,
        buttonText: btn.text,
        buttonRatio: btn.ratio,
        accentOnSurface: onSurface,
        usedFallback: false,
      };
    }
  }
  const d = normalizeHex(defaultAccent) ?? DEFAULT_ACCENT;
  const btn = pickButtonText(d);
  return {
    accent: d,
    buttonText: btn.text,
    buttonRatio: btn.ratio,
    accentOnSurface: contrastRatio(d, surface),
    usedFallback: true,
  };
}
