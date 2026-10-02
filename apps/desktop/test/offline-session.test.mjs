// A345 (2026-09-27) — a manager signed in OFFLINE: the back office says so, shows what the till has saved, and becomes a
// cloud sign-in by itself when the network returns.
// Owner, v0.6.14 checklist (screenshots: Staff and Menu said "This till is not signed in", Menu "0 of 0 items"): "we can sell
// this as an option fully offline till, thats why the manager has to log in confirm this is true full offline once
// registered" — then "build all three as 0.6.15".
//
// Registers the REAL compiled IPC handlers (dist/main/ipcHandlers.js) with electron shimmed, caches credentials the way an
// online sign-in does (real pinCache, real bcrypt), signs in with the network away, then brings a fake cloud back and calls
// the real manage:* handlers. The humaniser the renderer puts every IPC error through is RUN (posApi.ts). The two pages are
// pinned by source (React not run here); the live till is a target check (rule 16).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/offline-session.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - manageFetch back to `if (!token) throw new Error('Not signed in')`      → "(1) … says it signed in offline" fails
//   - signInLocal no longer holds the PIN                                      → "(3) the network is back …" fails
//   - the upgrade adopts a different person's answer (no staff-id check)      → "…a different person is never adopted" fails
//   - cachedStaff ignores manageOfflineReason (always returns the saved list)  → "a refusal is never replaced …" fails
//   - clearStaffSession no longer clears the PIN                               → "locking the till wipes the held PIN …" fails
//   - void/refund without the upgrade attempt and the offline message          → "a void with an offline sign-in …" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a345-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.6.15', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const attempt = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: e }; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'owner-tok', 'u-owner', 'biz-1', 'B Foods', '2026-09-27T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
const tokenStore = require(path.join(dist, 'tokenStore.js'));
try { tokenStore.writeSessionTokens?.({ token: 'owner-tok', refreshToken: 'r' }); } catch { /* the session row carries it */ }

// The menu the till sells from (what catalogue sync brought down).
db.prepare(`INSERT INTO categories (id, name, sort_order, status) VALUES ('c-1', 'Burgers', 1, 'active'), ('c-2', 'Drinks', 2, 'active')`).run();
db.prepare(`INSERT INTO products (id, category_id, name, base_price, status) VALUES
  ('p-1', 'c-1', 'Beef Burger', 650, 'active'), ('p-2', 'c-2', 'Soda', 100, 'active'),
  ('p-3', 'c-1', 'Burger Meal', 800, 'active'), ('p-9', 'c-1', 'Old Item', 1, 'inactive')`).run();
db.prepare(`INSERT INTO combo_items (combo_id, product_id, name, quantity, sort_order) VALUES
  ('p-3', 'p-1', 'Beef Burger', 1, 0), ('p-3', 'p-2', 'Soda', 1, 1)`).run();

// Earlier online sign-ins cached these (what the cloud's verify-pin returns as offlineAuth.pinHash).
const bcrypt = require('bcryptjs');
const P = require(path.join(dist, 'pinCache.js'));
P.cacheStaffCredential({ staffId: 'u-mary', name: 'Mary', roleName: 'manager', permissions: { 'reports.view': true } }, bcrypt.hashSync('4321', 4), 'br-1');
P.cacheStaffCredential({ staffId: 'u-tom', name: 'Tom', roleName: 'cashier', permissions: {} }, bcrypt.hashSync('1111', 4), 'br-1');

// ── The network: away, then a fake cloud ──
let online = false;
const calls = [];
let verifyAnswer = (body) => ({ status: 200, json: { staff: { id: body.pin === '4321' ? 'u-mary' : 'u-tom', name: body.pin === '4321' ? 'Mary' : 'Tom', role: body.pin === '4321' ? 'manager' : 'cashier' },
  permissions: { 'reports.view': true }, accessToken: `cloud-tok-${body.pin}`, refreshToken: 'cloud-refresh' } });
