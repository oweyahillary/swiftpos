// A496 — branch-server access fixes (internal audit, 2026-10-15). Each item, against the REAL compiled dist/main: the real
// branch server over HTTP on a real port, a real SQLite file, electron shimmed (safeStorage as a reversible stand-in).
//
//   1  /node/changes: a relayed change is applied here but NEVER queued for the cloud under the server's session; a PIN
//      (or a new person, who carries one) is never applied from a relay; a staff change for someone not on this
//      server's list is refused; only a till that proves which it is
//   2  device keys: first-use recording only for a device the server knew before keys; an unknown device's key is
//      refused ('unknown'); a poll from an unknown device does not make it known (no relay for it)
//   3  /node/roster, /node/report, /node/since, /node/cursors, /node/reference, /node/branding, /node/tech-session need a
//      proven till; no override PIN hash is kept or served; branding's receipt logo and accent are checked; only a real
//      tech token is held
//   4  /node/verify-pin limited per address as well as per device
//   5  /node/instructions/ack: a device that holds a key must present it; an older till (no key) keeps the old path
//   6  join: a device that already holds a key is refused until forgotten; one request per device; allowed-but-not-
//      collected requests count toward the cap
//   7  the gateway decodes percent-encoding before its checks
//   8  a till keeps one branch's staff list; saved sign-ins follow the server's list too; inactive = absent
//   9  the roster version moves on a permission-only change; syncEngine no longer pulls the server's roster a second time
//   10 a certificate pinned on first use is shown for comparison until confirmed; the server can refuse plain HTTP
//
//   cd apps/desktop && npm run build:main && node test/branch-server-hardening.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main and re-running):
//   - checkDeviceKey enrolling any never-seen device again (no mayEnrolOnFirstUse)  → "2: an unknown device's key is refused" fails
//   - acceptRelayedChanges queuing 'pending' again                                  → "1: never queued for the cloud" fails
//   - /node/roster without requireProven                                            → "3: /node/roster needs a proven till" fails
//   - pinAttemptAllowed only per device (no ip: key)                                → "4: rotating device ids from one address" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a496h-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.15', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('E:' + s, 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8').slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (/^https?:\/\/(127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)/.test(String(url)) ? realFetch(url, init) : Promise.reject(new TypeError('fetch failed')));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

process.env.SWIFTPOS_NODE_PORT = String(41000 + Math.floor(Math.random() * 15000));
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.invalid', branch_id: 'br-1', device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server', node_url: null });
const I = require(path.join(dist, 'nodeIngest.js'));
const B = require(path.join(dist, 'branchClose.js'));
const BS = require(path.join(dist, 'branchStaff.js'));
const NS = require(path.join(dist, 'nodeServer.js'));
const J = require(path.join(dist, 'serverJoin.js'));
const LC = require(path.join(dist, 'localChanges.js'));
const RS = require(path.join(dist, 'rosterSnapshot.js'));
const SR = require(path.join(dist, 'staffRoster.js'));
const G = require(path.join(dist, 'nodeGateway.js'));
const T = require(path.join(dist, 'lanTls.js'));

// A till this server heard from BEFORE device keys (an older install) — noted when the server starts.
const now = new Date().toISOString();
db.prepare(`INSERT INTO peer_cursors (device_id, table_name, last_seq, updated_at) VALUES ('dev-LEGACY', 'orders', 3, ?)`).run(now);

