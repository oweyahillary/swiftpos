/**
 * analytics-together-a575.test.mjs — A575: "What sells together" on Analytics, and Analytics in each business type's words.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/analytics-together-a575.test.mjs
 *
 * R. The rules (apps/server/src/lib/analyticsRules.ts, compiled) and the words (shared/analyticsTerms.ts and businessTerms.ts):
 *    - too few orders with two or more items (under 30): nothing, a friendly note;
 *    - a pair is turned so the item with fewer orders comes first ("People who buy X usually / often / sometimes add Y
 *      (n of m orders with X)"); a pair in under 5 orders, or not 1.2× as often as chance, is left out;
 *    - the ranking (orders together × how much more often than chance, capped at 5×) and the cap at 10 with the total;
 *    - the cards: at most 2, no product in both, the card thresholds; no KES, never a price;
 *    - each business type's advice (a combo; the same shelf; at the pumps when one is fuel; the forecourt shop; offer
 *      together) and Analytics' words (Product performance / Cost of sales for a shop); a scan of every wording for a
 *      price rise.
 * H. The route over HTTP — the COMPILED analytics router behind the REAL requireAuth (the A549 / A565 harness), supabase.rpc
 *    answered by the REAL migration-164 function in PGlite: the flag, the shape (top 10, no internal list), the business
 *    type's words, a manager held to their own branch, too few orders at Kilimani, the cards in /recommendations, before
 *    164 runs (503 here, /recommendations still answers), the cache.
 * P. The page: TogetherSection and the Costs area rendered (esbuild + react-dom/server); the page's wiring.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A575 report):
 *   - summariseTogether without the TOGETHER_MIN_BASKETS check                    → "too few orders" fails
 *   - summariseTogether keeping every pair (no TABLE_TOP cap)                     → "cap at 10" fails
 *   - summariseTogether never turning the pair (a is always the smaller id)       → "the direction" fails
 *   - the cards without the "no product in two cards" rule                         → "the cards" fails
 *   - togetherAdvice giving a shop the restaurant's combo words                   → "each business type" fails
 *   - the /together route sending the internal `strong` list                      → "route: shape" fails
 *   - analyticsWords giving a shop "Menu engineering"                             → "Analytics words" and "page" fail
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openSchema, seedAnalytics } from '../scripts/lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const DASH = path.join(ROOT, 'apps/dashboard');
if (!fs.existsSync(path.join(DIST, 'routes/analytics.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n      ')}`); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const R = require(path.join(DIST, 'lib/analyticsRules.js'));
// shared/analyticsTerms.ts imports './businessTerms' (no extension, as the apps build it): bundled once with esbuild
const BT = await (async () => {
  const os = await import('node:os');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a575-')), 'terms.mjs');
  await createRequire(path.join(DASH, 'package.json'))('esbuild').build({ entryPoints: [path.join(ROOT, 'shared/analyticsTerms.ts')], bundle: true,
    format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  const A = await import(pathToFileURL(out).href);
  const T = await import(pathToFileURL(path.join(ROOT, 'shared/businessTerms.ts')).href);
  return { ...T, ...A };
})();
const TYPES = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'];
/** Never a price rise, a discount or a KES figure in what the owner reads (the owner: "prices should be competitive"). */
const PRICE_WORDS = /\bprices?\b|\brais(e|es|ed|ing)\b|increase|re-?pric|discount|cheaper|mark ?up|\bdeal\b/i;
/** …and no KES figure ("No KES estimate", which says there is none, is the cards' own wording). */
const PRICE = { test: (t) => PRICE_WORDS.test(t) || /\bKES\b/.test(String(t).replace(/No KES estimate/g, '')) };

// ── R. The rules ──────────────────────────────────────────────────────────────
console.log('\nA575 — what sells together, and Analytics in each business type\'s words\n\nR. the rules\n');
const total = (orders, multi) => ({ kind: 'total', orders, multi_orders: multi, a_id: null, a_name: null, a_fuel: null, a_orders: null, b_id: null, b_name: null, b_fuel: null, b_orders: null, together: null });
const pair = (a, an, ao, b, bn, bo, together, extra = {}) => ({ kind: 'pair', orders: null, multi_orders: null, a_id: a, a_name: an, a_fuel: false, a_orders: ao, b_id: b, b_name: bn, b_fuel: false, b_orders: bo, together, ...extra });
// 2000 orders, 600 with two or more items. Wrap (id z) in 120, Soda (id a) in 300, together 38 → Wrap comes first.
const base = () => [total(2000, 600), pair('a', 'Soda 500ml', 300, 'z', 'Chicken Wrap', 120, 38)];

