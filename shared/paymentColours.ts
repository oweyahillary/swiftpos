/**
 * paymentColours.ts — one fixed colour per payment method (A344, 2026-09-27).
 *
 *  Byte-identical copies live at:
 *      shared/paymentColours.ts                   (canonical)
 *      apps/desktop/src/shared/paymentColours.ts  (the till)
 *      apps/dashboard/src/lib/paymentColours.ts   (the web)
 *  scripts/check-shared-sync.mjs fails CI if they diverge. Self-contained on purpose (no imports).
 *
 *  Owner, 2026-09-27: "we can make the payment method color full each with a color" — on the payment buttons AND the
 *  method labels in orders, the shift panel / Z-report and reports.
 *
 *  A method colour says WHICH METHOD, the way a status colour says paid or void. It is never the ACTION colour: a
 *  selected method button still shows the theme's highlight (action-*), so "what you pressed" keeps following the theme.
 *  How it is used, so it reads in dark AND light mode without touching text contrast:
 *    • `dot`  — a small swatch beside the method name (a graphic: ≥ 3:1 on every surface, tested). Each is the mid-tone of
 *               its hue that reads on BOTH the till's dark panels and the web's white (~3.6:1 on all — the ceiling);
 *    • `tint` — the dot colour at low alpha behind an UNSELECTED method button; the label keeps the normal text colour.
 *  M-Pesa keeps its familiar green, which is why SwiftPOS's own action colour moved away from green (A329).
 */

export type PayHex = string;
export interface MethodColour { dot: PayHex; name: string }

export const METHOD_COLOURS: Record<string, MethodColour> = {
  cash:   { dot: '#ac7404', name: 'amber' },
  mpesa:  { dot: '#2a904c', name: 'green' },
  card:   { dot: '#4879ed', name: 'blue' },
  credit: { dot: '#9461ed', name: 'violet' },
  glovo:  { dot: '#d8560b', name: 'orange' },
};

/** Colours for the business's own custom tenders (A96), chosen by a stable hash of the code — the same tender is always
 *  the same colour on every till and the web. */
export const CUSTOM_METHOD_COLOURS: MethodColour[] = [
  { dot: '#dd408f', name: 'pink' },
  { dot: '#0d8ca3', name: 'cyan' },
  { dot: '#e1455f', name: 'rose' },
  { dot: '#5e8c10', name: 'lime' },
  { dot: '#768093', name: 'slate' },
];

export function methodColour(code: string | null | undefined): MethodColour {
  const c = String(code ?? '').trim().toLowerCase();
  if (METHOD_COLOURS[c]) return METHOD_COLOURS[c];
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return CUSTOM_METHOD_COLOURS[h % CUSTOM_METHOD_COLOURS.length];
}

/** The dot at `alpha` (0–1) as rgba() — the tint behind an unselected method button. */
export function methodTint(code: string | null | undefined, alpha = 0.14): string {
  const hex = methodColour(code).dot.replace('#', '');
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
