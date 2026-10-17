// A494 — the till hardened before more clients are onboarded (the internal audit of 2026-10-15).
//
// RUNS the real compiled dist/main (electron shimmed, REAL SQLite, the network mocked):
//   1. developer tools only in a development build or inside a technician's session;
//   2. ONE local PIN limiter (pinAttempts.ts, kept in maintenance_state): 5 wrong PINs lock every local PIN check for
//      1 minute, growing; the sign-in pad, the lock screen, the update bar and the manager-PIN prompts all ask it; a 429
//      from the cloud is "try again shortly", never a check on the till;
//   3. no PIN oracles: the lock screen answers 'wrong' for a colleague's PIN too; the update bar needs someone signed in
//      and gives one answer for an unknown PIN and a PIN that may not restart;
//   4. joining a branch server: a joined till is not moved without a technician; a grant for another cloud is refused;
//      127.0.0.1 only in a development build;
//   5. saved sign-ins of someone this till's staff list does not hold as active are unknown;
//   6. offline void / refund: someone else approves (the owner excepted);
//   7. the offer discount a sale claims is re-checked on the till's own offers;
//   8. the Overview's expected cash and the branch report's parts ask their own keys;
//   9. technician channels need a technician session; adopting the branch's session needs the code entered here; a
//      token's scope and business are checked;
//  10. the SQL console masks computed columns over secrets, and the reveal code;
//  11. a cashier who sees only their own sales reprints only their own; a product created with a cost needs menu.costs.
//
//   cd apps/desktop && npm run build:main && node test/till-hardening.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - pinAttempts.recordPinFailure never locking (PIN_MAX_FAILURES = 1e9)   → "the 6th try is refused" fails
//   - auth:unlock returning 'other' for a colleague's PIN                    → "a colleague's PIN is 'wrong'" fails
//   - offlineReversal without the approver === actor rule                    → "a manager cannot approve their own" fails
//   - techService.openTechSession without the scope check                    → "a token of another scope is refused" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a494-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  const win = { isDestroyed: () => false, webContents: { send: () => {} } };
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.16', on() {}, isPackaged: false, getName: () => 'ZapTill' },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return [win]; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
const electron = require(shim);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const said = async (fn) => {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && r.ok === false) return String(r.error ?? r.message ?? r.reason ?? 'refused');
    return 'OK';
  } catch (e) { return String(e?.message ?? e); }
};
const MARK = 'catalogue.v2';
const fine = (...keys) => Object.fromEntries([...keys.map((k) => [k, true]), [MARK, true]]);

// ── the network: a router the tests set per case ────────────────────────────────────────────────────────────────────
let route = () => { throw new TypeError('fetch failed'); };
globalThis.fetch = async (url, init) => route(String(url), init);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till',
  terminal_code: 'T1', device_name: 'Front', configured: true, web_pos_enabled: true });
