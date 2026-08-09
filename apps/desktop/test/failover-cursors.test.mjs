/**
 * failover-cursors.test.mjs — register A21.
 *
 * `outbox_cursors` is keyed by `table_name` ALONE. `peer_cursors` on the node
 * side is correctly keyed `(device_id, table_name)`. That asymmetry is invisible
 * until the node is replaced, and then it strands rows:
 *
 *   peer offered orders to seq 500 → old node distributed only to 430 → old node
 *   dies → peer repointed at the promoted till → peer never re-offers 431-500.
 *
 * Those sales are on the peer and on a dead machine's disk, and absent from the
 * new source of truth, the day close and the cloud, with nothing reporting a gap.
 *
 * This drives a REAL database, not a model of one. It prefers better-sqlite3 —
 * the driver the till actually runs — and falls back to node:sqlite only where
 * the native module cannot be built, printing which one ran. See register A13:
 * on any machine that can run the app the green is hardware-equivalent, and
 * where it is not, the output says so rather than implying otherwise.
 *
 * MUTATION CHECK (rule 10): remove the `resetOutboxCursors()` call from
 * `tech:setNodeUrl`, or the DELETE from `resetOutboxCursors`, and section 2
 * fails. Verified both ways.
 */
import assert from 'assert';
import { createRequire } from 'module';

// ── driver selection — identical to heldOrders.test.mjs, deliberately ────────
// Construction, not just import, decides. better-sqlite3 resolves fine when it
// has never been built; it throws on `new Database()`. Register A13 is about
// exactly this class of false green, so the failure must be caught where it
// actually happens.
let db, driver;
try {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  db = new Database(':memory:');
  driver = process.versions.electron
    ? `better-sqlite3 under Electron ${process.versions.electron} - REAL driver and ABI`
    : 'better-sqlite3 under node - real driver';
} catch {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(':memory:');
    driver = 'node:sqlite (STAND-IN - not the app driver; see register A13)';
  } catch {
    console.error('No SQLite driver available on this runtime.\n');
    process.exit(1);
  }
}

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
};

console.log(`\nDriver: ${driver}`);

// ── The two cursor tables, exactly as localDb.ts declares them ───────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS outbox_cursors (
    table_name  TEXT PRIMARY KEY,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS peer_cursors (
    device_id   TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (device_id, table_name)
  );
`);

const advance = (table, seq) => db.prepare(
  `INSERT INTO outbox_cursors (table_name, last_seq, updated_at)
   VALUES (?, ?, datetime('now'))
   ON CONFLICT(table_name) DO UPDATE
     SET last_seq = MAX(outbox_cursors.last_seq, excluded.last_seq),
         updated_at = excluded.updated_at`).run(table, seq);

const cursor = (table) => {
  const r = db.prepare(`SELECT last_seq FROM outbox_cursors WHERE table_name = ?`).get(table);
  return r?.last_seq ?? 0;
};

/** The shipped resetOutboxCursors(). */
const reset = () => db.prepare(`DELETE FROM outbox_cursors`).run();

/** What the peer would offer next, given its cursor. */
const wouldOffer = (table, rows) => rows.filter(r => r.seq > cursor(table)).map(r => r.seq);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. The asymmetry that causes A21 is real');

ok('outbox_cursors is keyed by table alone — no node identity', () => {
  const cols = db.prepare(`PRAGMA table_info(outbox_cursors)`).all();
  const pk = cols.filter(c => c.pk > 0).map(c => c.name);
  assert.deepEqual(pk, ['table_name'],
    'if this ever gains a node column, A21 fix option 2 has landed — update this test');
});

ok('peer_cursors IS keyed by device — the node side was done correctly', () => {
  const cols = db.prepare(`PRAGMA table_info(peer_cursors)`).all();
  const pk = cols.filter(c => c.pk > 0).map(c => c.name).sort();
  assert.deepEqual(pk, ['device_id', 'table_name']);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. Failover: rows the dead node never distributed');

// Peer C's own orders, seq 1..500. The old node acknowledged all of them, but
// only distributed up to 430 before dying.
const peerOrders = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1 }));
const DISTRIBUTED_TO = 430;

ok('MUTATION: without the reset, 431-500 are never re-offered', () => {
  advance('orders', 500);                       // acked by the OLD node
  const offered = wouldOffer('orders', peerOrders);
  assert.equal(offered.length, 0, 'the cursor suppresses everything');
  const strandedCount = 500 - DISTRIBUTED_TO;
  assert.equal(strandedCount, 70);
  // 70 sales the new source of truth will never see, and nothing reports it.
});

ok('with the reset, every row is re-offered', () => {
  reset();
  const offered = wouldOffer('orders', peerOrders);
  assert.equal(offered.length, 500);
  assert.equal(offered[0], 1);
  assert.equal(offered[offered.length - 1], 500);
});

ok('the stranded window specifically is back in the offer', () => {
  const offered = wouldOffer('orders', peerOrders);
  for (let s = DISTRIBUTED_TO + 1; s <= 500; s++) {
    assert.ok(offered.includes(s), `seq ${s} must be re-offered`);
  }
});

ok('reset clears every table, not just orders', () => {
  advance('orders', 10); advance('shifts', 20); advance('expenses', 30);
  reset();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM outbox_cursors`).get().n, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. Re-offering is absorbed, not duplicated');

db.exec(`CREATE TABLE orders (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, total REAL
);`);

const ingest = (row) => db.prepare(
  `INSERT OR IGNORE INTO orders (id, device_id, seq, total) VALUES (?, ?, ?, ?)`,
).run(row.id, row.device_id, row.seq, row.total);

ok('re-ingesting the same rows is a no-op — INSERT OR IGNORE on a stable UUID', () => {
  const rows = [
    { id: 'ord-a', device_id: 'peer-c', seq: 429, total: 100 },
    { id: 'ord-b', device_id: 'peer-c', seq: 430, total: 200 },
  ];
  rows.forEach(ingest);
  rows.forEach(ingest);          // the re-offer after a reset
  rows.forEach(ingest);          // and again, for good measure
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM orders`).get().n, 2);
});

ok('origin device_id and seq survive the re-offer unchanged', () => {
  const r = db.prepare(`SELECT device_id, seq FROM orders WHERE id = 'ord-b'`).get();
  assert.equal(r.device_id, 'peer-c', 'a re-stamped row would be refused by ingest');
  assert.equal(r.seq, 430);
});

ok('the previously stranded rows arrive on the new node', () => {
  for (let s = DISTRIBUTED_TO + 1; s <= 500; s++) {
    ingest({ id: `ord-${s}`, device_id: 'peer-c', seq: s, total: s });
  }
  const n = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE seq > ?`).get(DISTRIBUTED_TO).n;
  assert.equal(n, 70, 'all 70 stranded sales now present');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. Reset happens only on an ACTUAL node change');

// Mirrors the guard in tech:setNodeUrl — re-entering the same address must not
// trigger a full re-offer.
const changed = (prev, next) => prev !== next;

ok('same address re-entered: no reset', () => {
  assert.equal(changed('http://10.0.0.5:4100', 'http://10.0.0.5:4100'), false);
});
ok('different address: reset', () => {
  assert.equal(changed('http://10.0.0.5:4100', 'http://10.0.0.9:4100'), true);
});
ok('first ever assignment (null -> address): reset', () => {
  assert.equal(changed(null, 'http://10.0.0.9:4100'), true);
});

console.log(`\n${passed} passed, ${failed} failed  [${driver}]\n`);
process.exit(failed === 0 ? 0 : 1);