let staffAnswer = () => ({ status: 200, json: [{ id: 'u-mary', name: 'Mary', roles: { name: 'manager' } }, { id: 'u-ann', name: 'Ann', roles: { name: 'cashier' } }] });
globalThis.fetch = async (url, init = {}) => {
  if (!online) throw new TypeError('fetch failed');
  const u = String(url); const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, method: init.method ?? 'GET', auth: init.headers?.Authorization ?? init.headers?.authorization, body });
  const reply = (r) => new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/auth/verify-pin')) return reply(verifyAnswer(body));
  if (u.endsWith('/api/staff')) return reply(staffAnswer(init));
  if (u.endsWith('/api/staff/roles')) return reply({ status: 200, json: [{ id: 'r-c', name: 'Cashier', assignable: true }] });
  return reply({ status: 200, json: [] });
};

require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const OS = require(path.join(dist, 'offlineSession.js'));   // the same module instance the handlers use
const call = (ch, arg) => H[ch]({}, arg);
ok('setup: the real handlers are registered (incl. the two new read-only ones)',
  ['auth:verifyPin', 'manage:listStaff', 'manage:cachedMenu', 'manage:cachedStaff', 'auth:clearStaffSession'].every((c) => typeof H[c] === 'function'));

// The renderer's humaniser, RUN (posApi.ts) — every IPC error passes through it on its way to the screen.
const humanise = (msg) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `
    globalThis.window = { swiftpos: {} };
    const m = await import(${JSON.stringify('file://' + path.join(here, '..', 'src', 'renderer', 'lib', 'posApi.ts'))});
    process.stdout.write(m.humaniseError(new Error(${JSON.stringify("Error invoking remote method 'manage:listStaff': Error: ")} + process.argv[1])));
  `, msg], { encoding: 'utf8' });
  return r.stdout || r.stderr;
};

// ── (1) Offline sign-in: the right words ──
const mary = await call('auth:verifyPin', { pin: '4321', branch_id: 'br-1' });
ok('setup: Mary signs in offline from her saved credential', mary?.offline === true && mary.role === 'manager', JSON.stringify(mary));
const r1 = await attempt(() => call('manage:listStaff'));
ok('(1) the Staff list, offline sign-in: says it signed in offline — never "Not signed in"',
  r1.error && /signed in while offline/.test(r1.error.message) && !/not signed in/i.test(r1.error.message), r1.error?.message);
const shown = humanise(r1.error.message);
ok('(1) …and the screen shows exactly that (the humaniser does not turn it into "This till is not signed in")',
  shown.startsWith('You signed in while offline.') && /Selling is not affected/.test(shown), shown);
const others = await Promise.all([
  attempt(() => call('manage:listProducts')), attempt(() => call('manage:listPaymentMethods')),
  attempt(() => call('manage:setReceiptText', { header: 'H', footer: 'F' })), attempt(() => call('manage:createStaff', { name: 'X' })),
]);
ok('(1) the same for every cloud-owned editor (menu, payment methods, saving receipt text, adding staff)',
  others.every((r) => r.error && /signed in while offline/.test(r.error.message)), others.map((r) => r.error?.message ?? 'no error').join(' | '));

// ── (2) What the till has saved, read-only ──
const menu = await call('manage:cachedMenu');
ok('(2) the Menu: the till\'s own menu, with the reason', menu.offline?.reason === 'offline_session'
  && menu.products.map((p) => p.name).join(',') === 'Beef Burger,Burger Meal,Soda', JSON.stringify(menu.products.map((p) => p.name)));
ok('(2) …categories, prices, and the combo\'s contents', menu.categories.length === 2
  && menu.products.find((p) => p.id === 'p-1').base_price === 650
  && menu.products.find((p) => p.id === 'p-3').is_combo === true && menu.products.find((p) => p.id === 'p-1').is_combo === false
  && menu.combos.find((c) => c.id === 'p-3')?.items.map((i) => i.name).join('+') === 'Beef Burger+Soda');
const staff = await call('manage:cachedStaff');
ok('(2) the Staff page: the people who signed in on this till, names and roles', staff.offline?.reason === 'offline_session'
  && staff.source === 'till' && staff.staff.map((s) => `${s.name}:${s.role_name}`).join(',') === 'Mary:manager,Tom:cashier', JSON.stringify(staff));
ok('(2) …never a PIN hash', staff.staff.every((s) => Object.keys(s).every((k) => !/hash|pin/i.test(k))), JSON.stringify(staff.staff[0]));
ok('(2) nothing was sent while offline', calls.length === 0);

