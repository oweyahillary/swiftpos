// A364 (2026-09-29) — a day close is a cash-up, never the end of trading for the date; desktop 0.6.21.
// Owner, T1: closed the morning shift, the day was closed, and the next cashier's "Start selling" failed with
// "That record already exists." (a second day row for the same date — business_days_till_date). Owner: shifts follow the
// staff's hours (9–5, 2–10, 5–midnight) and a day "should not even limit" them; overlapping cashiers use different tills.
//
// Drives the REAL compiled dist/main/shiftService.js + dayService.js on a REAL SQLite file, electron shimmed.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/day-reopen.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - ensureDayOpen without the closed-today reopen         → "a shift opens after the day was closed" fails (the bug)
//   - getDayCloseSummary without the `opened_at >= since`    → "the second cash-up counts only the shifts since" fails
//   - closeDayCore storing this cash-up alone (no prior)     → "the row carries the whole day" fails
//   - day_reopened missing from the event whitelist          → emitEvent throws → "a shift opens …" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a364-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
const D = require(path.join(dist, 'dayService.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Your Business', '2026-09-29T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://x', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
const signIn = (id, name, role, perms = '{}') => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-09-29T06:00:00Z')`).run(id, name, role, perms);
const cashSale = (id, shiftId, amount) => {
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, ?, ?, 'pending')`).run(id, `T1-${id}`, amount, amount, shiftId, new Date().toISOString());
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, 'cash', ?, ?, ?)`)
    .run(`p-${id}`, id, amount, amount, new Date().toISOString());
};
const days = () => db.prepare(`SELECT * FROM business_days WHERE device_id='dev-T1'`).all();
const events = (kind) => db.prepare(`SELECT * FROM events WHERE kind=?`).all(kind);

console.log('A364 — a day close is a cash-up; a later shift reopens the day\n');

// Morning: Eugene 2000 float, 500 cash, closes at 2500. A manager cashes up the day.
signIn('u-eugene', 'Eugene', 'cashier');
const morning = S.openShift(2000);
db.prepare(`UPDATE shifts SET opened_at = ? WHERE id = ?`).run(new Date(Date.now() - 3_600_000).toISOString(), morning.id);
cashSale('o1', morning.id, 500);
S.closeShift(2500);
signIn('u-mgr', 'Mary', 'manager');
const first = D.closeDay(2500);
ok('the morning cash-up: counted 2500, expected 2500', first.countedCash === 2500 && first.expectedCash === 2500, JSON.stringify(first));
const dayId = first.day.id;

// Afternoon: Test Cashier opens with 2000 — this is what failed on T1 ("That record already exists.").
signIn('u-test', 'Test Cashier', 'cashier');
let afternoon = null;
const err = threw(() => { afternoon = S.openShift(2000); });
ok('a shift opens after the day was closed (was: "That record already exists.")', !err && afternoon?.status === 'open', err?.message);
ok('…on the SAME day row — still one day per till per date (the cloud upserts it by id)',
  days().length === 1 && afternoon?.business_day_id === dayId, JSON.stringify(days().map(d => d.id)));
const reopened = days()[0];
ok('the day is open again, pending sync, the close fields cleared',
  reopened.status === 'open' && reopened.sync_status === 'pending' && reopened.closed_at === null && reopened.counted_cash === null,
  JSON.stringify(reopened));
ok('the earlier cash-up is kept in the notes, with who reopened it',
  /^Cashed up \d\d:\d\d: counted 2500, expected 2500, variance 0\. Reopened \d\d:\d\d by Test Cashier for a new shift\./.test(reopened.notes ?? ''),
  reopened.notes);
ok('a day_reopened event carries it to the branch replicas', events('day_reopened').length === 1
  && JSON.parse(events('day_reopened')[0].payload).status === 'open');
ok('the till can trade', D.checkDayGate().canTrade === true);

// Evening cash-up: 300 cash on the afternoon shift, closed at 2300.
cashSale('o2', afternoon.id, 300);
S.closeShift(2300);
const summary = D.getDayCloseSummary();
ok('the second cash-up counts only the shifts since the reopen (not the morning cash again)',
  summary.shifts === 1 && summary.expectedCash === 2300, JSON.stringify(summary));
signIn('u-mgr', 'Mary', 'manager');
const second = D.closeDay(2250);
ok('the manager sees this cash-up alone: counted 2250 vs expected 2300 → −50', second.countedCash === 2250 && second.variance === -50,
  JSON.stringify({ c: second.countedCash, v: second.variance }));
const closed = days()[0];
ok('the row carries the whole day: counted 4750, expected 4800, variance −50',
  closed.status === 'closed' && closed.counted_cash === 4750 && closed.expected_cash === 4800 && closed.cash_variance === -50,
  JSON.stringify(closed));
const lastClosed = events('day_closed').at(-1);
ok('the day_closed event carries the whole notes (a replica keeps the earlier cash-up line)',
  /Cashed up/.test(JSON.parse(lastClosed.payload).notes ?? '') && JSON.parse(lastClosed.payload).counted_cash === 4750, lastClosed.payload);

// Late shift: reopens again; the running totals carry on.
signIn('u-late', 'Late Cashier', 'cashier');
const late = S.openShift(1000);
ok('a third shift the same date reopens the day again', late?.business_day_id === dayId && days().length === 1 && days()[0].status === 'open');
ok('…and the running totals include both earlier cash-ups', D.reopenState(dayId)?.counted === 4750 && D.reopenState(dayId)?.expected === 4800,
  JSON.stringify(D.reopenState(dayId)));

// Still enforced: one shift per till at a time; the stale-yesterday lock.
ok('a second shift on the same till while one is open is still refused', !!threw(() => S.openShift(500)));
S.closeShift(1000);
db.prepare(`UPDATE business_days SET business_date = '2026-01-01' WHERE id = ?`).run(dayId);
ok('an unclosed earlier day still blocks a new shift (a manager must close it)', /never closed/.test(threw(() => S.openShift(500))?.message ?? ''));

const tab = fs.readFileSync(path.join(here, '..', 'src/renderer/pages/DayCloseTab.tsx'), 'utf8');
ok('the Day Close screen says it is a cash-up and a later shift reopens the day',
  /data-testid="day-close-cashup"[^>]*>\s*This is a cash-up\. A shift opened later today reopens the day/.test(tab));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
