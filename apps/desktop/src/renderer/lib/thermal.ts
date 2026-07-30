/**
 * thermal.ts — receipt/ticket document construction for thermal printers.
 *
 * Written from scratch to replace the millimetre-based guessing in the previous
 * printReceipt.ts. Everything here is derived from the print head's DOT COUNT,
 * because that is the only number the hardware actually has.
 *
 * ── WHAT WAS WRONG BEFORE ───────────────────────────────────────────────────
 *
 * The old builder laid the document out at the MEDIA width — 80mm — and assumed
 * that was the printable width. It is not. On the XP-80 (and essentially every
 * 80mm thermal printer) the head is 576 dots at 203dpi:
 *
 *     576 ÷ 203 × 25.4  =  72.06mm
 *
 * which is exactly what the Windows driver reports as `80(72.1) x 297 mm`:
 * 80mm of paper, 72.1mm of it printable. Laying out at 80mm pushes the last
 * ~8mm of every line past the end of the head, so the right-hand column — the
 * amounts — is silently cut off.
 *
 * The same is true at 58mm: the head is 384 dots = 48.03mm, not 58mm.
 *
 * ── WHY THE COLUMN IS LEFT-ALIGNED, NOT CENTRED ─────────────────────────────
 *
 * An earlier attempt centred a 72mm column inside an 80mm page. That is worse
 * than not fixing it: centring puts the column at 3.95mm..76.05mm, so ~4mm
 * still falls outside the head and the clipping continues, just less of it.
 * With `margins: none` the page origin is where printing starts, so the column
 * sits at x=0 and spans exactly the head's 576 dots. Text that asks to be
 * centred is then centred within the PRINTED area, which is what the eye reads
 * as centred.
 *
 * ── WHY EVERYTHING IS BOLD AND PURE BLACK ───────────────────────────────────
 *
 * A thermal head is one bit per dot: a dot is burned or it is not. Chromium
 * renders text anti-aliased in greyscale, so every glyph edge arrives as mid
 * grey, gets dithered to a sparse scatter of dots, and the result reads as
 * faint and washed out. Thin strokes suffer worst — at 203dpi a light Courier
 * stem can land under two dots wide and half of it dithers away.
 *
 * So: pure #000 only, bold body text, and no grey anywhere. A grey rule is not
 * a lighter line on this hardware, it is a broken one.
 */

export type PaperWidth = 58 | 80;

/** Print head resolution. Effectively universal on receipt printers. */
export const DPI = 203;

/**
 * Dots per line for each paper size — the hardware's real capability.
 * XP-80 spec: 576 dots/line, 72mm print width, 79.5±0.5mm media.
 */
export const HEAD_DOTS: Record<PaperWidth, number> = { 58: 384, 80: 576 };

/** Physical media width. Used ONLY for the page box handed to the driver. */
export const MEDIA_MM: Record<PaperWidth, number> = { 58: 58, 80: 80 };

/** Printable width in mm, derived from dots. 80 → 72.07mm, 58 → 48.05mm. */
export function printableMm(paper: PaperWidth): number {
  return (HEAD_DOTS[paper] / DPI) * 25.4;
}

/**
 * The width actually used for layout, in mm.
 *
 * Defaults to the head width, but a till may override it. Printers vary: some
 * 80mm units expose more than 576 dots, and a driver may place the printable
 * area with an offset that leaves usable paper unclaimed on one side. Rather
 * than argue about it, this is a number the site can set and verify with the
 * calibration ticket in one print.
 *
 * MAY EXCEED THE PAPER WIDTH, deliberately.
 *
 * This is a LAYOUT width, not a claim about the paper. If the driver scales the
 * page down on its way to the head — which is what a ticket measuring ~54mm when
 * 72.07mm was requested means — then the only way to land 72mm on paper is to
 * lay out wider and let the scaling bring it back. Capping this at the media
 * width made the setting useless for the very fault it exists to correct.
 *
 * The arithmetic: print the width test, measure the bar labelled N, then
 *   Print width = N x (N / measured)
 * e.g. an 80mm bar that measures 57mm -> 80 x (80/57) = 112mm.
 *
 * Still clamped at 3x the media width, which is far past any real scaling factor
 * and stops a typo from generating a metre-wide page.
 */
export function layoutMm(paper: PaperWidth, overrideMm?: number | null): number {
  const head = printableMm(paper);
  if (!overrideMm || !Number.isFinite(overrideMm)) return head;
  return Math.min(Math.max(overrideMm, head * 0.5), MEDIA_MM[paper] * 3);
}

/** CSS pixels at the browser's fixed 96dpi. */
const CSS_DPI = 96;
export const mmToPx = (mm: number) => (mm / 25.4) * CSS_DPI;

/** Width of the content column, in CSS px. This is the number that matters. */
export function contentPx(paper: PaperWidth, overrideMm?: number | null): number {
  return Math.floor(mmToPx(layoutMm(paper, overrideMm)));
}

