// A448 — the till works on its own; the cloud complements it. A manager's change on a till (a print station, a category, a
// product, a cashier, a PIN) works at once, offline too, and reaches the cloud later; a clash waits for the owner.
// Owner, 2026-10-11/12: "a totally offline till can't add another printer — that's bad … cloud should never block a till
// from working … cloud and local instance complement one another but none is superior unless an override is done";
// "if they are the same keep them, if not notify the owner requesting approval"; "offline supersedes online when it comes
// to PIN change".
//
// SIMULATES a till that loses the cloud: the REAL till (dist/main — ipcHandlers' manager handlers, changeQueue,
// localChanges, syncEngine, the print worker, real SQLite, electron shimmed) and a stand-in cloud whose POST /api/changes
// judges each change with the SAME rules file the real cloud runs (dist/main/tillChanges.js — copied byte for byte from
// shared/; the real cloud route is run in tests/till-changes-cloud.test.mjs).
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/till-first.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - manage:createStation back to the cloud first                  → "an offline till adds a printer station" fails
//   - overlayLocalChanges not run after a stations refresh           → "a refresh from the cloud does not undo it" fails
//   - pushLocalChanges ignoring canonical_id                         → "the same station made … kept once" fails
//   - the PIN hash on this till's staff list in the queue's form     → "she signs in on it at once" fails
//   - recordTillChange skipping the permission check                 → "a cashier cannot change the menu" fails
//   - sendTillChangesNow dropping a call made while a send runs      → "the station, the category, the item … reach the cloud" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a448-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.8', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const body = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { r(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { r({}); } }); });
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const T = require(path.join(dist, 'tillChanges.js'));   // the rules the cloud runs
const bcrypt = require('bcryptjs');
const BR = '22222222-2222-4222-8222-222222222222';
const AMY = '44444444-4444-4444-8444-444444444444', MARY = '55555555-5555-4555-8555-555555555555';
const ROLE = '33333333-3333-4333-8333-333333333333';
const uuid = () => require('node:crypto').randomUUID();

