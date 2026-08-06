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

function assignments(): Assignment[] {
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
  ipcMain.handle('escpos:retry', (_e, id: string) => { spool!.retry(id); return { ok: true }; });

  /**
   * Preview comes from the SAME Document the printer receives, so what the
   * settings screen shows is what the paper says. There is no second layout
   * engine here to disagree with the first.
   */
  ipcMain.handle('escpos:preview', (_e, ctx: PrintContext) =>
    toPreview(renderTicket(ctx), { showMargins: true }));

  /**
   * A test print bypasses the spool and reports the real outcome, because that
   * is the whole point of pressing it: the installer is standing at the printer
   * and needs to know now, not in a queue.
   */
  ipcMain.handle('escpos:test', async (_e, ctx: PrintContext, target: string) => {
    const started = Date.now();
    try {
      const doc = renderTicket(ctx);
      const bytes = toEscPos(doc, { cut: true, feedBeforeCut: ctx.station.feedBeforeCut });
      await sendToPrinter(parseTarget(target), bytes);
      return { ok: true, ms: Date.now() - started, bytes: bytes.length };
    } catch (err) {
      const e = err as PrinterError;
      return { ok: false, error: e.message, retryable: e.retryable ?? true };
    }
  });
}
