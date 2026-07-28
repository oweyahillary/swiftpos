// printService — native silent printing from the Electron main process.
//
// This replaces the need for QZ Tray on the desktop. QZ exists because
// BROWSERS can't print without a dialog; Electron can. A hidden window loads
// the receipt HTML and prints it straight to the OS printer driver:
// zero extra install, zero disk footprint, works offline.
//
// Thermal sizing: pageSize is given in microns (mm × 1000). Width matches the
// paper (58/80mm). Height is MEASURED from the rendered document rather than
// fixed, because the fixed 297mm this used to send is A4 — drivers that honour
// a page height literally fed roughly 30cm of blank paper after every receipt,
// which on a busy till is most of a roll an hour.

import { BrowserWindow } from 'electron';

// 96 CSS px per inch, 25,400 microns per inch.
const MICRONS_PER_PX = 25_400 / 96;

// Bounds on the measured height. The floor keeps a one-line ticket from being
// rejected by a driver with a minimum page size; the ceiling is a sanity guard
// so a runaway measurement can't ask for a hundred metres of paper.
const MIN_HEIGHT_MICRONS = 40_000;      // 40mm
const MAX_HEIGHT_MICRONS = 3_000_000;   // 3m
const FALLBACK_HEIGHT_MICRONS = 297_000;

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  /** Windows printer status bitfield. 0 = ready. Undefined on platforms that
   *  don't report one, which probePrinter treats as ready. */
  status?: number;
}

export interface SilentPrintOptions {
  html: string;            // full HTML document
  deviceName: string;      // exact OS printer name ('' = system default)
  paperWidthMm: 58 | 80;
  copies: number;
}

