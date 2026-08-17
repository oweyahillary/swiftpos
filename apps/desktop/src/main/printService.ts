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
import { execFile } from 'node:child_process';

// ─────────────────────────────────────────────────────────────────────────────
// Printer geometry — asking Windows instead of guessing.
//
// The paper width was a setting the user had to get right, and getting it wrong
// was silent: a till set to 58mm laid out a 48mm column on an 80mm roll, wasting
// a third of the paper and truncating anything long, with nothing to indicate a
// mismatch. Meanwhile Windows knew the answer all along — the Properties dialog
// shows "80(72.1) x 297 mm" because the driver reports both the media size and
// its imageable area.
//
// System.Drawing.Printing exposes exactly that: PaperSize for the media,
// PrintableArea for the extent the head can reach, and PrintableArea.X for the
// left offset. All in hundredths of an inch. On an XP-80 that comes back as
// roughly 315 / 284 / 16 — which is 80mm paper, 72.1mm printable, 4mm offset,
// matching a ruler to a tenth of a millimetre.
//
// Windows only, and deliberately best-effort: any failure returns null and the
// caller falls back to the dot table (576/384), which is correct for essentially
// every receipt printer ever made. A detection that guesses when it cannot see
// would be worse than one that admits it.
// ─────────────────────────────────────────────────────────────────────────────

export interface PrinterGeometry {
  /** Media width in mm, e.g. 80. */
  paperMm: number;
  /** Width the head can actually reach, in mm, e.g. 72.1. */
  printableMm: number;
  /** Unprintable left margin in mm, e.g. 4.0. */
  offsetMm: number;
}

const _geometryCache = new Map<string, PrinterGeometry | null>();

const HUNDREDTHS_INCH_TO_MM = 25.4 / 100;

export function probeGeometry(deviceName: string): Promise<PrinterGeometry | null> {
  // Two timeouts, deliberately. execFile's own 8s kill handles a slow child —
  // but a PowerShell blocked inside a hung printer DRIVER can be unkillable
  // (kernel-side wait), in which case the kill fails, the callback never
  // fires, and the promise never settles: the settings screen then reads
  // "Reading the printer…" forever, which is precisely what happened on an
  // XP-80 with a wedged spooler. The outer race settles null at 10s no matter
  // what the child does; the caller falls back to the head-spec table.
  return Promise.race([
    probeGeometryInner(deviceName),
    new Promise<PrinterGeometry | null>(res => setTimeout(() => res(null), 10_000)),
  ]);
}

