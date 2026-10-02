// A338 (2026-09-27) — one drawer must never stop another from syncing.
// Owner: the till was "not syncing to cloud … because of the cloud till which is running … one should never block the other".
//
// Drives the REAL compiled dist/main/syncEngine.js (+ localDb, shiftService) on a REAL SQLite file, electron shimmed, against
// a stand-in cloud that behaves exactly as the real routes do:
//   BEFORE migration 107 — /api/sync/push refuses the till's shift while the web's drawer is open on the same terminal
//   (duplicate_open_shift), its floats/expenses as missing_shift; /api/orders fails the shift foreign key (422
//   ORDER_FK_VIOLATION, lib/orderErrors.ts). AFTER — the shift lands; a sale whose drawer is not up yet gets 424
//   shift_not_synced (routes/orders.ts). Real Postgres behaviour of the index itself: scripts/test-migration-107.mjs.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/drawer-clash-sync.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - the requeue stage removed from runPushStages          → "after 107 everything the clash parked reaches the cloud" fails
//   - requeue drops its once-only mark                      → "a sale that fails again is not requeued twice" fails
//   - 424 handled like any other error (counts to 'failed') → "a sale waiting for its drawer never goes 'failed'" fails
//   - the rejection note is not taken out of the shift notes → "the rejection line is gone from the notes" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a338-'));
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
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Your Business', '2026-09-27T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-tom', 'Tom', 'cashier', 'br-1', 'tok', '2026-09-27T08:00:00Z')`).run();

// ── The stand-in cloud ──
const cloud = { migrated: false, shifts: new Map([['sh-web', { device_id: 'dev-T1', status: 'open' }]]), floats: new Set(), expenses: new Set(), orders: new Set() };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  if (u.endsWith('/api/sync/push')) {
    const rejected = [];
    for (const s of body.shifts ?? []) {
      const clash = [...cloud.shifts].some(([id, x]) => id !== s.id && x.status === 'open' && x.device_id === s.device_id);
      if (!cloud.shifts.has(s.id) && clash && !cloud.migrated) {
        rejected.push({ id: s.id, code: 'duplicate_open_shift', table: 'shifts', error: 'This cashier already has an open shift. It must be closed before this one can sync.' });
      } else cloud.shifts.set(s.id, { device_id: s.device_id, status: 'open' });
    }
    for (const f of body.floats ?? []) {
      if (cloud.shifts.has(f.shift_id)) cloud.floats.add(f.id);
      else rejected.push({ id: f.id, code: 'missing_shift', table: 'float_transactions', error: 'parent shift not synced' });
    }
    for (const e of body.expenses ?? []) {
      if (!e.shift_id || cloud.shifts.has(e.shift_id)) cloud.expenses.add(e.id);
      else rejected.push({ id: e.id, code: 'missing_shift', table: 'expenses', error: 'parent shift not synced' });
    }
    return json(200, { ok: true, rejected });
  }
  if (u.endsWith('/api/orders') && init.method === 'POST') {
    const order = body;
    if (order.shift_id && !cloud.shifts.has(order.shift_id)) {
      return cloud.migrated
        ? json(424, { code: 'shift_not_synced', error: 'This sale\'s drawer has not reached the cloud yet — it will sync right after it.' })
        : json(422, { code: 'ORDER_FK_VIOLATION', error: 'This sale references a record the server does not have. It cannot be accepted as-is.' });
    }
    if (order.malformed) return json(422, { code: 'ORDER_MALFORMED_VALUE', error: 'This sale contains a value the server could not read (a date or an id).' });
    cloud.orders.add(init.headers['X-Idempotency-Key']);
    return json(201, { orderId: `cloud-${cloud.orders.size}` });
  }
  return json(404, { error: 'not here' });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');

