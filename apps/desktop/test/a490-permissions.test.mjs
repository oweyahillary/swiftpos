// A490 — the till asks ONE rule, by permission, everywhere (main process and screens).
//
// Owner, 2026-10-14/15: "turn most of this features into permissions which can be set in one place" — "dont just focus
// on reports break even other views and how to limit what users see". The till had nine "is a manager" rules, most of
// them deciding on the role's NAME; every gate now names a fine key of the catalogue (shared/permissions.ts) and asks
// main/tillAccess.ts (the owner's role → '*'; anyone else expandMap(their map)).
//
// RUNS the real compiled dist/main (electron shimmed, REAL SQLite, no network) and the real renderer/lib/access.ts
// (bundled with esbuild):
//   1. the one rule: the owner's role, an older cloud's broad map, a fine map, with and without the catalogue marker;
//   2. every converted / newly gated IPC handler, table-driven: refused without its key, past the gate with it;
//   3. no role-name check is left in apps/desktop/src (a scan, with a short allow-list);
//   4. the update bar's restart identifies the PIN's holder and never replaces the session at the till;
//   5. a fresher permission map (the staff list, a staff renewal) reaches staff_session and the screens are told;
//   6. config:get never hands the branch access code to the screens; a staff member is never given more than the
//      person adding them holds (nor the owner's role); a hand discount needs sales.discount; a reprint needs
//      sales.reprint unless it is the sale just rung by the same person.
//
//   cd apps/desktop && npm run build:main && node test/a490-permissions.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - personAccess.personKeys ignoring the owner's role                       → "the owner's role holds everything" fails
//   - order:create without the sales.discount check                           → the table row "order:create" fails
//   - escpos:reprintReceipt asking sales.reprint of the person who rang it     → "reprinting the sale this cashier just rang" fails
//   - ipcHandlers manager:salesSummary without its requireKey                  → the table row "manager:salesSummary" fails
//   - roleCeilingRefusal returning null                                        → "a staff.edit holder cannot create an owner" fails
//   - config:get returning node_secret                                         → "config:get never hands the screens" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a490-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  const sent = (global.__sent = []);
  const win = { isDestroyed: () => false, webContents: { send: (ch, ...a) => sent.push(ch) } };
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.16', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return [win]; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
/** What a handler said: a thrown message, a returned { ok:false, error } / { error }, or 'OK'. */
const said = async (fn) => {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && (r.ok === false || (typeof r.error === 'string' && !Array.isArray(r)))) return String(r.error ?? r.message ?? r.reason ?? 'refused');
    return 'OK';
  } catch (e) { return String(e?.message ?? e); }
};

const MARK = 'catalogue.v2';
const fine = (...keys) => Object.fromEntries([...keys.map((k) => [k, true]), [MARK, true]]);

// ── 1. the one rule ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nThe one rule (main/personAccess.ts, renderer/lib/access.ts)\n');
const PA = require(path.join(dist, 'personAccess.js'));
const accessOut = path.join(userData, 'access.mjs');
require('esbuild').buildSync({ entryPoints: [path.join(desktop, 'src/renderer/lib/access.ts')], bundle: true, format: 'esm',
  outfile: accessOut, logLevel: 'silent' });
