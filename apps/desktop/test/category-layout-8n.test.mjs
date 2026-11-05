// 8n (2026-11-05) — the branch's category layout on the desktop POS: the side panel behind ☰ (A537, the standard) or the
// categories across the top. Owner, 2026-11-05: "initially we used to have a horizontal navbar for categories then we
// introduced the current vertical one can we have the option for both which can be toggled per branch by the manager? in
// the desktop app?" — and "yes we are unifying them so no change hits one without the other being affected".
//
// RUNS the real compiled dist/main (syncEngine's whole pull and applyChangeEntries, deviceConfig's cache, the branch
// server's reference bundle and a peer's unpacking, the IPC handlers through registerIpcHandlers and manageFetch) on a
// REAL SQLite file, electron shimmed, with a stand-in cloud (globalThis.fetch).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node --no-warnings test/category-layout-8n.test.mjs
//
//   1  the pull: pos/init's posCategoryLayout is kept on this POS (maintenance_state — offline too); an older cloud (no
//      key) and a value that is not panel / top leave it; never told = the side panel.
//   2  the change log: a 'setup' config change carries it (the branch's other POS switch without a whole pull); a money
//      change without the key leaves it.
//   3  the branch server relays it to its POS; an older server's bundle says nothing (a peer keeps its own).
//   4  the screens: pos:categoryLayout answers anyone signed in (the cached value); manage:setCategoryLayout needs
//      settings.pos_layout (a plain Manager's built-in keys) or settings.branches (the owner: everything) — a Cashier's
//      built-in keys are refused; it refuses anything but panel / top before asking the cloud, posts THIS branch's key to
//      /api/branches/:id/settings, and this POS switches at once.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — 2026-11-05):
//   - syncEngine configFromInit without posCategoryLayout                → 1 "kept on this POS" and 2 fail
//   - deviceConfig setCategoryLayout storing any string (no check)        → 1 "not panel / top leaves it" fails
//   - referenceBundle's node read without posCategoryLayout                → 3 "relays it" fails
//   - manage:setCategoryLayout without its requireKey                      → 4 "a Cashier is refused" fails
//   - its requireKey back to ['settings.branches'] only                   → 4 stops at "a plain Manager" (refused); a490's gate row fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-8n-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.23', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
    session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 600)}`); fail++; } };
// A function, not a promise: the channel's payload check (ipcGuard) throws before any promise exists.
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e?.message ?? String(e); } };
const BR = '22222222-2222-4222-8222-222222222222';

// ── The stand-in cloud ──
const SIGNED = { 'content-type': 'application/json', 'x-zaptill-server': '1' };
const cloud = { init: null, calls: [] };
const initWith = (extra) => ({ products: [], categories: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
  vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'restaurant', businessName: 'Test Grill', currency: 'KES', ...extra });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  cloud.calls.push({ path: u.pathname, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
  const send = (status, body) => new Response(JSON.stringify(body), { status, headers: SIGNED });
  if (u.pathname === '/api/pos/init') return send(200, cloud.init);
  if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff: [] });
  if (/\/api\/branches\/[^/]+\/settings$/.test(u.pathname)) return send(200, { key: 'pos_category_layout', value: JSON.parse(init.body).value });
  if (/\/api\/(inventory|tables|pumps|stations|staff)/.test(u.pathname)) return send(200, []);
  return send(200, {});
};

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-T1', 'biz-1', 'Test Grill', '2026-11-05T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.test', branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
const TS = require(path.join(dist, 'tokenStore.js'));
TS.writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine('http://cloud.test', 'tok', 'r1');
const RB = require(path.join(dist, 'referenceBundle.js'));
const stored = () => db.prepare(`SELECT value FROM maintenance_state WHERE key = 'pos_category_layout'`).get()?.value ?? null;

console.log('8n — the branch\'s category layout on the desktop POS\n');
try {
  // ── 1 ──
  ok('never told: the side panel (nobody\'s screen changes until a manager chooses)', DC.getCategoryLayout() === 'panel' && stored() === null);
  cloud.init = initWith({ posCategoryLayout: 'top' });
  const r = await E.pullCatalogueNow();
  ok('the pull: pos/init\'s value is kept on this POS (maintenance_state — it stays offline)', r.pulled === true && DC.getCategoryLayout() === 'top' && stored() === 'top',
    JSON.stringify({ r, stored: stored() }));
  cloud.init = initWith({});
  await E.pullCatalogueNow();
  ok('an older cloud (no key): this POS keeps its value', DC.getCategoryLayout() === 'top');
  cloud.init = initWith({ posCategoryLayout: 'sideways' });
  await E.pullCatalogueNow();
  ok('a value that is not panel / top: not stored — the POS keeps its value', DC.getCategoryLayout() === 'top' && stored() === 'top', stored());
  DC.setCategoryLayout(undefined); DC.setCategoryLayout(null); DC.setCategoryLayout(42);
  ok('…nor nothing, null or a number', stored() === 'top');

  // ── 2 ──
  const setup = (seq, value) => E.applyChangeEntries([{ seq, topic: 'setup', table: 'config', id: 'setup', op: 'upsert', row: { posCategoryLayout: value } }]);
  setup(1, 'panel');
  const afterPanel = DC.getCategoryLayout();
  setup(2, 'top');
  ok('the change log: a setup change carries it either way — the branch\'s other POS switch without a whole pull',
    afterPanel === 'panel' && DC.getCategoryLayout() === 'top', JSON.stringify({ afterPanel, now: DC.getCategoryLayout() }));
  E.applyChangeEntries([{ seq: 3, topic: 'money', table: 'config', id: 'money', op: 'upsert', row: { vatRate: 16 } }]);
  ok('…a money change (no key) leaves it', DC.getCategoryLayout() === 'top');

  // ── 3 ──
  const bundle = RB.buildReferenceBundle(db, DC.getDeviceConfig());
  const unpacked = RB.unpackNodeBundle(JSON.parse(JSON.stringify(bundle)));
  ok('the branch server relays it to its POS', unpacked.config.posCategoryLayout === 'top', JSON.stringify(unpacked.config.posCategoryLayout));
  const older = JSON.parse(JSON.stringify(bundle));
  delete older.posInit?.posCategoryLayout;
  ok('an older server\'s bundle (no key) says nothing — the peer keeps its own', RB.unpackNodeBundle(older).config.posCategoryLayout === undefined);

  // ── 4 ──
  require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
  const H = global.__handlers;
  const signIn = (keys, role = 'Manager') => {
    db.prepare(`DELETE FROM staff_session`).run();
    db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, 'u-1', 'Pat', ?, ?, ?, 'x', '2026-11-05T06:00:00Z')`)
      .run(role, JSON.stringify({ 'catalogue.v2': true, ...Object.fromEntries(keys.map((k) => [k, true])) }), BR);
    TS.writeStaffTokens({ token: 'staff-pat', refreshToken: 'r' });
  };
  // The built-in roles' keys for a NEW business (@zaptill/core/permissions) — what a plain Manager and a Cashier hold.
  const P = require('@zaptill/core/permissions');
  signIn(P.defaultKeysForRoleName('Cashier'), 'Cashier');
  const read = await H['pos:categoryLayout']({});
  ok('pos:categoryLayout answers anyone signed in — the cached value (offline too)', read?.layout === 'top', JSON.stringify(read));
  cloud.calls.length = 0;
  const refused = await rejects(() => H['manage:setCategoryLayout']({}, 'panel'));
  ok('a Cashier (the built-in keys) is refused — and nothing is asked of the cloud', /does not change how this branch's POS shows its categories/.test(refused ?? '')
    && cloud.calls.length === 0 && DC.getCategoryLayout() === 'top', refused);
  signIn(P.defaultKeysForRoleName('Manager'));
  const bad = await rejects(() => H['manage:setCategoryLayout']({}, 'sideways'));
  ok('a value that is not panel / top is refused before the cloud is asked (the channel\'s check: panel, top)', /panel, top/.test(bad ?? '') && cloud.calls.length === 0, bad);
  const out = await H['manage:setCategoryLayout']({}, 'panel');
  const post = cloud.calls.find((c) => c.method === 'POST');
  ok('a plain Manager (the built-in keys: settings.pos_layout, not settings.branches) posts THIS branch\'s key to /api/branches/:id/settings',
    !P.defaultKeysForRoleName('Manager').includes('settings.branches') && post?.path === `/api/branches/${BR}/settings`
    && post?.body?.key === 'pos_category_layout' && post?.body?.value === 'panel', JSON.stringify(cloud.calls));
  ok('…and this POS switches at once', DC.getCategoryLayout() === 'panel' && out?.value === 'panel', JSON.stringify(out));
  signIn(['settings.pos_layout']);
  await H['manage:setCategoryLayout']({}, 'top');
  ok('settings.pos_layout alone is enough', DC.getCategoryLayout() === 'top');
  signIn(['settings.branches']);
  await H['manage:setCategoryLayout']({}, 'panel');
  ok('settings.branches still is (a General Manager, the holders of settings.manage)', DC.getCategoryLayout() === 'panel');
  signIn([], 'Owner');
  await H['manage:setCategoryLayout']({}, 'top');
  ok('the owner (every key) may too', DC.getCategoryLayout() === 'top');
} catch (e) {
  ok('the test ran to its end', false, e?.stack ?? String(e));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
