// A537 — menus (Food, Soft drinks, Alcohol, Tea …) above the categories, the cloud's half; and the web POS's category
// panel wiring.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/menus-a537.test.mjs
//
// Owner, 2026-10-20: "the menu categories at the top, can we add them to the left like a hamburger, which can collapse,
// and it should start collapsed by default? … some restaurants have different menus — food menu, non-alcoholic drinks
// menu, alcoholic drinks menu, tea menu etc, can we include such?" — plain menus, one menu per category, the till and the
// web POS.
//
// RUNS the COMPILED server (routes/index.js behind the real requireAuth and requirePermission) over HTTP; the database in
// memory (tests/lib-memdb.mjs) — migration 155's SQL (table, set-null, RLS, triggers) is run for real in
// scripts/test-migration-155.mjs.
//
//   R  /api/menus: a person without menu.edit may list but not add, rename, reorder or delete (403); the owner may; a
//      name is cleaned (empty refused, a duplicate 409); another business's menu is never listed, renamed or deleted
//      (404); each menu says how many categories it holds; a delete is soft and leaves its categories with no menu.
//   K  a category's menu: PATCH / POST /api/categories take menu_id — this business's menu, or null; another business's
//      menu (or a deleted one, or junk) is refused "Menu not found"; a till's change (A448) naming such a menu is refused
//      for good, not sent again.
//   I  /api/pos/init carries the business's menus (on, not deleted, never another business's) and each category's menu_id.
//   C  /api/pos/changes: a renamed menu is ONE row (the menu as init sends it); switched off or deleted → a delete marker;
//      another business's menu named in an entry → a delete marker (nothing leaks).
//   W  the web POS: CashierScreen and MinimartPOS use the shared helper (lib/menuFilter.ts = shared/menuFilter.ts), the
//      panel starts collapsed and remembers the pin in try/catch; the back office has Menu › Menus and a Menu select.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
//   - routes/menus.ts POST without requirePermission('menu.edit')          → R "a cashier may not add" fails
//   - routes/menus.ts PATCH without .eq('business_id', …)                  → R "another business's menu: 404" fails
//   - lib/menus.ts menuIdForCategory without the business filter            → K "another business's menu refused" fails
//   - lib/menus.ts menusForPos without .eq('active', true)                  → I "only the on menus" fails
//   - syncChanges.ts menus without the active / deleted check                → C "switched off → a delete" fails
//   - changeApply.ts MENU_GONE answered with retry                           → K "refused for good" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/menus.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const SV = require(path.join(DIST, 'lib/syncVersions.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const PI = require(path.join(DIST, 'lib/posInit.js'));
const SC = require(path.join(DIST, 'lib/syncChanges.js'));
const CA = require(path.join(DIST, 'lib/changeApply.js'));
const warn = console.warn; console.warn = () => {};

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BRX = '44444444-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', CASHIER = 'aaaaaaaa-0000-4000-8000-000000000003';
const FOOD = 'cccccccc-0000-4000-8000-000000000001', DRINKS = 'cccccccc-0000-4000-8000-000000000002', OFF = 'cccccccc-0000-4000-8000-000000000003';
const GONE = 'cccccccc-0000-4000-8000-000000000004', THEIRS = 'cccccccc-0000-4000-8000-000000000009';
const perms = (...keys) => ({ name: 'Cashier', role_permissions: keys.map((key) => ({ permissions: { key } })) });

mem.rpc = async (name, a) => {
  if (name === 'sync_changes_since') {
    return { data: (mem.db.sync_changes ?? []).filter((c) => c.business_id === a.p_business && c.seq > a.p_since).slice(0, a.p_limit), error: null };
  }
  return { data: null, error: null };
};
let seq = 10;
const logChange = (biz, table_name, row_id, op = 'upsert') =>
  mem.db.sync_changes.push({ seq: ++seq, business_id: biz, branch_id: null, topic: 'menu', table_name, row_id, op, changed_at: new Date(Date.now() - 10_000).toISOString() });