const RA = await import(pathToFileURL(accessOut).href);
{
  const k = (role, perms) => [...PA.personKeys(role, perms)];
  ok('the owner\'s role holds everything (owner / admin, any case) — and the screens agree',
    k('Owner', '{}').join() === '*' && k(' admin ', {}).join() === '*' && PA.personCan({ roleName: 'owner' }, 'shifts.close_day')
    && RA.can({ role: 'Admin', permissions: {} }, 'menu.costs') && RA.isOwner({ role: 'owner' }));
  ok('a role\'s NAME gives nothing else: "Manager" with no keys holds nothing a cashier does not',
    !PA.personCan({ roleName: 'manager', permissions: {} }, 'shifts.confirm', 'sales.void', 'shifts.close_day', 'reports.sales')
    && !RA.backOffice({ role: 'Branch Manager', permissions: {} }) && !PA.backOffice('supervisor', '{}'));
  ok('an older cloud\'s broad keys become the fine keys they stood for (orders.void → void, refund, confirm, reprint)',
    ['sales.void', 'sales.refund', 'shifts.confirm', 'sales.reprint'].every((x) => PA.personCan({ roleName: 'x', permissions: '{"orders.void":true}' }, x))
    && !PA.personCan({ roleName: 'x', permissions: '{"orders.void":true}' }, 'shifts.close_day'));
  ok('a fine map holds exactly its keys', PA.personCan({ permissions: fine('reports.items') }, 'reports.items')
    && !PA.personCan({ permissions: fine('reports.items') }, 'reports.sales'));
  ok('no marker (a map from before the catalogue): what nobody was refused before is kept; with the marker it is not',
    PA.personCan({ permissions: '{"orders.create":true}' }, 'sales.discount') && !PA.personCan({ permissions: fine('orders.create') }, 'sales.discount'));
  ok('a key taken away (false) removes what it stands for; unreadable JSON grants nothing',
    !PA.personCan({ permissions: '{"orders.void":true,"sales.refund":false}' }, 'sales.refund')
    && !PA.personCan({ permissions: '{nope' }, 'sales.void'));
  ok('back office: beyond the shop floor or the owner — what every role keeps is not back office',
    PA.backOffice('cashier', '{"reports.view":true}') && PA.backOffice('owner', '{}')
    && !PA.backOffice('cashier', JSON.stringify(fine('orders.create', 'staff.view', 'sales.history_all', 'sales.discount')))
    && !PA.backOffice('cashier', '{"orders.create":true}') && RA.backOffice({ permissions: { 'shifts.close_day': true } }));
  ok('history before migration 134: the switch unless they may confirm; after: sales.history_all',
    PA.seesAllHistory({ permissions: '{}' }, false) && !PA.seesAllHistory({ permissions: '{}' }, true)
    && PA.seesAllHistory({ permissions: '{"orders.void":true}' }, true)
    && PA.seesAllHistory({ permissions: fine('sales.history_all') }, true) && !PA.seesAllHistory({ permissions: fine('shifts.confirm') }, false));
  ok('cash in / out before migration 134: the switch unless they may confirm; after: shifts.cash_movements (screens agree)',
    PA.mayMoveMoney({ permissions: '{}' }, false) && !PA.mayMoveMoney({ permissions: '{}' }, true)
    && PA.mayMoveMoney({ permissions: '{"settings.manage":true}' }, true) && !PA.mayMoveMoney({ permissions: fine('orders.create') }, false)
    && RA.mayMoveMoney({ permissions: fine('shifts.cash_movements') }, true) === true && RA.mayMoveMoney({ permissions: {} }, true) === false);
  ok('a role\'s keys from roles_cache: fine `keys`, the older list, the owner\'s role',
    [...PA.roleKeys({ name: 'Cashier', keys: ['orders.create'] })].join() === 'orders.create'
    && PA.roleKeys({ name: 'Old', permissions: [{ key: 'staff.manage' }] }).has('staff.edit')
    && PA.roleKeys({ name: 'Owner' }).has('*') && PA.roleKeys({ name: 'x', is_owner_role: true }).has('*'));
}

