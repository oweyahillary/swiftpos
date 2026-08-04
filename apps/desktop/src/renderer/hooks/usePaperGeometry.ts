/**
 * usePaperGeometry — resolve paper width from the driver rather than a guess.
 *
 * WHY THIS EXISTS
 *   Paper width used to be a 58/80 toggle the user set by hand, and getting it
 *   wrong produced no error of any kind. A till left on 58mm laid out a 48.05mm
 *   column (384 dots) and printed it on an 80mm roll: a third of the paper blank
 *   down the right-hand side, and every value longer than 22 characters quietly
 *   truncated — a cashier's name arriving as "Eugene Owe". Nothing in the app
 *   noticed, because nothing in the app had any idea what was in the printer.
 *
 *   Windows knew all along. The driver reports both the media size and its
 *   imageable area — that is what "80(72.1) x 297 mm" means in the Properties
 *   dialog. So in 'auto' this asks the driver and uses the answer.
 *
 * THE FALLBACK LADDER
 *   1. Driver geometry (Windows). Exact, including the unprintable offset.
 *   2. The dot table — 576 dots on 80mm, 384 on 58mm. Correct for effectively
 *      every receipt printer, and what 'auto' settles on when the probe fails
 *      (non-Windows, silent driver, printer offline).
 *   3. A manual 58/80 choice, then a manual millimetre override, for hardware
 *      that misreports itself.
 *
 *   Detection NEVER widens beyond what it measured. Too narrow only wastes
 *   paper; too wide silently deletes whatever runs past the last dot, and on a
 *   receipt that is the amount column.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { PrinterSettings } from './usePrinterSettings';
import { printableMm, type PaperWidth } from '../lib/thermal';

export interface ResolvedPaper {
  /** Paper size the rest of the app should use. */
  paper: PaperWidth;
  /** Column width in mm to lay out at. */
  widthMm: number;
  /** Unprintable left margin the driver reports, if it reported one. */
  offsetMm: number | null;
  /** Where the numbers came from — shown to the user, not just logged. */
  source: 'driver' | 'head-spec' | 'manual';
  /** Human-readable summary for the settings screen. */
  detail: string;
  probing: boolean;
}

/** Nearest standard roll to a measured media width. */
function classify(paperMm: number): PaperWidth {
  return Math.abs(paperMm - 58) < Math.abs(paperMm - 80) ? 58 : 80;
}

export function usePaperGeometry(
  settings: PrinterSettings,
  save?: (patch: Partial<PrinterSettings>) => void,
): ResolvedPaper & { redetect: () => void } {
  const [geo, setGeo] = useState<{ paperMm: number; printableMm: number; offsetMm: number } | null>(null);
  const [probing, setProbing] = useState(false);
  const [tried, setTried] = useState(false);

  const device = settings.receiptPrinterName;

  // Generation counter: pressing Re-detect while a probe is HUNG must start a
  // fresh attempt and let the stale one settle into the void — otherwise one
  // wedged probe owns the screen until the app restarts.
  const genRef = useRef(0);

  const detect = useCallback(async () => {
    if (!device) { setGeo(null); setTried(true); return; }
    const gen = ++genRef.current;
    setProbing(true);
    try {
      // Belt over main's braces: main already races its own hang vectors, but
      // the renderer must not trust that — a settings screen frozen on one
      // stuck IPC is the bug this fixes, so the ceiling lives HERE too.
      const g = await Promise.race([
        posApi.print.geometry(device),
        new Promise<null>(res => setTimeout(() => res(null), 12_000)),
      ]);
      if (gen !== genRef.current) return;   // a newer attempt owns the state now
      setGeo(g);
      // Persist it so the PRINT path can use it. The hook only runs on settings
      // screens; receipts are printed from places that cannot call a hook.
      if (g && save) {
        save({ detectedWidthMm: g.printableMm, paperWidth: classify(g.paperMm) });
      }
    } catch {
      if (gen === genRef.current) setGeo(null);   // probe failure is not an error state, just no data
    } finally {
      if (gen === genRef.current) { setProbing(false); setTried(true); }
    }
  }, [device]);

  useEffect(() => { setTried(false); setGeo(null); }, [device]);
  useEffect(() => {
    if (settings.paperMode === 'auto' && !tried && device) void detect();
  }, [settings.paperMode, tried, device, detect]);

  // A manual millimetre override always wins — it exists precisely for the case
  // where everything above is wrong and someone has measured the paper.
  if (settings.printWidthMm > 0) {
    const paper = settings.paperMode === 'auto'
      ? (geo ? classify(geo.paperMm) : settings.paperWidth as PaperWidth)
      : (settings.paperMode as PaperWidth);
    return {
      paper, widthMm: settings.printWidthMm, offsetMm: geo?.offsetMm ?? null,
      source: 'manual', probing,
      detail: `Manual override: ${settings.printWidthMm}mm`,
      redetect: detect,
    };
  }

  if (settings.paperMode === 'auto' && geo) {
    const paper = classify(geo.paperMm);
    return {
      paper, widthMm: geo.printableMm, offsetMm: geo.offsetMm,
      source: 'driver', probing,
      detail:
        `Driver reports ${geo.paperMm.toFixed(0)}mm paper, ` +
        `${geo.printableMm.toFixed(1)}mm printable, ` +
        `${geo.offsetMm.toFixed(1)}mm left margin`,
      redetect: detect,
    };
  }

  const paper: PaperWidth = settings.paperMode === 'auto'
    ? (settings.paperWidth as PaperWidth)
    : (settings.paperMode as PaperWidth);

  return {
    paper,
    widthMm: printableMm(paper),
    offsetMm: null,
    source: 'head-spec',
    probing,
    detail: settings.paperMode === 'auto'
      ? `Could not read the driver — using the ${paper}mm head spec (${printableMm(paper).toFixed(1)}mm)`
      : `Set manually to ${paper}mm (${printableMm(paper).toFixed(1)}mm printable)`,
    redetect: detect,
  };
}
