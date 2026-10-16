// A446 — a cashier created anywhere signs in on every till at once; every till keeps its branch's staff list.
// Owner, 2026-10-11: "the till should save cashiers pin instant when created on the local server or the cloud server no
// delay … each till should keep a local copy of all staff pin related to that branch"; the lock screen's "Cannot check that
// PIN right now. Use Lock till and sign in again" (screenshot) on a screen with no Lock till; "this till is not bound to a
// branch"; "i think there is an issue with how a till communicates with the server generally … do simulations".
//
// SIMULATES a branch: the REAL till (dist/main: ipcHandlers' auth:verifyPin and manage:createStaff, staffRoster,
// syncEngine, cloudGateway, real SQLite, electron shimmed) as a till BEHIND a branch server; a stand-in branch server on a
// real port (its PIN check from ITS OWN staff list, its copy of the list, its gateway to the cloud, its refresh-now) and a
// stand-in cloud (PIN check, the branch's staff list with a version, staff create). Then the REAL branch server
// (nodeServer) answering a till's refresh-now. Each scene says what the till did before A446.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/staff-sync.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - the node's "no" made final again (throw on rejected)           → "a cashier the server does not know yet signs in" fails
//   - fallbackToLocalAuthority checks the list only on a node         → "offline, this till's own copy signs them in" fails
//   - pullStaffRoster ignoring `unchanged` / storing every time        → "an unchanged list is not stored again" fails
//   - manage:createStaff not telling anyone                            → "a cashier created here is on this till at once" fails
//   - signInLocal not recording the branch                             → "the till records its branch" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const srcRoot = path.join(here, '..', 'src');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a446-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.7', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const portOf = (s) => s.address().port;
const body = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { r(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { r({}); } }); });
const send = (res, status, obj, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
const bcrypt = require('bcryptjs');
const BR = 'br-westlands';

// ── The stand-in cloud: the truth about staff ──────────────────────────────────
const cloud = { staff: [], up: true, rosterAsks: 0, created: [], tooMany: false, orderAuth: [], orderNumbers: [] };
const person = (id, name, pin, role = 'cashier') => ({ staff_id: id, name, role_name: role, branch_id: BR, permissions: role === 'manager' ? { 'orders.void': true } : {},
  pin_hash: bcrypt.hashSync(pin, 4), override_pin_hash: null, status: 'active', _pin: pin });
const versionOf = () => cloud.staff.map((s) => `${s.staff_id}:${s.pin_hash}:${s.status}`).sort().join('|');
const cloudSrv = await listen(async (req, res) => {
  const url = req.url;
  if (url.startsWith('/api/orders') && req.method === 'POST') {
    const b = await body(req);
    cloud.orderAuth.push(req.headers.authorization); cloud.orderNumbers.push(b.order_number);
    return send(res, 201, { id: 'x' });
  }
  if (url.startsWith('/api/auth/verify-pin')) {
    if (cloud.tooMany) return send(res, 429, { error: 'Too many attempts' });
    const b = await body(req);
    const m = cloud.staff.filter((s) => s.status === 'active' && bcrypt.compareSync(String(b.pin), s.pin_hash));
    if (!m.length) return send(res, 401, { error: 'Invalid PIN' });
    const s = m[0];
    return send(res, 200, { token: `tok-${s.staff_id}`, refreshToken: 'r', staff: { id: s.staff_id, name: s.name, role: s.role_name }, permissions: s.permissions,
      offlineAuth: { pinHash: s.pin_hash } });
  }
  if (url.startsWith('/api/pos/branch-staff')) {
    cloud.rosterAsks++;
    const v = versionOf();
    if (new URL(url, 'http://x').searchParams.get('v') === v) return send(res, 200, { branch_id: BR, version: v, unchanged: true });
    return send(res, 200, { branch_id: BR, version: v, staff: cloud.staff.filter((s) => s.status === 'active').map(({ _pin, ...s }) => s) });
  }
  if (url === '/api/staff' && req.method === 'POST') {
    const b = await body(req);
    const p = person(`u-${b.name.toLowerCase()}`, b.name, b.pin);
    cloud.staff.push(p); cloud.created.push(b.name);
    return send(res, 201, { id: p.staff_id, name: p.name });
  }
  return send(res, 404, { error: 'not here' });
});
const CLOUD = `http://127.0.0.1:${portOf(cloudSrv)}`;

// ── The stand-in branch server: its OWN staff list (refreshed only when told), its gateway ─────────────────────────────
const node = { staff: [], up: true, internet: true, refreshes: 0 };
const SECRET = 'branch-secret';
const nodeSrv = await listen(async (req, res) => {
  if (!node.up) { req.socket.destroy(); return; }
  if (req.headers['x-node-secret'] !== SECRET) return send(res, 401, { error: 'unauthorised — bad or missing X-Node-Secret' });
  const url = req.url;
  if (url.startsWith('/node/cloud/')) {
    if (!node.internet || !cloud.up) return send(res, 502, { error: 'The branch server cannot reach the cloud right now.' }, { 'x-node-gateway': '1', 'x-node-uplink': 'down' });
    const b = req.method === 'GET' ? undefined : JSON.stringify(await body(req));
    const r = await fetch(`${CLOUD}${url.slice('/node/cloud'.length)}`, { method: req.method, headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' }, body: b });
    res.writeHead(r.status, { 'content-type': 'application/json', 'x-node-gateway': '1' });
    return res.end(await r.text());
  }
  if (url === '/node/verify-pin') {
    const b = await body(req);
    const m = node.staff.filter((s) => bcrypt.compareSync(String(b.pin), s.pin_hash));
    if (!m.length) return send(res, 401, { ok: false, reason: 'no_match', error: 'Invalid PIN' });
    const s = m[0];
    return send(res, 200, { ok: true, staff: { staffId: s.staff_id, name: s.name, roleName: s.role_name, permissions: s.permissions } });
  }
  if (url === '/node/roster') return send(res, 200, { source: 'node', branch_id: BR, roster_version: String(node.staff.length), roster: node.staff.map(({ _pin, ...s }) => s) });
  if (url === '/node/roster/refresh') { node.refreshes++; node.staff = cloud.staff.map((s) => ({ ...s })); return send(res, 202, { ok: true }); }
  if (url === '/node/health') return send(res, 200, { ok: true, role: 'node' });
  return send(res, 404, { error: 'not here' });
});
const NODE = `http://127.0.0.1:${portOf(nodeSrv)}`;

// ── The REAL till, behind that branch server ───────────────────────────────────
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'till-tok', 'device:dev-T2', 'biz-1', 'Biz', '2026-10-11T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: null, device_id: 'dev-T2', device_role: 'till', terminal_code: 'T2',
  device_name: 'Bar', node_url: NODE, node_secret: SECRET });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'till-tok', refreshToken: 'till-r' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'till-tok', 'till-r');
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const R = require(path.join(dist, 'staffRoster.js'));
R.configureStaffRoster((p) => E.rosterCloudGet(p));
const verify = async (pin) => { try { return { ok: true, s: await H['auth:verifyPin'](null, { pin, branch_id: BR }) }; } catch (e) { return { ok: false, e: e.message }; } };
const localNames = () => db.prepare(`SELECT name FROM branch_staff WHERE branch_id = ? ORDER BY name`).all(BR).map((r) => r.name).join(',');

