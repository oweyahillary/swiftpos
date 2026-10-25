// A578 (2026-10-23) — menus by time of day on the till (Breakfast Mon–Fri 06:00–11:00, Lunch 11:00–16:00, a shop's
// alcohol department only in licensed hours …).
//
// Owner (approved 2026-10-23): each menu may carry optional days and time windows; no schedule = always. And: "let us not
// forget other business in the tills all this changes should also be taking shape on them based on how they operate" —
// a restaurant's Breakfast / Lunch / Happy hour tabs (and the tables → order flow, the same grid), a shop's Departments
// with hours (an out-of-hours department's item REFUSED when scanned, in plain words), a petrol station's shop groups
// (fuel never touched), parking / other Groups.
//
// Drives the REAL compiled dist/main (localDb's migration, syncEngine's whole pull and applyChangeEntries, the branch
// server's reference bundle, the pos:init handler) on a REAL SQLite file with a stand-in cloud; runs the shared helper
// (src/shared/menuHours.ts — the web POS runs the same file) with the till's menu bar (src/shared/menuFilter.ts and the
// till's MenuBar, bundled with esbuild and rendered with react-dom/server); pins the sale screen's wiring (POSPage is one
// 2,400-line component — its filter, refusals and timer are read from the source).
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/menu-hours-a578.test.mjs
//
//   1  local schema 76: menus.availability; REQUIRED_DESKTOP_SCHEMA moves with it.
//   2  sync: the whole pull stores each menu's hours; an older cloud (no availability) leaves none (always); a change
//      takes the new hours and clears them; the branch server relays them to its tills; pos:init hands the sale screen
//      the hours (as the object) and the business day's end.
//   3  the bar at 08:00 vs 13:00: an out-of-window menu is hidden from the top tabs (and its categories from the panel);
//      the hint "until 11:00"; Show all brings everything back, with "from 11:00".
//   4  the timer: the next change (not a poll), clamped to an hour; the hook sets ONE timeout at it, never an interval.
//   5  per mode — restaurant, retail (the scan refused), petrol (fuel never), parking / other.
//   6  the sale screen's wiring: the filter, the refusals first in addSimple (the scanner's path) and handleTap, Show all
//      only with menu.edit.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A578 report):
//   - writeMenus not storing availability                                     → 2 "the whole pull stores the hours" fails
//   - pos:init not parsing the hours                                          → 2 "pos:init hands the sale screen the hours" fails
//   - referenceBundle dropping availability                                   → 2 "the branch server relays the hours" fails
//   - menuHoursView not leaving the asleep menu out                           → 3 "at 13:00 Breakfast is gone" fails
//   - addSimple without refuseOutOfHours                                      → 5 "retail: the scanner's path refuses" fails
//   - itemAsleep not excusing fuel                                            → 5 "petrol: fuel never" fails
//   - useMenuHours polling with setInterval                                   → 4 "one timeout, never an interval" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a578-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
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
const BREAKFAST = { days: [1, 2, 3, 4, 5], windows: [{ start: '06:00', end: '11:00' }] };
const LUNCH = { days: null, windows: [{ start: '11:00', end: '16:00' }] };
const cat = (id, name, menu_id) => ({ id, name, color: '#f97316', icon: null, sort_order: 1, status: 'active', is_kitchen: false, menu_id });
const initWith = (extra) => ({ products: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
  vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'restaurant', businessName: 'Test Grill', currency: 'KES', ...extra });
const cloud = { init: initWith({
  categories: [cat('c-eggs', 'Eggs', 'm-bf'), cat('c-mains', 'Mains', 'm-lunch'), cat('c-sodas', 'Sodas', 'm-drinks')],
  menus: [{ id: 'm-bf', name: 'Breakfast', sort_order: 1, active: true, availability: BREAKFAST },
          { id: 'm-lunch', name: 'Lunch', sort_order: 2, active: true, availability: LUNCH },
          { id: 'm-drinks', name: 'Drinks', sort_order: 3, active: true, availability: null }],
}) };
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
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-T1', 'biz-1', 'Test Grill', '2026-10-23T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const RB = require(path.join(dist, 'referenceBundle.js'));
const hoursOf = (id) => db.prepare(`SELECT availability FROM menus WHERE id = ?`).get(id)?.availability ?? null;