// ── (3) The network is back → a cloud sign-in by itself ──
online = true;
const r3 = await attempt(() => call('manage:listStaff'));
ok('(3) the network is back: the Staff list comes from the cloud, no second PIN entry', Array.isArray(r3.value)
  && r3.value.map((s) => s.name).join(',') === 'Mary,Ann', r3.error?.message ?? JSON.stringify(r3.value));
const vp = calls.find((c) => c.url.endsWith('/api/auth/verify-pin'));
ok('(3) …by the same request an online sign-in makes (PIN, branch, device), under the till\'s owner token', vp
  && vp.body.pin === '4321' && vp.body.branch_id === 'br-1' && vp.body.device_id === 'dev-T1' && vp.body.app_version === '0.6.15'
  && vp.auth === 'Bearer owner-tok', JSON.stringify(vp));
const st = calls.find((c) => c.url.endsWith('/api/staff'));
ok('(3) …and the list is read under MARY\'s own cloud token (the cloud applies her role, A340)', st?.auth === 'Bearer cloud-tok-4321', st?.auth);
ok('(3) the session now carries her cloud token (a restart keeps it)', tokenStore.readStaffTokens().token === 'cloud-tok-4321'
  && db.prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get()?.staff_id === 'u-mary');
const after = await call('manage:cachedMenu');
ok('(3) online again, the saved lists are no longer offered', after.offline === null && after.products.length === 0);
const n3 = calls.length; await attempt(() => call('manage:listStaff'));
ok('(3) upgraded once: later calls do not ask for the PIN again', calls.slice(n3).every((c) => !c.url.endsWith('/verify-pin')));

// ── A refusal is never replaced by the saved list ──
staffAnswer = () => ({ status: 403, json: { error: 'Forbidden' } });
const r403 = await attempt(() => call('manage:listStaff'));
const s403 = await call('manage:cachedStaff');
ok('a refusal is never replaced by the saved list (403 → "not allowed", cachedStaff returns nothing)',
  /does not allow/.test(r403.error?.message ?? '') && s403.offline === null && s403.staff.length === 0, JSON.stringify(s403));
staffAnswer = () => ({ status: 200, json: [] });

// ── The cloud ANSWERS no → stop trying; the offline session carries on ──
await call('auth:clearStaffSession');
online = false;
await call('auth:verifyPin', { pin: '1111', branch_id: 'br-1' });           // Tom, offline
online = true;
verifyAnswer = () => ({ status: 401, json: { error: 'Invalid PIN' } });    // e.g. his PIN was changed on the cloud
let n = calls.length;
const rj = await attempt(() => call('manage:listStaff'));
ok('the cloud refuses the held PIN → still the offline message, still signed in', /signed in while offline/.test(rj.error?.message ?? '')
  && db.prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get()?.staff_id === 'u-tom');
ok('…asked once', calls.slice(n).filter((c) => c.url.endsWith('/verify-pin')).length === 1);
n = calls.length; await attempt(() => call('manage:listStaff'));
ok('…and never again (a refused PIN is dropped, not retried)', calls.slice(n).filter((c) => c.url.endsWith('/verify-pin')).length === 0);

// ── A 5xx is "not reachable": keep the PIN, succeed later ──
await call('auth:clearStaffSession');
online = false; await call('auth:verifyPin', { pin: '4321', branch_id: 'br-1' }); online = true;
verifyAnswer = () => ({ status: 503, json: {} });
const r5 = await attempt(() => call('manage:listStaff'));
ok('a cloud answering 503 is unreachable: the offline message, the PIN kept', /signed in while offline/.test(r5.error?.message ?? ''));
verifyAnswer = (body) => ({ status: 200, json: { staff: { id: 'u-mary', name: 'Mary', role: 'manager' }, permissions: {}, accessToken: 'cloud-tok-2', refreshToken: 'x' } });
const r5b = await attempt(() => call('manage:listStaff'));
ok('…and the next try upgrades', Array.isArray(r5b.value) && tokenStore.readStaffTokens().token === 'cloud-tok-2', r5b.error?.message);

// ── A different person is never adopted ──
await call('auth:clearStaffSession');
online = false; await call('auth:verifyPin', { pin: '4321', branch_id: 'br-1' }); online = true;
verifyAnswer = () => ({ status: 200, json: { staff: { id: 'u-someone-else', name: 'Eve', role: 'owner' }, permissions: { '*': true }, accessToken: 'eve-tok' } });
const rm = await attempt(() => call('manage:listStaff'));
ok('the cloud names a different person → a different person is never adopted', /signed in while offline/.test(rm.error?.message ?? '')
  && tokenStore.readStaffTokens().token !== 'eve-tok'
  && db.prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get()?.staff_id === 'u-mary');

