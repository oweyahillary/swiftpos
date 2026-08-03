#!/usr/bin/env node
/**
 * test-node-ingest.mjs — the branch replication ingest rules, executed.
 *
 * Every rule in nodeIngest.applyPeerRows is a case where continuing would
 * produce a plausible and incorrect number rather than an error. That is the
 * class of failure nothing else catches: tsc sees strings, the lints see shapes,
 * and the symptom on site is a report that foots but is wrong.
 *
 * The rule under test throughout is the one from the handoff: an ingested row
 * keeps the PEER's device_id. If it does not, getOpenShift() on the node returns
 * a cashier's open drawer from another terminal, and the sell gate is built on
 * getOpenShift().
 *
 * Mirrors the logic in nodeIngest.ts against real SQLite rather than importing
 * it — the module pulls in getLocalDb/getDeviceConfig, which pull in electron.
 * Where the two could drift, section 0 asserts the column lists are identical to
 * the ones the module declares.
 *
 *   node --no-warnings scripts/test-node-ingest.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqlite } from './lib/sqlite-open.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Prefers better-sqlite3 — the driver the app actually uses — and falls back to
// node:sqlite only where it is available. Which one ran is printed, because a
// pass against a different engine than the app is a weaker claim than it looks.
const { db: _probe, driver: DRIVER, isAppDriver: IS_APP_DRIVER } = openSqlite(REPO, ':memory:');
_probe.close();
const openMemoryDb = () => openSqlite(REPO, ':memory:').db;


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log(`\ndriver: ${DRIVER}`);
let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const NODE_DEVICE = 'dev-node-T1';
const PEER_DEVICE = 'dev-peer-T2';
const BRANCH      = 'branch-1';
const PEER_STATUS = 'peer';

const SHIFT_COLS = [
  'id', 'business_id', 'branch_id', 'cashier_id', 'opened_at', 'closed_at', 'status',
  'opening_float', 'closing_float', 'expected_cash', 'cash_variance', 'notes',
  'created_at', 'closed_by', 'close_method', 'business_day_id', 'business_date',
  'device_id', 'terminal_code', 'drawer_label', 'opened_by', 'seq',
];

function freshDb() {
  const db = openMemoryDb();
  db.exec(`
    CREATE TABLE shifts (
      id TEXT PRIMARY KEY, business_id TEXT, branch_id TEXT, cashier_id TEXT,
      opened_at TEXT, closed_at TEXT, status TEXT DEFAULT 'open',
      opening_float REAL DEFAULT 0, closing_float REAL, expected_cash REAL,
      cash_variance REAL, notes TEXT, created_at TEXT, closed_by TEXT,
      close_method TEXT, business_day_id TEXT, business_date TEXT, device_id TEXT,
      terminal_code TEXT, drawer_label TEXT, opened_by TEXT, seq INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE peer_cursors (
      device_id TEXT NOT NULL, table_name TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY (device_id, table_name));
    CREATE TABLE device_seq (table_name TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1);
  `);
  return db;
}

const shiftRow = (o = {}) => ({
  id: o.id ?? 'shift-p1', business_id: 'biz-1', branch_id: o.branch_id ?? BRANCH,
  cashier_id: 'cash-9', opened_at: '2026-08-02T06:00:00Z', closed_at: null,
  status: o.status ?? 'open', opening_float: 1000, closing_float: null,
  expected_cash: null, cash_variance: null, notes: null,
  created_at: o.created_at ?? '2026-08-02T06:00:00Z', closed_by: null, close_method: null,
  business_day_id: 'day-1', business_date: '2026-08-02',
  device_id: 'device_id' in o ? o.device_id : PEER_DEVICE,
  terminal_code: 'T2', drawer_label: 'Drawer 2', opened_by: 'user-9',
  seq: 'seq' in o ? o.seq : 1,
});

function advanceCursor(db, deviceId, table, seq) {
  db.prepare(
    `INSERT INTO peer_cursors (device_id, table_name, last_seq, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(device_id, table_name) DO UPDATE
       SET last_seq = MAX(peer_cursors.last_seq, excluded.last_seq),
           updated_at = excluded.updated_at`).run(deviceId, table, seq);
}

/** The applyPeerRows logic, against a real database. */
function applyPeerRows(db, table, peerDeviceId, rows, nodeCfg = { device_id: NODE_DEVICE, branch_id: BRANCH }) {
  const result = { applied: 0, duplicate: 0, rejected: [], cursor: 0 };
  const reject = (id, reason) => result.rejected.push({ id: String(id ?? '?'), table, reason });

  if (!peerDeviceId) { for (const r of rows) reject(r?.id, 'peer sent no device_id'); return result; }
  if (nodeCfg.device_id && peerDeviceId === nodeCfg.device_id) {
    for (const r of rows) reject(r?.id, 'peer is presenting this node\'s own device_id');
    return result;
  }

  const cols = SHIFT_COLS;
  const insert = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}, sync_status)
     VALUES (${cols.map(() => '?').join(', ')}, '${PEER_STATUS}')`);
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);

  for (const row of [...rows].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0))) {
    const id = row?.id ? String(row.id) : null;
    if (!id) { reject('?', 'row has no id'); continue; }
    const rowDevice = row.device_id ? String(row.device_id) : null;
    if (rowDevice && rowDevice !== peerDeviceId) { reject(id, 'row device_id does not match sender'); continue; }
    const seq = Number(row.seq);
    if (!Number.isInteger(seq) || seq <= 0) { reject(id, 'row has no sequence number'); continue; }
    if (nodeCfg.branch_id && row.branch_id && String(row.branch_id) !== nodeCfg.branch_id) {
      reject(id, 'row belongs to a different branch'); continue;
    }
    if (exists.get(id)) { result.duplicate++; if (seq > result.cursor) result.cursor = seq; continue; }
    try {
      insert.run(...cols.map(c => (c === 'device_id' ? peerDeviceId : row[c] ?? null)));
      result.applied++;
      if (seq > result.cursor) result.cursor = seq;
    } catch (err) { reject(id, String(err?.message)); break; }
  }
  if (result.cursor > 0) advanceCursor(db, peerDeviceId, table, result.cursor);
  return result;
}

// ── 0. The harness matches the module ────────────────────────────────────────
console.log('\n0. Column list matches nodeIngest.ts');
{
  const src = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/nodeIngest.ts'), 'utf8');
  const block = src.slice(src.indexOf('shifts: ['), src.indexOf('float_transactions: ['));
  const declared = [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  ok('shifts columns identical to the module\'s',
     JSON.stringify(declared) === JSON.stringify(SHIFT_COLS),
     `module=${declared.length} test=${SHIFT_COLS.length}`);
  ok('sync_status is NOT replicated', !declared.includes('sync_status'));
  ok('seq IS replicated', declared.includes('seq'));
}

// ── 1. The rule the sell gate depends on ─────────────────────────────────────
console.log('\n1. An ingested row keeps the PEER\'s device_id');
{
  const db = freshDb();
  const r = applyPeerRows(db, 'shifts', PEER_DEVICE, [shiftRow()]);
  const got = db.prepare(`SELECT device_id, seq, sync_status FROM shifts WHERE id='shift-p1'`).get();
  ok('applied', r.applied === 1);
  ok('device_id is the peer\'s, not the node\'s', got.device_id === PEER_DEVICE, `got ${got.device_id}`);
  ok('seq is the peer\'s, not re-minted', got.seq === 1);
  ok('sync_status is the peer marker, not pending', got.sync_status === PEER_STATUS);

  // The actual consequence: the node's own-scoped sell-gate query must not see it.
  const own = db.prepare(
    `SELECT id FROM shifts WHERE status='open' AND COALESCE(device_id,'') = COALESCE(?,'')
      ORDER BY opened_at DESC LIMIT 1`).get(NODE_DEVICE);
  ok('getOpenShift on the node does NOT return the peer\'s drawer', own === undefined);

  // And the branch-wide view must.
  const all = db.prepare(`SELECT COUNT(*) n FROM shifts WHERE status='open'`).get();
  ok('the branch-wide view DOES see it', all.n === 1);
  db.close();
}

// ── 2. Rows that must be refused ─────────────────────────────────────────────
console.log('\n2. Refusals — each one would otherwise produce a wrong number');
{
  const db = freshDb();

  const noDevice = applyPeerRows(db, 'shifts', '', [shiftRow({ id: 's-a' })]);
  ok('a peer with no device_id is refused', noDevice.applied === 0 && noDevice.rejected.length === 1);

  // NULL device_id is not neutral: COALESCE(NULL,'') matches "mine" on a till
  // that has no device_id of its own.
  const nullDev = applyPeerRows(db, 'shifts', PEER_DEVICE, [shiftRow({ id: 's-b', device_id: null })]);
  ok('a row with NULL device_id is stamped with the sender\'s, not left NULL',
     nullDev.applied === 1 &&
     db.prepare(`SELECT device_id d FROM shifts WHERE id='s-b'`).get().d === PEER_DEVICE);

  const impostor = applyPeerRows(db, 'shifts', NODE_DEVICE, [shiftRow({ id: 's-c', device_id: NODE_DEVICE })]);
  ok('a peer presenting the node\'s own device_id is refused',
     impostor.applied === 0 && impostor.rejected[0].reason.includes('own device_id'));

  const mismatch = applyPeerRows(db, 'shifts', PEER_DEVICE, [shiftRow({ id: 's-d', device_id: 'dev-other' })]);
  ok('a row re-stamped in transit is refused',
     mismatch.applied === 0 && mismatch.rejected[0].reason.includes('does not match'));

  const noSeq = applyPeerRows(db, 'shifts', PEER_DEVICE, [shiftRow({ id: 's-e', seq: null })]);
  ok('a row with no seq is refused (peer on a pre-45 build)',
     noSeq.applied === 0 && noSeq.rejected[0].reason.includes('sequence'));

  const wrongBranch = applyPeerRows(db, 'shifts', PEER_DEVICE, [shiftRow({ id: 's-f', branch_id: 'branch-2' })]);
  ok('a row from another branch is refused',
     wrongBranch.applied === 0 && wrongBranch.rejected[0].reason.includes('different branch'));

  ok('nothing refused was written', db.prepare(`SELECT COUNT(*) n FROM shifts`).get().n === 1);
  db.close();
}

// ── 3. Idempotency and the cursor ────────────────────────────────────────────
console.log('\n3. Retries are free, and the cursor is resumable');
{
  const db = freshDb();
  const batch = [shiftRow({ id: 's-1', seq: 1 }), shiftRow({ id: 's-2', seq: 2 }), shiftRow({ id: 's-3', seq: 3 })];

  const first = applyPeerRows(db, 'shifts', PEER_DEVICE, batch);
  ok('three applied', first.applied === 3);
  ok('cursor at the highest seq', first.cursor === 3);

  const again = applyPeerRows(db, 'shifts', PEER_DEVICE, batch);
  ok('re-offering the same batch applies nothing', again.applied === 0 && again.duplicate === 3);
  ok('and does not duplicate rows', db.prepare(`SELECT COUNT(*) n FROM shifts`).get().n === 3);

  const cursor = db.prepare(`SELECT last_seq FROM peer_cursors WHERE device_id=? AND table_name='shifts'`).get(PEER_DEVICE);
  ok('cursor persisted at 3', cursor.last_seq === 3);

  // A reinstalled peer restarts its counter. Accepting a lower cursor would make
  // it claim to hold less than it does, and re-offer rows already held.
  advanceCursor(db, PEER_DEVICE, 'shifts', 1);
  ok('the cursor never moves backwards',
     db.prepare(`SELECT last_seq l FROM peer_cursors WHERE device_id=? AND table_name='shifts'`).get(PEER_DEVICE).l === 3);
  db.close();
}

// ── 4. Out-of-order delivery ─────────────────────────────────────────────────
console.log('\n4. Out-of-order arrival, and a mid-batch failure');
{
  const db = freshDb();
  const r = applyPeerRows(db, 'shifts', PEER_DEVICE,
    [shiftRow({ id: 's-3', seq: 3 }), shiftRow({ id: 's-1', seq: 1 }), shiftRow({ id: 's-2', seq: 2 })]);
  ok('a shuffled batch applies in seq order', r.applied === 3);
  const order = db.prepare(`SELECT id FROM shifts ORDER BY seq`).all().map(x => x.id);
  ok('rows land in sequence order', JSON.stringify(order) === JSON.stringify(['s-1', 's-2', 's-3']));
  db.close();
}
{
  // seq 2 collides with a row already held under a different id — a genuine
  // insert failure. The batch must stop, and the cursor must not advance past
  // the failure, or seq 3 is skipped and never re-offered.
  const db = freshDb();
  applyPeerRows(db, 'shifts', PEER_DEVICE, [shiftRow({ id: 's-1', seq: 1 })]);
  db.exec(`CREATE UNIQUE INDEX shifts_seq_uq ON shifts (device_id, seq)`);
  const r = applyPeerRows(db, 'shifts', PEER_DEVICE,
    [shiftRow({ id: 's-x', seq: 1 }), shiftRow({ id: 's-3', seq: 3 })]);
  ok('the batch stops at the first genuine failure', r.rejected.length === 1);
  ok('the cursor does not advance past the failure', r.cursor === 0,
     `cursor=${r.cursor}`);
  ok('the later row is left for the next pass', 
     db.prepare(`SELECT COUNT(*) n FROM shifts WHERE id='s-3'`).get().n === 0);
  db.close();
}

// ── 5. Sequence allocation ───────────────────────────────────────────────────
console.log('\n5. seq comes from the device counter, not MAX(seq)');
{
  const db = freshDb();
  const nextSeq = table => {
    db.prepare(`INSERT INTO device_seq (table_name, next_seq) VALUES (?, 1) ON CONFLICT(table_name) DO NOTHING`).run(table);
    return db.prepare(`UPDATE device_seq SET next_seq = next_seq + 1 WHERE table_name = ? RETURNING next_seq - 1 AS seq`).get(table).seq;
  };
  ok('first allocation is 1', nextSeq('shifts') === 1);
  ok('and it increments', nextSeq('shifts') === 2 && nextSeq('shifts') === 3);

  // The node now ingests a peer row at seq 900. MAX(seq)+1 would hand this
  // device 901 — a number derived from another terminal's counter, after which
  // the two disagree about what "device X up to N" contains.
  applyPeerRows(db, 'shifts', PEER_DEVICE, [shiftRow({ id: 's-peer', seq: 900 })]);
  ok('a peer\'s high seq does not move this device\'s counter', nextSeq('shifts') === 4);
  ok('MAX(seq) would have got this wrong',
     db.prepare(`SELECT MAX(seq) m FROM shifts`).get().m === 900);
  db.close();
}

// ── 6. Order lines travel with their order ───────────────────────────────────
console.log('\n6. Order lines are part of the order, not a sixth table');
{
  const db = openMemoryDb();
  db.exec(`
    CREATE TABLE orders (id TEXT PRIMARY KEY, branch_id TEXT, total REAL,
      created_at TEXT, device_id TEXT, seq INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT, product_id TEXT,
      product_name TEXT, category_name TEXT, unit_price REAL, quantity INTEGER,
      subtotal REAL, course TEXT, fire_status TEXT);
  `);
  const ITEM_COLS = ['id','order_id','product_id','product_name','category_name',
                     'unit_price','quantity','subtotal','course','fire_status'];
  const order = {
    id: 'ord-1', branch_id: BRANCH, total: 450, created_at: '2026-08-02T10:00:00Z',
    device_id: PEER_DEVICE, seq: 1,
    _items: [
      { id: 'it-1', order_id: 'ord-1', product_id: 'p-1', product_name: 'Chips',
        category_name: 'Sides', unit_price: 150, quantity: 3, subtotal: 450,
        course: null, fire_status: 'fired' },
    ],
  };

  const cols = ['id','branch_id','total','created_at','device_id','seq'];
  const insert = db.prepare(
    `INSERT INTO orders (${cols.join(', ')}, sync_status)
     VALUES (${cols.map(() => '?').join(', ')}, '${PEER_STATUS}')`);
  const insertItem = db.prepare(
    `INSERT OR IGNORE INTO order_items (${ITEM_COLS.join(', ')})
     VALUES (${ITEM_COLS.map(() => '?').join(', ')})`);

  insert.run(...cols.map(c => (c === 'device_id' ? PEER_DEVICE : order[c] ?? null)));
  for (const it of order._items) insertItem.run(...ITEM_COLS.map(c => it[c] ?? null));

  ok('the order landed', db.prepare(`SELECT COUNT(*) n FROM orders`).get().n === 1);
  ok('its lines landed with it', db.prepare(`SELECT COUNT(*) n FROM order_items`).get().n === 1);

  // The failure this guards: sales total right, top-products under-reporting,
  // and the two disagreeing with nothing saying why.
  const total = db.prepare(`SELECT SUM(total) t FROM orders`).get().t;
  const lines = db.prepare(`SELECT SUM(subtotal) s FROM order_items`).get().s;
  ok('branch sales and the product breakdown agree', total === lines, `${total} vs ${lines}`);

  // Re-offering must not duplicate lines either.
  for (const it of order._items) insertItem.run(...ITEM_COLS.map(c => it[c] ?? null));
  ok('re-offering does not duplicate lines', db.prepare(`SELECT COUNT(*) n FROM order_items`).get().n === 1);
  db.close();
}

// ── 6b. Payments travel with their order ─────────────────────────────────────
// The gap this closes was visible on a screen before it was found in code: a
// peer till's sale on the node's manager view with Payment "—", and a branch
// method split that omitted every terminal but the node's own.
console.log('\n6b. Payments are part of the order too');
{
  const src = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/nodeIngest.ts'), 'utf8');

  // Parity: the module's PAYMENT_COLUMNS is what this section simulates.
  const pblock = src.slice(src.indexOf('const PAYMENT_COLUMNS'), src.indexOf('];', src.indexOf('const PAYMENT_COLUMNS')));
  const PAY_COLS = [...pblock.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  ok('module replicates 9 payment columns',
     JSON.stringify(PAY_COLS) === JSON.stringify(
       ['id','order_id','method','amount','amount_tendered','change_given','reference','status','created_at']),
     PAY_COLS.join(','));
  ok('payment sync_status is NOT replicated', !PAY_COLS.includes('sync_status'));

  // Both sides exist in the module: sender attaches, ingest inserts.
  ok('sender attaches _payments in fillNodeOutbox', src.includes('row._payments = readPays.all'));
  ok('ingest inserts _payments inside the order transaction', src.includes("Array.isArray(row._payments)"));
  ok("ingested payments are stamped 'peer', never left 'pending'",
     /INSERT OR IGNORE INTO payments[\s\S]{0,200}'\$\{PEER_SYNC_STATUS\}'/.test(src));

  const db = openMemoryDb();
  db.exec(`
    CREATE TABLE orders (id TEXT PRIMARY KEY, total REAL, device_id TEXT);
    CREATE TABLE payments (id TEXT PRIMARY KEY, order_id TEXT, method TEXT,
      amount REAL, amount_tendered REAL, change_given REAL DEFAULT 0,
      reference TEXT, status TEXT DEFAULT 'completed', created_at TEXT,
      sync_status TEXT DEFAULT 'pending');
  `);
  db.prepare(`INSERT INTO orders VALUES ('ord-1', 1490, 'dev-T2')`).run();
  const insertPay = db.prepare(
    `INSERT OR IGNORE INTO payments (${PAY_COLS.join(', ')}, sync_status)
     VALUES (${PAY_COLS.map(() => '?').join(', ')}, 'peer')`);
  const pays = [
    { id: 'pay-1', order_id: 'ord-1', method: 'glovo', amount: 1490,
      amount_tendered: 1490, change_given: 0, reference: 'GLV-8842',
      status: 'completed', created_at: '2026-08-03T12:00:00Z' },
  ];
  for (const p of pays) insertPay.run(...PAY_COLS.map(c => p[c] ?? null));

  ok('the payment landed with its method',
     db.prepare(`SELECT method FROM payments WHERE order_id='ord-1'`).get().method === 'glovo');
  ok("it sits in 'peer', invisible to every push path",
     db.prepare(`SELECT sync_status FROM payments`).get().sync_status === 'peer');

  // Payments sum to the order — the invariant the manager screen surfaced as broken.
  const paid = db.prepare(`SELECT SUM(amount) a FROM payments WHERE order_id='ord-1'`).get().a;
  ok('payments sum to the order total', paid === 1490, `${paid} vs 1490`);

  // The repair path: an order already held, re-offered WITH payments, fills the
  // hole and cannot double anything.
  for (const p of pays) insertPay.run(...PAY_COLS.map(c => p[c] ?? null));
  ok('re-offering does not duplicate payments',
     db.prepare(`SELECT COUNT(*) n FROM payments`).get().n === 1);
  db.close();
}

// ── 7. The outbox cursor ─────────────────────────────────────────────────────
console.log('\n7. The outbox offers each row once, and survives pruning');
{
  const db = freshDb();
  db.exec(`
    CREATE TABLE node_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL,
      payload TEXT NOT NULL, attempts INTEGER DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      UNIQUE (table_name, row_id));
    CREATE TABLE outbox_cursors (table_name TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  `);
  const OWN = 'dev-me';
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO shifts (id, branch_id, created_at, device_id, seq) VALUES (?,?,?,?,?)`)
      .run(`own-${i}`, BRANCH, `2026-08-02T0${i}:00:00Z`, OWN, i);
  }
  // A peer row on the same node — must never be offered onward as though it were ours.
  db.prepare(`INSERT INTO shifts (id, branch_id, created_at, device_id, seq) VALUES (?,?,?,?,?)`)
    .run('peer-1', BRANCH, '2026-08-02T01:30:00Z', PEER_DEVICE, 7);

  const cursor = () => db.prepare(`SELECT last_seq l FROM outbox_cursors WHERE table_name='shifts'`).get()?.l ?? 0;
  const fill = () => {
    const rows = db.prepare(
      `SELECT id, seq FROM shifts WHERE seq IS NOT NULL AND seq > ?
         AND COALESCE(device_id,'') = COALESCE(?,'') ORDER BY seq`).all(cursor(), OWN);
    let high = 0;
    for (const r of rows) {
      db.prepare(`INSERT OR IGNORE INTO node_queue (table_name,row_id,payload,created_at,status)
                  VALUES ('shifts',?,?,datetime('now'),'pending')`).run(r.id, '{}');
      if (r.seq > high) high = r.seq;
    }
    if (high) db.prepare(`INSERT INTO outbox_cursors (table_name,last_seq,updated_at) VALUES ('shifts',?,datetime('now'))
      ON CONFLICT(table_name) DO UPDATE SET last_seq=MAX(outbox_cursors.last_seq,excluded.last_seq), updated_at=excluded.updated_at`).run(high);
    return rows.length;
  };

  ok('first fill offers this till\'s three rows', fill() === 3);
  ok('and not the peer\'s row',
     db.prepare(`SELECT COUNT(*) n FROM node_queue WHERE row_id='peer-1'`).get().n === 0);
  ok('a second fill offers nothing new', fill() === 0);

  // Delivered rows get pruned. Without a cursor the next scan would re-offer them.
  db.exec(`UPDATE node_queue SET status='delivered'`);
  db.exec(`DELETE FROM node_queue WHERE status='delivered'`);
  ok('pruning delivered rows does not resurrect them', fill() === 0);
  ok('cursor still at 3', cursor() === 3);

  db.prepare(`INSERT INTO shifts (id, branch_id, created_at, device_id, seq) VALUES (?,?,?,?,?)`)
    .run('own-4', BRANCH, '2026-08-02T04:00:00Z', OWN, 4);
  ok('a new row is offered', fill() === 1);
  db.close();
}

console.log(`\n${passed} passed, ${failed} failed` + (IS_APP_DRIVER
  ? ' — against the app\'s own driver\n'
  : `\n\nNOTE: this ran on ${DRIVER}.\nRun it once with better-sqlite3 `
    + '(npm i --no-save better-sqlite3 at the repo root) to prove these hold on\n'
    + 'the engine the till actually uses.\n'));
process.exit(failed ? 1 : 0);