const sale = (id, shiftId, extra = {}) => {
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', 100, 0, 100, ?, ?, 'pending', 'dev-T1')`).run(id, id, shiftId, new Date().toISOString());
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES (?, ?, ?, 'pending')`)
    .run(id, JSON.stringify({ shift_id: shiftId, order_number: id, items: [], payments: [], ...extra }), new Date().toISOString());
};
const q = (id) => db.prepare(`SELECT status, attempts, last_error FROM sync_queue WHERE order_id=?`).get(id);
const st = (t, id) => db.prepare(`SELECT sync_status FROM ${t} WHERE id=?`).get(id)?.sync_status;
const passes = async (n) => { for (let i = 0; i < n; i++) await E.syncPush(); };

console.log('A338 — the web\'s drawer (the "cloud till") is open on T1; the till has its own\n');
const s1 = S.openShift(1000);
S.addFloat('float_out', 50, 'change run');
const floatId = db.prepare(`SELECT id FROM float_transactions WHERE shift_id=?`).get(s1.id).id;
db.prepare(`INSERT INTO expenses (id, business_id, branch_id, description, amount, expense_date, shift_id, created_at, device_id)
            VALUES ('e-1', 'biz-1', 'br-1', 'Gas', 150, '2026-09-27', ?, ?, 'dev-T1')`).run(s1.id, new Date().toISOString());
sale('o-1', s1.id);
sale('o-2', s1.id);

await passes(6);
ok('BEFORE 107 (the owner\'s failure): the till\'s drawer is refused and parked', st('shifts', s1.id) === 'conflict');
ok('…its float and expense are parked with it', st('float_transactions', floatId) === 'conflict' && st('expenses', 'e-1') === 'conflict');
ok('…and its sales fail and give up (\'failed\' after 5 tries) — nothing on that drawer reached the cloud',
  q('o-1').status === 'failed' && q('o-2').status === 'failed' && cloud.orders.size === 0, JSON.stringify(q('o-1')));
ok('…while the shift notes carry the rejection', /already has an open shift/.test(db.prepare(`SELECT notes FROM shifts WHERE id=?`).get(s1.id).notes ?? ''));

// A sale refused for a DIFFERENT reason must never be swept up by the requeue.
sale('o-bad', s1.id, { malformed: true });

cloud.migrated = true;   // migration 107 applied; the cloud runs A338
await passes(2);
ok('after 107 everything the clash parked reaches the cloud: the drawer', st('shifts', s1.id) === 'synced' && cloud.shifts.has(s1.id));
ok('…its float and expense', st('float_transactions', floatId) === 'synced' && st('expenses', 'e-1') === 'synced'
  && cloud.floats.has(floatId) && cloud.expenses.has('e-1'));
ok('…and both sales', q('o-1').status === 'synced' && q('o-2').status === 'synced' && cloud.orders.has('o-1') && cloud.orders.has('o-2'),
  JSON.stringify([q('o-1'), q('o-2')]));
ok('the web\'s drawer is untouched — both drawers are on the cloud', cloud.shifts.has('sh-web') && cloud.shifts.size === 2);
ok('the rejection line is gone from the notes (the close sends them on)',
  !/already has an open shift/.test(db.prepare(`SELECT notes FROM shifts WHERE id=?`).get(s1.id).notes ?? ''));

// A sale refused for another reason is not swept up.
await passes(5);
ok('a sale refused for another reason is left alone (failed, not re-sent by the requeue)',
  q('o-bad').status === 'failed' && !/requeued/.test(q('o-bad').last_error ?? ''), JSON.stringify(q('o-bad')));

console.log('\nA338 — a sale whose drawer is not up yet waits; it is never given up on');
// A drawer the cloud has not got (e.g. its trading day is still on the way): sales wait, however many passes.
db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id)
            VALUES ('sh-late', 'biz-1', 'br-1', 'u-tom', ?, 'closed', 0, ?, 'synced', 'dev-T1')`).run(new Date().toISOString(), new Date().toISOString());
sale('o-wait', 'sh-late');
await passes(8);
ok('a sale waiting for its drawer never goes \'failed\' (8 passes): pending, attempts not spent, the reason kept',
  q('o-wait').status === 'pending' && q('o-wait').attempts === 0 && /drawer has not reached the cloud/.test(q('o-wait').last_error ?? ''),
  JSON.stringify(q('o-wait')));
cloud.shifts.set('sh-late', { device_id: 'dev-T1', status: 'closed' });
await passes(1);
ok('…and goes the moment its drawer is there', q('o-wait').status === 'synced' && cloud.orders.has('o-wait'));

console.log('\nA338 — the requeue happens once per sale');
db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id)
            VALUES ('sh-gone', 'biz-1', 'br-1', 'u-tom', ?, 'closed', 0, ?, 'synced', 'dev-T1')`).run(new Date().toISOString(), new Date().toISOString());
sale('o-loop', 'sh-gone');
db.prepare(`UPDATE sync_queue SET status='failed', attempts=5, last_error='This sale references a record the server does not have. It cannot be accepted as-is.' WHERE order_id='o-loop'`).run();
cloud.migrated = false;   // this drawer keeps failing its foreign key (e.g. deleted on the cloud)
const r1 = E.requeueAfterDrawerClash();
ok('an FK-failed sale on a drawer the till has synced is requeued', r1.orders === 1 && q('o-loop').status === 'pending');
await passes(5);
const r2 = E.requeueAfterDrawerClash();
ok('a sale that fails again is not requeued twice (no endless loop)', q('o-loop').status === 'failed' && r2.orders === 0,
  JSON.stringify({ q: q('o-loop'), r2 }));
ok('a healthy till: the requeue matches nothing', JSON.stringify(E.requeueAfterDrawerClash()) === '{"shifts":0,"floats":0,"expenses":0,"orders":0}');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