const reset = () => {
  mem.fail = () => null; mem.calls = []; seq = 10;
  SV._resetSyncVersions(); AC._resetAuthCache(); PI._resetInitCache(); SC._resetSyncChanges();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Test Grill', type: 'restaurant', currency: 'KES', vat_rate: 16, ctl_rate: 0, status: 'active' },
      { id: B2, owner_id: 'x', name: 'Other', type: 'restaurant', currency: 'KES', vat_rate: 16, status: 'active' }],
    branches: [{ id: BR, business_id: B, name: 'Main', is_main: true, desktop_licensed: true },
      { id: BRX, business_id: B2, name: 'Theirs', is_main: true, desktop_licensed: true }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B, permissions_version: 0, roles: { name: 'Admin' }, user_branches: [], user_permissions: [] },
      { id: CASHIER, name: 'Wanjiru', status: 'active', business_id: B, permissions_version: 0, role_id: 'role-c', roles: perms('orders.create'), user_branches: [{ branch_id: BR }], user_permissions: [] }],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER }],
    sync_versions: [{ business_id: B, topic: 'catalogue', version: 7 }, { business_id: B2, topic: 'catalogue', version: 3 }],
    menus: [
      { id: FOOD, business_id: B, name: 'Food', sort_order: 1, active: true, color: null, icon: '🍔', deleted_at: null },
      { id: DRINKS, business_id: B, name: 'Soft drinks', sort_order: 2, active: true, color: null, icon: null, deleted_at: null },
      { id: OFF, business_id: B, name: 'Shisha', sort_order: 3, active: false, color: null, icon: null, deleted_at: null },
      { id: GONE, business_id: B, name: 'Old', sort_order: 4, active: false, color: null, icon: null, deleted_at: '2026-10-01T00:00:00Z' },
      { id: THEIRS, business_id: B2, name: 'Their menu', sort_order: 1, active: true, color: null, icon: null, deleted_at: null },
    ],
    categories: [
      { id: 'cat-burgers', business_id: B, name: 'Burgers', status: 'active', sort_order: 1, menu_id: FOOD },
      { id: 'cat-sodas', business_id: B, name: 'Sodas', status: 'active', sort_order: 2, menu_id: DRINKS },
      { id: 'cat-juice', business_id: B, name: 'Juice', status: 'active', sort_order: 3, menu_id: DRINKS },
      { id: 'cat-misc', business_id: B, name: 'Misc', status: 'active', sort_order: 4, menu_id: null },
      { id: 'cat-theirs', business_id: B2, name: 'Theirs', status: 'active', sort_order: 1, menu_id: THEIRS },
    ],
    products: [{ id: 'p-1', business_id: B, name: 'Fries', base_price: 150, status: 'active', is_combo: false, category_id: 'cat-burgers' }],
    branch_prices: [], tables: [], business_settings: [], branch_settings: [], feature_flags: [], business_branding: [],
    payment_methods: [], offers: [], promotions: [], stock_takes: [], variant_groups: [], modifier_groups: [], combo_items: [],
    sync_changes: [], sync_change_floor: [{ id: 1, floor_seq: 0 }], change_requests: [],
    refresh_tokens: [], audit_log: [], notifications: [], admin_users: [], ops_events: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  cashier: sign({ userId: CASHIER, permissionKeys: ['orders.create'], surface: 'dashboard' }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const menu = (id) => mem.db.menus.find((m) => m.id === id);
const catMenu = (id) => mem.db.categories.find((c) => c.id === id)?.menu_id ?? null;

try {
  state._setPermissionsMigrated(true);
  console.log('\nR. /api/menus\n');
  await ok('the list: this business\'s menus not deleted, in order, each with how many categories it holds', async () => {
    reset();
    const r = await call('GET', '/api/menus', T.cashier);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.map((m) => m.name), ['Food', 'Soft drinks', 'Shisha']);
    assert.deepEqual(r.body.map((m) => m.category_count), [1, 2, 0]);
    assert.ok(!r.body.some((m) => m.id === THEIRS || m.id === GONE));
  });
  await ok('a person without menu.edit may not add, rename, reorder or delete (403)', async () => {
    reset();
    assert.equal((await call('POST', '/api/menus', T.cashier, { name: 'Tea' })).status, 403);
    assert.equal((await call('PATCH', `/api/menus/${FOOD}`, T.cashier, { name: 'Grub' })).status, 403);
    assert.equal((await call('POST', '/api/menus/reorder', T.cashier, { ids: [DRINKS, FOOD] })).status, 403);
    assert.equal((await call('DELETE', `/api/menus/${FOOD}`, T.cashier)).status, 403);
    assert.equal(menu(FOOD).name, 'Food'); assert.equal(mem.db.menus.length, 5);
  });
  await ok('the owner adds one (cleaned name, after the last), renames, switches off; an empty name 400, a duplicate 409', async () => {
    reset();
    const r = await call('POST', '/api/menus', T.owner, { name: '  Tea   menu ', icon: '🍵' });
    assert.equal(r.status, 201, r.text);
    const tea = mem.db.menus.find((m) => m.name === 'Tea menu');
    assert.ok(tea); assert.equal(tea.business_id, B); assert.equal(tea.sort_order, 4);   // after the last not deleted (Shisha, 3) assert.equal(tea.icon, '🍵');
    assert.equal((await call('POST', '/api/menus', T.owner, { name: '   ' })).status, 400);
    assert.equal((await call('POST', '/api/menus', T.owner, { name: 'X', color: 'red' })).status, 400);
    mem.fail = (t, op) => (t === 'menus' && op === 'insert' ? { code: '23505', message: 'duplicate key value violates unique constraint "menus_business_name"' } : null);
    const dup = await call('POST', '/api/menus', T.owner, { name: 'Food' });
    assert.equal(dup.status, 409); assert.match(dup.body.error, /already exists/);
    mem.fail = () => null;
    assert.equal((await call('PATCH', `/api/menus/${FOOD}`, T.owner, { name: 'Food menu' })).status, 200);
    assert.equal(menu(FOOD).name, 'Food menu');
    assert.equal((await call('PATCH', `/api/menus/${FOOD}`, T.owner, { active: false })).status, 200);
    assert.equal(menu(FOOD).active, false);
    assert.equal((await call('PATCH', `/api/menus/${FOOD}`, T.owner, { active: 'no' })).status, 400);
  });
  await ok('another business\'s menu: never renamed, reordered or deleted (404 / ignored)', async () => {
    reset();
    assert.equal((await call('PATCH', `/api/menus/${THEIRS}`, T.owner, { name: 'Mine now' })).status, 404);
    assert.equal(menu(THEIRS).name, 'Their menu');
    assert.equal((await call('DELETE', `/api/menus/${THEIRS}`, T.owner)).status, 404);
    assert.equal(menu(THEIRS).deleted_at, null);
    await call('POST', '/api/menus/reorder', T.owner, { ids: [THEIRS, DRINKS, FOOD] });
    assert.equal(menu(THEIRS).sort_order, 1);
    assert.equal(menu(DRINKS).sort_order, 1); assert.equal(menu(FOOD).sort_order, 2);
  });
  await ok('a delete is soft (deleted_at, off) and leaves its categories with no menu', async () => {
    reset();
    assert.equal((await call('DELETE', `/api/menus/${DRINKS}`, T.owner)).status, 204);
    assert.ok(menu(DRINKS).deleted_at); assert.equal(menu(DRINKS).active, false);
    assert.equal(catMenu('cat-sodas'), null); assert.equal(catMenu('cat-juice'), null); assert.equal(catMenu('cat-burgers'), FOOD);
    assert.equal(catMenu('cat-theirs'), THEIRS);
  });

  console.log('\nK. a category\'s menu\n');
  await ok('PATCH /api/categories: this business\'s menu, or null', async () => {
    reset();
    assert.equal((await call('PATCH', '/api/categories/cat-misc', T.owner, { menu_id: FOOD })).status, 200);
    assert.equal(catMenu('cat-misc'), FOOD);
    assert.equal((await call('PATCH', '/api/categories/cat-misc', T.owner, { menu_id: null })).status, 200);
    assert.equal(catMenu('cat-misc'), null);
  });
  await ok('another business\'s menu, a deleted one, or junk: refused "Menu not found" — nothing changes', async () => {
    reset();
    for (const v of [THEIRS, GONE]) {
      const r = await call('PATCH', '/api/categories/cat-misc', T.owner, { menu_id: v });
      assert.equal(r.status, 400); assert.match(r.body.error, /Menu not found/);
    }
    assert.equal((await call('PATCH', '/api/categories/cat-misc', T.owner, { menu_id: 'x; drop' })).status, 400);
    assert.equal((await call('POST', '/api/categories', T.owner, { name: 'Tea', menu_id: THEIRS })).status, 400);
    assert.equal(catMenu('cat-misc'), null);
    const r = await call('POST', '/api/categories', T.owner, { name: 'Tea', menu_id: DRINKS });
    assert.equal(r.status, 201, r.text); assert.equal(r.body.menu_id, DRINKS);
  });
  await ok('a till\'s change naming another business\'s menu: refused for good (recorded, not sent again)', async () => {
    reset();
    const ctx = { businessId: B, branchId: BR, deviceId: 'dev-T1', callerKeys: ['*'], callerIsOwner: true, callerUserId: OWNER };
    const res = await CA.applyChange(ctx, { id: 'dddddddd-0000-4000-8000-000000000001', entity: 'category', op: 'update', entity_id: 'cat-misc',
      base: { menu_id: null }, data: { menu_id: THEIRS }, made_by: OWNER, made_by_name: 'Owner', made_at: new Date().toISOString() });
    assert.equal(res.status, 'refused'); assert.equal(res.message, CA.MENU_GONE); assert.ok(!res.retry, 'not retried');
    assert.equal(catMenu('cat-misc'), null);
  });

  console.log('\nI. /api/pos/init\n');
  await ok('init carries the business\'s on menus (not off, not deleted, not another business\'s) and each category\'s menu_id', async () => {
    reset();
    const r = await call('GET', `/api/pos/init?branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(r.body.menus.map((m) => m.id), [FOOD, DRINKS]);
    assert.equal(r.body.categories.find((c) => c.id === 'cat-sodas').menu_id, DRINKS);
  });
  await ok('before migration 155 (no menus table): init still answers, with menus []', async () => {
    reset(); PI._resetInitCache();
    mem.fail = (t) => (t === 'menus' ? { code: '42P01', message: 'relation "public.menus" does not exist' } : null);
    const r = await call('GET', `/api/pos/init?branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200); assert.deepEqual(r.body.menus, []);
    assert.deepEqual((await call('GET', '/api/menus', T.owner)).body, []);
  });

  console.log('\nC. /api/pos/changes\n');
  await ok('a renamed menu is ONE row (the menu as init sends it, no deleted_at)', async () => {
    reset();
    menu(FOOD).name = 'Food menu'; logChange(B, 'menus', FOOD);
    const r = await call('GET', `/api/pos/changes?since=10&branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.changes.length, 1);
    const e = r.body.changes[0];
    assert.equal(e.table, 'menus'); assert.equal(e.op, 'upsert'); assert.equal(e.row.name, 'Food menu'); assert.equal(e.topic, 'menu');
    assert.ok(!('deleted_at' in e.row) && !('business_id' in e.row));
  });
  await ok('switched off, deleted, or another business\'s → a delete marker (nothing leaks)', async () => {
    reset();
    logChange(B, 'menus', OFF); logChange(B, 'menus', GONE); logChange(B, 'menus', THEIRS);
    const r = await call('GET', `/api/pos/changes?since=10&branch_id=${BR}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.deepEqual(r.body.changes.map((c) => `${c.id}:${c.op}`), [`${OFF}:delete`, `${GONE}:delete`, `${THEIRS}:delete`]);
    assert.ok(!JSON.stringify(r.body).includes('Their menu'));
  });

  console.log('\nW. the web POS and the back office\n');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const cashier = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  const mini = read('apps/dashboard/src/pages/pos/MinimartPOS.tsx');
  const panel = read('apps/dashboard/src/pages/pos/cashier/CategoryPanel.tsx');
  await ok('the web POS uses the shared helper (an identical copy of shared/menuFilter.ts) in CashierScreen and MinimartPOS', async () => {
    assert.equal(read('apps/dashboard/src/lib/menuFilter.ts'), read('shared/menuFilter.ts'));
    for (const [n, s] of [['CashierScreen', cashier], ['MinimartPOS', mini]]) {
      assert.match(s, /from '\.\.\/\.\.\/lib\/menuFilter'/, n);
      assert.match(s, /const menuFilterScope = useMemo\(\(\) => menuScope\(categories, menus, activeMenu\)/, n);
      assert.match(s, /inMenuScope\(p, menuFilterScope\)/, n);
      assert.match(s, /<PanelToggle panel=\{catPanel\} \/>/, n);
      assert.match(s, /<CategoryPanel panel=\{catPanel\}[\s\S]{0,300}overlay=\{isPhone\} \/>/, n);
      assert.match(s, /<CategoryChip label=\{catChip\} onClear=\{clearCatChip\} \/>/, n);
      assert.doesNotMatch(s, /s\.catRow|s\.catBtn/, `${n}: the old category row is gone`);
    }
    assert.match(cashier, /menus=\{menus\}/);
  });
  await ok('the panel starts collapsed (open only when pinned) and remembers the pin and menu in this browser, in try/catch', async () => {
    assert.match(panel, /useState<boolean>\(\(\) => panelStartsOpen\(readPrefs\(\)\)\)/);
    assert.match(panel, /try \{ return parsePanelPrefs\(window\.localStorage\.getItem\(PANEL_PREFS_KEY\)\); \} catch/);
    assert.match(panel, /try \{ window\.localStorage\.setItem\(PANEL_PREFS_KEY, panelPrefsText\(p\)\); \} catch/);
    assert.match(panel, /const picked = useCallback\(\(\) => setOpen\(panelOpenAfterPick\(prefs\)\)/);
    assert.match(panel, /minHeight: 44/);   // touch-sized rows
    const M = await import(new URL('../shared/menuFilter.ts', import.meta.url).href);
    assert.equal(M.panelStartsOpen(M.parsePanelPrefs(null)), false);
  });
  await ok('the back office: Menu › Menus next to Categories (its route), and a Menu select on each category', async () => {
    const layout = read('apps/dashboard/src/components/DashboardLayout.tsx');
    assert.match(layout, /\{ to: '\/dashboard\/menus',\s+label: 'Menus',\s+icon: 'menu' \},\s*\{ to: '\/dashboard\/categories'/);
    assert.match(read('apps/dashboard/src/App.tsx'), /<Route path="menus"\s+element=\{<MenusPage \/>\} \/>/);
    const cats = read('apps/dashboard/src/pages/products/CategoriesPage.tsx');
    assert.match(cats, /<option value="">No menu<\/option>/);
    assert.match(cats, /api\.patch\(`\/api\/categories\/\$\{cat\.id\}`, \{ menu_id: menuId \|\| null \}\)/);
    const page = read('apps/dashboard/src/pages/products/MenusPage.tsx');
    for (const call of [`api.post('/api/menus'`, 'api.patch(`/api/menus/${m.id}`', `api.post('/api/menus/reorder'`, 'api.delete(`/api/menus/${m.id}`)']) assert.ok(page.includes(call), call);
  });
} finally {
  server.close();
  console.warn = warn;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
