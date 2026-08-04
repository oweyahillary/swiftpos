#!/usr/bin/env node
/**
 * Phase 2c — bounded replicas + snapshots. Behavioral: the prune SQL runs
 * against real SQLite with a mixed-age, mixed-owner dataset, and the snapshot
 * uses better-sqlite3's actual backup API into a temp dir with retention.
 *
 * What must hold:
 *   1. Pruning deletes ONLY other devices' rows past the cutoff. Own rows
 *      survive at any age; recent replicas survive; children go with their
 *      orders in the same transaction.
 *   2. Events: settled ones (applied/refused) prune; an UNAPPLIED event is
 *      never pruned at any age — it is a mutation still owed.
 *   3. The node prunes nothing — it is the archive tier.
 *   4. Snapshots are real (restorable), retained newest-N, and both success
 *      and failure are recorded where a person can read them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
const Database = require_('better-sqlite3');
console.log("driver: better-sqlite3 (repo root) — the driver the app uses");

let passed = 0, failed = 0;
const ok = (name, cond, extra='') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const SRC_M  = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/maintenance.ts'), 'utf8');
const SRC_IX = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/index.ts'), 'utf8');
const SRC_DB = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/localDb.ts'), 'utf8');

const DAY = 86_400_000;
const now = new Date('2026-08-04T12:00:00Z');
const iso = (daysAgo) => new Date(now.getTime() - daysAgo * DAY).toISOString();
const CUTOFF = iso(90);

// Mirror of pruneReplicas' SQL (parity pinned in section 0).
function prune(db, own) {
  const deleted = {};
  const tx = () => {
    for (const child of ['order_items', 'payments']) {
      deleted[child] = db.prepare(`DELETE FROM ${child} WHERE order_id IN (
        SELECT id FROM orders WHERE COALESCE(device_id,'') != COALESCE(?,'') AND created_at < ?)`).run(own, CUTOFF).changes;
    }
    for (const t of ['orders','shifts']) {
      deleted[t] = db.prepare(`DELETE FROM ${t} WHERE COALESCE(device_id,'') != COALESCE(?,'') AND created_at < ?`).run(own, CUTOFF).changes;
    }
    deleted.events = db.prepare(`DELETE FROM events WHERE COALESCE(device_id,'') != COALESCE(?,'') AND created_at < ? AND applied != 0`).run(own, CUTOFF).changes;
  };
  db.transaction(tx)();
  return deleted;
}

// ── 0. Parity ────────────────────────────────────────────────────────────────
console.log('\n0. Harness matches maintenance.ts');
{
  ok('prune predicate: other devices only, past cutoff',
     SRC_M.includes(`COALESCE(device_id,'') != COALESCE(?,'') AND created_at < ?`));
  ok('children keyed to expiring orders, same transaction',
     /DELETE FROM \$\{child\} WHERE order_id IN \(/.test(SRC_M) && /db\.transaction\(\(\) => \{[\s\S]{0,1600}\}\)\(\);/.test(SRC_M));
  ok('unapplied events never pruned', SRC_M.includes('AND applied != 0'));
  ok('the node keeps everything', SRC_M.includes('node keeps everything'));
  ok('retention floor of 7 days — a sub-week window is a misconfiguration', /n >= 7/.test(SRC_M));
  ok('snapshot uses the backup API, never fs.copyFile',
     // The comment WARNING against copyFile must not trip this — assert no CALL.
     SRC_M.includes('.backup(dest)') && !/copyFile(?:Sync)?\s*\(/.test(SRC_M));
  ok('failure is recorded, not swallowed', SRC_M.includes("`FAILED — ${err?.message"));
  ok('both jobs scheduled hourly AND once after boot',
     /pruneIfDue\(\);[\s\S]{0,200}snapshotIfDue\(\)/.test(SRC_IX) && /setTimeout\([\s\S]{0,300}90_000\)/.test(SRC_IX));
  ok('maintenance_state table exists in schema', SRC_DB.includes('maintenance_state'));
  {
    const local = Number((SRC_DB.match(/LOCAL_SCHEMA_VERSION = (\d+)/) || [])[1]);
    const req = Number((fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
    ok('schema at least v49 and both sides equal', local >= 49 && local === req, `${local}/${req}`);
  }
}

// ── 1. Prune boundaries ──────────────────────────────────────────────────────
console.log('\n1. Only other devices\' expired rows go; own rows survive any age');
{
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE orders (id TEXT PRIMARY KEY, device_id TEXT, created_at TEXT);
    CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT);
    CREATE TABLE payments (id TEXT PRIMARY KEY, order_id TEXT);
    CREATE TABLE shifts (id TEXT PRIMARY KEY, device_id TEXT, created_at TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, device_id TEXT, created_at TEXT, applied INTEGER DEFAULT 0);
  `);
  const o = db.prepare(`INSERT INTO orders VALUES (?,?,?)`);
  o.run('own-old',  'dev-ME', iso(400));    // own, ancient → SURVIVES
  o.run('own-new',  'dev-ME', iso(1));
  o.run('peer-old', 'dev-T2', iso(120));    // replica, expired → GOES
  o.run('peer-new', 'dev-T2', iso(30));     // replica, recent → survives
  db.prepare(`INSERT INTO order_items VALUES ('i1','peer-old')`).run();
  db.prepare(`INSERT INTO order_items VALUES ('i2','peer-new')`).run();
  db.prepare(`INSERT INTO payments VALUES ('p1','peer-old')`).run();
  db.prepare(`INSERT INTO payments VALUES ('p2','own-old')`).run();
  const sh = db.prepare(`INSERT INTO shifts VALUES (?,?,?)`);
  sh.run('sh-own-old', 'dev-ME', iso(200));
  sh.run('sh-peer-old', 'dev-T2', iso(200));

  const d = prune(db, 'dev-ME');
  const left = (t) => db.prepare(`SELECT id FROM ${t} ORDER BY id`).all().map(r => r.id).join(',');
  ok('expired replica order gone', !left('orders').includes('peer-old'));
  ok('its items and payment went with it, in the same transaction',
     left('order_items') === 'i2' && left('payments') === 'p2');
  ok('own ancient order survives', left('orders').includes('own-old'));
  ok('recent replica survives', left('orders').includes('peer-new'));
  ok('own ancient shift survives; peer expired shift gone',
     left('shifts') === 'sh-own-old');
  ok('counts honest', d.orders === 1 && d.shifts === 1 && d.order_items === 1 && d.payments === 1, JSON.stringify(d));
}

// ── 2. Event prune rules ─────────────────────────────────────────────────────
console.log('\n2. Settled events prune; an unapplied event is owed, at any age');
{
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE orders (id TEXT, device_id TEXT, created_at TEXT);
           CREATE TABLE order_items (id TEXT, order_id TEXT); CREATE TABLE payments (id TEXT, order_id TEXT);
           CREATE TABLE shifts (id TEXT, device_id TEXT, created_at TEXT);
           CREATE TABLE events (id TEXT PRIMARY KEY, device_id TEXT, created_at TEXT, applied INTEGER DEFAULT 0);`);
  const e = db.prepare(`INSERT INTO events VALUES (?,?,?,?)`);
  e.run('ev-applied-old', 'dev-T2', iso(200), 1);
  e.run('ev-refused-old', 'dev-T2', iso(200), -1);
  e.run('ev-waiting-old', 'dev-T2', iso(200), 0);   // still owed → SURVIVES
  e.run('ev-own-old',     'dev-ME', iso(200), 1);   // own → survives
  prune(db, 'dev-ME');
  const left = db.prepare(`SELECT id FROM events ORDER BY id`).all().map(r => r.id).join(',');
  ok('applied and refused pruned; waiting and own survive',
     left === 'ev-own-old,ev-waiting-old', left);
}

// ── 3. A snapshot is real ────────────────────────────────────────────────────
console.log('\n3. Snapshot: consistent, restorable, retained newest-N');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-snap-'));
  const src = path.join(tmp, 'live.db');
  const db = new Database(src);
  db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, total REAL)`);
  db.prepare(`INSERT INTO orders VALUES ('o1', 1490)`).run();

  const dir = path.join(tmp, 'backups');
  fs.mkdirSync(dir);
  const KEEP = 3;
  for (let i = 0; i < 5; i++) {
    const dest = path.join(dir, `swiftpos-2026-08-0${i + 1}T00-00-00-000Z.db`);
    await db.backup(dest);
    const snaps = fs.readdirSync(dir).filter(f => /^swiftpos-.*\.db$/.test(f)).sort().reverse();
    for (const f of snaps.slice(KEEP)) fs.unlinkSync(path.join(dir, f));
  }
  const remaining = fs.readdirSync(dir).sort();
  ok('exactly N snapshots retained', remaining.length === KEEP, remaining.join(','));
  ok('and they are the NEWEST N', remaining[0].includes('08-03') && remaining[2].includes('08-05'));

  const restored = new Database(path.join(dir, remaining[2]), { readonly: true });
  ok('a snapshot restores and reads', restored.prepare(`SELECT total FROM orders WHERE id='o1'`).get().total === 1490);
  restored.close(); db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed — against the app's own driver`);
process.exit(failed ? 1 : 0);