// ── the real handlers ───────────────────────────────────────────────────────────────────────────────────────────────
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till',
  terminal_code: 'T1', device_name: 'Front', node_secret: 'BRANCH-CODE', configured: true, web_pos_enabled: true });
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-T1', 'biz-1', 'B', '2026-10-15T00:00:00Z')`).run();
db.prepare(`INSERT OR IGNORE INTO branches (id, name) VALUES ('br-1', 'Main')`).run();
db.prepare(`UPDATE device_config SET web_pos_enabled = 1 WHERE id = 1`).run();   // the online licence (the cloud's pull sets it)
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };   // no network
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const signIn = (perms, role = 'staff', id = 'u-1') => {
  db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
  db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
              VALUES (1, ?, 'Pat', ?, 'br-1', 'Main', ?, '', NULL, '2026-10-15T00:00:00Z')`).run(id, role, JSON.stringify(perms));
};
const call = (ch, payload) => H[ch]({}, payload);

// ── 2. every gate, table-driven ─────────────────────────────────────────────────────────────────────────────────────
console.log('\nEvery gate: refused without its key, past the gate with it\n');
const order = { branch_id: 'br-1', order_number: 'T1--1', subtotal: 100, vat_amount: 0, total: 90, discount_amount: 10,
  items: [{ product: { id: 'p-1', name: 'Tea' }, unitPrice: 100, quantity: 1, lineTotal: 100 }], payments: [{ method: 'cash', amount: 90 }] };
const GATES = [
  ['manager:salesSummary', undefined, ['reports.sales'], /does not see this report/],
  ['manager:topProducts', undefined, ['reports.items'], /does not see this report/],
  ['manager:recentOrders', undefined, ['orders.view_all'], /does not see this report/],
  ['manager:branchOrders', undefined, ['orders.view_all'], /does not see this report/],
  ['manager:branchDay', undefined, ['reports.overview'], /does not see this report/],
  ['manager:stockLevels', undefined, ['inventory.view'], /does not see this report/],
  ['manager:fuelSales', undefined, ['reports.fuel'], /does not see this report/],
  ['manager:pumpStatus', undefined, ['reports.fuel'], /does not see this report/],
  ['manager:tableOccupancy', undefined, ['orders.view_all'], /does not see this report/],
  ['manager:branchReport', undefined, ['reports.sales'], /does not see this report/],
  ['manager:priceList', undefined, ['products.view'], /does not allow this\./],
  ['manager:exportCsv', { kind: 'orders' }, ['reports.export', 'orders.view_all'], /does not download/],
  ['manager:dailyReport', {}, ['reports.export', 'reports.sales'], /does not download/],
  ['manager:setBranchPrice', { product_id: 'p-1', price: 1 }, ['menu.prices'], /change prices/],
  ['expense:range', undefined, ['expenses.view'], /does not see expenses/],
  ['expense:addCategory', { name: 'Gas' }, ['expenses.manage'], /does not add expense types/],
  ['day:summary', undefined, ['reports.sales'], /day.s figures/],
  ['day:close', { countedCash: 0 }, ['shifts.close_day'], /may close the day/],
  ['day:retryConflict', { shiftId: 'x' }, ['shifts.close_day'], /may close the day/],
  ['branchClose:overview', undefined, ['shifts.close_day'], /may close the day/],
  ['branchClose:closeBranch', {}, ['shifts.close_day'], /may close the day/],
  ['shift:forceClose', { reason: 'left' }, ['shifts.force_close'], /force-close a drawer/],
  ['shift:history', undefined, ['reports.shifts'], /shift reports/],
  ['manager:branchShifts', undefined, ['shifts.confirm'], /shift reports/],
  ['shift:remoteConfirmView', 'sh-1', ['shifts.confirm'], /confirms drawers/],
  ['monthly:get', { month: '2026-10' }, ['reports.monthly_pack'], /open the monthly pack/],
  ['monthly:addMovement', { movement_date: '2026-10-05', method: 'cash', kind: 'charges', amount: 10 }, ['expenses.manage'], /record for the books/],
  ['monthly:removeMovement', { id: 'm-1' }, ['expenses.manage'], /record for the books/],
  ['manage:listProducts', undefined, ['products.view'], /does not allow this\./],
  ['manage:createProduct', { name: 'Tea', base_price: 50 }, ['menu.edit'], /menu change/],
  ['manage:updateProduct', { id: 'p-1', patch: { base_price: 60 } }, ['menu.prices'], /menu change/],
  ['manage:createPaymentMethod', { name: 'Voucher', code: 'voucher' }, ['settings.payments'], /payment methods/],
  ['manage:setPaymentMethodsEnabled', ['cash'], ['settings.payments'], /payment methods/],
  ['manage:setReceiptText', { header: 'H', footer: 'F' }, ['receipt.manage'], /receipt text/],
  ['manage:setContinuousOperation', true, ['settings.business'], /business settings/],
  ['manage:setCashierHistoryMethods', ['cash'], ['settings.business'], /business settings/],
  ['manage:offers', undefined, ['menu.offers'], /set up offers/],
  ['manage:listStaff', undefined, ['staff.view'], /see the staff list/],
  ['manage:setStaffPin', { id: 'u-9', pin: '1234' }, ['staff.edit'], /add or change staff/],
  ['manage:seedDefaultStations', undefined, ['stations.manage'], /print stations/],
  ['escpos:setKitchenExclusions', ['onion'], ['stations.manage'], /print stations/],
  ['escpos:clearKitchenExclusions', undefined, ['stations.manage'], /print stations/],
  ['wastage:items', undefined, ['inventory.waste'], /recording wastage/],
  ['transfers:list', undefined, ['inventory.transfer'], /transfer stock/],
  ['order:void', { orderId: 'o-1', reason: 'x' }, ['sales.void'], /does not void sales/],
  ['order:refund', { orderId: 'o-1', reason: 'x' }, ['sales.refund'], /does not refund sales/],
  ['branding:set', { businessId: 'biz-1', accentHex: '#112233' }, ['receipt.manage'], /change the branding/],
  ['node:tlsRetrust', undefined, ['settings.business'], /technician or someone who manages/],
  ['order:create', order, ['sales.discount'], /does not give discounts/],
];
for (const [ch, payload, keys, refusedRe] of GATES) {
  signIn(fine('orders.create'), 'cashier');
  const without = await said(() => call(ch, payload));
  signIn(fine(...keys), 'cashier');
  const withIt = await said(() => call(ch, payload));
  ok(`${ch}: ${keys.join(' + ')}`, refusedRe.test(without) && !refusedRe.test(withIt), `without: ${without} | with: ${withIt}`);
}
{
  db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
  ok('nobody signed in: a back-office read says "Not signed in"', /Not signed in/.test(await said(() => call('manager:salesSummary'))));
  signIn({}, 'Owner');
  ok('the owner\'s role passes every gate (a sample)', !/does not|may close|force-close/.test(await said(() => call('manager:salesSummary')))
    && !/may close the day/.test(await said(() => call('branchClose:overview'))));
  signIn(fine('orders.create'), 'cashier');
  ok('update:installNow: shifts.close_day (a cashier is refused)', (await call('update:installNow')).reason === 'manager_required');
  signIn(fine('shifts.close_day'), 'cashier');
  ok('…its holder passes the gate (then: not a packaged build)', (await call('update:installNow')).reason === 'not packaged');
}

// ── 3. no role-name check left ──────────────────────────────────────────────────────────────────────────────────────
console.log('\nNo role-name checks in apps/desktop/src\n');
{
  // The owner's role is the ONE role-name rule (the cloud's own); the copies of shared files carry it too.
  const ALLOW = new Set(['main/personAccess.ts', 'renderer/lib/access.ts', 'shared/shiftConfirm.ts', 'main/permissions.ts', 'shared/permissions.ts']);
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name)) files.push(p);
  } };
  walk(path.join(desktop, 'src'));
  const bad = [];
  const ROLE_CHECK = [
    /'(owner|admin|manager|supervisor|branch_manager)'\s*,\s*'(owner|admin|manager|supervisor|branch_manager)'/,   // a role-name list
    /(role_name|roleName|\.role)\b[^;\n]{0,60}(===|!==|includes\(|\.test\()[^;\n]{0,40}'(owner|admin|manager|supervisor|cashier)'/i,
    /\/[^/\n]*\b(owner|manager|supervisor)\b[^/\n]*\/i?\.test\([^)]*role/i,                // a role-name regex
    /MANAGER_ROLES|ELEVATED_NAME|isShiftManager|hasManagerRights\s*=\s*\(s[^)]*\)\s*=>\s*\{|personHolds|mayVoidRefund|maySeeSync|mayAddExpenseType/,
  ];
  for (const f of files) {
    const rel = path.relative(path.join(desktop, 'src'), f).replace(/\\/g, '/');
    if (ALLOW.has(rel)) continue;
    const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const re of ROLE_CHECK) if (re.test(code)) bad.push(`${rel}: ${re}`);
  }
  ok(`no file decides on a role's name (${files.length} files scanned)`, bad.length === 0, bad.join(' ; '));
  ok('the allow-listed owner rule is the cloud\'s: owner / admin only', /\['owner', 'admin'\]/.test(fs.readFileSync(path.join(desktop, 'src/main/personAccess.ts'), 'utf8'))
    && /\['owner', 'admin'\]/.test(fs.readFileSync(path.join(desktop, 'src/renderer/lib/access.ts'), 'utf8')));
}

