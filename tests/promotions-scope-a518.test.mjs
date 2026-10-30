// A518 — promotions charged at the sale, on the lines they are for. Before: nothing ever applied a promotion (not the
// cloud, not the web POS, not the till), and "Specific products" had no picker, so it could name no products (A506).
// Now a promotion saved from the page (applies_at_sale, migration 144) is sent to the tills and the web POS as an offer
// with pos/init and rechecked by the cloud through the ONE offers engine (@zaptill/core/offers = packages/core/src/offers.ts).
//
//   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/promotions-scope-a518.test.mjs
//
// RUNS the compiled mapping (lib/promotionOffers.js), the shared engine and the cloud's claim check (orders.js
// checkOfferClaim) over the in-memory database; reads the page and the pos/init wiring.
//
// MUTATIONS TO CONFIRM BITE: applies_to passed through as 'product' (the engine's word is 'products') → "only the chosen
// products" fails (every line discounted); applies_at_sale not required → "a promotion from before A518 is not charged"
// fails; promotionOffersByIds dropped from checkOfferClaim → "the cloud honours a till's promotion" fails; the picker
// taken off the page → "the page picks products and categories" fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/promotionOffers.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= 'test-only-secret-test-only-secret';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const PO = require(path.join(DIST, 'lib/promotionOffers.js'));
const { scopeProblem } = require(path.join(DIST, 'routes/promotions.js'));
const { checkOfferClaim, offerClaimFrom } = require(path.join(DIST, 'routes/orders.js'));
const ENGINE = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/offers.ts')).href);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const BZ = '11111111-1111-4111-8111-111111111111';
const SODA = '66666666-6666-4666-8666-666666666666', BURGER = '77777777-7777-4777-8777-777777777777', CHIPS = '88888888-8888-4888-8888-888888888888';
const DRINKS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', FOOD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P1 = 'c0000000-0000-4000-8000-000000000001', P2 = 'c0000000-0000-4000-8000-000000000002';
const lines = [
  { key: '0', product_id: SODA, category_id: DRINKS, unit_price: 100, quantity: 2 },
  { key: '1', product_id: BURGER, category_id: FOOD, unit_price: 600, quantity: 1 },
  { key: '2', product_id: CHIPS, category_id: FOOD, unit_price: 200, quantity: 1 },
];
const promo = (over) => ({ id: P1, name: 'Soda hour', promo_type: 'happy_hour', status: 'active', applies_at_sale: true,
  start_date: null, end_date: null, start_time: null, end_time: null, days_of_week: [0, 1, 2, 3, 4, 5, 6],
  applies_to: 'all', product_ids: [], category_ids: [], discount_type: 'percentage', discount_value: 10, min_quantity: 1, free_quantity: null, ...over });
const charge = (p) => ENGINE.applyOffers(lines, PO.promotionOffers([p]), { ignoreTiming: true, branchId: null });

console.log('\nA518 — promotions charged on the lines they are for\n');

