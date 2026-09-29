// A365 (2026-09-29) — a manager confirms every cashier's shift, on every payment method; desktop 0.6.22.
// Owner: "the managers should confirm shift before closing the day … They can confirm anytime but recommended the moment
// the cashier closes … it should block … They should recount incase the cashier submitted less than the amount … applies
// to both … on all payment method not just mpesa"; a manager's own shift: "allowed, flagged".
//
// Drives the REAL compiled dist/main (shiftService, dayService, syncEngine) on a REAL SQLite file, electron shimmed,
// against a stand-in cloud; then the real shared helper src/shared/shiftConfirm.ts (type-stripped) and pins the
// screens that use it (React is not run).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/shift-confirm.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - closeShift not storing declared_methods              → "the cashier's declaration is stored" fails
//   - closeDayCore without the SHIFTS_UNCONFIRMED refusal  → "Close Day refuses while a shift awaits" fails
//   - confirmShift without the confirmed_at check          → "a second confirmation is refused" fails
//   - confirmShift without the missing-method check        → "a recount must cover every declared method" fails
//   - the 'confirm' sync stage left out                    → "the confirmation reaches the cloud" fails
//   - reconcile not sending declared_methods               → "the close carries the declaration" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.SHIFT_CONFIRM_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, SHIFT_CONFIRM_TS: '1' } });
  process.exit(r.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a365-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
const D = require(path.join(dist, 'dayService.js'));
const E = require(path.join(dist, 'syncEngine.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Your Business', '2026-09-29T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-test', 'Test Cashier'), ('u-mary', 'Mary')`).run();
const signIn = (id, name, role, perms = '{}') => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-09-29T06:00:00Z')`).run(id, name, role, perms);
let n = 0;
const sale = (shiftId, method, amount) => {
  const id = `o${++n}`;
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, ?, ?, 'synced', 'dev-T1')`).run(id, id, amount, amount, shiftId, new Date().toISOString());
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`p-${id}`, id, method, amount, amount, new Date().toISOString());
};
const row = (id) => db.prepare(`SELECT * FROM shifts WHERE id=?`).get(id);

// ── The stand-in cloud: records the close and the confirmation ──
const cloud = { closes: [], confirms: [] };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  if (u.endsWith('/api/sync/push')) return json(200, { ok: true, rejected: [] });
  if (u.endsWith('/close')) { cloud.closes.push(body); return json(200, {}); }
  if (u.endsWith('/confirm') && cloud.notDeployed) return json(404, { error: 'Not found' });
  if (u.endsWith('/confirm')) {
    if (cloud.confirms.length && cloud.confirms.some((c) => c.id === u)) return json(409, { code: 'ALREADY_CONFIRMED' });
    cloud.confirms.push({ id: u, ...body }); return json(200, {});
  }
  return json(200, { orders: [] });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');

console.log('A365 — a manager confirms every shift, on every method\n');
ok('local schema 57: the confirmation columns exist on shifts', L.LOCAL_SCHEMA_VERSION === 57
  && ['declared_methods', 'expected_methods', 'confirmed_methods', 'confirmed_by', 'confirmed_at', 'confirm_self', 'confirm_sync']
    .every((c) => db.prepare(`PRAGMA table_info(shifts)`).all().some((x) => x.name === c)));

// Test Cashier: float 2000, 500 cash, 3250 M-Pesa, 700 card. Declares cash 2500, M-Pesa 3250, card 0 (forgot the card).
signIn('u-test', 'Test Cashier', 'cashier');
const sh = S.openShift(2000);
sale(sh.id, 'cash', 500); sale(sh.id, 'mpesa', 3250); sale(sh.id, 'card', 700);
const z = S.closeShift(2500, undefined, null, { MPESA: 3250, card: 0, cash: 1 });
ok('the cashier\'s declaration is stored — every method, cash = the counted drawer',
  JSON.stringify(JSON.parse(row(sh.id).declared_methods)) === JSON.stringify({ mpesa: 3250, card: 0, cash: 2500 }), row(sh.id).declared_methods);
ok('the Z-report says it awaits a manager', z.confirmation?.status === 'awaiting', JSON.stringify(z.confirmation));
ok('it is listed as awaiting a manager', S.awaitingConfirmation().map((a) => a.id).join() === sh.id
  && S.awaitingConfirmation()[0].cashier_name === 'Test Cashier');

signIn('u-mary', 'Mary', 'manager');
const refused = threw(() => D.closeDay(2500));
ok('Close Day refuses while a shift awaits a manager — and names it',
  refused?.code === 'SHIFTS_UNCONFIRMED' && /A shift must be confirmed by a manager before the day can close: Test Cashier \d\d:\d\d–\d\d:\d\d\./.test(refused.message),
  refused?.message);
ok('the day is still open', D.getOpenDay()?.status === 'open');

ok('a recount must cover every declared method', /Enter the counted amount for: card, mpesa/.test(threw(() => S.confirmShift(sh.id, { id: 'u-mary', name: 'Mary' }, { cash: 2400 }))?.message ?? ''));
ok('an open shift cannot be confirmed', !!threw(() => { signIn('u-test', 'Test Cashier', 'cashier'); const o = S.openShift(100); try { S.confirmShift(o.id, { id: 'u-mary', name: 'Mary' }, { cash: 100 }); } finally { S.closeShift(100, undefined, null, {}); } }));
// that extra shift is closed with a declaration too — confirm it straight away so it does not block the day below
const extra = S.awaitingConfirmation().find((a) => a.id !== sh.id);
S.confirmShift(extra.id, { id: 'u-mary', name: 'Mary' }, { cash: 100 });

const c = S.confirmShift(sh.id, { id: 'u-mary', name: 'Mary' }, { cash: 2400, mpesa: 3250, card: 700 });
const line = (m) => c.lines.find((l) => l.method === m);
ok('the manager\'s blind recount: cash 2400 against 2500 expected → short 100',
  line('cash').confirmed === 2400 && line('cash').expected === 2500 && line('cash').variance === -100, JSON.stringify(line('cash')));
ok('…and it differs from the cashier\'s 2500 (flagged)', line('cash').mismatch === true && line('cash').declared === 2500);
ok('card: the cashier declared 0, the manager found 700 = expected (flagged, no variance)',
  line('card').mismatch === true && line('card').variance === 0 && line('card').expected === 700);
ok('M-Pesa agrees all round', line('mpesa').mismatch === false && line('mpesa').variance === 0);
ok('not self-confirmed (Mary did not work it)', c.self === false && row(sh.id).confirm_self === 0);
ok('a second confirmation is refused', /already confirmed/.test(threw(() => S.confirmShift(sh.id, { id: 'u-owner', name: 'Owner' }, { cash: 2500, mpesa: 3250, card: 700 }))?.message ?? ''));
ok('nothing awaits now', S.awaitingConfirmation().length === 0);
const zc = S.computeZReport(sh.id);
ok('the Z-report carries the confirmation: who, lines', zc.confirmation?.status === 'confirmed' && zc.confirmation.confirmed_by_name === 'Mary'
  && zc.confirmation.lines.length === 3, JSON.stringify(zc.confirmation));

signIn('u-mary', 'Mary', 'manager');
const closed = D.closeDay(2500);
ok('Close Day then goes through', closed.day.status === 'closed');

// A manager confirming their own shift: allowed, flagged.
signIn('u-mary', 'Mary', 'manager');
const own = S.openShift(1000);
S.closeShift(1000, undefined, null, {});
const oc = S.confirmShift(own.id, { id: 'u-mary', name: 'Mary' }, { cash: 1000 });
ok('a manager confirming a shift they worked: allowed, self-confirmed', oc.self === true && row(own.id).confirm_self === 1);

// A shift closed the old way (no declaration — an older build) never waits.
const legacy = S.openShift(500);
S.closeShift(500);
ok('a close without a declaration (older build) never awaits a manager', !S.awaitingConfirmation().some((a) => a.id === legacy.id)
  && S.computeZReport(legacy.id).confirmation === null);

// ── Sync: the close carries the declaration; then the confirmation (after the close) ──
// First against a cloud not yet deployed with /confirm (404): the confirmation must wait, not be parked.
cloud.notDeployed = true;
await E.syncPush(); await E.syncPush();
ok('a cloud without /confirm yet (404): the confirmation waits, it is not parked', row(sh.id).confirm_sync === 'pending', row(sh.id).confirm_sync);
cloud.notDeployed = false;
await E.syncPush();
const sent = cloud.closes.find((b) => b.declared_methods && b.declared_methods.mpesa === 3250);
ok('the close carries the declaration to the cloud', !!sent && sent.declared_methods.cash === 2500, JSON.stringify(cloud.closes));
ok('the legacy close carries none', cloud.closes.some((b) => b.closing_float === 500 && !('declared_methods' in b)));
await E.syncPush();
const conf = cloud.confirms.find((x) => x.id.includes(sh.id));
ok('the confirmation reaches the cloud: the manager, the till\'s time and figures',
  !!conf && conf.confirmed_by === 'u-mary' && conf.confirmed_methods.cash === 2400 && conf.expected_methods.card === 700
  && conf.confirmed_at === row(sh.id).confirmed_at, JSON.stringify(cloud.confirms));
ok('…and is marked sent (never twice)', row(sh.id).confirm_sync === 'synced');
const before = cloud.confirms.length;
await E.syncPush();
ok('a later pass sends nothing again', cloud.confirms.length === before);

// ── The renderer helper (type-stripped) ──
const H = await import(pathToFileURL(path.join(here, '..', 'src/shared/shiftConfirm.ts')).href);
ok('methods to declare: M-Pesa, card, Glovo, every custom tender, plus any the shift took — never cash',
  JSON.stringify(H.methodsToDeclare([{ code: 'cash', name: 'Cash' }, { code: 'Voucher', name: 'Voucher' }], [{ method: 'bank' }, { method: 'cash' }])) === '["bank","card","glovo","mpesa","voucher"]');
ok('every method must be entered (0 is an answer, blank is not)',
  JSON.stringify(H.readAmounts({ card: '0', mpesa: '' }, ['card', 'mpesa'])) === '{"ok":false,"missing":["mpesa"]}'
  && JSON.stringify(H.readAmounts({ card: '0', mpesa: '3250.004' }, ['card', 'mpesa'])) === '{"ok":true,"map":{"card":0,"mpesa":3250}}');
ok('labels: awaiting / confirmed by … (self-confirmed)',
  H.confirmationLabel({ status: 'awaiting' }) === 'Awaiting manager check'
  && /^Confirmed by Mary \d\d:\d\d \(self-confirmed\)$/.test(H.confirmationLabel({ status: 'confirmed', confirmed_by_name: 'Mary', confirmed_at: new Date().toISOString(), self: true })));
const pl = H.confirmationPrintLines(zc.confirmation, (x) => String(x));
ok('the printed lines spell out the shortage and the cashier\'s different figure',
  pl[0].startsWith('CONFIRMED BY MARY') && pl.includes('Cash: counted 2400 / expected 2500 (short 100)') && pl.includes('  cashier said 2500'), JSON.stringify(pl));

// ── The screens (pinned; React is not run) ──
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
ok('End Shift asks for every other method and sends them with the close',
  /toDeclare\.map\(\(m\) => \(/.test(src('renderer/pages/ShiftPanel.tsx'))
  && /posApi\.shift\.close\(counted, closeNotes\.trim\(\) \|\| undefined, declaredRead\.map\)/.test(src('renderer/pages/ShiftPanel.tsx')));
ok('the closed shift offers "Manager: confirm now"', /data-testid="confirm-now"/.test(src('renderer/pages/ShiftPanel.tsx')));
ok('the confirm screen is blind: no expected or cashier figure before it is saved',
  !/expected|declared/i.test(src('renderer/components/ConfirmShiftModal.tsx').split('{!result && (')[1].split('{result && (')[0]));
ok('Close lists the shifts awaiting a manager and holds the close button',
  /data-testid="awaiting-shifts"/.test(src('renderer/pages/DayCloseTab.tsx'))
  && /disabled=\{!isManager \|\| busy \|\| counted === '' \|\| awaiting\.length > 0\}/.test(src('renderer/pages/DayCloseTab.tsx')));
ok('the till checks the PIN with an authority first; its saved sign-ins only when none answers',
  /ownerFetch\('\/api\/shifts\/confirmer'/.test(src('main/ipcHandlers.ts')) && /verifyPinOffline\(pin, branchId\)/.test(src('main/ipcHandlers.ts')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
