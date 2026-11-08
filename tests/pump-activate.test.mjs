// Activate a pump — the web POS and the desktop POS (owner, 2026-11-04: "1-5 yes only if the web licence is active").
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/pump-activate.test.mjs
//
// PATCH /api/pumps/:id/activate marks a pump dispensing when a cashier starts a fuel sale. It needed fuel.manage, which a
// cashier rarely holds (the web's call then failed quietly), and the cloud refused it from a desktop POS (A159: not on the
// terminal-write allowlist). Now whoever may sell (orders.create, or fuel.manage as before) may activate a pump of their
// own branch (or one of the whole business); from a desktop POS only as the person signed in, and only with the online
// licence. RUNS the COMPILED server (routes/index.js behind the real requireAuth, requireAnyPermission and the
// terminal-write guard, ENFORCED) over HTTP on the in-memory database (tests/lib-memdb.mjs).
//
//   R  the rule: a cashier (orders.create) on the web; a fuel.manage holder; a business-wide pump; refused: another
//      branch's pump (403), another business's (404), no right (403), an inactive pump (404).
//   D  the desktop: a cashier's PIN sign-in with the licence (200); without the licence (403 ONLINE_LICENCE_REQUIRED, the
//      pump untouched); the till's own token (403 by the guard); the allowlist entry is a person's only.
//   W  the wiring: the desktop main process asks only with the licence and never blocks the sale; the sale screen asks
//      when a fuel line goes on with the licence; the web's call is unchanged.
//
// MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted):
//   - fueltanks.ts activate back on canManageFuel                       → R "a cashier on the web", D "with the licence"
//   - fueltanks.ts without the desktopWithoutLicence check               → D "without the licence"
//   - fueltanks.ts without ownRow (branch check)                         → R "another branch's pump"
//   - terminalWrites.ts without the /activate entry                      → D "with the licence", D "the allowlist"
//   - terminalWrites.ts entry in TILL_WRITES instead of MANAGER_WRITES   → D "the till's own token", D "the allowlist"
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/onlineLicence.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.TERMINAL_WRITE_ENFORCE = 'true';
process.env.TILL_SCOPE_ENFORCE = 'true';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const warn = console.warn; console.warn = () => {};
const err = console.error; console.error = () => {};

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222', K = '33333333-2222-4222-8222-222222222222', BRX = '44444444-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', CATE = 'aaaaaaaa-0000-4000-8000-000000000002';
const FUEL = 'aaaaaaaa-0000-4000-8000-000000000003', KITCH = 'aaaaaaaa-0000-4000-8000-000000000004';
const PW = 'cccccccc-0000-4000-8000-000000000001', PK = 'cccccccc-0000-4000-8000-000000000002';
const PALL = 'cccccccc-0000-4000-8000-000000000003', POFF = 'cccccccc-0000-4000-8000-000000000004', PX = 'cccccccc-0000-4000-8000-000000000005';
const perms = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });

const reset = (licensed = true) => {
  mem.fail = () => null; mem.calls = []; AC._resetAuthCache();
  const user = (id, name, role, branches) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, role_id: role ? `role-${id}` : null,
    roles: role, user_branches: branches.map((b) => ({ branch_id: b })), user_permissions: [] });
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Fuel Co', type: 'petrol_station', currency: 'KES', status: 'active' },
      { id: B2, owner_id: 'x', name: 'Other', type: 'petrol_station', currency: 'KES', status: 'active' }],
    branches: [{ id: W, business_id: B, name: 'Westlands', status: 'active', is_main: true }, { id: K, business_id: B, name: 'Kilimani', status: 'active' },
      { id: BRX, business_id: B2, name: 'Theirs', status: 'active' }],
    users: [user(OWNER, 'Owner', { name: 'Admin', role_permissions: [] }, []),
      user(CATE, 'Cate', perms('Cashier', 'orders.create', 'products.view'), [W]),
      user(FUEL, 'Fred', perms('Fuel attendant', 'fuel.manage', 'products.view'), [W]),
      user(KITCH, 'Kit', perms('Kitchen', 'products.view'), [W])],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: W, user_id: OWNER }],
    pumps: [
      { id: PW, business_id: B, branch_id: W, name: 'Pump 1', status: 'idle' },
      { id: PK, business_id: B, branch_id: K, name: 'Pump 2', status: 'idle' },
      { id: PALL, business_id: B, branch_id: null, name: 'Pump 3', status: 'idle' },
      { id: POFF, business_id: B, branch_id: W, name: 'Pump 4', status: 'inactive' },
      { id: PX, business_id: B2, branch_id: BRX, name: 'Theirs', status: 'idle' }],
    orders: [], audit_log: [], refresh_tokens: [], sync_versions: [], sync_changes: [], business_settings: [], branch_settings: [],
    feature_flags: licensed ? [{ business_id: B, key: 'web_hosting', enabled: true }] : [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, isOwner: false, surface: 'dashboard', ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  cate: sign({ userId: CATE, branchId: W, permissionKeys: ['orders.create', 'products.view'] }),
  fuel: sign({ userId: FUEL, branchId: W, permissionKeys: ['fuel.manage', 'products.view'] }),
  kitchen: sign({ userId: KITCH, branchId: W, permissionKeys: ['products.view'] }),
  cateTill: sign({ userId: CATE, branchId: W, permissionKeys: ['orders.create', 'products.view'], surface: 'desktop', pinSignIn: true }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, branchId: W, permissionKeys: ['*'], surface: 'desktop' }),
};
const activate = async (pump, token) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/pumps/${pump}/activate`, { method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body };
};
const status = (id) => mem.db.pumps.find((p) => p.id === id)?.status;

try {
  state._setPermissionsMigrated(true);

  console.log('\nR. the rule\n');
  await ok('a cashier (orders.create, no fuel.manage) on the web activates a pump of their branch', async () => {
    reset();
    const r = await activate(PW, T.cate);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(status(PW), 'dispensing');
  });
  await ok('a fuel.manage holder still may', async () => {
    reset();
    assert.equal((await activate(PW, T.fuel)).status, 200);
  });
  await ok('a pump of the whole business (no branch) is every branch\'s', async () => {
    reset();
    assert.equal((await activate(PALL, T.cate)).status, 200);
    assert.equal(status(PALL), 'dispensing');
  });
  await ok('another branch\'s pump is refused (403) and stays idle', async () => {
    reset();
    assert.equal((await activate(PK, T.cate)).status, 403);
    assert.equal(status(PK), 'idle');
  });
  await ok('another business\'s pump: not found (404)', async () => {
    reset();
    assert.equal((await activate(PX, T.cate)).status, 404);
    assert.equal(status(PX), 'idle');
  });
  await ok('no right to sell (the kitchen role) is refused (403)', async () => {
    reset();
    assert.equal((await activate(PW, T.kitchen)).status, 403);
    assert.equal(status(PW), 'idle');
  });
  await ok('an inactive pump is not activated (404)', async () => {
    reset();
    assert.equal((await activate(POFF, T.cate)).status, 404);
    assert.equal(status(POFF), 'inactive');
  });
  await ok('the web needs no licence check of its own (signing in to the web is the licence)', async () => {
    reset(false);
    assert.equal((await activate(PW, T.cate)).status, 200);
  });

  console.log('\nD. the desktop POS\n');
  await ok('a cashier\'s PIN sign-in on a desktop POS, with the online licence: activated', async () => {
    reset(true);
    const r = await activate(PW, T.cateTill);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(status(PW), 'dispensing');
  });
  await ok('without the online licence: 403 ONLINE_LICENCE_REQUIRED, the pump untouched', async () => {
    reset(false);
    const r = await activate(PW, T.cateTill);
    assert.equal(r.status, 403);
    assert.equal(r.body?.code, 'ONLINE_LICENCE_REQUIRED');
    assert.equal(status(PW), 'idle');
  });
  await ok('another branch\'s pump from the desktop: 403', async () => {
    reset(true);
    assert.equal((await activate(PK, T.cateTill)).status, 403);
    assert.equal(status(PK), 'idle');
  });
  await ok('the till\'s own token (no person) is refused by the terminal-write guard', async () => {
    reset(true);
    assert.equal((await activate(PW, T.till)).status, 403);
    assert.equal(status(PW), 'idle');
  });
  await ok('the allowlist: a person\'s sign-in only, and only /activate (not /idle, not a pump edit)', async () => {
    const G = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/terminalWrites.ts')).href);
    assert.equal(G.terminalWriteVerdict('desktop', 'PATCH', `/api/pumps/${PW}/activate`, true), 'manager');
    assert.equal(G.terminalWriteVerdict('desktop', 'PATCH', `/api/pumps/${PW}/activate`, false), 'denied');
    assert.equal(G.terminalWriteVerdict('desktop', 'PATCH', `/api/pumps/${PW}/idle`, true), 'denied');
    assert.equal(G.terminalWriteVerdict('desktop', 'PATCH', `/api/pumps/${PW}`, true), 'denied');
    assert.equal(G.terminalWriteVerdict('desktop', 'PATCH', `/api/pumps/${PW}/activate/x`, true), 'denied');
  });

  console.log('\nW. the wiring\n');
  await ok('desktop main: asks only with the licence, as the person (manageFetch), and never throws into the sale', async () => {
    const c = read('apps/desktop/src/main/ipc/catalogue.ts');
    const h = c.slice(c.indexOf("handle('pos:activatePump'"), c.indexOf("handle('pos:init'"));
    assert.match(h, /if \(getDeviceConfig\(\)\?\.web_pos_enabled !== true\) return \{ ok: false \};/);
    assert.match(h, /manageFetch\(`\/api\/pumps\/\$\{encodeURIComponent\(pumpId\)\}\/activate`, 'PATCH', \{\}\)/);
    assert.match(h, /catch \{\s+return \{ ok: false \};/);
    assert.match(read('apps/desktop/src/main/ipcSchemas.ts'), /'pos:activatePump':\s+\{ kind: 'string', min: 1 \}/);
  });
  await ok('the desktop sale screen asks when a fuel line goes on, with the licence, without waiting', async () => {
    const p = read('apps/desktop/src/renderer/pages/POSPage.tsx');
    const f = p.slice(p.indexOf('const addFuelLine'), p.indexOf('const addFuelLine') + 1400);
    assert.match(f, /if \(onlineLicence\) void posApi\.pos\.activatePump\(pump\.id\)\.catch\(\(\) => \{\}\);/);
  });
  await ok('the web POS calls the same route (now open to a cashier who sells)', async () => {
    assert.match(read('apps/dashboard/src/pages/pos/CashierScreen.tsx'), /posApi\.patch\(`\/api\/pumps\/\$\{pump\.id\}\/activate`, \{\}\)/);
  });
} finally {
  server.close();
  console.warn = warn; console.error = err;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
