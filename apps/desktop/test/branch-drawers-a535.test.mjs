// A535 (2026-10-20) — at a branch only the server talks to the cloud for drawer checks too; stock levels travel on change;
// the pull-logs bell reaches a till behind a server.
// Owner, 2026-10-19: "for a setup like KRUNCH only the server does the communication to cloud, not all tills" — and
// "this should only happen when there is a change, no need to keep asking for the same item".
//
// Drives the REAL compiled dist/main (branchDrawers, syncEngine's drawer checks and its 90 s beat, liveSync's push channel
// and /node/live, logPull, nodeGateway) on a REAL SQLite file, electron shimmed, against a stand-in cloud on a real port —
// HTTP (signed answers, A529) and a WebSocket on /api/pos/live (hand-made, as live-sync-a531) — and, for the peer part, a
// stand-in branch server whose /node/drawers and /node/live are answered by the REAL branchDrawers.answerDrawers and
// liveSync.serveLiveLog (run as the server: the role switched for the call), and whose /node/cloud is the REAL gateway.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/branch-drawers-a535.test.mjs
//
//   S  the branch server: ONE GET /api/pos/branch-drawers for the whole branch; a till's answer holds only ITS drawers;
//      the server's own drawer checks are answered from that copy (no /api/shifts/state of its own); a 'drawers' ring
//      asks the branch call at once and no /changes; a log request for one of its tills is passed on once.
//   K  stock: a stock change is stored as a delta (its own pending sale taken off again — that product only); the
//      30-minute re-read is not asked when the cloud sends stock as changes; an old cloud → the re-read stays.
//   P  a till behind the server: web sales, the web's close, a confirmation and the 90 s beat — ZERO gateway calls; a
//      remote day close named for it → its own /api/day-close/pending once; a web close on the cloud reaches it through
//      the server; a log request rung for it reaches it within one LAN beat and it uploads; an older server (404) → the
//      old way through the gateway.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
//   - answerDrawers without the device check on states                    → S "only ITS drawers" fails
//   - syncEngine pullShiftCloses without the _drawerSource branch          → S "no /api/shifts/state" and P "zero gateway" fail
//   - liveSync 'changed' handler calling catchUp for a drawers-only ring   → S "no /changes" fails
//   - liveSync without notePeerLogRequest                                  → S "passed on" fails
//   - writeStockRows re-applying no pending sale                           → K "taken off again" fails
//   - liveTick without the stockTravelsOnChange() check                    → K "not asked" fails
//   - remoteCloseBeat ignoring hints.day_close                             → P "zero gateway" (the beat) fails
//   - pullWebSales taking "no answer" as "no such drawer"                  → P "older server" fails
//
// A547 (owner, 2026-10-21: "you can also finish the leftovers"): EVERY day-close check on a till behind the server — the
// start-up steps and the day gate (learnCloudCloses), the remote-instructions step, the 10-minute full sync — asks the
// server's copy first (syncEngine runDayCloseInstructionsOnce), not only the 90 s beat: none named → ZERO gateway calls
// for it; named → its own /api/day-close/pending once; an older server → through the gateway as before.
// MUTATIONS (A547, each red on its own):
//   - runDayCloseInstructionsOnce without the hint check                  → P "A547: none named … ZERO gateway" fails
//   - the hint check taken as "skip" when the server does not answer      → P "A547: an older server" fails
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a535-'));
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
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── The stand-in cloud ───────────────────────────────────────────────────────────────────────────────────────────────
const BR = 'br-1';
const S_OWN = uid(1), S_PEER = uid(2), S_OTHER = uid(3), S_WAIT = uid(4);
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const cloud = {
  hits: [], seq: 10, changes: [], servesStock: true, noDrawers: false, requests: [], uploads: [], dayClose: [],
  shifts: [
    { id: S_OWN, device_id: 'dev-S', branch_id: BR, status: 'open', closed_at: null, close_method: null, closed_by: null, closing_float: null, cash_variance: null, expected_cash: null, notes: null, confirmed_at: null },
    { id: S_PEER, device_id: 'dev-P2', branch_id: BR, status: 'open', closed_at: null, close_method: null, closed_by: null, closing_float: null, cash_variance: null, expected_cash: null, notes: null, confirmed_at: null },
    { id: S_OTHER, device_id: 'dev-P3', branch_id: BR, status: 'open', closed_at: null, close_method: null, closed_by: null, closing_float: null, cash_variance: null, expected_cash: null, notes: null, confirmed_at: null },
    { id: S_WAIT, device_id: 'dev-P2', branch_id: BR, status: 'closed', closed_at: iso(3600_000), close_method: 'count', closed_by: 'u-1', closing_float: 1000, cash_variance: 0, expected_cash: 1000, notes: null,
      declared_methods: { cash: 1000 }, confirmed_at: null },
  ],
  orders: [
    { id: 'web-1', order_number: 'W-001', order_type: 'retail', status: 'completed', subtotal: 300, vat_amount: 0, discount_amount: 0, total: 300, shift_id: S_PEER, branch_id: BR,
      idempotency_key: null, created_at: iso(60_000), updated_at: iso(60_000),
      order_items: [{ id: 'oi-w1', product_id: 'p-1', product_name: 'Soda', unit_price: 100, quantity: 3, subtotal: 300 }],
      payments: [{ id: 'pay-w1', method: 'cash', amount: 300, status: 'completed', created_at: iso(60_000) }] },
    { id: 'cloud-own-1', order_number: 'T2-007', order_type: 'retail', status: 'voided', subtotal: 100, vat_amount: 0, total: 100, shift_id: S_PEER, branch_id: BR,
      idempotency_key: 'local-own-1', created_at: iso(120_000), updated_at: iso(30_000), voided_at: iso(30_000), void_reason: 'wrong item', order_items: [], payments: [] },
  ],
};
const prod = (id, name, price) => ({ id, category_id: 'c-1', name, base_price: price, status: 'active', has_variants: false, has_modifiers: false, track_stock: true,
  is_combo: false, branch_price: null, description: null, image_url: null });