// ── The stand-in cloud: its own tables, judged by the shared rules ───────────────────────────────────────────────────
const cloud = { up: true, changesDown: false, stations: [], products: [], categories: [], users: [], requests: new Map(), notified: [] };
const tableOf = { station: 'stations', category: 'categories', product: 'products', staff_pin: 'users', staff: 'users' };
const cloudSrv = await listen(async (req, res) => {
  if (!cloud.up) { req.socket.destroy(); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/changes' && req.method === 'POST') {
    if (cloud.changesDown) return send(res, 503, { error: 'busy' });
    const b = await body(req);
    const results = [];
    for (const raw of b.changes ?? []) {
      const seen = cloud.requests.get(raw.id);
      if (seen) { results.push({ id: raw.id, status: seen.status, canonical_id: seen.canonical_id }); continue; }
      const cc = T.cleanChange(raw); if (!cc.ok) { results.push({ id: raw.id, status: 'refused', message: cc.error }); continue; }
      const c = cc.change, rows = cloud[tableOf[c.entity]];
      let r;
      if (c.entity === 'staff') { rows.push({ id: c.entity_id, name: c.data.name, pin: c.data.pin, role_id: c.data.role_id }); r = { status: 'applied' }; }
      else if (c.entity === 'staff_pin') {
        const other = rows.find((u) => u.id !== c.entity_id && u.pin === c.data.pin);
        if (other) { cloud.notified.push(`PIN clash with ${other.name}`); r = { status: 'refused', message: `that PIN is already ${other.name}'s — choose another` }; }
        else { const u = rows.find((x) => x.id === c.entity_id); if (u) u.pin = c.data.pin; r = { status: 'applied' }; }
      } else if (c.op === 'create') {
        const same = rows.find((x) => x.id === c.entity_id) ?? rows.find((x) => String(x.name).toLowerCase() === String(c.data.name).toLowerCase());
        if (same) { const v = T.judgeCreate(c.entity, same, c.data); r = v.verdict === 'identical' ? { status: 'identical', canonical_id: same.id !== c.entity_id ? same.id : null } : { status: 'awaiting', canonical_id: same.id }; }
        else { rows.push({ id: c.entity_id, ...c.data }); r = { status: 'applied' }; }
      } else if (c.op === 'update') {
        const cur = rows.find((x) => x.id === c.entity_id);
        if (!cur) r = { status: 'refused', message: 'it no longer exists on the cloud' };
        else { const v = T.judgeUpdate(c.entity, cur, c.base, c.data);
          if (v.verdict === 'apply') { Object.assign(cur, c.data); r = { status: 'applied' }; }
          else if (v.verdict === 'identical') r = { status: 'identical' };
          else { cloud.notified.push(`clash: ${v.fields.join(',')}`); r = { status: 'awaiting', proposed: c.data, entity_id: c.entity_id }; } }
      } else { const i = rows.findIndex((x) => x.id === c.entity_id); if (i >= 0) rows.splice(i, 1); r = { status: 'applied' }; }
      cloud.requests.set(c.id, { ...r, entity: c.entity, proposed: c.data, entity_id: c.canonical_id ?? c.entity_id });
      results.push({ id: c.id, ...r });
    }
    return send(res, 200, { results });
  }
  if (url.pathname === '/api/changes/state') {
    const ids = String(url.searchParams.get('ids') ?? '').split(',');
    return send(res, 200, ids.filter((i) => cloud.requests.has(i)).map((i) => ({ id: i, status: cloud.requests.get(i).status })));
  }
  if (url.pathname === '/api/stations' && req.method === 'GET') return send(res, 200, cloud.stations.map((s) => ({ ...s, active: s.active !== false, category_ids: [] })));
  return send(res, 404, { error: 'not here' });
});
const CLOUD = `http://127.0.0.1:${cloudSrv.address().port}`;
const decide = (requestId, approve) => {   // what the owner's Approvals page does on the cloud
  const r = cloud.requests.get(requestId);
  if (approve) Object.assign(cloud[tableOf[r.entity]].find((x) => x.id === r.entity_id), r.proposed);
  r.status = approve ? 'approved' : 'rejected';
};

// ── The REAL till ────────────────────────────────────────────────────────────────────────────────────────────────────
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'till-tok', 'device:dev-T1', 'biz-1', 'Krunch', '2026-10-12T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
// A490: Abdi sells too (orders.create) — the till's ceiling lets him give only a role that does no more than he does.
const asManager = () => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-abdi', 'Abdi', 'manager', '{"products.manage":true,"stations.manage":true,"staff.manage":true,"orders.create":true}', ?, 'mgr-tok', '2026-10-12T06:00:00Z')`).run(BR);
const asCashier = () => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-tom', 'Tom', 'cashier', '{"orders.create":true}', ?, '', '2026-10-12T06:00:00Z')`).run(BR);
asManager();
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'till-tok', 'r');
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
require(path.join(dist, 'print', 'printWorker.js')).initPrinting(db, () => null);
const H = global.__handlers;
const Q = require(path.join(dist, 'changeQueue.js'));
const LC = require(path.join(dist, 'localChanges.js'));
const state = (entityId) => db.prepare(`SELECT state, message FROM local_changes WHERE entity_id = ? ORDER BY made_at DESC LIMIT 1`).get(entityId);
const sendNow = async () => { await Q.sendTillChangesNow(); await new Promise((r) => setTimeout(r, 50)); };

// The menu the till and the cloud start with.
const BURGER = uuid(), FOOD = uuid();
db.prepare(`INSERT INTO categories (id, name, status) VALUES (?, 'Food', 'active')`).run(FOOD);
db.prepare(`INSERT INTO products (id, category_id, name, base_price, status) VALUES (?, ?, 'Burger', 600, 'active')`).run(BURGER, FOOD);
cloud.categories.push({ id: FOOD, name: 'Food', status: 'active' });
cloud.products.push({ id: BURGER, category_id: FOOD, name: 'Burger', base_price: 600, status: 'active' });