db.prepare(`UPDATE device_config SET web_pos_enabled = 1 WHERE id = 1`).run();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-T1', 'biz-1', 'B', '2026-10-15T00:00:00Z')`).run();
db.prepare(`INSERT OR IGNORE INTO branches (id, name) VALUES ('br-1', 'Main')`).run();
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const call = (ch, payload) => H[ch]({}, payload);
const signIn = (perms, role = 'staff', id = 'u-1') => {
  db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
  db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
              VALUES (1, ?, 'Pat', ?, 'br-1', 'Main', ?, '', NULL, '2026-10-15T00:00:00Z')`).run(id, role, JSON.stringify(perms));
};
const bcrypt = require('bcryptjs');
const P = require(path.join(dist, 'pinCache.js'));
const PA = require(path.join(dist, 'pinAttempts.js'));
const T = require(path.join(dist, 'techService.js'));
P.cacheStaffCredential({ staffId: 'u-mgr', name: 'Mary', roleName: 'manager', permissions: fine('shifts.close_day', 'shifts.confirm', 'sales.void') }, bcrypt.hashSync('7070', 4), 'br-1');
P.cacheStaffCredential({ staffId: 'u-cash', name: 'Cal', roleName: 'cashier', permissions: fine('orders.create') }, bcrypt.hashSync('1111', 4), 'br-1');
P.cacheStaffCredential({ staffId: 'u-sup', name: 'Sam', roleName: 'supervisor', permissions: fine('orders.create') }, bcrypt.hashSync('6060', 4), 'br-1');

// ── 1. developer tools ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. Developer tools\n');
{
  T.closeTechSession();
  ok('a development build: allowed', T.devToolsAllowed(false) === true);
  ok('an installed till with no technician session: refused', T.devToolsAllowed(true) === false);
  const idx = fs.readFileSync(path.join(desktop, 'src/main/index.ts'), 'utf8');
  ok('the Support menu\'s Ctrl+Shift+I asks devToolsAllowed before toggling', /accelerator: 'CmdOrCtrl\+Shift\+I',\s*click: \(_i, win\) => \{\s*if \(!devToolsAllowed\(app\.isPackaged\)\) return;/.test(idx));
  ok('…and tools opened any other way are closed at once', /win\.webContents\.on\('devtools-opened', \(\) => \{\s*if \(!devToolsAllowed\(app\.isPackaged\)\) win\.webContents\.closeDevTools\(\);/.test(idx));
}

// ── 9 (part). technician tokens: scope and business ────────────────────────────────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
T.cacheTechConfig(publicKey.export({ type: 'spki', format: 'pem' }), 'KNOCK7');
const mint = (over = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const payload = { techId: 'tech-1', techName: 'Tess', branchId: 'br-1', businessId: 'biz-1', scope: 'tech', iat: now, exp: now + 3600, ...over };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `st2.${b64}.${crypto.sign(null, Buffer.from(b64), privateKey).toString('base64url')}`;
};
console.log('\n9. Technician tokens and channels\n');
{
  const scope = T.openTechSession(mint({ scope: 'support' }));
  ok('a token of another scope is refused', scope.ok === false && /not a technician token/.test(scope.reason), JSON.stringify(scope));
  const biz = T.openTechSession(mint({ businessId: 'biz-OTHER' }));
  ok('a token for another business is refused (its branch id matching or not)', biz.ok === false && /different business/.test(biz.reason), JSON.stringify(biz));
  ok('no session was opened by either', T.getActiveSession() === null);
  for (const ch of ['tech:status', 'tech:maintenance', 'tech:logTail', 'tech:logAction']) {
    const r = await said(() => call(ch, ch === 'tech:logAction' ? { action: 'x' } : ch === 'tech:logTail' ? { lines: 5 } : undefined));
    const tail = ch === 'tech:logTail' ? (await call(ch, { lines: 5 })).text : '';
    ok(`${ch}: refused without a technician session`, /session/i.test(r) || /session required/i.test(tail), r + ' ' + tail);
  }
  ok('adopting the branch\'s session with a bare call is refused (the code is entered here first)',
    /technician code/.test(await said(() => call('tech:adoptFromNode'))));
  ok('a wrong reveal code does not open the way', (await call('tech:checkReveal', 'NOPE')).ok === false
    && /technician code/.test(await said(() => call('tech:adoptFromNode'))));
  ok('the reveal code entered here lets it ask the branch server (none here — just no token)', (await call('tech:checkReveal', 'knock7')).ok === true
    && !/technician code/.test(await said(() => call('tech:adoptFromNode'))));
  const good = T.openTechSession(mint());
  ok('the right token opens a session — and the channels answer', good.ok === true && (await said(() => call('tech:status'))) === 'OK'
    && (await said(() => call('tech:maintenance'))) === 'OK' && (await said(() => call('tech:logAction', { action: 'x' }))) === 'OK', JSON.stringify(good));
  ok('…developer tools on an installed till now too', T.devToolsAllowed(true) === true);
  const ipc = fs.readFileSync(path.join(desktop, 'src/main/ipcHandlers.ts'), 'utf8');
  ok('closing the session clears the token the branch server holds for its tills (broadcastTechToken(\'\'))',
    /handle\('tech:closeSession', async \(\) => \{\s*closeTechSession\(\);\s*revealPassedAt = 0;\s*broadcastTechToken\(''\)/.test(ipc));
  await call('tech:closeSession');
  ok('…and it is closed here', T.getActiveSession() === null && T.devToolsAllowed(true) === false);
}

// ── 10. the SQL console ────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n10. The SQL console\n');
{
  const q = (sql) => T.runTechQuery(sql);
  const r1 = q(`SELECT substr(token, 1, 4) AS t, upper(business_name) AS n FROM session`);
  ok('a computed column over a secret is masked (substr(token …)) — every computed column of that query', r1.ok
    && r1.result.rows[0][0] === '•••masked•••' && r1.result.maskedColumns.includes('t'), JSON.stringify(r1));
  const r2 = q(`SELECT reveal_code AS r, clock_floor FROM tech_state`);
  ok('the reveal code is masked (even renamed)', r2.ok && r2.result.rows[0][0] === '•••masked•••' && r2.result.rows[0][1] !== '•••masked•••', JSON.stringify(r2));
  const r3 = q(`SELECT upper(business_name) AS n, 1 + 1 AS two FROM session`);
  ok('a computed column of a query naming nothing secret is shown', r3.ok && r3.result.rows[0][0] === 'B' && r3.result.rows[0][1] === 2, JSON.stringify(r3));
  const r4 = q(`SELECT x FROM (SELECT hex(pin_hash_enc) AS x FROM staff_pin_cache)`);
  ok('…a secret wrapped in a sub-query is masked', r4.ok && r4.result.rows.every((r) => r[0] === '•••masked•••'), JSON.stringify(r4));
  T.closeTechReadonlyDb();
}

// ── 2/3. the PIN limiter and the oracles ───────────────────────────────────────────────────────────────────────────
console.log('\n2. One PIN limiter\n');
{
  PA.resetPinAttempts();
  const t0 = 1_000_000_000_000;
  for (let i = 0; i < 4; i++) PA.recordPinFailure(t0 + i);
  ok('four wrong PINs: not locked', PA.pinLockRemaining(t0 + 10) === 0);
  ok('the fifth locks every PIN check for 1 minute', PA.recordPinFailure(t0 + 20) === 60_000 && PA.pinLockRemaining(t0 + 30) > 0
    && /Try again in 60 seconds/.test((() => { try { PA.assertPinAllowed(t0 + 20); return ''; } catch (e) { return e.message; } })()));
  const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = 'pin_attempts'`).get();
  ok('kept in maintenance_state (a restart does not reset it)', !!row && JSON.parse(row.value).lockedUntil === t0 + 20 + 60_000, row?.value);
  for (let i = 0; i < 5; i++) PA.recordPinFailure(t0 + 70_000 + i);
  ok('the next lockout within the hour is longer (2 minutes)', PA.pinLockRemaining(t0 + 70_004) === 120_000);
  PA.resetPinAttempts();
  PA.recordPinFailure(t0); for (let i = 0; i < 4; i++) PA.recordPinFailure(t0 + 16 * 60_000 + i);
  ok('a wrong PIN older than 15 minutes no longer counts', PA.pinLockRemaining(t0 + 16 * 60_000 + 10) === 0);
  PA.resetPinAttempts();

  // The sign-in pad, offline: five wrong PINs, then even the right one waits.
  route = () => { throw new TypeError('fetch failed'); };
  const verify = (pin) => said(() => call('auth:verifyPin', { pin, branch_id: 'br-1' }));
  const wrongs = [];
  for (let i = 0; i < 5; i++) wrongs.push(await verify(String(2000 + i)));
  ok('offline: a wrong PIN is "Invalid PIN"', wrongs.every((w) => /Invalid PIN/.test(w)), wrongs.join(' | '));
  const sixth = await verify('1111');
  ok('the 6th try is refused — Cal\'s right PIN too — until the lockout ends', /Too many wrong PINs/.test(sixth), sixth);
  signIn(fine('orders.create'), 'cashier', 'u-cash');
  ok('the lock screen is locked too', /Too many wrong PINs/.test(await said(() => call('auth:unlock', { pin: '1111' }))));
  // A519: the update bar asks no PIN any more (one tap for back office) — nothing there to lock.
  signIn(fine('orders.create', 'shifts.cash_movements'), 'cashier', 'u-cash');
  ok('…and a manager-PIN prompt (cash out)', /Too many wrong PINs/.test(await said(() => call('shift:float', { type: 'float_out', amount: 5, pin: '7070' }))));
  PA.resetPinAttempts();
  ok('after the lockout the right PIN signs in', (await verify('1111')) === 'OK');

  // A504: the cloud says too many tries — the till's own list answers (its own limiter bounds it), so a right PIN still
  // sells; A494 made every cashier at the till wait 15 minutes, right PINs included.
  PA.resetPinAttempts();
  route = (url) => (url.includes('/api/auth/verify-pin') ? json(429, { error: 'Too many attempts' }) : json(404, {}));
  const busy = await verify('1111');
  ok('a 429 from the cloud: Cal is signed in from the till\'s list (the till\'s own limit applies)', busy === 'OK', busy);
  for (let i = 0; i < 5; i++) await verify(String(3000 + i));
  ok('…and wrong PINs behind a 429 still lock the till (no unlimited guessing)', PA.pinLockRemaining() > 0);
  PA.resetPinAttempts();
  // A504: a right PIN clears the count of wrong ones — typos across a shift never add up to a lockout.
  route = () => { throw new TypeError('fetch failed'); };
  for (let i = 0; i < 4; i++) await verify(String(4000 + i));
  ok('four typos, then a right PIN: signed in', (await verify('1111')) === 'OK');
  for (let i = 0; i < 4; i++) await verify(String(5000 + i));
  ok('…four more typos do not lock: the right PIN cleared the count', PA.pinLockRemaining() === 0);
  PA.resetPinAttempts();
  route = (url) => (url.includes('/api/auth/verify-pin') ? json(429, { error: 'Too many attempts' }) : json(404, {}));
  signIn(fine('orders.create'), 'cashier', 'u-cash');
  ok('…the lock screen says the same for a PIN the till does not know', /Try again shortly/.test(await said(() => call('auth:unlock', { pin: '4321' }))));
  route = () => { throw new TypeError('fetch failed'); };
  PA.resetPinAttempts();

  // A manager-PIN prompt counts a PIN that does not approve.
  signIn(fine('orders.create', 'shifts.cash_movements'), 'cashier', 'u-cash');
  for (let i = 0; i < 5; i++) await said(() => call('shift:float', { type: 'float_out', amount: 5, pin: '6060' }));   // Sam: real PIN, no approval
  ok('five refused approvals (a real PIN that may not approve) lock the PIN checks', PA.pinLockRemaining() > 0);
  PA.resetPinAttempts();
}

