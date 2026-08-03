import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openSqlite } from './lib/sqlite-open.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Locate the database ──────────────────────────────────────────────────────
function defaultDbPaths() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': return [path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'SwiftPOS', 'swiftpos.db')];
    case 'darwin': return [path.join(home, 'Library', 'Application Support', 'SwiftPOS', 'swiftpos.db')];
    default: return [path.join(home, '.config', 'SwiftPOS', 'swiftpos.db')];
  }
}

const dbPath = process.argv[2] ?? defaultDbPaths().find(p => fs.existsSync(p));
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('Could not find swiftpos.db.');
  console.error('Tried:', defaultDbPaths().join(', '));
  console.error('Pass the path explicitly: node scripts/verify-local-schema.mjs "<path>"');
  process.exit(2);
}

let db, driver, isAppDriver;
try {
  ({ db, driver, isAppDriver } = openSqlite(ROOT, dbPath, { readonly: true }));
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(2);
}

const get = sql => db.prepare(sql).get();
const all = sql => db.prepare(sql).all();

console.log(`\ndatabase  ${dbPath}`);
console.log(`driver    ${driver}`);
if (!isAppDriver) {
  console.log('          ⚠ the app uses better-sqlite3. This reads the same file with a');
  console.log('            different engine — fine for reading schema and counts, but it is');
  console.log('            not proof the app itself can open the database.');
}
console.log('');

let bad = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok    ${label}${detail ? `  (${detail})` : ''}`);
  else { bad++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

const tables = new Set(all(`SELECT name FROM sqlite_master WHERE type='table'`).map(r => r.name));
const columns = t => new Set(all(`PRAGMA table_info(${t})`).map(r => r.name));

// ── 1. Did the migration run at all ──────────────────────────────────────────
console.log('1. Schema generation');
const version = get(`SELECT version, applied_at FROM schema_version WHERE id=1`);
check('schema_version is 45', Number(version?.version) === 45,
      `found ${version?.version ?? 'nothing'}, applied ${version?.applied_at ?? '?'}`);

// ── 2. Are the new structures there ──────────────────────────────────────────
console.log('\n2. New tables and columns');
for (const t of ['node_queue', 'peer_cursors', 'device_seq', 'outbox_cursors']) {
  check(`table ${t}`, tables.has(t));
}
for (const t of ['orders', 'shifts', 'expenses', 'float_transactions', 'business_days']) {
  check(`${t}.seq`, columns(t).has('seq'));
}
check('orders.pump_id', columns('orders').has('pump_id'));
check('expenses.device_id', columns('expenses').has('device_id'));
check('float_transactions.device_id', columns('float_transactions').has('device_id'));

// ── 3. Did the one-time data fixes take ──────────────────────────────────────
console.log('\n3. Backfills');
const ownDevice = get(`SELECT device_id FROM device_config WHERE id=1`)?.device_id ?? null;
console.log(`  this till's device_id: ${ownDevice ?? '(none assigned)'}`);

const stranded = get(`SELECT COUNT(*) n FROM orders WHERE sync_status='node_ack'`).n;
// Not fatal on its own if the migration plainly did not run — section 1 already
// said so, and repeating it as five more failures buries the one that matters.
check('no orders left in node_ack', Number(stranded) === 0, `${stranded} found`);

if (ownDevice) {
  for (const t of ['expenses', 'float_transactions']) {
    // Guarded: on a database where the migration did NOT run, the column does
    // not exist and querying it throws. The point of this script is to report
    // that case clearly, not to crash in the middle of it.
    if (!columns(t).has('device_id')) {
      check(`${t} rows are all attributed`, false, 'device_id column is missing — the migration did not run');
      continue;
    }
    const n = get(`SELECT COUNT(*) n FROM ${t} WHERE device_id IS NULL`).n;
    // These would be collected by nothing: "mine" is
    // COALESCE(device_id,'') = COALESCE(own,''), so a NULL row matches no till
    // that has a device_id, and it silently never leaves this machine.
    check(`${t} rows are all attributed`, Number(n) === 0, `${n} unattributed`);
  }
} else {
  console.log('  skipped attribution check — this till has no device_id yet (not set up)');
}

// ── 4. What is waiting to go where ───────────────────────────────────────────
console.log('\n4. Current state');
for (const t of ['orders', 'shifts', 'expenses', 'float_transactions', 'business_days']) {
  if (!columns(t).has('seq')) {
    const n = get(`SELECT COUNT(*) n FROM ${t}`).n;
    console.log(`  ${t.padEnd(20)} ${String(n).padStart(6)} rows · no seq column — not migrated`);
    continue;
  }
  const r = get(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN sync_status='pending' THEN 1 ELSE 0 END) pending,
           SUM(CASE WHEN sync_status='peer'    THEN 1 ELSE 0 END) peer,
           SUM(CASE WHEN seq IS NULL           THEN 1 ELSE 0 END) unsequenced
      FROM ${t}`);
  console.log(`  ${t.padEnd(20)} ${String(r.total).padStart(6)} rows · ` +
              `${String(r.pending ?? 0).padStart(4)} pending to cloud · ` +
              `${String(r.peer ?? 0).padStart(4)} ingested from peers · ` +
              `${String(r.unsequenced ?? 0).padStart(4)} unsequenced`);
}

const nq = tables.has('node_queue')
  ? get(`SELECT COUNT(*) total,
                SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) pending,
                SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) failed,
                SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) delivered
           FROM node_queue`)
  : null;
if (nq) {
  console.log(`\n  node_queue: ${nq.total} total · ${nq.pending ?? 0} pending · ` +
              `${nq.delivered ?? 0} delivered · ${nq.failed ?? 0} failed`);
  if (Number(nq.failed) > 0) {
    console.log('  failures the branch server reported:');
    for (const r of all(`SELECT table_name, row_id, last_error FROM node_queue
                          WHERE status='failed' LIMIT 5`)) {
      console.log(`    ${r.table_name}/${r.row_id}: ${r.last_error}`);
    }
  }
}

const peers = tables.has('peer_cursors') ? all(`SELECT * FROM peer_cursors`) : [];
if (peers.length) {
  console.log('\n  peers this machine has ingested from:');
  for (const p of peers) {
    console.log(`    ${p.device_id}  ${p.table_name.padEnd(20)} up to seq ${p.last_seq}  (${p.updated_at})`);
  }
} else {
  console.log('\n  no peer rows ingested yet — expected unless this machine is the node');
}

console.log(bad === 0
  ? '\nOK — the migration ran and everything it should have changed, changed.\n'
  : `\n${bad} check(s) failed. Do not roll this build out further until they are understood.\n`);
process.exit(bad === 0 ? 0 : 1);
