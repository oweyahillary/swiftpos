// A404 — when ZapTill clears a client's test data on the cloud, the till clears the same period from its own database.
// Owner, 2026-10-05: the cloud clear left the tills holding the test sales — and a test trading day left open kept a
// till locked ("Trading day 2026-10-03 was never closed on this till").
//
// Drives the REAL compiled dist/main (localDb, testDataClear.applyTestDataClear, syncEngine.runTestDataClears,
// dayService.checkDayGate) on a REAL SQLite file, with a stand-in cloud.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/test-data-clear.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - the period's upper bound dropped (created_at >= from only)   → "the real sale after the period stays" fails
//   - a shift sold on after the period removed                      → "a drawer used after the period stays" fails
//   - the last-applied mark not kept                                → "each clear is applied once" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a404-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const D = require(path.join(dist, 'dayService.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B Foods', '2026-10-01T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Left Till' });

// Fill a row with what the table demands (NOT NULL without a default), then the given values.
const insert = (table, row) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const full = { ...row };
  for (const c of cols) if (c.notnull && c.dflt_value === null && !(c.name in full) && !c.pk) full[c.name] = /_at$/.test(c.name) ? '2026-10-01T00:00:00Z' : /float|amount|total|price|qty|quantity|subtotal|vat/.test(c.name) ? 0 : 'x';
  const k = Object.keys(full);
  db.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => full[x]));
};
const T = (d) => `2026-10-0${d}T10:00:00Z`;
// The test period: 1 → 3 October. Day 3's trading day was left open (the lock in the screenshot).
insert('business_days', { id: 'day-1', business_id: 'biz-1', branch_id: 'br-1', device_id: 'dev-T1', business_date: '2026-10-01', opened_at: T(1), status: 'closed', created_at: T(1), sync_status: 'synced' });
insert('business_days', { id: 'day-3', business_id: 'biz-1', branch_id: 'br-1', device_id: 'dev-T1', business_date: '2026-10-03', opened_at: T(3), status: 'open', created_at: T(3), sync_status: 'synced' });
insert('shifts', { id: 'sh-test', business_id: 'biz-1', branch_id: 'br-1', cashier_id: 'u-c', opened_at: T(1), status: 'closed', opening_float: 0, created_at: T(1), sync_status: 'synced', device_id: 'dev-T1', business_day_id: 'day-1' });
insert('shifts', { id: 'sh-open', business_id: 'biz-1', branch_id: 'br-1', cashier_id: 'u-c', opened_at: T(3), status: 'open', opening_float: 0, created_at: T(3), sync_status: 'synced', device_id: 'dev-T1', business_day_id: 'day-3' });
// a drawer opened in the period but sold on after it — real, stays
insert('shifts', { id: 'sh-used', business_id: 'biz-1', branch_id: 'br-1', cashier_id: 'u-c', opened_at: T(3), status: 'open', opening_float: 0, created_at: T(3), sync_status: 'synced', device_id: 'dev-T2' });
const sale = (id, at, shift, sync = 'synced') => {
  insert('orders', { id, business_id: 'biz-1', branch_id: 'br-1', order_number: id, status: 'completed', created_at: at, device_id: 'dev-T1', sync_status: sync, shift_id: shift, total: 500 });
  insert('order_items', { id: `${id}-i`, order_id: id, product_id: 'p1', quantity: 1, unit_price: 500 });
  insert('payments', { id: `${id}-p`, order_id: id, method: 'cash', amount: 500, status: 'completed', created_at: at, sync_status: sync });
};
sale('o-test-1', T(1), 'sh-test');
sale('o-test-2', T(2), 'sh-test', 'pending');   // a test sale never sent — must not reach the cloud after the clear
sale('o-real', '2026-10-05T09:00:00Z', 'sh-used');
insert('float_transactions', { id: 'f-test', shift_id: 'sh-test', branch_id: 'br-1', type: 'float_out', amount: 100, created_at: T(1), sync_status: 'synced' });
insert('expenses', { id: 'e-test', business_id: 'biz-1', branch_id: 'br-1', description: 'test', amount: 50, shift_id: 'sh-test', created_at: T(2), sync_status: 'synced' });
insert('expenses', { id: 'e-real', business_id: 'biz-1', branch_id: 'br-1', description: 'real', amount: 70, created_at: '2026-10-05T08:00:00Z', sync_status: 'synced' });

ok('before: the till is locked by the test day left open', D.checkDayGate().needsManager === true, JSON.stringify(D.checkDayGate()));

const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  const rows = String(url).includes('after=') ? [] : [{ id: 'purge-1', from_at: '2026-10-01T00:00:00Z', to_at: '2026-10-04T23:59:00Z', created_at: '2026-10-05T07:00:00Z' }];
  return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
};
E.configureSyncEngine('http://cloud', 'device-token');
const n = await E.runTestDataClears();
const count = (t, w = '1=1') => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w}`).get().n;

ok('the clear is applied', n === 1 && asked[0].endsWith('/api/pos/test-data-clears'), asked.join(' '));
ok('the period\'s sales are gone — items, payments too — sent or not', count('orders', "id LIKE 'o-test%'") === 0 && count('order_items', "order_id LIKE 'o-test%'") === 0 && count('payments', "order_id LIKE 'o-test%'") === 0);
ok('the real sale after the period stays', count('orders', "id = 'o-real'") === 1 && count('payments', "order_id = 'o-real'") === 1);
ok('the test shifts are gone; a drawer used after the period stays', count('shifts', "id IN ('sh-test','sh-open')") === 0 && count('shifts', "id = 'sh-used'") === 1);
ok('the test trading days are gone', count('business_days') === 0);
ok('cash out and expenses of the period go; a later expense stays', count('float_transactions') === 0 && count('expenses', "id = 'e-test'") === 0 && count('expenses', "id = 'e-real'") === 1);
ok('the till is no longer locked by the test day', D.checkDayGate().needsManager !== true, JSON.stringify(D.checkDayGate()));
ok('each clear is applied once (the next ask says what was seen)', (await E.runTestDataClears()) === 0 && asked[1]?.includes('after=2026-10-05T07%3A00%3A00Z'), asked.join(' '));

const cloud = fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'routes', 'pos.ts'), 'utf8');
ok('the cloud lists this business\'s clears, after what the till has seen, oldest first',
  /from\('test_data_purges'\)\.select\('id, from_at, to_at, created_at'\)\s*\.eq\('business_id', req\.businessId\)\.gt\('created_at', after\)\.order\('created_at', \{ ascending: true \}\)/.test(cloud));
ok('it runs on every full sync', /try \{ await runTestDataClears\(\); \} catch/.test(fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
