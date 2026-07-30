/**
 * printReceipt — sending tickets to a thermal printer.
 *
 * Document construction lives in thermal.ts; this file only decides WHERE a
 * ticket goes and what happens when it does not arrive.
 *
 * The window.open() dialog fallback that used to live here has been deleted
 * outright rather than fixed. The app's main window sets a setWindowOpenHandler
 * that denies every request, so window.open() returned null and the fallback
 * silently returned having printed nothing — no paper, no error, a resolved
 * promise. Every sale receipt on a till with no receipt printer saved went
 * there and vanished. A fallback that cannot work is worse than none, because
 * it makes the failure look like success.
 */

import { posApi } from './posApi';
import type { PrinterSettings } from '../hooks/usePrinterSettings';
import {
  buildTicketDocument,
  buildCalibrationTicket as buildCalibration,
  detectPaperWidth as detectWidth,
  type PaperWidth,
} from './thermal';

export { charsPerLine, printableMm, HEAD_DOTS } from './thermal';
export const detectPaperWidth = detectWidth;
export const buildCalibrationTicket = buildCalibration;

// 10pt matches the density of the reference receipts; 'small' stays available
// for sites that want more on a page.
const FONT_PT: Record<string, number> = { small: 9, normal: 10 };

/**
 * Wraps ticket content in a print-ready document.
 *
 * Kept under the old name because several call sites use it, but it now
 * delegates to thermal.ts, which sizes the column to the print HEAD (576 dots
 * = 72.06mm on 80mm paper) rather than to the paper. Laying out at the paper
 * width is what was cutting the amount column off the right-hand edge.
 */
export function buildThermalDocument(
  contentHtml: string,
  settings: PrinterSettings,
  title: string,
  copies: 1 | 2 = 1,
): string {
  const paper = settings.paperWidth as PaperWidth;
  const fontPt = FONT_PT[settings.fontSize] ?? 9;

  // A second copy is a second ticket in the same document, separated by a
  // tear line. Done here rather than via the driver's `copies` because many
  // thermal drivers ignore that field entirely.
  const body = copies === 2
    ? `${contentHtml}<div class="rule-dashed"></div><p class="center">- - - TEAR - - -</p>` +
      `<div class="rule-dashed"></div>${contentHtml}`
    : contentHtml;

  // Precedence, widest authority last-resort first:
  //   1. printWidthMm  — a human measured the paper and typed a number.
  //   2. detectedWidthMm — the driver's own imageable area.
  //   3. null          — fall back to the head spec (576/384 dots) in thermal.ts.
  // A manual value always beats detection; detection always beats a guess.
  const widthMm = settings.printWidthMm || settings.detectedWidthMm || null;
  return buildTicketDocument(body, { paper, fontPt, title, widthMm });
}

export interface PrintResult {
  ok: boolean;
  /** Set when nothing reached paper. Callers MUST surface this: a cashier who
   *  believes a receipt printed will hand over goods without one. */
  error?: string;
  /** True when the ticket was shown on screen instead of printed. */
  previewed?: boolean;
}

/**
 * Sends a document to a named printer, then to the OS default, then to screen.
 *
 * Jobs are serialised in the main process, so calling this for a receipt, a
 * kitchen ticket and a packing ticket in quick succession is safe even when all
 * three are bound to the same physical device — which is the normal case on a
 * single-printer till and previously caused all but the first to be dropped.
 */
export async function printDocument(
  doc: string,
  paperWidthMm: PaperWidth,
  deviceName: string,
  title: string,
  opts: { previewOnFailure?: boolean } = {},
): Promise<PrintResult> {
  const attempt = async (device: string) => {
    try {
      return await posApi.print.html({ html: doc, deviceName: device, paperWidthMm, copies: 1 });
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'IPC failed' };
    }
  };

  if (deviceName) {
    const res = await attempt(deviceName);
    if (res.ok) return { ok: true };
    console.warn(`[print] ${title}: configured printer failed:`, res.error);
  }

  // '' means OS default to the main process. This is the case that used to
  // disappear entirely — a printer TESTED in settings but never SAVED leaves
  // receiptPrinterName empty, so nothing was ever bound and nothing printed.
  const fallback = await attempt('');
  if (fallback.ok) return { ok: true };
  console.warn(`[print] ${title}: default printer failed:`, fallback.error);

  if (opts.previewOnFailure) {
    try {
      await posApi.print.preview({ html: doc, paperWidthMm, title });
      return {
        ok: false,
        previewed: true,
        error: `${title} did not print — shown on screen instead. Check Settings → Printers.`,
      };
    } catch { /* fall through to the plain failure below */ }
  }

  return { ok: false, error: `${title} did not print. Check Settings → Printers.` };
}

export async function printReceipt(
  receiptHtml: string,
  settings: PrinterSettings,
  title: string,
): Promise<PrintResult> {
  const doc = buildThermalDocument(receiptHtml, settings, title, settings.copies);
  return printDocument(
    doc,
    settings.paperWidth as PaperWidth,
    settings.receiptPrinterName,
    title,
    { previewOnFailure: true },   // the customer is standing there; show something
  );
}
