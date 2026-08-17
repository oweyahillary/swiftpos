/**
 * kitchen-exclusions-local.test.mjs — proves the till persists kitchen
 * exclusions and that a local override is final (register A66).
 *
 *   node kitchen-exclusions-local.test.mjs
 *
 * No Electron, no better-sqlite3. Uses node:sqlite (the app's own driver cannot
 * be built on every runner — see the rejection-routing suite for the same
 * choice) and pulls the REAL INSERT statement out of deviceConfig.ts, so the
 * exact write path the app uses is what gets tested. That matters here because
 * the bug this file guards against was invisible to every other gate: the
 * column was simply absent from the INSERT, so check-sql-binds (which only
 * balances placeholders) was green while nothing was written.
 *
 * Two properties under test:
 *   1. PERSISTENCE — saveDeviceConfig actually stores kitchen_exclusions. It did
 *      not: the column was missing from the INSERT column list, the VALUES and
 *      the ON CONFLICT SET, so the cloud baseline synced by syncEngine reached
 *      device_config and vanished, and the till applied no exclusions at all.
 *   2. "LOCAL IS FINAL" — a per-terminal override (kitchen_exclusions_override)
 *      wins over the synced baseline and survives a sync; NULL override means
 *      "follow the cloud" while an empty-but-present override means "this
 *      terminal excludes nothing, deliberately" — two different states.
 *
 * The resolver (escposBridge.kitchenExclusions) lives in TypeScript behind the
 * native driver, so its one rule — override ?? baseline — is copied here and
 * kept in sync by hand, exactly as discount-clamp.test.mjs copies the clamp.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite is a Node >= 22.5 built-in. The Node-20 CI lane (and older local
// runtimes) lack it — skip cleanly there, the same way the tests/ suites that
// need better-sqlite3 do, so the runner does not crash on a runtime mismatch.
// This test runs on the Node 22 lane / locally under Node 22.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('node:sqlite unavailable (needs Node >= 22.5) — skipping. Runs under Node 22.');
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
}

// ── The REAL statement, lifted from the source ──────────────────────────────
const deviceConfigSrc = fs.readFileSync(
  path.join(ROOT, 'apps/desktop/src/main/deviceConfig.ts'), 'utf8');
const insertMatch = deviceConfigSrc.match(
  /INSERT INTO device_config[\s\S]*?updated_at=excluded\.updated_at\s*`/);
if (!insertMatch) {
  console.error('Could not locate the device_config INSERT in deviceConfig.ts — has it moved?');
  process.exit(1);
}
const INSERT = insertMatch[0].replace(/`$/, '');

// The column order the statement writes, parsed from the INSERT itself — so a
// future reorder of the columns cannot desync this test from the app, and a
// column dropped from the list is caught by the asserts below.
const INSERT_COLS = INSERT
  .match(/INSERT INTO device_config\s*\(([^)]*)\)/)[1]
  .split(',').map(s => s.trim())
  .filter(c => c !== 'id');

// ── A fresh singleton device_config, matching localDb.ts columns ────────────
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE device_config(
    id INTEGER PRIMARY KEY,
    deploy_mode TEXT, server_url TEXT, branch_id TEXT, business_type TEXT,
    device_name TEXT, device_id TEXT, device_role TEXT, node_url TEXT, node_secret TEXT,
    terminal_code TEXT, vat_rate REAL, ctl_rate REAL, max_discount_pct REAL,
    receipt_header TEXT, receipt_footer TEXT,
    kitchen_exclusions TEXT, kitchen_exclusions_override TEXT,
    configured INTEGER, created_at TEXT, updated_at TEXT);`);
  return db;
}

// Emulates saveDeviceConfig's merge+write: start from the current row, apply a
// partial patch, bind the columns the real .run() binds. This is the behaviour
// under test, driven through the real SQL.
function saveDeviceConfig(db, patch) {
  const now = new Date().toISOString();
  const current = db.prepare('SELECT * FROM device_config WHERE id=1').get() ?? {};
  const merged = {
    deploy_mode: patch.deploy_mode ?? current.deploy_mode ?? 'cloud',
    server_url: patch.server_url ?? current.server_url ?? 'http://x',
    branch_id: patch.branch_id !== undefined ? patch.branch_id : (current.branch_id ?? null),
    business_type: patch.business_type !== undefined ? patch.business_type : (current.business_type ?? null),
    device_name: patch.device_name !== undefined ? patch.device_name : (current.device_name ?? null),
    device_id: patch.device_id ?? current.device_id ?? 'dev-1',
    device_role: patch.device_role ?? current.device_role ?? 'till',
    node_url: patch.node_url !== undefined ? patch.node_url : (current.node_url ?? null),
    node_secret: patch.node_secret !== undefined ? patch.node_secret : (current.node_secret ?? null),
    terminal_code: patch.terminal_code !== undefined ? patch.terminal_code : (current.terminal_code ?? null),
    vat_rate: patch.vat_rate !== undefined ? patch.vat_rate : (current.vat_rate ?? null),
    ctl_rate: patch.ctl_rate !== undefined ? patch.ctl_rate : (current.ctl_rate ?? null),
    max_discount_pct: patch.max_discount_pct !== undefined ? patch.max_discount_pct : (current.max_discount_pct ?? null),
    receipt_header: patch.receipt_header !== undefined ? patch.receipt_header : (current.receipt_header ?? null),
    receipt_footer: patch.receipt_footer !== undefined ? patch.receipt_footer : (current.receipt_footer ?? null),
    kitchen_exclusions: patch.kitchen_exclusions !== undefined ? patch.kitchen_exclusions : (current.kitchen_exclusions ?? null),
    kitchen_exclusions_override: patch.kitchen_exclusions_override !== undefined ? patch.kitchen_exclusions_override : (current.kitchen_exclusions_override ?? null),
    configured: patch.configured ?? (current.configured === 1) ?? false,
    created_at: current.created_at ?? now,
    updated_at: now,
  };
  const values = INSERT_COLS.map(name =>
    name === 'configured' ? (merged.configured ? 1 : 0)
    : name === 'created_at' ? merged.created_at
    : name === 'updated_at' ? merged.updated_at
    : (merged[name] ?? null));
  db.prepare(INSERT).run(...values);
}

// The resolver rule copied from escposBridge.kitchenExclusions — kept in sync
// by hand. NULL override => follow baseline; present override (even empty) wins.
function parseTerms(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String).filter(Boolean) : []; }
  catch { return []; }
}
function resolve(row) {
  return row.kitchen_exclusions_override != null
    ? { terms: parseTerms(row.kitchen_exclusions_override), source: 'local' }
    : { terms: parseTerms(row.kitchen_exclusions), source: 'cloud' };
}
const read = db => db.prepare('SELECT kitchen_exclusions, kitchen_exclusions_override FROM device_config WHERE id=1').get();

// Sanity: the statement really does name both columns. If a future edit drops
// kitchen_exclusions from the INSERT again, this fails before any DB work — the
// exact regression that shipped once already.
ok('INSERT column list includes kitchen_exclusions',          INSERT_COLS.includes('kitchen_exclusions'));
ok('INSERT column list includes kitchen_exclusions_override', INSERT_COLS.includes('kitchen_exclusions_override'));
ok('INSERT SET clause updates kitchen_exclusions',            /kitchen_exclusions=excluded\.kitchen_exclusions\b/.test(INSERT));

// ── 1. The bug: a synced baseline must actually persist ─────────────────────
{
  const db = freshDb();
  saveDeviceConfig(db, { kitchen_exclusions: '["soda","water"]' });
  const row = read(db);
  ok('cloud baseline persists (the bug fix)',
    row.kitchen_exclusions === '["soda","water"]', JSON.stringify(row.kitchen_exclusions));
  ok('no override yet -> source is cloud', resolve(row).source === 'cloud');
  ok('printer sees the synced baseline',
    JSON.stringify(resolve(row).terms) === JSON.stringify(['soda', 'water']));
}

// ── 2. Local override wins and survives a later sync ────────────────────────
{
  const db = freshDb();
  saveDeviceConfig(db, { kitchen_exclusions: '["soda"]' });          // cloud baseline
  saveDeviceConfig(db, { kitchen_exclusions_override: '["chips"]' }); // local edit
  let row = read(db);
  ok('override stored alongside baseline', row.kitchen_exclusions_override === '["chips"]');
  ok('baseline untouched by the local edit', row.kitchen_exclusions === '["soda"]');
  ok('resolver: local override wins',
    resolve(row).source === 'local' &&
    JSON.stringify(resolve(row).terms) === JSON.stringify(['chips']));

  // A catalogue pull refreshes the baseline; the override must not move.
  saveDeviceConfig(db, { kitchen_exclusions: '["soda","juice"]' });
  row = read(db);
  ok('sync refreshes baseline', row.kitchen_exclusions === '["soda","juice"]');
  ok('sync does NOT overwrite the override ("local is final")',
    row.kitchen_exclusions_override === '["chips"]');
  ok('printer still applies the override after sync',
    JSON.stringify(resolve(row).terms) === JSON.stringify(['chips']));
}

// ── 3. Empty override is not the same as no override ────────────────────────
{
  const db = freshDb();
  saveDeviceConfig(db, { kitchen_exclusions: '["soda"]' });
  saveDeviceConfig(db, { kitchen_exclusions_override: '[]' });  // "exclude nothing, deliberately"
  const row = read(db);
  ok('empty override is a present value, not NULL', row.kitchen_exclusions_override === '[]');
  ok('empty override wins: printer excludes nothing',
    resolve(row).source === 'local' && resolve(row).terms.length === 0,
    JSON.stringify(resolve(row).terms));
}

// ── 4. Clearing the override returns to the cloud baseline ───────────────────
{
  const db = freshDb();
  saveDeviceConfig(db, { kitchen_exclusions: '["soda","water"]' });
  saveDeviceConfig(db, { kitchen_exclusions_override: '["chips"]' });
  saveDeviceConfig(db, { kitchen_exclusions_override: null });  // "Reset to cloud default"
  const row = read(db);
  ok('clear writes NULL, not empty', row.kitchen_exclusions_override === null);
  ok('after clear, source is cloud again', resolve(row).source === 'cloud');
  ok('after clear, printer follows the baseline',
    JSON.stringify(resolve(row).terms) === JSON.stringify(['soda', 'water']));
}

console.log(`\n${fail === 0
  ? `All ${pass} checks passed. Exclusions persist; the local override is final.`
  : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