console.log('\n3. No PIN oracles\n');
{
  signIn(fine('orders.create'), 'cashier', 'u-cash');
  const colleague = await call('auth:unlock', { pin: '7070' });
  const unknown = await call('auth:unlock', { pin: '9999' });
  ok('a colleague\'s PIN is \'wrong\' — the same answer as a PIN nobody has (offline)', colleague.ok === false && colleague.reason === 'wrong'
    && unknown.ok === false && unknown.reason === 'wrong', JSON.stringify({ colleague, unknown }));
  ok('…and the session is untouched', db.prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get().staff_id === 'u-cash');
  ok('…both counted', JSON.parse(db.prepare(`SELECT value FROM maintenance_state WHERE key='pin_attempts'`).get().value).failures === 2);
  ok('the owner\'s own PIN unlocks', (await call('auth:unlock', { pin: '1111' })).ok === true);
  PA.resetPinAttempts();

  // A519: the update bar is no PIN oracle because it takes no PIN — one tap for the signed-in back-office person.
  signIn(fine('orders.create'), 'cashier', 'u-cash');
  ok('the update bar: a cashier is refused in main (no PIN to try)', (await call('update:installNow')).reason === 'manager_required');
  ok('…update:installWithPin is gone', !H['update:installWithPin']);
  db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
  const alone = await call('update:installNow');
  ok('…and nobody signed in: refused', alone.ok === false && alone.reason === 'manager_required', JSON.stringify(alone));
  const curtain = fs.readFileSync(path.join(desktop, 'src/renderer/components/LockCurtain.tsx'), 'utf8');
  ok('the lock screen shows one message for any refusal', /if \(r\.ok\) \{[\s\S]{0,120}\}\s*setError\(`That is not \$\{staffName\}'s PIN\. Try again\.`\);/.test(curtain));
  PA.resetPinAttempts();
}