// Monday morning: Amy (cashier) and Mary (manager); the branch server and this till have the list.
cloud.staff = [person('u-amy', 'Amy', '1111'), person('u-mary', 'Mary', '9999', 'manager')];
node.staff = cloud.staff.map((s) => ({ ...s }));

console.log('\nA till that has only ever signed people in through its branch server\n');
{
  const amy = await verify('1111');
  ok('Amy signs in through the branch server, and the till records its branch (before: "This till is not bound to a branch yet")',
    amy.ok && amy.s.staff?.name === 'Amy' && C.getDeviceConfig().branch_id === BR, JSON.stringify({ amy, b: C.getDeviceConfig().branch_id }));
}

console.log('\nA cashier created on the web: the branch server does not know them yet\n');
{
  cloud.staff.push(person('u-abdi', 'Abdi', '4321'));     // created on the web; the server's list is a pull behind
  const r = await verify('4321');
  ok('Abdi signs in at once — the server said "no", the till asked the cloud (before: "That PIN was not recognised")',
    r.ok && r.s.staff?.name === 'Abdi', JSON.stringify(r));
  const wrong = await verify('0000');
  ok('a wrong PIN is still refused — the cloud\'s "no" is final', !wrong.ok && /invalid pin/i.test(wrong.e), JSON.stringify(wrong));
}