await ok('too few orders with two or more items: nothing listed, a friendly note, no card', () => {
  const t = R.summariseTogether([total(400, 29), pair('a', 'Soda', 300, 'z', 'Wrap', 120, 38)], 'restaurant');
  assert.deepEqual([t.enough, t.pairs.length, t.total], [false, 0, 0]);
  assert.equal(t.note, 'Not enough orders with two or more items yet (29 of the 30 needed) — try a longer period.');
  assert.deepEqual(R.recTogether({ days: 30, together: t }), []);
  assert.equal(R.summariseTogether([total(400, 30), ...base().slice(1)]).enough, true, '30 is enough');
});
await ok('the direction and the sentence: the item with fewer orders first; usually / often / sometimes', () => {
  const t = R.summariseTogether(base(), 'restaurant');
  const p = t.pairs[0];
  assert.deepEqual([p.aName, p.bName, p.together, p.aOrders, p.bOrders], ['Chicken Wrap', 'Soda 500ml', 38, 120, 300]);
  assert.equal(p.sentence, 'People who buy Chicken Wrap often add Soda 500ml (38 of 120 orders with Chicken Wrap)');
  assert.ok(Math.abs(p.lift - (38 * 2000) / (120 * 300)) < 1e-9);
  assert.deepEqual([R.togetherWord(0.5), R.togetherWord(0.25), R.togetherWord(0.2)], ['usually', 'often', 'sometimes']);
});
await ok('a pair in under 5 orders, or not 1.2× as often as chance, is left out; Nothing goes together: a note', () => {
  const t = R.summariseTogether([total(500, 200), pair('a', 'A', 10, 'b', 'B', 10, 4), pair('c', 'C', 300, 'd', 'D', 300, 200)]);
  assert.deepEqual([t.enough, t.pairs.length], [true, 0], '4 together; 200×500/(300×300) = 1.11');
  assert.match(t.note, /buy each item for itself/);
});
await ok('the ranking (together × how much more often than chance, capped at 5×) and the cap at 10 with the total', () => {
  const rows = [total(10000, 4000)];
  for (let i = 0; i < 15; i++) rows.push(pair(`a${String(i).padStart(2, '0')}`, `Item ${i}`, 100, `b${String(i).padStart(2, '0')}`, `Other ${i}`, 100, 10 + i));
  rows.push(pair('r1', 'Rare one', 5, 'r2', 'Rare two', 5, 5));   // lift 200 — capped at 5: 25, not first
  const t = R.summariseTogether(rows);
  assert.equal(t.pairs.length, 10);
  assert.equal(t.total, 16);
  assert.deepEqual(t.pairs.slice(0, 2).map((p) => p.together), [24, 23], 'most together first (every lift above 5)');
  assert.ok(!t.pairs.some((p) => p.aName === 'Rare one'), 'two rare items never outrank a habit');
  assert.ok(!('score' in t.pairs[0]), 'the internal score stays inside');
});
await ok('the cards: at most 2, no product in both, 10 orders and 15% and 1.5× needed; no KES, the evidence', () => {
  const rows = [total(1000, 400),
    pair('w', 'Wrap', 100, 's', 'Soda', 200, 60),     // lift 3: card 1
    pair('w', 'Wrap', 100, 'c', 'Chips', 150, 40),    // shares Wrap: never a second card
    pair('t', 'Tea', 50, 'm', 'Mandazi', 60, 20),     // card 2
    pair('x', 'Bread', 100, 'y', 'Milk', 100, 9)];    // 9 together: listed, no card
  const t = R.summariseTogether(rows, 'restaurant');
  assert.deepEqual(t.strong.map((p) => `${p.aName}+${p.bName}`), ['Wrap+Soda', 'Tea+Mandazi']);
  const cards = R.recTogether({ days: 30, together: t });
  assert.equal(cards.length, 2);
  for (const c of cards) {
    assert.deepEqual([c.kind, c.impact, c.impactKind, c.impactPer, c.evidence, c.warning], ['together', null, null, null, 'together', false]);
    assert.ok(!PRICE.test(`${c.title} ${c.why} ${c.assumption}`), c.title);
  }
  assert.equal(cards[0].title, 'Offer Soda with Wrap');
  assert.equal(cards[0].why, 'People who buy Wrap usually add Soda (60 of 100 orders with Wrap). Make them a combo, or remind cashiers and waiters to offer Soda with every Wrap.');
  assert.equal(cards[0].confidence, 'high');
  assert.equal(cards[1].confidence, 'medium', '20 together');
  const one = R.summariseTogether([total(10000, 4000), pair('w', 'Wrap', 100, 's', 'Soda', 900, 12)]);
  assert.equal(one.strong.length, 0, 'lift 12×10000/(100×900) = 1.33 — listed, no card');
  assert.equal(one.pairs.length, 1);
  const all = R.allRecommendations({ days: 30, costs: false, menu: null, heatmap: null, leaks: null, credit: null, times: null, together: t });
  assert.equal(all.filter((r) => r.kind === 'together').length, 2, 'in every card the rules give');
  assert.equal(R.valueFound(all).monthly, 0, 'never a KES gain');
});
await ok('each business type: a combo, the same shelf, at the pumps (fuel), the forecourt shop, offer together', () => {
  const W = { name: 'Chicken Wrap' }, S = { name: 'Soda 500ml' };
  for (const t of ['restaurant', 'cafe', null]) {
    const a = BT.togetherAdvice(t, W, S);
    assert.equal(a.title, 'Offer Soda 500ml with Chicken Wrap', String(t));
    assert.match(a.action, /combo/);
  }
  for (const t of ['retail', 'minimart']) {
    const a = BT.togetherAdvice(t, { name: 'Bread' }, { name: 'Milk 500ml' });
    assert.equal(a.title, 'Put Milk 500ml next to Bread', t);
    assert.match(a.action, /same shelf or near the till/);
    assert.doesNotMatch(a.action, /combo|waiter|kitchen/);
  }
  const fuel = BT.togetherAdvice('petrol_station', { name: 'Water 1L' }, { name: 'Diesel', fuel: true });
  assert.equal(fuel.title, 'Offer Water 1L at the pumps');
  assert.match(fuel.action, /Customers who buy Diesel often take Water 1L: .*pump island.*attendants/);
  const shop = BT.togetherAdvice('petrol_station', { name: 'Engine oil' }, { name: 'Coolant' });
  assert.equal(shop.title, 'Put Coolant next to Engine oil');
  assert.match(shop.action, /forecourt shop/);
  for (const t of ['parking', 'other']) {
    const a = BT.togetherAdvice(t, { name: 'Parking 1 hr' }, { name: 'Car wash' });
    assert.equal(a.title, 'Offer Car wash with Parking 1 hr', t);
    assert.doesNotMatch(a.action, /combo|shelf|pump|kitchen|waiter/);
  }
  // the route's words come through the rules: a shop's card is a shop's
  const t = R.summariseTogether([total(1000, 400), pair('w', 'Bread', 100, 's', 'Milk', 200, 60)], 'minimart');
  assert.equal(R.recTogether({ days: 30, together: t })[0].title, 'Put Milk next to Bread');
  const f = R.summariseTogether([total(1000, 400), pair('w', 'Water 1L', 100, 's', 'Petrol', 300, 60, { b_fuel: true })], 'petrol_station');
  assert.equal(f.pairs[0].advice.title, 'Offer Water 1L at the pumps');
});
await ok('never a price: every type\'s words, the sentence and the notes', () => {
  for (const t of TYPES) {
    const a = BT.togetherAdvice(t, { name: 'A' }, { name: 'B', fuel: true });
    const b = BT.togetherAdvice(t, { name: 'A' }, { name: 'B' });
    for (const x of [a, b]) assert.ok(!PRICE.test(`${x.title} ${x.action} ${x.short}`), `${t}: ${x.action}`);
  }
  const src = read('apps/server/src/lib/analyticsRules.ts');
  const together = src.slice(src.indexOf('// ── A575: what sells together'));
  const strings = together.match(/`[^`]*`|'[^'\n]*'/g).filter((s) => / /.test(s));
  for (const s of strings) assert.ok(!PRICE.test(s), s);
  const page = read('apps/dashboard/src/pages/analytics/together.tsx');
  assert.ok(!/raise|increase price|price rise/i.test(page));
});
await ok('Analytics words: Product performance, items you sell, cost of sales for a shop; a restaurant keeps its own', () => {
  for (const t of TYPES) {
    const w = BT.analyticsWords(t);
    const food = t === 'restaurant' || t === 'cafe';
    assert.equal(w.itemsArea, food ? 'Menu engineering' : 'Product performance', t);
    assert.equal(w.costOfSales, food ? 'Food cost' : 'Cost of sales', t);
    if (!food) {
      const all = Object.values(w).join(' ');
      assert.doesNotMatch(all, /\bmenu\b|kitchen|\bfood\b|\bdish|recipe|portion|serving/i, t);
    }
  }
  assert.equal(BT.analyticsWords(null).itemsArea, 'Menu engineering', 'not known yet: as before');
  // the cloud's cards and tiles in a shop's words
  const cw = { foodCost: { now: 0.4, prev: 0.3, change: 0.1, costedShare: 1, movers: [{ name: 'Sugar 2kg', now: 0.5, prev: 0.3 }] }, noCost: { total: 0 } };
  const hooks = (businessType) => R.tileHooks({ costs: true, seesCredit: false, menu: null, heatmap: null, leaks: null, credit: null, stockUse: null, customers: null, costWatch: cw, recommendations: [], businessType });
  assert.equal(hooks('retail').costs.text, 'Cost of sales 40%');
  assert.equal(hooks('restaurant').costs.text, 'Food cost 40%');
  assert.equal(hooks(undefined).costs.text, 'Food cost 40%', 'unknown: as before');
  const src = read('apps/server/src/lib/analyticsRules.ts');
  assert.match(src, /title: `Your \$\{cos\} rose from/);
  assert.match(src, /a shorter list frees shelf space/);
  for (const c of ['apps/dashboard/src/lib/businessTerms.ts', 'apps/desktop/src/shared/businessTerms.ts', 'apps/server/src/lib/businessTerms.ts']) assert.equal(read(c), read('shared/businessTerms.ts'), c);
  for (const c of ['apps/dashboard/src/lib/analyticsTerms.ts', 'apps/server/src/lib/analyticsTerms.ts']) assert.equal(read(c), read('shared/analyticsTerms.ts'), c);
  assert.ok(!fs.existsSync(path.join(ROOT, 'apps/desktop/src/shared/analyticsTerms.ts')), 'the till has no Analytics: not in its first screen');
  assert.doesNotMatch(read('shared/businessTerms.ts'), /analyticsWords|togetherAdvice/);
  assert.match(read('scripts/check-shared-sync.mjs'), /'apps\/server\/src\/lib\/businessTerms\.ts'/);
  assert.match(read('scripts/check-shared-sync.mjs'), /name: 'analyticsTerms\.ts'/);
});
await ok('Help: a shop never reads the kitchen-ticket step; a restaurant (or a type not known yet) does', async () => {
  const H = await import(pathToFileURL(path.join(ROOT, 'shared/helpTopics.ts')).href);
  const printer = (food) => H.helpTopicsFor(food).find((t) => t.id === 'printer');
  assert.ok(printer(true).steps.some((s) => /kitchen ticket/i.test(s)));
  assert.ok(!printer(false).steps.some((s) => /kitchen/i.test(s)));
  assert.equal(printer(false).steps.length, printer(true).steps.length - 1);
  assert.equal(H.helpTopicsFor(true), H.HELP_TOPICS, 'unchanged for food');
  for (const t of TYPES) assert.equal(H.helpTopicsFor(BT.isFoodService(t)).some((x) => x.steps.some((s) => /kitchen/i.test(s))), t === 'restaurant' || t === 'cafe', t);
  assert.match(read('apps/dashboard/src/pages/HelpPage.tsx'), /const HELP_TOPICS = helpTopicsFor\(isFoodService\(businessType\)\);/);
  assert.match(read('apps/desktop/src/renderer/components/HelpScreen.tsx'), /const HELP_TOPICS = helpTopicsFor\(isFoodService\(businessType\)\);/);
  assert.match(read('apps/server/src/routes/business.ts'), /res\.json\(\{ support, businessType:/);
});
await ok('the upload template\'s menu line and the till\'s category list in a shop\'s words', () => {
  const m = read('apps/dashboard/src/pages/products/MenuUpload.tsx');
  assert.match(m, /: \[`MENU \(optional\): the product's \$\{group\}, e\.g\. \$\{terms\.menuExamples\[0\]\}/);
  assert.match(m, /const group = terms\.menu\.toLowerCase\(\);/);
  const t = read('apps/desktop/src/renderer/pages/ManageTabs.tsx');
  assert.match(t, /<option value="">\{terms\.noMenu\}<\/option>/);
  assert.doesNotMatch(t, />No menu</);
  assert.equal(BT.businessTerms('retail').noMenu, 'No department');
});

// ── H. The route over HTTP ───────────────────────────────────────────────────
console.log('\nH. the route over HTTP, the SQL in PGlite\n');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const ROUTE = require(path.join(DIST, 'routes/analytics.js'));
const { invalidateDayCutoff } = require(path.join(DIST, 'lib/dayCutoff.js'));

const pg = await openSchema({ through: 164 });
const S = await seedAnalytics(pg);
// Westlands, 15:00 EAT on 19 October: 40 Burger + Soda, 10 Chips + Tea, 10 Burger alone, 30 Soda alone, 100 Salad alone
// (the A549 scenario adds one order each of Wings, Burger, Combo, Chips, Tea, Soda, Salad). Burger 51, Soda 71, orders
// 197 → Burger + Soda 2.2× as often as chance: "People who buy Burger usually add Soda (40 of 51 orders with Burger)".
// Kilimani: 12 Burger + Chips (too few to say anything there).
{
  let n = 0;
  const order = async (branch, lines) => {
    n += 1;
    const row = await pg.put('orders', { business_id: S.A, branch_id: branch, order_number: `G-${n}`, status: 'completed', subtotal: 100, total: 100, discount_amount: 0, created_at: '2026-10-19T12:00:00Z', cashier_id: S.EVE });
    for (const [pid, name] of lines) await pg.put('order_items', { order_id: row.id, product_id: pid, product_name: name, quantity: 1, unit_price: 100, subtotal: 100 });
  };
  const B = [S.BURGER, 'Burger'], SO = [S.SODA, 'Soda'], C = [S.CHIPS, 'Chips'], T = [S.TEA, 'Tea'], SA = [S.SALAD, 'Salad'];
  for (let i = 0; i < 40; i++) await order(S.W, [B, SO]);
  for (let i = 0; i < 10; i++) await order(S.W, [C, T]);
  for (let i = 0; i < 10; i++) await order(S.W, [B]);
  for (let i = 0; i < 30; i++) await order(S.W, [SO]);
  for (let i = 0; i < 100; i++) await order(S.W, [SA]);
  for (let i = 0; i < 12; i++) await order(S.K, [B, C]);
}

const id = () => randomUUID();
const OWNER = id(), MGR = S.MGR, R_MGR = id();
const KEYS = ['reports.sales'];
const PID = Object.fromEntries(KEYS.map((k) => [k, id()]));
let db; let rpcs = [];
const reset = (flags = [], type = 'restaurant') => {
  invalidateDayCutoff(S.A);
  db = {
    businesses: [{ id: S.A, owner_id: OWNER, name: 'Test Grill', type }],
    branches: [{ id: S.W, business_id: S.A, name: 'Westlands', status: 'active' }, { id: S.K, business_id: S.A, name: 'Kilimani', status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [{ id: R_MGR, business_id: S.A, name: 'Manager' }],
    role_permissions: KEYS.map((k) => ({ id: id(), role_id: R_MGR, permission_id: PID[k] })),
    users: [
      { id: OWNER, business_id: S.A, name: 'Olga', role_id: null, status: 'active', permissions_version: 1 },
      { id: MGR, business_id: S.A, name: 'Max', role_id: R_MGR, status: 'active', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: S.W }], user_permissions: [], branch_settings: [], business_settings: [],
    feature_flags: flags.map((business_id) => ({ id: id(), business_id, key: 'analytics', enabled: true })),
  };
  ROUTE._analyticsCache().clear();
  rpcs = [];
};
const view = (table, r) => {
  if (table === 'role_permissions' || table === 'user_permissions') return { ...r, permissions: db.permissions.find((p) => p.id === r.permission_id) ?? null };
  if (table === 'roles') return { ...r, role_permissions: db.role_permissions.filter((g) => g.role_id === r.id).map((g) => view('role_permissions', g)) };
  if (table === 'users') {
    const role = db.roles.find((x) => x.id === r.role_id);
    return { ...r, roles: role ? view('roles', role) : null,
      user_permissions: db.user_permissions.filter((u) => u.user_id === r.id).map((u) => view('user_permissions', u)),
      user_branches: db.user_branches.filter((b) => b.user_id === r.id) };
  }
  return r;
};
const PG_TABLES = new Set(['stock_levels', 'ingredient_stock_levels', 'products', 'recipes']);
supabase.from = (table) => {
  const f = []; const sql = [];
  const pgRows = async () => (await pg.q(`SELECT * FROM public.${table}`)).filter((r) => sql.every((fn) => fn(r)));
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => (k.includes('.') ? true : r[k] === v)); sql.push((r) => r[k] === v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); sql.push((r) => a.includes(r[k])); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: rows().map((r) => view(table, r))[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = rows()[0]; return Promise.resolve(r ? { data: view(table, r), error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') {
        if (PG_TABLES.has(table)) return (res, rej) => pgRows().then((data) => ({ data, error: null })).then(res, rej);
        return (res, rej) => Promise.resolve({ data: rows().map((r) => view(table, r)), error: null }).then(res, rej);
      }
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async (name, args) => { rpcs.push({ name, args }); return pg.rpc(name, args); };

const jwt = require('jsonwebtoken');
const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: S.A, branchId: S.W, isOwner: false, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const TK = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'] }),
  mgr: sign({ userId: MGR, permissionKeys: KEYS }),
};
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/analytics', ROUTE.default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const call = async (p, token) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const PERIOD = `from=${S.FROM}&to=${S.TO}`;
const TG = (q = '') => `/api/analytics/together?${PERIOD}${q}`;
const REC = (q = '') => `/api/analytics/recommendations?${PERIOD}${q}`;

try {
  state._setPermissionsMigrated(true);

  await ok('route: the flag off → 403 ANALYTICS_OFF, nothing run', async () => {
    reset([]);
    const r = await call(TG(), TK.owner);
    assert.deepEqual([r.status, r.body.code], [403, 'ANALYTICS_OFF']);
    assert.equal(rpcs.length, 0);
  });
  await ok('route: shape — the pairs in words (top 10), the totals, the business type; no internal list or score', async () => {
    reset([S.A]);
    const r = await call(TG(`&branch=${S.W}`), TK.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.deepEqual([b.enough, b.businessType, b.branchId, b.period.from], [true, 'restaurant', S.W, S.FROM]);
    assert.equal(b.multiOrders, 50);
    assert.equal(b.orders, 197);
    const p = b.pairs[0];
    assert.equal(p.sentence, 'People who buy Burger usually add Soda (40 of 51 orders with Burger)');
    assert.equal(p.advice.title, 'Offer Soda with Burger');
    assert.ok(b.pairs.some((x) => x.sentence.startsWith('People who buy Chips usually add Tea (10 of 11')), b.pairs.map((x) => x.sentence).join(' | '));
    assert.ok(b.pairs.length <= 10);
    assert.ok(!('strong' in b) && !JSON.stringify(b).includes('"score"'), 'the cards\' list and the score stay in the cloud');
    const call1 = rpcs.filter((x) => x.name === 'analytics_together');
    assert.equal(call1.length, 1);
    assert.deepEqual([call1[0].args.p_branch, call1[0].args.p_limit], [S.W, 100]);
  });
  await ok('route: a shop reads a shop\'s advice; a petrol station the forecourt', async () => {
    reset([S.A], 'retail');
    const r = await call(TG(`&branch=${S.W}`), TK.owner);
    assert.equal(r.body.pairs[0].advice.title, 'Put Soda next to Burger');
    assert.equal(r.body.pairs[0].advice.short, 'Same shelf or near the till');
    reset([S.A], 'petrol_station');
    assert.match((await call(TG(`&branch=${S.W}`), TK.owner)).body.pairs[0].advice.action, /forecourt shop/);
  });
  await ok('route: a manager is held to their own branch; Kilimani has too few orders to say anything', async () => {
    reset([S.A]);
    const m = await call(TG(), TK.mgr);
    assert.equal(m.status, 200);
    assert.equal(m.body.branchId, S.W);
    assert.equal((await call(TG(`&branch=${S.K}`), TK.mgr)).body.code, 'BRANCH_SCOPE');
    const k = await call(TG(`&branch=${S.K}`), TK.owner);
    assert.deepEqual([k.body.enough, k.body.pairs.length, k.body.multiOrders], [false, 0, 12]);
    assert.match(k.body.note, /^Not enough orders with two or more items yet \(12 of the 30 needed\)/);
  });
  await ok('route: /recommendations carries the together cards (no KES, never a price); the cache runs nothing twice', async () => {
    reset([S.A]);
    await call(TG(`&branch=${S.W}`), TK.owner);
    const n = rpcs.filter((x) => x.name === 'analytics_together').length;
    const r = await call(REC(`&branch=${S.W}`), TK.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cards = r.body.recommendations.filter((x) => x.kind === 'together');
    assert.ok(cards.length >= 1 && cards.length <= 2, r.body.recommendations.map((x) => x.kind).join(','));
    assert.equal(cards[0].title, 'Offer Soda with Burger');
    for (const c of cards) {
      assert.deepEqual([c.impact, c.evidence], [null, 'together']);
      assert.ok(!PRICE.test(`${c.title} ${c.why} ${c.assumption}`), c.why);
    }
    assert.equal(rpcs.filter((x) => x.name === 'analytics_together').length, n, 'shared with /together through the cache');
  });
  await ok('route: before migration 164 runs — /together 503 ANALYTICS_NOT_READY, /recommendations still answers', async () => {
    reset([S.A]);
    const real = supabase.rpc;
    supabase.rpc = async (name, args) => (name === 'analytics_together' ? { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } } : real(name, args));
    try {
      const r = await call(TG(), TK.owner);
      assert.deepEqual([r.status, r.body.code], [503, 'ANALYTICS_NOT_READY']);
      const rec = await call(REC(), TK.owner);
      assert.equal(rec.status, 200);
      assert.ok(!rec.body.recommendations.some((x) => x.kind === 'together'));
    } finally { supabase.rpc = real; }
  });
} finally {
  server.close();
}

// ── P. The page ───────────────────────────────────────────────────────────────
console.log('\nP. the page\n');
const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.a575-'));
try {
  const bundle = async (entry, out) => {
    await require(path.join(DASH, 'node_modules/esbuild')).build({ entryPoints: [path.join(DASH, entry)], bundle: true, format: 'esm', platform: 'node',
      outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic',
      external: ['react', 'react-dom', 'react-router-dom', 'react/jsx-runtime', 'recharts'] });
    return import(pathToFileURL(path.join(bundleDir, out)).href);
  };
  const dreq = createRequire(path.join(DASH, 'package.json'));
  const React = dreq('react');
  const { renderToStaticMarkup } = dreq('react-dom/server');
  const { MemoryRouter } = dreq('react-router-dom');
  const h = React.createElement;
  const quiet = console.error;   // react-router's useLayoutEffect warning on the server — noise, not a finding
  console.error = (...a) => { if (!String(a[0]).includes('useLayoutEffect')) quiet(...a); };
  const TS = await bundle('src/pages/analytics/together.tsx', 'together.mjs');
  const PAL = await bundle('src/pages/analytics/chartPalette.ts', 'palette.mjs');
  const p = PAL.chartPalette('dark');

  await ok('page: the together section — the top 10, the sentence, what to do, the cap note; too few: the note only', () => {
    const rows = [total(1000, 400)];
    for (let i = 0; i < 14; i++) rows.push(pair(`a${String(i).padStart(2, '0')}`, `Item ${i}`, 100, `b${String(i).padStart(2, '0')}`, `Other ${i}`, 120, 20 + i));
    const t = R.summariseTogether(rows, 'retail');
    const { strong: _s, ...answer } = t;
    const html = renderToStaticMarkup(h(TS.TogetherSection, { t: answer, p }));
    assert.equal((html.match(/<li /g) ?? []).length, 10);
    assert.match(html, /Showing the top 10 of 14, the pairs that go together most first\./);
    assert.match(html, /People who buy Item 13 often add Other 13 \(33 of 100 orders with Item 13\)\./);
    assert.match(html, /Same shelf or near the till/);
    assert.ok(!PRICE.test(html.replace(/<[^>]+>/g, ' ')), 'no price words');
    const few = R.summariseTogether([total(100, 12)]);
    const e = renderToStaticMarkup(h(TS.TogetherSection, { t: few, p }));
    assert.match(e, /data-testid="analytics-together-empty"/);
    assert.match(e, /Not enough orders with two or more items yet \(12 of the 30 needed\)/);
    assert.doesNotMatch(e, /<li /);
  });
  await ok('page: the Costs area and the tiles in a shop\'s words (rendered); the page\'s wiring', async () => {
    const AR = await bundle('src/pages/analytics/areas.tsx', 'areas.mjs');
    const BTD = await bundle('src/lib/analyticsTerms.ts', 'bt.mjs');
    const costs = { days: 30, foodCost: { now: 0.4, prev: 0.3, change: 0.1, costedShare: 0.9, movers: [{ name: 'Sugar 2kg', now: 0.5, prev: 0.3 }] },
      thin: [], thinTotal: 0, rises: [], risesTotal: 0, historyNote: '',
      noCost: { items: [{ productId: 'x', name: 'Bread', category: null, qty: 5, revenue: 300 }], total: 1, revenue: 300, share: 0.1, unsold: 2, unsoldNames: [] } };
    const render = (type) => renderToStaticMarkup(h(MemoryRouter, null, h(AR.CostsSection, { c: costs, ownerView: true, currency: 'KES', words: BTD.analyticsWords(type) })));
    const shop = render('minimart').replace(/<[^>]+>/g, ' ');
    assert.match(shop, /Cost of sales/);
    assert.match(shop, /2 items you sell with no cost/);
    assert.doesNotMatch(shop, /\bfood\b|on your menu|portion/i);
    const rest = render('restaurant').replace(/<[^>]+>/g, ' ');
    assert.match(rest, /Food cost/);
    assert.match(rest, /2 items on your menu with no cost/);
    const tiles = (type) => renderToStaticMarkup(h(AR.AreaTiles, { areas: ['menu', 'heatmap'], hooks: null, active: 'menu', onPick() {}, stickyTop: 'top-0', labels: { menu: BTD.analyticsWords(type).itemsArea } }, null));
    assert.match(tiles('retail'), /Product performance/);
    assert.doesNotMatch(tiles('retail'), /Menu engineering/);
    assert.match(tiles('cafe'), /Menu engineering/);
    const page = read('apps/dashboard/src/pages/analytics/AnalyticsPage.tsx');
    assert.match(page, /client\.get<TogetherAnswer>\(`\/api\/analytics\/together\?\$\{qs\}`\)/);
    assert.match(page, /<TogetherSection t=\{together\} p=\{p\} \/>/);
    assert.match(page, /if \(e === 'together'\) \{ togetherRef\.current\?\.scrollIntoView/);
    assert.match(page, /labels=\{\{ menu: words\.itemsArea \}\}/);
    assert.match(page, /<ChartCard title=\{words\.matrix\}/);
    assert.match(page, /\$\{words\.removedItems\}`/);
    assert.match(page, /\{words\.voidsNote\} Refunds/);
    assert.match(page, /businessType=\{business\?\.type \?\? null\}/);
    assert.match(read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), /<Analytics client=\{posApi\} ownerView=\{false\} currency=\{currency\} branchName=\{session\.branchName\} businessType=\{session\.businessType\} \/>/);
  });
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