// OS printer list — needs a webContents, so we borrow the main window's.
export async function listPrinters(): Promise<PrinterInfo[]> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return [];
  try {
    const printers = await win.webContents.getPrintersAsync();
    return printers.map(p => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      status: typeof (p as any).status === 'number' ? (p as any).status : 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Opens the ticket in a VISIBLE window, at true paper width, without printing.
 *
 * Needed because there is otherwise no way to see what a ticket looks like
 * without thermal hardware. `printHtmlSilent` passes `silent: true`, which is
 * the entire point of the native path — it suppresses the OS dialog. That also
 * means "Microsoft Print to PDF" never gets a chance to ask for a filename, so
 * driving it silently produces no dialog and no file. Binding a printer to
 * Print-to-PDF therefore makes tickets vanish rather than appear.
 *
 * The window is sized to the paper so wrapping is realistic, and Ctrl+P inside
 * it opens a normal print dialog — which is how you get a PDF for review.
 */
export function openPrintPreview(opts: { html: string; paperWidthMm: 58 | 80; title?: string }): { ok: boolean } {
  // 96 CSS px per inch; paper width in mm → px, plus a little chrome.
  const paperPx = Math.round((opts.paperWidthMm / 25.4) * 96);

  const win = new BrowserWindow({
    width: paperPx + 60,
    height: 800,
    title: opts.title ?? 'Ticket preview',
    autoHideMenuBar: true,
    backgroundColor: '#3a3a3a',
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });

  // Grey surround so the paper edges are obvious, and a caption saying what
  // this is — a preview window with no label invites someone to assume the
  // ticket printed.
  const shell = `<!doctype html><html><head><meta charset="utf-8">
    <style>
      html,body{margin:0;padding:0;background:#3a3a3a;}
      .cap{font:12px system-ui,sans-serif;color:#ddd;text-align:center;padding:10px 8px 4px;}
      .cap b{color:#fff;}
      .paper{width:${opts.paperWidthMm}mm;margin:8px auto 24px;background:#fff;
             box-shadow:0 2px 12px rgba(0,0,0,.5);padding:6px 4px;}
      @media print{ .cap{display:none;} .paper{box-shadow:none;margin:0;} body{background:#fff;} }
    </style></head><body>
    <div class="cap">Preview only — nothing has been printed.<br>
      <b>${opts.paperWidthMm}mm paper</b> · press Ctrl+P to send it to a printer or save as PDF</div>
    <div class="paper">${opts.html}</div>
    </body></html>`;

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(shell));
  return { ok: true };
}

/**
 * Pings a printer: is it known to Windows, and is it in a usable state?
 *
 * Prints nothing. A cashier needs to answer "is the printer alive" a dozen
 * times a shift, and making them burn a test ticket to find out wastes paper and
 * trains them to ignore the answer.
 *
 * Windows exposes a status bitfield on each printer. 0 means ready; the bits
 * below are the ones a person at a till can actually do something about.
 */
export async function probePrinter(deviceName: string): Promise<{ ok: boolean; state: string }> {
  if (!deviceName) return { ok: false, state: 'No printer selected' };

  const printers = await listPrinters().catch(() => [] as PrinterInfo[]);
  const found = printers.find(p => p.name === deviceName);
  if (!found) return { ok: false, state: 'Not found — check power and cable' };

  const status = found.status ?? 0;
  if (status === 0) return { ok: true, state: 'Ready' };

  // PRINTER_STATUS_* bits, most actionable first.
  const faults: Array<[number, string]> = [
    [0x00000080, 'Offline'],
    [0x00000010, 'Out of paper'],
    [0x00000800, 'Paper jam'],
    [0x00040000, 'Door open'],
    [0x00000002, 'Printer error'],
    [0x00000020, 'Paper problem'],
    [0x00400000, 'No toner or ribbon'],
    [0x00000001, 'Paused'],
  ];
  const hit = faults.find(([bit]) => (status & bit) !== 0);
  if (hit) return { ok: false, state: hit[1] };

  // Busy/printing/warming-up all mean the printer is present and working.
  return { ok: true, state: 'Busy' };
}

export function printHtmlSilent(opts: SilentPrintOptions): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    let settled = false;
    const done = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      try { win.destroy(); } catch { /* already gone */ }
      resolve(result);
    };

    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });

    // Never leave a hidden window hanging if the driver stalls.
    const timeout = setTimeout(() => done({ ok: false, error: 'Print timed out' }), 20_000);

    win.webContents.once('did-finish-load', async () => {
      // Ask the rendered document how tall it actually is. Any failure falls
      // back to the old fixed height — a receipt that wastes paper is still
      // better than one that doesn't print.
      let heightMicrons = FALLBACK_HEIGHT_MICRONS;
      try {
        const px: number = await win.webContents.executeJavaScript(
          `Math.ceil(Math.max(
             document.body.scrollHeight,
             document.documentElement.scrollHeight,
             document.body.getBoundingClientRect().height
           ))`,
          true,
        );
        if (Number.isFinite(px) && px > 0) {
          // A few mm of tail so the last line clears the cutter.
          const measured = Math.round(px * MICRONS_PER_PX) + 6_000;
          heightMicrons = Math.min(Math.max(measured, MIN_HEIGHT_MICRONS), MAX_HEIGHT_MICRONS);
        }
      } catch {
        /* keep the fallback */
      }
      if (settled) return;   // timed out while we were measuring

      win.webContents.print(
        {
          silent: true,
          deviceName: opts.deviceName || undefined,   // undefined = default printer
          copies: Math.max(1, opts.copies),
          margins: { marginType: 'none' },
          pageSize: { width: opts.paperWidthMm * 1000, height: heightMicrons },
          printBackground: true,
        },
        (success, failureReason) => {
          clearTimeout(timeout);
          done(success ? { ok: true } : { ok: false, error: failureReason || 'Print failed' });
        },
      );
    });

    win.webContents.once('did-fail-load', (_e, _code, desc) => {
      clearTimeout(timeout);
      done({ ok: false, error: `Failed to render: ${desc}` });
    });

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(opts.html));
  });
}
