/**
 * escpos — Document to printer bytes.
 *
 * ── WHY BYTES AND NOT HTML ───────────────────────────────────────────────────
 * The path being replaced rendered HTML and then either handed it to QZ Tray
 * over a signed WebSocket, or wrote a temp file and shelled out to
 *   powershell -Command "Get-Content tmp.html | Out-Printer"
 * PowerShell's cold start alone is one to three seconds, and Out-Printer pushes
 * the job through the Windows GDI spooler, which RENDERS A DOCUMENT — laying
 * out HTML, rasterising it, and sending a bitmap. That is where the ten seconds
 * went. No amount of tuning the HTML recovers it, because the HTML was never
 * the slow part.
 *
 * A thermal printer wants a byte stream. This file produces one. There is no
 * browser, no temp file, no shell, and no local HTTP server in the path.
 *
 * ── CODE PAGE ────────────────────────────────────────────────────────────────
 * Everything is emitted as CP437-safe ASCII, and layout.sanitize() has already
 * stripped anything outside it. Menu names pasted out of Word carry curly
 * quotes and en-dashes that print as garbage glyphs otherwise, and a garbage
 * glyph in a dish name is the kind of thing that gets blamed on the printer for
 * a week.
 */

import type { Document, TextBlock, Size } from './document';

const ESC = 0x1b;
const GS = 0x1d;

const INIT = [ESC, 0x40];
const CODEPAGE_CP437 = [ESC, 0x74, 0x00];
const LINE_SPACING_DEFAULT = [ESC, 0x32];

const ALIGN = { left: 0, center: 1, right: 2 } as const;

/** GS ! n — the low nibble is height, the high nibble is width, each 0-7
 *  meaning 1x to 8x. Only 1x and 2x are used here; anything larger is
 *  unreadable on 58mm and wraps unpredictably on 80mm. */
function sizeByte(size: Size): number {
  switch (size) {
    case 'normal': return 0x00;
    case 'tall':   return 0x01;
    case 'wide':   return 0x10;
    case 'large':  return 0x11;
  }
}

export interface EscPosOptions {
  /** Blank lines fed before the cut, so the tear-off edge clears the head. */
  feedBeforeCut?: number;
  cut?: boolean;
  openDrawer?: boolean;
}

export function toEscPos(doc: Document, opts: EscPosOptions = {}): Buffer {
  const out: number[] = [];
  const push = (...bytes: number[]) => out.push(...bytes);
  const text = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out.push(c > 0x7e || c < 0x20 ? 0x3f : c);
    }
  };

  push(...INIT, ...CODEPAGE_CP437, ...LINE_SPACING_DEFAULT);

  // Tracked so the serialiser only emits a mode change when the mode actually
  // changes. A receipt is ~40 lines; re-sending four control sequences per line
  // is a third of the payload for no benefit.
  let curAlign = -1;
  let curSize = -1;
  let curBold = -1;

  for (const block of doc.blocks) {
    switch (block.kind) {
      case 'text': {
        const b = block as TextBlock;
        const a = ALIGN[b.align];
        if (a !== curAlign) { push(ESC, 0x61, a); curAlign = a; }
        const s = sizeByte(b.size);
        if (s !== curSize) { push(GS, 0x21, s); curSize = s; }
        const bold = b.bold ? 1 : 0;
        if (bold !== curBold) { push(ESC, 0x45, bold); curBold = bold; }
        text(b.text);
        push(0x0a);
        break;
      }
      case 'feed':
        push(ESC, 0x64, Math.max(0, Math.min(255, block.lines)));
        break;
      case 'drawer':
        // ESC p 0 25 250 — pin 2, 50ms on, 500ms off. The conservative timing;
        // some drawers ignore shorter pulses.
        push(ESC, 0x70, 0x00, 0x19, 0xfa);
        break;
      case 'cut':
        push(GS, 0x56, 0x42, 0x00);
        break;
    }
  }

  // Reset before finishing so the next job on this printer starts from a known
  // state even if it came from someone else's software.
  push(ESC, 0x61, 0, GS, 0x21, 0x00, ESC, 0x45, 0);

  if (opts.openDrawer) push(ESC, 0x70, 0x00, 0x19, 0xfa);
  if (opts.feedBeforeCut) push(ESC, 0x64, opts.feedBeforeCut);
  if (opts.cut) push(GS, 0x56, 0x42, 0x00);

  return Buffer.from(out);
}
