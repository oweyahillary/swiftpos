// A601 — the desktop-only cut-off on the POS: told by the catalogue pull (pos/init cloudBackup), it stops sending the
// cloud backup QUIETLY (no request, no error, no 5-minute probe), keeps everything queued on the PC, stops the
// background polls that only serve the backup, keeps the catalogue pull and the changes push, resumes when the cloud
// says the backup is on again, shows the manager the notice, and takes "no update for you" as a plain hold.
//
// Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md): "Partial cut … Stays: setup, sign-in, catalogue and staff
// changes, support logs. Cut: the backup of sales, orders, shifts, drawers, reversals and day closes, and the background
// polls that only serve it." The cloud's side: tests/desktop-only-cutoff-a601.test.mjs.
//
// Drives the REAL compiled dist/main (localDb, syncEngine, cloudBackup, branchDrawers, autoUpdate) on a REAL SQLite file
// in a temp userData, electron shimmed, with a stand-in cloud; the manager's notice (src/renderer/lib/syncNotice.ts) from
// its TypeScript.
//
//   cd apps/desktop && npm run build:main && node test/desktop-only-cutoff-a601.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted — 2026-10-28):
//   runPushStagesOnce's `if (backup)` dropped from the order push  → 4 fail ("not one backup call in four passes", "queued" …)
//   pullWebSales without the cloudBackupOffNow return              → 1 fail ("the background polls … stop")
//   configFromInit without cloudBackup                              → 11 fail ("the catalogue pull stores …" …)
//   syncNotice without the `!cut &&` on the pending notice          → 1 fail ("no 'waiting to sync' nag")
//   effectiveCloudBackup without the date check                     → 1 fail ("a notice whose date has passed is a cut")
//   branchDrawers pollOnce without the cloudBackupOffNow return     → 1 fail ("a branch server asks the cloud for no drawers")
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'cloudBackup.js'))) { console.error('dist/main not built. Run:  npm run build:main'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a601-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.23', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const updaterShim = path.join(userData, 'updater-shim.cjs');
fs.writeFileSync(updaterShim, `module.exports = { autoUpdater: { on() {}, checkForUpdates: async () => null, setFeedURL() {} } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  if (req === 'electron-updater') return updaterShim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const DC = require(path.join(dist, 'deviceConfig.js'));
const CB = require(path.join(dist, 'cloudBackup.js'));
const BD = require(path.join(dist, 'branchDrawers.js'));
const RB = require(path.join(dist, 'referenceBundle.js'));
const U = require(path.join(dist, 'autoUpdate.js'));
const SN = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'syncNotice.ts')).href);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Fries', '2026-10-28T00:00:00Z')`).run();
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });

const CUT = '2026-11-30T21:00:00.000Z';   // 1 December 2026, Nairobi
let cloudBackup = { on: true, phase: 'notice', cutoffAt: CUT };
let refuseBackup = false;   // the cloud answers backup writes 503 CLOUD_BACKUP_OFF
const calls = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const BACKUP = /\/api\/(orders|sync\/push|shifts\/[^/]+\/(close|force-close|foreign-cash|foreign-orders|confirm)|day-close\/ack)/;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url).replace('http://cloud', ''); const method = String(init.method ?? 'GET').toUpperCase();
  calls.push(`${method} ${u}`);
  if (u.startsWith('/api/pos/init')) return json(200, { branchId: 'br-1', products: [], categories: [], paymentMethods: [], cloudBackup });
  if (method === 'GET') return json(200, []);
  if (refuseBackup && BACKUP.test(u)) return json(503, { error: 'This POS no longer backs up to the ZapTill cloud', code: 'CLOUD_BACKUP_OFF', cutoffAt: CUT });
  if (u.endsWith('/api/orders')) { const b = JSON.parse(String(init.body ?? '{}')); return json(201, { orderId: b.id ?? 'x' }); }
  if (u.endsWith('/api/sync/push')) return json(200, { ok: true, upserted: { shifts: 0, floats: 0, expenses: 0, businessDays: 0, kitchenVoids: 0 }, rejected: [] });
  if (u.endsWith('/api/changes')) return json(200, { results: [] });
  return json(200, { ok: true });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');

