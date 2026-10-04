/**
 * stock-take.test.mjs — A394: stock take. Blind counts; a freeze the owner decides; differences reviewed before stock
 * changes; till sales that reach the cloud late are allowed for.
 *
 * Owner, 2026-10-04: "We are missing a stock take module" — "Yes the count should be blind, I would recommend freeze but
 * we leave that as a feature which the owner will decide".
 *
 * The rules (lib/stockTakeRules.ts, pure) and the till's freeze parse (shared/stockCountFreeze.ts) run for real; source
 * pins on the routes, the web POS, the till and the screens.
 *
 * MUTATIONS TO CONFIRM BITE: lateSales counting a sale made after the count → "a sale after the count is not late"
 * fails; frozenProductIds keeping a counted item → "an item is released once counted" fails; blindLine leaving
 * expected_qty → "the person counting never sees" fails; post writing a SET instead of a delta → "posting adds the
 * difference" pins fail; the web freeze applied to a till's synced sale → "a till's sale is never refused" fails;
 * the till's addSimple without refuseFrozen → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const R = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/stockTakeRules.ts')).href);
const F = await import(pathToFileURL(path.join(ROOT, 'shared/stockCountFreeze.ts')).href);

console.log('\nThe rules\n');
await ok('steps: count and hand in while counting; recount and post under review; cancel while open', () => {
  assert.ok(R.canDo('counting', 'count') && R.canDo('counting', 'submit') && R.canDo('counting', 'cancel'));
  assert.ok(!R.canDo('review', 'count') && !R.canDo('counting', 'post') && !R.canDo('counting', 'recount'));
  assert.ok(R.canDo('review', 'post') && R.canDo('review', 'recount') && R.canDo('review', 'cancel'));
  for (const a of ['count', 'submit', 'recount', 'post', 'cancel']) assert.ok(!R.canDo('posted', a) && !R.canDo('cancelled', a), a);
  assert.equal(R.stockTakeRef(0), 'ST-0001'); assert.equal(R.stockTakeRef(41), 'ST-0042');
});
await ok('a count is a number ≥ 0 (2 decimals); whole pieces where counted in pieces', () => {
  assert.equal(R.parseCount('12', false), 12); assert.equal(R.parseCount(' 1,250.5 ', false), 1250.5);
  assert.equal(R.parseCount('0', true), 0); assert.equal(R.parseCount(2.345, false), 2.35);
  for (const bad of ['', '-1', 'ten', '1e3', null, undefined, '1.5.2']) assert.equal(R.parseCount(bad, false), null, String(bad));
  assert.equal(R.parseCount('2.5', true), null, 'half a piece');
});
await ok('a till sale made before the item was counted, synced after, is taken off what was expected', () => {
  const counted = '2026-10-04T10:00:00Z';
  const made = new Map([['o1', '2026-10-04T09:30:00Z'], ['o2', '2026-10-04T10:05:00Z'], ['o3', '2026-10-04T09:00:00Z']]);
  const moves = [
    { quantity_change: -2, created_at: '2026-10-04T10:20:00Z', reference_id: 'o1' },   // late: made 09:30, reached 10:20
    { quantity_change: -1, created_at: '2026-10-04T10:06:00Z', reference_id: 'o2' },   // sold after the count
    { quantity_change: -5, created_at: '2026-10-04T09:01:00Z', reference_id: 'o3' },   // already in what the system held
    { quantity_change: -4, created_at: '2026-10-04T10:30:00Z', reference_id: null },   // no order → not late
  ];
  assert.equal(R.lateSales(moves, made, counted), -2);
});
await ok('a sale after the count is not late; a bad time counts nothing', () => {
  const made = new Map([['o2', '2026-10-04T10:05:00Z']]);
  assert.equal(R.lateSales([{ quantity_change: -1, created_at: '2026-10-04T10:06:00Z', reference_id: 'o2' }], made, '2026-10-04T10:00:00Z'), 0);
  assert.equal(R.lateSales([{ quantity_change: -1, created_at: 'x', reference_id: 'o2' }], made, 'not a time'), 0);
});
await ok('the difference: counted − (expected + late); its value at cost; pieces stay whole', () => {
  const o = R.lineOutcome(8, 12, -2, 150, false);
  assert.deepEqual(o, { expectedFinal: 10, variance: -2, varianceValue: -300, delta: -2 });
  assert.equal(R.lineOutcome(12, 10, 0, null, false).varianceValue, 0, 'no cost known → no value');
  assert.equal(R.lineOutcome(7, 9.6, 0, 10, true).expectedFinal, 10);
  assert.equal(R.lineOutcome(5, 5, 0, 99, false).delta, 0, 'nothing to post');
});
await ok('the summary: counted / not counted, short and over in money', () => {
  const s = R.summarise([
    { counted_qty: 8, variance: -2, variance_value: -300 }, { counted_qty: 12, variance: 2, variance_value: 100 },
    { counted_qty: 5, variance: 0, variance_value: 0 }, { counted_qty: null },
  ]);
  assert.deepEqual(s, { items: 4, counted: 3, notCounted: 1, withVariance: 2, shortValue: -300, overValue: 100, netValue: -200 });
});
await ok('freeze: only an open count that freezes; an item is released once counted', () => {
  const lines = [
    { item_kind: 'product', product_id: 'p1', counted_qty: null },
    { item_kind: 'product', product_id: 'p2', counted_qty: 4 },
    { item_kind: 'ingredient', product_id: null, counted_qty: null },
  ];
  assert.deepEqual(R.frozenProductIds({ status: 'counting', freeze: true }, lines), ['p1']);
  assert.deepEqual(R.frozenProductIds({ status: 'review', freeze: true }, lines), ['p1']);
  assert.deepEqual(R.frozenProductIds({ status: 'counting', freeze: false }, lines), []);
  assert.deepEqual(R.frozenProductIds({ status: 'posted', freeze: true }, lines), []);
  assert.deepEqual(R.frozenProductIds(null, lines), []);
});
await ok('blind: the person counting never sees what the system expects or the difference', () => {
  const b = R.blindLine({ id: 'l', name: 'Coke 500ml', counted_qty: 3, expected_qty: 9, late_sales: -1, expected_final: 8,
    variance: -5, variance_value: -250, posted_delta: -5, previous_count: 4 });
  assert.deepEqual(Object.keys(b).sort(), ['counted_qty', 'id', 'name']);
});
await ok("the owner's setting: only a clear yes freezes", () => {
  for (const v of [true, 'true', '"true"', 'on', 'yes', '1']) assert.equal(R.freezeSetting(v), true, String(v));
  for (const v of [false, 'false', '', null, undefined, 'maybe', 1]) assert.equal(R.freezeSetting(v), false, String(v));
});
await ok("the till's copy of the frozen list: from the wire or the cache; anything bad → nothing frozen", () => {
  assert.deepEqual(F.parseStockCountFreeze({ ref: 'ST-0003', productIds: ['p1', 'p1', '', 7] }), { ref: 'ST-0003', productIds: ['p1'] });
  assert.deepEqual(F.parseStockCountFreeze('{"ref":"ST-0003","productIds":["p2"]}'), { ref: 'ST-0003', productIds: ['p2'] });
  for (const bad of [null, undefined, 'nonsense', 42, { productIds: [] }]) assert.deepEqual(F.parseStockCountFreeze(bad), F.NO_FREEZE);
  assert.ok(F.isFrozen({ ref: null, productIds: ['p1'] }, 'p1') && !F.isFrozen({ ref: null, productIds: ['p1'] }, 'p2'));
  assert.match(F.frozenMessage('ST-0003', 'Coke'), /Coke is being counted \(ST-0003\) — it can be sold again once it has been counted\./);
});

console.log('\nThe cloud\n');
const st = read('apps/server/src/routes/stockTakes.ts');
const acc = read('apps/server/src/lib/stockTakeAccess.ts');
await ok('who: counting is inventory.count; recount and post are inventory.adjust (the owner by default)', () => {
  assert.match(st, /router\.post\('\/:id\/count', requireAnyPermission\('inventory\.count', 'inventory\.adjust'\)/);
  assert.match(st, /router\.post\('\/:id\/recount', requirePermission\('inventory\.adjust'\)/);
  assert.match(st, /router\.post\('\/:id\/post', requirePermission\('inventory\.adjust'\)/);
  assert.match(read('apps/server/src/lib/permissionCatalogue.ts'), /key: 'inventory\.count'/);
  assert.match(read('apps/server/src/routes/index.ts'), /router\.use\('\/stock-takes',\s+stockTakeRoutes\);/);
});
await ok('blind on the cloud: the items and totals reach only someone who may change stock', () => {
  assert.match(st, /lines: full \? lines : lines\.map\(\(l\) => blindLine\(/);
  assert.match(st, /summary: full \? \(take\.summary \?\? summary\) : null,/);
  assert.match(st, /const full = may\(req, 'inventory\.adjust'\);\n  if \(full && isOpen\(take\.status\)\) lines = await preview\(take, lines\);/);
  // what the system held at the moment of the count is recorded, never sent back
  assert.match(st, /counted_qty: s\.qty, expected_qty: levels\.get\(lineKey\(s\.line\)\) \?\? 0, counted_at: now/);
  assert.match(st, /res\.json\(\{ saved: toSave\.length, counted_at: now \}\);/);
});
await ok('blind beyond the count screen: stock screens hide the counted items from someone who may not change stock', () => {
  assert.match(acc, /if \(!branchId \|\| may\(req, 'inventory\.adjust'\)\) return hide;/);
  assert.match(read('apps/server/src/routes/inventory.ts'), /hide\.has\(`p:\$\{r\.product_id\}`\) \? \{ \.\.\.r, quantity: null, qty_pieces: null, counting: true \} : r/);
  assert.match(read('apps/server/src/routes/stock.ts'), /hide\.has\(`i:\$\{i\.id\}`\) \? \{ \.\.\.i, current_stock: null, branch_stock: \[\], counting: true \} : i/);
});
await ok('posting adds the difference (never "set to"), once, with the count on the movement', () => {
  assert.match(st, /\.update\(\{ status: 'posted', posted_at: now, posted_by: who\.id, posted_by_name: who\.name, updated_at: now \}\)\n\s+\.eq\('id', take\.id\)\.eq\('status', 'review'\)/);
  assert.match(st, /p_qty_delta: l\.by_piece \? 0 : o\.delta, p_piece_delta: l\.by_piece \? Math\.round\(o\.delta\) : 0,/);
  assert.match(st, /p_ingredient_id: l\.ingredient_id, p_branch_id: take\.branch_id, p_business_id: req\.businessId, p_delta: o\.delta,/);
  assert.equal((st.match(/reference_type: 'stock_take', reference_id: take\.id/g) ?? []).length, 2);
  assert.match(st, /const pending = all\.filter\(\(l\) => l\.counted_qty !== null && l\.expected_qty !== null && !l\.posted_at\);/);
  assert.doesNotMatch(st, /from\('stock_levels'\)\s*\.(update|upsert)/);
});
await ok('one open count per branch; a second Start is refused by name', () => {
  assert.match(st, /code: 'COUNT_OPEN', id: existing\.id/);
  assert.match(read('migrations/120_stock_take.sql'), /stock_takes_one_open_per_branch\s+ON public\.stock_takes \(branch_id\) WHERE status IN \('counting', 'review'\)/);
});
await ok("freeze on the web: a live web sale of a frozen item is refused; a till's sale is never refused", () => {
  const o = read('apps/server/src/routes/orders.ts');
  assert.match(o, /if \(!deviceIdFromRequest\(req\) && !\(req\.body\?\.created_at \|\| req\.body\?\.client_created_at\)\) \{\n\s+const frozen = await frozenAtBranch\(req\.businessId, branch_id\);/);
  assert.match(o, /code: 'STOCK_COUNT_FROZEN',/);
  assert.match(acc, /if \(!take \|\| !take\.freeze_sales\) return null;/);
});
await ok('the till hears about a freeze: pos/init sends it, the 20-second check watches stock_takes', () => {
  const p = read('apps/server/src/routes/pos.ts');
  assert.match(p, /stockCount: await frozenAtBranch\(req\.businessId, \(opBranch as \{ id\?: string \} \| null\)\?\.id \?\? null\),/);
  assert.match(p, /latest\('stock_takes',\s+'business_id', biz\),/);
  assert.match(st, /await supabase\.from\('stock_takes'\)\.update\(\{ updated_at: now \}\)\.eq\('id', take\.id\);/);
});
await ok("the freeze is the owner's decision", () => {
  const b = read('apps/server/src/routes/business.ts');
  assert.match(b, /if \(key === STOCK_COUNT_FREEZE_KEY\) \{\n\s+if \(!req\.isOwner\) \{/);
  assert.match(b, /'stock_count_freeze',/);
  assert.match(st, /const freeze = freezeSetting\(\(fz as \{ value\?: unknown \} \| null\)\?\.value\);/);
});
await ok("an ingredient's sale carries its order (late till sales of an ingredient can be found)", () => {
  const e = read('apps/server/src/lib/stockEffects.ts');
  assert.equal((e.match(/await insertIngredientSale\(order_id, \{/g) ?? []).length, 3);
  assert.match(e, /\.insert\(\{ \.\.\.row, reference_type: 'order', reference_id: orderId \}\);/);
  assert.doesNotMatch(e, /\.from\('ingredient_stock_movements'\)\n\s*\.insert\(\{\n\s*business_id/);
});

console.log('\nThe till, the web POS, the screens\n');
await ok('the till refuses a frozen item on tap and scan, and keeps the list it last heard', () => {
  const pos = read('apps/desktop/src/renderer/pages/POSPage.tsx');
  assert.match(pos, /const addSimple = \(product: any\) => \{\n\s+if \(refuseFrozen\(product\)\) return;/);
  assert.match(pos, /const handleTap = \(product: any\) => \{\n\s+if \(refuseFrozen\(product\)\) return;/);
  assert.match(pos, /posApi\.pos\.stockCountFreeze\(\)\.then\(setCountFreeze\)/);
  assert.match(read('apps/desktop/src/main/syncEngine.ts'), /setStockCountFreeze\(c\.stockCount\);/);
  assert.match(read('apps/desktop/src/main/syncEngine.ts'), /stockCount: 'stockCount' in _j \? \(_j\.stockCount \?\? null\) : undefined,/);
  assert.match(read('apps/desktop/src/main/referenceBundle.ts'), /stockCount: rows\.config\.stockCount,/);
  assert.match(read('apps/desktop/src/main/localDb.ts'), /\['stock_count_freeze', 'TEXT'\],/);
});
await ok('the web POS refuses a frozen item at the counter (tap, scan, minimart)', () => {
  const c = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(c, /\(product: Product\) => \{ if \(!isFrozen\(product\)\) _addToCart\(product, variantsByProduct\); \},/);
  assert.match(c, /onAddToCart=\{minimartAddToCartChecked\}/);
});
await ok('the screens: the difference only for a reviewer; a blind printed sheet; the manager counts', () => {
  const sc = read('apps/dashboard/src/components/StockCounts.tsx');
  assert.match(sc, /const showDiff = take\.can_review && \(take\.status === 'review' \|\| take\.status === 'posted'\);/);
  assert.match(sc, /: \[\{ label: 'Item' \}, \{ label: 'Category' \}, \{ label: 'Unit' \}, \{ label: 'Counted', align: 'right' \}\],/);
  assert.match(sc, /\{isOwner && <FreezeSwitch client=\{client\} \/>\}/);
  const md = read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
  assert.match(md, /key: 'counts',[^\n]+permission: 'inventory\.count', group: 'Inventory' \}/);
  assert.match(read('apps/dashboard/src/App.tsx'), /<Route path="stock\/counts"\s+element=\{<StockCountsPage \/>\} \/>/);
  assert.match(read('apps/dashboard/src/components/DashboardLayout.tsx'), /\{ to: '\/dashboard\/stock\/counts',\s+label: 'Stock Counts'/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