// ── 4. the update bar never replaces the session ───────────────────────────────────────────────────────────────────
console.log('\nThe update bar\'s restart\n');
{
  const bcrypt = require('bcryptjs');
  const P = require(path.join(dist, 'pinCache.js'));
  P.cacheStaffCredential({ staffId: 'u-own', name: 'Olive', roleName: 'owner', permissions: {} }, bcrypt.hashSync('9090', 4), 'br-1');
  P.cacheStaffCredential({ staffId: 'u-mgr', name: 'Mary', roleName: 'manager', permissions: fine('shifts.close_day') }, bcrypt.hashSync('7070', 4), 'br-1');
  P.cacheStaffCredential({ staffId: 'u-sup', name: 'Sam', roleName: 'supervisor', permissions: {} }, bcrypt.hashSync('6060', 4), 'br-1');
  signIn(fine('orders.create'), 'cashier', 'u-cash');
  const before = JSON.stringify(db.prepare(`SELECT staff_id, role_name, permissions FROM staff_session WHERE id=1`).get());
  const r1 = await call('update:installWithPin', { pin: '7070' });
  const r2 = await call('update:installWithPin', { pin: '9090' });
  const r3 = await call('update:installWithPin', { pin: '6060' });
  const r4 = await call('update:installWithPin', { pin: '1212' });
  const after = JSON.stringify(db.prepare(`SELECT staff_id, role_name, permissions FROM staff_session WHERE id=1`).get());
  ok('a shifts.close_day PIN restarts (then: not a packaged build) — the cashier stays signed in', r1.reason === 'not packaged' && before === after, JSON.stringify({ r1, before, after }));
  ok('the owner\'s PIN restarts too (the role-name list used to refuse the owner)', r2.reason === 'not packaged', JSON.stringify(r2));
  ok('a "supervisor" without the key is refused, saying why; an unknown PIN is refused', r3.reason === 'not_allowed' && /Close the day/.test(r3.message)
    && r4.ok === false && r4.reason !== 'not packaged', JSON.stringify({ r3, r4 }));
  const banner = fs.readFileSync(path.join(desktop, 'src/renderer/pages/UpdateBanner.tsx'), 'utf8');
  ok('the bar calls update.installWithPin and never auth.verifyPin', /posApi\.update\.installWithPin\(pin\.trim\(\)\)/.test(banner)
    && !/posApi\.auth\.verifyPin/.test(banner));
}

