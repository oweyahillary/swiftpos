// A537 (2026-10-20) — the till's categories in a collapsible left panel, and menus (Food, Soft drinks, Alcohol, Tea …)
// above the categories.
//
// Owner: "the menu categories at the top, can we add them to the left like a hamburger, which can collapse, and it should
// start collapsed by default? … some restaurants have different menus — food menu, non-alcoholic drinks menu, alcoholic
// drinks menu, tea menu etc, can we include such?" — both the till and the web POS; plain menus; one menu per category.
//
// Drives the REAL compiled dist/main (localDb's migration, syncEngine's whole pull and applyChangeEntries, the branch
// server's reference bundle) on a REAL SQLite file, electron shimmed, against a stand-in cloud on a real port; runs the
// shared panel helper (src/shared/menuFilter.ts — the web POS runs the same file); pins the sale screen's wiring.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/menus-a537.test.mjs
//
//   1  local schema 73: the menus table and categories.menu_id (and REQUIRED_DESKTOP_SCHEMA moves with it).
//   2  the whole pull stores the menus (on ones only) and each category's menu; an older cloud (no menus, no menu_id)
//      leaves what the till has.
//   3  a change from /api/pos/changes: a renamed menu is that one row, a delete takes it away, a category moved between
//      menus is its own row.
//   4  the branch server relays menus and menu_id to its peers; an older server's bundle leaves the peer's menus.
//   5  the panel helper: no menus → every category (the plain list, no tabs); a menu → its categories and only their
//      products; categories with no menu under All menus and Other; a menu switched off → its categories under Other.
//   6  collapsed by default; the pin and the chosen menu remembered (parse / text round trip, junk → the default).
//   7  the sale screen: ☰ by the search, the panel beside (or over) the grid, the chip, the menu narrowing the grid;
//      Manager › Menu puts a category under a menu (a till change, A448, menu_id cleaned).
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
//   - syncEngine writeCategories always writing menu_id (no has_menu keep)      → 2 "an older cloud leaves the menu" fails
//   - syncEngine writeMenus storing a menu with active false                     → 2 "only the on menus" fails
//   - applyChangeEntries without the 'menus' case                                → 3 "a renamed menu" fails
//   - menuFilter menuOfCategory not checking the menu is live                    → 5 "switched off → Other" fails
//   - menuFilter parsePanelPrefs taking pinned from any truthy value             → 6 "junk is the default" fails
//   - CategoryPanel useState(true) for open                                      → 7 "starts collapsed" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a537-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, session: { fromPartition: () => ({}) }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (req === 'electron') return shim; return orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

// ── The stand-in cloud ───────────────────────────────────────────────────────────────────────────────────────────────
const BR = 'br-1';
const cloud = { init: null };
const cat = (id, name, menu_id) => ({ id, name, color: '#f97316', icon: null, sort_order: 1, status: 'active', is_kitchen: false, ...(menu_id === undefined ? {} : { menu_id }) });
const FOOD = 'm-food', DRINKS = 'm-drinks', OFF = 'm-off';
const initWith = (extra) => ({ products: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
  vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'restaurant', businessName: 'Test Grill', currency: 'KES', ...extra });