const sockets = new Set();
const wsSend = (sock, obj) => { const p = Buffer.from(JSON.stringify(obj)); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); try { sock.write(Buffer.concat([h, p])); } catch { /* gone */ } };
const ringAll = (obj) => { for (const s of sockets) wsSend(s, obj); };
const drawersAnswer = (since) => {
  const ord = cloud.orders.filter((o) => !since || Date.parse(o.updated_at) > Date.parse(since) - 120_000);
  return { branch_id: BR, at: iso(), cursor: ord.reduce((m, o) => (!m || o.updated_at > m ? o.updated_at : m), since ?? null), shifts: cloud.shifts, orders: ord,
    beat: { day_close_devices: [...new Set(cloud.dayClose)], log_request_devices: [...new Set(cloud.requests.filter((r) => r.status === 'waiting').map((r) => r.device_id))], test_clear_latest: null } };
};
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const dev = String(req.headers['x-device-id'] ?? '');
    cloud.hits.push({ path: u.pathname, search: u.search, method: req.method, dev });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'x-zaptill-server': '1' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/api/pos/branch-drawers') return cloud.noDrawers ? send(404, { error: 'Not found' }) : send(200, drawersAnswer(u.searchParams.get('since')));
    if (u.pathname === '/api/shifts/state') { const ids = String(u.searchParams.get('ids') ?? '').split(','); return send(200, cloud.shifts.filter((s) => ids.includes(s.id))); }
    if (/\/api\/shifts\/[^/]+\/foreign-orders$/.test(u.pathname)) return send(200, { orders: [], own_reversals: [] });
    if (u.pathname === '/api/day-close/pending') return send(200, []);
    if (u.pathname === '/api/pos/test-data-clears') return send(200, []);
    if (u.pathname === '/api/support/log-requests/mine') return send(200, { requests: cloud.requests.filter((r) => r.status === 'waiting' && r.device_id === dev) });
    if (u.pathname === '/api/support/logs' && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const r = cloud.requests.find((x) => x.id === body.request_id);
      cloud.uploads.push({ body, dev, text: zlib.gunzipSync(Buffer.from(body.log_gz_b64, 'base64')).toString('utf8') });
      if (r) r.status = 'delivered';
      return send(201, { reference: `REF${cloud.uploads.length}`, request_id: body.request_id });
    }
    if (u.pathname === '/api/pos/changes') {
      const since = u.searchParams.get('since');
      const serves = cloud.servesStock ? { serves: ['stock'] } : {};
      if (since === null) return send(200, { last_seq: cloud.seq, changes: [], ...serves });
      const list = cloud.changes.filter((c) => c.seq > Number(since));
      return send(200, { last_seq: Math.max(Number(since), ...list.map((c) => c.seq)), changes: list, ...serves });
    }
    if (u.pathname === '/api/pos/init') return send(200, { products: [prod('p-1', 'Soda', 100), prod('p-2', 'Water', 50)],
      categories: [{ id: 'c-1', name: 'Drinks', color: '#0af', icon: null, sort_order: 1, status: 'active', is_kitchen: false }], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
      vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'restaurant', receiptHeader: 'KRUNCH', receiptFooter: '', kitchenExclusions: [], businessName: 'KRUNCH', currency: 'KES' });
    if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff: [] });
    if (u.pathname === '/api/pos/catalogue-version') return send(200, { version: 'cv:1' });
    if (/\/api\/(inventory|staff|tables|pumps|stations|shifts)/.test(u.pathname)) return send(200, []);
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
    if (m?.type === 'hello') { sockets.add(sock); wsSend(sock, { type: 'ready', last_seq: cloud.seq }); }
  });
  sock.on('close', () => sockets.delete(sock)); sock.on('error', () => sockets.delete(sock));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const CLOUD = `http://127.0.0.1:${srv.address().port}`;