console.log('\nThe till with no cloud at all\n');
cloud.up = false;
let barista;
{
  barista = await H['manage:createStation'](null, { name: 'Barista', kind: 'kitchen' });
  ok('an offline till adds a printer station — at once (before: "No connection — menu and staff changes need internet")',
    !!barista?.id && !!db.prepare(`SELECT 1 FROM print_stations WHERE id = ?`).get(barista.id), JSON.stringify(barista));
  const preview = await H['escpos:preview'](null, { stationId: barista.id, paperWidthMm: 80 });
  ok('…and it prints (its preview renders)', !/no such station/i.test(String(preview)) && String(preview).length > 20);
  await H['manage:updateProduct'](null, { id: BURGER, patch: { base_price: 700 } });
  ok('an offline till reprices an item — the till sells it at 700 now', db.prepare(`SELECT base_price FROM products WHERE id = ?`).get(BURGER).base_price === 700);
  const cat = await H['manage:createCategory'](null, { name: 'Drinks' });
  const soda = await H['manage:createProduct'](null, { name: 'Soda', base_price: 100, category_id: cat.id });
  ok('…adds a category and an item in it', !!db.prepare(`SELECT 1 FROM products WHERE id = ? AND category_id = ?`).get(soda.id, cat.id));
  ok('every change waits for the cloud (not lost, not refused)', ['pending'].includes(state(barista.id)?.state) && state(BURGER)?.state === 'pending');
  const list = await H['manage:listStations'](null);
  ok('the printer screen lists it (from this till)', list.some((s) => s.id === barista.id && s.change_state === 'pending'));
  const products = await H['manage:listProducts'](null);
  ok('the menu screen shows the till\'s price and the new item, each marked "not on the cloud yet"',
    products.find((p) => p.id === BURGER)?.base_price === 700 && products.some((p) => p.id === soda.id && p.change_state === 'pending'));
  asCashier();
  let refused = null;
  try { await H['manage:createStation'](null, { name: 'Bar 2', kind: 'kitchen' }); } catch (e) { refused = e; }
  ok('a cashier cannot change the menu or the printers', /not allow/i.test(String(refused?.message)));
  asManager();
}

console.log('\nThe cloud is back\n');
cloud.up = true;
{
  await sendNow();
  ok('the station, the category, the item and the price reach the cloud', cloud.stations.some((s) => s.id === barista.id)
    && cloud.products.find((p) => p.id === BURGER)?.base_price === 700 && cloud.products.some((p) => p.name === 'Soda'), JSON.stringify(cloud.products));
  ok('…and settle on the till (nothing left waiting)', state(barista.id)?.state === 'done' && state(BURGER)?.state === 'done');
  const again = cloud.requests.size;
  await sendNow();
  ok('nothing is sent twice', cloud.requests.size === again);
}

console.log('\nThe cloud answers but has not taken the change yet\n');
{
  cloud.changesDown = true;
  const pass2 = await H['manage:createStation'](null, { name: 'Pass', kind: 'dispatch' });
  await sendNow();
  const list = await H['manage:listStations'](null);   // refreshes from the cloud, which has no "Pass" yet
  ok('a refresh from the cloud does not undo it — the till keeps its new station and still prints to it',
    list.some((s) => s.id === pass2.id) && !!db.prepare(`SELECT 1 FROM print_stations WHERE id = ?`).get(pass2.id));
  cloud.changesDown = false;
  await sendNow();
  ok('…and it reaches the cloud once the cloud takes changes again', state(pass2.id)?.state === 'done' && cloud.stations.some((x) => x.id === pass2.id));
}

