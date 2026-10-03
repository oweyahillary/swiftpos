// 0.6.34 — the business day ends at the owner's cut-off ("Business day ends at", 00:00–06:00), not at midnight.
//
// Owner, 2026-10-03: a hotel bar trading past midnight was locked at 00:00 — "Trading day … was never closed. A manager
// must count the cash and close it" — mid-service. Drives the REAL compiled dist/main (localDb, deviceConfig,
// shiftService, dayService, managerReports) on a REAL SQLite file, with the clock set by the test (Nairobi time).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/business-day.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - businessDateNow ignores the cut-off                 → "01:30 still sells (yesterday's business day)" fails
//   - the grace counts from midnight again               → "24-hour operation: the grace runs from the cut-off" fails
//   - History's "today" starts at midnight               → "History's Today at 01:30 starts at yesterday's 04:00" fails
//   - setBusinessDayCutoff accepts 07:00                  → "a cut-off past 06:00 is ignored" fails
process.env.TZ = 'Africa/Nairobi';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The clock: every `new Date()` / Date.now() in the till reads NOW.
const RealDate = Date;
let NOW = new RealDate('2026-10-02T20:00:00+03:00').getTime();
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
};
const at = (s) => { NOW = new RealDate(s).getTime(); };

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0634-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const S = require(path.join(dist, 'shiftService.js'));
const D = require(path.join(dist, 'dayService.js'));
const M = require(path.join(dist, 'managerReports.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Hotel', '2026-10-02T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://x', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Bar' });
db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-amy', 'Amy', 'cashier', '{}', 'br-1', 'tok', '2026-10-02T17:00:00Z')`).run();

console.log('0.6.34 — the business day ends at the owner\'s cut-off\n');

ok('local schema 64: device_config.business_day_cutoff', L.LOCAL_SCHEMA_VERSION >= 64
  && db.prepare(`PRAGMA table_info(device_config)`).all().some((c) => c.name === 'business_day_cutoff'));
ok('never told → midnight (0), as every till before', C.getBusinessDayCutoff() === 0);
C.setBusinessDayCutoff(420);
ok('a cut-off past 06:00 is ignored', C.getBusinessDayCutoff() === 0);
C.setBusinessDayCutoff('04:00');
ok('the pull sets it (04:00 = 240)', C.getBusinessDayCutoff() === 240);
C.setBusinessDayCutoff(undefined);
ok('an older cloud saying nothing keeps it', C.getBusinessDayCutoff() === 240);
C.saveDeviceConfig({ device_name: 'Bar 2' });
ok('config:save never moves it (only the pull writes it)', C.getBusinessDayCutoff() === 240);

// Friday 20:00 — the bar opens its shift: Friday's business day.
at('2026-10-02T20:00:00+03:00');
S.openShift(2000);
ok('the evening opens Friday\'s business day', D.businessDateNow() === '2026-10-02' && D.checkDayGate().canTrade === true);

at('2026-10-03T01:30:00+03:00');
ok('01:30 Saturday still sells (yesterday\'s business day — no lock mid-service)',
  D.businessDateNow() === '2026-10-02' && D.checkDayGate().canTrade === true, JSON.stringify(D.checkDayGate()));
const hist = M.resolveRange('today');
ok('History\'s Today at 01:30 starts at yesterday\'s 04:00 (the evening is on screen)',
  hist.from === new RealDate('2026-10-02T04:00:00+03:00').toISOString(), JSON.stringify(hist));

at('2026-10-03T04:30:00+03:00');
const g = D.checkDayGate();
ok('after the cut-off (04:30) the day must be closed — a manager closes it, as before', g.canTrade === false && g.needsManager === true, JSON.stringify(g));

// 24-hour operation: the 2-hour grace runs from the cut-off (04:00 → 06:00), not from midnight.
C.saveDeviceConfig({ continuous_operation: true });
at('2026-10-03T05:30:00+03:00');
ok('24-hour operation: the grace runs from the cut-off (05:30 still sells)', D.checkDayGate().canTrade === true, JSON.stringify(D.checkDayGate()));
at('2026-10-03T06:30:00+03:00');
ok('…and ends 2 hours after it (06:30 locks)', D.checkDayGate().canTrade === false);
C.saveDeviceConfig({ continuous_operation: false });

// The default (midnight) is exactly as before: 00:30 locks.
C.setBusinessDayCutoff(0);
at('2026-10-03T00:30:00+03:00');
ok('midnight (the default): 00:30 locks, as before 0.6.34', D.businessDateNow() === '2026-10-03' && D.checkDayGate().canTrade === false);
ok('…and History\'s Today starts at midnight', M.resolveRange('today').from === new RealDate('2026-10-03T00:00:00+03:00').toISOString());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
