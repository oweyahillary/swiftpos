/**
 * billNumber.ts — A500: a bill number never stops a sale, and never stops a till's sale reaching the branch.
 *
 * Owner, 2026-10-15 (a till log): "distribution: refused 1 orders row(s) … UNIQUE constraint failed: orders.order_number",
 * receipts showing "T3--5". Bill numbers are `<terminal code>--<n>`, n from this till's own counter (counters.bill_seq).
 * A till wiped or reinstalled gets its old terminal code back from the cloud (A182) under a NEW device id, with its counter
 * at 0 — while the branch server and the other tills still hold the sales its earlier self numbered T3--1, T3--2, …
 * The local `orders.order_number` is UNIQUE across every row a machine holds (its own sales AND the branch's replicas), so:
 *   - the branch's copies of the new till's sales were refused (the log above) — the sale missing from the branch, and
 *   - worse, once the old rows had reached the new till, its own next sale "T3--1" could not be saved at all.
 * The cloud already allows it (migration 94: unique per business, branch AND device).
 *
 * The rules now:
 *   1. nextBillNumber continues past every number this machine holds for the code (a wiped till carries on, it does not
 *      restart) — cheap: one unique-index lookup per sale, a scan only when the counter has fallen behind.
 *   2. A sale rung here keeps its number (it may already be on a kitchen ticket): a REPLICA holding it yields — its local
 *      copy is renamed `<number>~<device>`; the row's id stays its identity everywhere.
 *   3. A replica arriving (server ingest or a till's distribution pull) whose number is already held by another row is
 *      stored under `<number>~<device>` instead of being refused. Logged loudly, never dropped.
 */
import type Database from 'better-sqlite3';

type Db = Database.Database;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The highest n of `<code>--<n>` this machine holds (sales, replicas and held bills), or 0. */
export function highestBillSeq(db: Db, code: string): number {
  const prefix = `${code}--`;
  const pattern = `${likeEscape(prefix)}%`;
  let max = 0;
  for (const table of ['orders', 'held_orders']) {
    try {
      const row = db.prepare(
        `SELECT MAX(CAST(substr(order_number, ?) AS INTEGER)) AS n FROM ${table}
          WHERE order_number LIKE ? ESCAPE '\\' AND substr(order_number, ?) GLOB '[0-9]*'
            AND substr(order_number, ?) NOT GLOB '*[^0-9]*'`,
      ).get(prefix.length + 1, pattern, prefix.length + 1, prefix.length + 1) as { n: number | null } | undefined;
      if (Number(row?.n) > max) max = Number(row!.n);
    } catch { /* a table this database does not have */ }
  }
  return max;
}

function numberTaken(db: Db, num: string): boolean {
  // branch-wide: a bill number is unique across every row this machine holds (own sales and the branch's replicas).
  if (db.prepare(`SELECT 1 FROM orders WHERE order_number = ?`).get(num)) return true;
  try { if (db.prepare(`SELECT 1 FROM held_orders WHERE order_number = ?`).get(num)) return true; } catch { /* no table */ }
  return false;
}

/**
 * The next bill number for this till. `code` empty → the old unprefixed scheme (no terminal code yet).
 * Atomic (better-sqlite3 transactions are synchronous).
 */
export function nextBillNumber(db: Db, code: string | null | undefined, now = Date.now()): string {
  const c = String(code ?? '').trim();
  if (!c) return `ORD-${now.toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
  return db.transaction(() => {
    db.prepare(`INSERT INTO counters (name, value) VALUES ('bill_seq', 0) ON CONFLICT(name) DO NOTHING`).run();
    for (let i = 0; i < 5; i++) {
      db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'bill_seq'`).run();
      const seq = Number((db.prepare(`SELECT value FROM counters WHERE name = 'bill_seq'`).get() as { value: number } | undefined)?.value ?? 1);
      const candidate = `${c}--${seq}`;
      if (!numberTaken(db, candidate)) return candidate;
      // Behind what this machine holds (a wiped / reinstalled till, rows pulled from the branch): carry on past it.
      const high = highestBillSeq(db, c);
      if (high >= seq) db.prepare(`UPDATE counters SET value = ? WHERE name = 'bill_seq'`).run(high);
    }
    // Five tries cannot all clash after the jump; belt and braces — a number nobody holds.
    return `${c}--${Date.now()}`;
  })();
}

/** `<number>~<first 8 of the device>` (then ~2, ~3 …) — a number no row on this machine holds. */
export function aliasOrderNumber(db: Db, num: string, deviceId: string | null | undefined): string {
  const base = `${num}~${String(deviceId ?? 'peer').slice(0, 8)}`;
  if (!numberTaken(db, base)) return base;
  for (let i = 2; i < 1000; i++) if (!numberTaken(db, `${base}~${i}`)) return `${base}~${i}`;
  return `${base}~${Date.now()}`;
}

/**
 * Rule 3 — the number a replica row is stored under on this machine: its own, unless another row (another id) holds it.
 * Returns null when the number is free (store as it came).
 */
export function replicaOrderNumber(db: Db, row: { id: string; order_number?: unknown; device_id?: unknown }): string | null {
  const num = row?.order_number === null || row?.order_number === undefined ? '' : String(row.order_number);
  if (!num) return null;
  // branch-wide: which row (any till's) already holds this number here.
  const holder = db.prepare(`SELECT id FROM orders WHERE order_number = ?`).get(num) as { id: string } | undefined;
  if (!holder || holder.id === String(row.id)) return null;
  return aliasOrderNumber(db, num, row.device_id ? String(row.device_id) : null);
}

/**
 * Rule 2 — before a sale rung here is written: free its number. A replica holding it is renamed (its copy here only);
 * a row of THIS till holding it (a stale reservation) means this sale takes the next number. Returns the number to use,
 * and what happened, for the log. Call inside the sale's transaction.
 */
export function claimOrderNumberForOwnSale(db: Db, num: string, ownDevice: string | null | undefined, code: string | null | undefined):
  { number: string; renamedReplica?: { id: string; to: string }; renumbered?: boolean } {
  if (!num) return { number: num };
  // branch-wide: the holder may be another till's replica (it yields) or this till's own sale.
  const holder = db.prepare(`SELECT id, device_id FROM orders WHERE order_number = ?`).get(num) as { id: string; device_id: string | null } | undefined;
  if (!holder) return { number: num };
  const mine = (holder.device_id ?? '') === (ownDevice ?? '');
  if (!mine) {
    const to = aliasOrderNumber(db, num, holder.device_id);
    db.prepare(`UPDATE orders SET order_number = ? WHERE id = ?`).run(to, holder.id);
    return { number: num, renamedReplica: { id: holder.id, to } };
  }
  return { number: nextBillNumber(db, code), renumbered: true };
}
