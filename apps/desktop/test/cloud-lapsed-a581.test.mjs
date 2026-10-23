// A581 — the business's ZapTill cloud plan lapsed: the till keeps selling, keeps its queue, tells the MANAGER (never the
// cashier), and drains the moment the payment is recorded.
//
// Owner, 2026-10-23: "if a client stops paying for the cloud … yes till continues to work, but the cloud stops syncing and
// the till cannot be re-registered until the client pays again".
//
// Drives the REAL compiled dist/main (localDb, syncEngine) on a REAL SQLite file in a temp userData, electron shimmed, with
// a stand-in cloud that answers this business's writes 503 CLOUD_SUBSCRIPTION_ENDED (apps/server/src/lib/cloudPlan.ts)
// until "paid"; and the manager's notice (src/renderer/lib/syncNotice.ts) from its TypeScript.
//
//   cd apps/desktop && npm run build:main && node test/cloud-lapsed-a581.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted):
//   noteCloudPlanAnswer not called from syncFetch                 → "the till knows why" and the notice fail
//   cloudLapsedHold removed from runPushStagesOnce                → "asks at most every 5 minutes" fails
//   the clear on an accepted write removed                        → "drains after resume" (cloudLapsedNow cleared) fails
//   the cloudLapsed branch removed from syncNotice                → "the manager's notice says so" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'syncEngine.js'))) { console.error('dist/main not built. Run:  npm run build:main'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a581-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const DC = require(path.join(dist, 'deviceConfig.js'));
const SN = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'syncNotice.ts')).href);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Pollo', '2026-10-23T00:00:00Z')`).run();
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });

let paid = false;
const writes = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const LAPSED = { error: "This business's ZapTill cloud subscription has ended. The till keeps selling and keeps its sales; they are sent when it is renewed. Call or WhatsApp ZapTill on 0717 675 635.", code: 'CLOUD_SUBSCRIPTION_ENDED', trial: false };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = String(init.method ?? 'GET').toUpperCase();
  if (method === 'GET') return json(200, []);
  writes.push(u.replace('http://cloud', ''));
  if (!paid) return json(503, LAPSED);
  if (u.endsWith('/api/orders')) { const b = JSON.parse(String(init.body ?? '{}')); return json(201, { orderId: b.id ?? 'x' }); }
  if (u.endsWith('/api/sync/push')) return json(200, { ok: true, upserted: { shifts: 0, floats: 0, expenses: 0, businessDays: 0, kitchenVoids: 0 }, rejected: [] });
  return json(200, { ok: true });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');

// A sale rung on this till (the selling path writes the order and its queue row locally — it never asks the cloud).
const sell = (id) => {
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status, device_id)
    VALUES (?, 'biz-1', 'br-1', ?, 100, 0, 100, ?, 'pending', 'dev-T1')`).run(id, id, at);
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES (?, ?, ?, 'pending')`).run(id, JSON.stringify({ id, order_number: id, branch_id: 'br-1', items: [], payments: [] }), at);
};
const q = (id) => db.prepare(`SELECT status, attempts FROM sync_queue WHERE order_id = ?`).get(id);

console.log('\nA581 — the cloud plan lapsed\n');
{
  E._resetCloudLapsed();
  sell('T1-0001');
  await E.syncPush();
  ok('the till kept the sale: the order is stored, its queue row pending', q('T1-0001')?.status === 'pending', JSON.stringify(q('T1-0001')));
  ok('the refusal is not counted against the sale (503 = passing state on every till version)', q('T1-0001')?.attempts === 0 && E.isTransientStatus(503));
  const lapsed = E.cloudLapsedNow();
  ok('the till knows why (CLOUD_SUBSCRIPTION_ENDED), with the cloud\'s words', !!lapsed && /0717 675 635/.test(lapsed.message), JSON.stringify(lapsed));
  for (let i = 0; i < 6; i++) await E.syncPush();
  ok('five passes later it is still pending — never failed, never parked', q('T1-0001')?.status === 'pending' && q('T1-0001')?.attempts === 0);
  sell('T1-0002');
  ok('the till keeps selling: another sale is stored and queued', q('T1-0002')?.status === 'pending');

  writes.length = 0;
  await E.syncPush(); await E.syncPush();
  ok('it asks the cloud at most every 5 minutes while lapsed (no writes in between)', writes.length === 0, writes.join(', '));

  const st = E.getSyncStatus();
  ok('getSyncStatus carries cloudLapsed and counts both sales as waiting', !!st.cloudLapsed && st.pendingCount >= 2 && st.failedCount === 0, JSON.stringify({ c: st.cloudLapsed, p: st.pendingCount, f: st.failedCount }));
  const notice = SN.syncNotice(st);
  ok('the manager\'s notice says so in plain words — kept on this till, sent when renewed, ZapTill\'s number',
    notice?.tone === 'alert' && /ZapTill cloud subscription ended/.test(notice.text) && /kept on this till, sent when renewed/.test(notice.text) && /0717 675 635/.test(notice.text),
    JSON.stringify(notice));
  const pos = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'POSPage.tsx'), 'utf8');
  ok('no cashier surface: the notice is shown only to who may see sync (canSeeSync = back office, never a cashier)',
    /const notice = canSeeSync \? syncNotice\(syncStatus\) : null;/.test(pos) && !/CLOUD_SUBSCRIPTION_ENDED|cloudLapsed\s*&&/.test(pos.replace(/cloudLapsed\?: SyncStatusLike\['cloudLapsed'\];/, '')));
}

console.log('\nA581 — paid: sync resumes and the queue drains\n');
{
  paid = true;
  E._resetCloudLapsed(Date.now() - 6 * 60_000);   // the 5-minute probe is due
  writes.length = 0;
  await E.syncPush();
  ok('the next probe is sent and accepted', writes.some((w) => w === '/api/orders'), writes.join(', '));
  ok('the queue drains: both sales synced', q('T1-0001')?.status === 'synced' && q('T1-0002')?.status === 'synced', JSON.stringify([q('T1-0001'), q('T1-0002')]));
  ok('the lapse is forgotten: no notice', E.cloudLapsedNow() === null && E.getSyncStatus().cloudLapsed === null);
  ok('the notice is gone (nothing waits)', SN.syncNotice(E.getSyncStatus()) === null || !/subscription ended/.test(SN.syncNotice(E.getSyncStatus()).text));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
