/**
 * sync-timeout.test.mjs — A177.
 *
 * The P0 that stranded 6 orders in the field: sync fetches had no timeout, and
 * `_isSyncing` is cleared only in `finally`. A connection that opens but never
 * responds hung the await forever, so `finally` never ran, `_isSyncing` stayed
 * true, and EVERY later sync — the 60s flush, the post-sale flush, reconnect,
 * and the Force-sync button — returned "Sync already in progress." Orders sat
 * pending, 0 attempts, 0 failed, invisible, until the app restarted.
 *
 * This drives the REAL compiled syncEngine with a fetch that hangs until aborted
 * (like a real black-holed socket) and a short SYNC_FETCH_TIMEOUT_MS, and asserts
 * the wedge is impossible: the pass RESOLVES, the order is attempted, and a
 * following sync is never blocked.
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.SYNC_FETCH_TIMEOUT_MS = '300';

// The REAL compiled engine on the REAL till schema (dist/main/localDb on a temp userData, electron shimmed). The
// hand-made schema this test used to carry went stale as the order push grew (sales on account, A552): the order
// stage threw before it reached the network, so the timeout was never exercised.
//
//   cd apps/desktop && npm run build:main && node test/sync-timeout.test.mjs
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'syncEngine.js'))) { console.error('dist/main not built. Run:  npm run build:main'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-synctimeout-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const engine = require(path.join(dist, 'syncEngine.js'));
const DC = require(path.join(dist, 'deviceConfig.js'));
const driver = 'real localDb';

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Pollo', '2026-10-23T00:00:00Z')`).run();
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'b1', device_id: 'd1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });

// A sale rung on this till: the order and its queue row, as the selling path writes them.
const at = new Date().toISOString();
db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status, device_id)
  VALUES ('o1', 'biz-1', 'b1', 'A-1', 100, 0, 100, ?, 'pending', 'd1')`).run(at);
db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES ('o1', ?, ?, 'pending')`)
  .run(JSON.stringify({ id: 'o1', branch_id: 'b1', order_number: 'A-1', items: [], payments: [] }), at);

// A fetch that hangs until its AbortSignal fires — exactly what a black-holed
// connection does, and exactly what the old code hung on forever.
let calls = 0;
globalThis.fetch = (_u, o) => new Promise((_res, rej) => {
  if (String(_u).includes('/api/orders')) calls++;
  if (o?.signal) o.signal.addEventListener('abort', () => rej(o.signal.reason || new Error('aborted')));
});

engine.configureSyncEngine('http://cloud', 'tok', 'refresh');

let pass = 0, fail = 0;
const ok = (name, cond, d = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${d}`); } };
const attempts = () => db.prepare(`SELECT attempts FROM sync_queue WHERE order_id='o1'`).get().attempts;
const qrow = () => db.prepare(`SELECT status, last_error FROM sync_queue WHERE order_id='o1'`).get();

console.log(`sync fetch timeout (driver: ${driver})\n`);

const t0 = Date.now();
const r1 = await engine.syncPush();            // old code: hangs forever here
const dt = Date.now() - t0;
ok('a hung fetch RESOLVES via the timeout (does not hang the pass)', dt < 5000);
// A446 (session audit): a timeout is the LINE, not the sale — the order is tried (its reason recorded) but does not count
// towards 'failed' (a long outage used to turn every sale 'failed', one every 2.5 minutes, with nothing retrying them).
ok('the order got a real attempt (not stranded untried), and a timeout does not count towards failed',
  calls === 1 && /timed out/.test(qrow().last_error ?? '') && attempts() === 0 && qrow().status === 'pending');
ok('the failure names a timeout', /timed out/.test(JSON.stringify(r1.errors)));

const r2 = await engine.syncPush();            // old code: "Sync already in progress" forever
ok('a following sync is NOT wedged (Force sync still works)', !r2.errors.includes('Sync already in progress'));
ok('the second pass attempted again', calls === 2 && qrow().status === 'pending');

// A448: the answer starts (headers, some bytes) and then the line stalls. Before, the limit ended with the headers and the
// body read hung the pass for good. The stream errors when the signal aborts — as a real socket's body does.
globalThis.fetch = (_u, o) => {
  if (String(_u).includes('/api/orders')) calls++;
  const body = new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('{"id":'));
    o?.signal?.addEventListener('abort', () => c.error(o.signal.reason || new Error('aborted')));
  } });
  return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
};
const t3 = Date.now();
const r3 = await engine.syncPush();
ok('an answer that stalls mid-body RESOLVES via the timeout too (the body has a time limit)',
  Date.now() - t3 < 5000 && calls === 3 && /timed out/.test(JSON.stringify(r3.errors) + (qrow().last_error ?? '')), JSON.stringify(r3.errors));
const r4 = await engine.syncPush();
ok('…and the next sync is not wedged', !r4.errors.includes('Sync already in progress') && calls === 4);

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