console.log('\nEvery till keeps its own copy of the branch\'s staff\n');
{
  R._resetRoster();
  const p = await R.refreshStaffRosterNow('test');
  ok('the till pulls the branch\'s list from the cloud (through its branch server)', p.source === 'cloud' && localNames() === 'Abdi,Amy,Mary', `${JSON.stringify(p)} ${localNames()}`);
  const before = cloud.rosterAsks;
  const again = await R.refreshStaffRosterNow('test');
  ok('an unchanged list is not stored again (the cloud says "unchanged")', again.source === 'cloud' && again.changed === false && cloud.rosterAsks === before + 1);
  cloud.staff.push(person('u-cora', 'Cora', '8642'));   // created on the web; never signed in anywhere
  await R.refreshStaffRosterNow('test');
  node.internet = false; node.up = false;          // the shop's internet AND the branch server are off
  const cora = await verify('8642');
  ok('offline, Cora — on the list but never signed in on this till — signs in from its copy', cora.ok && cora.s.staff?.name === 'Cora', JSON.stringify(cora));
  const offline = await verify('4321');
  ok('offline, this till\'s own copy signs Abdi in (before: only the server held the list)', offline.ok && offline.s.staff?.name === 'Abdi' && offline.s.offline === true, JSON.stringify(offline));
  const offWrong = await verify('5555');
  ok('…and offline a PIN nobody has is refused', !offWrong.ok, JSON.stringify(offWrong));
  node.up = true;
  node.staff = cloud.staff.map((s) => ({ ...s }));
  db.prepare(`DELETE FROM branch_staff`).run(); R._resetRoster();
  const fromNode = await R.refreshStaffRosterNow('test');
  ok('no internet: the till takes the branch server\'s copy instead', fromNode.source === 'node' && localNames() === 'Abdi,Amy,Cora,Mary', `${JSON.stringify(fromNode)} ${localNames()}`);
  node.internet = true;
}