// ── 4. joining a branch server ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. Joining a branch server\n');
{
  signIn(fine('orders.create'), 'cashier', 'u-cash');
  const first = await said(() => call('install:requestJoin', { url: 'http://192.168.1.50:4000' }));
  ok('a till already joined to its business is not moved by a first join (no technician)', /already joined/.test(first), first);
  electron.app.isPackaged = true;
  const local = await said(() => call('install:requestJoin', { url: 'http://127.0.0.1:4000', rejoin: true }));
  electron.app.isPackaged = false;
  ok('an installed till never takes 127.0.0.1 as its branch server', /not a branch server address/.test(local), local);
  // A rejoin through a server that answers with another cloud's grant.
  route = (url) => {
    if (url.endsWith('/node/tls')) return json(404, {});
    if (url.endsWith('/node/join')) return json(200, { id: 'j-1', token: 'tok' });
    if (url.includes('/node/join/status')) return json(200, { status: 'approved', grant: { cloud_url: 'http://evil-cloud', business_id: 'biz-1',
      branch_id: 'br-1', code: 'C', node_secret: 'S' } });
    throw new TypeError('fetch failed');
  };
  const asked = await said(() => call('install:requestJoin', { url: 'http://127.0.0.1:4999', rejoin: true }));
  const before = C.getDeviceConfig();
  const answer = await said(() => call('install:joinStatus'));
  ok('a grant for another cloud is refused, and nothing about the server is saved', asked === 'OK' && /another cloud/.test(answer)
    && C.getDeviceConfig().node_url === before.node_url && C.getDeviceConfig().node_secret === before.node_secret, `${asked} | ${answer}`);
  route = () => { throw new TypeError('fetch failed'); };
}

