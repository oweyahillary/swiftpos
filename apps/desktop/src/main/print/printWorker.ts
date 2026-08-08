/**
 * printWorker — the desktop's print subsystem.
 *
 * Wires the renderer to the spool and the spool to the transport, and owns the
 * per-terminal printer assignments.
 *
 * ── WHY ASSIGNMENTS LIVE HERE AND NOT ON THE SERVER ──────────────────────────
 * A STATION is a job — Kitchen, Dispatch, Till — and belongs to the business.
 * It is the same at every branch. A PRINTER is a machine, and belongs to ONE
 * terminal. Three tills in a branch have three different printers attached, so
 * the printer can never be part of the station or every till would fight over
 * it. Stations sync; assignments do not, and stay in the local database.
 *
 * A station with no printer on this terminal simply does not print here. That
 * is not an error — it is how a waiter's tablet avoids printing kitchen tickets
 * that the kitchen's own terminal is already producing.
 */

import type Database from 'better-sqlite3';
import { ipcMain, type BrowserWindow } from 'electron';

import {
  renderTicket, toEscPos, toPreview, Spool,
  type PrintContext, type StationConfig,
  sendToPrinter, parseTarget, PrinterError,
} from '@swiftpos/printing';
import { SqliteJobStore } from './spoolStore.sqlite';
import { escposEnabled, setEscposEnabled } from '../escposBridge';
import { renderShiftReport, hasPrintableContent } from '@swiftpos/printing';
import { sampleOrder, sampleBusiness, SAMPLE_KITCHEN, SAMPLE_DISPATCH,
  kitchenPreset, dispatchPreset, receiptPreset } from '@swiftpos/printing';

const ASSIGNMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS station_printers (
  station_id     TEXT PRIMARY KEY,
  target         TEXT NOT NULL,
  paper_width_mm INTEGER NOT NULL DEFAULT 80,
  updated_at     INTEGER NOT NULL
);
`;

export interface Assignment {
  stationId: string;
  target: string;
  paperWidthMm: 58 | 80;
}

let spool: Spool | null = null;
let db: Database.Database | null = null;

export function initPrinting(database: Database.Database, win: () => BrowserWindow | null): void {
  db = database;
  db.exec(ASSIGNMENTS_SCHEMA);

  const store = new SqliteJobStore(db);
  spool = new Spool(store, {
    send: (target, bytes) => sendToPrinter(parseTarget(target), bytes),
    isRetryable: (e: unknown) => (e instanceof PrinterError ? e.retryable : true),
    // Pushed to the renderer so the queue badge updates without polling.
    onChange: () => win()?.webContents.send('escpos:changed'),
  });

  const recovered = spool.recoverStuck();
  if (recovered > 0) {
    console.log(`[print] recovered ${recovered} job(s) left mid-print by a previous run`);
  }
  spool.start();

  // Completed jobs are kept a day so the queue view is useful, then dropped.
  // Reprints come from the ORDER, not from here, so nothing is lost.
  setInterval(() => { store.purgeDone(Date.now() - 24 * 60 * 60 * 1000); }, 60 * 60 * 1000)
    .unref?.();

  registerIpc();
}

/**
 * The StationConfig for a station id, at a given paper width.
 *
 * Reads the business's own print_stations and falls back to the three built-ins
 * so a terminal that has never configured stations still previews correctly.
 * Uses the exported presets rather than hand-built config — they are what the
 * verified sample output was rendered from, and forking them here would make
 * the preview a picture of something the printer never produces.
 */
function stationConfigFor(stationId: string, paperWidthMm: 58 | 80): StationConfig | null {
  let row: { id: string; name: string; kind: 'kitchen' | 'dispatch' | 'receipt' } | undefined;
  try {
    row = db?.prepare(
      `SELECT id, name, kind FROM print_stations WHERE id = ? AND active = 1`
    ).get(stationId) as typeof row;
  } catch { /* table absent on an un-migrated till */ }

  if (!row) {
    const builtin: Record<string, { name: string; kind: 'kitchen' | 'dispatch' | 'receipt' }> = {
      kitchen:  { name: 'Kitchen',  kind: 'kitchen'  },
      dispatch: { name: 'Dispatch', kind: 'dispatch' },
      receipt:  { name: 'Till',     kind: 'receipt'  },
    };
    const b = builtin[stationId];
    if (!b) return null;
    row = { id: stationId, name: b.name, kind: b.kind };
  }

  return row.kind === 'kitchen'  ? kitchenPreset(row.id, row.name, paperWidthMm)
       : row.kind === 'dispatch' ? dispatchPreset(row.id, row.name, paperWidthMm)
       :                           receiptPreset(row.id, row.name, paperWidthMm);
}

export function assignments(): Assignment[] {
  return (db!.prepare(`SELECT * FROM station_printers`).all() as {
    station_id: string; target: string; paper_width_mm: number;
  }[]).map(r => ({
    stationId: r.station_id,
    target: r.target,
    paperWidthMm: r.paper_width_mm === 58 ? 58 : 80,
  }));
}

function assignmentFor(stationId: string): Assignment | null {
  return assignments().find(a => a.stationId === stationId) ?? null;
}

/**
 * Queues one ticket per station that has a printer on THIS terminal. Returns
 * immediately — see spool.ts. The caller gets the job ids, not a print result,
 * because at this point nobody knows whether it printed and the sale must not
 * depend on finding out.
 */
export function queueTickets(
  contexts: Omit<PrintContext, 'station'>[],
  stations: StationConfig[],
): { queued: string[]; skipped: string[] } {
  const queued: string[] = [];
  const skipped: string[] = [];

  for (const station of stations) {
    const assignment = assignmentFor(station.id);
    if (!assignment) { skipped.push(station.name); continue; }

    for (const base of contexts) {
      // The station's own paper width is overridden by what is physically
      // loaded on this terminal's printer. A ticket laid out for 80mm and
      // printed on 58mm wraps its whole right-hand column.
      const resolved: StationConfig = { ...station, paperWidthMm: assignment.paperWidthMm };

      // Nothing routed here, so print nothing. Rendering it anyway produces a
      // slip reading "0 items to cook", which a kitchen has to stop and read
      // mid-service before working out it means nothing. An order of two sodas
      // should leave the kitchen printer silent.
      if (!hasPrintableContent({ ...base, station: resolved })) {
        skipped.push(station.name);
        continue;
      }

      const doc = renderTicket({ ...base, station: resolved });
      const bytes = toEscPos(doc, {
        cut: resolved.cutPaper,
        openDrawer: resolved.openCashDrawer,
        feedBeforeCut: resolved.feedBeforeCut,
      });
      queued.push(spool!.enqueue({
        stationId: station.id,
        stationName: station.name,
        target: assignment.target,
        bytes,
        orderId: base.order.billNumber,
        kind: station.kind,
      }));
    }
  }
  return { queued, skipped };
}

function registerIpc(): void {
  ipcMain.handle('escpos:assignments', () => assignments());

  ipcMain.handle('escpos:assign', (_e, a: Assignment) => {
    db!.prepare(`
      INSERT INTO station_printers (station_id, target, paper_width_mm, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(station_id) DO UPDATE SET
        target=excluded.target,
        paper_width_mm=excluded.paper_width_mm,
        updated_at=excluded.updated_at
    `).run(a.stationId, a.target, a.paperWidthMm, Date.now());
    return { ok: true };
  });

  ipcMain.handle('escpos:unassign', (_e, stationId: string) => {
    db!.prepare(`DELETE FROM station_printers WHERE station_id=?`).run(stationId);
    return { ok: true };
  });

  ipcMain.handle('escpos:status', () => spool!.status());

  /**
   * The per-terminal thermal switch.
   *
   * Read and written here rather than in a settings screen somewhere else,
   * because the only place anyone will look for it is beside the printers it
   * governs. Off by default — see main/escposBridge.ts.
   */
  ipcMain.handle('escpos:enabled', () => escposEnabled());
  ipcMain.handle('escpos:setEnabled', (_e, on: boolean) => {
    setEscposEnabled(!!on);
    return { ok: true, enabled: escposEnabled() };
  });
  ipcMain.handle('escpos:retry', (_e, id: string) => { spool!.retry(id); return { ok: true }; });

  /**
   * Preview comes from the SAME Document the printer receives, so what the
   * settings screen shows is what the paper says. There is no second layout
   * engine here to disagree with the first.
   */
  /**
   * Preview for the Printers screen.
   *
   * The renderer sends { stationId, paperWidthMm } — it has no order and no
   * business config, and it should not: building a realistic ticket is main's
   * job, not the screen's. This used to take a whole PrintContext and render it
   * directly, so every call threw on `ctx.order` being undefined and the panel
   * read "Preview unavailable." for every station. Nothing caught it because
   * nothing exercised the two sides against each other.
   *
   * Renders the SAME sample order the verified output was produced from, so a
   * preview that looks right is evidence about the paper.
   */
  ipcMain.handle('escpos:preview', (_e, req: { stationId: string; paperWidthMm: 58 | 80 }) => {
    try {
      const st = stationConfigFor(req.stationId, req.paperWidthMm);
      if (!st) return 'No such station.';

      // Render under the SAMPLE's station id, not the real one.
      //
      // A kitchen ticket includes only lines routed to it
      // (includeUnits: 'routed'), and the sample order routes its lines to
      // 'st-kitchen' / 'st-dispatch'. A real station's id is a uuid, so nothing
      // matched and the preview read "0 items to cook" — on a fixture whose
      // whole purpose is to show five. Dispatch looked correct only because
      // that preset is 'all' and ignores routing entirely, which is exactly the
      // kind of half-working that hides a bug.
      //
      // Name, kind and paper width stay real: the header, the column widths and
      // the wrapping are what the installer is checking.
      const previewStation = {
        ...st,
        id: st.kind === 'kitchen' ? SAMPLE_KITCHEN
          : st.kind === 'dispatch' ? SAMPLE_DISPATCH
          : st.id,
      };

      return toPreview(
        renderTicket({ order: sampleOrder, business: sampleBusiness, station: previewStation }),
        { showMargins: true });
    } catch (err) {
      console.error('[escpos] preview failed:', err);
      return 'Preview unavailable.';
    }
  });

  /**
   * Will ESC/POS actually produce a ticket of this kind on this terminal?
   *
   * The renderer needs this to decide whether to skip the old HTML path. The
   * flag alone is not enough: a terminal can have thermal switched ON and still
   * have no RECEIPT station configured — which is exactly what the first real
   * install looked like, with only Kitchen and dispatcher defined. The receipt
   * button then reported "sent to the printer" and printed nothing at all.
   *
   * A station only counts if it exists AND has a printer bound here.
   */
  /**
   * The shift report / Z-report, as ESC/POS.
   *
   * The last document still printed as HTML. That path measured its page by
   * laying the markup out in an offscreen window whose width was never set to
   * the paper, so the height it computed was for an 800px column while the
   * printer got a 302px one — the report ran off the page and stopped mid-way,
   * losing the entire cash reconciliation.
   *
   * Goes to the RECEIPT station: it is a till document, printed on the same roll
   * as the customer receipt, and a kitchen has no use for it.
   */
  ipcMain.handle('escpos:printShiftReport', async (_e, data: any) => {
    try {
      const assignment = assignments().find(a => {
        const st = stationConfigFor(a.stationId, a.paperWidthMm);
        return st?.kind === 'receipt';
      });
      if (!assignment) return { ok: false, error: 'No receipt printer is set up on this terminal.' };

      const doc = renderShiftReport(
        {
          ...data,
          openedAt:  new Date(data.openedAt),
          closedAt:  data.closedAt ? new Date(data.closedAt) : null,
          printedAt: new Date(),
        },
        assignment.paperWidthMm,
      );
      const bytes = toEscPos(doc, { cut: true, feedBeforeCut: 3 });
      await sendToPrinter(parseTarget(assignment.target), bytes);
      return { ok: true, bytes: bytes.length };
    } catch (err) {
      const e = err as PrinterError;
      return { ok: false, error: e?.message ?? String(err), internal: !(err instanceof PrinterError) };
    }
  });

  ipcMain.handle('escpos:canPrint', (_e, kind: 'kitchen' | 'dispatch' | 'receipt') => {
    try {
      if (!escposEnabled()) return false;
      const bound = new Set(assignments().map(a => a.stationId));
      const rows = db!.prepare(
        `SELECT id FROM print_stations WHERE active = 1 AND kind = ?`
      ).all(kind) as Array<{ id: string }>;
      // Fall back to the built-in ids when a business has configured none.
      const ids = rows.length ? rows.map(r => r.id)
        : [kind === 'receipt' ? 'receipt' : kind];
      return ids.some(id => bound.has(id));
    } catch {
      return false;   // cannot tell → let the path that has always worked run
    }
  });

  /**
   * A test print bypasses the spool and reports the real outcome, because that
   * is the whole point of pressing it: the installer is standing at the printer
   * and needs to know now, not in a queue.
   */
  ipcMain.handle('escpos:test', async (
    _e,
    req: { stationId: string; paperWidthMm: 58 | 80 },
    target: string,
  ) => {
    const started = Date.now();
    try {
      // Takes { stationId, paperWidthMm } — the SAME shape as escpos:preview.
      //
      // This used to take a whole PrintContext while the screen sent the short
      // form, so `ctx.station` was undefined and the handler died on
      // `station.kind` before it reached the printer. The screen then reported
      // "the printer is off or unreachable", which sends an installer to check
      // a power cable over a bug in this file.
      //
      // Both handlers now build their own context from the same sample order,
      // so what Test puts on paper is what Preview shows on screen.
      const st = stationConfigFor(req.stationId, req.paperWidthMm);
      if (!st) return { ok: false, error: `No station "${req.stationId}".`, retryable: false };

      const station = {
        ...st,
        id: st.kind === 'kitchen' ? SAMPLE_KITCHEN
          : st.kind === 'dispatch' ? SAMPLE_DISPATCH
          : st.id,
      };

      const doc = renderTicket({ order: sampleOrder, business: sampleBusiness, station });
      const bytes = toEscPos(doc, { cut: station.cutPaper, feedBeforeCut: station.feedBeforeCut });
      await sendToPrinter(parseTarget(target), bytes);
      return { ok: true, ms: Date.now() - started, bytes: bytes.length };
    } catch (err) {
      const e = err as PrinterError;
      // `retryable` distinguishes "the printer did not answer" from "that
      // address is not a printer". A fault in OUR code is neither, and must not
      // be dressed up as either — it is reported as itself so the next person
      // reads a stack trace instead of unplugging a working printer.
      // PrinterError now carries `internal` itself — set by
      // classifySpoolerFailure, which is the only thing that can tell a spooler
      // fault from a fault in our own script. Anything that is not a
      // PrinterError at all reached here unclassified, so it is ours by
      // definition.
      const isOurs = !(err instanceof PrinterError) || e.internal === true;
      return {
        ok: false,
        error: e?.message ?? String(err),
        retryable: isOurs ? undefined : (e.retryable ?? true),
        internal: isOurs || undefined,
      };
    }
  });
}
