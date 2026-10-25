// A523 — empty days close themselves; a till that comes back learns what the cloud closed before it decides it is locked.
// Owner, 2026-10-17: "I don't want this back and forth, clients not being able to do simple tasks day to day operations,
// to make it worse there is no location on the cloud where I can close day as the owner or tech support remote force
// close."
//
// Drives the REAL compiled dist/main (dayService, branchClose, shiftService, syncEngine, remoteShiftClose, the IPC
// handlers) on a REAL SQLite file, electron shimmed, a stand-in cloud answering fetch.
//
//   cd apps/desktop && npm run build:main && node test/self-closing-days-a523.test.mjs
//
//   1 an OLD day with nothing left to count (no drawer open, every shift confirmed — or none, or force-closed) closes
//     itself at the day gate: the confirmed shifts' cash (A452), closed_by NULL, the note, pushed; the new day starts with
//     a cashier signed in (no manager)
//   2 an old day with money (a drawer open, a shift to confirm) still locks, with A520's wording; today's day is untouched
//   3 a web force-close and a web day close are learned BEFORE the gate decides (day:gate), the drawer first, then the
//     day; the till keeps its own figures
//   4 the day-close ack carries the code (DRAWER_OPEN / SHIFTS_UNCONFIRMED) and the wait flag
//   5 the wiring: at start-up before the push, on the 90 s beat, at most once a minute from the gate
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main and re-running):
//   - checkDayGate without the autoCloseEmptyDay loop                        → "#1 …closes itself" fails
//   - autoCloseEmptyDay without the unconfirmed-shift check                  → "#2 …quietly: a day that needs a manager is not
//     tried" fails (closeDayCore still refuses it — the lock stands — but every gate read logged a failed close)
//   - autoCloseEmptyDay without the open-drawer check (liveOnDay)            → "#2 any drawer still open on the old day" fails
//   - the day:gate handler without learnBeforeLock                           → "#3 …learned before the gate" fails
//   - learnCloudCloses without pullShiftCloses                               → "#3 …the drawer first" fails
//   - the ack body without `code`                                             → "#4 …DRAWER_OPEN" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a523-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.18', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('E:' + s), decryptString: (b) => b.toString().replace(/^E:/, '') },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

// The stand-in cloud: what it says about this till's drawers and its waiting day closes; every request kept.
const cloud = { asked: [], acks: [], shiftState: () => [], pending: () => [] };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  cloud.asked.push(`${init.method ?? 'GET'} ${u.pathname}`);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/api/shifts/state') return json(cloud.shiftState((u.searchParams.get('ids') ?? '').split(',')));
  if (u.pathname === '/api/day-close/pending') return json(cloud.pending());
  if (u.pathname === '/api/day-close/ack') { cloud.acks.push(JSON.parse(init.body)); return json({ ok: true }); }
  return json({ error: 'not in this test' }, 503);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

process.env.SWIFTPOS_NODE_PORT = String(41000 + Math.floor(Math.random() * 15000));
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-T1', 'biz-1', 'KRUNCH & CO', '2026-10-17T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.test', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till',
  terminal_code: 'T1', device_name: 'Front', node_url: null });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-mary', 'Mary'), ('u-joe', 'Joe')`).run();