console.log('\nA cashier created on this till\n');
{
  db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
    VALUES (1, 'u-mary', 'Mary', 'manager', '{"staff.manage":true}', ?, 'tok-u-mary', '2026-10-11T08:00:00Z')`).run(BR);
  require(path.join(dist, 'tokenStore.js')).writeStaffTokens({ token: 'tok-u-mary', refreshToken: 'r' });
  const before = node.refreshes;
  await H['manage:createStaff'](null, { name: 'Brian', pin: '2468', role: 'cashier' });
  await new Promise((r) => setTimeout(r, 300));
  ok('a cashier created here is on this till at once', localNames().includes('Brian'), localNames());
  ok('…and the branch server is told to refresh at once (its other tills have it on their next ask)', node.refreshes === before + 1 && node.staff.some((s) => s.name === 'Brian'));
  const b = await verify('2468');
  ok('Brian signs in straight away', b.ok && b.s.staff?.name === 'Brian', JSON.stringify(b));
}

console.log('\nA cashier removed\n');
{
  // Amy once signed in on this till online (the cloud's answer saves her sign-in: staff_pin_cache).
  const amy = cloud.staff.find((x) => x.name === 'Amy');
  require(path.join(dist, 'pinCache.js')).cacheStaffCredential({ staffId: 'u-amy', name: 'Amy', roleName: 'cashier', permissions: {} }, amy.pin_hash, BR);
  ok('(Amy\'s sign-in is saved on this till)', !!db.prepare(`SELECT 1 FROM staff_pin_cache WHERE staff_id = 'u-amy'`).get());
  cloud.staff = cloud.staff.filter((s) => s.name !== 'Amy');
  node.staff = cloud.staff.map((s) => ({ ...s }));   // the branch server's own 10-s refresh
  await R.refreshStaffRosterNow('test');
  ok('Amy leaves this till\'s copy on the next refresh — and her saved sign-in with it',
    !localNames().includes('Amy') && !db.prepare(`SELECT 1 FROM staff_pin_cache WHERE staff_id = 'u-amy'`).get(), localNames());
  node.internet = false;
  const r = await verify('1111');
  ok('…so offline she is refused too (before: her saved sign-in still let her in)', !r.ok, JSON.stringify(r));
  node.internet = true;
  // Brian's PIN is changed on the web: the old one stops working everywhere, offline included.
  const brian = cloud.staff.find((s) => s.name === 'Brian');
  await verify('2468');                                // saved sign-in with the OLD PIN
  Object.assign(brian, { pin_hash: bcrypt.hashSync('1357', 4), _pin: '1357' });
  node.staff = cloud.staff.map((s) => ({ ...s }));
  await R.refreshStaffRosterNow('test');
  node.internet = false;
  const oldPin = await verify('2468'), newPin = await verify('1357');
  ok('a changed PIN: offline the old one is refused and the new one works', !oldPin.ok && newPin.ok && newPin.s.staff?.name === 'Brian',
    `${JSON.stringify(oldPin)} ${JSON.stringify(newPin)}`);
  node.internet = true;
  const saved = cloud.staff; cloud.staff = [];
  await R.refreshStaffRosterNow('test');
  ok('an empty list from the cloud never wipes the till\'s copy (a till must not lock its own staff out)', localNames().includes('Brian'), localNames());
  cloud.staff = saved;
}

console.log('\nThe branch, the lock screen, the timer\n');
{
  C.saveDeviceConfig({ ...C.getDeviceConfig(), branch_id: null });
  ok('a till that never recorded its branch takes its signed-in person\'s (start-up repair)', C.tillBranchId() === BR && C.getDeviceConfig().branch_id === BR);
  const curtain = fs.readFileSync(path.join(srcRoot, 'renderer/components/LockCurtain.tsx'), 'utf8');
  ok('the lock screen says the real reason, not "Cannot check that PIN right now. Use Lock till…" for every failure',
    /That is not \$\{staffName\}'s PIN\. Try again\./.test(curtain) && !/Use Lock till and sign in again/.test(curtain));
  ok('…and has its way out: Sign out — another person signs in', /data-testid="lock-sign-out" onClick=\{onSignOut\}/.test(curtain)
    && /onSignOut=\{\(\) => \{ void handleEndShift\(\); \}\}/.test(fs.readFileSync(path.join(srcRoot, 'renderer/App.tsx'), 'utf8')));
  const idx = fs.readFileSync(path.join(srcRoot, 'main/index.ts'), 'utf8');
  // A513: from start-up — the sequence's 'staff' step pulls it (second, after the catalogue), then the timer runs.
  ok('every till refreshes its copy on a timer (10 s on a server, 20 s on a till) from start-up', /configureStaffRoster\(\(path\) => rosterCloudGet\(path\)\);/.test(idx)
    && /startStaffRosterTimer\(false\);/.test(idx) && /\{ name: 'staff', what: 'staff list, PINs and permissions', run: \(\) => refreshStaffRosterNow\('start'\) \}/.test(idx));
}

console.log('\nThe lock screen keeps the session (session audit)\n');
{
  require(path.join(dist, 'pinAttempts.js')).resetPinAttempts();   // A494: the wrong PINs above count toward the lockout
  // Brian is signed in online (a cloud session); the till locks.
  await verify('1357');
  db.prepare(`UPDATE staff_session SET token = 'tok-u-brian' WHERE id = 1`).run();
  require(path.join(dist, 'tokenStore.js')).writeStaffTokens({ token: 'tok-u-brian', refreshToken: 'r-brian' });
  const before = db.prepare(`SELECT staff_id FROM staff_session WHERE id = 1`).get();
  const tokBefore = require(path.join(dist, 'tokenStore.js')).readStaffTokens().token;
  const mine = await H['auth:unlock'](null, { pin: '1357' });
  ok('Brian unlocks with his PIN — checked on this till, his cloud session kept (before: swapped for an offline one)',
    mine.ok === true && require(path.join(dist, 'tokenStore.js')).readStaffTokens().token === tokBefore, JSON.stringify(mine));
  const other = await H['auth:unlock'](null, { pin: '9999' });   // Mary's correct PIN
  ok('a colleague\'s correct PIN does not unlock — and does NOT change who is signed in (before: Mary silently became the cashier)',
    // A494: the same answer as any wrong PIN ('wrong') — 'other' confirmed that a guessed PIN was a real one.
    other.ok === false && other.reason === 'wrong' && db.prepare(`SELECT staff_id FROM staff_session WHERE id = 1`).get().staff_id === before.staff_id
    && require(path.join(dist, 'tokenStore.js')).readStaffTokens().token === tokBefore, JSON.stringify(other));
  const wrong = await H['auth:unlock'](null, { pin: '0000' });
  ok('a wrong PIN: not unlocked, nothing changed', wrong.ok === false && db.prepare(`SELECT staff_id FROM staff_session WHERE id = 1`).get().staff_id === before.staff_id);
}

console.log('\nToo many wrong PINs on the cloud (session audit)\n');
{
  require(path.join(dist, 'pinAttempts.js')).resetPinAttempts();
  cloud.tooMany = true;
  // A494: the branch server would sign Cora in itself — here its list is behind (no Cora), so the cloud is asked.
  const nodeStaff = node.staff;
  node.staff = nodeStaff.filter((s) => s.staff_id !== 'u-cora');
  const r = await verify('8642');
  node.staff = nodeStaff;
  // A504 (back to A446, now bounded): a 429 is the cloud's limit on wrong PINs from this till. Waiting it out locked every
  // cashier at the till out of selling; the till checks the PIN on its own saved sign-in instead, and its own limiter
  // (pinAttempts) keeps guessing bounded (till-hardening.test.mjs §2).
  ok('the cloud says "too many tries" (429): the till checks the PIN itself — Cora signs in (offline)',
    r.ok && r.s?.staff?.id === 'u-cora' && r.s?.offline === true, JSON.stringify(r));
  cloud.tooMany = false;
}

console.log('\nSales queued under one cashier, uploaded after another signs in (session audit)\n');
{
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES ('o-amy', ?, ?, 'pending')`)
    .run(JSON.stringify({ branch_id: BR, order_number: 'T2-0001', cashier_id: 'u-cora', items: [], payments: [] }), new Date().toISOString());
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status) VALUES ('o-amy', 'biz-1', ?, 'T2-0001', 0, 0, 0, ?, 'pending')`)
    .run(BR, new Date().toISOString());
  // Brian is the one signed in now (online).
  db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
    VALUES (1, 'u-brian', 'Brian', 'cashier', '{}', ?, 'tok-u-brian', '2026-10-11T12:00:00Z')`).run(BR);
  E.configureStaffSession('tok-u-brian', 'r-brian');
  cloud.orderAuth = [];
  await E.syncPush();
  ok('Cora\'s queued sale goes up under the till\'s own session (it names Cora) — not under Brian, who is signed in now',
    cloud.orderAuth.length >= 1 && cloud.orderAuth[0] === 'Bearer till-tok', JSON.stringify(cloud.orderAuth));
  // An outage: the branch server has no internet — the sale is tried and stays pending; it does not count towards failed.
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES ('o-out', ?, ?, 'pending')`)
    .run(JSON.stringify({ branch_id: BR, order_number: 'T2-0002', cashier_id: 'u-brian', items: [], payments: [] }), new Date().toISOString());
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status) VALUES ('o-out', 'biz-1', ?, 'T2-0002', 0, 0, 0, ?, 'pending')`)
    .run(BR, new Date().toISOString());
  node.internet = false;
  for (let i = 0; i < 6; i++) await E.syncPush();
  const q = db.prepare(`SELECT status, attempts FROM sync_queue WHERE order_id = 'o-out'`).get();
  ok('six passes through an outage: the sale is still pending with 0 attempts (before: \'failed\' after five, never retried)',
    q.status === 'pending' && q.attempts === 0, JSON.stringify(q));
  node.internet = true;
  db.prepare(`UPDATE sync_queue SET status = 'failed', attempts = 5, last_error = 'fetch failed' WHERE order_id = 'o-out'`).run();
  db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES ('o-3', ?, ?, 'pending')`)
    .run(JSON.stringify({ branch_id: BR, order_number: 'T2-0003', cashier_id: 'u-brian', items: [], payments: [] }), new Date().toISOString());
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status) VALUES ('o-3', 'biz-1', ?, 'T2-0003', 0, 0, 0, ?, 'pending')`)
    .run(BR, new Date().toISOString());
  await E.syncPush();
  await E.syncPush();
  ok('a sale left \'failed\' by a connection problem goes again once the line is back, and reaches the cloud',
    db.prepare(`SELECT status FROM sync_queue WHERE order_id = 'o-out'`).get()?.status !== 'failed' && cloud.orderNumbers.includes('T2-0002'),
    JSON.stringify(db.prepare(`SELECT status, attempts, last_error FROM sync_queue WHERE order_id = 'o-out'`).get()));
}

console.log('\nThe REAL branch server answers a till\'s "refresh now"\n');
{
  nodeSrv.close();
  process.env.SWIFTPOS_NODE_PORT = String(40000 + Math.floor(Math.random() * 20000));
  C.saveDeviceConfig({ ...C.getDeviceConfig(), device_role: 'node', node_url: null, branch_id: BR });
  const realSecret = C.ensureNodeSecret();
  const N = require(path.join(dist, 'nodeServer.js'));
  N.startNodeServer();
  await new Promise((r) => setTimeout(r, 300));
  const before = cloud.rosterAsks;
  const res = await fetch(`http://127.0.0.1:${N.getNodePort()}/node/roster/refresh`, { method: 'POST', headers: { 'X-Node-Secret': realSecret } });
  await new Promise((r) => setTimeout(r, 400));
  ok('POST /node/roster/refresh → the server pulls the list from the cloud now', res.status === 202 && cloud.rosterAsks > before, `${res.status} ${cloud.rosterAsks - before}`);
  const no = await fetch(`http://127.0.0.1:${N.getNodePort()}/node/roster/refresh`, { method: 'POST' });
  ok('…only with the branch access code', no.status === 401);
  N.stopNodeServer?.();
}

cloudSrv.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
