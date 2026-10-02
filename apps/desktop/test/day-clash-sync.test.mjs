// A363 (2026-09-29) — an offline close-and-reopen must never strand a drawer; desktop 0.6.20.
// Owner, T1: closed yesterday and opened today while offline; online again, today's shift never reached the cloud, its
// two sales "wait for their drawer" for two hours, and the web asked for a float on a till that was trading.
//
// Drives the REAL compiled dist/main/syncEngine.js (+ localDb, shiftService) on a REAL SQLite file, electron shimmed,
// against a stand-in cloud that behaves as /api/sync/push does:
//   BEFORE the fix — trading days written in the order sent; one open day per till (business_days_one_open_per_till),
//   so today's open day sent before yesterday's close is refused duplicate_open_day, and its shift missing_business_day.
//   AFTER — closing days first (lib/dayOrder closesFirst; the server side runs in tests/day-order.test.mjs).
// Also: refusals reach swiftpos.log; the web-sales pull renews an expired staff token; "recovered" only after a clean
// pass; parked + last-synced in the status; the Z-report says what is not backed up.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/day-clash-sync.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - requeueAfterDayClash left out of the requeue stage     → "after the fix the day and shift reach the cloud" fails
//   - the once-only mark dropped                              → "re-sent once only" fails
//   - the refusal logLine removed                             → "the refusal is in swiftpos.log" fails
//   - pullWebSales without the 401 refresh                    → "the web-sales pull renews an expired token" fails
//   - clearInboundFailure back after a failed pass            → "no 'recovered' after a failed pass" fails
//   - noteSyncedIfClear stamping with something still parked  → "last synced is not stamped while a record is parked" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a363-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const LOG = require(path.join(dist, 'logFile.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const logText = () => { try { return fs.readFileSync(LOG.getLogPath(), 'utf8'); } catch { return ''; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B Foods', '2026-09-29T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Left Till' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-eugene', 'Eugene', 'owner', 'br-1', 'tok', '2026-09-29T06:54:00Z')`).run();