const signIn = (id, name, role, perms) => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-17T06:00:00Z')`).run(id, name, role, JSON.stringify(perms));
const CASHIER = { 'orders.create': true };   // no shifts.close_day — nobody who could lift a lock
signIn('u-joe', 'Joe', 'Cashier', CASHIER);
const Dy = require(path.join(dist, 'dayService.js'));
const B = require(path.join(dist, 'branchClose.js'));
const S = require(path.join(dist, 'shiftService.js'));
const E = require(path.join(dist, 'syncEngine.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
E.configureSyncEngine('http://cloud.test', 'device-token');

const DAY_MS = 86_400_000;
const today = Dy.businessDateNow();
const yesterday = Dy.businessDateNow(new Date(Date.now() - DAY_MS));
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const clean = () => { db.prepare(`DELETE FROM shifts`).run(); db.prepare(`DELETE FROM business_days`).run(); cloud.asked = []; cloud.acks = []; cloud.shiftState = () => []; cloud.pending = () => []; };
const openDay = (id, date) => db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, opened_by, status, created_at, sync_status)
  VALUES (?, 'biz-1', 'br-1', 'dev-T1', 'T1', ?, ?, 'u-joe', 'open', ?, 'synced')`).run(id, date, iso(DAY_MS), iso(DAY_MS));
const shiftRow = (o) => {
  const r = { id: 'sh', status: 'closed', opening_float: 2500, closing_float: null, expected_cash: null, declared_methods: null, confirmed_at: null, confirmed_methods: null,
    closed_at: iso(DAY_MS - 3_600_000), day: 'd', ...o };
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, closed_at, status, opening_float, closing_float, expected_cash, created_at, sync_status,
      device_id, terminal_code, business_day_id, declared_methods, confirmed_at, confirmed_methods)
    VALUES (?, 'biz-1', 'br-1', 'u-joe', ?, ?, ?, ?, ?, ?, ?, 'synced', 'dev-T1', 'T1', ?, ?, ?, ?)`)
    .run(r.id, iso(DAY_MS), r.status === 'open' ? null : r.closed_at, r.status, r.opening_float, r.closing_float, r.expected_cash, iso(DAY_MS), r.day,
      r.declared_methods ? JSON.stringify(r.declared_methods) : null, r.confirmed_at, r.confirmed_methods ? JSON.stringify(r.confirmed_methods) : null);
};
const dayRow = (id) => db.prepare(`SELECT * FROM business_days WHERE id = ?`).get(id);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#1 an old day with nothing left to count closes itself — no manager\n');
{
  clean();
  openDay('d-1', yesterday);
  shiftRow({ id: 'sh-1', day: 'd-1', closing_float: 3450, expected_cash: 3500, declared_methods: { cash: 3450 }, confirmed_at: iso(DAY_MS - 4e6), confirmed_methods: { cash: 3400 } });
  const gate = Dy.checkDayGate();
  const d = dayRow('d-1');
  ok('#1 yesterday\'s day, its one shift confirmed: the gate does not lock (no manager needed)', !gate.needsManager && gate.needsShift === true, JSON.stringify(gate));
  ok('#1 …it closes itself: closed, closed_by NULL, the note', d.status === 'closed' && d.closed_by === null && d.notes.includes(Dy.AUTO_CLOSE_NOTE), JSON.stringify(d));
  ok('#1 …counted = the confirmed shifts\' cash (A452), expected = the shifts\', the difference between them', d.counted_cash === 3400 && d.expected_cash === 3500 && d.cash_variance === -100, JSON.stringify(d));
  ok('#1 …and it goes up to the cloud like any close (pending)', d.sync_status === 'pending');
  ok('#1 …the note reads "closed automatically — nothing left to count"', /Closed automatically — nothing left to count/.test(Dy.AUTO_CLOSE_NOTE));
  const sh = S.openShift(1000);
  const nd = Dy.getOpenDay();
  ok('#1 the cashier (no manager signed in) opens the next drawer: today\'s day starts', !!sh && nd?.business_date === today && nd.id !== 'd-1', JSON.stringify(nd));
  const logPath = require(path.join(dist, 'logFile.js')).getLogPath();
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  ok('#1 …logged (the till\'s log: which day, its shifts, the cash)',
    log.includes(`[day] trading day ${yesterday} closed automatically — nothing left to count (1 shift(s), confirmed cash 3400, expected 3500)`), logPath);

  clean();
  openDay('d-2', yesterday);
  ok('#1 a day opened and never traded (no shifts) closes itself too, at 0', !Dy.checkDayGate().needsManager && dayRow('d-2').status === 'closed' && dayRow('d-2').counted_cash === 0);
  clean();
  openDay('d-3', yesterday);
  shiftRow({ id: 'sh-3', day: 'd-3', status: 'closed_unreconciled', expected_cash: 4200 });
  const g3 = Dy.checkDayGate();
  ok('#1 a day whose only drawer was force-closed (nothing to confirm) closes itself — nothing counted, the shortfall shown',
    !g3.needsManager && dayRow('d-3').status === 'closed' && dayRow('d-3').counted_cash === 0 && dayRow('d-3').expected_cash === 4200, JSON.stringify(dayRow('d-3')));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#2 money still needs a manager — and today is never touched\n');
{
  clean();
  openDay('d-4', yesterday);
  shiftRow({ id: 'sh-4', day: 'd-4', status: 'open' });
  const g = Dy.checkDayGate();
  ok('#2 a drawer open on the old day still locks (a manager counts it)', g.needsManager === true && dayRow('d-4').status === 'open', JSON.stringify(g));
  ok('#2 …with the A520 wording (where to close it)',
    g.reason === `Trading day ${yesterday} was never closed on this POS. A manager must count the cash and close it before ${today} can start — a manager signs in here and closes it in Manager › Close › Close Day.`, g.reason);
  db.prepare(`UPDATE shifts SET business_day_id = NULL WHERE id = 'sh-4'`).run();   // the till's drawer open, on no day
  ok('#2 this till\'s drawer open (on any day) still locks', Dy.checkDayGate().needsManager === true && dayRow('d-4').status === 'open');
  clean();
  openDay('d-5', yesterday);
  shiftRow({ id: 'sh-5', day: 'd-5', closing_float: 900, expected_cash: 900, declared_methods: { cash: 900 } });
  ok('#2 a shift to confirm still locks (a manager confirms it)', Dy.checkDayGate().needsManager === true && dayRow('d-5').status === 'open');
  const logNow = fs.readFileSync(require(path.join(dist, 'logFile.js')).getLogPath(), 'utf8');
  ok('#2 …quietly: a day that needs a manager is not tried (no "could not close itself" at every gate read)', !/could not close itself/.test(logNow));
  clean();
  openDay('d-5b', yesterday);
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id, business_day_id)
    VALUES ('sh-web', 'biz-1', 'br-1', 'u-joe', ?, 'open', 0, ?, 'synced', NULL, 'd-5b')`).run(iso(DAY_MS), iso(DAY_MS));
  ok('#2 any drawer still open on the old day (not this till\'s own — a web stand-in) still locks', Dy.checkDayGate().needsManager === true && dayRow('d-5b').status === 'open');
  clean();
  openDay('d-6', today);
  Dy.checkDayGate();
  ok('#2 today\'s day, empty, stays open (only an OLD day closes itself)', dayRow('d-6').status === 'open');
  ok('#2 autoCloseEmptyDay of today is refused', Dy.autoCloseEmptyDay(dayRow('d-6')) === null && dayRow('d-6').status === 'open');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#3 a web force-close and a web day close are learned before the gate decides\n');
{
  clean();
  openDay('d-7', yesterday);
  shiftRow({ id: 'sh-7', day: 'd-7', status: 'open', opening_float: 1000 });
  ok('(before: the till would lock on its open drawer)', Dy.checkDayGate().needsManager === true);
  // The web force-closed the drawer and closed the day (Tills & days): the cloud says so.
  cloud.shiftState = (ids) => ids.filter((x) => x === 'sh-7').map((id) => ({ id, status: 'closed_unreconciled', closed_at: iso(3e6), close_method: 'forced',
    closed_by: 'u-mary', closed_by_name: 'Mary', closing_float: null, cash_variance: null, expected_cash: 1500, notes: 'Force-closed by manager: T1 off, cashier gone' }));
  cloud.pending = () => [{ id: 'ins-7', kind: 'close_day', payload: { business_date: yesterday, counted_cash: null, notes: 'Closed on the web by Mary: T1 off, cashier gone',
    closed_by_staff_id: 'u-mary', closed_by_name: 'Mary', wait_for_till: true, cloud_closed: { at: iso(3e6), by_name: 'Mary', counted_cash: 0, expected_cash: 1500 } } }];
  const gate = await H['day:gate'](null);
  const d = dayRow('d-7');
  const s = db.prepare(`SELECT * FROM shifts WHERE id = 'sh-7'`).get();
  ok('#3 day:gate asks the cloud first — the till is not locked after all', !gate.needsManager && gate.needsShift === true, JSON.stringify(gate));
  ok('#3 …the drawer first (the web\'s force-close adopted), then the waiting day close',
    cloud.asked.indexOf('GET /api/shifts/state') > -1 && cloud.asked.indexOf('GET /api/shifts/state') < cloud.asked.indexOf('GET /api/day-close/pending'), cloud.asked.join(' | '));
  ok('#3 …the drawer closed here uncounted, as on the web; its expected cash is the till\'s own (A521), not the web\'s 1500',
    s.status === 'closed_unreconciled' && s.closing_float === null && s.expected_cash === 1000 && s.sync_status === 'synced', JSON.stringify(s));
  ok('#3 …the day closed here, as the web\'s close — by the web\'s closer, the note says the till adopted it',
    d.status === 'closed' && d.closed_by === 'u-mary' && /Closed on the web by Mary — this POS adopted the web's close\./.test(d.notes ?? '') && /T1 off, cashier gone/.test(d.notes ?? ''), JSON.stringify(d));
  ok('#3 …on its own books (expected 1000 from its own drawer, counted the confirmed counts: 0)', d.expected_cash === 1000 && d.counted_cash === 0, JSON.stringify(d));
  ok('#3 …and the close acked to the cloud as done', cloud.acks.length === 1 && cloud.acks[0].instruction_id === 'ins-7' && cloud.acks[0].ok === true, JSON.stringify(cloud.acks));
  ok('#3 …the day goes up with the till\'s figures (pending — the cloud keeps one close)', d.sync_status === 'pending');

  // The gate asks at most once a minute — a lock screen re-reading never floods the cloud.
  cloud.asked = [];
  openDay('d-8', Dy.businessDateNow(new Date(Date.now() - 2 * DAY_MS)));
  shiftRow({ id: 'sh-8', day: 'd-8', status: 'open' });
  const again = await H['day:gate'](null);
  ok('#3 a second lock within the minute: not asked again (LEARN_EVERY_MS), the lock shown at once', again.needsManager === true && cloud.asked.length === 0, cloud.asked.join(' | '));
  ok('#3 …asked again after the minute', await E.learnBeforeLock(Date.now() + E.LEARN_EVERY_MS + 1) === true && cloud.asked.includes('GET /api/shifts/state'));
  ok('#3 …and never waits more than a few seconds on a slow line', E.LEARN_WAIT_MS <= 10_000);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#4 the day-close ack carries the code\n');
{
  clean();
  openDay('d-9', yesterday);
  shiftRow({ id: 'sh-9', day: 'd-9', status: 'open' });
  cloud.shiftState = () => [];   // the cloud has the drawer open too
  cloud.pending = () => [{ id: 'ins-9', kind: 'close_day', payload: { business_date: yesterday, counted_cash: null, wait_for_till: true } }];
  await E.learnCloudCloses();
  const a = cloud.acks[0];
  ok('#4 a drawer open here: "not yet" — ok false, code DRAWER_OPEN, wait true', a && a.ok === false && a.code === 'DRAWER_OPEN' && a.wait === true, JSON.stringify(a));
  clean();
  openDay('d-10', yesterday);
  shiftRow({ id: 'sh-10', day: 'd-10', closing_float: 900, expected_cash: 900, declared_methods: { cash: 900 } });
  cloud.pending = () => [{ id: 'ins-10', kind: 'close_day', payload: { business_date: yesterday, counted_cash: null, wait_for_till: true } }];
  await E.learnCloudCloses();
  ok('#4 a shift to confirm here: code SHIFTS_UNCONFIRMED, wait true', cloud.acks[0]?.code === 'SHIFTS_UNCONFIRMED' && cloud.acks[0]?.wait === true, JSON.stringify(cloud.acks));
  const plain = B.executeCloseDay({ business_date: yesterday, counted_cash: null });
  ok('#4 executeCloseDay names the code even without wait_for_till (and does not wait)', plain.code === 'SHIFTS_UNCONFIRMED' && plain.wait === undefined, JSON.stringify(plain));
  db.prepare(`UPDATE shifts SET status = 'open', closed_at = NULL WHERE id = 'sh-10'`).run();
  const dr = B.executeCloseDay({ business_date: yesterday, counted_cash: null });
  ok('#4 …DRAWER_OPEN for a drawer open', dr.code === 'DRAWER_OPEN' && dr.ok === false, JSON.stringify(dr));
  ok('#4 a real refusal has no code', B.executeCloseDay({ business_date: '2099-01-01', counted_cash: -1 }).code === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#5 the wiring\n');
{
  const idx = read('src/main/index.ts');
  ok('#5 at start-up: learned in the push step, before anything is pushed or the gate is read',
    /await testClearsBeforePush\(\);[\s\S]{0,400}await learnCloudCloses\(\);\s*\n\s*await nodeReplicationTick\(\);/.test(idx));
  const se = read('src/main/syncEngine.ts');
  ok('#5 the 90 s beat adopts the web\'s drawer closes before its day closes',
    /export async function remoteCloseBeat[\s\S]{0,600}pullShiftCloses\(\)[\s\S]{0,200}await runDayCloseInstructions\(\[\]\);/.test(se));
  ok('#5 learnCloudCloses: drawers, then confirmations, then the day closes',
    /export async function learnCloudCloses[\s\S]{0,300}pullShiftCloses\(\)[\s\S]{0,120}pullShiftConfirmations\(\)[\s\S]{0,120}runDayCloseInstructions\(\[\]\)/.test(se));
  const ipc = ipcHandlersSource();
  ok('#5 day:gate learns before it locks, then reads the gate again',
    /handle\('day:gate'[\s\S]{0,700}if \(gate\.needsManager && gate\.staleDay && await learnBeforeLock\(\)\) gate = checkDayGate\(\);/.test(ipc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