/**
 * Monospace columns available at a given font size.
 * Courier New advances at 0.6em, so 576 dots at 9pt ≈ 45 characters. Useful for
 * deciding where to truncate item names rather than letting them wrap raggedly.
 */
export function charsPerLine(paper: PaperWidth, fontPt: number, overrideMm?: number | null): number {
  const emPx = (fontPt / 72) * CSS_DPI;
  return Math.floor(contentPx(paper, overrideMm) / (emPx * 0.6));
}

export interface TicketDocOptions {
  paper: PaperWidth;
  /** Body size in points. 10pt matches the density of the reference receipts;
   *  9pt is the practical floor for legibility at 203dpi. */
  fontPt?: number;
  /** Override the layout width in mm. Null/undefined = use the head width. */
  widthMm?: number | null;
  title?: string;
  /** Blank millimetres after the last line so it clears the tear bar/cutter. */
  tailMm?: number;
}

/**
 * Wraps ticket content in a complete, thermal-correct HTML document.
 *
 * Deliberately NOT configurable in the ways the old builder was. Font size and
 * width were settings that let a till be configured into producing unreadable
 * output; the constraints here come from the hardware and are not opinions.
 */
export function buildTicketDocument(contentHtml: string, opts: TicketDocOptions): string {
  const { paper, fontPt = 10, title = 'Ticket', tailMm = 8, widthMm = null } = opts;
  const widthPx = contentPx(paper, widthMm);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  *, *::before, *::after {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    /* One bit per dot: anything that is not pure black dithers to a scatter. */
    color: #000 !important;
    /* Bold is forced with !important because the ticket BUILDERS set
       font-weight:normal inline on qualifier text, and an inline declaration
       beats a plain rule on html/body. That is precisely why "(Normal, Soda)"
       came out visibly washed out while the item name above it was solid. */
    font-weight: 700 !important;
    background: transparent !important;
    box-shadow: none !important;
    text-shadow: none !important;
  }

  html, body {
    width: ${widthPx}px;
    /* Left-aligned at the page origin: with margins:none this is the first dot
       the head can fire. Centring here would push the tail off the end. */
    margin: 0;
    padding: 0;
    font-family: 'Courier New', Courier, monospace;
    font-size: ${fontPt}pt;
    /* Bold throughout. Not a style choice — thin stems dither away at 203dpi. */
    font-weight: 700;
    line-height: 1.45;
    color: #000;
    background: #fff;
    /* Stop the renderer softening glyph edges into grey. */
    -webkit-font-smoothing: none;
    font-smooth: never;
    text-rendering: geometricPrecision;
  }

  /* No overflow:hidden. The head clips at its last dot regardless, but hiding
     overflow also hid it from the on-screen preview — so a value that was too
     long simply disappeared with no sign anything was wrong. Let it spill: a
     visibly ragged edge during testing is worth far more than a clean-looking
     receipt that has quietly dropped half a cashier's name. */
  .ticket { width: ${widthPx}px; word-break: break-word; }

  /* Rules are solid black, never grey — a grey hairline prints as gaps. */
  .rule  { border-top: 1px solid #000; margin: 5px 0; height: 0; }
  .rule-dashed { border-top: 1px dashed #000; margin: 5px 0; height: 0; }

  /* Two- and three-column rows. Table layout rather than flex: flex percentages
     round unpredictably at this width and shunted the amount column off the
     edge. Fixed table layout puts every amount on the same dot column. */
  table.rows { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.rows td { vertical-align: top; padding: 0; }
  td.qty { width: 12%; text-align: right; }
  td.amt { width: 30%; text-align: right; white-space: nowrap; }
  td.name { width: 58%; }

  .center { text-align: center; }
  .right  { text-align: right; }
  .big    { font-size: ${fontPt + 4}pt; }
  .huge   { font-size: ${fontPt + 7}pt; }

  /* Trailing feed so the final line clears the tear bar. Without it the last
     lines sit under the head and have to be pulled through by hand. */
  .tail { height: ${tailMm}mm; }

  @media print {
    html, body { width: ${widthPx}px; max-width: ${widthPx}px; }
    .ticket { page-break-inside: avoid; break-inside: avoid; }
  }
</style>
</head>
<body><div class="ticket">${contentHtml}</div><div class="tail"></div></body>
</html>`;
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

/** A left label and a right value on one line, aligned to the column edges. */
export function metaRow(label: string, value: string): string {
  return `<table class="rows"><tr><td>${esc(label)}</td><td class="right">${esc(value)}</td></tr></table>`;
}

/**
 * Calibration ticket — makes the geometry measurable instead of arguable.
 *
 * Prints a ruler spanning the full content column with a tick every 10mm. Lay a
 * real ruler on it:
 *
 *   • Reads the stated width  → geometry is correct, head is fully used.
 *   • Reads short             → the driver is still scaling; printed ÷ stated
 *                               is the exact factor.
 *   • Right end cut off       → the column is wider than the head; reduce
 *                               HEAD_DOTS for this paper size.
 */
export function buildCalibrationTicket(
  paper: PaperWidth,
  appVersion = '',
  widthMm?: number | null,
): string {
  const head = printableMm(paper);
  const inUse = layoutMm(paper, widthMm);

  // Candidate widths to test in ONE print, from the head width upwards to the
  // full media width. The widest bar that comes out with its right-hand end
  // marker intact is the true usable width of this printer.
  //
  // This exists because the question "how wide can it actually print" cannot be
  // answered from a specification or a photograph — printers vary, and a driver
  // may place the printable area with an offset. Nested bars turn it into one
  // measurement instead of a rebuild per guess.
  const candidates = Array.from(
    new Set([Math.round(head * 10) / 10, 74, 76, 78, MEDIA_MM[paper]]),
  ).filter(w => w >= head - 0.1 && w <= MEDIA_MM[paper]).sort((a, b) => a - b);

  const bars = candidates.map(w => `
    <div style="position:relative;height:6mm;width:100%;">
      <div style="position:absolute;left:0;top:2mm;width:${w}mm;border-top:3px solid #000;"></div>
      <div style="position:absolute;left:${w - 4}mm;top:0;font-size:7pt;">${w}]</div>
    </div>`).join('');

  // A 10mm ruler along the width currently in use, for measuring scale.
  const ticks: string[] = [];
  for (let mm = 0; mm <= Math.floor(inUse); mm += 10) {
    ticks.push(
      `<div style="position:absolute;left:${mm}mm;top:0;width:0;` +
      `height:${mm % 50 === 0 ? 6 : 3}mm;border-left:2px solid #000;"></div>`,
    );
  }

  return `
    <p class="center big">WIDTH TEST</p>
    <p class="center">${paper}mm paper &middot; using ${inUse.toFixed(1)}mm</p>
    <div class="rule-dashed"></div>

    <p>MEASURE THE LONGEST BAR.</p>
    <p>Each bar is labelled with the width</p>
    <p>it was ASKED to be, in mm.</p>
    <div class="rule-dashed"></div>
    ${bars}
    <div class="rule-dashed"></div>

    <p>If a bar labelled 80 measures 80mm,</p>
    <p>nothing is scaling. Set Print width</p>
    <p>to the widest bar that printed whole.</p>
    <p></p>
    <p>If it measures SHORT, the driver is</p>
    <p>scaling. Then:</p>
    <p></p>
    <p>  Print width = N x (N / measured)</p>
    <p></p>
    <p>e.g. bar 80 measures 57:</p>
    <p>  80 x (80 / 57) = 112</p>
    <p>Enter 112 and print this again.</p>
    <p>Repeat until a bar measures true.</p>
    <div class="rule-dashed"></div>

    <div style="position:relative;height:9mm;width:100%;">
      <div style="position:absolute;left:0;top:0;width:100%;border-top:3px solid #000;"></div>
      ${ticks.join('')}
    </div>
    <p>Ruler above: ticks every 10mm at</p>
    <p>the current ${inUse.toFixed(1)}mm setting.</p>
    <div class="rule-dashed"></div>
    <p class="center">${new Date().toLocaleString('en-KE')}</p>
    ${appVersion ? `<p class="center">BUILD v${esc(appVersion)}</p>` : ''}`;
}

