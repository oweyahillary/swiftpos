// A531 (2026-10-19) — the till takes a change when there is one, and only the rows that changed.
// Owner: "this should only happen when there is a change, no need to keep asking for the same item … Critical should be
// instant, non-critical can take effect after 1 hr or 30 min", "the till does not have to check, the trigger should happen
// instantly — if I change fries from 100 to 150 the trigger should only send the affected product and price, not the
// whole menu … if Eugene's PIN changes only Eugene's change gets synced", and "only the server does the communication to
// cloud, not all tills".
//
// Drives the REAL compiled dist/main (liveSync, syncEngine's whole pull and applyChangeEntries, branchStaff, staffRoster,
// cloudGateway) on a REAL SQLite file, electron shimmed, against a stand-in cloud on a real port — HTTP (signed answers,
// A529) and a WebSocket on /api/pos/live (a small hand-made one: the desktop has no ws package) — and a stand-in branch
// server for the peer part.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/live-sync-a531.test.mjs
//
//   1  first start: where the log is, then the whole catalogue ONCE; nothing changed → no pull (the 10-minute sync too:
//      no /init, no /changes while the push channel is open; the beat asks nothing).
//   2  a menu change rings: ONE /changes, ONLY the fries row changes (the other 69 products untouched); a delete marker
//      takes a product off the grid and a table away.
//   3  Eugene's PIN: his row on the staff list replaced, the other 149 untouched.
//   4  a look change waits while a drawer is open (not at 10 minutes, not mid-sale at 31), then is applied; idle → at once.
//   5  the daily safety pull; the push channel down → asked every 5 minutes (20 s with a drawer open); back → catches up;
//      a till moved to another branch takes the whole catalogue for it.
//   6  a branch server logs what it applied for its tills (/node/live: the PIN hash from its own list; behind → resync).
//   7  a peer behind a branch server never asks the cloud (changes, init, roster, version): it takes the change from the
//      server; the roster timer stands down (30-minute safety).
//   8  an old cloud (no /changes: its signed 404) → today's behaviour (the whole pull on the 10-minute sync).
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-19):
//   - syncEngine syncAll without the liveCatalogueActive() branch          → 1 "the 10-minute sync pulls nothing" fails
//   - liveSync handle() applying every topic at once                        → 4 "a look change waits" fails
//   - liveSync applyWaitingIfDue without the midSale() check                → 4 "not mid-sale" fails
//   - liveSync catchUpOnce taking a change as a whole pull                  → 2 "only the fries row" and 3 fail
//   - liveSync liveTick without the daily check                             → 5 "daily safety pull" fails
//   - liveSync without the branch-move check (moved = false)                → 5 "moved to another branch" fails
//   - liveSync fetchChanges ignoring shape() (peer asks the cloud)          → 7 "never asks the cloud" fails
//   - liveSync goLegacy not called on 404                                   → 8 fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a531-'));
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
Module._resolveFilename = function (req, parent, ...rest) { if (req === 'electron') return shim; return orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await wait(20); } return false; };

// ── The stand-in cloud ───────────────────────────────────────────────────────────────────────────────────────────────
const BR = 'br-1';
const pid = (i) => `p-${String(i).padStart(3, '0')}`;
const cloud = {
  products: Array.from({ length: 70 }, (_, i) => ({ id: pid(i), category_id: 'cat-1', name: i === 0 ? 'Fries' : `Item ${i}`, base_price: i === 0 ? 100 : 50 + i,
    status: 'active', has_variants: false, has_modifiers: false, track_stock: false, is_combo: false, branch_price: null, description: null, image_url: null })),
  staff: Array.from({ length: 150 }, (_, i) => ({ staff_id: i === 0 ? 'u-eugene' : `u-${i}`, name: i === 0 ? 'Eugene' : `Staff ${i}`, role_name: 'Cashier',
    branch_id: BR, permissions: { 'orders.create': true }, pin_hash: `$2b$10$${'o'.repeat(53)}${i}`, override_pin_hash: null, status: 'active' })),
  seq: 100, changes: [], hasChanges: true, hits: [], signed: true,
};
const initBody = () => ({ products: cloud.products, categories: [{ id: 'cat-1', name: 'Sides', color: '#f00', icon: null, sort_order: 1, status: 'active', is_kitchen: false }],
  comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR, vatRate: 16, ctlRate: 0, maxDiscountPct: 50,
  businessType: 'restaurant', receiptHeader: 'KRUNCH', receiptFooter: 'Asante', kitchenExclusions: [], businessName: 'KRUNCH', currency: 'KES',
  receiptPayLabel: '', receiptPayNumber: '' });