// ── The stand-in cloud ── (yesterday's day is OPEN on the cloud: its close is still on the till)
const cloud = {
  fixed: false,
  days: new Map([['day-y', { device_id: 'dev-T1', status: 'open' }]]),
  shifts: new Map([['sh-y', { device_id: 'dev-T1', status: 'closed' }]]),
  orders: new Set(), staffToken: 'fresh', webPull: 'ok',
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  const bearer = String(init.headers?.Authorization ?? '').replace('Bearer ', '');
  if (u.endsWith('/api/auth/refresh')) return json(200, { accessToken: cloud.staffToken, refreshToken: 'r2' });
  if (u.endsWith('/api/sync/push')) {
    const rejected = [];
    const days = body.business_days ?? [];
    const ordered = cloud.fixed ? [...days.filter(d => d.status === 'closed'), ...days.filter(d => d.status !== 'closed')] : days;
    for (const d of ordered) {
      const clash = d.status === 'open' && [...cloud.days].some(([id, x]) => id !== d.id && x.status === 'open' && x.device_id === d.device_id);
      if (clash) rejected.push({ id: d.id, code: 'duplicate_open_day', table: 'business_days', error: 'This till already has an open trading day. It must be closed before this one can sync.' });
      else cloud.days.set(d.id, { device_id: d.device_id, status: d.status });
    }
    for (const s of body.shifts ?? []) {
      if (s.business_day_id && !cloud.days.has(s.business_day_id)) {
        rejected.push({ id: s.id, code: 'missing_business_day', table: 'shifts', error: 'This shift\'s trading day is not on the server — the day was refused or has not synced yet. Resolve the trading day first.' });
      } else cloud.shifts.set(s.id, { device_id: s.device_id, status: 'open' });
    }
    return json(200, { ok: true, rejected });
  }
  if (u.endsWith('/api/orders') && init.method === 'POST') {
    if (body.shift_id && !cloud.shifts.has(body.shift_id)) {
      return json(424, { code: 'shift_not_synced', error: 'This sale\'s drawer has not reached the cloud yet — it will sync right after it.' });
    }
    cloud.orders.add(init.headers['X-Idempotency-Key']);
    return json(201, { orderId: `cloud-${cloud.orders.size}` });
  }
  if (u.includes('/foreign-orders')) {
    if (cloud.webPull === 'down') return json(500, { error: 'boom' });
    return bearer === cloud.staffToken ? json(200, { orders: [] }) : json(401, { error: 'Invalid or expired token' });
  }
  return json(404, { error: 'not here' });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');

const now = () => new Date().toISOString();
const sale = (id, shiftId) => {
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', 100, 0, 100, ?, ?, 'pending', 'dev-T1')`).run(id, id, shiftId, now());
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES (?, ?, ?, 'pending')`)
    .run(id, JSON.stringify({ shift_id: shiftId, order_number: id, items: [], payments: [] }), now());
};
const q = (id) => db.prepare(`SELECT status FROM sync_queue WHERE order_id=?`).get(id)?.status;
const st = (t, id) => db.prepare(`SELECT sync_status, notes FROM ${t} WHERE id=?`).get(id);
const passes = async (n) => { for (let i = 0; i < n; i++) await E.syncPush(); };

console.log('A363 — offline at 09:54: yesterday closed, today opened, two sales; online at 10:15\n');
// Today's day is written FIRST (as the till's SELECT returns it), yesterday's close after it — the order that clashed.
db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, status, created_at, sync_status)
            VALUES ('day-t', 'biz-1', 'br-1', 'dev-T1', 'T1', '2026-09-29', ?, 'open', ?, 'pending')`).run(now(), now());
db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, closed_at, status, created_at, sync_status)
            VALUES ('day-y', 'biz-1', 'br-1', 'dev-T1', 'T1', '2026-09-28', '2026-09-28T13:58:00Z', ?, 'closed', '2026-09-28T13:58:00Z', 'pending')`).run(now());
db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id, terminal_code, business_day_id, opened_by)
            VALUES ('sh-t', 'biz-1', 'br-1', 'u-eugene', ?, 'open', 3000, ?, 'pending', 'dev-T1', 'T1', 'day-t', 'u-eugene')`).run(now(), now());
sale('o-glovo', 'sh-t');
sale('o-mpesa', 'sh-t');

