/**
 * printReceipt
 *
 * Prints a customer receipt.
 * - If QZ Tray is connected AND a printer name is configured → silent QZ print
 * - Otherwise → window.print() browser fallback
 *
 * Optimised for 58mm and 80mm thermal paper.
 */

import type { PrinterSettings } from '../hooks/usePrinterSettings';
import { getQZStatus, printToQZ } from './localPrintServer';

// Paper width in pixels at 96dpi (browser default)
// 58mm ≈ 219px,  80mm ≈ 302px
const PAPER_PX: Record<number, number> = { 58: 219, 80: 302 };

// Font sizes
const FONT_SIZE: Record<string, string> = {
  small:  '8pt',
  normal: '9pt',
};

export async function printReceipt(
  receiptHtml: string,
  settings: PrinterSettings,
  businessName: string,
  qzPrinterName?: string, // if set and QZ connected, use silent print
) {
  // ── QZ path ──────────────────────────────────────────────────────────────
  if (qzPrinterName && getQZStatus() === 'connected') {
    try {
      await printToQZ(qzPrinterName, receiptHtml, {
        paperWidth: settings.paperWidth,
        copies:     settings.copies,
        autoCut:    settings.autoCut,
      });
      return;
    } catch (err: any) {
      console.warn('[printReceipt] QZ failed, falling back to browser:', err?.message);
      // fall through to browser print
    }
  }

  // ── Browser fallback ──────────────────────────────────────────────────────
  const paperPx  = PAPER_PX[settings.paperWidth] ?? PAPER_PX[80];
  const fontSize  = FONT_SIZE[settings.fontSize]  ?? FONT_SIZE.normal;
  const winWidth  = paperPx + 40; // add margin for window chrome

  const cutLine = settings.autoCut
    ? `<div style="border-top:1px dashed #000;margin:12px 0;text-align:center;font-size:8pt;color:#999;">✂ cut here</div>`
    : '';

  // Build the full receipt — duplicate if 2 copies
  const singleReceipt = `<div class="receipt">${receiptHtml}</div>`;
  const body = settings.copies === 2
    ? `${singleReceipt}${cutLine}${singleReceipt}`
    : singleReceipt;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${businessName} — Receipt</title>
  <style>
    /* Reset */
    *, *::before, *::after {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    /* Base */
    html, body {
      width: ${paperPx}px;
      font-family: 'Courier New', Courier, monospace;
      font-size: ${fontSize};
      color: #000;
      background: #fff;
      line-height: 1.5;
    }

    body {
      padding: 4px 4px 16px 4px;
    }

    /* Receipt block */
    .receipt {
      width: 100%;
      word-break: break-word;
    }

    /* Dividers rendered as <p> with border-top */
    p[style*="border-top"] {
      margin: 5px 0 !important;
    }

    /* All spans full width on flex rows */
    div[style*="display: flex"] {
      display: flex !important;
      width: 100%;
    }

    /* Print-specific: remove background colours, shadows */
    @media print {
      html, body {
        width: ${paperPx}px;
        max-width: ${paperPx}px;
        margin: 0 !important;
        padding: 2px !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      /* Force no page break inside a receipt */
      .receipt {
        page-break-inside: avoid;
        break-inside: avoid;
      }

      /* Remove emoji colours — thermal printers can't do colour */
      * {
        color: #000 !important;
        background: transparent !important;
        text-shadow: none !important;
        box-shadow: none !important;
      }
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;

  const win = window.open(
    '',
    '_blank',
    `width=${winWidth},height=600,scrollbars=yes,resizable=yes`,
  );

  if (!win) {
    // Pop-up blocked — surface this to the caller via thrown error
    // so the POS can show an inline message instead of a blocking alert.
    throw new Error('Pop-up blocked. Please allow pop-ups for this site to print receipts.');
  }

  win.document.open();
  win.document.write(html);
  win.document.close();

  // Give the browser a moment to render before printing
  win.onload = () => {
    win.focus();
    setTimeout(() => {
      win.print();
      // Don't auto-close — let the user close after printing
      // (some printers need the window to stay open)
    }, 300);
  };

  // Fallback if onload doesn't fire (some browsers)
  setTimeout(() => {
    if (!win.closed) {
      win.focus();
      win.print();
    }
  }, 800);
}