const sockets = new Set();
const wsSend = (sock, obj) => { const p = Buffer.from(JSON.stringify(obj)); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); try { sock.write(Buffer.concat([h, p])); } catch { /* gone */ } };
const wsClose = (sock, code) => { try { sock.write(Buffer.from([0x88, 2, code >> 8, code & 255])); sock.end(); } catch { /* gone */ } };
const ring = () => { for (const s of sockets) wsSend(s, { type: 'changed', last_seq: cloud.seq, topics: ['menu'] }); };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  cloud.hits.push(u.pathname + (u.search || ''));
  const send = (status, body) => {
    const h = { 'content-type': 'application/json' }; if (cloud.signed) h['x-zaptill-server'] = '1';
    res.writeHead(status, h); res.end(JSON.stringify(body));
  };
  if (u.pathname === '/api/pos/changes') {
    if (!cloud.hasChanges) return send(404, { error: 'Not found' });
    const since = u.searchParams.get('since');
    if (since === null) return send(200, { last_seq: cloud.seq, changes: [] });
    const list = cloud.changes.filter((c) => c.seq > Number(since));
    return send(200, { last_seq: Math.max(Number(since), ...list.map((c) => c.seq)), changes: list });
  }
  if (u.pathname === '/api/pos/init') return send(200, initBody());
  if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff: cloud.staff });
  if (u.pathname === '/api/pos/catalogue-version') return send(200, { version: 'cv:1' });
  if (/\/api\/(inventory|staff|tables|pumps|stations|shifts|day-close\/pending|pos\/test-data-clears)/.test(u.pathname)) return send(200, []);
  return send(200, {});
});
srv.on('upgrade', (req, sock) => {
  if (!String(req.url).startsWith('/api/pos/live') || cloud.refuseSocket) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-ZapTill-Server: 1\r\n\r\n`);
  sock.on('data', (buf) => {
    const op = buf[0] & 15; if (op === 8) { sock.end(); return; }
    let len = buf[1] & 127, at = 2; if (len === 126) { len = buf.readUInt16BE(2); at = 4; }
    const mask = buf.subarray(at, at + 4); const data = Buffer.from(buf.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]);
    let m = null; try { m = JSON.parse(Buffer.from(data).toString()); } catch { /* ping or partial */ }
    if (m?.type === 'hello') { sockets.add(sock); wsSend(sock, { type: 'ready', last_seq: cloud.seq }); }
  });
  sock.on('close', () => sockets.delete(sock)); sock.on('error', () => sockets.delete(sock));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const CLOUD = `http://127.0.0.1:${srv.address().port}`;

// ── The till ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-T1', 'biz-1', 'KRUNCH', '2026-10-19T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const LS = require(path.join(dist, 'liveSync.js'));
const SR = require(path.join(dist, 'staffRoster.js'));
const BS = require(path.join(dist, 'branchStaff.js'));
const AT = require(path.join(dist, 'activityTracker.js'));
const hits = (re) => cloud.hits.filter((h) => re.test(h)).length;
const product = (id) => db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
const kv = (k) => db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(k)?.value ?? null;
const openDrawer = (on) => {
  if (on) db.prepare(`INSERT OR REPLACE INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, created_at, device_id) VALUES ('s-1', 'biz-1', ?, 'u-1', ?, 'open', ?, 'dev-T1')`).run(BR, new Date().toISOString(), new Date().toISOString());
  else db.prepare(`DELETE FROM shifts WHERE id = 's-1'`).run();
};
const change = (table, id, op, row, topic = 'menu') => { cloud.seq++; const c = { seq: cloud.seq, topic, table, id, op, ...(row ? { row } : {}) }; cloud.changes.push(c); return c; };

console.log('A531 — change-triggered sync on the till\n');
try {
  // ── 1 ──
  LS.startLiveSync();
  await until(() => LS.liveActive() && LS.liveStatus().channel === 'push', 5000);
  ok('first start: where the log is, then the whole catalogue once (70 products), changes from there on',
    hits(/^\/api\/pos\/changes\?branch_id=/) === 1 && hits(/^\/api\/pos\/init/) === 1 && Number(kv('live_seq')) === 100
    && db.prepare(`SELECT COUNT(*) AS n FROM products`).get().n === 70, JSON.stringify(cloud.hits));
  ok('…the push channel is open (one socket to the cloud)', LS.liveStatus().channel === 'push' && sockets.size === 1, JSON.stringify(LS.liveStatus()));
  await wait(200);
  cloud.hits = [];
  await LS.liveTick(Date.now() + 10 * 60_000);
  const r10 = await E.syncAll();
  ok('nothing changed: the beat and the 10-minute sync ask NOTHING about the catalogue (no /init, no /changes, no version)',
    hits(/\/api\/pos\/(init|changes|catalogue-version)/) === 0, JSON.stringify(cloud.hits) + JSON.stringify(r10));

  // ── 2 ──
  const before = Object.fromEntries(db.prepare(`SELECT id, base_price, synced_at FROM products`).all().map((p) => [p.id, p]));
  await wait(15);
  cloud.hits = [];
  change('products', pid(0), 'upsert', { product: { ...cloud.products[0], base_price: 150 }, comboItems: null });
  ring();
  await until(() => product(pid(0)).base_price === 150);
  const after = db.prepare(`SELECT id, base_price, synced_at FROM products`).all();
  const touched = after.filter((p) => p.synced_at !== before[p.id].synced_at).map((p) => p.id);
  ok('fries 100 → 150 rings: ONE /changes, no /init — and ONLY the fries row was written (69 untouched)',
    hits(/^\/api\/pos\/changes/) === 1 && hits(/\/api\/pos\/init/) === 0 && touched.length === 1 && touched[0] === pid(0),
    JSON.stringify({ hits: cloud.hits, touched }));
  db.prepare(`INSERT OR REPLACE INTO tables (id, name, synced_at) VALUES ('t-9', 'T9', 'x')`).run();
  change('products', pid(5), 'delete');
  change('tables', 't-9', 'delete', null, 'setup');
  ring();
  await until(() => product(pid(5)).status === 'inactive');
  ok('a delete marker: the product leaves the grid (status inactive, an old sale still names it)', product(pid(5)).status === 'inactive');

  // ── 3 ──
  BS.storeBranchStaff(BR, cloud.staff);
  const staffBefore = Object.fromEntries(db.prepare(`SELECT staff_id, updated_at, pin_hash_enc FROM branch_staff`).all().map((r) => [r.staff_id, r]));
  await wait(15);
  cloud.hits = [];
  const newHash = '$2b$10$' + 'n'.repeat(53);
  change('staff', 'u-eugene', 'upsert', { user: { id: 'u-eugene', name: 'Eugene', roles: { name: 'Cashier' }, status: 'active' },
    roster: { ...cloud.staff[0], pin_hash: newHash } }, 'staff');
  ring();
  await until(() => db.prepare(`SELECT pin_hash_enc FROM branch_staff WHERE staff_id = 'u-eugene'`).get()?.pin_hash_enc === Buffer.from('w:' + newHash).toString('base64'));
  const staffAfter = db.prepare(`SELECT staff_id, updated_at FROM branch_staff`).all();
  const staffTouched = staffAfter.filter((r) => r.updated_at !== staffBefore[r.staff_id]?.updated_at).map((r) => r.staff_id);
  ok('Eugene\'s PIN: his row replaced (the new hash), the other 149 untouched, nothing but /changes asked',
    staffAfter.length === 150 && staffTouched.length === 1 && staffTouched[0] === 'u-eugene' && hits(/branch-staff|\/api\/pos\/init/) === 0,
    JSON.stringify({ n: staffAfter.length, staffTouched, hits: cloud.hits }));
  // the table delete was setup (non-critical): applied at once only because no drawer is open
  ok('…and the table delete (setup) applied at once — no drawer open, the till is idle', !db.prepare(`SELECT 1 FROM tables WHERE id = 't-9'`).get());

  // ── 4 ──
  openDrawer(true);
  await LS.liveTick(Date.now());   // the beat sees the drawer open (a shift opening is itself a moment to apply what waits)
  const footer0 = DC.getDeviceConfig().receipt_footer;
  change('config', 'look', 'upsert', { receiptFooter: 'Karibu tena' }, 'look');
  ring();
  await until(() => LS.liveStatus().waiting === 1);
  ok('a look change while a drawer is open WAITS (kept, not applied)', LS.liveStatus().waiting === 1 && DC.getDeviceConfig().receipt_footer === footer0);
  const t0 = Date.now();
  await LS.liveTick(t0 + 10 * 60_000);
  ok('…still waiting at 10 minutes (a drawer open)', DC.getDeviceConfig().receipt_footer === footer0 && LS.liveStatus().waiting === 1);
  AT.noteRendererPing({ busy: { cart: true, payment: false } });
  LS.applyWaitingIfDue(t0 + 31 * 60_000);
  ok('…not mid-sale even past 30 minutes (a cart with items)', DC.getDeviceConfig().receipt_footer === footer0);
  AT.noteRendererPing({ busy: { cart: false, payment: false } });
  LS.applyWaitingIfDue(t0 + 31 * 60_000);
  ok('…applied at 30 minutes once the sale is done', DC.getDeviceConfig().receipt_footer === 'Karibu tena' && LS.liveStatus().waiting === 0);
  change('config', 'look', 'upsert', { receiptFooter: 'Shift change' }, 'look');
  ring();
  await until(() => LS.liveStatus().waiting === 1);
  openDrawer(false);
  await LS.liveTick(Date.now());
  ok('…and a waiting change goes in at the shift close (the drawer closed)', DC.getDeviceConfig().receipt_footer === 'Shift change');

  // ── 5 ──
  cloud.hits = [];
  db.prepare(`UPDATE maintenance_state SET value = ? WHERE key = 'live_full_at'`).run(new Date(Date.now() - 25 * 3600_000).toISOString());
  await LS.liveTick(Date.now());
  ok('the daily safety pull: the whole catalogue once after 24 h', hits(/^\/api\/pos\/init/) === 1, JSON.stringify(cloud.hits));
  for (const s of [...sockets]) wsClose(s, 1001);
  cloud.refuseSocket = true;
  await until(() => LS.liveStatus().channel === 'polling');
  cloud.hits = [];
  const tDown = Date.now();
  await LS.liveTick(tDown + 60_000);
  const at1 = hits(/^\/api\/pos\/changes/);
  await LS.liveTick(tDown + 6 * 60_000);
  ok('push channel down, no drawer: nothing asked at 1 minute, asked at 5', at1 === 0 && hits(/^\/api\/pos\/changes/) === 1, `${at1} then ${hits(/^\/api\/pos\/changes/)}`);
  openDrawer(true);
  cloud.hits = [];
  await LS.liveTick(tDown + 6 * 60_000 + 25_000);
  ok('…with a drawer open: every 20 s', hits(/^\/api\/pos\/changes/) === 1, JSON.stringify(cloud.hits));
  openDrawer(false);
  change('products', pid(7), 'upsert', { product: { ...cloud.products[7], base_price: 999 }, comboItems: null });
  cloud.refuseSocket = false;
  await until(async () => { await LS.liveTick(Date.now() + 10 * 60_000); return product(pid(7)).base_price === 999 && LS.liveStatus().channel === 'push'; }, 4000);
  ok('the channel back: it catches up from the change it last applied', product(pid(7)).base_price === 999 && LS.liveStatus().channel === 'push', JSON.stringify(LS.liveStatus()));

  cloud.hits = [];
  DC.saveDeviceConfig({ branch_id: 'br-2' });
  await LS.catchUp('test');
  const movedPull = hits(/^\/api\/pos\/init\?branch_id=br-2/);
  DC.saveDeviceConfig({ branch_id: BR });
  await LS.catchUp('test');
  ok('a till moved to another branch takes the whole catalogue for it (and back)', movedPull === 1 && hits(/^\/api\/pos\/init\?branch_id=br-1/) === 1, JSON.stringify(cloud.hits));

  // ── 6 ── this machine as the branch server
  DC.saveDeviceConfig({ device_role: 'node' });
  db.prepare(`DELETE FROM live_log`).run();
  change('products', pid(8), 'upsert', { product: { ...cloud.products[8], base_price: 888 }, comboItems: null });
  change('staff', 'u-eugene', 'upsert', { user: { id: 'u-eugene', name: 'Eugene', roles: { name: 'Cashier' }, status: 'active' }, roster: { ...cloud.staff[0], pin_hash: newHash } }, 'staff');
  await LS.catchUp('test');
  const served = LS.serveLiveLog(0, BR, 'local-1');
  const logged = db.prepare(`SELECT row FROM live_log WHERE table_name = 'staff'`).get();
  ok('a branch server logs what it applied for its tills, in order', served.changes.length === 2 && served.changes[0].id === pid(8) && served.changes[0].row.product.base_price === 888,
    JSON.stringify(served).slice(0, 300));
  ok('…the staff row is kept WITHOUT its PIN hash, served with the hash from its own list', !JSON.parse(logged.row).roster.pin_hash
    && served.changes[1].row.roster.pin_hash === newHash);
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('live_floor', '999999', 'x')`).run();
  ok('…a till further back than its log keeps: full_resync_needed', LS.serveLiveLog(0, BR, null).full_resync_needed === true);
  db.prepare(`DELETE FROM maintenance_state WHERE key = 'live_floor'`).run();
  LS.stopLiveSync();

  // ── 7 ── this machine as a till behind that branch server
  const node = { changes: [], hits: [] };
  const nodeSrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://n'); node.hits.push(u.pathname + u.search);
    if (u.pathname === '/node/live') {
      const since = u.searchParams.get('since');
      const list = since === null ? [] : node.changes.filter((c) => c.seq > Number(since));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ last_seq: Math.max(Number(since ?? 0), 5, ...list.map((c) => c.seq)), changes: list, local: 'L1' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise((r) => nodeSrv.listen(0, '127.0.0.1', r));
  DC.saveDeviceConfig({ device_role: 'till', node_url: `http://127.0.0.1:${nodeSrv.address().port}`, node_secret: 'sekret' });
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('live_seq', '5', 'x'), ('live_node_local', 'L1', 'x'), ('live_full_at', ?, 'x'), ('live_scope', 'biz-1|br-1', 'x')`).run(new Date().toISOString());
  LS._resetLive();
  LS.startLiveSync();
  for (const s of [...sockets]) wsClose(s, 1000);
  cloud.hits = [];
  node.changes.push({ seq: 6, topic: 'menu', table: 'products', id: pid(9), op: 'upsert', row: { product: { ...cloud.products[9], base_price: 777 }, comboItems: null } });
  await LS.liveTick(Date.now());
  await LS.liveTick(Date.now() + 25_000);
  ok('a peer takes the change from its branch server', product(pid(9)).base_price === 777 && LS.liveMode() === 'peer', JSON.stringify({ mode: LS.liveMode(), node: node.hits }));
  SR.setRosterLive({ quiet: LS.liveActive, preferNode: () => true });
  const beat1 = SR.rosterBeatDue(Date.now());
  const beat2 = SR.rosterBeatDue(Date.now() + 60_000);
  const beat3 = SR.rosterBeatDue(Date.now() + 31 * 60_000);
  ok('…the staff-list timer stands down (one beat, then only the 30-minute safety)', beat1 && !beat2 && beat3);
  await E.syncAll();
  ok('…and NEVER asks the cloud for changes, the menu, the staff list or a version (its 10-minute sync included)',
    hits(/\/api\/pos\/(changes|init|branch-staff|catalogue-version)/) === 0 && sockets.size === 0, JSON.stringify(cloud.hits));
  nodeSrv.close();

  // ── 8 ── an old cloud
  DC.saveDeviceConfig({ node_url: null });
  db.prepare(`UPDATE device_config SET node_url = NULL`).run();
  LS._resetLive();
  cloud.hasChanges = false;
  cloud.hits = [];
  await LS.liveTick(Date.now());
  ok('an old cloud (its own signed 404 for /changes): the old way — not change-triggered', LS.liveMode() === 'legacy' && !LS.liveActive());
  cloud.hits = [];
  await E.syncAll();
  ok('…the 10-minute sync takes the whole catalogue as before', hits(/^\/api\/pos\/init/) === 1, JSON.stringify(cloud.hits));
} catch (e) {
  fail++; console.log('  FAIL threw', e?.stack ?? e);
} finally {
  try { LS.stopLiveSync(); } catch { /* */ }
  for (const s of sockets) s.destroy();
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
