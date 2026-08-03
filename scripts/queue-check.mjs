#!/usr/bin/env node
/**
 * queue-check.mjs — what is actually holding those pending orders.
 *
 * `orders.sync_status` describes the row. `sync_queue` is what drives the push.
 * The two can disagree, and when they do the row is stranded: it reads pending
 * forever and nothing will ever offer it to the server. No count anywhere says
 * so, which is why this asks the question directly.
 *
 * Read-only. Safe with the till running.
 *
 *   node scripts/queue-check.mjs
 *   node scripts/queue-check.mjs "C:\\path\\to\\swiftpos.db"
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultDb() {
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'SwiftPOS', 'swiftpos.db');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'SwiftPOS', 'swiftpos.db');
  return path.join(home, '.config', 'SwiftPOS', 'swiftpos.db');
}

const dbPath = process.argv[2] ?? defaultDb();
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(2);
}

const req = createRequire(pathToFileURL(path.join(ROOT, 'package.json')));
const Database = req('better-sqlite3');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const all = sql => db.prepare(sql).all();
const get = sql => db.prepare(sql).get();

console.log(`\ndatabase  ${dbPath}\n`);

console.log('sync_queue by status');
const byStatus = all(`SELECT status, COUNT(*) n FROM sync_queue GROUP BY status ORDER BY n DESC`);
if (!byStatus.length) console.log('  (empty)');
for (const r of byStatus) console.log(`  ${String(r.status).padEnd(12)} ${r.n}`);

// A row the server refused for a reason no retry clears. The message is the
// server's own — a count without it is the "9 failed" button that sat in the
// header for a week with no way to find out why.
console.log('\nwhy anything is not synced');
const reasons = all(`
  SELECT COALESCE(last_error,'(no error recorded)') last_error,
         COUNT(*) n, MIN(created_at) since, MAX(attempts) attempts
    FROM sync_queue WHERE status != 'synced'
   GROUP BY last_error ORDER BY n DESC LIMIT 10`);
if (!reasons.length) console.log('  nothing unsynced');
for (const r of reasons) {
  console.log(`  ${r.n}× since ${r.since} (up to ${r.attempts} attempts)`);
  console.log(`     ${r.last_error}`);
}

// The stranded case: pending on the row, absent from the queue. Nothing offers
// these. They are not lost — the order is here and its money was taken — but no
// retry, no button and no sync pass will ever send them.
const stranded = all(`
  SELECT o.id, o.order_number, o.total, o.created_at
    FROM orders o
   WHERE o.sync_status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.order_id = o.id)
   ORDER BY o.created_at`);
console.log(`\nstranded orders (pending, but no queue row): ${stranded.length}`);
for (const o of stranded.slice(0, 20)) {
  console.log(`  ${o.created_at}  #${o.order_number ?? '?'}  ${o.total}  ${o.id}`);
}
if (stranded.length > 20) console.log(`  ... and ${stranded.length - 20} more`);

// The reverse mismatch: the queue thinks it is done, the row does not.
const disagree = get(`
  SELECT COUNT(*) n FROM orders o
    JOIN sync_queue q ON q.order_id = o.id
   WHERE q.status = 'synced' AND o.sync_status = 'pending'`).n;
if (Number(disagree) > 0) {
  console.log(`\n⚠ ${disagree} order(s): the queue says synced, the order says pending.`);
  console.log('  Harmless to the server (it has them) but the header count will not clear.');
}

console.log('\nthe pending orders themselves');
for (const o of all(`
  SELECT o.id, o.order_number, o.total, o.created_at, o.device_id,
         q.status qstatus, q.attempts, q.last_error
    FROM orders o LEFT JOIN sync_queue q ON q.order_id = o.id
   WHERE o.sync_status = 'pending' ORDER BY o.created_at LIMIT 20`)) {
  console.log(`  ${o.created_at}  #${o.order_number ?? '?'}  ${String(o.total).padStart(8)}  ` +
              `queue=${o.qstatus ?? 'MISSING'}${o.attempts ? ` (${o.attempts} tries)` : ''}`);
  if (o.last_error) console.log(`      ${o.last_error}`);
}

// ── Which products are these orders actually referencing? ────────────────────
//
// "Order contains a product that does not belong to this business" has two very
// different causes and they need opposite responses:
//
//   the product is gone from this till too  → M34. The menu was re-imported or
//       the product deleted, the order references a UUID that no longer exists
//       anywhere, and it can NEVER sync. Refusing loses the sale; accepting
//       records a price nobody can verify. That is the business call the
//       handoff left open.
//
//   the product is still here  → the till and the server disagree about who
//       owns it. Not M34 — a tenancy or catalogue-sync problem, and the order
//       may well sync once that is sorted. Do not delete these.
//
// A count of failures cannot tell those apart. This can.
console.log('\nproducts referenced by the failed orders');
const failedOrders = all(`
  SELECT o.id, o.order_number FROM orders o
    JOIN sync_queue q ON q.order_id = o.id
   WHERE q.status = 'failed'`);

if (!failedOrders.length) {
  console.log('  none');
} else {
  const rows = all(`
    SELECT oi.product_id, oi.product_name,
           COUNT(DISTINCT oi.order_id) orders,
           SUM(oi.subtotal) value,
           (SELECT COUNT(*) FROM products p WHERE p.id = oi.product_id) still_here
      FROM order_items oi
      JOIN sync_queue q ON q.order_id = oi.order_id AND q.status = 'failed'
     GROUP BY oi.product_id, oi.product_name
     ORDER BY orders DESC, value DESC`);

  const missing = rows.filter(r => Number(r.still_here) === 0);
  const present = rows.filter(r => Number(r.still_here) > 0);

  console.log(`  ${rows.length} distinct product(s) across ${failedOrders.length} failed order(s)`);
  if (missing.length) {
    console.log(`\n  GONE from this till's catalogue too — M34, cannot ever sync as-is:`);
    for (const r of missing) {
      console.log(`    ${r.product_name ?? '(unnamed)'}  ${r.orders} order(s)  ${r.value}  [${r.product_id}]`);
    }
  }
  if (present.length) {
    console.log(`\n  STILL in this till's catalogue — the till and server disagree about ownership,`);
    console.log(`  which is a different problem and may be fixable without losing the sale:`);
    for (const r of present) {
      console.log(`    ${r.product_name ?? '(unnamed)'}  ${r.orders} order(s)  ${r.value}  [${r.product_id}]`);
    }
  }
}
// ── Per-order verdict ────────────────────────────────────────────────────────
//
// The aggregate above says which products are missing. It does not say which
// ORDERS are actually blocked by that, and those need opposite actions:
//
//   every product missing / some missing → M34. Cannot sync as it stands.
//   no product missing                   → it failed for some OTHER reason, and
//                                          that reason may since have been fixed.
//                                          Safe to re-queue and find out.
//
// Lumping them together is how a re-queueable sale sits in a 'failed' bucket
// for a fortnight next to nine that genuinely cannot move.
console.log('\nper-order verdict');
for (const o of all(`
  SELECT o.id, o.order_number, o.total, o.created_at, q.last_error
    FROM orders o JOIN sync_queue q ON q.order_id = o.id
   WHERE q.status = 'failed' ORDER BY o.created_at`)) {
  const items = all(`
    SELECT oi.product_id, oi.product_name,
           (SELECT COUNT(*) FROM products p WHERE p.id = oi.product_id) still_here
      FROM order_items oi WHERE oi.order_id = '${o.id.replace(/'/g, "''")}'`);
  const gone = items.filter(i => Number(i.still_here) === 0);
  const verdict = items.length === 0 ? 'NO ITEMS RECORDED'
    : gone.length === 0 ? 'RE-QUEUEABLE — every product still exists'
    : gone.length === items.length ? `M34 — all ${items.length} product(s) gone`
    : `M34 — ${gone.length} of ${items.length} product(s) gone`;
  console.log(`  #${o.order_number ?? '?'}  ${String(o.total).padStart(8)}  ${o.created_at}`);
  console.log(`      ${verdict}`);
  if (gone.length && gone.length < items.length) {
    console.log(`      missing: ${gone.map(g => g.product_name).join(', ')}`);
  }
}

// ── Evidence of a menu re-import ─────────────────────────────────────────────
//
// The same product NAME under two different UUIDs — one referenced by a failed
// order and absent from the catalogue, one present — means the catalogue was
// rebuilt rather than the product genuinely deleted. That matters for the M34
// decision: the item is still on sale, so the order is a real sale of a real
// product and only its id is stale. That is a remap, not a write-off.
console.log('\nsame name, different id — menu re-import evidence');
const pairs = all(`
  SELECT DISTINCT oi.product_name, oi.product_id AS old_id, p.id AS new_id
    FROM order_items oi
    JOIN sync_queue q ON q.order_id = oi.order_id AND q.status = 'failed'
    JOIN products p ON lower(trim(p.name)) = lower(trim(oi.product_name))
   WHERE NOT EXISTS (SELECT 1 FROM products x WHERE x.id = oi.product_id)
   ORDER BY oi.product_name`);
if (!pairs.length) {
  console.log('  none — the missing products are not on the catalogue under any id,');
  console.log('  so they were genuinely removed rather than re-imported.');
} else {
  for (const p of pairs) {
    console.log(`  ${p.product_name}`);
    console.log(`      order references ${p.old_id}`);
    console.log(`      catalogue now has ${p.new_id}`);
  }
  console.log(`\n  ${pairs.length} product(s) could be remapped old id → new id, after which`);
  console.log('  those orders would reference products the server recognises. That is a');
  console.log('  decision, not a repair: match by name and you are asserting the two are');
  console.log('  the same item, and the price on the order stays whatever was charged.');
}
console.log('');