// ── 5. saved sign-ins follow this till's staff list ────────────────────────────────────────────────────────────────
console.log('\n5. Saved sign-ins and the staff list\n');
{
  ok('no staff list for the branch yet: a saved sign-in works as before', P.verifyPinOffline('1111', 'br-1').ok === true);
  const BS = require(path.join(dist, 'branchStaff.js'));
  BS.storeBranchStaff('br-1', [
    { staff_id: 'u-mgr', name: 'Mary', role_name: 'manager', permissions: fine('shifts.close_day', 'shifts.confirm', 'sales.void'), pin_hash: bcrypt.hashSync('7070', 4), override_pin_hash: null, status: 'active' },
    { staff_id: 'u-sup', name: 'Sam', role_name: 'supervisor', permissions: fine('orders.create'), pin_hash: bcrypt.hashSync('6060', 4), override_pin_hash: null, status: 'inactive' },
  ]);
  ok('someone the list does not hold (Cal, removed) is unknown offline', P.verifyPinOffline('1111', 'br-1').ok === false
    && P.verifyPinOffline('1111', 'br-1').reason === 'no_match');
  ok('someone the list holds as inactive (Sam) is unknown offline', P.verifyPinOffline('6060', 'br-1').ok === false);
  ok('an active person still signs in from their saved sign-in', P.verifyPinOffline('7070', 'br-1').ok === true);
  db.prepare(`DELETE FROM branch_staff`).run();
}

// ── 6. offline void / refund ───────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. Offline void and refund\n');
{
  const O = require(path.join(dist, 'offlineReversal.js'));
  const mgr = { id: 'u-mgr', name: 'Mary', roleName: 'manager', permissions: fine('sales.void') };
  const own = { id: 'u-own', name: 'Olive', roleName: 'owner', permissions: {} };
  const rules = { voidWindowMinutes: 60, offlineRefundMethods: ['cash'], offlineReverseWebSales: false };
  const e = (() => { try { O.reverseOffline({ kind: 'void', orderId: 'none', reason: 'x', actor: mgr, approver: mgr, rules, deviceId: 'dev-T1' }, db); return ''; } catch (x) { return x.message; } })();
  ok('a manager cannot approve their own offline void', /someone else must approve/.test(e), e);
  const o = (() => { try { O.reverseOffline({ kind: 'void', orderId: 'none', reason: 'x', actor: own, approver: own, rules, deviceId: 'dev-T1' }, db); return ''; } catch (x) { return x.message; } })();
  ok('the owner may (refused here only because the sale is not on this till)', o === O.OFFLINE_NOT_ON_TILL, o);
}

// ── 7. the offer discount ──────────────────────────────────────────────────────────────────────────────────────────
console.log('\n7. Offer discounts on the till\'s own offers\n');
{
  signIn(fine('orders.create'), 'cashier', 'u-cash');
  await said(() => call('shift:open', { opening_float: 0 }));
  const sale = (n, extra) => ({ branch_id: 'br-1', order_number: `T1--${n}`, subtotal: 100, vat_amount: 0, total: 50, discount_amount: 50,
    items: [{ product: { id: 'p-1', name: 'Tea' }, unitPrice: 100, quantity: 1, lineTotal: 100 }], payments: [{ method: 'cash', amount: 50 }], ...extra });
  db.prepare(`DELETE FROM offers`).run();
  ok('a claimed offer discount with no offer on this till is a hand discount (refused without sales.discount)',
    /give discounts/.test(await said(() => call('order:create', sale(1, { offer_discount: 50, offers: [{ offer_id: 'x', name: 'Fake', amount: 50 }] })))));
  db.prepare(`INSERT INTO offers (id, data) VALUES ('of-1', ?)`).run(JSON.stringify({ id: 'of-1', name: 'Ten off', kind: 'amount_off', value: 10,
    applies_to: 'all', product_ids: [], category_ids: [], active: true }));
  ok('…more than the till\'s offers give is refused too (50 claimed, the offer gives 10)',
    /give discounts/.test(await said(() => call('order:create', sale(2, { offer_discount: 50 })))));
  const fair = await said(() => call('order:create', sale(3, { discount_amount: 10, total: 90, offer_discount: 10, payments: [{ method: 'cash', amount: 90 }] })));
  ok('what the till\'s offer gives is accepted', fair === 'OK', fair);
  signIn(fine('orders.create', 'sales.discount'), 'cashier', 'u-cash');
  const withKey = await said(() => call('order:create', sale(4, { offer_discount: 50 })));
  const kept = db.prepare(`SELECT offer_discount FROM orders WHERE order_number = 'T1--4'`).get();
  ok('someone who may discount: accepted, and the sale records only the offer\'s 10 as offers', withKey === 'OK' && kept?.offer_discount === 10, `${withKey} ${JSON.stringify(kept)}`);
}

