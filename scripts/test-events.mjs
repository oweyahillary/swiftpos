#!/usr/bin/env node
/**
 * Phase 2b — mutations as events. Behavioral against real SQLite for the
 * applier (the part that mutates cash-bearing replicas), source-pinned for
 * emission wiring.
 *
 * What must hold:
 *   1. The whitelist is the security boundary: an event's payload can NEVER
 *      write device_id, seq, id, or sync_status into a replica — those are
 *      the columns that make replication safe.
 *   2. Applying is idempotent — a second sweep changes nothing.
 *   3. Origin-only: an event can only mutate a row its origin owns. A target
 *      owned by someone else = refused (-1), row untouched. A target not here
 *      yet = waiting (0), applied by a later sweep when the row arrives —
 *      that repetition IS the answer to cross-table seq ordering.
 *   4. Every mutation site emits: counted close, forced close, day close,
 *      void — and local emissions start applied=1 (the caller already mutated
 *      its own row).
 *   5. events is the sixth replicated table: it rides outbox, ingest, and
 *      distribution untouched; applied and sync_status stay home.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
let Database, driver;
try { Database = require_('better-sqlite3'); driver = "better-sqlite3 (repo root) — the driver the app uses"; }
catch {
  const { DatabaseSync } = await import('node:sqlite');
  Database = class { constructor(p){ const d=new DatabaseSync(p); this.prepare=s=>{const st=d.prepare(s);return{get:(...a)=>st.get(...a),all:(...a)=>st.all(...a),run:(...a)=>{const r=st.run(...a);return{changes:Number(r.changes)}}}}; this.exec=s=>d.exec(s);} };
  driver = 'node:sqlite (fallback — run once against better-sqlite3)';
}
console.log(`driver: ${driver}`);

let passed = 0, failed = 0;
const ok = (name, cond, extra='') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const SRC_NI = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/nodeIngest.ts'), 'utf8');
const SRC_SS = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/shiftService.ts'), 'utf8');
const SRC_DS = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/dayService.ts'), 'utf8');
const SRC_IH = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8');
const SRC_NS = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/nodeServer.ts'), 'utf8');
const SRC_DB = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/localDb.ts'), 'utf8');

// Extract the module's whitelist so the harness applies with the SAME rules.
const wl = {};
{
  const block = SRC_NI.slice(SRC_NI.indexOf('const EVENT_WHITELIST'), SRC_NI.indexOf('};', SRC_NI.indexOf('const EVENT_WHITELIST')));
  for (const m of block.matchAll(/(\w+): \{\s*table: '(\w+)',\s*columns: \[([\s\S]*?)\]/g)) {
    wl[m[1]] = { table: m[2], columns: [...m[3].matchAll(/'([\w]+)'/g)].map(x => x[1]) };
  }
}

// Mirror of applyPendingEvents (parity pinned in section 0).
function sweep(db) {
  const out = { applied: 0, waiting: 0, refused: 0 };
  const pending = db.prepare(`SELECT id, device_id, kind, target_table, target_id, payload FROM events WHERE applied = 0`).all();
  for (const ev of pending) {
    const spec = wl[ev.kind];
    if (!spec || spec.table !== ev.target_table) { out.waiting++; continue; }
    let payload; try { payload = JSON.parse(ev.payload) ?? {}; } catch { db.prepare(`UPDATE events SET applied=-1 WHERE id=?`).run(ev.id); out.refused++; continue; }
    const cols = spec.columns.filter(c => c in payload);
    if (!cols.length) { db.prepare(`UPDATE events SET applied=1 WHERE id=?`).run(ev.id); out.applied++; continue; }
    const r = db.prepare(`UPDATE ${spec.table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND COALESCE(device_id,'') = COALESCE(?,'')`)
      .run(...cols.map(c => payload[c] ?? null), ev.target_id, ev.device_id);
    if (r.changes > 0) { db.prepare(`UPDATE events SET applied=1 WHERE id=?`).run(ev.id); out.applied++; continue; }
    const holder = db.prepare(`SELECT device_id FROM ${spec.table} WHERE id = ?`).get(ev.target_id);
    if (!holder) { out.waiting++; continue; }
    db.prepare(`UPDATE events SET applied=-1 WHERE id=?`).run(ev.id); out.refused++;
  }
  return out;
}

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE shifts (id TEXT PRIMARY KEY, status TEXT, closed_at TEXT,
      closing_float REAL, expected_cash REAL, cash_variance REAL, notes TEXT,
      close_method TEXT, closed_by TEXT, device_id TEXT, seq INTEGER, sync_status TEXT DEFAULT 'pending');
    CREATE TABLE events (id TEXT PRIMARY KEY, business_id TEXT, branch_id TEXT,
      device_id TEXT, seq INTEGER, kind TEXT, target_table TEXT, target_id TEXT,
      payload TEXT, created_at TEXT, applied INTEGER DEFAULT 0, sync_status TEXT DEFAULT 'pending');
  `);
  return db;
}
const addEvent = (db, id, dev, kind, table, target, payload) =>
  db.prepare(`INSERT INTO events (id, device_id, kind, target_table, target_id, payload, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, dev, kind, table, target, JSON.stringify(payload), new Date().toISOString());

// ── 0. Parity ────────────────────────────────────────────────────────────────
console.log('\n0. Harness matches nodeIngest.ts');
{
  ok('three event kinds with their tables',
     wl.shift_closed?.table === 'shifts' && wl.day_closed?.table === 'business_days' && wl.order_voided?.table === 'orders');
  ok('no whitelist names device_id, seq, id, or sync_status',
     Object.values(wl).every(s => !s.columns.some(c => ['device_id','seq','id','sync_status'].includes(c))));
  ok('events is a replicated table', /REPLICATED_TABLES = \[[\s\S]{0,200}'events'/.test(SRC_NI));
  ok("replicated event columns exclude applied and sync_status",
     /events: \[[\s\S]{0,300}\]/.test(SRC_NI)
     && !/events: \[[^\]]*'applied'/.test(SRC_NI) && !/events: \[[^\]]*'sync_status'/.test(SRC_NI));
  ok('origin-only clause in the applier',
     SRC_NI.includes(`WHERE id = ? AND COALESCE(device_id,'') = COALESCE(?,'')`));
  ok('sweep runs after node ingest AND after distribution pull',
     /applyPeerRows\(table, peerDeviceId, rows\);\s*\}\s*[\s\S]{0,400}applyPendingEvents\(\)/.test(SRC_NS)
     && /applyDistribution[\s\S]{0,800}applyPendingEvents\(\)/.test(SRC_NI));
  ok('local schema has the events table + unapplied index',
     SRC_DB.includes('CREATE TABLE IF NOT EXISTS events') && SRC_DB.includes('idx_events_unapplied'));
  {
    const local = Number((SRC_DB.match(/LOCAL_SCHEMA_VERSION = (\d+)/) || [])[1]);
    const req = Number((fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
    ok('schema at least v48 and both sides equal', local >= 48 && local === req, `${local}/${req}`);
  }
}

// ── 1. The whitelist is the boundary ─────────────────────────────────────────
console.log('\n1. An event cannot smuggle protected columns into a replica');
{
  const db = freshDb();
  db.prepare(`INSERT INTO shifts (id, status, device_id, seq, sync_status) VALUES ('sh1','open','dev-T2', 5, 'peer')`).run();
  addEvent(db, 'ev1', 'dev-T2', 'shift_closed', 'shifts', 'sh1', {
    status: 'closed', closed_at: '2026-08-04T20:00:00Z', closing_float: 4500,
    device_id: 'dev-EVIL', seq: 999, id: 'sh-EVIL', sync_status: 'pending',   // all must be dropped
  });
  const r = sweep(db);
  const row = db.prepare(`SELECT * FROM shifts WHERE id='sh1'`).get();
  ok('event applied', r.applied === 1);
  ok('whitelisted columns landed', row.status === 'closed' && row.closing_float === 4500);
  ok('device_id untouched', row.device_id === 'dev-T2');
  ok('seq untouched', row.seq === 5);
  ok("sync_status untouched — still 'peer', invisible to every push path", row.sync_status === 'peer');
  ok('id untouched', row.id === 'sh1');
}

// ── 2. Idempotent ────────────────────────────────────────────────────────────
console.log('\n2. A second sweep changes nothing');
{
  const db = freshDb();
  db.prepare(`INSERT INTO shifts (id, status, device_id) VALUES ('sh1','open','dev-T2')`).run();
  addEvent(db, 'ev1', 'dev-T2', 'shift_closed', 'shifts', 'sh1', { status: 'closed', cash_variance: -50 });
  sweep(db);
  const first = db.prepare(`SELECT status, cash_variance FROM shifts WHERE id='sh1'`).get();
  const again = sweep(db);
  const second = db.prepare(`SELECT status, cash_variance FROM shifts WHERE id='sh1'`).get();
  ok('nothing pending on the second pass', again.applied === 0 && again.waiting === 0 && again.refused === 0);
  ok('row identical', JSON.stringify(first) === JSON.stringify(second));
}

// ── 3. Origin-only, and out-of-order arrival ─────────────────────────────────
console.log('\n3. Origin-only; an early event waits for its row');
{
  const db = freshDb();
  db.prepare(`INSERT INTO shifts (id, status, device_id) VALUES ('sh-T3','open','dev-T3')`).run();
  // T2 emits an event about T3's row — forged or misattributed either way.
  addEvent(db, 'ev-forged', 'dev-T2', 'shift_closed', 'shifts', 'sh-T3', { status: 'closed' });
  const r1 = sweep(db);
  ok('refused, not applied', r1.refused === 1 && r1.applied === 0);
  ok("marked -1, never retried",
     db.prepare(`SELECT applied FROM events WHERE id='ev-forged'`).get().applied === -1);
  ok("T3's drawer untouched", db.prepare(`SELECT status FROM shifts WHERE id='sh-T3'`).get().status === 'open');

  // The event beats its row across the LAN (independent seq streams).
  addEvent(db, 'ev-early', 'dev-T4', 'shift_closed', 'shifts', 'sh-T4', { status: 'closed', closed_at: 'x' });
  const r2 = sweep(db);
  ok('early event WAITS (0), is not refused', r2.waiting === 1 && r2.refused === 0
     && db.prepare(`SELECT applied FROM events WHERE id='ev-early'`).get().applied === 0);
  db.prepare(`INSERT INTO shifts (id, status, device_id) VALUES ('sh-T4','open','dev-T4')`).run();
  const r3 = sweep(db);
  ok('a later sweep applies it once the row arrives', r3.applied === 1
     && db.prepare(`SELECT status FROM shifts WHERE id='sh-T4'`).get().status === 'closed');

  // A kind this build does not know: a newer till emitted it. Wait, never guess.
  addEvent(db, 'ev-future', 'dev-T5', 'order_refunded', 'orders', 'o1', { status: 'refunded' });
  const r4 = sweep(db);
  ok('unknown kinds wait for an upgrade, not guessed at', r4.waiting === 1
     && db.prepare(`SELECT applied FROM events WHERE id='ev-future'`).get().applied === 0);
}

// ── 4. Emission wiring ───────────────────────────────────────────────────────
console.log('\n4. Every mutation site emits, and local emissions start applied=1');
{
  ok('counted shift close emits', /close_method: 'counted',\s*closed_by/.test(SRC_SS)
     && /emitEvent\('shift_closed', shift\.id/.test(SRC_SS));
  ok('forced shift close emits closed_unreconciled',
     /emitEvent\('shift_closed', shift\.id, \{\s*status: 'closed_unreconciled'/.test(SRC_SS));
  ok('day close emits', /emitEvent\('day_closed', day\.id/.test(SRC_DS));
  ok('void emits and finally writes voided_at',
     /emitEvent\('order_voided', String\(orderId\)/.test(SRC_IH) && SRC_IH.includes("status='voided', voided_at=?"));
  ok('local emissions insert applied=1 (own row already mutated by the caller)',
     /INSERT INTO events \(id, business_id[\s\S]{0,200}applied\)\s*VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, 1\)/.test(SRC_NI));
}

console.log(`\n${passed} passed, ${failed} failed${driver.startsWith('better') ? " — against the app's own driver" : ''}`);
process.exit(failed ? 1 : 0);
