#!/usr/bin/env node
/**
 * purge-failed-orders.mjs — remove orders the server has permanently refused.
 *
 * TEST ENVIRONMENTS ONLY. This deletes sales rows. On a real till those are the
 * record of money taken, and the fact that they will not sync does not make them
 * untrue — a refused order is still an order somebody paid for.
 *
 * Scope: orders whose sync_queue row is 'failed'. Not 'pending' (still trying)
 * and not anything without a queue row (see queue-check.mjs — those are stranded
 * for a different reason and deleting them hides it).
 *
 *   node scripts/purge-failed-orders.mjs              # dry run, changes nothing
 *   node scripts/purge-failed-orders.mjs --confirm    # actually delete
 *
 * CLOSE THE TILL FIRST. The app holds the database open, and deleting rows
 * underneath a running renderer gives you a screen showing orders that no longer
 * exist.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIRM = process.argv.includes('--confirm');
const pathArg = process.argv.slice(2).find(a => !a.startsWith('--'));

function defaultDb() {
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'SwiftPOS', 'swiftpos.db');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'SwiftPOS', 'swiftpos.db');
  return path.join(home, '.config', 'SwiftPOS', 'swiftpos.db');
}

const dbPath = pathArg ?? defaultDb();
if (!fs.existsSync(dbPath)) { console.error(`No database at ${dbPath}`); process.exit(2); }

const req = createRequire(pathToFileURL(path.join(ROOT, 'package.json')));
const Database = req('better-sqlite3');
const db = new Database(dbPath, CONFIRM ? {} : { readonly: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const get = (sql, ...a) => db.prepare(sql).get(...a);

console.log(`\ndatabase  ${dbPath}`);
console.log(`mode      ${CONFIRM ? 'DELETE' : 'dry run — nothing will be written'}\n`);

// ── What is in scope ─────────────────────────────────────────────────────────
const targets = all(`
  SELECT o.id, o.order_number, o.total, o.created_at, o.status, o.shift_id, q.last_error
    FROM orders o JOIN sync_queue q ON q.order_id = o.id
   WHERE q.status = 'failed'
   ORDER BY o.created_at`);

if (!targets.length) { console.log('Nothing to purge — no failed orders.\n'); process.exit(0); }

const ids = targets.map(t => t.id);
const inList = ids.map(() => '?').join(',');

console.log(`${targets.length} order(s) in scope, total ${targets.reduce((s, t) => s + Number(t.total || 0), 0)}:`);
for (const t of targets) {
  console.log(`  ${t.created_at}  #${t.order_number ?? '?'}  ${String(t.total).padStart(8)}  ${t.status}`);
}

// ── What comes with them ─────────────────────────────────────────────────────
const itemIds = all(`SELECT id FROM order_items WHERE order_id IN (${inList})`, ...ids).map(r => r.id);
const itemList = itemIds.length ? itemIds.map(() => '?').join(',') : "''";

const counts = {
  order_items: itemIds.length,
  order_item_variants: itemIds.length
    ? get(`SELECT COUNT(*) n FROM order_item_variants WHERE order_item_id IN (${itemList})`, ...itemIds).n : 0,
  order_item_modifiers: itemIds.length
    ? get(`SELECT COUNT(*) n FROM order_item_modifiers WHERE order_item_id IN (${itemList})`, ...itemIds).n : 0,
  payments: get(`SELECT COUNT(*) n FROM payments WHERE order_id IN (${inList})`, ...ids).n,
  customer_credit_transactions:
    get(`SELECT COUNT(*) n FROM customer_credit_transactions WHERE order_id IN (${inList})`, ...ids).n,
  sync_queue: get(`SELECT COUNT(*) n FROM sync_queue WHERE order_id IN (${inList})`, ...ids).n,
};

console.log('\nchild rows that go with them:');
for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(30)} ${n}`);

// ── The thing with no foreign key ────────────────────────────────────────────
//
// stock_movements does not carry order_id. It records the deduction with
// notes = 'Order <order_number>', which is a text match and not a relationship.
// So this script does NOT touch it, and deleting the orders leaves the stock
// already deducted and stock_levels already reduced.
//
// That is deliberate. Guessing at a text match to reverse inventory is how a
// purge quietly inflates stock, and on a test database the honest repair is a
// stock count, not a script.
const numbers = targets.map(t => `Order ${t.order_number}`);
const stockHits = numbers.length
  ? get(`SELECT COUNT(*) n FROM stock_movements WHERE notes IN (${numbers.map(() => '?').join(',')})`, ...numbers).n
  : 0;
console.log(`\nstock_movements matching these bill numbers: ${stockHits}  (NOT deleted, NOT reversed)`);
if (stockHits) {
  console.log('  Stock was deducted when these were rung and stays deducted. stock_movements has');
  console.log('  no order_id — only a notes string — so reversing it here would be a guess at a');
  console.log('  text match. If the levels matter on this database, do a stock count instead.');
}

// ── Reports move ─────────────────────────────────────────────────────────────
const shifts = [...new Set(targets.map(t => t.shift_id).filter(Boolean))];
if (shifts.length) {
  console.log(`\nthese orders belong to ${shifts.length} shift(s). Z-reports and daily sales for`);
  console.log('those shifts will change after the delete, including any already printed.');
}

if (!CONFIRM) {
  console.log('\nDry run. Re-run with --confirm to delete.');
  console.log('Close the till first — the app holds this database open.\n');
  process.exit(0);
}

// ── Back up, then delete ─────────────────────────────────────────────────────
const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
db.prepare('SELECT 1').get();          // fail early if the file is not writable
fs.copyFileSync(dbPath, backup);
console.log(`\nbackup    ${backup}`);

// Children first. SQLite here has no cascading deletes, and an order removed
// before its items leaves items pointing at nothing — invisible until something
// joins on them and silently returns fewer rows.
const tx = db.transaction(() => {
  if (itemIds.length) {
    db.prepare(`DELETE FROM order_item_variants WHERE order_item_id IN (${itemList})`).run(...itemIds);
    db.prepare(`DELETE FROM order_item_modifiers WHERE order_item_id IN (${itemList})`).run(...itemIds);
  }
  db.prepare(`DELETE FROM order_items WHERE order_id IN (${inList})`).run(...ids);
  db.prepare(`DELETE FROM payments WHERE order_id IN (${inList})`).run(...ids);
  db.prepare(`DELETE FROM customer_credit_transactions WHERE order_id IN (${inList})`).run(...ids);
  db.prepare(`DELETE FROM sync_queue WHERE order_id IN (${inList})`).run(...ids);
  db.prepare(`DELETE FROM orders WHERE id IN (${inList})`).run(...ids);
});
tx();

console.log(`deleted   ${targets.length} order(s) and ${Object.values(counts).reduce((a, b) => a + b, 0)} child row(s)`);

const left = get(`SELECT COUNT(*) n FROM orders WHERE sync_status='pending'`).n;
const orphanItems = get(`SELECT COUNT(*) n FROM order_items oi
  WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id)`).n;
console.log(`remaining orders pending to cloud: ${left}`);
console.log(`orphaned order_items anywhere in the database: ${orphanItems}`);
console.log(orphanItems === 0
  ? '\nClean. Re-run queue-check.mjs to confirm.\n'
  : '\nOrphaned items found — investigate before trusting any report.\n');