const H = await import(pathToFileURL(path.join(desktop, 'src', 'shared', 'menuHours.ts')).href);
const M = await import(pathToFileURL(path.join(desktop, 'src', 'shared', 'menuFilter.ts')).href);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const bundleDir = fs.mkdtempSync(path.join(desktop, 'node_modules', '.a578-'));
const bundle = (entry, out) => {
  require('esbuild').buildSync({ entryPoints: [path.join(desktop, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'] });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};

const at = (s) => new Date(s);   // the till's local clock (Kenya), as the sale screen reads it
const FRI_0800 = at('2026-10-23T08:00:00'), FRI_1300 = at('2026-10-23T13:00:00');

console.log('A578 — menus by time of day on the till\n');
try {
  // ── 1 ──
  {
    const cols = db.prepare(`PRAGMA table_info(menus)`).all().map((c) => c.name);
    const required = Number((fs.readFileSync(path.join(desktop, '..', 'server', 'src', 'lib', 'desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
    ok('local schema 76: menus.availability; REQUIRED_DESKTOP_SCHEMA moves with it',
      L.LOCAL_SCHEMA_VERSION >= 76 && cols.includes('availability') && required === L.LOCAL_SCHEMA_VERSION, JSON.stringify({ v: L.LOCAL_SCHEMA_VERSION, cols, required }));
  }

  // ── 2 ──
  {
    const r = await E.pullCatalogueNow();
    ok('the whole pull stores the hours of each menu (JSON), none = NULL (always)', r.pulled === true
      && JSON.stringify(JSON.parse(hoursOf('m-bf'))) === JSON.stringify(BREAKFAST) && hoursOf('m-drinks') === null, JSON.stringify({ r, bf: hoursOf('m-bf') }));
    const reg = {};
    require(path.join(dist, 'ipc', 'catalogue.js')).registerCatalogueHandlers({ handle: (ch, fn) => { reg[ch] = fn; }, tillFetch: async () => null, withinMs: async (p) => p });
    DC.setBusinessDayCutoff('04:00');   // the only writer (as a pull sets it)
    const init = await reg['pos:init']();
    ok('pos:init hands the sale screen the hours (the object, not text) and when the business day ends',
      JSON.stringify(init.menus.find((m) => m.id === 'm-bf')?.availability) === JSON.stringify(BREAKFAST)
      && init.menus.find((m) => m.id === 'm-drinks')?.availability === null && init.businessDayCutoff === 240, JSON.stringify(init.menus));
    DC.setBusinessDayCutoff('00:00');

    E.applyChangeEntries([{ seq: 1, topic: 'menu', table: 'menus', id: 'm-lunch', op: 'upsert',
      row: { id: 'm-lunch', name: 'Lunch', sort_order: 2, active: true, availability: { days: null, windows: [{ start: '12:00', end: '15:00' }] } } }]);
    ok('a change takes the new hours (that one menu)', JSON.parse(hoursOf('m-lunch')).windows[0].start === '12:00'
      && JSON.stringify(JSON.parse(hoursOf('m-bf'))) === JSON.stringify(BREAKFAST));
    E.applyChangeEntries([{ seq: 2, topic: 'menu', table: 'menus', id: 'm-lunch', op: 'upsert', row: { id: 'm-lunch', name: 'Lunch', sort_order: 2, active: true, availability: null } }]);
    ok('…hours cleared upstream → always here', hoursOf('m-lunch') === null);
    E.applyChangeEntries([{ seq: 3, topic: 'menu', table: 'menus', id: 'm-lunch', op: 'upsert', row: { id: 'm-lunch', name: 'Lunch', sort_order: 2, active: true, availability: LUNCH } }]);

    const b = RB.buildReferenceBundle(db, DC.getDeviceConfig());
    const peer = RB.unpackNodeBundle(b);
    ok('the branch server relays the hours to its tills; a peer stores them as the cloud sent them',
      JSON.stringify(b.posInit.menus.find((m) => m.id === 'm-bf')?.availability) === JSON.stringify(BREAKFAST)
      && JSON.stringify(peer.menus.find((m) => m.id === 'm-lunch')?.availability) === JSON.stringify(LUNCH)
      && peer.menus.find((m) => m.id === 'm-drinks')?.availability === null, JSON.stringify(b.posInit.menus));

    cloud.init = initWith({ categories: cloud.init.categories, menus: cloud.init.menus.map(({ availability, ...m }) => m) });
    await E.pullCatalogueNow();
    ok('an older cloud (no availability on its menus): no hours stored — every menu always, as before', hoursOf('m-bf') === null && hoursOf('m-lunch') === null);
  }

  // ── 3 ──
  const MS = [{ id: 'm-bf', name: 'Breakfast', sort_order: 1, active: true, availability: BREAKFAST },
              { id: 'm-lunch', name: 'Lunch', sort_order: 2, active: true, availability: LUNCH },
              { id: 'm-drinks', name: 'Drinks', sort_order: 3, active: true, availability: null }];
  const CS = [{ id: 'c-eggs', name: 'Eggs', menu_id: 'm-bf' }, { id: 'c-mains', name: 'Mains', menu_id: 'm-lunch' },
              { id: 'c-sodas', name: 'Sodas', menu_id: 'm-drinks' }, { id: 'c-extras', name: 'Extras', menu_id: null }];
  const P = [{ id: 'p-eggs', name: 'Spanish omelette', category_id: 'c-eggs', status: 'active' },
             { id: 'p-stew', name: 'Beef stew', category_id: 'c-mains', status: 'active' },
             { id: 'p-coke', name: 'Coke', category_id: 'c-sodas', status: 'active', barcode: '5449000000996' },
             { id: 'p-sauce', name: 'Chilli sauce', category_id: 'c-extras', status: 'active' },
             { id: 'p-water', name: 'Water', category_id: null, status: 'active' }];
  // The sale screen's rule (POSPage's filter: the menu — ignored while searching — the search, and A578's hours).
  const grid = (view, menu = 'all', search = '') => {
    const scope = M.gridMenuScope(M.menuScope(view.categories, view.menus, menu), search);
    return P.filter((p) => M.inMenuScope(p, scope) && p.name.toLowerCase().includes(search.toLowerCase()) && !H.hiddenByHours(p, view)).map((p) => p.id);
  };
  const CP = await bundle('src/renderer/components/CategoryPanel.tsx', 'panel.mjs');
  const bar = (view, trailing) => renderToStaticMarkup(React.createElement(CP.MenuBar, {
    tabs: M.menuBarTabs(view.menus, view.categories), active: 'all', onPick() {}, label: 'Menus', hints: view.hints, trailing }));
  const tabNames = (html) => [...html.matchAll(/data-testid="menu-bar-tab"[^>]*>(?:<span aria-hidden="true" class="mr-1.5">[^<]*<\/span>)?([^<]+)/g)].map((m) => m[1]);
  {
    const v8 = H.menuHoursView(MS, CS, FRI_0800), v13 = H.menuHoursView(MS, CS, FRI_1300);
    const h8 = bar(v8), h13 = bar(v13);
    ok('at 08:00 (Friday) the top tabs are All, Breakfast, Drinks, Other — Lunch hidden; Breakfast says "until 11:00"',
      JSON.stringify(tabNames(h8)) === JSON.stringify(['All', 'Breakfast', 'Drinks', 'Other']) && /data-testid="menu-bar-hint"[^>]*>until 11:00</.test(h8), JSON.stringify(tabNames(h8)));
    ok('at 13:00 Breakfast is gone and Lunch shows ("until 16:00"); Drinks (no hours) and Other always',
      JSON.stringify(tabNames(h13)) === JSON.stringify(['All', 'Lunch', 'Drinks', 'Other']) && /until 16:00/.test(h13), JSON.stringify(tabNames(h13)));
    ok('the panel follows: an asleep menu\'s categories are not listed (08:00: no Mains)',
      JSON.stringify(v8.categories.map((c) => c.id)) === JSON.stringify(['c-eggs', 'c-sodas', 'c-extras']));
    ok('the All tab and search: only items available now (08:00: no stew, even searched; items in no menu and in an always-on menu stay)',
      JSON.stringify(grid(v8)) === JSON.stringify(['p-eggs', 'p-coke', 'p-sauce', 'p-water']) && grid(v8, 'all', 'stew').length === 0
      && JSON.stringify(grid(v13)) === JSON.stringify(['p-stew', 'p-coke', 'p-sauce', 'p-water']));
    const all = H.menuHoursView(MS, CS, FRI_0800, { showAll: true });
    const hAll = bar(all, React.createElement('button', { 'data-testid': 'menu-show-all' }, 'Showing all menus ✕'));
    ok('Show all (a manager, this session): every menu back, Lunch "from 11:00", the switch at the row\'s end, nothing refused',
      JSON.stringify(tabNames(hAll)) === JSON.stringify(['All', 'Breakfast', 'Lunch', 'Drinks', 'Other']) && /from 11:00/.test(hAll)
      && /menu-show-all/.test(hAll) && H.hoursRefusal(P[1], all) === null && grid(all).length === 5);
    const sleepy = H.menuHoursView([MS[1]], [CS[1]], FRI_0800);
    ok('every menu asleep: no tabs, but the Show all switch still shows for a manager (the bar is not empty)',
      M.menuBarTabs(sleepy.menus, sleepy.categories).length === 0 && /menu-show-all/.test(bar(sleepy, React.createElement('button', { 'data-testid': 'menu-show-all' }, 'Show all menus')))
      && bar(sleepy) === '');
    const remembered = M.resolveMenu('m-bf', M.menuBarTabs(v13.menus, v13.categories));
    ok('a till that remembered Breakfast (A554) shows All after 11:00 (the menu is not a tab now)', remembered === M.ALL_MENUS);
  }

  // ── 4 ──
  {
    ok('the next change: 08:00 → 11:00 (Breakfast closes, Lunch opens); 16:30 → Saturday 11:00; Breakfast alone at 16:30 → Monday 06:00, so the timer waits an hour and looks again; at 10:59 it fires at 11:00 (+¼ s)',
      H.nextMenuChange([BREAKFAST, LUNCH], FRI_0800).getTime() === at('2026-10-23T11:00:00').getTime()
      && H.nextMenuChange([BREAKFAST, LUNCH], at('2026-10-23T16:30:00')).getTime() === at('2026-10-24T11:00:00').getTime()
      && H.menuTimerDelay(H.nextMenuChange([BREAKFAST], at('2026-10-23T16:30:00')), at('2026-10-23T16:30:00').getTime()) === 3600_000
      && H.menuTimerDelay(at('2026-10-23T11:00:00'), at('2026-10-23T10:59:00').getTime()) === 60_250);
    ok('no hours anywhere: no timer at all', H.nextMenuChange([null, null], FRI_0800) === null && H.menuTimerDelay(null, 0) === null);
    const hook = src('renderer/lib/useMenuHours.ts');
    ok('the hook sets ONE timeout at the next change (re-armed when it fires), never an interval; looks again on focus',
      /const delay = menuTimerDelay\(/.test(hook) && /setTimeout\(\(\) => setNow\(new Date\(\)\), delay\)/.test(hook) && /\[nextMs, now\]/.test(hook)
      && !/setInterval/.test(hook) && /addEventListener\('focus', again\)/.test(hook));
  }

  // ── 5 ── per mode
  {
    // Restaurant / café: Breakfast, Lunch, Happy hour — the tables → order flow opens the same grid (one filter).
    const HAPPY = { days: null, windows: [{ start: '17:00', end: '19:00' }] };
    const R = H.menuHoursView([...MS, { id: 'm-happy', name: 'Happy hour', active: true, availability: HAPPY }],
      [...CS, { id: 'c-cocktails', name: 'Cocktails', menu_id: 'm-happy' }], at('2026-10-23T17:30:00'));
    ok('restaurant 17:30: Happy hour and Drinks on the tabs (Breakfast and Lunch hidden), "Happy hour until 19:00"',
      JSON.stringify(M.menuBarTabs(R.menus, R.categories).map(M.menuBarLabel)) === JSON.stringify(['All', 'Happy hour', 'Drinks', 'Other'])
      && R.hints['m-happy'] === 'until 19:00');
    const pos = src('renderer/pages/POSPage.tsx');
    ok('restaurant: the table\'s order uses the same grid — one filter with the hours, no second product list',
      (pos.match(/const filtered = useMemo\(\(\) => products\.filter/g) ?? []).length === 1 && /const matchHours\s+= !hiddenByHours\(p, hours\) \|\| laterPeek\(p, hours, \{ menu: activeMenu, category: activeCategory, search \}\);/.test(pos));   // A580: + Later

    // Retail / minimart: a licensed-hours alcohol department. 10:00: hidden, and a SCAN of Tusker is refused in words.
    const ALC = { days: [1, 2, 3, 4, 5, 6], windows: [{ start: '17:00', end: '23:00' }] };
    const shopMenus = [{ id: 'd-alc', name: 'Alcohol', active: true, availability: ALC }, { id: 'd-groc', name: 'Groceries', active: true, availability: null },
                       { id: 'd-bake', name: 'Bakery', active: true, availability: { days: null, windows: [{ start: '06:00', end: '10:00' }] } }];
    const shopCats = [{ id: 'c-beer', name: 'Beer', menu_id: 'd-alc' }, { id: 'c-flour', name: 'Flour', menu_id: 'd-groc' }, { id: 'c-bread', name: 'Bread', menu_id: 'd-bake' }];
    const shopProducts = [{ id: 'p-tusker', name: 'Tusker 500ml', category_id: 'c-beer', barcode: '6161101560014', status: 'active' },
                          { id: 'p-unga', name: 'Unga 2kg', category_id: 'c-flour', barcode: '6164001234567', status: 'active' }];
    const S10 = H.menuHoursView(shopMenus, shopCats, at('2026-10-23T10:00:00'));
    // The till's scanner path (POSPage): products.find(barcode or PLU) → addSimple → refuseOutOfHours first.
    const scan = (code, view) => { const found = shopProducts.find((p) => p.barcode === code); return found ? (H.hoursRefusal(found, view) ?? 'added') : 'not found'; };
    ok('retail 10:00: Alcohol hidden (Groceries shows; Bakery just closed at 10:00); a scanned Tusker is REFUSED in plain words',
      JSON.stringify(M.menuBarTabs(S10.menus, S10.categories).map(M.menuBarLabel)) === JSON.stringify(['All', 'Groceries'])
      && scan('6161101560014', S10) === 'Tusker 500ml is not sold at this time — Alcohol is Mon–Sat, 17:00–23:00.'
      && scan('6164001234567', S10) === 'added', scan('6161101560014', S10));
    ok('retail 18:00: the same scan sells; Sunday 18:00 (no Sunday licence here) it is refused again',
      scan('6161101560014', H.menuHoursView(shopMenus, shopCats, at('2026-10-23T18:00:00'))) === 'added'
      && scan('6161101560014', H.menuHoursView(shopMenus, shopCats, at('2026-10-25T18:00:00'))) !== 'added');
    ok('retail: a manager\'s Show all lets the scan through (the switch is the manager\'s, this session)',
      scan('6161101560014', H.menuHoursView(shopMenus, shopCats, at('2026-10-23T10:00:00'), { showAll: true })) === 'added');
    // Everything before the freeze check in each (A577's weighed-item line may sit first: it refuses on the hours too).
    const addSimple = pos.match(/const addSimple = \(product: any\) => \{\n((?:[^\n]*\n){0,3}?)\s+if \(refuseFrozen\(product\)\) return;/);
    const handleTap = pos.match(/const handleTap = \(product: any\) => \{\n((?:[^\n]*\n){0,3}?)\s+if \(refuseFrozen\(product\)\) return;/);
    const refusesFirst = (block) => /^\s+if \(refuseOutOfHours\(product\)\) return;/m.test(block ?? '')
      && (!/isSoldByWeight/.test(block ?? '') || /isSoldByWeight\(product\)\) \{ if \(!refuseOutOfHours\(product\)/.test(block ?? ''));
    ok('retail: the scanner\'s path refuses — the scanner calls addSimple, which refuses on the hours before anything else; a tap (handleTap) too',
      /if \(found && found\.status === 'active'\) \{\s*addSimple\(found\);/.test(pos)
      && refusesFirst(addSimple?.[1]) && refusesFirst(handleTap?.[1])
      && /const why = hoursRefusal\(product, hoursRef\.current\);/.test(pos) && /hoursRef\.current = hours;/.test(pos), JSON.stringify([addSimple?.[1], handleTap?.[1]]));

    // Petrol: shop groups with hours; fuel NEVER refused or hidden, even when its category sits under a scheduled group.
    const petrolMenus = [{ id: 'g-fore', name: 'Forecourt', active: true, availability: { days: null, windows: [{ start: '06:00', end: '22:00' }] } },
                         { id: 'g-shop', name: 'Shop', active: true, availability: { days: null, windows: [{ start: '07:00', end: '21:00' }] } }];
    const petrolCats = [{ id: 'c-fuel', name: 'Fuel', menu_id: 'g-fore' }, { id: 'c-snacks', name: 'Snacks', menu_id: 'g-shop' }];
    const P23 = H.menuHoursView(petrolMenus, petrolCats, at('2026-10-23T23:00:00'));
    const diesel = { id: 'p-diesel', name: 'Diesel', category_id: 'c-fuel', is_fuel: true }, crisps = { id: 'p-crisps', name: 'Crisps', category_id: 'c-snacks' };
    ok('petrol 23:00: the shop group is closed (Crisps hidden and refused); fuel is never hidden or refused',
      H.hiddenByHours(crisps, P23) && H.hoursRefusal(crisps, P23) !== null && !H.hiddenByHours(diesel, P23) && H.hoursRefusal(diesel, P23) === null);
    // A588: the petrol POS's grid is its forecourt shop (fuel only on the pumps) — the hours ride along on it.
    ok('petrol: the shop grid never lists fuel (A588: the grades are on the pumps), the hours ride along',
      /const matchFuel\s+= !\(p as any\)\.is_fuel;/.test(pos) && /&& matchFuel && matchDay && matchStock && matchHours;/.test(pos));

    // Parking / other: Groups with hours work the same (a car wash group 08:00–18:00).
    const G = H.menuHoursView([{ id: 'g-wash', name: 'Car wash', active: true, availability: { days: null, windows: [{ start: '08:00', end: '18:00' }] } }],
      [{ id: 'c-wash', menu_id: 'g-wash' }, { id: 'c-park', menu_id: null }], at('2026-10-23T19:00:00'));
    ok('parking / other 19:00: the Car wash group is hidden; parking (no group) untouched',
      G.menus.length === 0 && G.categories.map((c) => c.id).join() === 'c-park' && H.hoursRefusal({ name: 'Wash', category_id: 'c-wash' }, G) !== null);
  }

  // ── 6 ──
  {
    const pos = src('renderer/pages/POSPage.tsx');
    ok('the bar and the panel take the menus open now; the hints and Show all on the bar',
      /const hours = useMenuHours\(menus, categories, \{ cutoff: menuDayCutoff, showAll: showAllMenus && canShowAllMenus, later: laterMenus \}\);/.test(pos)   // A580: + Later
      && /<CategoryPanel panel=\{catPanel\} categories=\{categoriesNow\} menus=\{menusNow\}/.test(pos)
      && /hints=\{hours\.hints\}\s+greyed=\{hours\.later\}\s+trailing=\{hours\.anyAsleep \?/.test(pos) && /\{canShowAllMenus && \(/.test(pos));   // A580: Later for anyone, Show all for menu.edit
    ok('Show all only with menu.edit (the menu permission, an existing key), for this session (component state, never stored)',
      /setCanShowAllMenus\(can\(ss, 'menu\.edit'\)\)/.test(pos) && /const \[showAllMenus, setShowAllMenus\] = useState\(false\);/.test(pos)
      && !/localStorage[^\n]*showAll/i.test(pos));
    ok('the business day\'s end reaches the hours (a window past midnight belongs to the night before)',
      /setMenuDayCutoff\(Number\(bdc\) \|\| 0\)/.test(pos));
    ok('the till\'s copy of the helper is the shared file, verbatim',
      src('shared/menuHours.ts') === fs.readFileSync(path.join(desktop, '..', '..', 'shared', 'menuHours.ts'), 'utf8'));
  }
} finally {
  srv.close();
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
