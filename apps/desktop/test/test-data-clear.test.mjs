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
//   A482 (the whole menu):
//   - `if (c.menu === true)` dropped (menu cleared on every clear)  → "a clear without the menu leaves the till's menu" fails
//   - dropPurgedMenu not applied in the pull                        → "the deleted menu does not come back" fails
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
// A482: the till's menu — every local table that holds it
insert('categories', { id: 'c1', name: 'Drinks' });
insert('products', { id: 'p1', category_id: 'c1', name: 'Coke', base_price: 120, has_variants: 1, has_modifiers: 1 });
insert('products', { id: 'p2', category_id: 'c1', name: 'Meal deal', base_price: 500 });
insert('variant_groups', { id: 'vg1', product_id: 'p1', name: 'Size' });
insert('variant_options', { id: 'vo1', variant_group_id: 'vg1', name: 'Large' });
insert('modifier_groups', { id: 'mg1', product_id: 'p1', name: 'Ice' });
insert('modifier_options', { id: 'mo1', modifier_group_id: 'mg1', name: 'No ice' });
insert('combo_items', { combo_id: 'p2', product_id: 'p1', name: 'Coke' });
insert('offers', { id: 'of1', data: '{}' });
insert('stock_levels', { product_id: 'p1', branch_id: 'br-1', quantity: 10 });
insert('local_price_edits', { product_id: 'p1', price: 110, updated_at: T(1) });
insert('print_stations', { id: 'st1', name: 'Bar' });
insert('category_stations', { category_id: 'c1', station_id: 'st1' });
insert('local_changes', { id: 'lc-prod', entity: 'product', op: 'update', entity_id: 'p1', data: '{}', made_at: T(1), updated_at: T(1), state: 'pending' });
insert('local_changes', { id: 'lc-staff', entity: 'staff', op: 'update', entity_id: 'u-c', data: '{}', made_at: T(1), updated_at: T(1), state: 'pending' });
const MENU = ['products', 'categories', 'variant_groups', 'variant_options', 'modifier_groups', 'modifier_options', 'combo_items', 'offers', 'stock_levels', 'local_price_edits', 'category_stations'];

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
ok('A482: a clear without the menu leaves the till\'s menu as it was', MENU.every((t) => count(t) > 0), MENU.map((t) => `${t}=${count(t)}`).join(' '));

// ── A482: a clear that deleted the whole menu on the cloud ──
// The cloud now lists one more clear, with menu: true. Its pull still offers the old Coke — as a branch server that has
// not applied the clear yet would — and a product added on the web since.
const asked2 = [];
globalThis.fetch = async (url) => {
  const u = String(url); asked2.push(u);
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('/api/pos/test-data-clears')) return json(u.includes('after=2026-10-07') ? [] : [{ id: 'purge-2', from_at: '2026-10-06T00:00:00Z', to_at: '2026-10-06T01:00:00Z', created_at: '2026-10-07T07:00:00Z', menu: true }]);
  if (u.includes('/api/pos/init')) return json({ branchId: 'br-1', products: [
    { id: 'p1', category_id: 'c1', name: 'Coke (old)', description: null, image_url: null, base_price: 120, has_variants: false, has_modifiers: false, track_stock: true, status: 'active' },
    { id: 'p-new', category_id: null, name: 'Chapati', description: null, image_url: null, base_price: 30, has_variants: false, has_modifiers: false, track_stock: false, status: 'active' }],
    categories: [{ id: 'c1', name: 'Drinks (old)', color: null, icon: null, sort_order: 0, status: 'active' }], comboItems: { p2: [{ product_id: 'p1', name: 'Coke', quantity: 1 }] }, offers: [] });
  if (u.includes('/api/inventory')) return json([{ id: 's1', product_id: 'p1', branch_id: 'br-1', quantity: 10 }]);
  if (u.includes('/api/stations')) return json({ error: 'not here' }, 404);
  return json([]);
};
const n2 = await E.runTestDataClears();
ok('A482: the menu clear is applied', n2 === 1, String(n2));
ok('A482: the till\'s whole menu is gone — products, categories, variants, add-ons, combos, offers, stock, prices, routing',
  ['categories', 'variant_groups', 'variant_options', 'modifier_groups', 'modifier_options', 'combo_items', 'offers', 'stock_levels', 'local_price_edits', 'category_stations'].every((t) => count(t) === 0)
  && count('products', "id IN ('p1','p2')") === 0, MENU.map((t) => `${t}=${count(t)}`).join(' '));
ok('A482: then it pulled from the cloud — a product added since is there', count('products', "id = 'p-new'") === 1 && asked2.some((u) => u.includes('/api/pos/init')), asked2.join(' '));
ok('A482: the deleted menu does not come back from a source that still has it', count('products', "id = 'p1'") === 0 && count('categories', "id = 'c1'") === 0 && count('combo_items') === 0 && count('stock_levels') === 0);
ok('A482: a menu change waiting to be sent is dropped; other changes, print stations and sales stay',
  count('local_changes', "id = 'lc-prod'") === 0 && count('local_changes', "id = 'lc-staff'") === 1 && count('print_stations') === 1 && count('orders', "id = 'o-real'") === 1);

const cloud = fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'routes', 'pos.ts'), 'utf8');
ok('the cloud lists this business\'s clears, after what the till has seen, oldest first',
  /from\('test_data_purges'\)\.select\(cols\)\s*\.eq\('business_id', req\.businessId\)\.gt\('created_at', after\)\.order\('created_at', \{ ascending: true \}\)/.test(cloud)
  && /clearsOf\('id, from_at, to_at, created_at, menu'\)/.test(cloud));
ok('it runs on every full sync', /try \{ await runTestDataClears\(\); \} catch/.test(fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
