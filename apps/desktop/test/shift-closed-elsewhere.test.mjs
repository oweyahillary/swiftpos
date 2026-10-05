// A401 — a drawer force-closed (or closed) on the web closes on the till too.
// Owner, 2026-10-05: "force close drawer on the web does not close desktop till it remains open".
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, syncEngine.pullShiftCloses + getOpenShift,
// remoteShiftClose) on a REAL SQLite file, with a stand-in cloud answering GET /api/shifts/state.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/shift-closed-elsewhere.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - closesToAdopt adopts a shift the cloud still has open          → "a shift still open on the cloud stays open" fails
//   - the local close left sync_status 'pending'                       → "marked synced" fails (the till would push a 2nd close)
//   - a forced close given the cloud's closing_float                   → "uncounted: no closing float" fails
//   - another till's shift adopted                                      → "only this till's open shifts are asked about" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a401-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const R = require(path.join(dist, 'remoteShiftClose.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

console.log('\nThe rule (pure)\n');
{
  const forced = { id: 'a', status: 'closed_unreconciled', closed_at: '2026-10-05T10:00:00Z', close_method: 'forced', closed_by: 'u-m',
    closed_by_name: 'Mary', closing_float: 999, cash_variance: 5, expected_cash: 4200, notes: 'Force-closed by manager: cashier went home' };
  const [c] = R.closesToAdopt(['a'], [forced]);
  ok('a force-close is adopted as uncounted: no closing float, no variance', c.status === 'closed_unreconciled' && c.closing_float === null && c.cash_variance === null && c.expected_cash === 4200, JSON.stringify(c));
  ok('the cashier is told who and why', c.message === 'This shift was force-closed on the web by Mary (cashier went home). Open a new shift to keep selling.', c.message);
  const counted = R.closesToAdopt(['b'], [{ id: 'b', status: 'closed', closed_at: 'x', close_method: null, closed_by: null, closing_float: '5000', cash_variance: '-20', expected_cash: '5020', notes: null }])[0];
  ok('a close with a count keeps the count', counted.status === 'closed' && counted.closing_float === 5000 && counted.cash_variance === -20, JSON.stringify(counted));
  ok('a shift still open on the cloud stays open; one not asked about is ignored',
    R.closesToAdopt(['a'], [{ ...forced, status: 'open' }]).length === 0 && R.closesToAdopt(['z'], [forced]).length === 0);
}

console.log('\nThe till, end to end\n');
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B Foods', '2026-10-05T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Left Till' });
const now = () => new Date().toISOString();
const shift = (id, dev) => db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id, terminal_code)
  VALUES (?, 'biz-1', 'br-1', 'u-c', ?, 'open', 3000, ?, 'synced', ?, 'T1')`).run(id, now(), now(), dev);
shift('sh-mine', 'dev-T1');
shift('sh-peer', 'dev-T2');

const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  const ids = new URL(String(url)).searchParams.get('ids').split(',');
  const rows = ids.map((id) => ({ id, status: 'closed_unreconciled', closed_at: '2026-10-05T11:00:00Z', close_method: 'forced', closed_by: 'u-m',
    closed_by_name: 'Mary', closing_float: null, cash_variance: null, expected_cash: 4200, notes: 'Force-closed by manager: drawer left open' }));
  return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
};
E.configureSyncEngine('http://cloud', 'device-token');
const told = [];
E.onShiftClosedElsewhere((c) => told.push(c));

ok('before: the till sells against its open shift', E.getOpenShift()?.id === 'sh-mine');
const n = await E.pullShiftCloses();
const row = db.prepare(`SELECT * FROM shifts WHERE id = 'sh-mine'`).get();
ok('the cloud is asked about this till\'s open shift only', asked.length === 1 && asked[0].includes('/api/shifts/state?ids=sh-mine') && !asked[0].includes('sh-peer'), asked.join(' '));
ok('the till\'s shift is closed — uncounted, as on the cloud', n === 1 && row.status === 'closed_unreconciled' && row.closing_float === null && row.close_method === 'forced', JSON.stringify(row));
ok('marked synced — the till never pushes a second close over the cloud\'s', row.sync_status === 'synced');
ok('the note says who closed it on the web and why', /Shift force-closed on the web by Mary — drawer left open\./.test(row.notes ?? ''), row.notes);
ok('selling stops: no open shift on this till', E.getOpenShift() === null);
ok('the screens are told', told.length === 1 && /Open a new shift/.test(told[0].message));
ok('another till\'s shift is untouched', db.prepare(`SELECT status FROM shifts WHERE id = 'sh-peer'`).get().status === 'open');
ok('nothing open → the cloud is not asked again', (await E.pullShiftCloses()) === 0 && asked.length === 1);

console.log('\nThe wiring (source)\n');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
ok('the 20-s beat runs it and every window hears it', /pullShiftCloses\(\)\.catch\(console\.error\);/.test(src('main/index.ts')) && /w\.webContents\.send\('shift:closedElsewhere'/.test(src('main/index.ts')));
ok('the till screen shows why and re-reads the shift', /posApi\.shift\.onClosedElsewhere\(\(e\) => \{\s*setClosedElsewhere\(e\.message\);\s*posApi\.shift\.current\(\)\.then\(setShift\)/.test(src('renderer/pages/POSPage.tsx')));
const cloud = fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'routes', 'shifts.ts'), 'utf8');
ok('the cloud answers for this business only, before /:id', /router\.get\('\/state'/.test(cloud) && /\.eq\('business_id', req\.businessId\)\.in\('id', ids\);/.test(cloud)
  && cloud.indexOf("router.get('/state'") < cloud.indexOf("router.get('/:id'"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
