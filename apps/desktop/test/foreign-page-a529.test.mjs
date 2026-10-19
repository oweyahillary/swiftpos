// A529 (2026-10-19) — a cloud that answers with someone else's page is UNREACHABLE: sign-in falls back, sales never 'failed'.
// Owner, during the Render suspension: "some users were not able to log in … and I thought we had said when the desktop is
// offline or render unavailable all users should be able to log in", and "the could not sync error some clients did not
// like it". A suspended Render service / a Cloudflare page / a captive portal answers with ITS OWN page (404, 403, 410,
// 200 HTML); the till read the status as the cloud's verdict ("Invalid PIN"; sales counted towards 'failed').
//
// Drives the REAL compiled dist/main (ipcHandlers' auth:verifyPin, order:void, manager:branchShifts; syncEngine's push,
// renewal and status; cloudGateway; nodeGateway) on a REAL SQLite file, electron shimmed, against a stand-in cloud that
// signs its answers (X-ZapTill-Server) or not; and the real src/renderer/lib/syncNotice.ts (type-stripped).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/foreign-page-a529.test.mjs
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-19):
//   - cloudGateway judgeAnswer returning res for a 'foreign' verdict (no throw)  → every "foreign page" case fails
//   - authTransport judgeCloudAnswer without the cloudSigns() gate (unsigned = foreign always) → "before the cloud has ever
//     signed" fails
//   - dbSignatureStore.load returning false (memory only)                        → "a till restarted during the outage" fails
//   (syncEngine isTransportError's 'ForeignPageError' is belt and braces: its message starts "fetch failed", which the
//    transport pattern matches too — removing either alone survives, by design.)
//   - syncEngine CONNECTION_FAILURE_SQL without the bare "HTTP nnn" / "another server's page" → the re-queue case fails
//   - syncEngine pushPendingOrders without the start-of-push re-queue            → "re-sent when the signed cloud returns" fails
//   - renderer syncNotice without the cloudUnreachable wording                   → "the manager's notice is quiet" fails
//   - authTransport judgeCloudAnswer without the rolled-back branch              → "a cloud rolled back below A529" fails
//   - ipcHandlers pos:getVariants / pos:getModifiers without `if (catalogueHeld())` → "no cloud call on any tap" fails (11 calls)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A529_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A529_TS: '1' } });
  process.exit(r.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a529-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'owner-tok', 'dev-T1', 'biz-1', 'Your Business', '2026-10-19T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
db.prepare(`INSERT OR IGNORE INTO branches (id, name) VALUES ('br-1', 'Main')`).run();
const T = require(path.join(dist, 'tokenStore.js'));
T.writeSessionTokens({ token: 'owner-tok', refreshToken: 'refresh-1' });

// Saved sign-ins (what an online sign-in caches): Tom the cashier.
const bcrypt = require('bcryptjs');
const P = require(path.join(dist, 'pinCache.js'));
P.cacheStaffCredential({ staffId: 'u-tom', name: 'Tom', roleName: 'cashier', permissions: { 'orders.create': true } }, bcrypt.hashSync('1111', 4), 'br-1');

// ── The stand-in cloud ──────────────────────────────────────────────────────────────────────────────────────────────
// mode.page: null → the real cloud (signed JSON, per route); otherwise every answer is that page.
const SIGNED = { 'content-type': 'application/json', 'x-zaptill-server': '1' };
const page = (status, body = '<html><body>This service has been suspended.</body></html>', type = 'text/html') =>
  () => new Response(status === 204 ? null : body, { status, headers: { 'content-type': type } });
const signed = (status, body) => new Response(JSON.stringify(body), { status, headers: SIGNED });
const mode = { page: null, verify: null, orders: null };
const seen = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  seen.push(u);
  if (mode.page) return mode.page();
  if (u.endsWith('/api/health')) return signed(200, { ok: true });
  if (u.endsWith('/api/auth/verify-pin')) return mode.verify ? mode.verify() : signed(401, { error: 'Invalid PIN' });
  if (u.endsWith('/api/auth/refresh')) return signed(200, { accessToken: 'owner-tok-2', refreshToken: 'refresh-2' });
  if (u.endsWith('/api/orders')) {
    if (mode.orders) return mode.orders();
    const key = init.headers?.['X-Idempotency-Key'];
    return signed(201, { orderId: `cloud-${key}` });
  }
  if (/\/api\/orders\/[^/]+\/void$/.test(u)) return signed(404, { error: 'Order not found' });
  if (u.includes('/api/sync/push')) return signed(200, { ok: true, upserted: {}, rejected: [] });
  if (u.includes('/api/variants/groups') || u.includes('/api/modifiers/groups')) return signed(200, [{ id: 'g-cloud', name: 'Size' }]);
  if (u.includes('/api/shifts')) return signed(200, []);
  return signed(200, {});
};

