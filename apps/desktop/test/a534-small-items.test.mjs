// A534 (2026-10-20) — four small 1.0.20 items. Owner: "add all of them since effort is small".
//
// Drives the REAL compiled dist/main (syncEngine's whole pull, branchStaff, updateReport + autoUpdate's runUpdateCheck,
// distributionLag) on a REAL SQLite file, electron shimmed, against a stand-in cloud on a real port.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/a534-small-items.test.mjs
//
//   1  staff names: the whole pull no longer asks GET /api/staff with the till's own token (Render, 2026-10-19:
//      "[tillScope] DRY-RUN would refuse … staff.view on GET /api/staff") — the names come from the till's own branch
//      staff list; a person who left keeps their name on the old reports.
//   2  the update state: sent only once the cloud says it takes it (reportsState on /api/desktop-update/status — an old
//      cloud without the field gets nothing), each state (downloading n%, downloaded since, failed and why), on a change
//      or every 30 minutes; the cloud refusing the route rests it 6 hours.
//   3  the branch server's distribution lag (register A23): what waits for the cloud by table (sales from its tills
//      counted), the oldest's age, the last push the cloud took, the runbook line.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
//   - syncEngine pullCatalogue asking /api/staff again (users from the answer)     → 1 "no GET /api/staff" fails
//   - branchStaff storeBranchStaff without mirrorRosterNames                         → 1 "names straight from the list" fails
//   - runUpdateCheck telling cloudReportsState(true) whatever the body says          → 2 "an old cloud … nothing" fails
//   - updateReport reportKey without the 25 % bucket (the raw percent)               → 2 "45 → 48 % sends nothing" fails
//   - updateReport tick without the REPORT_EVERY_MS resend                           → 2 "every 30 minutes" fails
//   - distributionLag counting only 'pending' sales (not 'failed')                   → 3 "6 sales wait" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a534-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, session: { fromPartition: () => ({}) }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (req === 'electron') return shim; return orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