/**
 * Best-effort paper-width detection from the driver.
 *
 * Returns null when it cannot tell, and callers must keep the current setting —
 * silently switching a working 80mm till to 58mm on a bad guess is worse than
 * not detecting at all.
 *
 * CUPS reports real media sizes; Windows drivers usually report nothing useful,
 * so the printer NAME is the only signal there. Note the driver may report the
 * PRINTABLE width (72.1 / 48) rather than the media width — both identify the
 * roll, which is why they are matched here too.
 */
export function detectPaperWidth(
  printer: { name?: string; displayName?: string; options?: Record<string, string> } | undefined,
): PaperWidth | null {
  if (!printer) return null;

  const optionText = Object.entries(printer.options ?? {})
    .filter(([k]) => /media|page.?size|paper|form/i.test(k))
    .map(([, v]) => String(v))
    .join(' ');

  // e.g. "80(72.1) x 297 mm", "Custom.72x200mm", "X80MM"
  const nums = optionText.match(/\d{2,3}(?:\.\d)?/g) ?? [];
  for (const n of nums) {
    const v = Math.round(Number(n));
    if (v === 80 || v === 72) return 80;
    if (v === 58 || v === 48) return 58;
  }

  const haystack = `${printer.name ?? ''} ${printer.displayName ?? ''} ${optionText}`;
  // Boundary-guarded so a model number like "TM-T588" cannot read as 58.
  if (/(^|[^0-9])80(mm|[^0-9]|$)/i.test(haystack)) return 80;
  if (/(^|[^0-9])58(mm|[^0-9]|$)/i.test(haystack)) return 58;

  return null;
}