const AT = require(path.join(dist, 'authTransport.js'));
const CG = require(path.join(dist, 'cloudGateway.js'));
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine('http://cloud', 'owner-tok', 'refresh-1');
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const verify = (pin) => H['auth:verifyPin']({}, { pin, branch_id: 'br-1' });
const N = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'syncNotice.ts')).href);

let n = 0;
const queueSale = () => {
  const id = `o-${++n}`;
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', 100, 0, 100, ?, 'pending', 'dev-T1')`).run(id, `T1-${n}`, new Date().toISOString());
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES (?, ?, ?, 'pending')`)
    .run(id, JSON.stringify({ id, order_number: `T1-${n}`, total: 100 }), new Date().toISOString());
  return id;
};
const q = (id) => db.prepare(`SELECT status, attempts, last_error FROM sync_queue WHERE order_id=?`).get(id);
const signsOnDisk = () => !!db.prepare(`SELECT 1 FROM maintenance_state WHERE key='cloud_signs:http://cloud'`).get();

console.log('A529 — another server\'s page is no connection\n');

// ── 1. Before the cloud has ever signed: today's rules (a 1.0.20 till on a cloud from before A529) ────────────────────
mode.page = page(404);
const e0 = await rejects(verify('1111'));
ok('before the cloud has ever signed: an unsigned 404 at sign-in is read by today\'s rules (refused, as 1.0.19 did)',
  e0 && /Invalid PIN/.test(e0.message), e0?.message);
mode.page = page(503);
const t503 = await verify('1111').catch((e) => ({ error: e.message }));
ok('…and an unsigned 503 still falls back (A152)', t503?.offline === true && t503.staff?.name === 'Tom', JSON.stringify(t503));
mode.page = page(404);
const early = queueSale();
for (let i = 0; i < 5; i++) await E.syncPush();
ok('…a sale pushed into unsigned 404s before then counts as today (5 → failed, "HTTP 404")',
  q(early).status === 'failed' && q(early).attempts === 5 && q(early).last_error === 'HTTP 404', JSON.stringify(q(early)));
ok('nothing learned from unsigned answers', !signsOnDisk());

// ── 2. The cloud signs once: learned, and kept on disk ──────────────────────────────────────────────────────────────
mode.page = null;
const h = await CG.cloudFetch('http://cloud/api/health');
ok('a signed answer: this cloud signs — kept on disk (maintenance_state)', h.ok && signsOnDisk() && AT.cloudSigns('http://cloud'));
AT._resetSignatureMemory();   // a restart: memory gone
ok('a till restarted during the outage still knows its cloud signs (read from disk)', AT.cloudSigns('http://cloud', CG.dbSignatureStore));

// ── 3. The outage: every page that is not the cloud's ───────────────────────────────────────────────────────────────
for (const [label, mk] of [['404 HTML', page(404)], ['403 HTML', page(403)], ['200 HTML (a captive portal)', page(200)], ['410', page(410, 'Gone', 'text/plain')]]) {
  mode.page = mk;
  const r = await verify('1111').catch((e) => ({ error: e.message }));
  ok(`sign-in during an unsigned ${label}: Tom signs in from the saved sign-in`, r?.offline === true && r.staff?.name === 'Tom', JSON.stringify(r));
}
mode.page = page(404);
const unknown = await rejects(verify('9999'));
ok('…an unknown PIN is still refused, on the till', unknown && /Invalid PIN|not recogni[sz]ed|PIN/i.test(unknown.message), unknown?.message);

const s1 = queueSale();
for (let i = 0; i < 10; i++) await E.syncPush();
ok('a sale pushed into unsigned 404s ×10 stays pending — attempts 0, the distinct reason kept',
  q(s1).status === 'pending' && q(s1).attempts === 0 && /another server's page, HTTP 404/.test(q(s1).last_error ?? ''), JSON.stringify(q(s1)));

const st = E.getSyncStatus();
ok('status: the cloud cannot be reached; the sale failed before learning counts as waiting, not failed',
  !!st.cloudUnreachable && st.failedCount === 0 && st.pendingBreakdown.orders >= 2, JSON.stringify({ c: st.cloudUnreachable, f: st.failedCount, p: st.pendingBreakdown }));
const notice = N.syncNotice(st);
ok('the manager\'s notice for the outage is quiet: waiting · the cloud cannot be reached · last synced',
  notice?.tone === 'quiet' && /records? waiting to sync · the cloud cannot be reached · last synced/.test(notice.text), JSON.stringify(notice));

// The renewal answered by a foreign page: "could not reach", never "refused" — the tokens stay, no re-enrolment.
mode.page = page(401, '<html>Sign in to the Wi-Fi</html>');
const renewed = await E.refreshAccessToken();
ok('a renewal answered by a foreign 401 page keeps the tokens and is not a refusal',
  renewed === false && T.readSessionTokens().refreshToken === 'refresh-1' && !E.tillSessionRefusedRecently() && E.renewalHeldUntil() === null,
  JSON.stringify({ renewed, rt: T.readSessionTokens().refreshToken, refused: E.tillSessionRefusedRecently() }));

// A peer behind a branch server: the server forwards the cloud's answer — an unsigned one is still not the cloud's.
const peerCfg = { device_role: 'till', node_url: 'http://node:4000', node_secret: 'S', server_url: 'http://cloud' };
const viaNode = await rejects(CG.cloudFetch('http://cloud/api/orders', {}, { cfg: peerCfg, signatures: null,
  fetch: async () => new Response('<html>Suspended</html>', { status: 404, headers: { 'x-node-gateway': '1', 'content-type': 'text/html' } }) }));
ok('through the branch server\'s gateway: an unsigned page is no connection too', viaNode?.name === 'ForeignPageError', viaNode?.message);

// ── 4. The cloud is back (signed): the waiting sales go, including the one 'failed' before learning ──────────────────
mode.page = null;
await CG.cloudFetch('http://cloud/api/health');
await E.syncPush();
ok('the signed cloud returns: the waiting sale is sent', q(s1).status === 'synced', JSON.stringify(q(s1)));
ok('…and the one left \'failed\' by a page that was not the cloud\'s is queued again and sent', q(early).status === 'synced', JSON.stringify(q(early)));

// ── 5. Real answers from OUR cloud stay real ────────────────────────────────────────────────────────────────────────
mode.verify = () => signed(401, { error: 'Invalid PIN' });
const final = await rejects(verify('1111'));
ok('a SIGNED 401 "Invalid PIN" is final — even for a PIN this till knows (no cable-pull sign-in)', final && /Invalid PIN/.test(final.message), final?.message);
mode.verify = null;
mode.orders = () => signed(400, { error: 'total does not add up' });
const bad = queueSale();
await E.syncPush();
ok('a SIGNED 400 still counts towards \'failed\'', q(bad).attempts === 1 && q(bad).status === 'pending', JSON.stringify(q(bad)));
for (let i = 0; i < 4; i++) await E.syncPush();
const st2 = E.getSyncStatus();
const red = N.syncNotice(st2);
ok('…5 of them: failed, and the manager\'s notice is red with the cloud\'s words',
  q(bad).status === 'failed' && st2.failedCount === 1 && red?.tone === 'alert' && /total does not add up/.test(red.text), JSON.stringify({ q: q(bad), red }));
mode.orders = null;

// ── 6. Void and manager screens during a foreign page ───────────────────────────────────────────────────────────────
db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
            VALUES (1, 'u-owner', 'Owner', 'owner', 'br-1', 'Main', '{"*":true}', '', NULL, ?)`).run(new Date().toISOString());