// ── The stand-in cloud ───────────────────────────────────────────────────────────────────────────────────────────────
const BR = 'br-1';
const cloud = { hits: [] };
const staff = [
  { staff_id: 'u-eugene', name: 'Eugene', role_name: 'Cashier', branch_id: BR, permissions: { 'orders.create': true }, pin_hash: `$2b$10$${'e'.repeat(53)}`, override_pin_hash: null, status: 'active' },
  { staff_id: 'u-amina', name: 'Amina', role_name: 'Manager', branch_id: BR, permissions: { 'orders.create': true }, pin_hash: `$2b$10$${'a'.repeat(53)}`, override_pin_hash: null, status: 'active' },
];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  cloud.hits.push(`${req.method} ${u.pathname}`);
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'x-zaptill-server': '1' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/api/pos/init') return send(200, { products: [], categories: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
    vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'restaurant', businessName: 'KRUNCH', currency: 'KES' });
  if (u.pathname === '/api/staff') return send(200, [{ id: 'u-wrong', name: 'From /api/staff', roles: { name: 'X' }, status: 'active' }]);
  if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff });
  if (/\/api\/(inventory|tables|pumps|stations)/.test(u.pathname)) return send(200, []);
  return send(200, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const CLOUD = `http://127.0.0.1:${srv.address().port}`;

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-T1', 'biz-1', 'KRUNCH', '2026-10-20T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const BS = require(path.join(dist, 'branchStaff.js'));
const UR = require(path.join(dist, 'updateReport.js'));
const AU = require(path.join(dist, 'autoUpdate.js'));
const DL = require(path.join(dist, 'distributionLag.js'));
const userName = (id) => db.prepare(`SELECT name FROM users WHERE id = ?`).get(id)?.name ?? null;

console.log('A534 — four small 1.0.20 items\n');
try {
  // ── 1 ── staff names from the till's own staff list
  db.prepare(`INSERT OR REPLACE INTO users (id, name, role_name, status, synced_at) VALUES ('u-left', 'Wanjiku', 'Cashier', 'active', 'x')`).run();
  BS.storeBranchStaff(BR, staff);
  ok('the branch staff list names its people at once (users mirrored from it)', userName('u-eugene') === 'Eugene' && userName('u-amina') === 'Amina');
  db.prepare(`UPDATE users SET name = 'stale' WHERE id = 'u-eugene'`).run();
  cloud.hits = [];
  const r = await E.pullCatalogueNow();
  ok('the whole pull ran (the menu came)', r.pulled === true && cloud.hits.some((h) => h.startsWith('GET /api/pos/init')), JSON.stringify({ r, hits: cloud.hits }));
  ok('…and asked NO GET /api/staff (staff.view — a till\'s own sign-in does not hold it)', !cloud.hits.some((h) => h === 'GET /api/staff'), JSON.stringify(cloud.hits));
  ok('…the names come from the till\'s own list (Eugene, not the /api/staff answer)', userName('u-eugene') === 'Eugene' && userName('u-wrong') === null);
  ok('…a person who left keeps their name on the old reports (never cleared)', userName('u-left') === 'Wanjiku');
  const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8');
  ok('…and nothing in syncEngine asks /api/staff any more', !/syncFetch\(`\$\{_serverUrl\}\/api\/staff/.test(src));

  // ── 2 ── the update state
  // An old cloud: the status answer has no reportsState → the reporter stays off.
  const seen = [];
  const checkWith = (body) => AU.runUpdateCheck({
    updater: { setFeedURL() {}, requestHeaders: null, checkForUpdates: async () => null },
    fetch: async () => ({ ok: true, status: 200, json: async () => body }),
    cloudUrl: () => CLOUD, token: () => 'tok', refresh: async () => false, running: '1.0.20',
    cloudReportsState: (y) => seen.push(y),
  });
  await checkWith({ approvedVersion: '1.0.20', held: false });
  await checkWith({ approvedVersion: '1.0.20', held: false, reportsState: true });
  ok('the status answer: an old cloud (no reportsState) → false; this cloud → true', seen[0] === false && seen[1] === true, JSON.stringify(seen));

  let t = Date.parse('2026-10-20T14:00:00Z');
  const posts = [];
  let status = { state: 'idle', version: null, percent: null, note: 'up to date', checkedAt: '2026-10-20T13:59:00.000Z', approved: '1.0.20' };
  let stateAt = '2026-10-20T13:00:00.000Z', idleNote = null, answer = 204;
  const rep = UR.createUpdateReporter({
    build: () => UR.buildUpdateReport({ status, running: '1.0.19', stateAt, idleNote, task: true }),
    post: async (b) => { posts.push(b); return { status: answer }; },
    now: () => t,
  });
  ok('an old cloud (never told reportsState): nothing is sent', (await rep.tick()) === 'off' && posts.length === 0);
  rep.setCloudTakes(true);
  ok('told it takes it: the first report goes', (await rep.tick()) === 'sent' && posts.length === 1 && posts[0].state === 'idle' && posts[0].running === '1.0.19');
  t += 60_000;
  ok('nothing changed a minute later: nothing sent', (await rep.tick()) === 'same' && posts.length === 1);
  status = { ...status, state: 'downloading', version: '1.0.20', percent: 45 }; stateAt = '2026-10-20T14:01:00.000Z';
  t += 60_000; await rep.tick();
  ok('downloading 45 %: sent, with the version and the percent', posts.length === 2 && posts[1].state === 'downloading' && posts[1].percent === 45 && posts[1].version === '1.0.20');
  status = { ...status, percent: 48 }; t += 60_000;
  ok('45 → 48 % sends nothing (25 % steps)', (await rep.tick()) === 'same' && posts.length === 2);
  status = { ...status, percent: 76 }; t += 60_000; await rep.tick();
  ok('…76 % does', posts.length === 3 && posts[2].percent === 76);
  status = { ...status, state: 'downloaded', percent: 100, note: '1.0.20 downloaded — installs when ZapTill is closed' };
  stateAt = '2026-10-20T14:02:00.000Z'; idleNote = 'in use 3 min ago'; t += 60_000; await rep.tick();
  ok('downloaded: sent with since (14:02) and why it has not installed itself yet', posts.length === 4 && posts[3].state === 'downloaded'
    && posts[3].since === '2026-10-20T14:02:00.000Z' && posts[3].idle_note === 'in use 3 min ago' && posts[3].percent === null && posts[3].task === true);
  idleNote = 'in use 4 min ago'; t += 60_000;
  ok('…"in use 3 min ago" → "4 min ago" is the same reason: nothing sent', (await rep.tick()) === 'same' && posts.length === 4);
  t += 31 * 60_000; await rep.tick();
  ok('…and again every 30 minutes while nothing changes (the cloud knows it is alive)', posts.length === 5);
  status = { ...status, state: 'error', note: 'the last attempt failed: net::ERR_CONNECTION_RESET while downloading' }; stateAt = '2026-10-20T14:10:00.000Z';
  t += 60_000; await rep.tick();
  ok('failed: the error in its own words (without the prefix), at 14:10', posts.length === 6 && posts[5].state === 'error'
    && posts[5].error === 'net::ERR_CONNECTION_RESET while downloading' && posts[5].since === '2026-10-20T14:10:00.000Z');
  answer = 404; status = { ...status, state: 'checking' }; t += 60_000;
  ok('a cloud without the route (404): rests', (await rep.tick()) === 'resting');
  status = { ...status, state: 'idle' }; t += 60 * 60_000;
  const n404 = posts.length;
  ok('…nothing asked for 6 hours', (await rep.tick()) === 'resting' && posts.length === n404);
  answer = 204; t += 6 * 60 * 60_000;
  ok('…then reported again', (await rep.tick()) === 'sent');
  const long = UR.buildUpdateReport({ status: { state: 'error', version: null, percent: null, note: 'x'.repeat(500) }, running: '1.0.20', stateAt: null, idleNote: null, task: null });
  ok('an error is cut to 160 characters; no percent outside a download', long.error.length === 160 && long.percent === null);

  // ── 3 ── the branch server's distribution lag (A23)
  DC.saveDeviceConfig({ device_role: 'node', device_id: 'dev-S' });
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const order = (id, dev) => db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status, device_id)
    VALUES (?, 'biz-1', ?, ?, 100, 0, 100, ?, 'pending', ?)`).run(id, BR, id, ago(1), dev);
  order('o-1', 'dev-S'); order('o-2', 'dev-S'); order('o-3', 'dev-T1'); order('o-4', 'dev-T2'); order('o-5', 'dev-T2'); order('o-6', 'dev-S'); order('o-7', 'dev-S');
  const q = db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES (?, '{}', ?, ?)`);
  q.run('o-1', ago(190), 'pending'); q.run('o-2', ago(30), 'pending'); q.run('o-3', ago(20), 'pending');
  q.run('o-4', ago(10), 'pending'); q.run('o-5', ago(5), 'failed'); q.run('o-6', ago(2), 'pending'); q.run('o-7', ago(500), 'synced');
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, created_at, device_id, sync_status) VALUES ('s-1', 'biz-1', ?, 'u-eugene', ?, 'open', ?, 'dev-S', 'pending')`).run(BR, ago(60), ago(60));
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, created_at, device_id, sync_status) VALUES ('s-2', 'biz-1', ?, 'u-amina', ?, 'open', ?, 'dev-T1', 'peer')`).run(BR, ago(900), ago(900));
  const lag = DL.distributionLag(db, Date.now(), 'dev-S');
  ok('6 sales wait for the cloud (pending and failed; a synced one is not counted)', lag.waiting.orders === 6, JSON.stringify(lag.waiting));
  ok('…3 of them this branch\'s tills\'', lag.waiting.ordersFromTills === 3, JSON.stringify(lag.waiting));
  ok('…and this server\'s own drawer (a till\'s drawer held here, "peer", is not the server\'s to send)', lag.waiting.shifts === 1 && lag.total === 7, JSON.stringify(lag));
  ok('the oldest not yet on the cloud: about 3 h 10 min', lag.oldestAgeMs !== null && Math.abs(lag.oldestAgeMs - 190 * 60_000) < 5_000, String(lag.oldestAgeMs));
  ok('no push recorded yet', lag.lastPushOkAt === null);
  DL.notePushOk(db, new Date('2026-10-20T15:00:00Z'));
  ok('…a push the cloud took is the last successful push', DL.distributionLag(db, Date.now(), 'dev-S').lastPushOkAt === '2026-10-20T15:00:00.000Z');
  ok('the runbook line is there, word for word', lag.runbook === 'If this server fails, do not wipe or reinstall it until a technician has copied its swiftpos.db — sales not yet on the cloud live only on its disk.');
  db.prepare(`UPDATE sync_queue SET status = 'synced'`).run(); db.prepare(`UPDATE shifts SET sync_status = 'synced' WHERE id = 's-1'`).run();
  const clear = DL.distributionLag(db, Date.now(), 'dev-S');
  ok('everything taken: nothing waits, no oldest', clear.total === 0 && clear.oldestAt === null && clear.oldestAgeMs === null);
  const ipc = ipcHandlersSource();
  const panel = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'components', 'ServerDistributionPanel.tsx'), 'utf8');
  ok('the Tech page asks node:distribution (a technician or settings.business) and shows the runbook line',
    /handle\('node:distribution'[\s\S]{0,300}signedInCan\('settings\.business'\)/.test(ipc) && /d\.runbook/.test(panel));
} catch (e) {
  fail++; console.log('  FAIL threw', e?.stack ?? e);
} finally {
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