await ok('"Specific products": only the chosen products are discounted (the engine reads "products", not "product")', () => {
  const r = charge(promo({ applies_to: 'product', product_ids: [SODA] }));
  assert.deepEqual(r.byLine, { 0: 20 });
  assert.equal(r.total, 20);
  const row = PO.promotionAsOfferRow(promo({ applies_to: 'product', product_ids: [SODA], category_ids: [FOOD] }));
  assert.equal(row.applies_to, 'products');
  assert.deepEqual(row.product_ids, [SODA]);
  assert.deepEqual(row.category_ids, [], 'a list the scope does not use is not carried');
});
await ok('"Specific categories": only the lines of those categories', () => {
  const r = charge(promo({ applies_to: 'category', category_ids: [FOOD], discount_type: 'fixed', discount_value: 50 }));
  assert.deepEqual(r.byLine, { 1: 50, 2: 50 });
});
await ok('"All items" discounts every line; a BOGO on chosen products gives the cheapest of those free', () => {
  assert.equal(charge(promo({})).total, 100);
  const b = charge(promo({ promo_type: 'bogo', applies_to: 'product', product_ids: [SODA], discount_type: null, discount_value: null, min_quantity: 1, free_quantity: 1 }));
  assert.deepEqual(b.byLine, { 0: 100 });
});
await ok('a scoped promotion with nothing chosen, a quantity discount, a switched-off one and one from before A518 are not charged', () => {
  assert.equal(PO.promotionAsOfferRow(promo({ applies_to: 'product', product_ids: [] })), null);
  assert.equal(PO.promotionAsOfferRow(promo({ promo_type: 'quantity_discount', min_quantity: 3 })), null);
  assert.match(PO.promotionChargeable(promo({ promo_type: 'quantity_discount' })), /Offer/);
  assert.equal(PO.promotionAsOfferRow(promo({ status: 'inactive' })), null);
  assert.equal(PO.promotionAsOfferRow(promo({ applies_at_sale: false })), null);
  assert.equal(PO.promotionAsOfferRow(promo({ applies_at_sale: null })), null);
});
await ok('a happy hour keeps its days, dates and hours (HH:MM, as the engine reads them) — and runs only then', () => {
  const row = PO.promotionAsOfferRow(promo({ start_time: '17:00:00', end_time: '19:00:00', days_of_week: [5], start_date: '2026-10-01', end_date: '2026-12-31' }));
  assert.equal(row.start_time, '17:00'); assert.equal(row.end_time, '19:00');
  const [o] = PO.promotionOffers([promo({ start_time: '17:00:00', end_time: '19:00:00', days_of_week: [5] })]);
  assert.deepEqual(o.days, [5]);
  assert.equal(ENGINE.offerRunsAt(o, new Date(2026, 9, 16, 18, 0), null), true, 'a Friday at 18:00');
  assert.equal(ENGINE.offerRunsAt(o, new Date(2026, 9, 16, 20, 0), null), false, 'after the hour');
  assert.equal(ENGINE.offerRunsAt(o, new Date(2026, 9, 15, 18, 0), null), false, 'a Thursday');
  assert.equal(o.branch_ids, null, 'every branch');
});
await ok('every row sent to a till is one its own engine accepts (cleanOffer)', () => {
  for (const p of [promo({}), promo({ applies_to: 'product', product_ids: [SODA] }), promo({ promo_type: 'bogo', min_quantity: 2, free_quantity: 1 })]) {
    const row = PO.promotionAsOfferRow(p);
    assert.ok(row && ENGINE.cleanOffer(row).ok, JSON.stringify(row));
  }
});
await ok('the cloud honours a till\'s promotion claim on its own prices — only on the chosen lines, never more', async () => {
  mem.db = { offers: [], promotions: [{ ...promo({ applies_to: 'product', product_ids: [SODA] }), business_id: BZ }] };
  const r = await checkOfferClaim(BZ, null, lines, offerClaimFrom({ offer_discount: 20, offers: [{ offer_id: P1 }] }), 1000);
  assert.equal(r.offerDiscount, 20);
  const greedy = await checkOfferClaim(BZ, null, lines, offerClaimFrom({ offer_discount: 100, offers: [{ offer_id: P1 }] }), 1000);
  assert.equal(greedy.offerDiscount, 20, 'a claim of the whole bill is cut to the chosen lines');
});
await ok('the cloud ignores a claim on a promotion from before A518, or another business\'s', async () => {
  mem.db = { offers: [], promotions: [{ ...promo({ id: P1, applies_at_sale: false }), business_id: BZ },
    { ...promo({ id: P2 }), business_id: '99999999-9999-4999-8999-999999999999' }] };
  assert.equal((await checkOfferClaim(BZ, null, lines, offerClaimFrom({ offer_discount: 100, offers: [{ offer_id: P1 }] }), 1000)).offerDiscount, 0);
  assert.equal((await checkOfferClaim(BZ, null, lines, offerClaimFrom({ offer_discount: 100, offers: [{ offer_id: P2 }] }), 1000)).offerDiscount, 0);
});
await ok('promotionOffersFor (pos/init) sends the charged ones only', async () => {
  mem.db = { promotions: [{ ...promo({ id: P1, applies_to: 'category', category_ids: [DRINKS] }), business_id: BZ },
    { ...promo({ id: P2, applies_at_sale: false }), business_id: BZ }] };
  const rows = await PO.promotionOffersFor(BZ);
  assert.deepEqual(rows.map((r) => r.id), [P1]);
  assert.equal(rows[0].applies_to, 'categories');
});
await ok('the route checks the scope: products / categories needed, the unused list emptied', () => {
  assert.match(scopeProblem({ applies_to: 'product', product_ids: [] }), /Choose the products/);
  assert.match(scopeProblem({ applies_to: 'category' }), /Choose the categories/);
  assert.match(scopeProblem({ applies_to: 'some' }), /applies_to/);
  const b = { applies_to: 'product', product_ids: [SODA, SODA], category_ids: [FOOD] };
  assert.equal(scopeProblem(b), null);
  assert.deepEqual(b.product_ids, [SODA]); assert.deepEqual(b.category_ids, []);
  const edit = { product_ids: [CHIPS] };
  assert.equal(scopeProblem(edit, { applies_to: 'product', product_ids: [SODA], category_ids: [] }), null);
  assert.equal(edit.applies_to, 'product');
  assert.equal(scopeProblem({ name: 'x' }), null, 'a save that does not touch the scope is not checked');
});
await ok('pos/init sends the promotions with the offers; the catalogue version moves on a promotion change; create marks applies_at_sale', () => {
  const pos = read('apps/server/src/routes/pos.ts');
  assert.match(pos, /\.\.\.\(await promotionOffersFor\(req\.businessId!\)\)/);
  assert.match(pos, /latest\('promotions',\s+'business_id', biz\)/);
  const route = read('apps/server/src/routes/promotions.ts');
  assert.match(route, /applies_at_sale: true,/);
  assert.match(read('apps/server/src/routes/orders.ts'), /promotionOffersByIds\(businessId,/);
  assert.match(read('migrations/144_promotions_at_sale.sql'), /ADD COLUMN IF NOT EXISTS applies_at_sale boolean NOT NULL DEFAULT false/);
});
await ok('the page picks products and categories (search, chips), saves them and shows them', () => {
  const page = read('apps/dashboard/src/pages/PromotionsPage.tsx');
  assert.match(page, /client\.get<any\[\]>\('\/api\/products'\)/);
  assert.match(page, /client\.get<any\[\]>\('\/api\/categories'\)/);
  assert.match(page, /<ScopePicker label="Products"/);
  assert.match(page, /<ScopePicker label="Categories"/);
  assert.match(page, /product_ids:\s+form\.applies_to === 'product' \? form\.product_ids : \[\]/);
  assert.match(page, /category_ids:\s+form\.applies_to === 'category' \? form\.category_ids : \[\]/);
  assert.match(page, /product_ids:\s+p\.product_ids \?\? \[\]/, 'shown when editing');
  assert.match(page, /applies_at_sale: true/);
  assert.match(page, /data-testid="promotion-not-charged"/);
  // A608 (2026-10-29): the web manager portal is retired — its checks are gone; "the manager portal passes its
  // client" pinned ManagerDashboard.tsx; the page itself (above) is still pinned.
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