T.writeStaffTokens({ token: 'staff-tok', refreshToken: 'staff-refresh' });
const v1 = queueSale();
db.prepare(`UPDATE orders SET sync_status='synced' WHERE id=?`).run(v1);
db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, 'cash', 100, 100, ?)`).run(`p-${v1}`, v1, new Date().toISOString());
mode.page = page(404);
const voided = await H['order:void']({}, { orderId: v1, reason: 'Wrong items' }).catch((e) => ({ error: e.message }));
ok('a void during a foreign page goes the offline-reversal path', voided?.ok === true && voided.offline === true, JSON.stringify(voided));
const shifts = await rejects(H['manager:branchShifts']({}));
ok('a manager screen during a foreign page says "No connection", not "Request failed (404)"', shifts && /^No connection/.test(shifts.message), shifts?.message);
mode.page = null;
const v2 = queueSale();
const realNo = await rejects(H['order:void']({}, { orderId: v2, reason: 'x' }));
ok('a SIGNED 404 on a void is the cloud\'s answer (refused, not reversed offline)', realNo && /Order not found/.test(realNo.message), realNo?.message);

// ── 7. The branch server passes the signature through unchanged ─────────────────────────────────────────────────────
const NG = require(path.join(dist, 'nodeGateway.js'));
const gw = await new Promise((r) => { const s = http.createServer((req, res) => NG.forwardToCloud(req, res, 'http://cloud',
  { fetch: async () => signed(200, { ok: true }) })); s.listen(0, '127.0.0.1', () => r(s)); });
const realFetch = (await import('node:http')).get;
const gwHeaders = await new Promise((r) => realFetch(`http://127.0.0.1:${gw.address().port}/node/cloud/api/health`, (res) => { res.resume(); r(res.headers); }));
gw.close();
ok('the branch server\'s gateway passes X-ZapTill-Server through (and adds its own mark)', gwHeaders['x-zaptill-server'] === '1' && gwHeaders['x-node-gateway'] === '1', JSON.stringify(gwHeaders));