// ── Locking the till ends it ──
await call('auth:clearStaffSession');
online = false; await call('auth:verifyPin', { pin: '4321', branch_id: 'br-1' });
ok('(setup) an offline sign-in holds the PIN in memory', OS.heldOfflinePin()?.staffId === 'u-mary');
await call('auth:clearStaffSession');                                       // locked
ok('locking the till wipes the held PIN from memory at once', OS.heldOfflinePin() === null);
online = true; verifyAnswer = () => ({ status: 200, json: { staff: { id: 'u-mary' }, accessToken: 'late' } });
n = calls.length;
const rl = await attempt(() => call('manage:listStaff'));
ok('locking the till ends the upgrade: nothing is sent, and signed-out says "Not signed in"',
  calls.slice(n).length === 0 && /Not signed in/.test(rl.error?.message ?? ''), rl.error?.message);
const lockedMenu = await call('manage:cachedMenu');
ok('…and nobody signed in sees no saved lists', lockedMenu.offline === null);

// ── The till's void and refund (online calls) behave the same ──
await call('auth:clearStaffSession');
online = false; await call('auth:verifyPin', { pin: '4321', branch_id: 'br-1' });
const vOff = await attempt(() => call('order:void', { orderId: 'o-1', reason: 'wrong item' }));
ok('a void with an offline sign-in says it signed in offline (not "This till is not signed in")',
  /signed in while offline/.test(vOff.error?.message ?? ''), vOff.error?.message);
online = true;
verifyAnswer = () => ({ status: 200, json: { staff: { id: 'u-mary', name: 'Mary', role: 'manager' }, permissions: {}, accessToken: 'cloud-tok-v', refreshToken: 'x' } });
n = calls.length;
await attempt(() => call('order:refund', { orderId: 'o-2', reason: 'returned' }));
const rf = calls.slice(n);
ok('…and once online the refund first makes it a cloud sign-in, then goes out under MARY\'s token',
  rf[0]?.url.endsWith('/api/auth/verify-pin') && rf[1]?.url.endsWith('/api/orders/o-2/refund') && rf[1]?.auth === 'Bearer cloud-tok-v',
  JSON.stringify(rf.map((c) => [c.url, c.auth])));

// ── The screens (source — React not run here) ──
const ipc = src('main/ipcHandlers.ts');
ok('a timer retries the upgrade every 30 s while a PIN is held, and never keeps the app alive',
  /setInterval\(\(\) => \{ if \(heldOfflinePin\(\)\) void tryUpgradeOfflineSession\(\); \}, 30_000\)/.test(ipc) && /offlineUpgradeTimer as any\)\.unref/.test(ipc));
const menuPage = src('renderer/pages/MenuWorkbench.tsx');
ok('Menu page: falls back ONLY when the till says it is offline, and says why', /if \(cached\?\.offline\) \{/.test(menuPage)
  && /\{offline\.message\}/.test(menuPage) && /Showing the menu saved on this till — read-only/.test(menuPage));
ok('Menu page: offline, prices cannot be edited, import is hidden, the detail is the read-only one',
  /disabled=\{savingId === p\.id \|\| !!offline\}/.test(menuPage) && /onOpenImport && !offline &&/.test(menuPage) && /\) : offline \? \(\s*<SavedItemDetail/.test(menuPage));
const staffPage = src('renderer/pages/ManageTabs.tsx');
ok('Staff page: offline, the saved list with the reason; no Add, no Deactivate', /if \(cached\?\.offline\) \{/.test(staffPage)
  && /\{offline \? \(\s*<div className="bg-amber-500\/10/.test(staffPage) && /\{!offline && \(\s*<button onClick=\{\(\) => toggleActive\(m\)\}/.test(staffPage));
ok('the IPC bridge and schema carry the two new channels', /cachedMenu:\s+\(\)\s+=> ipcRenderer\.invoke\('manage:cachedMenu'\)/.test(src('main/preload.ts'))
  && /'manage:cachedStaff':\s+NO_PAYLOAD/.test(src('main/ipcSchemas.ts')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