console.log('\nThe same thing made in two places: kept, one id\n');
{
  const webGrill = uuid();
  cloud.stations.push({ id: webGrill, name: 'Grill', kind: 'kitchen', active: true, sort_order: 0 });   // added on the web
  cloud.up = false;
  const tillGrill = await H['manage:createStation'](null, { name: 'Grill', kind: 'kitchen' });   // and on the offline till
  db.prepare(`INSERT OR REPLACE INTO station_printers (station_id, target, paper_width_mm, updated_at) VALUES (?, 'printer:Grill', 80, 0)`).run(tillGrill.id);
  cloud.up = true;
  await sendNow();
  ok('the same station made on the web and on the till is kept once — the till takes the cloud\'s id',
    !db.prepare(`SELECT 1 FROM print_stations WHERE id = ?`).get(tillGrill.id) && !!db.prepare(`SELECT 1 FROM print_stations WHERE id = ?`).get(webGrill)
    && cloud.stations.filter((s) => s.name === 'Grill').length === 1);
  ok('…and its printer follows (the Grill still prints to printer:Grill)',
    db.prepare(`SELECT target FROM station_printers WHERE station_id = ?`).get(webGrill)?.target === 'printer:Grill');
}

console.log('\nDifferent changes to the same thing: the owner decides\n');
let clashId;
{
  cloud.up = false;
  await H['manage:updateProduct'](null, { id: BURGER, patch: { base_price: 750 } });   // the till, offline: 700 → 750
  cloud.products.find((p) => p.id === BURGER).base_price = 720;                          // the web meanwhile: 700 → 720
  cloud.up = true;
  await sendNow();
  const st = state(BURGER);
  clashId = db.prepare(`SELECT id FROM local_changes WHERE entity_id = ? ORDER BY made_at DESC LIMIT 1`).get(BURGER).id;
  ok('a clash is not applied: it waits for the owner, and the owner is notified',
    st.state === 'awaiting' && cloud.products.find((p) => p.id === BURGER).base_price === 720 && cloud.notified.some((n) => /clash: base_price/.test(n)), JSON.stringify(st));
  // A pull from the cloud (its stations; the product the same way after a menu pull) does not undo what the till waits on.
  db.prepare(`UPDATE products SET base_price = 720 WHERE id = ?`).run(BURGER);   // what a menu pull writes
  LC.overlayLocalChanges(db);
  ok('…the till keeps selling at its own 750 meanwhile (a pull does not undo it)', db.prepare(`SELECT base_price FROM products WHERE id = ?`).get(BURGER).base_price === 750);
  ok('…and the manager sees it is with the owner', (await H['manage:changeStates'](null)).some((c) => c.entity_id === BURGER && c.state === 'awaiting'));
  decide(clashId, true);   // the owner takes the till's
  await sendNow();
  ok('the owner approves: the till\'s 750 is applied on the cloud, and settles on the till',
    cloud.products.find((p) => p.id === BURGER).base_price === 750 && state(BURGER).state === 'done');
}
{
  cloud.up = false;
  await H['manage:updateProduct'](null, { id: BURGER, patch: { name: 'Big Burger' } });
  cloud.products.find((p) => p.id === BURGER).name = 'Beef Burger';
  cloud.up = true;
  await sendNow();
  const id = db.prepare(`SELECT id FROM local_changes WHERE entity_id = ? ORDER BY made_at DESC LIMIT 1`).get(BURGER).id;
  decide(id, false);   // the owner keeps the cloud's
  await sendNow();
  db.prepare(`UPDATE products SET name = 'Beef Burger' WHERE id = ?`).run(BURGER);   // the next pull
  LC.overlayLocalChanges(db);
  ok('the owner keeps the cloud\'s: the till takes it on its next pull (its own change is dropped)',
    state(BURGER).state === 'rejected' && db.prepare(`SELECT name FROM products WHERE id = ?`).get(BURGER).name === 'Beef Burger');
}