await passes(1);
ok('BEFORE the fix (the owner\'s morning, one pass): today\'s day is refused and parked', st('business_days', 'day-t').sync_status === 'conflict');
ok('…and its shift with it — the web then sees T1 as closed', st('shifts', 'sh-t').sync_status === 'conflict' && !cloud.shifts.has('sh-t'));
ok('…its sales wait for the drawer, never lost (pending)', q('o-glovo') === 'pending' && q('o-mpesa') === 'pending' && cloud.orders.size === 0);
ok('the refusal is in swiftpos.log now, not only on the Sync card',
  /refused by the cloud \(business_days day-t\): This till already has an open trading day/.test(logText())
  && /refused by the cloud \(shifts sh-t\): This shift's trading day is not on the server/.test(logText()));
let status = E.getSyncStatus();
ok('the status carries the parked records and why (the manager\'s red notice)',
  status.parkedCount === 2 && /already has an open trading day|trading day is not on the server/.test(status.parkedReason ?? ''), JSON.stringify(status));
ok('last synced is not stamped while a record is parked', status.lastSyncedAt == null, String(status.lastSyncedAt));
const z1 = S.computeZReport('sh-t');
ok('the Z-report says the drawer was refused', z1.notBackedUp?.drawerRefused === true && z1.notBackedUp?.sales === 2, JSON.stringify(z1.notBackedUp));

// The till's once-only re-send recovers it on its own: yesterday's close landed in the first pass, so today's day no
// longer clashes — T1 unsticks on 0.6.20 whichever of the cloud or the till is updated first.
await passes(2);
ok('the till re-sends the parked day and shift once, and they reach the cloud (even before the cloud fix)',
  st('business_days', 'day-t').sync_status === 'synced' && st('shifts', 'sh-t').sync_status === 'synced'
  && cloud.days.get('day-t')?.status === 'open' && cloud.shifts.has('sh-t'), JSON.stringify([st('business_days', 'day-t'), st('shifts', 'sh-t')]));
ok('…and both sales follow', q('o-glovo') === 'synced' && q('o-mpesa') === 'synced' && cloud.orders.size === 2);
ok('the rejection lines are gone from the notes (a day\'s notes go to the cloud)',
  !/Sync rejected/.test(st('business_days', 'day-t').notes ?? '') && !/Sync rejected/.test(st('shifts', 'sh-t').notes ?? ''));
ok('the re-send is logged', /A363 re-sending once after a trading-day clash: 1 day\(s\), 1 shift\(s\)/.test(logText()));
status = E.getSyncStatus();
ok('nothing parked any more, and "last synced" is stamped', status.parkedCount === 0 && typeof status.lastSyncedAt === 'string', JSON.stringify(status));
const z2 = S.computeZReport('sh-t');
ok('the Z-report has nothing to warn about', z2.notBackedUp?.sales === 0 && z2.notBackedUp?.drawerRefused === false);

console.log('\nA363 — with the cloud fix, an offline close-and-reopen is never refused at all');
cloud.fixed = true;   // the cloud writes closing days first (0.6.20 cloud, lib/dayOrder)
cloud.days.set('day-t', { device_id: 'dev-T1', status: 'open' });
db.prepare(`UPDATE business_days SET status='closed', closed_at=?, sync_status='pending' WHERE id='day-t'`).run(now());
db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, status, created_at, sync_status)
            VALUES ('day-n', 'biz-1', 'br-1', 'dev-T1', 'T1', '2026-09-30', ?, 'open', '2026-09-29T00:00:00Z', 'pending')`).run(now());
const beforeFixed = logText().length;
await passes(1);
ok('the new day lands in the first pass, next to the close', st('business_days', 'day-n').sync_status === 'synced' && cloud.days.get('day-n')?.status === 'open'
  && cloud.days.get('day-t')?.status === 'closed', JSON.stringify([...cloud.days]));
ok('…and nothing was refused', !/refused by the cloud/.test(logText().slice(beforeFixed)));

console.log('\nA363 — re-sent once only (a real refusal is parked again, never looped)');
db.prepare(`UPDATE shifts SET sync_status='conflict', notes=? WHERE id='sh-t'`).run(E.MISSING_DAY_NOTE);
const again = E.requeueAfterDayClash();
ok('a row already re-sent once is left parked', again.shifts === 0 && st('shifts', 'sh-t').sync_status === 'conflict', JSON.stringify(again));
ok('last synced is not stamped while a record is parked — even with no sale waiting', E.getSyncStatus().pendingCount === 0 && E.noteSyncedIfClear() === false);
db.prepare(`UPDATE shifts SET sync_status='synced', notes=NULL WHERE id='sh-t'`).run();
ok('a healthy till: the re-send matches nothing', JSON.stringify(E.requeueAfterDayClash()) === '{"days":0,"shifts":0}');

console.log('\nA363 — the web-sales pull and the log');
E.configureStaffSession('expired', 'r1');
const before = logText().length;
await E.pullWebSales();
const pulled = logText().slice(before);
ok('the web-sales pull renews an expired token and retries (no 401 line)', !/web sales pull failed/.test(pulled), pulled);
cloud.webPull = 'down';
const before2 = logText().length;
await E.pullWebSales();
await E.pullWebSales();
const down = logText().slice(before2);
ok('a failed pass is logged…', /web sales pull failed: HTTP 500/.test(down), down);
ok('…with no "recovered" after a failed pass', !/recovered after: web sales pull failed/.test(down), down);
cloud.webPull = 'ok';
const before3 = logText().length;
await E.pullWebSales();
ok('"recovered" only once a pass is clean', /recovered after: web sales pull failed: HTTP 500/.test(logText().slice(before3)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
