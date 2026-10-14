// Till sync audit (2026-10-14) — the till's cloud push and pull, defect by defect (F1–F19).
//
// Drives the REAL compiled dist/main (localDb, syncEngine, localChanges, shiftService, testDataClear) on a REAL SQLite
// file in a temp userData, electron shimmed, with a stand-in cloud that follows the cloud's new contract:
//   /api/shifts/:id/close|force-close → 2xx, 409 {code:'ALREADY_CLOSED'}, 404 only when the cloud has no such shift, 5xx;
//   /api/sync/push → { ok: true, upserted, rejected } (503 for its own passing errors).
//
//   cd apps/desktop && npm run build:main && node test/till-sync-audit.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted):
//   F1  markShift / markDay back to `WHERE id=?`                          → "a shift closed while its push was in flight" fails
//   F2  the 'reversals' stage moved back after 'reconcile'               → "the void reaches the cloud BEFORE the close" fails
//   F3  `res.ok || res.status === 404` marks synced again                 → "a 404 close is NOT taken as done" fails
//   F5  the PARKED_DRAWER / drawer_wait_at ordering removed (created_at)  → "a newer drawer's sale is not starved" fails
//   F6  the till-token fallback after a failed staff renewal removed      → "goes under the till's own session" fails
//   F9  pushLocalChanges marks done without the unchanged-row check       → "the newer edit is kept" fails
//   F14 `if (res.ok)` without the body check (orders)                     → "an empty 201 is not proof" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Africa/Nairobi';   // F11: the till's local clock (UTC+3)
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8').replace(/\r\n/g, '\n');
if (!fs.existsSync(path.join(dist, 'syncEngine.js'))) { console.error('dist/main not built. Run:  npm run build:main'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-audit-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const LC = require(path.join(dist, 'localChanges.js'));
const S = require(path.join(dist, 'shiftService.js'));
const D = require(path.join(dist, 'dayService.js'));
const TDC = require(path.join(dist, 'testDataClear.js'));
const DC = require(path.join(dist, 'deviceConfig.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Pollo', '2026-10-14T00:00:00Z')`).run();
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-tom', 'Tom', 'cashier', 'br-1', 'tok', '2026-10-14T08:00:00Z')`).run();

// ── the stand-in cloud ──
const cloud = {
  shifts: new Map(), days: new Map(), floats: new Map(), expenses: new Set(), kvs: new Set(), orders: new Set(),
  calls: [], onPush: null, closeAnswer: null, orderAnswer: null, pushAnswer: null, refreshAnswer: null, brandingAnswer: null, onBranding: null,
  pushBodies: [],
};
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const hdr = (init, k) => { const h = init.headers ?? {}; const key = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase()); return key ? h[key] : undefined; };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  cloud.calls.push({ u, body, auth: hdr(init, 'authorization'), device: hdr(init, 'x-device-id') });
  if (u.endsWith('/api/sync/push')) {
    cloud.pushBodies.push(body);
    if (cloud.onPush) { const f = cloud.onPush; cloud.onPush = null; f(); }   // a local write while the push is on its way
    if (cloud.pushAnswer) return cloud.pushAnswer(body);
    const rejected = [];
    for (const s of body.shifts ?? []) if (!cloud.shifts.has(s.id)) cloud.shifts.set(s.id, { status: 'open' });
    for (const d of body.business_days ?? []) cloud.days.set(d.id, { status: d.status });
    for (const f of body.floats ?? []) cloud.floats.set(f.id, f);
    for (const e of body.expenses ?? []) cloud.expenses.add(e.id);
    for (const k of body.kitchen_voids ?? []) cloud.kvs.add(k.id);
    return json(200, { ok: true, upserted: { shifts: 0, floats: 0, expenses: 0, businessDays: 0, kitchenVoids: (body.kitchen_voids ?? []).length }, rejected });
  }
  const close = u.match(/\/api\/shifts\/([^/]+)\/(close|force-close)$/);
  if (close) {
    if (cloud.closeAnswer) return cloud.closeAnswer(close[1], body);
    const s = cloud.shifts.get(close[1]);
    if (!s) return json(404, { error: 'Shift not found' });
    if (s.status !== 'open') return json(409, { code: 'ALREADY_CLOSED', error: 'already closed' });
    s.status = 'closed'; s.body = body;
    return json(200, { ok: true });
  }
  const rev = u.match(/\/api\/orders\/([^/]+)\/(void|refund)$/);
  if (rev) return json(200, { ok: true });
  if (u.endsWith('/api/orders') && init.method === 'POST') {
    if (cloud.orderAnswer) { const r = cloud.orderAnswer(body, init); if (r) return r; }
    if (body.shift_id && !cloud.shifts.has(body.shift_id)) return json(424, { code: 'shift_not_synced', error: 'This sale\'s drawer has not reached the cloud yet' });
    cloud.orders.add(hdr(init, 'x-idempotency-key'));
    return json(201, { orderId: hdr(init, 'x-idempotency-key') });
  }
  if (u.endsWith('/api/auth/refresh')) return cloud.refreshAnswer ? cloud.refreshAnswer(body, init) : json(500, { error: 'down' });
  if (u.endsWith('/api/business/branding')) {
    if (cloud.onBranding) { const f = cloud.onBranding; cloud.onBranding = null; f(); }
    return cloud.brandingAnswer ? cloud.brandingAnswer() : json(200, { ok: true });
  }
  return json(404, { error: 'not here' });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');
const T = require(path.join(dist, 'tokenStore.js'));
T.writeSessionTokens({ token: 'tok', refreshToken: 'refresh' });

const now = () => new Date().toISOString();
const shift = (id, extra = {}) => db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id, closed_at, closed_by, closing_float)
  VALUES (@id, 'biz-1', 'br-1', 'u-tom', @at, @status, 0, @at, @sync, 'dev-T1', @closed_at, @closed_by, @closing_float)`)
  .run({ id, at: now(), status: 'open', sync: 'pending', closed_at: null, closed_by: null, closing_float: null, ...extra });
const sale = (id, shiftId, { synced = false, at = now(), cashier = 'u-tom' } = {}) => {
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', 100, 0, 100, ?, ?, ?, 'dev-T1')`).run(id, id, shiftId, at, synced ? 'synced' : 'pending');
  if (!synced) db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES (?, ?, ?, 'pending')`)
    .run(id, JSON.stringify({ shift_id: shiftId, order_number: id, cashier_id: cashier, items: [], payments: [] }), at);
};
const col = (t, id, c = 'sync_status') => db.prepare(`SELECT ${c} AS v FROM ${t} WHERE id=?`).get(id)?.v;
const q = (id) => db.prepare(`SELECT status, attempts, last_error FROM sync_queue WHERE order_id=?`).get(id);
const reset = () => {
  for (const t of ['shifts', 'business_days', 'orders', 'sync_queue', 'float_transactions', 'expenses', 'kitchen_voids', 'pending_reversals', 'local_price_edits']) db.prepare(`DELETE FROM ${t}`).run();
  cloud.calls.length = 0; cloud.pushBodies.length = 0;
  cloud.onPush = cloud.closeAnswer = cloud.orderAnswer = cloud.pushAnswer = cloud.refreshAnswer = cloud.brandingAnswer = null;
};

console.log('\nF1 — a close made while the push is on its way is never marked synced\n');
{
  reset();
  shift('sh-1');
  cloud.onPush = () => db.prepare(`UPDATE shifts SET status='closed', closed_at=?, closing_float=0, closed_by='u-tom', sync_status='pending' WHERE id='sh-1'`).run(now());
  await E.syncPush();
  ok('a shift closed while its open push was in flight reaches the cloud CLOSED (the close is not lost)',
    cloud.shifts.get('sh-1')?.status === 'closed' && col('shifts', 'sh-1') === 'synced', JSON.stringify([cloud.shifts.get('sh-1'), col('shifts', 'sh-1')]));

  db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, business_date, opened_at, status, created_at, sync_status)
              VALUES ('day-1', 'biz-1', 'br-1', 'dev-T1', '2026-10-14', ?, 'open', ?, 'pending')`).run(now(), now());
  cloud.onPush = () => db.prepare(`UPDATE business_days SET status='closed', closed_at=?, counted_cash=500, sync_status='pending' WHERE id='day-1'`).run(now());
  await E.syncPush();
  ok('a day closed while its push was in flight stays pending…', col('business_days', 'day-1') === 'pending');
  await E.syncPush();
  ok('…and its close reaches the cloud on the next pass', cloud.days.get('day-1')?.status === 'closed' && col('business_days', 'day-1') === 'synced');
}