cloud.init = initWith({
  categories: [cat('c-burgers', 'Burgers', FOOD), cat('c-sodas', 'Sodas', DRINKS), cat('c-misc', 'Misc', null)],
  menus: [{ id: FOOD, name: 'Food', sort_order: 1, active: true, color: null, icon: '🍔' },
          { id: DRINKS, name: 'Soft drinks', sort_order: 2, active: true, color: null, icon: null },
          { id: OFF, name: 'Shisha', sort_order: 3, active: false, color: null, icon: null }],
});
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'x-zaptill-server': '1' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/api/pos/init') return send(200, cloud.init);
  if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff: [] });
  if (/\/api\/(inventory|tables|pumps|stations|staff)/.test(u.pathname)) return send(200, []);
  return send(200, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const CLOUD = `http://127.0.0.1:${srv.address().port}`;

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-T1', 'biz-1', 'Test Grill', '2026-10-20T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const RB = require(path.join(dist, 'referenceBundle.js'));
const menus = () => db.prepare(`SELECT id, name, sort_order, active, icon FROM menus ORDER BY sort_order`).all();
const menuOf = (id) => db.prepare(`SELECT menu_id FROM categories WHERE id = ?`).get(id)?.menu_id ?? null;
const M = await import(pathToFileURL(path.join(here, '..', 'src', 'shared', 'menuFilter.ts')).href);

console.log('A537 — the category panel and menus on the till\n');
try {
  // ── 1 ──
  const cols = db.prepare(`PRAGMA table_info(categories)`).all().map((c) => c.name);
  const mcols = db.prepare(`PRAGMA table_info(menus)`).all().map((c) => c.name);
  const required = Number((fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'lib', 'desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
  ok('local schema 73: menus (id, name, sort_order, active, color, icon) and categories.menu_id; REQUIRED moves with it',
    L.LOCAL_SCHEMA_VERSION >= 73 && L.getLocalSchemaVersion() === L.LOCAL_SCHEMA_VERSION && cols.includes('menu_id')
    && ['id', 'name', 'sort_order', 'active', 'color', 'icon'].every((c) => mcols.includes(c)) && required === L.LOCAL_SCHEMA_VERSION,
    JSON.stringify({ v: L.LOCAL_SCHEMA_VERSION, cols, mcols, required }));

  // ── 2 ──
  const r = await E.pullCatalogueNow();
  ok('the whole pull stores the menus — only the on ones, in order', r.pulled === true
    && JSON.stringify(menus().map((m) => m.id)) === JSON.stringify([FOOD, DRINKS]) && menus()[0].icon === '🍔', JSON.stringify({ r, m: menus() }));
  ok('…and each category\'s menu (none = null)', menuOf('c-burgers') === FOOD && menuOf('c-sodas') === DRINKS && menuOf('c-misc') === null);
  cloud.init = initWith({ categories: [cat('c-burgers', 'Burgers'), cat('c-sodas', 'Sodas'), cat('c-misc', 'Misc')] });   // an older cloud
  await E.pullCatalogueNow();
  ok('an older cloud (no menus, categories without menu_id): the till keeps its menus and each category\'s menu',
    menus().length === 2 && menuOf('c-burgers') === FOOD && menuOf('c-sodas') === DRINKS, JSON.stringify({ m: menus(), b: menuOf('c-burgers') }));
  cloud.init = initWith({ categories: [cat('c-burgers', 'Burgers', FOOD), cat('c-sodas', 'Sodas', null), cat('c-misc', 'Misc', null)],
    menus: [{ id: FOOD, name: 'Food', sort_order: 1, active: true }] });
  await E.pullCatalogueNow();
  ok('a whole pull replaces the menus (Soft drinks gone upstream → gone here) and a category taken out of its menu',
    JSON.stringify(menus().map((m) => m.id)) === JSON.stringify([FOOD]) && menuOf('c-sodas') === null, JSON.stringify(menus()));

  // ── 3 ──
  const before = db.prepare(`SELECT id, synced_at FROM menus`).all();
  E.applyChangeEntries([{ seq: 1, topic: 'menu', table: 'menus', id: DRINKS, op: 'upsert', row: { id: DRINKS, name: 'Soft drinks', sort_order: 2, active: true, color: null, icon: '🥤' } }]);
  ok('a change: a new menu is that one row (the other untouched)', menus().length === 2 && menus()[1].icon === '🥤'
    && db.prepare(`SELECT synced_at FROM menus WHERE id = ?`).get(FOOD).synced_at === before.find((b) => b.id === FOOD).synced_at);
  E.applyChangeEntries([{ seq: 2, topic: 'menu', table: 'menus', id: FOOD, op: 'upsert', row: { id: FOOD, name: 'Food menu', sort_order: 1, active: true, color: null, icon: null } }]);
  ok('…a renamed menu: its row renamed', menus()[0].name === 'Food menu');
  E.applyChangeEntries([{ seq: 3, topic: 'menu', table: 'categories', id: 'c-sodas', op: 'upsert', row: cat('c-sodas', 'Sodas', DRINKS) }]);
  ok('…a category moved into a menu: its own row', menuOf('c-sodas') === DRINKS && menuOf('c-burgers') === FOOD);
  E.applyChangeEntries([{ seq: 4, topic: 'menu', table: 'menus', id: DRINKS, op: 'delete' }]);
  ok('…a delete (switched off or deleted on the cloud): the menu is gone', menus().length === 1 && menus()[0].id === FOOD);

  // ── 4 ──
  E.applyChangeEntries([{ seq: 5, topic: 'menu', table: 'menus', id: DRINKS, op: 'upsert', row: { id: DRINKS, name: 'Soft drinks', sort_order: 2, active: true } }]);
  const bundle = RB.buildReferenceBundle(db, DC.getDeviceConfig());
  ok('the branch server relays the menus and each category\'s menu to its tills',
    bundle.posInit.menus?.length === 2 && bundle.posInit.categories.find((c) => c.id === 'c-sodas')?.menu_id === DRINKS,
    JSON.stringify(bundle.posInit.menus));
  const unpacked = RB.unpackNodeBundle(bundle);
  const old = RB.unpackNodeBundle({ ...bundle, posInit: { ...bundle.posInit, menus: undefined } });
  ok('…a peer takes them; an older server\'s bundle (no menus) leaves the peer\'s own (null = not sent)',
    unpacked.menus?.length === 2 && old.menus === null);

  // ── 5 ──
  const C = [{ id: 'b', name: 'Burgers', menu_id: 'food' }, { id: 's', name: 'Sodas', menu_id: 'drinks' }, { id: 't', name: 'Tusker', menu_id: 'beer' },
    { id: 'x', name: 'Extras', menu_id: null }];
  const MS = [{ id: 'drinks', name: 'Soft drinks', sort_order: 2, active: true }, { id: 'food', name: 'Food', sort_order: 1, active: true },
    { id: 'beer', name: 'Alcohol', sort_order: 3, active: false }, { id: 'tea', name: 'Tea', sort_order: 4, active: true }];
  const P = [{ id: 'p1', category_id: 'b' }, { id: 'p2', category_id: 's' }, { id: 'p3', category_id: 't' }, { id: 'p4', category_id: 'x' }, { id: 'p5', category_id: null }];
  const shown = (menu) => P.filter((p) => M.inMenuScope(p, M.menuScope(C, MS, menu))).map((p) => p.id).join(',');
  ok('no menus: no tabs, the plain list of every category, every product', M.menuTabs([], C).length === 0
    && M.categoriesForMenu(C, [], 'food').length === 4 && M.categoryGroups(C, [], 'all').length === 1
    && M.categoryGroups(C, [], 'all')[0].menu === null && shown('all') === 'p1,p2,p3,p4,p5' && M.menuScope(C, [], 'food') === null);
  ok('menus: tabs All menus, then each menu that holds a category in order (Tea holds none, Alcohol is off), then Other',
    JSON.stringify(M.menuTabs(MS, C).map((t) => t.name)) === JSON.stringify(['All menus', 'Food', 'Soft drinks', 'Other']));
  ok('a menu chosen: only its categories in the list, only their products on the grid',
    M.categoriesForMenu(C, MS, 'food').map((c) => c.id).join() === 'b' && shown('food') === 'p1' && shown('drinks') === 'p2');
  ok('Other: the categories with no menu AND those whose menu is off — and the products with no category',
    M.categoriesForMenu(C, MS, 'other').map((c) => c.id).join() === 't,x' && shown('other') === 'p3,p4,p5');
  ok('All menus: every category, grouped under each menu, Other last; every product',
    M.categoryGroups(C, MS, 'all').map((g) => `${g.menu.name}:${g.categories.map((c) => c.id).join('')}`).join(' ') === 'Food:b Soft drinks:s Other:tx'
    && shown('all') === 'p1,p2,p3,p4,p5');
  ok('a remembered menu that is gone → All menus; a category the menu does not hold → All',
    M.resolveMenu('tea', M.menuTabs(MS, C)) === 'all' && M.resolveMenu('drinks', M.menuTabs(MS, C)) === 'drinks'
    && M.resolveCategory('b', M.categoriesForMenu(C, MS, 'drinks')) === 'all' && M.resolveCategory('s', M.categoriesForMenu(C, MS, 'drinks')) === 's');

  // ── 6 ──
  ok('collapsed by default: nothing stored → not pinned, All menus, the panel closed at start and after a pick',
    M.parsePanelPrefs(null).pinned === false && M.parsePanelPrefs(undefined).menu === 'all'
    && M.panelStartsOpen(M.parsePanelPrefs(null)) === false && M.panelOpenAfterPick(M.DEFAULT_PANEL_PREFS) === false);
  const stored = M.panelPrefsText({ pinned: true, menu: 'drinks' });
  ok('pinned: remembered (text round trip), open at start and stays open after a pick',
    M.parsePanelPrefs(stored).pinned === true && M.parsePanelPrefs(stored).menu === 'drinks'
    && M.panelStartsOpen(M.parsePanelPrefs(stored)) && M.panelOpenAfterPick(M.parsePanelPrefs(stored)));
  ok('junk in storage is the default (bad JSON, a string "true", a long menu id)',
    M.parsePanelPrefs('{oops').pinned === false && M.parsePanelPrefs('{"pinned":"true"}').pinned === false
    && M.parsePanelPrefs(JSON.stringify({ pinned: 1, menu: 'x'.repeat(200) })).menu === 'all');

  // ── 7 ──
  const panel = src('renderer/components/CategoryPanel.tsx');
  const pos = src('renderer/pages/POSPage.tsx');
  ok('the panel starts collapsed (open only when pinned) and remembers on this till — every storage access in try/catch',
    /useState<boolean>\(\(\) => panelStartsOpen\(readPrefs\(\)\)\)/.test(panel)
    && /try \{ return parsePanelPrefs\(window\.localStorage\.getItem\(PANEL_PREFS_KEY\)\); \} catch/.test(panel)
    && /try \{ window\.localStorage\.setItem\(PANEL_PREFS_KEY, panelPrefsText\(p\)\); \} catch/.test(panel)
    && /const picked = useCallback\(\(\) => setOpen\(panelOpenAfterPick\(prefs\)\)/.test(panel));
  ok('touch first: 48 px rows, 40+ px pin / close / tabs, nothing on hover only (the panel uses the action colours)',
    /min-h-\[48px\]/.test(panel) && (panel.match(/min-h-\[40px\]/g) || []).length >= 3 && /bg-action-500/.test(panel) && !/onMouseEnter|onMouseOver/.test(panel));
  ok('the sale screen: ☰ before the search, the chip after it; the old category row is gone',
    /<PanelToggle panel=\{catPanel\} \/>\s*<input\s+type="text"\s+placeholder="Search products…"/.test(pos)
    && /<CategoryChip label=\{gridFilter\.categoryName\} onClear=\{clearCatChip\} \/>/.test(pos)
    && !/border-b border-gray-800 overflow-x-auto/.test(pos) && !/categories\.map\(\(cat: any\) => \(/.test(pos));
  ok('…the panel beside the grid (over it in a narrow window), and the menu narrows the grid (the shared helper)',
    /<CategoryPanel panel=\{catPanel\}[\s\S]{0,300}overlay=\{narrowWindow\} \/>\s*<div ref=\{grid\.rootRef\} className="flex-1 overflow-y-auto p-4">/.test(pos)
    && /const menuFilterScope = useMemo\(\(\) => menuScope\(categories, menus, activeMenu\)/.test(pos)
    && /const matchMenu\s+= inMenuScope\(p, menuFilterScope\);/.test(pos) && /&& matchCat && matchMenu && matchSearch/.test(pos)
    && /from '\.\.\/\.\.\/shared\/menuFilter'/.test(pos));
  ok('pos:init gives the sale screen the menus (on, in order; none before schema 73)',
    /SELECT id, name, sort_order, color, icon FROM menus WHERE active = 1 ORDER BY sort_order, name/.test(src('main/ipcHandlers.ts'))
    && /menus: mn, branchId/.test(pos));
  const manage = src('renderer/pages/ManageTabs.tsx');
  const TC = await import(pathToFileURL(path.join(here, '..', 'src', 'shared', 'tillChanges.ts')).href);
  const good = TC.cleanChange({ id: '11111111-1111-4111-8111-111111111111', entity: 'category', op: 'update', entity_id: '22222222-2222-4222-8222-222222222222',
    data: { menu_id: '33333333-3333-4333-8333-333333333333' } });
  const bad = TC.cleanChange({ id: '11111111-1111-4111-8111-111111111111', entity: 'category', op: 'update', entity_id: '22222222-2222-4222-8222-222222222222',
    data: { menu_id: 'drop table' } });
  ok('Manager › Menu: a category is put under a menu (a till change, A448 — menu_id a clean id or null)',
    /updateCategory\(c\.id, \{ menu_id: menuId \|\| null \}\)/.test(manage) && good.ok && good.change.data.menu_id === '33333333-3333-4333-8333-333333333333'
    && !bad.ok && /menu_id = @menu_id|menu_id: d\.menu_id === undefined \? undefined/.test(src('main/localChanges.ts')));
} finally {
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
