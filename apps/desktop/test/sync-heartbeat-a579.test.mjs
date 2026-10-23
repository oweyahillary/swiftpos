// A579 — the idle heartbeat: an idle till proves to the cloud it is up to date.
//
// Owner, 2026-10-23, on critical emails about a till "on but not syncing" for 9 hours: "maybe its just that no trade is
// taking place". The cloud's last_sync_at moved only on /api/sync/push, which a till sent only with drawer rows to send.
//
// Drives the REAL compiled dist/main (localDb, syncEngine, activityTracker) on a REAL SQLite file in a temp userData,
// electron shimmed (net.isOnline switchable), with a stand-in cloud.
//
//   cd apps/desktop && npm run build:main && node test/sync-heartbeat-a579.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted):
//   the 15-min gate removed from syncHeartbeat              → "at most once every 15 minutes" fails
//   the pendingCount check removed                          → "not while something waits" fails
//   the isOnline() check removed                            → "not when offline" fails
//   the 'heartbeat' stage removed from runPushStagesOnce    → "an empty sync pass sends it" fails
//   SYNC_PUSH_MIN_BYTES check removed (activityTracker)     → "the branch server never counts it as trade" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'syncEngine.js'))) { console.error('dist/main not built. Run:  npm run build:main'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a579-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => globalThis.__online !== false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const A = require(path.join(dist, 'activityTracker.js'));
const DC = require(path.join(dist, 'deviceConfig.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'TJ', '2026-10-23T00:00:00Z')`).run();
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });

const pushes = [];
let pushStatus = 200;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hdr = (init, k) => { const h = init.headers ?? {}; const key = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase()); return key ? h[key] : undefined; };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith('/api/sync/push')) {
    pushes.push({ body: String(init.body ?? ''), pending: hdr(init, 'x-sync-pending'), failed: hdr(init, 'x-sync-failed'), device: hdr(init, 'x-device-id') });
    if (pushStatus !== 200) return json(pushStatus, { error: 'down' });
    return json(200, { ok: true, upserted: { shifts: 0, floats: 0, expenses: 0, businessDays: 0, kitchenVoids: 0 }, rejected: [] });
  }
  if (init.method === 'POST') return json(200, { ok: true });
  return json(200, []);
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');

const T0 = Date.parse('2026-10-23T10:00:00Z');
const MIN = 60_000;

console.log('\nA579 — the idle heartbeat\n');
{
  E._resetHeartbeat(0);
  pushes.length = 0;
  ok('an idle till sends an empty push', await E.syncHeartbeat(T0) === true && pushes.length === 1);
  ok('the body is `{}` — under the branch server\'s SYNC_PUSH_MIN_BYTES', pushes[0]?.body === '{}' && Buffer.byteLength(pushes[0].body) < A.SYNC_PUSH_MIN_BYTES);
  ok('it carries the queue: X-Sync-Pending 0, X-Sync-Failed 0, its own device id', pushes[0]?.pending === '0' && pushes[0]?.failed === '0' && pushes[0]?.device === 'dev-T1',
    JSON.stringify(pushes[0]));

  ok('at most once every 15 minutes (14 min later: none)', await E.syncHeartbeat(T0 + 14 * MIN) === false && pushes.length === 1);
  ok('15 min later: the next one', await E.syncHeartbeat(T0 + 15 * MIN) === true && pushes.length === 2);

  globalThis.__online = false;
  ok('not when offline', await E.syncHeartbeat(T0 + 60 * MIN) === false && pushes.length === 2);
  globalThis.__online = true;

  // something still waits for the cloud: the push that sends it is the proof, not the heartbeat
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id)
              VALUES ('sh-1', 'biz-1', 'br-1', 'u-tom', '2026-10-23T09:00:00Z', 'open', 0, '2026-10-23T09:00:00Z', 'pending', 'dev-T1')`).run();
  ok('not while something waits', await E.syncHeartbeat(T0 + 60 * MIN) === false && pushes.length === 2);
  db.prepare(`DELETE FROM shifts`).run();

  pushStatus = 503;
  ok('a refused heartbeat is not counted (tried again at the next pass)', await E.syncHeartbeat(T0 + 60 * MIN) === false);
  pushStatus = 200;
  ok('... and the next pass sends it', await E.syncHeartbeat(T0 + 61 * MIN) === true);
}

console.log('\nA579 — inside a sync pass\n');
{
  E._resetHeartbeat(0);
  pushes.length = 0;
  await E.syncPush();
  ok('an empty sync pass sends it', pushes.length === 1 && pushes[0].body === '{}', `${pushes.length} pushes`);
  await E.syncPush();
  ok('a second pass straight after: not again', pushes.length === 1, `${pushes.length} pushes`);

  // a real drawer push moves the cloud's last_sync_at itself — and carries the queue headers
  E._resetHeartbeat(0);
  pushes.length = 0;
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id)
              VALUES ('sh-2', 'biz-1', 'br-1', 'u-tom', '2026-10-23T09:00:00Z', 'open', 0, '2026-10-23T09:00:00Z', 'pending', 'dev-T1')`).run();
  await E.syncPush();
  const real = pushes.filter((p) => p.body !== '{}');
  ok('a drawer push carries X-Sync-Pending (what waits, this row included)', real.length === 1 && Number(real[0].pending) >= 1, JSON.stringify(pushes));
  ok('and no heartbeat in the same pass (the drawer push already proved it)', pushes.filter((p) => p.body === '{}').length === 0, JSON.stringify(pushes));
}

console.log('\nA579 — a branch server never counts it as trade\n');
{
  ok('the heartbeat through the gateway is background', A.classifyGatewayCall('POST', '/node/cloud/api/sync/push', 2).kind === 'background');
  ok('noteGatewayCall does not count it', A.noteGatewayCall('POST', '/node/cloud/api/sync/push', Date.now(), 2) === false);
  ok('a real drawer push still is trade', A.classifyGatewayCall('POST', '/node/cloud/api/sync/push', 400).kind === 'trading');
}

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