console.log('\nStaff: a cashier and a PIN, offline (offline supersedes online)\n');
{
  // The roles the till saved the last time it was online.
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('roles_cache', ?, ?)`)
    .run(JSON.stringify([{ id: ROLE, name: 'cashier', permissions: [{ key: 'orders.create' }] }]), new Date().toISOString());
  cloud.users.push({ id: AMY, name: 'Amy', pin: '1111' }, { id: MARY, name: 'Mary', pin: '9999' });
  db.prepare(`INSERT INTO branch_staff (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, status) VALUES (?, 'Amy', 'cashier', ?, '{}', ?, 'active')`)
    .run(AMY, BR, Buffer.from('w:' + bcrypt.hashSync('1111', 4)).toString('base64'));
  cloud.up = false;
  const cora = await H['manage:createStaff'](null, { name: 'Cora', pin: '4242', role_id: ROLE });
  const verify = async (pin) => { try { return { ok: true, s: await H['auth:verifyPin'](null, { pin, branch_id: BR }) }; } catch (e) { return { ok: false, e: e.message }; } };
  ok('an offline till adds a cashier — she signs in on it at once', (await verify('4242')).s?.staff?.name === 'Cora', JSON.stringify(await verify('4242')));
  asManager();
  await H['manage:setStaffPin'](null, { id: AMY, pin: '2580' });
  ok('a PIN changed on the offline till: the new PIN works on this till at once, the old one does not',
    (await verify('2580')).s?.staff?.name === 'Amy' && !(await verify('1111')).ok);
  asManager();
  cloud.users.find((u) => u.id === AMY).pin = '3333';   // the web set Amy a different PIN meanwhile
  cloud.up = true;
  await sendNow();
  ok('back online: the cashier is added on the cloud, and the till\'s PIN wins over the web\'s (offline supersedes online)',
    cloud.users.some((u) => u.name === 'Cora' && u.pin === '4242') && cloud.users.find((u) => u.id === AMY).pin === '2580');
  cloud.up = false;
  await H['manage:setStaffPin'](null, { id: AMY, pin: '9999' });   // Mary's PIN
  cloud.up = true;
  await sendNow();
  ok('a PIN another person has is refused on the cloud, with the reason, and the owner is told',
    state(AMY).state === 'refused' && /Mary/.test(state(AMY).message ?? '') && cloud.notified.some((n) => /PIN clash with Mary/.test(n)), JSON.stringify(state(AMY)));
}

console.log('\nThe branch server, with no internet\n');
{
  // The branch server takes a till's change over the shop's network: applied there too (its other tills pull it from it).
  const D = require('better-sqlite3');
  const nodeDb = new D(':memory:');
  nodeDb.exec(`CREATE TABLE maintenance_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE print_stations (id TEXT PRIMARY KEY, name TEXT, kind TEXT, sort_order INTEGER, active INTEGER, synced_at TEXT);
    CREATE TABLE category_stations (category_id TEXT, station_id TEXT);`);
  const row = { id: uuid(), entity: 'station', op: 'create', entity_id: uuid(), base: null, data: { name: 'Pass', kind: 'dispatch' }, made_by: 'u-abdi', made_by_name: 'Abdi', made_at: new Date().toISOString() };
  const n = LC.acceptRelayedChanges(nodeDb, [row, row], { wrap: (s) => s, unwrap: (s) => s, seal: (s) => s });
  ok('the branch server applies a till\'s new station at once (once, however often it is handed it) and its change counter moves',
    n === 1 && !!nodeDb.prepare(`SELECT 1 FROM print_stations WHERE name = 'Pass'`).get() && !!LC.changeVersion(nodeDb));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8');
  ok('a till with no cloud checks the branch server\'s counter and pulls from it when it moved',
    /const nodeVersion = await nodeChangeVersion\(\)\.catch\(\(\) => null\);/.test(src) && /overlayLocalChanges\(db\);\n  \}\)\(\);/.test(src));
}

cloudSrv.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
