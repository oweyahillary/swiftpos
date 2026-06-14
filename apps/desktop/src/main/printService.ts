// printService — native silent printing from the Electron main process.
//
// This replaces the need for QZ Tray on the desktop. QZ exists because
// BROWSERS can't print without a dialog; Electron can. A hidden window loads
// the receipt HTML and prints it straight to the OS printer driver:
// zero extra install, zero disk footprint, works offline.
//
// Thermal sizing: pageSize is given in microns (mm × 1000). Width matches the
// paper (58/80mm); height is generous — thermal drivers treat the roll as
// continuous and stop at the content.

import { BrowserWindow } from 'electron';

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
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
    }));
  } catch {
    return [];
  }
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

    win.webContents.once('did-finish-load', () => {
      win.webContents.print(
        {
          silent: true,
          deviceName: opts.deviceName || undefined,   // undefined = default printer
          copies: Math.max(1, opts.copies),
          margins: { marginType: 'none' },
          pageSize: { width: opts.paperWidthMm * 1000, height: 297_000 },
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