// ── 8. the Overview and the branch report ──────────────────────────────────────────────────────────────────────────
console.log('\n8. Expected cash and the branch report\n');
{
  signIn(fine('orders.create', 'shifts.confirm'), 'manager', 'u-mgr');
  const z = await said(() => call('shift:close', { closing_float: 0, notes: 'counted' }));
  if (z !== 'OK') console.log('      (shift:close said: ' + z + ')');
  signIn(fine('reports.overview'), 'cashier', 'u-cash');
  const day = await call('manager:branchDay', { preset: 'today' });
  ok('the Overview without reports.shifts / shifts.confirm: no expected cash, no difference', day.shifts.length > 0
    && day.shifts.every((s) => s.expected_cash === null && s.variance === null), JSON.stringify(day.shifts));
  signIn(fine('reports.overview', 'reports.shifts'), 'cashier', 'u-cash');
  const day2 = await call('manager:branchDay', { preset: 'today' });
  ok('…with reports.shifts: the closed drawer\'s expected cash', day2.shifts.some((s) => typeof s.expected_cash === 'number'), JSON.stringify(day2.shifts));
  signIn(fine('reports.sales'), 'cashier', 'u-cash');
  const rep = await call('manager:branchReport');
  ok('the branch report with reports.sales only: no orders list, no stock levels', rep.recentOrders === null && rep.stockLevels === null && !!rep.salesSummary);
  signIn(fine('reports.sales', 'orders.view_all', 'inventory.view'), 'cashier', 'u-cash');
  const rep2 = await call('manager:branchReport');
  ok('…with orders.view_all and inventory.view: both', Array.isArray(rep2.recentOrders) && Array.isArray(rep2.stockLevels));
}

// ── 11. reprints, products ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\n11. Reprints and product costs\n');
{
  const o = db.prepare(`SELECT id, cashier_id FROM orders WHERE cashier_id = 'u-cash' LIMIT 1`).get();
  db.prepare(`INSERT OR REPLACE INTO receipt_payloads (order_id, payload, created_at) VALUES (?, ?, ?)`).run(o.id, JSON.stringify({ order_number: 'T1--3', items: [] }), new Date().toISOString());
  signIn(fine('orders.create', 'sales.reprint'), 'cashier', 'u-other');
  ok('someone who sees only their own sales cannot reprint another cashier\'s', /not yours/.test(await said(() => call('escpos:reprintReceiptForOrder', o.id))));
  signIn(fine('orders.create', 'sales.reprint'), 'cashier', 'u-cash');
  ok('…their own: past the check', !/not yours/.test(await said(() => call('escpos:reprintReceiptForOrder', o.id))));
  signIn(fine('orders.create', 'sales.reprint', 'sales.history_all'), 'cashier', 'u-other');
  ok('…and someone who sees every sale reprints any', !/not yours/.test(await said(() => call('escpos:reprintReceiptForOrder', o.id))));

  signIn(fine('menu.edit'), 'manager', 'u-mgr');
  ok('creating a product with a cost price needs menu.costs', /menu change/.test(await said(() => call('manage:createProduct', { name: 'Tea', base_price: 50, cost_price: 20 }))));
  ok('…without a cost it does not', !/menu change/.test(await said(() => call('manage:createProduct', { name: 'Tea', base_price: 50 }))));
  signIn(fine('menu.edit', 'menu.costs'), 'manager', 'u-mgr');
  ok('…a menu.costs holder creates it with its cost', !/menu change/.test(await said(() => call('manage:createProduct', { name: 'Chai', base_price: 50, cost_price: 20 }))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
