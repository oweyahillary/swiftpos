/**
 * owner-decisions-a580.test.mjs — A580: the owner's decisions of 2026-10-23 on the 1.0.20 batch (web, cloud, shared).
 *
 *   L  Menu hours (A578): "let it remain as built, but add a 'Later' button to the menu list to show closed menus in
 *      greyed-out form" — packages/core/src/menuHours.ts `later` / laterPeek (closed menus greyed on the bar with when they open,
 *      their items shown greyed only in their own menu, nothing sold — A578's refusal word for word; Show all wins); the web
 *      MenuBar and LaterButton rendered; CashierScreen / MinimartPOS wiring (anyone, session only, only while a menu is closed).
 *   P  Loss alerts (A576): "Yes let them be premium" — every /api/loss-alerts route, the job, the bell and the daily-email
 *      block need the Analytics switch (feature_flags 'analytics'); the Watch list and the settings show the locked note.
 *   U  Retail setup's unused "Default weight unit": removed (the control, and the key from the settings route's lists).
 *   R  Shops and restaurant roles: "how can shops have waiter and kitchen roles unless requested keep them off" — Waiter,
 *      Kitchen and Kitchen Manager are a restaurant's or café's only (BUILT_IN_ROLES types); migration 169 (its own test,
 *      scripts/test-migration-169.mjs) takes the unused ones off shops.
 *   K  "Kots: 0" on shop receipts: gone (business.kitchenTickets false from the web's receipt config); a restaurant's bytes
 *      unchanged.
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/owner-decisions-a580.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A580 report):
 *   - menuHoursView's `if (opts.later)` branch removed                       → L "the closed menu joins the bar greyed" fails
 *   - laterPeek without the search check                                    → L "never in a search" fails
 *   - the later view's asleep map emptied (selling allowed)                 → L "nothing sold" fails
 *   - CashierScreen's Later gated on canShowAllMenus                        → L "for any staff member" fails
 *   - the loss-alerts router without the premium middleware                 → P "403 LOSS_ALERTS_OFF" fails
 *   - runLossAlertsForBusiness without the analyticsEnabled check           → P "the job skips" fails
 *   - lossEmailHtml without the premium check                               → P "no email block" fails
 *   - Waiter's `types: FOOD_BUSINESS_TYPES` dropped                         → R "a shop is not seeded" fails
 *   - buildReceiptBusinessConfig's kitchenTickets always true               → K "a shop's receipt has no Kots" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/lossAlertRules.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const DASH = path.join(ROOT, 'apps/dashboard');
const dreq = createRequire(path.join(DASH, 'package.json'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
const log = console.log;

const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.a580-'));
const bundle = (entry, out) => {
  dreq('esbuild').buildSync({ entryPoints: [path.join(DASH, entry)], bundle: true, format: 'esm', platform: 'node', outfile: path.join(bundleDir, out),
    logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'],
    define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'test-only', VITE_API_URL: '' }) } });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};
const React = dreq('react');
const { renderToStaticMarkup } = dreq('react-dom/server');
const h = React.createElement;

try {
  // ── L. Later ───────────────────────────────────────────────────────────────
  log('\nL. menu hours: "Later" (the closed menus greyed, view only)\n');
  const H = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/menuHours.ts')).href);
  const MF = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/menuFilter.ts')).href);
  const T = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/businessTerms.ts')).href);
  const at = (s) => new Date(s);
  // A shop: Groceries always; Alcohol Mon–Sat 17:00–23:00 (licensed hours). Friday 10:00.
  const ALC = { days: [1, 2, 3, 4, 5, 6], windows: [{ start: '17:00', end: '23:00' }] };
  const MS = [{ id: 'groc', name: 'Groceries', sort_order: 1, active: true, availability: null },
              { id: 'alc', name: 'Alcohol', sort_order: 2, active: true, availability: ALC }];
  const CS = [{ id: 'c-bread', menu_id: 'groc' }, { id: 'c-beer', menu_id: 'alc' }];
  const P = [{ id: 'bread', name: 'Bread', category_id: 'c-bread' }, { id: 'tusker', name: 'Tusker 500ml', category_id: 'c-beer' }];
  const FRI10 = at('2026-10-23T10:00:00');
  const plain = H.menuHoursView(MS, CS, FRI10);
  const later = H.menuHoursView(MS, CS, FRI10, { later: true });
  // The POS's grid rule with A580 (CashierScreen / POSPage): hidden by hours unless Later peeks into its own menu.
  const grid = (view, menu = 'all', category = 'all', search = '') => P.filter((p) =>
    MF.inMenuScope(p, MF.gridMenuScope(MF.menuScope(view.categories, view.menus, menu), search))
    && (category === 'all' || p.category_id === category) && p.name.toLowerCase().includes(search.toLowerCase())
    && (!H.hiddenByHours(p, view) || H.laterPeek(p, view, { menu, category, search }))).map((p) => p.id);

  await ok('default (Later off): A578 as built — Alcohol hidden, nothing greyed', () => {
    assert.deepEqual(plain.menus.map((m) => m.id), ['groc']);
    assert.equal(plain.later.size, 0);
    assert.ok(plain.anyAsleep, 'Later is offered');
  });
  await ok('Later on: the closed menu joins the bar greyed, with when it opens — "from 17:00 (Mon–Sat)"', () => {
    assert.deepEqual(later.menus.map((m) => m.id), ['groc', 'alc']);
    assert.deepEqual([...later.later], ['alc']);
    assert.equal(later.hints.alc, 'from 17:00 (Mon–Sat)');
    assert.deepEqual(MF.menuBarTabs(later.menus, later.categories).map((t) => t.id), ['all', 'groc', 'alc']);
    assert.ok(later.categories.some((c) => c.id === 'c-beer'), 'its categories in the panel');
  });
  await ok('…nothing sold: a tap or a scan is refused with A578\'s words, word for word', () => {
    const why = H.hoursRefusal(P[1], later);
    assert.equal(why, H.hoursRefusal(P[1], plain));
    assert.equal(why, 'Tusker 500ml is not sold at this time — Alcohol is Mon–Sat, 17:00–23:00.');
    assert.equal(H.hoursRefusal(P[0], later), null);
  });
  await ok('…its items show (greyed) only in its own menu or category — never on the All tab, never in a search', () => {
    assert.deepEqual(grid(later, 'alc'), ['tusker']);
    assert.deepEqual(grid(later, 'all', 'c-beer'), ['tusker']);
    assert.deepEqual(grid(later), ['bread']);
    assert.deepEqual(grid(later, 'all', 'all', 'tusk'), []);
    assert.equal(H.laterPeek(P[1], later, { menu: 'alc', category: 'c-beer', search: 'tusk' }), false, 'a search inside the greyed menu finds nothing closed');
    assert.ok(!grid(plain, 'alc').includes('tusker') && !grid(plain, 'all', 'c-beer').includes('tusker'), 'Later off: nothing peeks');
    assert.equal(H.laterPeek(P[0], later, { menu: 'groc' }), false, 'an open item is not a "later" one');
  });
  await ok('Show all wins over Later (a manager\'s sale switch): nothing greyed, nothing refused', () => {
    const both = H.menuHoursView(MS, CS, FRI10, { later: true, showAll: true });
    assert.equal(both.later.size, 0);
    assert.equal(both.asleep.size, 0);
    assert.equal(both.hints.alc, 'from 17:00');
  });
  await ok('nothing closed: no Later (anyAsleep false, nothing greyed); a menu that opens more than a day away names its days', () => {
    const open = H.menuHoursView(MS, CS, at('2026-10-23T18:00:00'), { later: true });
    assert.equal(open.anyAsleep, false); assert.equal(open.later.size, 0);
    const sun = H.menuHoursView(MS, CS, at('2026-10-25T10:00:00'), { later: true });
    assert.equal(sun.hints.alc, 'Mon–Sat');
    const daily = H.menuHoursView([{ id: 'bf', name: 'Breakfast', active: true, availability: { days: null, windows: [{ start: '06:00', end: '11:00' }] } }],
      [{ id: 'c', menu_id: 'bf' }], at('2026-10-23T13:00:00'), { later: true });
    assert.equal(daily.hints.bf, 'from 06:00');
  });
  await ok('one file: packages/core/src/menuHours.ts, no copies left', () => {
    assert.ok(read('packages/core/src/menuHours.ts').length > 0);
    for (const c of ['shared/menuHours.ts', 'apps/desktop/src/shared/menuHours.ts', 'apps/dashboard/src/lib/menuHours.ts', 'apps/server/src/lib/menuHours.ts']) assert.ok(!fs.existsSync(path.join(ROOT, c)), c);
  });

  const CP = await bundle('src/pages/pos/cashier/CategoryPanel.tsx', 'panel.mjs');
  await ok('the web bar: the closed menu greyed and dashed (its own test id), its hint; the Later button at the end', () => {
    const html = renderToStaticMarkup(h(CP.MenuBar, { tabs: MF.menuBarTabs(later.menus, later.categories), active: 'all', onPick() {},
      label: 'Departments', hints: later.hints, greyed: later.later, trailing: h(CP.LaterButton, { on: true, onToggle() {}, label: 'Departments' }) }));
    assert.equal((html.match(/data-testid="menu-bar-tab"/g) ?? []).length, 2, 'All and Groceries as before');
    assert.match(html, /data-testid="menu-bar-tab-later" data-later="true"[^>]*dashed[^>]*>Alcohol<span data-testid="menu-bar-hint"[^>]*>from 17:00 \(Mon–Sat\)<\/span>/);
    assert.match(html, /grayscale/);
    assert.match(html, /data-testid="menu-later" aria-pressed="true"[^>]*>.*Later ✕<\/button>/);
  });
  await ok('the Later button: "Later" (off) / "Later ✕" (on), in each business type\'s word (Departments, Groups, Menus)', () => {
    for (const type of ['restaurant', 'cafe', 'retail', 'minimart', 'petrol_station', 'parking', 'other']) {
      const word = T.businessTerms(type).menus;
      const off = renderToStaticMarkup(h(CP.LaterButton, { on: false, onToggle() {}, label: word }));
      assert.match(off, /aria-pressed="false"/);
      assert.match(off, new RegExp(`See the ${word.toLowerCase()} that open later \\(view only\\)`), type);
      assert.match(off, />Later<\/button>$/);
    }
  });
  await ok('CashierScreen: Later for ANY staff member (not menu.edit), only while a menu is closed, this session only; Show all stays the manager\'s and says it sells', () => {
    const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    assert.match(cs, /const \[laterMenus, setLaterMenus\] = useState\(false\);/);
    assert.match(cs, /useMenuHours\(menus, categories, \{ cutoff: getWebDayCutoff\(\), showAll: showAllMenus && canShowAllMenus, later: laterMenus \}\)/);
    assert.match(cs, /const laterButton = hours\.anyAsleep && !\(showAllMenus && canShowAllMenus\)\s*\n?\s*\? <LaterButton on=\{laterMenus\}/);
    assert.ok(!/localStorage[^\n]*later/i.test(cs), 'never stored');
    assert.match(cs, /const showAllButton = canShowAllMenus && hours\.anyAsleep \?/);
    assert.match(cs, /`Show all \$\{words\.menus\.toLowerCase\(\)\} · sell`/);
    assert.match(cs, /trailing=\{menuBarTrailing\} greyed=\{hours\.later\}/);
    assert.match(cs, /data-later=\{later \? 'true' : undefined\}\s*aria-disabled=\{soldOut \|\| later \|\| undefined\}/);
    assert.match(cs, /const addToCart = useCallback\(\s*\(product: Product\) => \{\s*if \(isFrozen\(product\)\) return;/, 'a greyed tile\'s tap is refused (isFrozen first)');
  });
  await ok('MinimartPOS (shops): greyed departments and tiles; a greyed tile\'s tap refused before any weight is asked', () => {
    const mm = read('apps/dashboard/src/pages/pos/MinimartPOS.tsx');
    assert.match(mm, /function pick\(product: Product\) \{\s*if \(outOfHours\?\.\(product\)\) \{ onAddToCart\(product\); return; \}/);
    assert.match(mm, /greyed=\{menuLater\}/);
    assert.match(mm, /const later = !!outOfHours\?\.\(product\);/);
    const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    assert.match(cs, /menuLater=\{hours\.later\}/);
    assert.match(cs, /peekLater=\{\(p: Product, scope[^)]*\) => laterPeek\(p as any, hours, scope\)\}/);
  });

  // ── P. premium loss alerts ─────────────────────────────────────────────────
  log('\nP. loss alerts are premium (the Analytics switch)\n');
  const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
  const mem = installMemDb(supabase);
  const AC = require(path.join(DIST, 'lib/authCache.js'));
  const J = require(path.join(DIST, 'jobs/lossAlerts.js'));
  const R = require(path.join(DIST, 'lib/lossAlertRules.js'));
  const { businessDateEAT } = require('@zaptill/core/businessDay');
  const warn = console.warn, logErr = console.error; console.warn = () => {}; console.error = () => {};
  const B = '11111111-1111-4111-8111-111111111111', B2 = '44444444-1111-4111-8111-111111111111';
  const W = '22222222-2222-4222-8222-222222222222';
  const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MAX = 'aaaaaaaa-0000-4000-8000-000000000002';
  const MARY = 'aaaaaaaa-0000-4000-8000-000000000005', JOHN = 'aaaaaaaa-0000-4000-8000-000000000006';
  const role = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
  const MGR = ['reports.voids', 'reports.overview', 'orders.view_all'];
  const NOW = new Date(Date.parse(businessDateEAT(new Date(), 0) + 'T09:00:00Z'));
  const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
  const BIZ = { id: B, owner_id: OWNER, name: 'Test Bar', type: 'restaurant', currency: 'KES', status: 'active' };
  const BIZ2 = { id: B2, owner_id: OWNER, name: 'Other Shop', type: 'retail', currency: 'KES', status: 'active' };
  const flag = (biz, on) => ({ id: `ff-${biz}`, business_id: biz, key: 'analytics', enabled: on });
  const reset = (flags) => {
    AC._resetAuthCache?.();
    mem.fail = () => null; mem.calls = [];
    const user = (id, name, r, branches, email) => ({ id, name, email, status: 'active', business_id: B, permissions_version: 0, role_id: `role-${id}`,
      roles: r, user_branches: branches.map((b) => ({ branch_id: b })), user_permissions: [] });
    const order = (id, by, minAgo, biz = B) => ({ id, business_id: biz, branch_id: W, cashier_id: by, voided_by: by, status: 'voided', voided_at: ago(minAgo), created_at: ago(minAgo + 5), total: 700 });
    mem.db = {
      businesses: [BIZ, BIZ2],
      branches: [{ id: W, business_id: B, name: 'Westlands', status: 'active' }],
      users: [user(OWNER, 'Owner', role('Admin'), [], 'owner@x.co'), user(MAX, 'Max', role('Manager', ...MGR), [W], 'max@x.co'),
        user(MARY, 'Mary', role('Cashier', 'orders.create'), [W], null), user(JOHN, 'John', role('Cashier', 'orders.create'), [W], null)],
      business_settings: [], branch_settings: [],
      shifts: [MARY, JOHN].map((s, i) => ({ id: `sh-${i}`, business_id: B, branch_id: W, cashier_id: s, opened_at: ago(120), status: 'open' })),
      orders: [...[1, 2, 3, 4, 5, 6].map((i) => order(`o-m${i}`, MARY, 10 + i)), order('o-j1', JOHN, 30)],
      payments: [...[1, 2, 3, 4, 5, 6].map((i) => ({ id: `pay-${i}`, order_id: `o-m${i}`, business_id: B, amount: 700, status: 'completed', method: 'cash' })),
        { id: 'pay-j', order_id: 'o-j1', business_id: B, amount: 700, status: 'completed', method: 'cash' }],
      business_days: [], order_price_variances: [], kitchen_voids: [], parking_sessions: [],
      loss_alerts: [], notifications: [], audit_log: [], refresh_tokens: [], sync_versions: [], sync_changes: [], feature_flags: flags,
      user_devices: [],
    };
  };

  await ok('the job skips a business without premium Analytics: nothing stored, nobody told (the bell stays quiet)', async () => {
    reset([]);
    const r = await J.runLossAlertsForBusiness(BIZ, NOW);
    assert.deepEqual([r.stored.length, mem.db.loss_alerts.length, mem.db.notifications.length], [0, 0, 0]);
    reset([flag(B, false)]);
    await J.runLossAlertsForBusiness(BIZ, NOW);
    assert.equal(mem.db.loss_alerts.length + mem.db.notifications.length, 0, 'switched off is off');
    reset([flag(B, true)]);
    const on = await J.runLossAlertsForBusiness(BIZ, NOW);
    assert.deepEqual(on.stored.map((a) => a.kind), ['paid_voids']);
    assert.ok(mem.db.notifications.some((n) => n.type === 'loss_alert' && n.user_id === OWNER), 'premium: the owner\'s bell');
  });
  await ok('the hourly tick reads only the premium businesses (one feature_flags read), never the others', async () => {
    reset([flag(B, true), flag(B2, false)]);
    mem.calls = [];
    await J.runLossAlertsTick(NOW);
    assert.ok(mem.db.loss_alerts.length > 0 && mem.db.loss_alerts.every((a) => a.business_id === B));
    reset([flag(B2, true)]);
    await J.runLossAlertsTick(NOW);
    assert.equal(mem.db.loss_alerts.filter((a) => a.business_id === B).length, 0, 'B is not premium now: skipped');
    reset([]);
    await J.runLossAlertsTick(NOW);
    assert.equal(mem.db.loss_alerts.length, 0, 'no premium business: nothing');
  });
  await ok('the daily email has no "Worth a look" block without premium; with it, as A576', async () => {
    reset([]);
    // an alert already stored for today (written while the business still had premium): still no block
    mem.db.loss_alerts.push({ id: 'cccccccc-0000-4000-8000-000000000009', business_id: B, branch_id: W, staff_id: MARY, alert_key: 'k9',
      kind: 'paid_voids', period: 'day', business_date: businessDateEAT(NOW, 0), count: 6, score: 90, message: 'Mary voided 6 paid orders today (others: 0–1). Worth a look.',
      link: '/dashboard/reports?tab=voids', notified_at: null, dismissed_at: null });
    assert.equal(await J.lossEmailHtml(BIZ, ['owner@x.co'], NOW), '');
    reset([flag(B, true)]);
    assert.match(await J.lossEmailHtml(BIZ, ['owner@x.co'], NOW), /Worth a look/);
  });

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const app = express();
  app.use(express.json());
  app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, isOwner: false, surface: 'dashboard', ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const TK = { owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'] }),
               max: sign({ userId: MAX, branchId: W, permissionKeys: MGR }) };
  const call = async (method, p, token, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body: json };
  };
  try {
    await ok('not premium: every /api/loss-alerts route answers 403 LOSS_ALERTS_OFF in plain words (the watch list, looked into, the settings)', async () => {
      reset([]);
      for (const [m, p, tk, body] of [['GET', '/api/loss-alerts', TK.owner], ['GET', '/api/loss-alerts/settings', TK.owner],
        ['PUT', '/api/loss-alerts/settings', TK.owner, { settings: { enabled: true } }], ['GET', '/api/loss-alerts', TK.max],
        ['PATCH', '/api/loss-alerts/cccccccc-0000-4000-8000-000000000001/dismiss', TK.max, {}]]) {
        const r = await call(m, p, tk, body);
        assert.equal(r.status, 403, `${m} ${p}`);
        assert.equal(r.body.code, 'LOSS_ALERTS_OFF', `${m} ${p}`);
        assert.equal(r.body.error, R.LOSS_OFF_MESSAGE);
      }
      assert.match(R.LOSS_OFF_MESSAGE, /ZapTill Premium/);
      assert.equal(mem.db.business_settings.length, 0, 'nothing saved');
    });
    await ok('premium: the routes as A576 — the settings still the OWNER\'s only (a manager refused)', async () => {
      reset([flag(B, true)]);
      assert.equal((await call('GET', '/api/loss-alerts', TK.owner)).status, 200);
      assert.equal((await call('GET', '/api/loss-alerts/settings', TK.owner)).status, 200);
      const m = await call('GET', '/api/loss-alerts/settings', TK.max);
      assert.equal(m.status, 403); assert.notEqual(m.body.code, 'LOSS_ALERTS_OFF');
      assert.equal((await call('GET', '/api/loss-alerts', TK.max)).status, 200, 'the manager\'s watch list (reports.voids)');
    });
  } finally { server.close(); console.warn = warn; console.error = logErr; }

  // The page's module reads the browser's location and storage when loaded (the api client): a minimal stand-in (as A576's test).
  const store = new Map();
  globalThis.window ??= { location: new URL('http://localhost:5173/dashboard'), addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
  globalThis.localStorage ??= { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.sessionStorage ??= globalThis.localStorage;
  const WL = await bundle('src/pages/WatchListPage.tsx', 'watch.mjs');
  await ok('the Watch list (dashboard and manager portal) and the Loss prevention tab show the premium note on LOSS_ALERTS_OFF', () => {
    const html = renderToStaticMarkup(h(WL.WatchListLocked, { message: R.LOSS_OFF_MESSAGE }));
    assert.match(html, /data-testid="watch-list-locked"/);
    assert.match(html, /ZapTill Premium/);
    assert.match(html, /The Watch list is part of ZapTill Premium — contact ZapTill to enable it\./);
    assert.equal(WL.LOSS_OFF_CODE, R.LOSS_OFF_CODE);
    const page = read('apps/dashboard/src/pages/WatchListPage.tsx'), tab = read('apps/dashboard/src/pages/settings/LossAlertsTab.tsx');
    assert.match(page, /if \(e\?\.code === LOSS_OFF_CODE\) \{ setLocked\(e\?\.message \?\? ''\); return; \}/);
    assert.match(page, /if \(locked !== null\) return <WatchListLocked message=\{locked\} \/>;/);
    assert.match(tab, /if \(e\?\.code === LOSS_OFF_CODE\) setLocked\(e\?\.message \?\? ''\);/);
    assert.match(tab, /if \(!isOwner\) return <div[^>]*>Only the owner can change loss-prevention alerts\.<\/div>;\s*\n\s*if \(locked !== null\) return <WatchListLocked/, 'owner-only first, then the premium note');
    assert.ok(read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx').includes('<WatchListPanel client={posApi} isOwner={false} portal />'), 'the portal uses the same panel');
  });
  await ok('the route and the job read the same switch as Analytics (feature_flags \'analytics\')', () => {
    const route = read('apps/server/src/routes/lossAlerts.ts'), job = read('apps/server/src/jobs/lossAlerts.ts');
    assert.match(route, /router\.use\(async \(req, res, next\) => \{\s*if \(!\(await analyticsEnabled\(req\.businessId\)\)\)/);
    assert.match(job, /\.from\('feature_flags'\)\.select\('business_id'\)\s*\n?\s*\.eq\('key', ANALYTICS_FLAG\)\.eq\('enabled', true\)/);
  });

  // ── U. the unused weight unit ──────────────────────────────────────────────
  log('\nU. Retail setup: "Default weight unit" removed\n');
  await ok('the Retail setup page no longer offers it; the settings route no longer reads or writes weight_unit', () => {
    const page = read('apps/dashboard/src/pages/settings/MinimartSettingsPage.tsx');
    assert.ok(!/>Default weight unit<|saveSetting\('weight_unit'|settings\['weight_unit'\]|Unit displayed for weighed items/.test(page));
    const { BUSINESS_SETTING_KEYS } = require(path.join(DIST, 'routes/business.js'));
    assert.equal(BUSINESS_SETTING_KEYS.has('weight_unit'), false);
    assert.ok(BUSINESS_SETTING_KEYS.has('scanner_beep'), 'its neighbours stay');
    assert.ok(!/'weight_unit'(?!\s+gone)/.test(read('apps/server/src/routes/business.ts')));
  });

  // ── R. roles ───────────────────────────────────────────────────────────────
  log('\nR. Waiter, Kitchen and Kitchen Manager: a restaurant\'s or café\'s only\n');
  const PM = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
  const seed = require(path.join(DIST, 'lib/defaultRolePermissions.js'));
  const KITCHEN_ROLES = ['Waiter', 'Kitchen', 'Kitchen Manager'];
  await ok('every business type: a restaurant and a café get them; a shop, a petrol station, a car park and "other" do not — Cashier, Supervisor, Manager for all', () => {
    for (const type of ['restaurant', 'cafe', 'retail', 'minimart', 'petrol_station', 'parking', 'other']) {
      const names = PM.builtInRolesFor(type).map((r) => r.name);
      const food = type === 'restaurant' || type === 'cafe';
      for (const n of KITCHEN_ROLES) assert.equal(names.includes(n), food, `${type}: ${n}`);
      for (const n of ['Manager', 'Cashier', 'Supervisor', 'Storekeeper', 'Accountant']) assert.ok(names.includes(n), `${type}: ${n}`);
      const seeded = seed.seededRoleRows('b1', 'Admin', type).map((r) => r.name);
      for (const n of KITCHEN_ROLES) assert.equal(seeded.includes(n), food, `seeded ${type}: ${n}`);
    }
    assert.deepEqual([...PM.FOOD_BUSINESS_TYPES], ['restaurant', 'cafe']);
  });
  await ok('their keys are unchanged (the frozen catalogue untouched); a shop that becomes a restaurant is given them', () => {
    assert.deepEqual([...PM.BUILT_IN_ROLES.find((r) => r.name === 'Kitchen').keys], ['products.view']);
    assert.deepEqual(seed.typeRolesMissing('restaurant', ['Admin', 'Cashier']).map((r) => r.name), KITCHEN_ROLES);
    assert.deepEqual(seed.typeRolesMissing('minimart', ['Admin']).map((r) => r.name), []);
    assert.ok(fs.existsSync(path.join(ROOT, 'migrations/169_shop_kitchen_roles.sql')), 'migration 169 for the shops that have them');
  });

  // ── K. Kots on shop receipts ───────────────────────────────────────────────
  log('\nK. no "Kots" line on a shop\'s receipt\n');
  const BR = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/buildReceiptOrder.ts')).href);
  const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);
  const biz = (type) => BR.buildReceiptBusinessConfig({ id: 'b', name: 'Magas Limited', type, currency: 'KES', owner_id: 'o', status: 'active' }, undefined, 0, {});
  const order = BR.buildReceiptOrder({ orderNumber: 'T1-0042', orderType: 'retail', cashierName: 'Mary', total: 150, change: 50,
    payments: [{ method: 'cash', amount: 200 }],
    cart: [{ product: { id: 'p1', name: 'Bread', base_price: 75 }, quantity: 2, unitPrice: 75, lineTotal: 150, modifiers: [] }] });
  const text = (bytes) => Buffer.from(bytes).toString('latin1');
  await ok('the receipt config per business type: a restaurant or café (or a type not known yet) has kitchen tickets; every other type not', () => {
    for (const [t, want] of [['restaurant', true], ['cafe', true], ['', true], [undefined, true], ['retail', false], ['minimart', false],
      ['petrol_station', false], ['parking', false], ['other', false], ['Petrol Station', false]]) assert.equal(biz(t).kitchenTickets, want, String(t));
  });
  await ok('a shop\'s web receipt has no "Kots"; a restaurant\'s still does, its bytes the same as without the switch', () => {
    const shop = E.renderReceiptEscPos(order, biz('retail'), 80), rest = E.renderReceiptEscPos(order, biz('restaurant'), 80);
    assert.ok(!/Kots/.test(text(shop)), 'shop');
    assert.match(text(rest), /Kots: 0/);
    const { kitchenTickets, ...asBefore } = biz('restaurant');
    assert.ok(Buffer.from(rest).equals(Buffer.from(E.renderReceiptEscPos(order, asBefore, 80))), 'restaurant bytes unchanged');
    for (const t of ['minimart', 'petrol_station', 'parking', 'other']) assert.ok(!/Kots/.test(text(E.renderReceiptEscPos(order, biz(t), 58))), t);
  });
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
}

log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