const sell = (id) => {
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status, device_id)
    VALUES (?, 'biz-1', 'br-1', ?, 100, 0, 100, ?, 'pending', 'dev-T1')`).run(id, id, at);
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES (?, ?, ?, 'pending')`).run(id, JSON.stringify({ id, order_number: id, branch_id: 'br-1', items: [], payments: [] }), at);
};
const q = (id) => db.prepare(`SELECT status, attempts FROM sync_queue WHERE order_id = ?`).get(id);
// an open drawer still to reach the cloud (a shift push would send it)
const openShift = () => db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, created_at, device_id, sync_status)
  VALUES ('sh-1', 'biz-1', 'br-1', 'u-owner', ?, 'open', ?, 'dev-T1', 'pending')`).run(new Date().toISOString(), new Date().toISOString());
const cloudCalls = (re) => calls.filter((c) => re.test(c));

console.log('\nA601 — the rules\n');
{
  ok('the wire: a real answer kept; junk / no `on` = not said (keep)', JSON.stringify(CB.cleanCloudBackup({ on: false, phase: 'cut', cutoffAt: CUT })) === JSON.stringify({ on: false, phase: 'cut', cutoffAt: CUT })
    && CB.cleanCloudBackup(null) === undefined && CB.cleanCloudBackup({ phase: 'cut' }) === undefined && CB.cleanCloudBackup('x') === undefined);
  ok('a notice whose date has passed is a cut, by this POS\'s clock; before it, not', CB.backupOff({ on: true, phase: 'notice', cutoffAt: CUT }, Date.parse(CUT))
    && !CB.backupOff({ on: true, phase: 'notice', cutoffAt: CUT }, Date.parse(CUT) - 1) && !CB.backupOff(null) && !CB.backupOff({ on: true, phase: 'none', cutoffAt: null }));
}

console.log('\nA601 — the notice phase: told by the pull, everything still goes\n');
{
  await E.pullCatalogueNow();
  CB._forgetCloudBackupMemo();
  ok('the catalogue pull stores pos/init\'s cloudBackup (kept in maintenance_state)', JSON.stringify(CB.getCloudBackup()) === JSON.stringify(cloudBackup), JSON.stringify(CB.getCloudBackup()));
  sell('T1-0001');
  calls.length = 0;
  await E.syncPush();
  ok('before the date the sale goes up as usual', cloudCalls(/POST \/api\/orders$/).length === 1 && q('T1-0001')?.status === 'synced', calls.join(', '));
  const st = E.getSyncStatus();
  ok('getSyncStatus carries it', st.cloudBackup?.phase === 'notice' && st.cloudBackup?.on === true);
  const n = SN.syncNotice(st);
  ok('the manager\'s notice: the date in plain words, sales safe on this PC, who to ask — and only an OK button',
    n?.action === 'dismiss' && n.tone === 'quiet'
    && n.text === 'From 1 December 2026, this POS no longer backs up to the ZapTill cloud. Your sales stay on this PC and are backed up on it every night. To keep online backup and the web dashboard, ask ZapTill about the online licence.',
    JSON.stringify(n));
  ok('…no "till", no pressure words', !/\btill\b|urgent|hurry|last chance|!/i.test(n?.text ?? ''));
  ok('closed by the manager: the usual notices again (nothing waits → none)', SN.syncNotice(st, new Date(), { backupNoticeClosed: true }) === null);
  ok('nothing to say ("none") → no notice', SN.syncNotice({ ...st, cloudBackup: { on: true, phase: 'none', cutoffAt: null } }) === null);
}

console.log('\nA601 — the cut: quiet, queued, polls stopped, catalogue kept\n');
{
  cloudBackup = { on: false, phase: 'cut', cutoffAt: CUT };
  await E.pullCatalogueNow();
  ok('the pull says cut → off', CB.cloudBackupOffNow());
  openShift();
  sell('T1-0002'); sell('T1-0003');
  calls.length = 0;
  for (let i = 0; i < 4; i++) await E.syncPush();
  ok('no order push, no sync push (shifts, floats, days), no heartbeat — not one backup call in four passes', cloudCalls(BACKUP).length === 0, calls.join(', '));
  ok('the sales stay queued on this PC, never failed or parked (for "going online later")', q('T1-0002')?.status === 'pending' && q('T1-0003')?.status === 'pending' && q('T1-0002')?.attempts === 0);
  ok('no error and no lapse probe recorded', E.cloudLapsedNow() === null);
  calls.length = 0;
  await E.pullWebSales(); await E.pullShiftCloses(); await E.pullShiftConfirmations(); await E.remoteCloseBeat(); await E.learnCloudCloses();
  ok('the background polls that only serve the backup stop: no foreign-orders, no shift state, no day-close pending / ack',
    cloudCalls(/foreign-orders|\/api\/shifts\/state|\/api\/day-close/).length === 0, calls.join(', '));
  calls.length = 0;
  DC.saveDeviceConfig({ device_role: 'node' });
  await BD.pollBranchDrawers('test');
  DC.saveDeviceConfig({ device_role: 'till' });
  ok('a branch server asks the cloud for no drawers (GET /api/pos/branch-drawers)', cloudCalls(/branch-drawers/).length === 0, calls.join(', '));
  calls.length = 0;
  await E.pullCatalogueNow();
  ok('the catalogue pull still goes (pos/init)', cloudCalls(/GET \/api\/pos\/init/).length === 1, calls.join(', '));
  const r = await E.tillChangesPost([{ id: 'c-1', kind: 'product', payload: {} }]);
  ok('the catalogue / staff changes push still goes (POST /api/changes)', r.ok && cloudCalls(/POST \/api\/changes/).length === 1, calls.join(', '));
  const st = E.getSyncStatus();
  const n = SN.syncNotice(st);
  ok('the manager sees the same notice (not "N records waiting to sync")', n?.action === 'dismiss' && /no longer backs up/.test(n.text), JSON.stringify(n));
  ok('closed: no "waiting to sync" nag, no red — nothing goes to the cloud on purpose', st.pendingCount >= 2 && SN.syncNotice(st, new Date(), { backupNoticeClosed: true }) === null,
    JSON.stringify(SN.syncNotice(st, new Date(), { backupNoticeClosed: true })));
  ok('…but the branch server\'s own lines (the shop network) still show', /branch server/.test(SN.syncNotice({ ...st, nodeBacklog: { pending: 0, failed: 2 } }, new Date(), { backupNoticeClosed: true })?.text ?? ''));
}

console.log('\nA601 — a branch server relays it to its POSs\n');
{
  const bundle = RB.buildReferenceBundle(db, DC.getDeviceConfig());
  const peer = RB.unpackNodeBundle(bundle);
  ok('the bundle carries the server\'s copy, and a POS behind it reads it', JSON.stringify(peer.config.cloudBackup) === JSON.stringify({ on: false, phase: 'cut', cutoffAt: CUT }), JSON.stringify(peer.config.cloudBackup));
  ok('an older server (no key) says nothing → the POS keeps its own', RB.unpackNodeBundle({ posInit: {} }).config.cloudBackup === undefined);
}

console.log('\nA601 — back on: the queue drains\n');
{
  cloudBackup = { on: true, phase: 'none', cutoffAt: null };
  await E.pullCatalogueNow();
  calls.length = 0;
  await E.syncPush();
  ok('the cloud says on (a plan, the cloud_backup flag) → the queued sales go in the next pass', q('T1-0002')?.status === 'synced' && q('T1-0003')?.status === 'synced', calls.join(', '));
  ok('no notice any more', SN.syncNotice(E.getSyncStatus()) === null || !/no longer backs up/.test(SN.syncNotice(E.getSyncStatus()).text));
}

console.log('\nA601 — a refusal before the POS heard\n');
{
  refuseBackup = true;
  sell('T1-0004');
  calls.length = 0;
  await E.syncPush();
  ok('a 503 CLOUD_BACKUP_OFF turns the backup off at once (the date kept)', CB.cloudBackupOffNow() && CB.getCloudBackup()?.cutoffAt === CUT, JSON.stringify(CB.getCloudBackup()));
  ok('…the sale stays queued (503: never failed)', q('T1-0004')?.status === 'pending' && q('T1-0004')?.attempts === 0, JSON.stringify(q('T1-0004')));
  const before = cloudCalls(BACKUP).length;
  await E.syncPush(); await E.syncPush();
  ok('…and nothing more is tried (no 5-minute probing loop)', cloudCalls(BACKUP).length === before, calls.join(', '));
}

console.log('\nA601 — desktop updates: "released by ZapTill support", no loop\n');
{
  let asks = 0, checks = 0;
  const deps = () => ({ updater: { setFeedURL() {}, requestHeaders: null, async checkForUpdates() { checks++; } },
    fetch: async () => { asks++; return new Response(JSON.stringify({ approvedVersion: null, held: true, reportsState: true, bySupport: true }), { status: 200 }); },
    cloudUrl: () => 'https://c', token: () => 'tok', refresh: async () => false, running: '1.0.23' });
  const r = await U.runUpdateCheck(deps());
  ok('the check is a plain hold: nothing downloaded, nothing checked', r.decision === 'hold' && r.bySupport === true && checks === 0, JSON.stringify(r));
  let st = { state: 'idle', version: null, percent: null };
  const loop = U.createUpdateLoop({ status: () => st, set: (p) => { st = { ...st, ...p }; }, running: '1.0.23', isServer: () => false, log: () => {},
    askServer: async () => null, installOnQuit: () => {}, checkDeps: ({ running }) => ({ ...deps(), running }) });
  await loop.check('hourly');
  ok('the Tech page reads "Updates for this business are released by ZapTill support" (not an error)', st.note === 'Updates for this business are released by ZapTill support' && st.state === 'idle', JSON.stringify(st));
  asks = 0;
  await loop.check('hourly');
  ok('each check asks once (the hourly timer), never retries in a loop', asks === 1 && checks === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