const SECRET = C.ensureNodeSecret();
NS.startNodeServer();
await new Promise((r) => setTimeout(r, 300));
const PORT = NS.getNodePort();
const NODE = `http://127.0.0.1:${PORT}`;
const KEY_A = I.issueDeviceKey('dev-A');            // a till that joined
const hdr = (device, key) => ({ 'X-Node-Secret': SECRET, ...(device ? { 'X-Device-Id': device } : {}), ...(key ? { 'X-Device-Token': key } : {}) });
const A = hdr('dev-A', KEY_A);
const post = (p, body, h = A) => realFetch(`${NODE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
const get = (p, h = A) => realFetch(`${NODE}${p}`, { headers: h });
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const randKey = () => crypto.randomBytes(32).toString('hex');

console.log('\n2. Device keys: first use only for tills known before keys\n');
{
  const legacy = randKey();
  const r1 = await get('/node/report', hdr('dev-LEGACY', legacy));
  ok('a till the server knew before device keys records its key on first use', r1.status === 200 && I.checkDeviceKey('dev-LEGACY', legacy) === 'ok', String(r1.status));
  const stranger = randKey();
  const r2 = await get('/node/report', hdr('dev-NEW', stranger));
  const b2 = await r2.json();
  ok('2: an unknown device\'s key is refused (it must join) — and nothing is recorded for it',
    r2.status === 401 && /has not joined/.test(b2.error) && I.checkDeviceKey('dev-NEW', stranger) === 'unknown' && !I.holdsDeviceKey('dev-NEW'), JSON.stringify(b2));
  const p = await post('/node/instructions/poll', { device_id: 'dev-NEW2', branch_id: 'br-1', state: { day_open: true } }, hdr('dev-NEW2'));
  ok('a poll from an unknown device (no key) is answered, but does not make it known',
    p.status === 200 && !db.prepare(`SELECT 1 FROM node_peer_state WHERE device_id = 'dev-NEW2'`).get() && I.isKnownTill('dev-NEW2') === false);
  const pk = await post('/node/instructions/poll', { device_id: 'dev-A', branch_id: 'br-1', state: { day_open: true } });
  ok('…a joined till\'s state is recorded as before', pk.status === 200 && !!db.prepare(`SELECT 1 FROM node_peer_state WHERE device_id = 'dev-A'`).get());
  const order = (id, device) => ({ id, device_id: device, seq: 1, branch_id: 'br-1', order_number: `N-${id}`, status: 'completed', total: 100, subtotal: 100,
    created_at: now, updated_at: now, _relayPayload: { branch_id: 'br-1', order_number: `N-${id}`, items: [], payments: [], device_id: device } });
  const s = await post('/node/sync', { device_id: 'dev-NEW2', branch_id: 'br-1', tables: { orders: [order('o-new2', 'dev-NEW2')] } }, hdr('dev-NEW2'));
  ok('…so an older-style sync from it is kept here but never relayed to the cloud (A19)',
    s.status === 200 && !db.prepare(`SELECT 1 FROM sync_queue WHERE order_id = 'o-new2'`).get(), String(s.status));
  B.forgetTill('dev-LEGACY');
  ok('forgetting a till takes its first-use right too (it joins again)', I.checkDeviceKey('dev-LEGACY', legacy) === 'unknown');
}

console.log('\n1. /node/changes\n');
{
  const product = { id: uuid(1), entity: 'product', op: 'create', entity_id: uuid(101), data: { name: 'Samosa', base_price: 50 }, made_at: now };
  const r0 = await post('/node/changes', { changes: [product] }, hdr('dev-NEW', randKey()));
  ok('a till that does not prove which it is hands over nothing', r0.status === 401 && !db.prepare(`SELECT 1 FROM products WHERE id = ?`).get(uuid(101)));
  const r1 = await post('/node/changes', { changes: [product] });
  const row = db.prepare(`SELECT state FROM local_changes WHERE id = ?`).get(uuid(1));
  ok('a joined till\'s product is applied here (the branch has it with no internet)', r1.status === 200 && !!db.prepare(`SELECT 1 FROM products WHERE id = ?`).get(uuid(101)));
  const posted = [];
  await LC.pushLocalChanges(db, { post: async (c) => { posted.push(...c); return { ok: true, status: 200, json: async () => ({ results: [] }) }; }, state: async () => [], secrets: { wrap: (s) => s, unwrap: (s) => s, seal: (s) => s } });
  // A521 (#6): the till that made it may be switched off before it reaches the cloud — the server now FORWARDS it, still
  // never as its own: never re-queued as one of the server's own changes ('pending'), the maker kept as the till named
  // it (the cloud believes the maker only with their own proof — A494), and the till it came from named (relayed_for).
  const fwd = posted.find((c) => c.id === uuid(1));
  ok('1: …never queued as the server\'s own change; forwarded as relayed for the till that made it (A521)',
    row?.state === 'relayed' && !!fwd && fwd.relayed_for && (fwd.made_by ?? null) === (product.made_by ?? null), JSON.stringify({ row, posted: posted.map((c) => [c.id, c.relayed_for]) }));
  db.prepare(`INSERT OR REPLACE INTO branch_staff (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, status, updated_at)
              VALUES (?, 'Jo', 'Cashier', 'br-1', '{}', 'E:$2a$04$old', 'active', ?)`).run(uuid(201), now);
  const pin = { id: uuid(2), entity: 'staff_pin', op: 'update', entity_id: uuid(201), data: { pin: '7777' }, made_at: now };
  const ghost = { id: uuid(3), entity: 'staff', op: 'update', entity_id: uuid(299), data: { name: 'Ghost' }, made_at: now };
  const rename = { id: uuid(4), entity: 'staff', op: 'update', entity_id: uuid(201), data: { name: 'Joanna' }, made_at: now };
  const r2 = await (await post('/node/changes', { changes: [pin, ghost, rename] })).json();
  const jo = db.prepare(`SELECT name, pin_hash_enc FROM branch_staff WHERE staff_id = ?`).get(uuid(201));
  ok('a relayed PIN change is never applied here (it comes back from the cloud once applied there)',
    jo.pin_hash_enc === 'E:$2a$04$old' && r2.refused.some((x) => x.id === uuid(2)), JSON.stringify(r2));
  ok('a staff change for someone not on this server\'s list is refused', r2.refused.some((x) => x.id === uuid(3) && /not on this branch server/.test(x.reason)));
  ok('…a rename of someone on it still applies', jo.name === 'Joanna');
}

console.log('\n3. The branch\'s data only to a proven till\n');
{
  BS.storeBranchStaff('br-1', [{ staff_id: 'u-1', name: 'Cash', role_name: 'Cashier', permissions: { 'orders.create': true }, pin_hash: '$2a$04$abc', override_pin_hash: '$2a$04$override', status: 'active' }]);
  ok('the override PIN hash is no longer kept', db.prepare(`SELECT override_pin_hash_enc FROM branch_staff WHERE staff_id = 'u-1'`).get()?.override_pin_hash_enc === null);
  db.prepare(`UPDATE branch_staff SET override_pin_hash_enc = 'E:$2a$04$override' WHERE staff_id = 'u-1'`).run();
  const noKey = await post('/node/roster', { branch_id: 'br-1' }, hdr('dev-OLD'));
  const wrong = await post('/node/roster', { branch_id: 'br-1' }, hdr('dev-A', randKey()));
  ok('3: /node/roster needs a proven till (no key, or a wrong key: refused)', noKey.status === 401 && wrong.status === 401);
  const roster = await (await post('/node/roster', { branch_id: 'br-1' })).json();
  ok('…a joined till gets it, with no override PIN hash even where one was stored', roster.roster?.length === 1 && roster.roster[0].override_pin_hash === null
    && !JSON.stringify(roster).includes('override$'), JSON.stringify(roster).slice(0, 200));
  const routes = [['GET', '/node/report'], ['POST', '/node/since', { device_id: 'dev-OLD', cursors: {} }], ['GET', '/node/cursors?device=dev-OLD'],
    ['POST', '/node/reference', {}], ['POST', '/node/branding', { accentHex: '#112233' }], ['GET', '/node/tech-session'], ['POST', '/node/tech-session', { token: null }]];
  const refused = [];
  for (const [m, p, body] of routes) {
    const r = m === 'GET' ? await get(p, hdr('dev-OLD')) : await post(p, body, hdr('dev-OLD'));
    if (r.status !== 401) refused.push(`${p} ${r.status}`);
  }
  ok('/node/report, /since, /cursors, /reference, /branding, /tech-session: refused to a till with no key', refused.length === 0, refused.join(', '));
  const allowed = [];
  for (const [m, p, body] of [['GET', '/node/report'], ['POST', '/node/since', { device_id: 'dev-A', cursors: {} }], ['GET', '/node/cursors?device=dev-A'], ['POST', '/node/reference', {}]]) {
    const r = m === 'GET' ? await get(p) : await post(p, body);
    if (r.status !== 200) allowed.push(`${p} ${r.status}`);
  }
  ok('…and answered for a joined till', allowed.length === 0, allowed.join(', '));
  const other = await get('/node/cursors?device=dev-LEGACY');
  ok('/node/cursors answers a till for its own rows only', other.status === 401);
  const bad = await post('/node/branding', { logoReceipt: '<svg onload=x>' });
  const badAccent = await post('/node/branding', { accentHex: 'red;}' });
  ok('branding: the receipt logo must be base64 and the accent #RRGGBB', bad.status === 400 && badAccent.status === 400);
  const junk = await post('/node/tech-session', { token: 'st2.not.real' });
  ok('a token that is not a real tech token is not held for the branch', junk.status === 400 && (await (await get('/node/tech-session')).json()).token === null);
  const keys = crypto.generateKeyPairSync('ed25519');
  require(path.join(dist, 'techService.js')).cacheTechConfig(keys.publicKey.export({ type: 'spki', format: 'pem' }), null);
  const tok = (extra) => { const p = Buffer.from(JSON.stringify({ techId: 't', techName: 'T', branchId: 'br-1', businessId: 'b', scope: 's', iat: 1, exp: Math.floor(Date.now() / 1000) + 600, ...extra })).toString('base64url');
    return `st2.${p}.${crypto.sign(null, Buffer.from(p), keys.privateKey).toString('base64url')}`; };
  const good = await post('/node/tech-session', { token: tok({}) });
  ok('…a real one for this branch is', good.status === 200 && (await (await get('/node/tech-session')).json()).token === tok({}));
  ok('…not one for another branch, nor an expired one', (await post('/node/tech-session', { token: tok({ branchId: 'br-2' }) })).status === 400
    && (await post('/node/tech-session', { token: tok({ exp: 1 }) })).status === 400);
}

console.log('\n4. PIN attempts per address too\n');
{
  NS._resetPinAttempts();
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const id = `dev-R${i}`;
    const k = I.issueDeviceKey(id);
    statuses.push((await post('/node/verify-pin', { pin: '0000', branch_id: 'br-1' }, hdr(id, k))).status);
  }
  ok('4: rotating device ids from one address is limited (10 a minute, then 429)', statuses.slice(0, 10).every((s) => s !== 429) && statuses[10] === 429 && statuses[11] === 429, statuses.join(','));
  NS._resetPinAttempts();
}

console.log('\n5. Instruction acks\n');
{
  const wrong = await post('/node/instructions/ack', { instruction_uid: 'u-1', device_id: 'dev-A', ok: true }, hdr('dev-A', randKey()));
  const missing = await post('/node/instructions/ack', { instruction_uid: 'u-1', device_id: 'dev-A', ok: true }, hdr('dev-A'));
  const unknown = await post('/node/instructions/ack', { instruction_uid: 'u-1', device_id: 'dev-ZZ', ok: true }, hdr('dev-ZZ', randKey()));
  ok('5: an ack for a till that holds a key needs that key (wrong or none: refused); an unknown device\'s key too',
    wrong.status === 401 && missing.status === 401 && unknown.status === 401, `${wrong.status} ${missing.status} ${unknown.status}`);
  const proven = await post('/node/instructions/ack', { instruction_uid: 'u-1', device_id: 'dev-A', ok: true });
  const older = await post('/node/instructions/ack', { instruction_id: 1, ok: true }, hdr(null));
  ok('…a joined till acks; an older till (no device, no key) keeps the old path', proven.status === 200 && older.status === 200, `${proven.status} ${older.status}`);
}

console.log('\n6. Join requests\n');
{
  J._resetJoins();
  const r1 = await post('/node/join', { device_id: 'dev-A', name: 'Front' }, {});
  const b1 = await r1.json();
  // A521: the button is "Revoke this till" now — the refusal names it (intent kept: refused until the server lets it go).
  ok('6: a till that already holds a key is refused until the server revokes it', r1.status === 409 && /revoke it at the server/.test(b1.error) && /Revoke this till/.test(b1.error), JSON.stringify(b1));
  B.forgetTill('dev-A');
  ok('…then it may ask again', (await post('/node/join', { device_id: 'dev-A', name: 'Front' }, {})).status === 202);
  J._resetJoins();
  J.createJoinRequest({ device_id: 'dev-J1', name: 'One' }, '10.0.0.5');
  J.createJoinRequest({ device_id: 'dev-J1', name: 'One again' }, '10.0.0.6');
  ok('one request per device (a second, from another address, replaces the first)', J.pendingJoins().filter((p) => p.name.startsWith('One')).length === 1);
  J._resetJoins();
  for (let i = 0; i < 5; i++) {
    const r = J.createJoinRequest({ device_id: `dev-C${i}` }, `10.0.1.${i}`);
    if (i < 3) await J.answerJoin(r.id, true, async () => ({ cloud_url: 'x', business_id: 'b', branch_id: 'br-1', branch_name: null, code: 'c', node_secret: 's' }));
  }
  const sixth = J.createJoinRequest({ device_id: 'dev-C9' }, '10.0.1.9');
  ok('allowed requests not yet collected count toward the cap', sixth.ok === false && sixth.status === 429, JSON.stringify(sixth));
  J._resetJoins();
}

console.log('\n7. The gateway decodes before it checks\n');
{
  ok('7: %2e%2e, a doubly encoded %252e%252e and an encoded // never leave the API',
    G.upstreamUrl('/node/cloud/api/%2e%2e/admin', 'https://c.example') === null && G.upstreamUrl('/node/cloud/api/%252e%252e/x', 'https://c.example') === null
    && G.upstreamUrl('/node/cloud/api/a%2F%2Fb', 'https://c.example') === null && G.upstreamUrl('/node/cloud/api/%E0%A4%A', 'https://c.example') === null);
  ok('…an ordinary request still goes', G.upstreamUrl('/node/cloud/api/desktop-update/v/1.0.1/ZapTill%201.exe?x=1', 'https://c.example') === 'https://c.example/api/desktop-update/v/1.0.1/ZapTill%201.exe?x=1');
  const r = await get('/node/cloud/api/%2e%2e/admin', hdr(null));
  ok('…and over HTTP the server refuses it (400)', r.status === 400);
}

console.log('\n8. One branch\'s list; saved sign-ins follow every list\n');
{
  db.prepare(`INSERT OR REPLACE INTO branch_staff (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, status, updated_at)
              VALUES ('old-1', 'Old branch person', 'Cashier', 'br-OLD', '{}', 'E:$2a$04$x', 'active', ?)`).run(now);
  BS.storeBranchStaff('br-1', [{ staff_id: 'u-1', name: 'Cash', role_name: 'Cashier', permissions: {}, pin_hash: '$2a$04$abc', override_pin_hash: null, status: 'active' }]);
  ok('8: a till moved to another branch keeps no old roster', !db.prepare(`SELECT 1 FROM branch_staff WHERE branch_id = 'br-OLD'`).get());
  db.prepare(`INSERT OR REPLACE INTO staff_pin_cache (staff_id, branch_id, name, role_name, permissions, pin_hash_enc, cached_at) VALUES ('u-1', 'br-1', 'Cash', 'Cashier', '{}', 'E:$2a$04$abc', ?)`)
    .run(now);
  const n = BS.pruneSavedSignIns('br-1', [{ staff_id: 'u-1', name: 'Cash', role_name: 'Cashier', permissions: {}, pin_hash: '$2a$04$abc', override_pin_hash: null, status: 'inactive' }, { staff_id: 'u-2', pin_hash: '$2a$04$z', status: 'active' }]);
  ok('an inactive person counts as absent: their saved sign-in goes', n === 1 && !db.prepare(`SELECT 1 FROM staff_pin_cache WHERE staff_id = 'u-1'`).get());
  SR._resetRoster();
  const pruned = [];
  const snap = RS.buildRosterSnapshot('br-1', [{ staff_id: 'u-9', name: 'N', role_name: 'Cashier', permissions: {}, pin_hash: '$2a$04$n', override_pin_hash: null, status: 'active' }]);
  const r = await SR.pullStaffRoster({ cloudGet: async () => { throw new Error('offline'); }, nodeSnapshot: async () => snap, store: () => {}, prune: (b, l) => pruned.push([b, l.length]) }, 'test');
  ok('saved sign-ins are pruned after a list from the branch server too', r.source === 'node' && pruned.length === 1 && pruned[0][0] === 'br-1', JSON.stringify(pruned));
}

console.log('\n9. Roster version; one roster pull\n');
{
  const row = (perms) => ({ staff_id: 's', name: 'N', role_name: 'Cashier', permissions: perms, pin_hash: '$2a$04$n', override_pin_hash: null, status: 'active' });
  ok('9: a permission-only change moves the roster version', RS.rosterVersion([row({ a: true })]) !== RS.rosterVersion([row({ a: true, b: true })]));
  ok('…and key order alone does not', RS.rosterVersion([row({ a: true, b: false })]) === RS.rosterVersion([row({ b: false, a: true })]));
  const se = read('src/main/syncEngine.ts');
  ok('syncEngine no longer pulls the server\'s roster after each catalogue pull (staffRoster does, cloud first)',
    !/fetchRosterFromNode\(/.test(se) && /refreshStaffRosterNow|startStaffRosterTimer/.test(read('src/main/index.ts') + read('src/main/staffRoster.ts')));
}

console.log('\n10. TLS: compare the code; plain HTTP can be refused\n');
{
  C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.invalid', branch_id: 'br-1', device_id: 'dev-T', device_role: 'till', node_url: NODE, node_secret: SECRET });
  T._resetLanTls(); T.setTillPin(null);
  const st = await T.ensureNodeTls(() => hdr('dev-T'));
  const s1 = T.nodeTlsStatus();
  ok('10: a certificate pinned on first use is shown for comparison (not confirmed)', st === 'encrypted' && s1.confirmed === false && /^[0-9A-F]{4}-/.test(s1.code ?? ''), JSON.stringify(s1));
  ok('…until the person confirms the codes match', T.confirmTillPin() === true && T.nodeTlsStatus().confirmed === true);
  T.setTillPin(T.tillPin());
  ok('a pin made at join (codes compared there) is confirmed', T.nodeTlsStatus().confirmed === true);
  C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.invalid', branch_id: 'br-1', device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server', node_url: null });
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  T.setRequireTlsForTills(true);
  const plain = lan ? await realFetch(`http://${lan}:${PORT}/node/health`, { headers: hdr(null), signal: AbortSignal.timeout(5000) }).catch(() => null) : null;
  if (plain) {
    ok('with the setting on, plain HTTP from another machine is refused (426)', plain.status === 426, String(plain.status));
    ok('…and the server lists which tills still talk plain', T.tillTransports().some((t) => t.plainRecently));
  } else console.log('  (this machine cannot reach itself on a LAN address — the 426 check is skipped)');
  ok('…this machine\'s own calls (loopback) are never refused', (await get('/node/health', hdr(null))).status === 200);
  T.setRequireTlsForTills(false);
  ok('the setting is off by default (and off again)', T.requireTlsForTills() === false);
}

NS.stopNodeServer();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
