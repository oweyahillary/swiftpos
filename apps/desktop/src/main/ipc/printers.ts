// IPC: printers (native — replaces QZ Tray on the desktop). Registered from ipcHandlers.ts (D10).
import { printerShares } from '../printService';
import { listPrinters, printHtmlSilent, openPrintPreview, probePrinter, probeGeometry } from '../printService';
import { type IpcShared } from './shared';

/** Printers (native — replaces QZ Tray on the desktop). */
export function registerPrinterHandlers(ctx: IpcShared) {
  const { handle } = ctx;

  // ── Printing (native — replaces QZ Tray on the desktop) ──

  handle('print:list', async () => {
    return await listPrinters();
  });

  /**
   * Which printers are SHARED, and under what name.
   *
   * The Printers screen needs this to build a working \\localhost\<share>
   * target. Without it the picker guessed the printer's own name, which is a
   * different field and is absent entirely on a printer nobody has shared.
   */
  handle('print:shares', async () => await printerShares());

  // Ping a printer without printing. Cashiers use this constantly; it must not
  // consume paper.
  handle('print:probe', async (_event, deviceName: string) =>
    probePrinter(String(deviceName ?? '')));

  // Reads the driver's real media size and imageable area, so paper width does
  // not have to be a setting the user can silently get wrong. Returns null when
  // it cannot be determined and the caller falls back to the dot table.
  handle('print:geometry', async (_event, deviceName: string) =>
    probeGeometry(String(deviceName ?? '')));

  // Preview: renders the ticket in a visible window instead of printing it.
  // The only way to see a ticket without thermal hardware, since the silent
  // path deliberately suppresses every OS dialog.
  handle('print:preview', async (_event, opts: any) => {
    return openPrintPreview({
      html: String(opts?.html ?? ''),
      paperWidthMm: opts?.paperWidthMm === 58 ? 58 : 80,
      title: opts?.title ? String(opts.title) : undefined,
    });
  });

  handle('print:html', async (_event, opts: any) => {
    return await printHtmlSilent({
      html: String(opts?.html ?? ''),
      deviceName: String(opts?.deviceName ?? ''),
      paperWidthMm: opts?.paperWidthMm === 58 ? 58 : 80,
      copies: Number(opts?.copies) || 1,
    });
  });
}