console.log('\nF2 — a drawer\'s offline voids reach the cloud before its close\n');
{
  reset();
  shift('sh-2', { status: 'closed', closed_at: now(), closed_by: 'u-tom', closing_float: 0 });
  cloud.shifts.set('sh-2', { status: 'open' });
  sale('o-2', 'sh-2', { synced: true });
  db.prepare(`INSERT INTO pending_reversals (id, order_id, kind, reason, approved_by, device_id, approved_at, sync_status) VALUES ('r-2', 'o-2', 'void', 'wrong item', 'u-mgr', 'dev-T1', ?, 'pending')`).run(now());
  await E.syncPush();
  const iVoid = cloud.calls.findIndex((c) => /\/orders\/o-2\/void$/.test(c.u));
  const iClose = cloud.calls.findIndex((c) => /\/shifts\/sh-2\/close$/.test(c.u));
  ok('the void reaches the cloud BEFORE the close', iVoid >= 0 && iClose > iVoid, `${iVoid} ${iClose}`);

  reset();
  shift('sh-2b', { status: 'closed', closed_at: now(), closed_by: 'u-tom', closing_float: 0 });
  cloud.shifts.set('sh-2b', { status: 'open' });
  sale('o-2b', 'sh-2b', { synced: true });
  db.prepare(`INSERT INTO pending_reversals (id, order_id, kind, reason, approved_by, device_id, approved_at, sync_status) VALUES ('r-2b', 'o-2b', 'void', 'x', 'u-mgr', 'dev-T1', ?, 'pending')`).run(now());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (/\/void$/.test(String(url)) ? json(503, { error: 'busy' }) : realFetch(url, init));
  await E.syncPush();
  globalThis.fetch = realFetch;
  ok('a drawer whose void is still waiting is not closed on the cloud yet', cloud.shifts.get('sh-2b')?.status === 'open' && col('shifts', 'sh-2b') === 'pending');
}

