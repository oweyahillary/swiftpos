/**
 * printReceipt — native Electron silent printing (zero-install).
 *
 * Priority:
 *   1. Native silent print through the main process (print:html IPC) when a
 *      receipt printer is configured — no dialog, no QZ Tray, no extra MB.
 *   2. window.open() print-dialog fallback otherwise (or if native fails).
 *
 * QZ Tray is no longer required on the desktop. It remains a WEB dashboard
 * concern, where the browser cannot print silently.
 */

import { posApi } from './posApi';
import type { PrinterSettings } from '../hooks/usePrinterSettings';

// Paper width in pixels at 96dpi: 58mm ≈ 219px, 80mm ≈ 302px
const PAPER_PX: Record<number, number> = { 58: 219, 80: 302 };
const FONT_SIZE: Record<string, string> = { small: '8pt', normal: '9pt' };

// Builds the complete thermal-sized HTML document. Shared by the native
// silent path (hidden window in main) and the dialog fallback.
export function buildThermalDocument(
  contentHtml: string,
  settings: PrinterSettings,
  title: string,
  copies: 1 | 2 = 1,
): string {
  const paperPx  = PAPER_PX[settings.paperWidth] ?? PAPER_PX[80];
  const fontSize = FONT_SIZE[settings.fontSize] ?? FONT_SIZE.normal;

  const cutLine = settings.autoCut
    ? `<div style="border-top:1px dashed #000;margin:12px 0;text-align:center;font-size:8pt;color:#999;">✂ cut here</div>`
    : '';

  const single = `<div class="receipt">${contentHtml}</div>`;
  const body = copies === 2 ? `${single}${cutLine}${single}` : single;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: ${paperPx}px;
      font-family: 'Courier New', Courier, monospace;
      font-size: ${fontSize};
      color: #000;
      background: #fff;
      line-height: 1.5;
    }
    body { padding: 4px 4px 16px 4px; }
    .receipt { width: 100%; word-break: break-word; }
    p[style*="border-top"] { margin: 5px 0 !important; }
    div[style*="display: flex"] { display: flex !important; width: 100%; }
    @media print {
      html, body {
        width: ${paperPx}px; max-width: ${paperPx}px;
        margin: 0 !important; padding: 2px !important;
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      .receipt { page-break-inside: avoid; break-inside: avoid; }
      * { color: #000 !important; background: transparent !important; text-shadow: none !important; box-shadow: none !important; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export async function printReceipt(
  receiptHtml: string,
  settings: PrinterSettings,
  title: string,
): Promise<void> {
  const doc = buildThermalDocument(receiptHtml, settings, title, settings.copies);

  // ── Native silent print ────────────────────────────────────────────────
  if (settings.receiptPrinterName) {
    try {
      // Copies are duplicated in the document (with a cut line between), so
      // the driver prints 1; this also works on drivers that ignore copies.
      const res = await posApi.print.html({
        html: doc,
        deviceName: settings.receiptPrinterName,
        paperWidthMm: settings.paperWidth,
        copies: 1,
      });
      if (res.ok) return;
      console.warn('[printReceipt] Native print failed, falling back to dialog:', res.error);
    } catch (err: any) {
      console.warn('[printReceipt] Native print error, falling back to dialog:', err?.message);
    }
  }

  // ── Dialog fallback ────────────────────────────────────────────────────
  browserPrint(receiptHtml, settings, title, settings.copies);
}

// Print-dialog fallback — opens a paper-width window and prints.
export function browserPrint(
  contentHtml: string,
  settings: PrinterSettings,
  title: string,
  copies: 1 | 2 = 1,
): void {
  const paperPx = PAPER_PX[settings.paperWidth] ?? PAPER_PX[80];
  const html = buildThermalDocument(contentHtml, settings, title, copies);

  const win = window.open('', '_blank', `width=${paperPx + 40},height=600,scrollbars=yes,resizable=yes`);
  if (!win) return;

  win.document.open();
  win.document.write(html);
  win.document.close();

  win.onload = () => {
    win.focus();
    setTimeout(() => win.print(), 300);
  };
  setTimeout(() => {
    if (!win.closed) { win.focus(); win.print(); }
  }, 800);
}
