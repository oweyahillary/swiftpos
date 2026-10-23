// A578 — menus by time of day: the pure rules (shared/menuHours.ts — the till, the web POS, the Menus page and the cloud
// run this one file), the web POS (CashierScreen, MinimartPOS: the bar, the grid, a scan refused), the Menus page's hours
// editor, and the cloud's routes and sync.
//
// Owner, 2026-10-23 (approved): "each menu can have optional availability: days of the week and one or more time windows
// (Breakfast Mon–Fri 06:00–11:00; Lunch 11:00–16:00). No schedule = always available." Then: "let us not forget other
// business … all this changes should also be taking shape on them based on how they operate" — a shop's alcohol
// department in licensed hours refused when SCANNED, not only hidden.
//
//   node tests/menu-hours-a578.test.mjs
//
//   R  the rules: no schedule = always; days; windows (the end not included); a window past midnight belongs to the day it
//      started; the business day's cut-off; a bad stored value = always.
//   N  the next change and the timer's wait (one timeout at the next change, at most an hour).
//   C  what the cloud stores (checkAvailability): cleaned, refused in words.
//   V  the POS's view: hidden from the tabs, the panel, the All tab and search; items in no menu / an always-on menu / fuel
//      untouched; the hints; the manager's Show all; the refusal's words.
//   W  the web POS: the bar (hints, Show all at the row's end), CashierScreen's filter and refusal (the scanner too),
//      MinimartPOS's scan refused in words (not "not found"); Show all only with menu.edit.
//   E  the Menus page: the hours editor rendered (Always / set times, days, times, the preview, a refusal before saving),
//      the summary per menu, the business's word.
//   S  the cloud: PATCH / POST take availability (checked; 409 before migration 165), /pos/init and /pos/changes carry it.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A578 report):
//   - isMenuOpenAt with the end included (<=)                        → R "the end is not included" fails
//   - isMenuOpenAt without the yesterday half of an overnight window → R "past midnight belongs to the day it started" fails
//   - businessClock ignoring the cut-off                             → R "the cut-off" fails
//   - readAvailability hiding a menu on a bad value                  → R "a bad stored value = always" fails
//   - nextMenuChange returning the first boundary whatever changes   → N "the next REAL change" fails
//   - hoursRefusal passing everything                                → V "refused in words" fails
//   - CashierScreen's isFrozen without the hours check               → W "the scanner and a tap refused" fails
//   - MinimartPOS adding the scanned item without outOfHours         → W "MinimartPOS refuses a scan" fails
//   - checkAvailability accepting an empty day list                  → C "no day at all is refused" fails
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const require = createRequire(path.join(DASH, 'package.json'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`PASS  ${n}`); pass++; } else { console.log(`FAIL  ${n}  ${d}`); fail++; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.a578-'));
const bundle = (entry, out) => {
  require('esbuild').buildSync({ entryPoints: [path.join(DASH, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'] });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};
const at = (s) => new Date(s);   // local clock (the till's / the browser's)

try {
  const H = await import(pathToFileURL(path.join(ROOT, 'shared/menuHours.ts')).href);
  const M = await import(pathToFileURL(path.join(ROOT, 'shared/menuFilter.ts')).href);
  const BF = H.readAvailability({ days: [1, 2, 3, 4, 5], windows: [{ start: '06:00', end: '11:00' }] });
  const LUNCH = H.readAvailability({ windows: [{ start: '11:00', end: '16:00' }] });
  const NIGHT = H.readAvailability({ days: [5], windows: [{ start: '22:00', end: '02:00' }] });   // Friday nights
  const SUNDAY = H.readAvailability({ days: [0] });

  console.log('\nR. the rules\n');
  ok('no schedule = always (null, undefined, "", "null", every day with no times, all seven days)',
    [null, undefined, '', 'null', { days: null, windows: [] }, { days: [0, 1, 2, 3, 4, 5, 6] }].every((v) => H.readAvailability(v) === null)
    && H.isMenuOpenAt(null, at('2026-10-23T03:00:00')));
  ok('Breakfast Mon–Fri 06:00–11:00: Friday 08:00 open; 13:00 shut; Saturday 08:00 shut; 05:59 shut',
    H.isMenuOpenAt(BF, at('2026-10-23T08:00:00')) && !H.isMenuOpenAt(BF, at('2026-10-23T13:00:00'))
    && !H.isMenuOpenAt(BF, at('2026-10-24T08:00:00')) && !H.isMenuOpenAt(BF, at('2026-10-23T05:59:00')));
  ok('the end is not included: 11:00 is Lunch\'s, not Breakfast\'s; 06:00 is Breakfast\'s',
    !H.isMenuOpenAt(BF, at('2026-10-23T11:00:00')) && H.isMenuOpenAt(LUNCH, at('2026-10-23T11:00:00')) && H.isMenuOpenAt(BF, at('2026-10-23T06:00:00')));
  ok('past midnight belongs to the day it started: Fri 22:00–02:00 is open Fri 23:00 and Sat 01:00, shut Fri 01:00 (Thursday night) and Sat 02:00',
    H.isMenuOpenAt(NIGHT, at('2026-10-23T23:00:00')) && H.isMenuOpenAt(NIGHT, at('2026-10-24T01:00:00'))
    && !H.isMenuOpenAt(NIGHT, at('2026-10-23T01:00:00')) && !H.isMenuOpenAt(NIGHT, at('2026-10-24T02:00:00')));
  ok('"18:00–00:00" runs to midnight (not all night)', H.isMenuOpenAt(H.readAvailability({ windows: [{ start: '18:00', end: '00:00' }] }), at('2026-10-23T23:59:00'))
    && !H.isMenuOpenAt(H.readAvailability({ windows: [{ start: '18:00', end: '00:00' }] }), at('2026-10-24T00:30:00')));
  ok('the cut-off (the business day ends at 04:00): Sunday 01:30 is still Saturday night — a Sunday menu is shut; Monday 01:30 is Sunday night — open',
    !H.isMenuOpenAt(SUNDAY, at('2026-10-25T01:30:00'), 240) && H.isMenuOpenAt(SUNDAY, at('2026-10-26T01:30:00'), 240)
    && H.isMenuOpenAt(SUNDAY, at('2026-10-25T01:30:00'), 0) && !H.isMenuOpenAt(SUNDAY, at('2026-10-26T01:30:00'), 0));
  ok('…with the cut-off at 04:00 a Friday "00:30–03:00" is Friday NIGHT (Saturday 01:00), not Friday early morning',
    H.isMenuOpenAt(H.readAvailability({ days: [5], windows: [{ start: '00:30', end: '03:00' }] }), at('2026-10-24T01:00:00'), 240)
    && !H.isMenuOpenAt(H.readAvailability({ days: [5], windows: [{ start: '00:30', end: '03:00' }] }), at('2026-10-23T01:00:00'), 240));
  ok('a bad stored value = always (never hide a menu by mistake)', ['{bad', { days: 'x' }, { windows: [{ start: 'noon' }] }, [1, 2], 7]
    .every((v) => H.readAvailability(v) === null));

  console.log('\nN. the next change and the timer\n');
  ok('the next REAL change: Friday 08:00 → 11:00 (Breakfast shuts, Lunch opens) — not the 06:00 / cut-off marks in between',
    H.nextMenuChange([BF, LUNCH], at('2026-10-23T08:00:00')).getTime() === at('2026-10-23T11:00:00').getTime()
    && H.nextMenuChange([BF], at('2026-10-23T13:00:00')).getTime() === at('2026-10-26T06:00:00').getTime()
    && H.nextMenuChange([NIGHT], at('2026-10-24T01:00:00')).getTime() === at('2026-10-24T02:00:00').getTime());
  ok('no schedule anywhere: no change, no timer; the wait is clamped to ¼ s … 1 h', H.nextMenuChange([null], at('2026-10-23T08:00:00')) === null
    && H.menuTimerDelay(null, 0) === null && H.menuTimerDelay(new Date(10_000), 0) === 10_250
    && H.menuTimerDelay(new Date(0), 99_999) === 250 && H.menuTimerDelay(new Date(9e12), 0) === 3_600_000);
  const hookWeb = read('apps/dashboard/src/lib/useMenuHours.ts'), hookTill = read('apps/desktop/src/renderer/lib/useMenuHours.ts');
  ok('the web and the till set ONE timeout at the next change, never an interval (the two hooks differ only in their import)',
    !/setInterval/.test(hookWeb) && /setTimeout\(\(\) => setNow\(new Date\(\)\), delay\)/.test(hookWeb)
    && hookWeb.replace(/^\/\*\*[\s\S]*?\*\/\n/, '').replace("'./menuHours'", 'X') === hookTill.replace(/^\/\*\*[\s\S]*?\*\/\n/, '').replace("'../../shared/menuHours'", 'X'));

  console.log('\nC. what the cloud stores\n');
  const c1 = H.checkAvailability({ days: [5, '1', 1, 3], windows: [{ start: '6:00', end: '11:00:00' }, { start: '6:00', end: '11:00' }, { start: '05:00', end: '05:30' }] });
  ok('cleaned: days sorted and de-duplicated; times "HH:MM"; duplicates dropped; sorted by start',
    c1.ok && JSON.stringify(c1.value) === JSON.stringify({ days: [1, 3, 5], windows: [{ start: '05:00', end: '05:30' }, { start: '06:00', end: '11:00' }] }));
  const err = (v) => H.checkAvailability(v).error;
  ok('refused in words: no day at all, a day 7, a time 25:00, from = to, seven windows, an array, text that is not JSON',
    err({ days: [] }) === 'Choose at least one day' && /Sunday \(0\) to Saturday \(6\)/.test(err({ days: [7] }))
    && /from and a to/.test(err({ windows: [{ start: '25:00', end: '26:00' }] })) && /must differ/.test(err({ windows: [{ start: '10:00', end: '10:00' }] }))
    && /At most 6/.test(err({ windows: Array.from({ length: 7 }, (_, i) => ({ start: `0${i}:00`, end: `0${i}:30` })) }))
    && /days and times/.test(err([1])) && /could not be read/.test(err('{nope')));
  ok('in words for the owner: "Mon–Fri, 06:00–11:00", "Every day, 11:00–16:00 and 18:00–22:00", "Sat, Sun, all day", "Always"',
    H.availabilityLabel(BF) === 'Mon–Fri, 06:00–11:00'
    && H.availabilityLabel(H.readAvailability({ windows: [{ start: '18:00', end: '22:00' }, { start: '11:00', end: '16:00' }] })) === 'Every day, 11:00–16:00 and 18:00–22:00'
    && H.availabilityLabel(H.readAvailability({ days: [6, 0] })) === 'Sat, Sun, all day' && H.availabilityLabel(null) === 'Always');

  console.log('\nV. the POS\'s view\n');
  const MS = [{ id: 'bf', name: 'Breakfast', sort_order: 1, active: true, availability: BF },
              { id: 'lunch', name: 'Lunch', sort_order: 2, active: true, availability: LUNCH },
              { id: 'drinks', name: 'Drinks', sort_order: 3, active: true, availability: null },
              { id: 'off', name: 'Shisha', sort_order: 4, active: false, availability: LUNCH }];
  const CS = [{ id: 'eggs', menu_id: 'bf' }, { id: 'mains', menu_id: 'lunch' }, { id: 'sodas', menu_id: 'drinks' }, { id: 'extras', menu_id: null }, { id: 'hookah', menu_id: 'off' }];
  const P = [{ id: 'omelette', name: 'Omelette', category_id: 'eggs' }, { id: 'stew', name: 'Beef stew', category_id: 'mains' },
             { id: 'coke', name: 'Coke', category_id: 'sodas' }, { id: 'sauce', name: 'Chilli sauce', category_id: 'extras' },
             { id: 'water', name: 'Water', category_id: null }, { id: 'pipe', name: 'Pipe', category_id: 'hookah' },
             { id: 'stew2', name: 'Stew (web shape)', categories: { id: 'mains' } }, { id: 'diesel', name: 'Diesel', category_id: 'mains', is_fuel: true }];
  const v8 = H.menuHoursView(MS, CS, at('2026-10-23T08:00:00'));
  // The web POS's rule (CashierScreen's filter) — the menu (ignored while searching), the search, the hours.
  const grid = (view, menu = 'all', search = '') => P.filter((p) => M.inMenuScope(p, M.gridMenuScope(M.menuScope(view.categories, view.menus, menu), search))
    && p.name.toLowerCase().includes(search.toLowerCase()) && !H.hiddenByHours(p, view)).map((p) => p.id).join();
  ok('08:00: Lunch is not on the tabs, its categories not in the panel; Breakfast and Drinks are; a switched-off menu is A537\'s (not ours)',
    JSON.stringify(M.menuBarTabs(v8.menus, v8.categories).map(M.menuBarLabel)) === JSON.stringify(['All', 'Breakfast', 'Drinks', 'Other'])
    && !v8.categories.some((c) => c.id === 'mains') && v8.categories.some((c) => c.id === 'hookah'));
  ok('the All tab and search show only what is available now; items in no menu, in an always-on menu, and fuel are untouched',
    grid(v8) === 'omelette,coke,sauce,water,pipe,diesel' && grid(v8, 'all', 'stew') === '' && grid(v8, 'all', 'die') === 'diesel');
  ok('refused in words (the scan or a tap): "Beef stew is not sold at this time — Lunch is every day, 11:00–16:00." (the web\'s nested category too)',
    H.hoursRefusal(P[1], v8) === 'Beef stew is not sold at this time — Lunch is every day, 11:00–16:00.'
    && H.hoursRefusal(P[6], v8) !== null && H.hoursRefusal(P[2], v8) === null && H.hoursRefusal(P[4], v8) === null && H.hoursRefusal(P[7], v8) === null);
  ok('the hints: Breakfast "until 11:00"; a menu without hours none; anyAsleep and the next change at 11:00',
    v8.hints.bf === 'until 11:00' && !('drinks' in v8.hints) && v8.anyAsleep && v8.nextChange.getTime() === at('2026-10-23T11:00:00').getTime());
  const all = H.menuHoursView(MS, CS, at('2026-10-23T08:00:00'), { showAll: true });
  ok('Show all: every menu and category back, nothing refused, Lunch "from 11:00"; still anyAsleep (the switch stays to turn off)',
    all.menus.length === 4 && all.categories.length === 5 && all.asleep.size === 0 && all.hints.lunch === 'from 11:00' && all.anyAsleep
    && grid(all).split(',').length === P.length);
  const sat = H.menuHoursView(MS, CS, at('2026-10-24T17:00:00'), { showAll: true });
  ok('…a menu that does not open again today says "from 06:00" only within a day, else "not today"', sat.hints.bf === 'not today');
  ok('no menus with hours: the view is the input (today\'s behaviour, no timer)',
    (() => { const v = H.menuHoursView([MS[2]], CS, at('2026-10-23T08:00:00')); return v.menus.length === 1 && v.categories.length === 5 && !v.anyAsleep && v.nextChange === null; })());

  console.log('\nW. the web POS\n');
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const CP = await bundle('src/pages/pos/cashier/CategoryPanel.tsx', 'panel.mjs');
  const barHtml = renderToStaticMarkup(React.createElement(CP.MenuBar, { tabs: M.menuBarTabs(v8.menus, v8.categories), active: 'all', onPick() {},
    hints: v8.hints, trailing: React.createElement('button', { 'data-testid': 'menu-show-all' }, 'Show all menus') }));
  ok('the web bar: the hint on Breakfast\'s tab, Show all at the row\'s end; nothing else changes (A566\'s tabs)',
    /Breakfast<span data-testid="menu-bar-hint"[^>]*>until 11:00<\/span>/.test(barHtml) && /data-testid="menu-show-all"/.test(barHtml)
    && (barHtml.match(/data-testid="menu-bar-tab"/g) ?? []).length === 4, barHtml.slice(0, 400));
  ok('…every menu asleep and no manager: no bar at all (as a business with no menus)',
    renderToStaticMarkup(React.createElement(CP.MenuBar, { tabs: [], active: 'all', onPick() {} })) === '');
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx'), mm = read('apps/dashboard/src/pages/pos/MinimartPOS.tsx');
  ok('CashierScreen: the hours by the browser\'s clock and the business day; Show all only with menu.edit, this session',
    /const canShowAllMenus = hasPermission\('menu\.edit'\);/.test(cs) && /const \[showAllMenus, setShowAllMenus\] = useState\(false\);/.test(cs)
    && /useMenuHours\(menus, categories, \{ cutoff: getWebDayCutoff\(\), showAll: showAllMenus && canShowAllMenus, later: laterMenus \}\)/.test(cs)   // A580: + Later
    && /const showAllButton = canShowAllMenus && hours\.anyAsleep \?/.test(cs));
  ok('CashierScreen: the grid leaves out what is asleep (All and search too); the bar and panel take the menus open now',
    /const matchHours = !hiddenByHours\(p as any, hours\)[^\n]*\n\s*\|\| laterPeek\(p as any, hours, \{ menu: activeMenu, category: activeCategory, search \}\);/.test(cs) && /&& matchStock && matchHours;/.test(cs)   // A580: Later peeks
    && /menuBarTabs\(menusNow, categoriesNow\)/.test(cs) && /<CategoryPanel panel=\{catPanel\} categories=\{categoriesNow\} menus=\{menusNow\}/.test(cs));
  ok('CashierScreen: the scanner and a tap refused in words — isFrozen\'s FIRST check is the hours (through a ref: the scanner\'s listener reads the latest)',
    /const isFrozen = useCallback\(\(product: Product\): boolean => \{\s*const outOfHours = hoursRefusal\(product as any, hoursRef\.current\);/.test(cs)
    && /if \(outOfHours\) \{ showFreezeToast\(outOfHours, 'warning'\); return true; \}/.test(cs) && /hoursRef\.current = hours;/.test(cs)
    && /const found = products\.find\(p => \(p as any\)\.barcode === buffer\);\s*if \(found\) addToCart\(found\);/.test(cs)
    && /const addToCart = useCallback\(\s*\(product: Product\) => \{\s*if \(isFrozen\(product\)\) return;/.test(cs));
  ok('MinimartPOS refuses a scan of an out-of-hours department\'s item in words (not "not found", not added) and leaves it off its catalogue',
    /const notNow = product && outOfHours \? outOfHours\(product\) : null;\s*if \(product && notNow\) \{\s*setScanStatus\('error'\);\s*setScanMessage\(notNow\);\s*\} else if/.test(mm)
    && /\} else if \(notNow\) \{\s*setScanStatus\('error'\);\s*setScanMessage\(notNow\);/.test(mm)   // A577's scale label too
    && /if \(outOfHours\?\.\(p\) && !peekLater\?\.\(p, \{ menu: activeMenu, category: activeCategory, search: catalogueSearch \}\)\) return false;/.test(mm)   // A580
    && /outOfHours=\{\(p: Product\) => hoursRefusal\(p as any, hours\)\}/.test(cs) && /categories=\{categoriesNow\}/.test(cs)
    && /hints=\{menuHints\} trailing=\{menuBarTrailing\} greyed=\{menuLater\}/.test(mm));   // A580: the greyed Later tabs
  ok('the web\'s copies are the shared file, verbatim (lib/ and the cloud\'s)',
    read('apps/dashboard/src/lib/menuHours.ts') === read('shared/menuHours.ts') && read('apps/server/src/lib/menuHours.ts') === read('shared/menuHours.ts'));

  console.log('\nE. the Menus page\n');
  const ED = await bundle('src/pages/products/MenuHoursEditor.tsx', 'editor.mjs');
  const editor = (initial, extra = {}) => renderToStaticMarkup(React.createElement(ED.default, { name: 'Breakfast', one: 'menu', food: true, initial, onSave() {}, onCancel() {}, ...extra }));
  const e1 = editor(BF);
  ok('the editor: Always / Only at set times (set times chosen), the days Mon first with Mon–Fri on, one time 06:00–11:00, the preview',
    /role="radio" aria-checked="true"[^>]*>Only at set times/.test(e1) && /aria-pressed="true"[^>]*>Mon</.test(e1) && /aria-pressed="false"[^>]*>Sat</.test(e1)
    && /value="06:00"/.test(e1) && /value="11:00"/.test(e1) && /data-testid="menu-hours-preview"[^>]*><span[^>]*>Mon–Fri, 06:00–11:00</.test(e1)
    && !/disabled=""[^>]*>Save hours/.test(e1), e1.slice(0, 300));
  const e2 = editor(null);
  ok('no hours yet: "Always available" chosen, the preview says Always', /role="radio" aria-checked="true"[^>]*>Always available/.test(e2) && />Always</.test(e2));
  const e3 = editor({ days: null, windows: [{ start: '10:00', end: '10:00' }] });
  ok('a time that is no time: the refusal in words before saving, Save disabled', /must differ/.test(e3) && /disabled=""[^>]*>Save hours/.test(e3));
  const e4 = editor({ days: null, windows: [{ start: '22:00', end: '02:00' }] }, { name: 'Alcohol', one: 'department', food: false });
  ok('a shop\'s words: "the Alcohol department", the licensed-hours example; past midnight explained',
    /When is the Alcohol department available\?/.test(e4) && /Alcohol only in licensed hours/.test(e4) && /runs past midnight/.test(e4) && !/Breakfast/.test(e4));
  const mp = read('apps/dashboard/src/pages/products/MenusPage.tsx');
  ok('MenusPage: an Hours button per menu, its hours in words ("Always available" when none), saved with PATCH { availability }',
    /data-testid="menu-hours-button"/.test(mp) && /'Always available'/.test(mp) && /api\.patch\(`\/api\/menus\/\$\{m\.id\}`, \{ availability \}\)/.test(mp)
    && /<MenuHoursEditor name=\{m\.name\} one=\{one\} food=\{isFoodService\(business\?\.type\)\}/.test(mp));

  console.log('\nS. the cloud\n');
  const route = read('apps/server/src/routes/menus.ts'), lib = read('apps/server/src/lib/menus.ts'), sc = read('apps/server/src/lib/syncChanges.ts');
  ok('PATCH and POST take availability through checkAvailability (400 in words); hours before migration 165 → 409, never a 500',
    /const v = cleanMenuAvailability\(b\.availability\); if \(!v\.ok\) \{ res\.status\(400\)/.test(route) && /const hours = cleanMenuAvailability\(req\.body\?\.availability\);/.test(route)
    && (route.match(/res\.status\(409\)\.json\(\{ error: NO_HOURS_YET \}\)/g) ?? []).length === 2
    && /export function cleanMenuAvailability\(v: unknown\): Clean<MenuAvailability \| null> \{\s*const r = checkAvailability\(v\);/.test(lib));
  ok('/pos/init: each menu with its hours (cleaned), and the menus still go before migration 165 (read again without the column)',
    /read\('id, name, sort_order, active, color, icon, availability'\)/.test(lib) && /if \(error && menusMissing\(error\)\) \(\{ data, error \} = await read\('id, name, sort_order, active, color, icon'\)\);/.test(lib)
    && /availability: readAvailability\(m\.availability\)/.test(lib));
  ok('/pos/changes: a changed menu carries its hours (155\'s trigger already writes the entry)', /availability: readAvailability\(r\.availability\) \}\)\);/.test(sc));
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
