// owner-decisions-a580.test.mjs — A580 on the till: the owner's decisions of 2026-10-23.
//
//   1  Menu hours (A578): "let it remain as built, but add a 'Later' button to the menu list to show closed menus in
//      greyed-out form" — the till's MenuBar renders the closed menus greyed (their own test id, dashed) with when they
//      open; the LaterButton ("Later" / "Later ✕"); the sale screen's wiring (POSPage): Later for ANY staff member while a
//      menu is closed, this session only, Show all still the manager's (menu.edit) and saying it sells; a greyed tile is
//      refused by handleTap's first check (A578's words).
//   2  Every business type, as it operates: restaurant (Breakfast / Happy hour), retail (a licensed-hours Alcohol
//      department, the scan refused), petrol station (the shop's group; the pumps' fuel never touched), parking / other
//      (a Car wash group) — Later shows the closed one greyed, its items only in its own menu, nothing sold.
//   3  No "Kots" on a shop's receipt: the till's print path passes kitchenTickets from the business type (compiled main),
//      and the printing package leaves the line out; a restaurant's receipt as before.
//
//   cd apps/desktop && npm run build:main && node test/owner-decisions-a580.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — the A580 report):
//   - MenuBar ignoring `greyed` (the closed tab drawn as an open one)   → 1 "greyed and dashed" fails
//   - POSPage's LaterButton gated on canShowAllMenus                    → 1 "for any staff member" fails
//   - laterPeek allowing the All tab                                    → 2 "never on All" fails (every type)
//   - kitchenBusiness returning true for every type                     → 3 "a shop's receipt" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a580-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, session: { fromPartition: () => ({}) }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (req === 'electron') return shim; return orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const H = await import(pathToFileURL(path.join(desktop, 'src', 'shared', 'menuHours.ts')).href);
const M = await import(pathToFileURL(path.join(desktop, 'src', 'shared', 'menuFilter.ts')).href);
const T = await import(pathToFileURL(path.join(desktop, 'src', 'shared', 'businessTerms.ts')).href);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const bundleDir = fs.mkdtempSync(path.join(desktop, 'node_modules', '.a580-'));
const bundle = (entry, out) => {
  require('esbuild').buildSync({ entryPoints: [path.join(desktop, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'] });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};
const at = (s) => new Date(s);

try {
  // ── 1 ──
  console.log('\n1. the till\'s bar: Later (the closed menus greyed, view only)\n');
  const BF = { days: [1, 2, 3, 4, 5], windows: [{ start: '06:00', end: '11:00' }] };
  const HAPPY = { days: [4, 5], windows: [{ start: '17:00', end: '19:00' }] };
  const MS = [{ id: 'm-bf', name: 'Breakfast', sort_order: 1, active: true, availability: BF },
              { id: 'm-happy', name: 'Happy hour', sort_order: 2, active: true, availability: HAPPY },
              { id: 'm-drinks', name: 'Drinks', sort_order: 3, active: true, availability: null }];
  const CS = [{ id: 'c-eggs', menu_id: 'm-bf' }, { id: 'c-cocktails', menu_id: 'm-happy' }, { id: 'c-sodas', menu_id: 'm-drinks' }];
  const FRI13 = at('2026-10-23T13:00:00');
  const view = H.menuHoursView(MS, CS, FRI13, { later: true });
  const CP = await bundle('src/renderer/components/CategoryPanel.tsx', 'panel.mjs');
  const html = renderToStaticMarkup(React.createElement(CP.MenuBar, { tabs: M.menuBarTabs(view.menus, view.categories), active: 'all', onPick() {},
    label: 'Menus', hints: view.hints, greyed: view.later,
    trailing: React.createElement(React.Fragment, null, React.createElement(CP.LaterButton, { on: true, onToggle() {}, label: 'Menus' }),
      React.createElement('button', { 'data-testid': 'menu-show-all' }, 'Show all menus · sell')) }));
  ok('Friday 13:00 with Later on: Breakfast (Mon–Fri, shut since 11:00) and Happy hour greyed and dashed, each with when it opens',
    (html.match(/data-testid="menu-bar-tab-later"/g) ?? []).length === 2 && /border-dashed opacity-60 grayscale/.test(html)
    && />Breakfast<span data-testid="menu-bar-hint"[^>]*>Mon–Fri<\/span>/.test(html)
    && />Happy hour<span data-testid="menu-bar-hint"[^>]*>from 17:00 \(Thu, Fri\)<\/span>/.test(html), html.slice(0, 1200));
  ok('…Drinks (no hours) and All as before; Later and the manager\'s Show all side by side at the row\'s end',
    (html.match(/data-testid="menu-bar-tab"/g) ?? []).length === 2 && /data-testid="menu-later" aria-pressed="true"/.test(html)
    && html.indexOf('menu-later') < html.indexOf('menu-show-all') && /flex items-center gap-2/.test(html));
  const offHtml = renderToStaticMarkup(React.createElement(CP.LaterButton, { on: false, onToggle() {}, label: 'Departments' }));
  ok('the Later button off: "Later", dashed, "See the departments that open later (view only)"',
    />Later<\/button>$/.test(offHtml) && /border-dashed/.test(offHtml) && /See the departments that open later \(view only\)/.test(offHtml));

  const pos = src('renderer/pages/POSPage.tsx');
  ok('POSPage: Later is component state (this session only, never stored) and reaches the hours',
    pos.includes('const [laterMenus, setLaterMenus] = useState(false);')
    && pos.includes('const hours = useMenuHours(menus, categories, { cutoff: menuDayCutoff, showAll: showAllMenus && canShowAllMenus, later: laterMenus });')
    && !/localStorage[^\n]*later/i.test(pos));
  ok('POSPage: Later for ANY staff member, only while a menu is closed (not menu.edit); hidden while a manager\'s Show all is on',
    /trailing=\{hours\.anyAsleep \? \(<>/.test(pos) && /\{!\(showAllMenus && canShowAllMenus\) && \(\s*<LaterButton on=\{laterMenus\} onToggle=\{\(\) => setLaterMenus\(\(v\) => !v\)\} label=\{words\.menus\} \/>/.test(pos)
    && /\{canShowAllMenus && \(\s*\/\/[^\n]*\n\s*<button type="button" data-testid="menu-show-all"/.test(pos));
  ok('POSPage: Show all is the amber 🔑 "· sell" switch — clearly not Later',
    pos.includes("`Show all ${words.menus.toLowerCase()} · sell`") && /title=\{`Manager: bring back every/.test(pos));
  ok('POSPage: the grid shows a closed menu\'s items only through laterPeek; the tile greyed "Later"; a tap refused first (handleTap)',
    /const matchHours\s+= !hiddenByHours\(p, hours\) \|\| laterPeek\(p, hours, \{ menu: activeMenu, category: activeCategory, search \}\);/.test(pos)
    && pos.includes('later={hours.later.size > 0 && itemAsleep(product, hours) !== null}')
    && /data-testid=\{later \? 'tile-later' : soldOut \? 'tile-sold-out' : undefined\}/.test(pos)
    && /const handleTap = \(product: any\) => \{\s*if \(refuseOutOfHours\(product\)\) return;/.test(pos)
    && /<MenuBar tabs=\{menuBar\} active=\{activeMenu\} onPick=\{pickMenu\} label=\{words\.menus\} hints=\{hours\.hints\}\s+greyed=\{hours\.later\}/.test(pos));

  // ── 2 ──
  console.log('\n2. every business type, as it operates\n');
  const run = (type, menus, cats, products, now, closedMenu, closedItem) => {
    const v = H.menuHoursView(menus, cats, now, { later: true });
    const grid = (menu = 'all', category = 'all', search = '') => products.filter((p) => M.inMenuScope(p, M.gridMenuScope(M.menuScope(v.categories, v.menus, menu), search))
      && (category === 'all' || p.category_id === category) && p.name.toLowerCase().includes(search.toLowerCase())
      && (!H.hiddenByHours(p, v) || H.laterPeek(p, v, { menu, category, search }))).map((p) => p.id);
    const word = T.businessTerms(type).menus;
    const item = products.find((p) => p.id === closedItem);
    return {
      greyed: v.later.has(closedMenu) && M.menuBarTabs(v.menus, v.categories).some((t) => t.id === closedMenu),
      peeks: grid(closedMenu).includes(closedItem), notOnAll: !grid().includes(closedItem), notInSearch: !grid('all', 'all', item.name.slice(0, 4)).includes(closedItem),
      refused: H.hoursRefusal(item, v), word,
    };
  };
  const check = (label, r, wordWant) => ok(`${label}: greyed under Later, its items only in its own ${r.word.toLowerCase()} (never on All or in a search), refused in words`,
    r.greyed && r.peeks && r.notOnAll && r.notInSearch && /is not sold at this time — /.test(r.refused ?? '') && r.word === wordWant, JSON.stringify(r));
  check('restaurant 13:00 (Happy hour Thu–Fri 17:00)', run('restaurant', MS, CS,
    [{ id: 'mojito', name: 'Mojito', category_id: 'c-cocktails' }, { id: 'coke', name: 'Coke', category_id: 'c-sodas' }], FRI13, 'm-happy', 'mojito'), 'Menus');
  check('cafe 13:00 (Breakfast Mon–Fri 06:00–11:00)', run('cafe', MS, CS,
    [{ id: 'omelette', name: 'Omelette', category_id: 'c-eggs' }], FRI13, 'm-bf', 'omelette'), 'Menus');
  const ALC = { days: [1, 2, 3, 4, 5, 6], windows: [{ start: '17:00', end: '23:00' }] };
  for (const type of ['retail', 'minimart']) {
    check(`${type} 10:00 (the Alcohol department Mon–Sat 17:00–23:00)`, run(type,
      [{ id: 'd-alc', name: 'Alcohol', active: true, availability: ALC }, { id: 'd-groc', name: 'Groceries', active: true, availability: null }],
      [{ id: 'c-beer', menu_id: 'd-alc' }, { id: 'c-bread', menu_id: 'd-groc' }],
      [{ id: 'tusker', name: 'Tusker 500ml', category_id: 'c-beer', barcode: '6161101600019' }, { id: 'bread', name: 'Bread', category_id: 'c-bread' }],
      at('2026-10-23T10:00:00'), 'd-alc', 'tusker'), 'Departments');
  }
  const SHOP = { days: null, windows: [{ start: '06:00', end: '22:00' }] };
  const petrol = H.menuHoursView([{ id: 'g-shop', name: 'Shop', active: true, availability: SHOP }], [{ id: 'c-snacks', menu_id: 'g-shop' }, { id: 'c-fuel', menu_id: 'g-shop' }],
    at('2026-10-23T23:00:00'), { later: true });
  ok('petrol station 23:00: the shop\'s group greyed under Later, a snack refused — the pumps\' diesel never (fuel excused)',
    petrol.later.has('g-shop') && H.hoursRefusal({ name: 'Crisps', category_id: 'c-snacks' }, petrol) !== null
    && H.hoursRefusal({ name: 'Diesel', category_id: 'c-fuel', is_fuel: true }, petrol) === null
    && H.laterPeek({ name: 'Diesel', category_id: 'c-fuel', is_fuel: true }, petrol, { menu: 'g-shop' }) === false
    && T.businessTerms('petrol_station').menus === 'Departments');
  const WASH = { days: null, windows: [{ start: '07:00', end: '18:00' }] };
  for (const type of ['parking', 'other']) {
    check(`${type} 19:00 (a Car wash group 07:00–18:00)`, run(type,
      [{ id: 'g-wash', name: 'Car wash', active: true, availability: WASH }], [{ id: 'c-wash', menu_id: 'g-wash' }, { id: 'c-park', menu_id: null }],
      [{ id: 'wash', name: 'Full wash', category_id: 'c-wash' }, { id: 'park', name: 'Parking 1h', category_id: 'c-park' }],
      at('2026-10-23T19:00:00'), 'g-wash', 'wash'), 'Groups');
  }

  // ── 3 ──
  console.log('\n3. no "Kots" on a shop\'s receipt (the till\'s print path)\n');
  const S = require(path.join(dist, 'ipc', 'shared.js'));
  ok('kitchenBusiness (compiled main): restaurant / café / not known yet → the Kots line; every other type → none',
    ['restaurant', 'cafe', '', null, 'Restaurant'].every((t) => S.kitchenBusiness(t) === true)
    && ['retail', 'minimart', 'petrol_station', 'Petrol Station', 'parking', 'other'].every((t) => S.kitchenBusiness(t) === false));
  ok('the till\'s receipt config passes it from device_config.business_type',
    src('main/ipc/shared.ts').includes('kitchenTickets:  kitchenBusiness(cfg?.business_type),'));
  const PR = require('@swiftpos/printing');
  const order = { billNumber: 'T1-0042', orderType: 'counter', cashierName: 'Mary', soldAt: new Date('2026-10-23T10:00:00Z'),
    lines: [{ productId: 'p1', name: 'Bread', quantity: 2, unitPrice: 7500, lineTotal: 15000, units: [] }],
    payments: [{ label: 'Cash', amount: 20000 }], changeGiven: 5000, total: 15000, kotCount: 0 };
  const biz = { name: 'Magas Limited', currencyCode: 'KES', vatRate: 16, ctlRate: 0 };
  const bytes = (b) => PR.toEscPos(PR.renderTicket({ order, business: b, station: PR.receiptPreset('st', 'Till', 80) }), { cut: true }).toString('latin1');
  ok('a shop\'s till receipt: no "Kots"; a restaurant\'s: "Kots: 0", the same bytes as before the switch',
    !/Kots/.test(bytes({ ...biz, kitchenTickets: S.kitchenBusiness('retail') })) && /Kots: 0/.test(bytes({ ...biz, kitchenTickets: S.kitchenBusiness('restaurant') }))
    && bytes({ ...biz, kitchenTickets: true }) === bytes(biz));
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