// ── 5. a fresher map reaches the session ───────────────────────────────────────────────────────────────────────────
console.log('\nStale permissions\n');
{
  const TA = require(path.join(dist, 'tillAccess.js'));
  const BS = require(path.join(dist, 'branchStaff.js'));
  signIn(fine('orders.create', 'reports.sales'), 'manager', 'u-mgr');
  global.__sent.length = 0;
  const bcrypt = require('bcryptjs');
  BS.storeBranchStaff('br-1', [
    { staff_id: 'u-mgr', name: 'Mary', role_name: 'cashier', permissions: fine('orders.create'), pin_hash: bcrypt.hashSync('7070', 4), override_pin_hash: null, status: 'active' },
    { staff_id: 'u-sup', name: 'Sam', role_name: 'supervisor', permissions: fine('shifts.confirm'), pin_hash: bcrypt.hashSync('6060', 4), override_pin_hash: null, status: 'active' },
  ]);
  const st = db.prepare(`SELECT role_name, permissions FROM staff_session WHERE id=1`).get();
  ok('the staff list brings Mary\'s new map: her session loses reports.sales at once', !TA.signedInCan('reports.sales') && TA.signedInCan('orders.create')
    && st.role_name === 'cashier', JSON.stringify(st));
  ok('…and the screens are told (auth:permissionsChanged)', global.__sent.includes('auth:permissionsChanged'));
  ok('…and every saved sign-in takes its person\'s map', JSON.parse(db.prepare(`SELECT permissions FROM staff_pin_cache WHERE staff_id='u-sup'`).get().permissions)['shifts.confirm'] === true);
  global.__sent.length = 0;
  ok('the same map again changes nothing and tells nobody', TA.storeSessionPermissions('u-mgr', fine('orders.create')) === false && global.__sent.length === 0);
  ok('a renewal\'s map is stored only for the person still signed in', TA.storeSessionPermissions('u-other', fine('reports.sales')) === false
    && TA.storeSessionPermissions('u-mgr', fine('orders.create', 'reports.items')) === true && TA.signedInCan('reports.items'));
  const app = fs.readFileSync(path.join(desktop, 'src/renderer/App.tsx'), 'utf8');
  ok('the screens re-read the session on auth:permissionsChanged', /posApi\.auth\.onPermissionsChanged\(\(\) => \{\s*posApi\.auth\.getStaffSession\(\)/.test(app)
    && /ipcRenderer\.on\('auth:permissionsChanged', h\)/.test(fs.readFileSync(path.join(desktop, 'src/main/preload.ts'), 'utf8')));
  ok('the staff renewal stores the cloud\'s `permissions`', /if \(permissions && typeof permissions === 'object' && storeSessionPermissions\(who, permissions\)\)/
    .test(fs.readFileSync(path.join(desktop, 'src/main/syncEngine.ts'), 'utf8')));
}

// ── 6. the rest ─────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nThe branch code, the staff ceiling, discounts and reprints\n');
{
  signIn({}, 'Owner');
  const cfg = await call('config:get');
  ok('config:get never hands the screens the branch access code (even the owner\'s)', cfg.node_secret === null && cfg.terminal_code === 'T1', JSON.stringify(cfg.node_secret));
  ok('…the till itself still holds it', C.getDeviceConfig().node_secret === 'BRANCH-CODE');

  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('roles_cache', ?, ?)`).run(JSON.stringify([
    { id: '00000000-0000-4000-8000-0000000000a1', name: 'Owner', is_owner_role: true, keys: [] },
    { id: '00000000-0000-4000-8000-0000000000a2', name: 'Cashier', keys: ['orders.create', 'sales.discount'] },
    { id: '00000000-0000-4000-8000-0000000000a3', name: 'Manager', keys: ['orders.create', 'sales.void', 'shifts.close_day'] },
  ]), new Date().toISOString());
  signIn(fine('staff.edit', 'orders.create', 'sales.discount'), 'manager', 'u-mgr');
  const owner = await said(() => call('manage:createStaff', { name: 'Eve', pin: '4444', role_id: '00000000-0000-4000-8000-0000000000a1' }));
  const more = await said(() => call('manage:createStaff', { name: 'Max', pin: '4445', role_id: '00000000-0000-4000-8000-0000000000a3' }));
  const same = await said(() => call('manage:createStaff', { name: 'Cal', pin: '4446', role_id: '00000000-0000-4000-8000-0000000000a2' }));
  ok('a staff.edit holder cannot create an owner on this till (the hole: an owner signed in here at once, offline)', /owner/i.test(owner), owner);
  ok('…nor someone who can do more than they can', /can do more than you/.test(more), more);
  ok('…but adds a cashier at once', same === 'OK', same);
  signIn(fine('staff.view'), 'manager', 'u-mgr');
  ok('without staff.edit, nobody is added', /add or change staff/.test(await said(() => call('manage:createStaff', { name: 'Zed', pin: '4447', role_id: '00000000-0000-4000-8000-0000000000a2' }))));
  signIn({}, 'owner');
  ok('the owner adds anyone but the owner\'s role (that is the web\'s)', (await said(() => call('manage:createStaff', { name: 'Mo', pin: '4448', role_id: '00000000-0000-4000-8000-0000000000a3' }))) === 'OK'
    && /owner/i.test(await said(() => call('manage:createStaff', { name: 'Oz', pin: '4449', role_id: '00000000-0000-4000-8000-0000000000a1' }))));

  signIn(fine('orders.create'), 'cashier', 'u-cash');
  const noDisc = { ...order, order_number: 'T1--2', discount_amount: 0, total: 100 };
  ok('a sale with no hand discount is never refused for it (selling is never asked)', !/discount/i.test(await said(() => call('order:create', noDisc))));
  const offerOnly = { ...order, order_number: 'T1--3', discount_amount: 10, offer_discount: 10, offers: [] };
  ok('…nor one whose discount the offers took', !/give discounts/.test(await said(() => call('order:create', offerOnly))));
  const opened = await said(() => call('shift:open', { opening_float: 0 }));
  const rung = await said(() => call('order:create', { ...noDisc, order_number: 'T1--4' }));
  if (rung !== 'OK') console.log('      (shift:open said: ' + opened + ')');
  ok('(setup) the cashier rings a sale', rung === 'OK', rung);
  ok('reprinting the sale this cashier just rang works (the "print my receipt now")', !/reprint permission/.test(await said(() => call('escpos:reprintReceipt'))));
  signIn(fine('orders.create'), 'cashier', 'u-other');
  ok('another cashier reprinting it needs sales.reprint', /reprint permission/.test(await said(() => call('escpos:reprintReceipt'))));
  signIn(fine('sales.reprint'), 'cashier', 'u-other');
  ok('…which a sales.reprint holder has', !/reprint permission/.test(await said(() => call('escpos:reprintReceipt'))));
  signIn(fine('orders.create'), 'cashier', 'u-cash');
  ok('enrolling a till already joined to its business is the technician console\'s', /technician/.test(await said(() => call('auth:enrolDevice', { business_id: 'biz-1', code: 'X' }))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
