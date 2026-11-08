/**
 * category-layout-8n.test.mjs — the branch's category layout on both POS (docs/SHARED-COMPONENTS-PLAN.md 8n).
 * Owner, 2026-11-05: "initially we used to have a horizontal navbar for categories then we introduced the current vertical
 * one can we have the option for both which can be toggled per branch by the manager? in the desktop app?" — and "yes we
 * are unifying them so no change hits one without the other being affected".
 *
 *   node --no-warnings tests/category-layout-8n.test.mjs
 *
 *   C  the rule, once (@zaptill/core/categoryLayout): 'panel' | 'top', absent or unknown = the panel; the cloud stores only
 *      those two; the words both POS show have no "till"; the change log's 'setup' topic carries it; a desktop POS may
 *      write the branch setting only with a person's PIN sign-in. Who: settings.pos_layout (owner, 2026-11-05: "lets go
 *      with your recommendations since in future we might get more items under POS layout") or settings.branches — a
 *      plain Manager's built-in keys pass, a Cashier's do not, settings.manage and the owner's '*' still do.
 *   R  the REAL shared pieces (@zaptill/ui/CategoryPanel) rendered (react-dom/server) in each app's look: with 'top' the
 *      CategoryBar — "All" and each category, in the owner's order, the menu chosen narrowing it ("All Drinks"), the
 *      chosen pill in the category's own colour, 48 px — and no ☰, no chip, no panel; with 'panel' exactly today (the ☰,
 *      the chip, the panel, no bar); the real useCategoryPanel hook carries the layout.
 *   S  the cloud: the key is a branch override (settings.branches, own branch), checked, sent with pos/init.
 *   W  the screens: the desktop POS, the web POS and its minimart screen read the branch's value and put the bar under the
 *      menu bar; a manager changes it in Manager › Settings (desktop) and Settings › Branches › the branch (web), in the
 *      same words.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — 2026-11-05):
 *   - CategoryBar without `if (panel.layout !== 'top') return null`          → R "panel: no bar"
 *   - PanelToggle without its 'top' guard                                     → R "top: no ☰"
 *   - the desktop's catPill without the colour style                         → R "the category's own colour"
 *   - categoryLayoutSettingValue accepting any string                         → C "only panel / top"
 *   - CONFIG_KEYS.setup without 'posCategoryLayout'                           → C "the change log carries it"
 *   - pos.ts init without posCategoryLayout                                   → S "sent with pos/init"
 *   - CATEGORY_LAYOUT_PERMISSIONS without 'settings.pos_layout'               → C "a plain Manager may"
 *   - the catalogue's settings.pos_layout without manager: true                → C "a plain Manager may"
 *   - branchSettingKeys without its pos_category_layout line                  → S "the gate is settings.pos_layout or …"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const dashReq = createRequire(path.join(ROOT, 'apps/dashboard/package.json'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 800)}`); fail++; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-8n-'));
try {
  // One bundle: the shared pieces with each app's look, the rules, the change-log topics, the desktop write guard.
  const entry = path.join(tmp, 'entry.tsx');
  const at = (p) => JSON.stringify(path.join(ROOT, p).replace(/\\/g, '/'));
  fs.writeFileSync(entry, `
export { default as DeskPanel, CategoryBar as DeskBar, PanelToggle as DeskToggle, CategoryChip as DeskChip } from ${at('apps/desktop/src/renderer/components/CategoryPanel.tsx')};
export { default as WebPanel, CategoryBar as WebBar, PanelToggle as WebToggle, CategoryChip as WebChip } from ${at('apps/dashboard/src/pages/pos/cashier/CategoryPanel.tsx')};
export { useCategoryPanel } from ${at('packages/ui/src/CategoryPanel.tsx')};
export * as LAYOUT from ${at('packages/core/src/categoryLayout.ts')};
export * as TOPICS from ${at('packages/core/src/syncTopics.ts')};
export * as GUARD from ${at('apps/server/src/lib/terminalWrites.ts')};
export * as PERMS from ${at('packages/core/src/permissions.ts')};
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';`);
  const out = path.join(tmp, 'ui.cjs');
  dashReq('esbuild').buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent', jsx: 'automatic',
    nodePaths: [path.join(ROOT, 'apps/dashboard/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
  const UI = createRequire(import.meta.url)(out);
  const h = UI.createElement, html = (el) => UI.renderToStaticMarkup(el);
  const { LAYOUT: L, TOPICS: T, GUARD: G, PERMS: P } = UI;

  console.log('\nC. The rule, once');
  ok('two layouts: the side panel and the top bar', L.CATEGORY_LAYOUTS.join() === 'panel,top' && L.CATEGORY_LAYOUT_KEY === 'pos_category_layout');
  ok('absent, unknown or garbled = the side panel (nobody\'s screen changes until a manager chooses)',
    [undefined, null, '', 'sideways', 42, {}].every((v) => L.categoryLayoutOf(v) === 'panel') && L.categoryLayoutOf('top') === 'top' && L.categoryLayoutOf(' TOP ') === 'top');
  ok('the cloud stores only panel / top', L.categoryLayoutSettingValue('panel') === 'panel' && L.categoryLayoutSettingValue('top') === 'top'
    && [undefined, null, '', 'sideways', 'left', 1, true].every((v) => L.categoryLayoutSettingValue(v) === null));
  const words = JSON.stringify(L.CATEGORY_LAYOUT_WORDS);
  ok('the words say POS, never till', /POS/.test(words) && !/\btill\b/i.test(words) && L.CATEGORY_LAYOUT_WORDS.options.map((o) => o.value).join() === 'panel,top');
  ok('the change log carries it: a setup setting by its key, answered with posCategoryLayout',
    T.settingTopic('pos_category_layout') === 'setup' && T.CONFIG_KEYS.setup.includes('posCategoryLayout'));
  ok('a desktop POS writes the branch setting only with a person\'s PIN sign-in (never its own token)',
    G.terminalWriteVerdict('desktop', 'POST', '/api/branches/br-1/settings', true) === 'manager'
    && G.terminalWriteVerdict('desktop', 'POST', '/api/branches/br-1/settings', false) === 'denied');

  const mayChange = (keys) => L.CATEGORY_LAYOUT_PERMISSIONS.some((k) => P.expandKeys(keys).has(k));
  const pl = P.PERMISSIONS.find((p) => p.key === 'settings.pos_layout');
  ok('its own right: settings.pos_layout, "POS layout", Settings, on both POS, a Manager\'s by default; settings.branches stays web',
    pl?.label === 'POS layout' && pl.group === 'settings' && pl.surface === 'both' && pl.manager === true && !/\btill\b/i.test(pl.description)
    && P.PERMISSIONS.find((p) => p.key === 'settings.branches').surface === 'web');
  ok('a plain Manager may (the built-in keys); a Cashier, a Waiter and a Supervisor may not',
    mayChange(P.defaultKeysForRoleName('Manager')) && !P.defaultKeysForRoleName('Manager').includes('settings.branches')
    && ['Cashier', 'Waiter', 'Supervisor'].every((r) => !mayChange(P.defaultKeysForRoleName(r))));
  ok('the owner\'s role and the General Manager hold it; settings.manage brings it; settings.branches alone is accepted',
    P.defaultKeysForRoleName('Owner').includes('settings.pos_layout') && mayChange(P.defaultKeysForRoleName('General Manager'))
    && P.expandKeys(['settings.manage']).has('settings.pos_layout') && mayChange(['settings.branches']));

  console.log('\nR. The shared pieces, rendered in each app\'s look');
  const menus = [{ id: 'food', name: 'Food', sort_order: 1 }, { id: 'drinks', name: 'Drinks', sort_order: 2 }];
  const categories = [
    { id: 'c-soda', name: 'Sodas', menu_id: 'drinks', color: '#3b82f6' },
    { id: 'c-burger', name: 'Burgers', menu_id: 'food', color: '#ef4444', icon: '🍔' },
    { id: 'c-fries', name: 'Fries', menu_id: 'food', color: null },
  ];
  const state = (layout, menu = 'all') => ({ prefs: { pinned: false, menu }, open: true, setOpen() {}, setPinned() {}, setMenu() {}, picked() {}, layout });
  const bar = (Bar, layout, activeCategory = 'all', menu = 'all') => html(h(Bar, { panel: state(layout, menu), categories, menus, activeMenu: menu,
    activeCategory, onCategory() {}, label: 'Categories' }));
  const pills = (s) => [...s.matchAll(/data-testid="category-bar-(?:all|pill)"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?([^<]+)</g)].map((m) => m[1]);
  const panelOf = (Panel, layout) => html(h(Panel, { panel: state(layout), categories, menus, products: [], activeMenu: 'all', activeCategory: 'all',
    onMenu() {}, onCategory() {}, overlay: false, menuBar: true }));
  for (const [app, Bar, Toggle, Chip, Panel, size, colour, accent] of [
    ['desktop', UI.DeskBar, UI.DeskToggle, UI.DeskChip, UI.DeskPanel, 'min-h-[48px]', 'background-color:#ef4444', 'bg-action-500'],
    ['web', UI.WebBar, UI.WebToggle, UI.WebChip, UI.WebPanel, 'min-height:48px', 'background:#ef4444', 'background:rgb(var(--act-strong']]) {
    const top = bar(Bar, 'top', 'c-burger');
    ok(`${app}: top — the bar: "All" and each category, in the owner's order (menu by menu)`, top.includes('data-testid="category-bar"')
      && pills(top).join() === 'All,Burgers,Fries,Sodas' && /role="tablist" aria-label="Categories"/.test(top), JSON.stringify(pills(top)) + top.slice(0, 300));
    const chosen = top.slice(top.indexOf('🍔') - 400, top.indexOf('🍔'));
    ok(`${app}: top — the chosen pill wears the category's own colour, 48 px (touch)`, chosen.includes('aria-selected="true"') && chosen.includes(colour) && chosen.includes(size), chosen);
    ok(`${app}: top — "All" chosen wears the app's accent; a category with no colour too`, bar(Bar, 'top', 'all').includes(accent)
      && bar(Bar, 'top', 'c-fries').slice(0, bar(Bar, 'top', 'c-fries').indexOf('>Fries<')).includes(accent));
    const drinks = bar(Bar, 'top', 'all', 'drinks');
    ok(`${app}: top — a menu chosen narrows the bar to its categories ("All Drinks")`, pills(drinks).join() === 'All Drinks,Sodas', JSON.stringify(pills(drinks)));
    ok(`${app}: top — no ☰, no chip, no panel`, html(h(Toggle, { panel: state('top') })) === ''
      && html(h(Chip, { label: 'Burgers', onClear() {}, panel: state('top') })) === '' && panelOf(Panel, 'top') === '');
    ok(`${app}: panel — no bar`, bar(Bar, 'panel', 'c-burger') === '');
    ok(`${app}: panel — exactly today: the ☰, the chip, the panel`, html(h(Toggle, { panel: state('panel') })).includes('data-testid="category-panel-toggle"')
      && html(h(Chip, { label: 'Burgers', onClear() {}, panel: state('panel') })).includes('data-testid="category-chip"')
      && html(h(Chip, { label: 'Burgers', onClear() {} })).includes('data-testid="category-chip"')
      && panelOf(Panel, 'panel').includes('data-testid="category-panel"'));
  }
  // The real hook (useCategoryPanel) gives the pieces the branch's layout.
  const Probe = ({ layout }) => {
    const p = UI.useCategoryPanel(layout);
    return h('div', null, h(UI.DeskToggle, { panel: p }), h(UI.DeskBar, { panel: p, categories, menus, activeMenu: 'all', activeCategory: 'all', onCategory() {} }));
  };
  const probeTop = html(h(Probe, { layout: 'top' })), probeStd = html(h(Probe, {}));
  ok('the real useCategoryPanel carries the layout: \'top\' — the bar, no ☰; nothing given — the ☰, no bar',
    probeTop.includes('category-bar') && !probeTop.includes('category-panel-toggle') && probeStd.includes('category-panel-toggle') && !probeStd.includes('category-bar'));
  const shared = read('packages/ui/src/CategoryPanel.tsx');
  ok('packages/ui holds no class names (each app\'s look lives in its own file); one sideways scroll for both bars',
    !/className=["{`]/.test(shared) && (shared.match(/useSideScroll\(/g) ?? []).length === 3 && (shared.match(/menuBarEdges\(/g) ?? []).length === 1);

  console.log('\nS. The cloud');
  const br = read('apps/server/src/routes/branches.ts');
  ok('a branch override, checked: only panel / top are stored', /const OVERRIDABLE_KEYS = \[[^\]]*CATEGORY_LAYOUT_KEY,[^\]]*\];/.test(br)
    && /if \(key === CATEGORY_LAYOUT_KEY\) \{\s*const clean = categoryLayoutSettingValue\(value\);\s*if \(clean === null\) \{ res\.status\(400\)/.test(br));
  const keysFn = br.slice(br.indexOf('export function branchSettingKeys'), br.indexOf('\n}\n', br.indexOf('export function branchSettingKeys')));
  ok('the gate is settings.pos_layout or settings.branches (one list, @zaptill/core/categoryLayout), on the person\'s own branch (assertBranchAccess) — the owner any',
    keysFn.includes('if (key === CATEGORY_LAYOUT_KEY) return [...CATEGORY_LAYOUT_PERMISSIONS];')
    && /requireAnyPermission\('settings\.branches', 'settings\.payments', 'receipt\.manage', 'settings\.pos_layout'\)/.test(br)
    && /if \(!assertBranchAccess\(req, req\.params\.id\)\)/.test(br));
  const pos = read('apps/server/src/routes/pos.ts');
  ok('sent with pos/init: the branch\'s own value, else the side panel', /'receipt_pay_account',\s*CATEGORY_LAYOUT_KEY\]\)/.test(pos)
    && pos.includes('posCategoryLayout: categoryLayoutOf(branchText[CATEGORY_LAYOUT_KEY]),'));

  console.log('\nW. The screens');
  const desk = read('apps/desktop/src/renderer/pages/POSPage.tsx');
  const cash = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  const mini = read('apps/dashboard/src/pages/pos/MinimartPOS.tsx');
  const order = (s) => { const a = s.indexOf('<MenuBar '), b = s.indexOf('<CategoryBar panel={catPanel}'), c = s.indexOf('<CategoryPanel panel={catPanel}'); return a > 0 && a < b && b < c; };
  ok('the desktop POS: the branch\'s value (main\'s cache, re-read after each pull) into the panel\'s state; the bar under the menu bar',
    /const load = \(\) => posApi\.pos\.categoryLayout\(\)\.then\(\(r\) => \{ if \(r\?\.layout\) setCategoryLayout\(r\.layout\); \}\)\.catch\(\(\) => \{\}\);\s*load\(\);\s*return posApi\.pos\.onCatalogueChanged\(load\);/.test(desk)
    && desk.includes('const catPanel = useCategoryPanel(categoryLayout);') && order(desk) && desk.includes('label={words.categories} />'));
  ok('the web POS: pos/init\'s value (usePOSData) into the panel\'s state, and to the minimart screen; the bar under the menu bar',
    read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts').includes('setCategoryLayout(categoryLayoutOf(init.posCategoryLayout));')
    && cash.includes('const catPanel = useCategoryPanel(categoryLayout);') && cash.includes('categoryLayout={categoryLayout}') && order(cash)
    && mini.includes('const catPanel = useCategoryPanel(categoryLayout);') && order(mini));
  ok('every screen tells the chip the layout', [desk, cash, mini].every((s) => /<CategoryChip label=\{[^}]+\} onClear=\{clearCatChip\} panel=\{catPanel\} \/>/.test(s)));
  ok('no screen keeps a category row of its own', [desk, cash, mini].every((s) => !/setActiveCategory\(cat\.id\)|s\.catRow|s\.catBtn/.test(s)));
  const deskSet = read('apps/desktop/src/renderer/components/CategoryLayoutPanel.tsx');
  const webSet = read('apps/dashboard/src/pages/settings/BranchReceiptOverrides.tsx');
  ok('the manager changes it — desktop Manager › Settings (settings.pos_layout or settings.branches), web Settings › Branches › the branch — in the same words',
    read('apps/desktop/src/renderer/components/SettingsPanel.tsx').includes('<CategoryLayoutPanel canEdit={canPosLayout} />')
    && read('apps/desktop/src/renderer/pages/ManagerPage.tsx').includes('canPosLayout={hasAny(...CATEGORY_LAYOUT_PERMISSIONS)}')
    && read('apps/desktop/src/main/ipc/branchSettings.ts').includes('requireKey([...CATEGORY_LAYOUT_PERMISSIONS],')
    && webSet.includes('const mayChange = CATEGORY_LAYOUT_PERMISSIONS.some((k) => can(k));')
    && /'settings\.pos_layout'\],\s+\/\/ 8n/.test(read('apps/dashboard/src/components/DashboardLayout.tsx'))
    && deskSet.includes('posApi.manage.setCategoryLayout(next)')
    && webSet.includes('<BranchCategoryLayout value={overrides[CATEGORY_LAYOUT_KEY]} onSave={(v) => save(CATEGORY_LAYOUT_KEY, v)} />')
    && [deskSet, webSet].every((s) => s.includes('CATEGORY_LAYOUT_WORDS.options.map(') && s.includes('{CATEGORY_LAYOUT_WORDS.title}') && s.includes('{CATEGORY_LAYOUT_WORDS.explain}')));
  ok('not premium: nothing about it asks for the online licence',
    ![deskSet, desk.slice(desk.indexOf('8n (owner, 2026-11-05)'), desk.indexOf('8n (owner, 2026-11-05)') + 600)].some((s) => /online|webPosEnabled|requireOnlineLicence/.test(s))
    && !/requireOnlineLicence\(\);\s*requireKey\(\['settings\.branches'\]/.test(read('apps/desktop/src/main/ipc/branchSettings.ts')));
} catch (e) {
  ok('the test ran to its end', false, e?.stack ?? String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