// ── The machine ──────────────────────────────────────────────────────────────────────────────────────────────────────
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-S', 'biz-1', 'KRUNCH', '2026-10-20T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const LS = require(path.join(dist, 'liveSync.js'));
const BD = require(path.join(dist, 'branchDrawers.js'));
const LP = require(path.join(dist, 'logPull.js'));
const NG = require(path.join(dist, 'nodeGateway.js'));
const hits = (re) => cloud.hits.filter((h) => re.test(h.path)).length;
const kv = (k) => db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(k)?.value ?? null;
const putShift = (id, device, over = {}) => {
  db.prepare(`INSERT OR REPLACE INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, created_at, device_id, sync_status, closed_at, declared_methods, confirmed_at)
              VALUES (@id, 'biz-1', @branch, 'u-1', @at, @status, @at, @device, @sync, @closed_at, @declared, NULL)`)
    .run({ id, branch: BR, at: iso(7200_000), status: 'open', device, sync: 'synced', closed_at: null, declared: null, ...over });
};
const shift = (id) => db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(id);
const level = (pid) => db.prepare(`SELECT quantity FROM stock_levels WHERE product_id = ? AND branch_id = ?`).get(pid, BR)?.quantity;

console.log('A535 — drawer checks through the branch server, stock on change, the log bell to a till behind a server\n');
try {
  // ── S ── this machine is the branch server
  LS.startLiveSync();
  await until(() => LS.liveActive() && LS.liveStatus().channel === 'push' && sockets.size === 1, 6000);
  BD.startBranchDrawers();
  await wait(200);
  cloud.hits = [];
  await BD.pollBranchDrawers('test');
  ok('the server asks ONE GET /api/pos/branch-drawers for the whole branch (4 drawers, 2 sales)',
    hits(/^\/api\/pos\/branch-drawers$/) === 1 && BD.drawersStatus().drawers === 4, JSON.stringify({ hits: cloud.hits, st: BD.drawersStatus() }));
  const forP2 = BD.answerDrawers('dev-P2', { state_ids: [S_PEER, S_OTHER, S_OWN] });
  ok('…a till\'s answer holds only ITS drawers (dev-P2 asks about three, gets its own one)',
    forP2.status === 200 && forP2.body.states.length === 1 && forP2.body.states[0].id === S_PEER, JSON.stringify(forP2));
  const webP3 = BD.answerDrawers('dev-P3', { web_shift: { id: S_PEER, own_ids: [] } });
  ok('…another till\'s drawer\'s sales are not handed out (unknown to it)', webP3.body.web === 'unknown', JSON.stringify(webP3.body));
  // A542: what the branch server's Tech page shows (DrawersCopyPanel ← node:drawersStatus ← drawersStatus()).
  const st542 = BD.drawersStatus();
  ok('A542: the Tech page\'s drawer copy — last poll ok, 3 open + 1 waiting for a confirmation, 2 tills asked this hour, push line up, not on the fallback',
    st542.lastPollOk === true && !!st542.lastPollAt && st542.open === 3 && st542.awaitingConfirmation === 1 && st542.peersLastHour === 2
    && st542.channel === 'push' && st542.fallback === false && st542.fresh === true, JSON.stringify(st542));
  ok('A542: …a till that asked more than an hour ago is not counted', BD.drawersStatus(Date.now() + 3_600_001).peersLastHour === 0);
  ok('A542: the push line at a glance — connected since a time, no ring yet, no fallback polling',
    !!LS.liveStatus().push.since && LS.liveStatus().push.lastRingAt === null && LS.liveStatus().push.fallbackEveryS === null, JSON.stringify(LS.liveStatus().push));

  putShift(S_OWN, 'dev-S');
  cloud.shifts[0] = { ...cloud.shifts[0], status: 'closed', closed_at: iso(), close_method: 'force', closed_by: 'u-mgr', closed_by_name: 'Akinyi', closing_float: 0, cash_variance: 0 };
  ringAll({ type: 'changed', last_seq: cloud.seq, topics: ['drawers'] });
  await until(() => hits(/^\/api\/pos\/branch-drawers$/) === 2);
  ok('a "drawers" ring (a web close) → the server asks the branch call at once — and no /changes for it',
    hits(/^\/api\/pos\/branch-drawers$/) === 2 && hits(/^\/api\/pos\/changes/) === 0, JSON.stringify(cloud.hits));
  ok('A542: …the push line shows the cloud\'s last ring', !!LS.liveStatus().push.lastRingAt, JSON.stringify(LS.liveStatus().push));
  await wait(100);
  cloud.hits = [];
  const closedHere = await E.pullShiftCloses();
  ok('the server\'s own drawer check is answered from its copy: the web close adopted, NO /api/shifts/state of its own',
    closedHere === 1 && shift(S_OWN).status !== 'open' && hits(/\/api\/shifts\//) === 0, JSON.stringify({ closedHere, s: shift(S_OWN)?.status, hits: cloud.hits }));

  ringAll({ type: 'log_request', device_id: 'dev-P2' });
  await wait(200);
  const bell1 = LS.serveLiveLog(0, BR, null, 'dev-P2');
  const bell2 = LS.serveLiveLog(0, BR, null, 'dev-P2');
  const bellOther = LS.serveLiveLog(0, BR, null, 'dev-P3');
  ok('a log request rung for one of its tills is passed on ONCE, on that till\'s /node/live (not another till\'s)',
    bell1.log_request === true && !bell2.log_request && !bellOther.log_request, JSON.stringify({ bell1, bell2 }));

  // ── K ── stock levels on change
  db.prepare(`INSERT OR REPLACE INTO stock_levels (product_id, branch_id, quantity, low_stock_threshold, synced_at) VALUES ('p-1', ?, 50, 5, 'x'), ('p-2', ?, 20, 5, 'x')`).run(BR, BR);
  db.prepare(`UPDATE products SET track_stock = 1`).run();
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, created_at, device_id, sync_status)
              VALUES ('own-p1', 'biz-1', ?, 'S1-001', 'completed', 200, 0, 200, ?, 'dev-S', 'pending'), ('own-p2', 'biz-1', ?, 'S1-002', 'completed', 50, 0, 50, ?, 'dev-S', 'pending')`).run(BR, iso(), BR, iso());
  db.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal) VALUES ('oi-1', 'own-p1', 'p-1', 'Soda', 100, 2, 200), ('oi-2', 'own-p2', 'p-2', 'Water', 50, 1, 50)`).run();
  cloud.seq++;
  cloud.changes.push({ seq: cloud.seq, topic: 'stock', table: 'stock', id: 'p-1', op: 'upsert', row: { product_id: 'p-1', branch_id: BR, quantity: 40, low_stock_threshold: 5, qty_pieces: 0 } });
  cloud.hits = [];
  ringAll({ type: 'changed', last_seq: cloud.seq, topics: ['stock'] });
  await until(() => level('p-1') !== 50);
  ok('a stock change arrives as ONE row: the cloud\'s 40 less this server\'s own sale still waiting (2) = 38; Water untouched (20, not 19)',
    level('p-1') === 38 && level('p-2') === 20 && hits(/^\/api\/pos\/changes/) === 1 && hits(/^\/api\/inventory/) === 0, JSON.stringify({ p1: level('p-1'), p2: level('p-2'), hits: cloud.hits }));
  const served = LS.serveLiveLog(Number(kv('live_floor') ?? 0), BR, null, 'dev-P2');
  ok('…logged for the server\'s tills (/node/live carries the stock row and says stock travels on change)',
    served.changes.some((c) => c.table === 'stock' && c.row.quantity === 40) && served.serves?.includes('stock'), JSON.stringify(served).slice(0, 600));
  cloud.hits = [];
  db.prepare(`DELETE FROM maintenance_state WHERE key = 'live_stock_at'`).run();
  await LS.liveTick(Date.now() + 31 * 60_000);
  ok('the 30-minute stock re-read is NOT asked (stock travels on change)', hits(/^\/api\/inventory/) === 0 && kv('live_serves_stock') === '1', JSON.stringify(cloud.hits));
  cloud.servesStock = false;
  cloud.seq++; cloud.changes.push({ seq: cloud.seq, topic: 'menu', table: 'categories', id: 'c-1', op: 'upsert', row: { id: 'c-1', name: 'Drinks', status: 'active' } });
  ringAll({ type: 'changed', last_seq: cloud.seq, topics: ['menu'] });
  await until(() => kv('live_serves_stock') === '0');
  cloud.hits = [];
  db.prepare(`DELETE FROM maintenance_state WHERE key = 'live_stock_at'`).run();
  await LS.liveTick(Date.now() + 62 * 60_000);
  ok('…an older cloud (no stock in its changes): the 30-minute re-read stays', hits(/^\/api\/inventory/) === 1, JSON.stringify(cloud.hits));
  cloud.servesStock = true;
  LS.stopLiveSync();
  for (const s of [...sockets]) s.destroy();

  // ── P ── this machine is a till (dev-P2) behind a stand-in branch server
  const SECRET = 'branch-access-code-123';
  const node = { gateway: [], drawers404: false, seen: [] };
  const asServer = (fn) => {
    const was = DC.getDeviceConfig();
    DC.saveDeviceConfig({ device_role: 'node', device_id: 'dev-S' });
    try { return fn(); } finally { DC.saveDeviceConfig({ device_role: was.device_role, device_id: was.device_id }); }
  };
  const nodeSrv = http.createServer((q, s) => {
    const u = new URL(q.url, 'http://n');
    node.seen.push(u.pathname);
    if (q.headers['x-node-secret'] !== SECRET) { s.writeHead(401, { 'content-type': 'application/json' }); s.end('{"error":"X-Node-Secret required"}'); return; }
    if (u.pathname.startsWith('/node/cloud/')) { node.gateway.push(u.pathname.slice('/node/cloud'.length)); void NG.forwardToCloud(q, s, CLOUD); return; }
    const reply = (st, b) => { s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(b)); };
    const chunks = [];
    q.on('data', (c) => chunks.push(c));
    q.on('end', () => {
      const dev = String(q.headers['x-device-id'] ?? '');
      if (u.pathname === '/node/drawers') {
        if (node.drawers404) return reply(404, { error: 'not found' });
        const a = asServer(() => BD.answerDrawers(dev, JSON.parse(Buffer.concat(chunks).toString() || '{}')));
        return reply(a.status, a.body);
      }
      if (u.pathname === '/node/live') {
        const since = u.searchParams.get('since');
        return reply(200, asServer(() => LS.serveLiveLog(since === null ? null : Number(since), BR, 'L1', dev)));
      }
      reply(404, { error: 'not found' });
    });
  });
  await new Promise((r) => nodeSrv.listen(0, '127.0.0.1', r));
  const NODE = `http://127.0.0.1:${nodeSrv.address().port}`;
  DC.saveDeviceConfig({ device_role: 'till', device_id: 'dev-P2', terminal_code: 'T2', device_name: 'Bar', node_url: NODE, node_secret: SECRET });
  db.prepare(`DELETE FROM shifts`).run();
  putShift(S_PEER, 'dev-P2');
  putShift(S_WAIT, 'dev-P2', { status: 'closed', closed_at: iso(3600_000), declared: '{"cash":1000}' });
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, created_at, device_id, sync_status, shift_id)
              VALUES ('local-own-1', 'biz-1', ?, 'T2-007', 'completed', 100, 0, 100, ?, 'dev-P2', 'synced', ?)`).run(BR, iso(120_000), S_PEER);
  cloud.shifts[3] = { ...cloud.shifts[3], confirmed_at: iso(60_000), confirmed_by: 'u-mgr', confirmed_by_name: 'Akinyi', confirmed_methods: { cash: 1000 }, expected_methods: { cash: 1000 } };
  await asServer(() => BD.pollBranchDrawers('test'));
  await wait(50);
  cloud.hits = []; node.gateway = [];
  const web = await E.pullWebSales();
  const closes = await E.pullShiftCloses();
  const confirms = await E.pullShiftConfirmations();
  await E.remoteCloseBeat();
  await wait(200);
  const webRow = db.prepare(`SELECT origin, status FROM orders WHERE id = 'web-1'`).get();
  ok('a till behind the server: web sales, the web\'s closes, a confirmation and the 90 s beat — ZERO gateway calls',
    node.gateway.length === 0 && cloud.hits.length === 0, JSON.stringify({ gateway: node.gateway, cloud: cloud.hits }));
  ok('…the web\'s sale on its drawer is stored (origin web) and its own sale voided on the web is voided here',
    web >= 2 && webRow?.origin === 'web' && db.prepare(`SELECT status FROM orders WHERE id = 'local-own-1'`).get()?.status === 'voided', JSON.stringify({ web, webRow }));
  ok('…the confirmation made elsewhere is taken; its open drawer stays open (the cloud has it open)',
    confirms === 1 && !!shift(S_WAIT).confirmed_at && closes === 0 && shift(S_PEER).status === 'open', JSON.stringify({ confirms, closes }));

  cloud.shifts[1] = { ...cloud.shifts[1], status: 'closed', closed_at: iso(), close_method: 'force', closed_by: 'u-mgr', closed_by_name: 'Akinyi', closing_float: 0, cash_variance: 0 };
  await asServer(() => BD.pollBranchDrawers('the cloud rang (drawers)'));
  cloud.hits = []; node.gateway = [];
  const closed2 = await E.pullShiftCloses();
  ok('a web close on the cloud reaches the till THROUGH the server (one branch call by the server, none by the till)',
    closed2 === 1 && shift(S_PEER).status !== 'open' && node.gateway.length === 0 && cloud.hits.length === 0, JSON.stringify({ closed2, gw: node.gateway, cloud: cloud.hits }));

  cloud.dayClose.push('dev-P2');
  await asServer(() => BD.pollBranchDrawers('test'));
  node.gateway = [];
  E.setDrawerSource(BD.drawerSource);   // the beat's hints are remembered 5 s (the beats here are not 90 s apart)
  await E.remoteCloseBeat();
  await wait(200);
  ok('a remote day close named for this till → it asks its own /api/day-close/pending once (through the gateway), nothing else',
    node.gateway.length === 1 && node.gateway[0] === '/api/day-close/pending', JSON.stringify(node.gateway));
  // A547: …and the start-up / day-gate check (learnCloudCloses) collects it too while it is named.
  node.gateway = [];
  E.setDrawerSource(BD.drawerSource);
  await E.learnCloudCloses();
  ok('A547: named for this till, the day gate\'s check (learnCloudCloses) collects it — /api/day-close/pending through the gateway',
    node.gateway.filter((p) => p === '/api/day-close/pending').length === 1, JSON.stringify(node.gateway));
  cloud.dayClose = [];
  await asServer(() => BD.pollBranchDrawers('test'));
  // A547: none named — every other day-close check (not only the 90 s beat) asks the server's copy: no gateway call.
  node.gateway = []; cloud.hits = [];
  E.setDrawerSource(BD.drawerSource);
  const learned = await E.learnCloudCloses();
  await E.runRemoteInstructionsNow();
  await wait(200);
  ok('A547: none named — the day gate\'s check (learnCloudCloses) and the remote-instructions step: ZERO gateway calls for the day close',
    learned === true && !node.gateway.includes('/api/day-close/pending') && !cloud.hits.some((h) => /day-close/.test(h.path)),
    JSON.stringify({ gw: node.gateway, cloud: cloud.hits }));

  // the log bell: the cloud rings the server's socket for dev-P2 (part S proved the socket → notePeerLogRequest)
  LP.startLogPull();
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('live_seq', '0', 'x'), ('live_node_local', 'L1', 'x'), ('live_full_at', ?, 'x'), ('live_scope', 'biz-1|br-1', 'x')`).run(iso());
  LS._resetLive();
  const r = { id: crypto.randomUUID(), device_id: 'dev-P2', range_hours: 24, include: {}, requested_at: iso(), status: 'waiting' };
  cloud.requests.push(r);
  asServer(() => LS.notePeerLogRequest('dev-P2'));
  node.gateway = [];
  const t0 = Date.now();
  await LS.liveTick(t0);
  await LS.liveTick(t0 + 25_000);
  await until(() => r.status === 'delivered', 4000);
  ok('a log request rung for this till reaches it within ONE LAN beat (/node/live) and it uploads (through the gateway, A533 unchanged)',
    r.status === 'delivered' && cloud.uploads.at(-1)?.body?.request_id === r.id && cloud.uploads.at(-1)?.dev === 'dev-P2'
    && node.gateway.includes('/api/support/log-requests/mine') && node.gateway.includes('/api/support/logs'), JSON.stringify({ st: r.status, gw: node.gateway, seen: node.seen.slice(-6) }));

  node.drawers404 = true;
  BD._resetBranchDrawers();
  putShift(S_PEER, 'dev-P2');
  cloud.shifts[1] = { ...cloud.shifts[1], status: 'open', closed_at: null };
  node.gateway = [];
  await E.pullShiftCloses();
  await E.pullWebSales();
  ok('an older branch server (its 404 for /node/drawers): the till asks the cloud through the gateway, as before',
    node.gateway.some((p) => p.startsWith('/api/shifts/state')) && node.gateway.some((p) => /foreign-orders$/.test(p)), JSON.stringify(node.gateway));
  // A547: the older server answers no day-close hint → the till asks its own /api/day-close/pending through the gateway.
  node.gateway = [];
  E.setDrawerSource(BD.drawerSource);
  await E.learnCloudCloses();
  ok('A547: an older server (no answer to the hint) → the day-close check goes through the gateway, as before',
    node.gateway.includes('/api/day-close/pending'), JSON.stringify(node.gateway));
  ok('A542: …and the till\'s drawer status says it is on the fallback path', BD.drawersStatus().fallback === true && !!BD.drawersStatus().fallbackUntil, JSON.stringify(BD.drawersStatus()));
  // A542: a branch server whose cloud does not answer for the branch in one call — the Tech page says fallback, poll failed.
  BD._resetBranchDrawers();
  cloud.noDrawers = true;
  await asServer(() => BD.pollBranchDrawers('test'));
  const fb = asServer(() => BD.drawersStatus());
  ok('A542: a server whose cloud has no branch call → its Tech page shows the fallback (each till asks) and the poll failed',
    fb.role === 'server' && fb.fallback === true && fb.lastPollOk === false && !!fb.lastPollAt, JSON.stringify(fb));
  cloud.noDrawers = false;
  nodeSrv.close();
} catch (e) {
  console.log(`  FAIL threw: ${e?.stack ?? e}`); fail++;
} finally {
  try { LS.stopLiveSync(); } catch { /* */ }
  try { BD.stopBranchDrawers(); } catch { /* */ }
  for (const s of sockets) { try { s.destroy(); } catch { /* */ } }
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