// ── 7b. Options for a product: the local catalogue is trusted (the owner's System page: /api/variants 557 calls / 36 min) ──
mode.page = null;
const optionCalls = () => seen.filter((u) => /\/api\/(variants|modifiers)\/groups/.test(u)).length;
const c0 = optionCalls();
const vBefore = await H['pos:getVariants']({}, 'p-new');
const mBefore = await H['pos:getModifiers']({}, 'p-new');
ok('before this till has ever pulled its catalogue: a product with no local options asks the cloud (variants and modifiers)',
  optionCalls() === c0 + 2 && vBefore?.[0]?.id === 'g-cloud' && mBefore?.[0]?.id === 'g-cloud', JSON.stringify({ calls: optionCalls() - c0, vBefore }));
mode.page = page(404);
const vForeign = await H['pos:getVariants']({}, 'p-new');
ok('…a foreign page there is no connection: no options, at once', Array.isArray(vForeign) && vForeign.length === 0, JSON.stringify(vForeign));
mode.page = null;
db.prepare(`INSERT INTO products (id, name, base_price, synced_at) VALUES ('p-chips', 'Chips', 150, ?)`).run(new Date().toISOString());
const c1 = optionCalls();
for (let i = 0; i < 5; i++) { await H['pos:getVariants']({}, 'p-chips'); await H['pos:getModifiers']({}, 'p-chips'); }
const vAfter = await H['pos:getVariants']({}, 'p-chips');
ok('after a catalogue pull: a product with no local options means none — no cloud call on any tap',
  optionCalls() === c1 && Array.isArray(vAfter) && vAfter.length === 0, JSON.stringify({ calls: optionCalls() - c1 }));

// ── 8. A cloud rolled back below A529: an unsigned JSON answer — forgotten, today's rules again ──────────────────────
mode.page = page(200, JSON.stringify({ ok: true }), 'application/json');
const rb = await CG.cloudFetch('http://cloud/api/health').catch((e) => ({ status: e.message }));
ok('a cloud rolled back below A529 (unsigned 200 JSON): passed on, and "this cloud signs" forgotten',
  rb.status === 200 && !signsOnDisk() && !AT.cloudSigns('http://cloud', CG.dbSignatureStore), JSON.stringify(rb.status));
mode.page = page(404);
const after = await rejects(verify('1111'));
ok('…and an unsigned 404 is read by today\'s rules again (refused, as from a cloud before A529)', after && /Invalid PIN/.test(after.message), after?.message);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