function probeGeometryInner(deviceName: string): Promise<PrinterGeometry | null> {
  if (process.platform !== 'win32' || !deviceName) return Promise.resolve(null);
  if (_geometryCache.has(deviceName)) return Promise.resolve(_geometryCache.get(deviceName)!);

  // Windows PowerShell (5.1) specifically, not pwsh: System.Drawing.Printing is
  // a Windows-only assembly and is not present in PowerShell Core on all hosts.
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$ps = New-Object System.Drawing.Printing.PrinterSettings
$ps.PrinterName = '${deviceName.replace(/'/g, "''")}'
if (-not $ps.IsValid) { exit 3 }
$pg = $ps.DefaultPageSettings
[Console]::Out.Write(('{0},{1},{2}' -f $pg.PaperSize.Width, $pg.PrintableArea.Width, $pg.PrintableArea.X))
`.trim();

  return new Promise(resolve => {
    const finish = (g: PrinterGeometry | null) => { _geometryCache.set(deviceName, g); resolve(g); };

    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 8_000, windowsHide: true },
      (err, stdout) => {
        if (err) { finish(null); return; }
        const parts = String(stdout).trim().split(',').map(Number);
        if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) { finish(null); return; }

        const [paperRaw, printableRaw, offsetRaw] = parts;
        const paperMm = paperRaw * HUNDREDTHS_INCH_TO_MM;
        const printableMm = printableRaw * HUNDREDTHS_INCH_TO_MM;
        const offsetMm = offsetRaw * HUNDREDTHS_INCH_TO_MM;

        // Sanity-check before trusting it. A driver configured for A4, or one
        // reporting nonsense, must not silently reconfigure a receipt printer:
        // too WIDE a column deletes the amount column, which is the one failure
        // we cannot allow a guess to cause.
        const plausible =
          paperMm > 40 && paperMm < 120 &&
          printableMm > 20 && printableMm <= paperMm + 0.5 &&
          offsetMm >= 0 && offsetMm < 15;

        finish(plausible ? { paperMm, printableMm, offsetMm } : null);
      },
    );
    child.on('error', () => finish(null));
  });
}

// 96 CSS px per inch, 25,400 microns per inch.
const MICRONS_PER_PX = 25_400 / 96;

// Bounds on the measured height. The floor keeps a one-line ticket from being
// rejected by a driver with a minimum page size; the ceiling is a sanity guard
// so a runaway measurement can't ask for a hundred metres of paper.
const MIN_HEIGHT_MICRONS = 40_000;      // 40mm
const MAX_HEIGHT_MICRONS = 3_000_000;   // 3m
const FALLBACK_HEIGHT_MICRONS = 297_000;

// Thermal head resolution. Rasterising at the device's own dpi keeps glyph
// edges 1-bit instead of resampled grey — see the note on printOnce.
const THERMAL_DPI = 203;

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  /** Windows printer status bitfield. 0 = ready. Undefined on platforms that
   *  don't report one, which probePrinter treats as ready. */
  status?: number;
  /** Raw driver options. CUPS (Linux/macOS) puts the paper size in here under
   *  keys like `media` or `media-default` — e.g. `Custom.72x200mm`, `X80MM`.
   *  Windows drivers rarely populate it, so anything reading this must treat
   *  an empty object as "unknown" rather than as a default. */
  options?: Record<string, string>;
}

export interface SilentPrintOptions {
  html: string;            // full HTML document
  deviceName: string;      // exact OS printer name ('' = system default)
  paperWidthMm: 58 | 80;
  copies: number;
}

// OS printer list — needs a webContents, so we borrow the main window's.
/**
 * Windows sharing state per printer, keyed by printer name.
 *
 * WHY THIS EXISTS
 * Raw ESC/POS bytes reach a USB printer on Windows by writing to its UNC share:
 * \\localhost\<ShareName>. There is no other route without a native module —
 * a USB printer has no IP, and its port (USB001) is not a path anything can
 * open.
 *
 * The catch is that Windows does NOT share a printer by default, and when it
 * does, the SHARE name is a separate field from the printer name. The printer
 * list Electron gives us has only the printer name, so building
 * \\localhost\<printer name> from it is a guess — and on a printer that has
 * never been shared it is a guess that fails with
 * "UNKNOWN: unknown error, open '\\localhost\XP-80'", which reads like a
 * hardware fault and is not one.
 *
 * Get-Printer is the only thing that knows. Windows-only by construction;
 * every other platform returns an empty map and the caller falls back to the
 * printer name, which is correct for CUPS.
 */
export async function printerShares(): Promise<Record<string, { shared: boolean; shareName: string | null }>> {
  if (process.platform !== 'win32') return {};
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
         'Get-Printer | Select-Object Name,Shared,ShareName | ConvertTo-Json -Compress'],
        // Same reasoning as the getPrintersAsync race below: a wedged spooler
        // must degrade to "unknown", never to a frozen settings screen.
        { timeout: 6_000, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });

    const parsed = JSON.parse(out || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const map: Record<string, { shared: boolean; shareName: string | null }> = {};
    for (const r of rows) {
      if (!r?.Name) continue;
      map[r.Name] = { shared: !!r.Shared, shareName: r.ShareName ?? null };
    }
    return map;
  } catch {
    // No PowerShell, blocked by policy, or a wedged spooler. Unknown sharing
    // state is not an error — the manual field still accepts a typed target.
    return {};
  }
}

export async function listPrinters(): Promise<PrinterInfo[]> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return [];
  try {
    // getPrintersAsync has NO timeout of its own and blocks indefinitely on a
    // wedged Windows print spooler — which is exactly the state a dropped-
    // offline XP-80 leaves the machine in. Racing it means a wedged spooler
    // degrades to "no printers found, retry" instead of freezing the settings
    // screen; the cashier restarts the spooler and presses refresh.
    const printers = await Promise.race([
      win.webContents.getPrintersAsync(),
      new Promise<never[]>(res => setTimeout(() => res([]), 6_000)),
    ]);
    return printers.map(p => ({
      name: p.name,
      displayName: p.displayName || p.name,
      // Electron 43 removed `isDefault` from PrinterInfo (default-ness now lives
      // in the platform-specific `options` bag). This value is display-only — the
      // renderer appends a "(default)" label with it — so read it defensively:
      // the legacy field where a runtime still provides it, else the Windows
      // options key. Worst case the label is absent; printing is unaffected.
      isDefault: !!((p as any).isDefault ?? ((p as any).options?.['printer-is-default'] === 'true')),
      status: typeof (p as any).status === 'number' ? (p as any).status : 0,
      options: ((p as any).options ?? {}) as Record<string, string>,
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

// ─────────────────────────────────────────────────────────────────────────────
// Silent printing — rewritten.
//
// Three faults in the previous implementation, all of which showed up on an
// XP-80 at a live till:
//
//  1. NO scaleFactor. Left unset, Chromium fits the page to whatever printable
//     area the driver reports. Output landed at roughly 70% of the paper and
//     pinned left. Now pinned to 100 — render what we asked for.
//
//  2. NO dpi. Chromium rasterises at 96dpi and the driver resamples up to 203.
//     Resampling turns crisp 1-bit glyph edges into grey, and a thermal head
//     dithers grey into a sparse scatter of dots — which is exactly what "very
//     faded" looks like. Asking for 203 means the raster matches the head and
//     each dot is on or off.
//
//  3. NO serialisation. Every call opened its own hidden window and printed
//     immediately. Firing a receipt, a kitchen ticket and a packing ticket at
//     one physical printer within a few milliseconds of each other left the
//     spooler to arbitrate, and jobs were dropped — the reported symptom being
//     that only the first ticket appeared. Jobs are now queued and run one at a
//     time, so a till with three "printers" all pointing at one device behaves
//     the same as three separate devices.
// ─────────────────────────────────────────────────────────────────────────────

/** Serial print queue. One job at a time, in submission order. */
let _chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = _chain.then(job, job);
  // Keep the chain alive regardless of outcome; a failed job must not wedge
  // every later ticket, which would take the till out of service silently.
  _chain = run.then(() => undefined, () => undefined);
  return run;
}

function printOnce(opts: SilentPrintOptions): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    let settled = false;
    const done = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { win.destroy(); } catch { /* already gone */ }
      resolve(result);
    };

    // The measuring window MUST be the width of the paper.
    //
    // It had no width, so Electron defaulted it to 800px. The HTML was laid out
    // at 800px, its height measured there, and that height handed to
    // webContents.print() as the page length — while the actual print reflowed
    // the same content into ~302px (80mm). Narrower column, far more wrapping,
    // far taller page. The paper then ran out at whatever the 800px measurement
    // had predicted, and everything past it was simply not printed.
    //
    // A receipt survived this because its rows are short and wrap little. The
    // shift report did not: it stopped dead after Gross sales, losing the whole
    // cash reconciliation — the half of the report anybody counting a drawer
    // actually needs.
    //
    // useContentSize so the number means the page, not the window frame.
    const paperPx = Math.max(1, Math.round((opts.paperWidthMm / 25.4) * 96));
    const win = new BrowserWindow({
      show: false,
      width: paperPx,
      height: 2000,
      useContentSize: true,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });

    const timeout = setTimeout(() => done({ ok: false, error: 'Print timed out' }), 20_000);

    win.webContents.once('did-finish-load', async () => {
      // Measure the rendered height rather than sending a fixed page length.
      // The fixed 297mm this once used is A4: drivers that honour it literally
      // fed ~30cm of blank paper after every receipt.
      let heightMicrons = FALLBACK_HEIGHT_MICRONS;
      try {
        const px: number = await win.webContents.executeJavaScript(
          `(async () => {
             // Fonts change line counts, and a line count is the whole
             // measurement. Measuring before they load reports a height the
             // printed page will overrun.
             if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
             await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
             return Math.ceil(Math.max(
               document.body.scrollHeight,
               document.documentElement.scrollHeight,
               document.body.getBoundingClientRect().height
             ));
           })()`,
          true,
        );
        if (Number.isFinite(px) && px > 0) {
          heightMicrons = Math.min(
            Math.max(Math.round(px * MICRONS_PER_PX) + 2_000, MIN_HEIGHT_MICRONS),
            MAX_HEIGHT_MICRONS,
          );
        }
      } catch {
        /* keep the fallback — a receipt that wastes paper beats one that vanishes */
      }
      if (settled) return;

      win.webContents.print(
        {
          silent: true,
          deviceName: opts.deviceName || undefined,   // undefined = OS default
          copies: Math.max(1, opts.copies),
          margins: { marginType: 'none' },
          // The page is the MEDIA width. The content column inside it is the
          // head width (see thermal.ts) — the driver's own form is declared the
          // same way, e.g. "80(72.1) x 297 mm".
          pageSize: { width: opts.paperWidthMm * 1000, height: heightMicrons },
          printBackground: false,   // nothing here has a background worth burning
          scaleFactor: 100,
          dpi: { horizontal: THERMAL_DPI, vertical: THERMAL_DPI },
        },
        (success, failureReason) => {
          done(success ? { ok: true } : { ok: false, error: failureReason || 'Print failed' });
        },
      );
    });

    win.webContents.once('did-fail-load', (_e, _code, desc) => {
      done({ ok: false, error: `Failed to render: ${desc}` });
    });

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(opts.html));
  });
}

export function printHtmlSilent(opts: SilentPrintOptions): Promise<{ ok: boolean; error?: string }> {
  return enqueue(() => printOnce(opts));
}
