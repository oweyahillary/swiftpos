// A533 (2026-10-20) — ZapTill support pulls this till's (or branch server's) log from the admin portal.
// Owner, 2026-10-19: "add a feature where we can pull local logs of a server or a till to cloud so that we can be
// investigating such issues" — and, on the admin portal's Desktop updates tab: "how do I pull logs".
//
// Drives the REAL compiled dist/main (logPull, supportLogs, logRedact, syncEngine's 90 s beat and its session, liveSync's
// push channel, cloudGateway) on a REAL SQLite file, electron shimmed, against a stand-in cloud on a real port — HTTP
// (signed answers, A529) and a WebSocket on /api/pos/live (hand-made, as live-sync-a531) — and, for the peer part, a
// stand-in branch server whose /node/cloud is the REAL nodeGateway.forwardToCloud.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/log-pull-a533.test.mjs
//
//   1  the 90 s beat (remoteCloseBeat) asks /api/support/log-requests/mine once; a waiting 3-day request → ONE upload
//      with request_id: lines from 30 h and 50 h ago (the rolled swiftpos.log.1) in, 100 h ago out; a PIN and a token
//      written in the log do not appear; no auth.log (not asked); the diagnostics block (sync, A531 topics and channel,
//      printer errors); the shop's own log says "logs pulled by ZapTill support (request …)". Answered → not again.
//   2  the doorbell: the cloud rings { type: 'log_request', device_id } on the push channel → the till asks at once (no
//      beat) — a 7-day request with the sign-in history: 100 h ago in, 200 h ago out (swiftpos.log.3 never opened),
//      auth.log in. A ring for another device asks nothing.
//   3  a failing upload is tried three times, then left (the request stays waiting); one upload at a time.
//   4  a closed request (409: cancelled) is never tried again; an older cloud (its 404 on /mine) is not asked for an hour.
//   5  a till behind a branch server: the beat's GET and the upload go through the server's gateway (the access code to
//      the server only; the till's own session and device to the cloud).
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
//   - syncEngine remoteCloseBeat without the _logPullBeat call             → 1 fails
//   - liveSync onmessage without the 'log_request' branch                  → 2 "the doorbell" fails
//   - logPull bell without the device check                                → 2 "another device asks nothing" fails
//   - logPull pullText using the 24 h default window                       → 1 "50 h ago in" and 2 "100 h ago in" fail
//   - logPull including auth.log regardless of include.auth                → 1 "no auth.log" fails
//   - supportLogs buildSupportText without redactLog                       → 1 "a PIN and a token do not appear" fails
//   - logPull answer() without the MAX_TRIES stop                          → 3 "then left" fails
//   - lazyLogFiles without the mtime stop                                  → 2 "swiftpos.log.3 never opened" fails
//   - logPull checkLogRequests not single-flight                           → 3 "one upload at a time" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a533-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (req === 'electron') return shim; return orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 1500)}`); fail++; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await wait(20); } return false; };

// ── The log files, as the till rolls them (A477: swiftpos.log, .1, .2 …) ────────────────────────────────────────────
const NOW = Date.now();
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXYtVDEifQ.c2lnbmF0dXJlLXNlY3JldA';
const logBase = path.join(userData, 'swiftpos.log');
const write = (p, lines, mtimeHoursAgo) => {
  fs.writeFileSync(p, lines.map((l) => `${l}\n`).join(''));
  const t = new Date(NOW - mtimeHoursAgo * 3_600_000); fs.utimesSync(p, t, t);
};
write(`${logBase}.3`, [`${at(200)} [sync] MARK-200H very old`], 199);
write(`${logBase}.2`, [`${at(100)} [sync] MARK-100H four days back`], 99);
write(`${logBase}.1`, [`${at(50)} [sync] MARK-50H two days back`, `${at(30)} [print] MARK-30H receipt printer failed: ECONNREFUSED 192.168.1.50:9100`], 29);
write(logBase, [`${at(2)} [pin] MARK-2H verify-pin pin=4321 accepted`, `${at(1)} [auth] MARK-1H Authorization: Bearer ${JWT}`], 0);
write(path.join(userData, 'auth.log'), [`${at(1)} [renewal] AUTHMARK renewal ok`], 0);