console.log('\nF3 — the close contract: 2xx / 409 ALREADY_CLOSED done, 404 re-armed, 5xx pending\n');
{
  reset();
  const closedAt = '2026-10-14T18:05:00.000Z';
  shift('sh-3', { status: 'closed', closed_at: closedAt, closed_by: 'u-mgr', closing_float: 1000, sync: 'pending' });
  // The cloud does not have it (its open push was lost): the push stage sends it, then the close goes.
  cloud.closeAnswer = () => json(404, { error: 'Shift not found' });
  const sentAll = cloud.pushBodies.length;
  await E.syncPush();
  ok('a 404 close is NOT taken as done: the shift stays pending', col('shifts', 'sh-3') === 'pending');
  cloud.closeAnswer = null;
  await E.syncPush();
  ok('…the shift push sent it (open) and the close followed', cloud.shifts.get('sh-3')?.status === 'closed' && col('shifts', 'sh-3') === 'synced'
    && cloud.pushBodies.slice(sentAll).some((b) => (b.shifts ?? []).some((s) => s.id === 'sh-3')));
  ok('the close carries the till\'s own close time and closer', cloud.shifts.get('sh-3')?.body?.closed_at === closedAt && cloud.shifts.get('sh-3')?.body?.closed_by === 'u-mgr',
    JSON.stringify(cloud.shifts.get('sh-3')?.body));

  shift('sh-3b', { status: 'closed', closed_at: now(), closed_by: 'u-tom', closing_float: 0, sync: 'pending' });
  cloud.shifts.set('sh-3b', { status: 'closed' });
  await E.syncPush();
  ok('409 ALREADY_CLOSED (an earlier answer lost) is done', col('shifts', 'sh-3b') === 'synced');

  shift('sh-3c', { status: 'closed', closed_at: now(), closed_by: 'u-tom', closing_float: 0, sync: 'pending' });
  cloud.shifts.set('sh-3c', { status: 'open' });
  cloud.closeAnswer = () => json(503, { error: 'busy' });
  await E.syncPush();
  ok('a 5xx keeps it pending', col('shifts', 'sh-3c') === 'pending');
  cloud.closeAnswer = (id) => json(409, { code: 'SOMETHING_ELSE', error: 'no' });
  await E.syncPush();
  ok('a 409 that is not ALREADY_CLOSED keeps it pending', col('shifts', 'sh-3c') === 'pending');
}

console.log('\nF5 — one drawer waiting never starves the rest\n');
{
  reset();
  shift('sh-old', { sync: 'conflict' });             // refused by the cloud — parked
  shift('sh-wait', { sync: 'synced' });              // the till thinks it is up; the cloud does not have it (424)
  shift('sh-new', { sync: 'synced' }); cloud.shifts.set('sh-new', { status: 'open' });
  const base = Date.parse('2026-10-14T06:00:00Z');
  for (let i = 0; i < 30; i++) sale(`o-park-${i}`, 'sh-old', { at: new Date(base + i * 1000).toISOString() });
  for (let i = 0; i < 60; i++) sale(`o-wait-${i}`, 'sh-wait', { at: new Date(base + 60_000 + i * 1000).toISOString() });
  sale('o-new', 'sh-new', { at: new Date(base + 3600_000).toISOString() });
  await E.syncPush();
  ok('a newer drawer\'s sale is not starved by 90 older sales waiting on other drawers', q('o-new').status === 'synced', JSON.stringify(q('o-new')));
  ok('a sale of a drawer the cloud refused is not sent (it goes with its drawer)', !cloud.calls.some((c) => c.u.endsWith('/api/orders') && c.body.order_number === 'o-park-0'));
  ok('a drawer that answered 424 is asked once per pass, not 50 times',
    cloud.calls.filter((c) => c.u.endsWith('/api/orders') && String(c.body.order_number).startsWith('o-wait-')).length === 1);
  ok('a 424 sale stays pending with its attempts unspent', q('o-wait-0').status === 'pending' && q('o-wait-0').attempts === 0);
  const s = E.getSyncStatus();
  ok('the badge: sales of a refused drawer are parked, not pending', s.parkedSales === 30 && s.pendingBreakdown.orders === 60, JSON.stringify(s.pendingBreakdown));
  cloud.shifts.set('sh-wait', { status: 'open' });
  await E.syncPush();
  const waitSynced = () => db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE order_id LIKE 'o-wait-%' AND status = 'synced'`).get().n;
  ok('the moment the drawer is on the cloud its sales go (50 a pass)', waitSynced() === 50, String(waitSynced()));
  await E.syncPush();
  ok('…and the rest on the pass after, the one that waited included', waitSynced() === 60 && q('o-wait-0').status === 'synced', String(waitSynced()));

  // 50 sales on 50 different drawers none of which is on the cloud yet fill a whole pass; the sale after them must not
  // wait behind them for ever: a sale that answered 424 queues behind the ones not waiting.
  reset();
  for (let i = 0; i < 50; i++) { shift(`sh-w${i}`, { sync: 'synced' }); sale(`o-w${i}`, `sh-w${i}`, { at: new Date(base + i * 1000).toISOString() }); }
  shift('sh-fresh', { sync: 'synced' }); cloud.shifts.set('sh-fresh', { status: 'open' });
  sale('o-fresh', 'sh-fresh', { at: new Date(base + 3600_000).toISOString() });
  await E.syncPush();
  ok('(a pass of 50 drawers each answering 424 uses the whole pass)', q('o-fresh').status === 'pending' && q('o-w0').status === 'pending');
  await E.syncPush();
  ok('…the next pass sends the sale behind them first', q('o-fresh').status === 'synced', JSON.stringify(q('o-fresh')));
}

console.log('\nF6 — staff renewal: the gate, X-Device-Id, Retry-After, and the till session for orders\n');
{
  reset();
  shift('sh-6', { sync: 'synced' }); cloud.shifts.set('sh-6', { status: 'open' });
  E.configureStaffSession('staff-tok', 'staff-ref');
  db.prepare(`UPDATE staff_session SET token='staff-tok' WHERE id=1`).run();
  try { T.writeStaffTokens({ token: 'staff-tok', refreshToken: 'staff-ref' }); } catch { /* older store */ }
  sale('o-6', 'sh-6');
  cloud.orderAnswer = (b, init) => (hdr(init, 'authorization') === 'Bearer staff-tok' ? json(401, { error: 'Invalid or expired token' }) : null);
  cloud.refreshAnswer = () => json(503, { error: 'down' });
  await E.syncPush();
  const posts = cloud.calls.filter((c) => c.u.endsWith('/api/orders'));
  ok('a sale whose staff session cannot be renewed goes under the till\'s own session (naming its cashier)',
    q('o-6').status === 'synced' && posts.at(-1)?.auth === 'Bearer tok' && posts.at(-1)?.body.cashier_id === 'u-tom', JSON.stringify(posts.map((p) => p.auth)));
  const ren = cloud.calls.find((c) => c.u.endsWith('/api/auth/refresh') && c.body.refreshToken === 'staff-ref');
  ok('the staff renewal says which till asks (X-Device-Id)', ren?.device === 'dev-T1', JSON.stringify(ren));
  const n0 = cloud.calls.filter((c) => c.u.endsWith('/api/auth/refresh')).length;
  ok('a failed staff renewal is not retried within the minute', (await E.refreshStaffToken()) === false
    && cloud.calls.filter((c) => c.u.endsWith('/api/auth/refresh')).length === n0);

  E._resetStaffRenewalPace();
  cloud.refreshAnswer = () => json(429, { error: 'Too many renewals' }, { 'retry-after': '120' });
  await E.refreshStaffToken();
  const held = E.renewalHeldUntil();
  ok('a 429 holds every renewal for its Retry-After (the shared gate)', held !== null && held - Date.now() > 100_000 && held - Date.now() <= 121_000, String(held && held - Date.now()));
  E._resetStaffRenewalPace();
  const n1 = cloud.calls.filter((c) => c.u.endsWith('/api/auth/refresh')).length;
  ok('…the staff renewal waits too', (await E.refreshStaffToken()) === false && cloud.calls.filter((c) => c.u.endsWith('/api/auth/refresh')).length === n1);
  E.resetRenewalGate('test');

  E._resetStaffRenewalPace();
  let k = 0;
  cloud.refreshAnswer = () => { k++; return json(200, { accessToken: `staff-new-${k}`, refreshToken: `staff-ref-${k}` }); };
  ok('a renewal succeeds', (await E.refreshStaffToken()) === true && k === 1);
  ok('the 20-s pollers\' next 401 within the minute does not rotate the key again', (await E.refreshStaffToken()) === true && k === 1);
  E.configureStaffSession('', '');
  try { T.writeStaffTokens({ token: '', refreshToken: '' }); } catch { /* */ }
}

console.log('\nF7 / F13 — renew only on a 401; one product\'s choices never abort the pass\n');
{
  const se = read('src/main/syncEngine.ts');
  ok('syncAll renews only after a 401 pull', /if \(!pulled && _lastPullStatus === 401/.test(se));
  ok('the busy flag is released only by the pass that took it', /if \(_syncOwner !== me\) return;/.test(se) && !/finally \{\s*_isSyncing = false;/.test(se));
  ok('the push stages are single-flight', /if \(!_pushStagesInFlight\)/.test(se));

  reset();
  shift('sh-13', { sync: 'synced' }); cloud.shifts.set('sh-13', { status: 'open' });
  sale('o-13', 'sh-13');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/api/pos/init')) return json(200, { products: [{ id: 'p1', name: 'Tea', base_price: 50, has_variants: true, category_id: null, description: null, image_url: null, status: 'active' }, { id: 'p2', name: 'Cake', base_price: 90, has_variants: true, category_id: null, description: null, image_url: null, status: 'active' }], categories: [], branchId: 'br-1' });
    if (u.includes('/api/variants/groups?product_id=p1')) throw new Error('sync fetch timed out after 20000ms');
    if (u.includes('/api/variants/groups')) return json(200, []);
    if (u.includes('/api/inventory') || u.includes('/api/staff') || u.includes('/api/tables') || u.includes('/api/pumps') || u.includes('/api/stations')) return json(200, []);
    return realFetch(url, init);
  };
  const r = await E.syncAll();
  globalThis.fetch = realFetch;
  ok('a product whose choices fetch throws does not stop the pass: the pull lands and the push stages run',
    r.pulled === true && q('o-13').status === 'synced', JSON.stringify(r));
}

console.log('\nF8 — the logo stays pending on a 401 / 408 / 429, and a newer upload is never cleared\n');
{
  reset();
  db.prepare(`INSERT OR REPLACE INTO branding (business_id, accent_hex, logo_png, synced_at) VALUES ('biz-1', '#112233', NULL, ?)`).run(now());
  for (const st of [401, 408, 429]) {
    cloud.brandingAnswer = () => json(st, { error: 'no' });
    cloud.refreshAnswer = () => json(503, { error: 'down' });
    const r = await E.queueBrandingPush();
    ok(`HTTP ${st}: pending, not refused (the logo is kept)`, r.state === 'pending' && E.brandingPushPending(), JSON.stringify(r));
  }
  cloud.brandingAnswer = null;
  cloud.onBranding = () => db.prepare(`UPDATE maintenance_state SET value = 'newer-upload' WHERE key = 'branding_push_pending'`).run();
  const r = await E.pushBrandingNow();
  ok('a logo uploaded again while the first was on its way stays pending', r.state === 'saved' && E.brandingPushPending());
  await E.pushBrandingNow();
  ok('…and the next push clears it', !E.brandingPushPending());
}

console.log('\nF9 — an edit merged in while its change was on its way is not lost\n');
{
  const secrets = { wrap: (s) => `raw:${s}`, unwrap: (s) => s.replace(/^raw:/, ''), seal: (s) => s };
  db.prepare(`DELETE FROM local_changes`).run();
  const made = LC.recordChange(db, { entity: 'category', op: 'create', data: { name: 'Drinks' } }, { id: 'u-mgr', name: 'Mgr' }, secrets);
  const catId = made.change.entity_id;
  const firstId = made.change.id;
  const sent = [];
  const deps = {
    secrets,
    state: async () => [],
    post: async (changes) => {
      sent.push(...changes);
      if (sent.length === 1) LC.recordChange(db, { entity: 'category', op: 'update', entity_id: catId, data: { name: 'Cold drinks' } }, { id: 'u-mgr', name: 'Mgr' }, secrets);
      return { ok: true, status: 200, json: async () => ({ results: changes.map((c) => ({ id: c.id, status: 'applied' })) }) };
    },
  };
  await LC.pushLocalChanges(db, deps);
  const rows = db.prepare(`SELECT * FROM local_changes WHERE entity_id = ?`).all(catId);
  ok('the newer edit is kept: still pending, not marked done', rows.length === 1 && rows[0].state === 'pending' && JSON.parse(rows[0].data).name === 'Cold drinks', JSON.stringify(rows));
  ok('…under a NEW change id (the cloud answers an id it has seen with its first answer)', rows[0].id !== firstId);
  ok('…as an update of what the cloud now holds', rows[0].op === 'update' && JSON.parse(rows[0].base).name === 'Drinks', `${rows[0].op} ${rows[0].base}`);
  await LC.pushLocalChanges(db, deps);
  ok('the next push sends it and it settles', sent.at(-1)?.id === rows[0].id && sent.at(-1)?.data.name === 'Cold drinks'
    && db.prepare(`SELECT state FROM local_changes WHERE id = ?`).get(rows[0].id).state === 'done');
}

console.log('\nF10 — 5xx is a retry; rows an older cloud parked for a passing reason go again once\n');
{
  reset();
  db.prepare(`INSERT INTO kitchen_voids (id, business_id, branch_id, order_number, product_name, quantity, reason, device_id, created_at, sync_status)
              VALUES ('kv-1', 'biz-1', 'br-1', 'T1-1', 'Tea', 1, 'wrong_item', 'dev-T1', ?, 'pending')`).run(now());
  cloud.pushAnswer = () => json(503, { error: 'busy', code: 'TRANSIENT' });
  await E.syncPush();
  ok('a 503 push leaves the rows pending (never parked)', col('kitchen_voids', 'kv-1') === 'pending');
  cloud.pushAnswer = null;
  db.prepare(`UPDATE kitchen_voids SET sync_status='conflict', sync_error=NULL WHERE id='kv-1'`).run();
  db.prepare(`INSERT INTO kitchen_voids (id, business_id, branch_id, order_number, product_name, quantity, reason, device_id, created_at, sync_status, sync_error)
              VALUES ('kv-bad', 'biz-1', 'br-1', 'T1-2', 'Tea', 1, 'nonsense', 'dev-T1', ?, 'conflict', 'invalid_reason: unknown kitchen void reason')`).run(now());
  db.prepare(`INSERT INTO expenses (id, business_id, branch_id, description, amount, expense_date, shift_id, created_at, device_id, sync_status)
              VALUES ('ex-1', 'biz-1', 'br-1', 'Gas', 150, '2026-10-14', NULL, ?, 'dev-T1', 'conflict')`).run(now());
  await E.syncPush();
  ok('a kitchen void parked with no data error code goes again and lands', col('kitchen_voids', 'kv-1') === 'synced' && cloud.kvs.has('kv-1'));
  ok('an expense "Not from a drawer" parked by an older cloud goes again and lands', col('expenses', 'ex-1') === 'synced' && cloud.expenses.has('ex-1'));
  ok('a row refused for its data stays parked', col('kitchen_voids', 'kv-bad') === 'conflict');
  db.prepare(`UPDATE kitchen_voids SET sync_status='conflict' WHERE id='kv-1'`).run();
  E.requeueTransientConflicts();
  ok('…and the re-send is once only (no loop)', col('kitchen_voids', 'kv-1') === 'conflict');
  cloud.pushAnswer = () => json(200, { ok: true, upserted: { kitchenVoids: 1 }, rejected: [{ id: 'kv-2', code: 'invalid_quantity', table: 'kitchen_voids', error: 'a kitchen void needs a quantity above 0' }] });
  db.prepare(`INSERT INTO kitchen_voids (id, business_id, branch_id, order_number, product_name, quantity, reason, device_id, created_at, sync_status)
              VALUES ('kv-2', 'biz-1', 'br-1', 'T1-3', 'Tea', 0, 'wrong_item', 'dev-T1', ?, 'pending')`).run(now());
  await E.syncPush();
  ok('a refusal keeps the cloud\'s code on the row (sync_error)', /^invalid_quantity:/.test(col('kitchen_voids', 'kv-2', 'sync_error') ?? ''));
  ok('isDataErrorCode: data codes vs passing ones', E.isDataErrorCode('23503') && E.isDataErrorCode('missing_shift') && !E.isDataErrorCode('error') && !E.isDataErrorCode('57014') && !E.isDataErrorCode(null));
}

console.log('\nF11 — an expense is dated by the business day on this till, not the UTC date\n');
{
  reset();
  const RealDate = Date;
  const fixed = RealDate.parse('2026-10-14T22:30:00Z');   // 01:30 on the 15th in Nairobi
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
  let id;
  try { id = S.recordExpense({ shiftId: null, description: 'Ice', amount: 40, approver: { id: 'u-mgr', name: 'Mgr' } }).id; }
  finally { globalThis.Date = RealDate; }
  ok('expense_date is the local business date (2026-10-15), not the UTC one (2026-10-14)', col('expenses', id, 'expense_date') === '2026-10-15', col('expenses', id, 'expense_date'));
}

console.log('\nF14 — only the cloud\'s real answer marks anything synced\n');
{
  reset();
  shift('sh-14', { sync: 'synced' }); cloud.shifts.set('sh-14', { status: 'open' });
  sale('o-14', 'sh-14');
  cloud.orderAnswer = () => json(201, {});
  await E.syncPush();
  ok('an empty 201 is not proof the sale is stored: it stays pending', q('o-14').status === 'pending' && col('orders', 'o-14') === 'pending');
  cloud.orderAnswer = () => json(200, { orderId: 'o-14', duplicate: true });
  await E.syncPush();
  ok('a duplicate answer is', q('o-14').status === 'synced');
  db.prepare(`INSERT INTO float_transactions (id, shift_id, branch_id, cashier_id, type, amount, reason, created_at, device_id, sync_status, order_id)
              VALUES ('fl-14', 'sh-14', 'br-1', 'u-tom', 'float_out', 200, 'rider', ?, 'dev-T1', 'pending', 'o-14')`).run(now());
  cloud.pushAnswer = () => json(200, {});
  await E.syncPush();
  ok('a push answered {} leaves the cash rows pending', col('float_transactions', 'fl-14') === 'pending');
  cloud.pushAnswer = null;
  await E.syncPush();
  ok('F15: the float goes with the sale it was paid for (order_id)', cloud.floats.get('fl-14')?.order_id === 'o-14' && col('float_transactions', 'fl-14') === 'synced');
}

console.log('\nF16 / F17 — the queue is pruned; the badge counts everything still owed\n');
{
  reset();
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES ('q-old', '{}', ?, 'synced'), ('q-fail', '{}', ?, 'failed'), ('q-recent', '{}', ?, 'synced')`)
    .run(old, old, new Date(Date.now() - 5 * 86400_000).toISOString());
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES ('q-sqlite', '{}', datetime('now', '-40 days'), 'synced')`).run();
  const n = E.pruneSyncedQueue();
  const left = db.prepare(`SELECT order_id FROM sync_queue ORDER BY order_id`).all().map((r) => r.order_id).join(',');
  ok('synced rows older than 30 days go; failed and recent ones stay', n === 2 && left === 'q-fail,q-recent', `${n} ${left}`);
  ok('sync_queue has an index on status', db.prepare(`PRAGMA index_list(sync_queue)`).all().some((i) => i.name === 'sync_queue_status_idx'));
  db.prepare(`DELETE FROM sync_queue`).run();

  db.prepare(`INSERT INTO kitchen_voids (id, business_id, branch_id, order_number, product_name, quantity, reason, device_id, created_at, sync_status)
              VALUES ('kv-17', 'biz-1', 'br-1', 'T1-9', 'Tea', 1, 'wrong_item', 'dev-T1', ?, 'pending')`).run(now());
  db.prepare(`INSERT INTO local_price_edits (product_id, price, updated_at, synced) VALUES ('p1', 60, ?, 0)`).run(now());
  shift('sh-17', { status: 'closed', closed_at: now(), sync: 'synced' });
  db.prepare(`UPDATE shifts SET confirmed_at=?, confirmed_by='u-mgr', confirm_sync='pending' WHERE id='sh-17'`).run(now());
  const s = E.getSyncStatus();
  ok('kitchen voids, price edits and confirmations still owed are counted', s.pendingBreakdown.kitchenVoids === 1 && s.pendingBreakdown.prices === 1
    && s.pendingBreakdown.confirmations === 1 && s.pendingCount >= 3, JSON.stringify(s.pendingBreakdown));
  db.prepare(`DELETE FROM maintenance_state WHERE key = 'last_synced_at'`).run();
  ok('"Last synced" is not stamped while they wait', E.noteSyncedIfClear() === false);
}

console.log('\nF18 — a long-offline till never sends one body over the cloud\'s 1 MB limit\n');
{
  const mk = (p, n) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}` }));
  const b = E.cashBatches({ business_days: mk('d', 1), shifts: mk('s', 250), floats: mk('f', 450), expenses: mk('e', 3), kitchen_voids: [] }, 200);
  ok('at most 200 rows per table per request', b.every((x) => Object.values(x).every((a) => a.length <= 200)));
  ok('every row once', b.reduce((n, x) => n + Object.values(x).reduce((m, a) => m + a.length, 0), 0) === 704);
  const firstFloat = b.findIndex((x) => x.floats.length), lastShift = b.map((x) => x.shifts.length > 0).lastIndexOf(true);
  ok('no float goes before the last shift (at the earliest in the same request — the cloud writes shifts first)', firstFloat >= lastShift &&b[0].business_days.length === 1, `${firstFloat} ${lastShift}`);

  reset();
  shift('sh-18', { sync: 'synced' }); cloud.shifts.set('sh-18', { status: 'open' });
  const ins = db.prepare(`INSERT INTO float_transactions (id, shift_id, branch_id, cashier_id, type, amount, reason, created_at, device_id, sync_status)
                          VALUES (?, 'sh-18', 'br-1', 'u-tom', 'float_in', 1, 'x', ?, 'dev-T1', 'pending')`);
  for (let i = 0; i < 450; i++) ins.run(`fl18-${i}`, now());
  await E.syncPush();
  ok('450 pending floats go in three requests, all land', cloud.pushBodies.length === 3 && cloud.pushBodies.every((x) => (x.floats ?? []).length <= 200)
    && db.prepare(`SELECT COUNT(*) AS n FROM float_transactions WHERE sync_status='synced'`).get().n === 450, String(cloud.pushBodies.length));
}

console.log('\nF19 — the test-data clear compares instants, not spellings\n');
{
  reset();
  sale('o-in-tz', null, { synced: true, at: '2026-10-03T08:00:00.000Z' });      // 11:00 Nairobi — inside 10:00+03:00 … 12:00Z
  sale('o-edge', null, { synced: true, at: '2026-10-03T12:00:00.000Z' });       // exactly the period's end, spelled 'Z'
  sale('o-out', null, { synced: true, at: '2026-10-03T06:59:59.000Z' });        // before 10:00+03:00
  const r = TDC.applyTestDataClear(db, { id: 'c1', from_at: '2026-10-03T10:00:00+03:00', to_at: '2026-10-03T12:00:00+00:00' });
  const left = db.prepare(`SELECT id FROM orders ORDER BY id`).all().map((x) => x.id).join(',');
  ok('a sale inside the period is cleared whatever the offset spelling', r.sales === 2 && left === 'o-out', `${r.sales} ${left}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