// ── The stand-in cloud ───────────────────────────────────────────────────────────────────────────────────────────────
const BR = 'br-1';
const cloud = { hits: [], requests: [], uploads: [], failUploads: 0, uploadDelay: 0, inFlight: 0, maxInFlight: 0, mine404: false, cancelOnUpload: null };
const sockets = new Set();
const wsSend = (sock, obj) => { const p = Buffer.from(JSON.stringify(obj)); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); try { sock.write(Buffer.concat([h, p])); } catch { /* gone */ } };
const ring = (deviceId) => { for (const s of sockets) wsSend(s, { type: 'log_request', device_id: deviceId }); };
const waiting = (dev) => cloud.requests.filter((r) => r.status === 'waiting' && r.device_id === dev);
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    const dev = String(req.headers['x-device-id'] ?? '');
    cloud.hits.push({ path: u.pathname, method: req.method, dev, auth: req.headers.authorization ?? '', nodeSecret: req.headers['x-node-secret'] ?? null });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'x-zaptill-server': '1' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/api/support/log-requests/mine') {
      if (cloud.mine404) return send(404, { error: 'Not found' });
      return send(200, { requests: waiting(dev).map(({ id, range_hours, include, requested_at }) => ({ id, range_hours, include, requested_at })) });
    }
    if (u.pathname === '/api/support/logs' && req.method === 'POST') {
      cloud.inFlight++; cloud.maxInFlight = Math.max(cloud.maxInFlight, cloud.inFlight);
      if (cloud.uploadDelay) await wait(cloud.uploadDelay);
      cloud.inFlight--;
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (cloud.failUploads > 0) { cloud.failUploads--; cloud.uploads.push({ failed: true, body, dev }); return send(503, { error: 'busy' }); }
      const r = cloud.requests.find((x) => x.id === body.request_id);
      if (r && cloud.cancelOnUpload === r.id) r.status = 'cancelled';
      if (r && r.status !== 'waiting') { cloud.uploads.push({ refused: true, body, dev }); return send(409, { error: 'closed', code: 'REQUEST_CLOSED', status: r.status }); }
      const text = zlib.gunzipSync(Buffer.from(body.log_gz_b64, 'base64')).toString('utf8');
      cloud.uploads.push({ body, text, dev, auth: req.headers.authorization ?? '' });
      if (r) r.status = 'delivered';
      return send(201, { reference: `REF${cloud.uploads.length}`, request_id: body.request_id });
    }
    if (u.pathname === '/api/pos/changes') return send(200, { last_seq: 1, changes: [] });
    if (u.pathname === '/api/pos/init') return send(200, { products: [], categories: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
      vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'restaurant', receiptHeader: 'KRUNCH', receiptFooter: '', kitchenExclusions: [], businessName: 'KRUNCH', currency: 'KES' });
    if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff: [] });
    if (u.pathname === '/api/pos/catalogue-version') return send(200, { version: 'cv:1' });
    if (/\/api\/(inventory|staff|tables|pumps|stations|shifts|day-close\/pending|pos\/test-data-clears)/.test(u.pathname)) return send(200, []);
    return send(200, {});
  });
});
srv.on('upgrade', (req, sock) => {
  if (!String(req.url).startsWith('/api/pos/live')) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-ZapTill-Server: 1\r\n\r\n`);
  sock.on('data', (buf) => {
    const op = buf[0] & 15; if (op === 8) { sock.end(); return; }
    let len = buf[1] & 127, o = 2; if (len === 126) { len = buf.readUInt16BE(2); o = 4; }
    const mask = buf.subarray(o, o + 4); const data = Buffer.from(buf.subarray(o + 4, o + 4 + len)).map((b, i) => b ^ mask[i % 4]);
    let m = null; try { m = JSON.parse(Buffer.from(data).toString()); } catch { /* ping or partial */ }
    if (m?.type === 'hello') { sockets.add(sock); wsSend(sock, { type: 'ready', last_seq: 1 }); }
  });
  sock.on('close', () => sockets.delete(sock)); sock.on('error', () => sockets.delete(sock));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const CLOUD = `http://127.0.0.1:${srv.address().port}`;

// ── The till ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-T1', 'biz-1', 'KRUNCH', '2026-10-20T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const LS = require(path.join(dist, 'liveSync.js'));
const LP = require(path.join(dist, 'logPull.js'));
const SL = require(path.join(dist, 'supportLogs.js'));
const NG = require(path.join(dist, 'nodeGateway.js'));
const mineHits = () => cloud.hits.filter((h) => h.path === '/api/support/log-requests/mine').length;
const posts = () => cloud.hits.filter((h) => h.path === '/api/support/logs' && h.method === 'POST').length;
const tillLog = () => fs.readFileSync(logBase, 'utf8');
const req = (over = {}) => { const r = { id: crypto.randomUUID(), device_id: 'dev-T1', range_hours: 24, include: {}, requested_at: new Date().toISOString(), status: 'waiting', ...over }; cloud.requests.push(r); return r; };

console.log('A533 — support pulls a till\'s log from the admin portal\n');
try {
  LP.startLogPull();

  // ── 1 ──
  const r1 = req({ range_hours: 72 });
  cloud.hits = [];
  await E.remoteCloseBeat();
  await until(() => cloud.uploads.length === 1);
  const u1 = cloud.uploads[0];
  ok('the 90 s beat asks /mine ONCE and answers a waiting 3-day request with ONE upload carrying its request_id',
    mineHits() === 1 && posts() === 1 && u1?.body?.request_id === r1.id && r1.status === 'delivered', JSON.stringify(cloud.hits));
  const t1 = u1?.text ?? '';
  if (process.env.SHOW_BUNDLE) console.log(t1);
  ok('…the 3-day window across the rolled files: 2 h, 30 h and 50 h ago in (swiftpos.log.1); 100 h ago out',
    /MARK-2H/.test(t1) && /MARK-30H/.test(t1) && /MARK-50H/.test(t1) && !/MARK-100H/.test(t1) && /swiftpos\.log, last 3 days/.test(t1), t1.slice(0, 3000));
  // The PIN is checked ON ITS OWN LINE (MARK-2H): the bundle also carries numbers of its own (disk free, a random request
  // id) that can contain "4321" by chance — CI on Linux, 2026-10-21, failed this way with the redaction working.
  const pinLine = (t) => (t.split('\n').find((l) => l.includes('MARK-2H')) ?? '');
  ok('…a PIN and a token written in the log do not appear (redacted on the till)',
    !!pinLine(t1) && !/4321/.test(pinLine(t1)) && !t1.includes(JWT) && !/eyJhbGci/.test(t1), pinLine(t1) || t1.slice(-1500));
  ok('…no auth.log — the sign-in history was not asked for', !/AUTHMARK/.test(t1) && !/auth\.log, last/.test(t1));
  ok('…the diagnostics block: who asked, version and role, sync and what waits, the A531 topics and channel, printer errors, disk',
    /Sent by: ZapTill support — a pull from the admin portal \(request /.test(t1) && /Diagnostics:/.test(t1)
    && /Version 1\.0\.20 · till · branch br-1 · terminal T1/.test(t1) && /Sync: online/.test(t1) && /Change-triggered sync \(A531\): /.test(t1)
    && /Topics: /.test(t1) && /Printer errors in the window: 1/.test(t1) && /receipt printer failed/.test(t1), t1.slice(0, 2500));
  // The till writes this line only after the cloud ANSWERS the upload; the stand-in cloud has the upload a moment before
  // that — wait for the line (flaky 2 in 5 when read at once, 2026-10-21).
  const logged = await until(() => tillLog().includes(`A533: logs pulled by ZapTill support (request ${r1.id})`) && tillLog().includes('reference REF1'));
  ok('…the shop\'s own log says it happened: "logs pulled by ZapTill support (request …)"', logged);
  cloud.hits = [];
  await E.remoteCloseBeat(); await wait(150);
  ok('answered → the next beat asks /mine once and uploads nothing', mineHits() === 1 && posts() === 0, JSON.stringify(cloud.hits));

  // ── 2 ──
  LS.startLiveSync();
  await until(() => LS.liveStatus().channel === 'push' && sockets.size === 1, 5000);
  ok('(the push channel is open)', sockets.size === 1, JSON.stringify(LS.liveStatus()));
  await wait(100);
  cloud.hits = [];
  ring('dev-T2');
  await wait(300);
  ok('a ring for ANOTHER device asks nothing', mineHits() === 0 && posts() === 0, JSON.stringify(cloud.hits));
  const r2 = req({ range_hours: 168, include: { auth: true } });
  ring('dev-T1');
  await until(() => cloud.uploads.length === 2);
  const t2 = cloud.uploads[1]?.text ?? '';
  ok('the doorbell: the till asks at once (no beat) and answers the 7-day request', mineHits() === 1 && cloud.uploads[1]?.body?.request_id === r2.id && r2.status === 'delivered',
    JSON.stringify(cloud.hits));
  ok('…7 days: 100 h ago in (swiftpos.log.2), 200 h ago out', /MARK-100H/.test(t2) && !/MARK-200H/.test(t2) && /last 7 days/.test(t2), t2.slice(0, 2000));
  ok('…the sign-in history when asked (auth.log)', /AUTHMARK/.test(t2) && /auth\.log, last 7 days/.test(t2));
  const opened = [...SL.lazyLogFiles(SL.rolledPaths(logBase, 10), NOW - 168 * 3_600_000)];
  ok('…swiftpos.log.3 (last written 199 h ago) is never opened for a 7-day window', opened.length === 3 && !opened.some((x) => /MARK-200H/.test(x)), String(opened.length));
  ok('…still redacted', !!pinLine(t2) && !/4321/.test(pinLine(t2)) && !t2.includes(JWT), pinLine(t2));

  // ── 3 ──
  LP._resetLogPull();
  const r3 = req();
  const r3b = req();
  cloud.failUploads = 99; cloud.uploadDelay = 60; cloud.maxInFlight = 0;
  cloud.hits = [];
  await Promise.all([LP.checkLogRequests('test'), LP.checkLogRequests('test again')]);
  ok('one upload at a time (two requests, two checks at once → never two uploads side by side)', cloud.maxInFlight === 1, String(cloud.maxInFlight));
  await LP.checkLogRequests('test'); await LP.checkLogRequests('test');
  const tried = cloud.uploads.filter((u) => u.failed && u.body.request_id === r3.id).length;
  ok('a failing upload is tried three times', tried === 3, String(tried));
  const before = posts();
  await LP.checkLogRequests('test');
  ok('…then left: a fourth check uploads nothing, the request stays waiting', posts() === before && r3.status === 'waiting' && r3b.status === 'waiting', `${posts()} vs ${before}`);
  ok('…and the shop\'s log says so', tillLog().includes(`log request ${r3.id} — sending failed 3 times`));
  cloud.failUploads = 0; cloud.uploadDelay = 0;

  // ── 4 ──
  LP._resetLogPull();
  r3.status = 'cancelled'; r3b.status = 'cancelled';
  const r4 = req();
  cloud.cancelOnUpload = r4.id;   // cancelled in the admin portal between the till's GET and its upload
  cloud.hits = [];
  await LP.checkLogRequests('test');
  const p4 = posts();
  r4.status = 'waiting';           // even were the cloud to list it again
  await LP.checkLogRequests('test');
  ok('a closed request (409: cancelled after the till asked) is never tried again', p4 === 1 && posts() === p4 && tillLog().includes(`log request ${r4.id} not answered`), `${p4} → ${posts()}`);
  r4.status = 'cancelled'; cloud.cancelOnUpload = null;
  LP._resetLogPull();
  cloud.mine404 = true; cloud.hits = [];
  await LP.checkLogRequests('test'); await LP.checkLogRequests('test');
  ok('an older cloud (its 404 on /mine) is not asked again for an hour', mineHits() === 1, String(mineHits()));
  cloud.mine404 = false;
  LS.stopLiveSync();

  // ── 5 ── a till behind a branch server
  LP._resetLogPull();
  const SECRET = 'branch-access-code-123';
  const nodeSeen = [];
  const node = http.createServer((q, s) => {
    nodeSeen.push({ url: q.url, secret: q.headers['x-node-secret'] ?? null });
    if (q.headers['x-node-secret'] !== SECRET) { s.writeHead(401, { 'content-type': 'application/json' }); s.end('{"error":"X-Node-Secret required"}'); return; }
    if (String(q.url).startsWith('/node/cloud/')) { void NG.forwardToCloud(q, s, CLOUD); return; }
    s.writeHead(404); s.end();
  });
  await new Promise((r) => node.listen(0, '127.0.0.1', r));
  const NODE = `http://127.0.0.1:${node.address().port}`;
  DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-P2', device_role: 'till', terminal_code: 'T2', device_name: 'Bar',
    node_url: NODE, node_secret: SECRET });
  const r5 = req({ device_id: 'dev-P2', range_hours: 24 });
  cloud.hits = [];
  await E.remoteCloseBeat();
  await until(() => r5.status === 'delivered');
  const viaNode = nodeSeen.filter((n) => /\/node\/cloud\/api\/support\/(log-requests\/mine|logs)/.test(n.url));
  const atCloud = cloud.hits.filter((h) => /\/api\/support\/(log-requests\/mine|logs)/.test(h.path));
  ok('a peer: the beat\'s GET and the upload go through the branch server\'s gateway', viaNode.length === 2 && r5.status === 'delivered', JSON.stringify(nodeSeen));
  ok('…the cloud sees the till\'s own session and device — never the branch access code',
    atCloud.length === 2 && atCloud.every((h) => h.dev === 'dev-P2' && h.auth === 'Bearer tok' && h.nodeSecret === null), JSON.stringify(atCloud));
  ok('…the peer\'s bundle names it', /Terminal: T2 · Bar · till · device dev-P2/.test(cloud.uploads.at(-1)?.text ?? '') && /behind a branch server/.test(cloud.uploads.at(-1)?.text ?? ''));
  node.close();
} catch (e) {
  console.log(`  FAIL threw: ${e?.stack ?? e}`); fail++;
} finally {
  try { LS.stopLiveSync(); } catch { /* */ }
  for (const s of sockets) { try { s.destroy(); } catch { /* */ } }
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
