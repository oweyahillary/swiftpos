/**
 * platform-prices-a619.test.mjs — A619 (owner, 2026-11-01): delivery platform prices. "assume 3 piece chicken is 1000
 * normal price ordering with glovo it is 1150 a 15% bump so the receipt shows 1150 not the percentage increase but the
 * price in glovo"; "the moment a cashier picks glovo or uber eats as the payment method the price changes"; "a
 * confirmation of payment method when a cashier clicks charge glovo, uber but cash there is no need".
 *
 *   node tests/platform-prices-a619.test.mjs
 *
 * RUNS the real packages/core/src/platformPrices.ts: the settings (rules, rounding, own prices), the price (percentage, a fixed
 * amount per item, every rounding, an item's own price, add-ons, options, quantity, 0 / blank = normal, to the cent), the
 * cart (re-priced and restored, lines with no product kept, the quote and its uplift) and the payment flow (only a
 * single platform payment prices for the platform, no split, the confirmation only for a platform). Then pins the chain:
 * the copies, both payment screens, the till's sale, the cloud's check, the pull and the reports use it.
 *
 * MUTATIONS TO CONFIRM BITE: up5 rounding with Math.round → "up to the nearest 5" fails; a fixed amount added to add-ons
 * → "a fixed amount is per item" fails; the own price rounded → "the own price exactly" fails; legsAfterPick (desktop
 * payment.ts) keeping the other legs → "a platform pays the whole bill" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A619_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A619_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const P = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/platformPrices.ts')).href);
const C = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/paymentCatalogue.ts')).href);
const PAY = await import(pathToFileURL(path.join(ROOT, 'apps/desktop/src/renderer/lib/payment.ts')).href);

const pct = (value, rounding = 'exact') => ({ rounding, rules: { glovo: { kind: 'percent', value } } });
const amt = (value, rounding = 'exact') => ({ rounding, rules: { glovo: { kind: 'amount', value } } });
const line = (unit, qty = 1, extra = {}) => ({ product: { id: 'p1', name: '3 Piece Chicken' }, quantity: qty, unitPrice: unit,
  lineTotal: unit * qty, selectedVariants: [], selectedModifiers: [], ...extra });

console.log('\nThe platforms');
ok('the delivery platforms are the payment catalogue\'s delivery apps (Glovo, Uber Eats, Bolt Food, Yum)', () => {
  assert.deepEqual([...P.PLATFORM_METHODS].sort(), C.PAYMENT_CATALOGUE.filter((m) => m.kind === 'delivery').map((m) => m.code).sort());
  assert.equal(P.isPlatformMethod('glovo'), true); assert.equal(P.isPlatformMethod('Uber_Eats'), true);
  assert.equal(P.isPlatformMethod('cash'), false); assert.equal(P.isPlatformMethod('mpesa'), false); assert.equal(P.isPlatformMethod(null), false);
});

console.log('\nThe settings');
ok('a rule: a percentage or an amount; blank, 0, negative or unreadable = normal prices (null)', () => {
  assert.deepEqual(P.cleanRule({ kind: 'percent', value: 15 }), { kind: 'percent', value: 15 });
  assert.deepEqual(P.cleanRule('{"kind":"amount","value":"250"}'), { kind: 'amount', value: 250 });
  for (const bad of [null, '', {}, { kind: 'percent', value: 0 }, { kind: 'percent', value: -5 }, { kind: 'x', value: 5 }, 'nope', { kind: 'percent', value: 501 }])
    assert.equal(P.cleanRule(bad), null, JSON.stringify(bad));
});
ok('the rules: each platform its own; unknown platforms dropped', () => {
  assert.deepEqual(P.cleanRules('{"glovo":{"kind":"percent","value":15},"uber_eats":{"kind":"amount","value":250},"cash":{"kind":"percent","value":5}}'),
    { glovo: { kind: 'percent', value: 15 }, uber_eats: { kind: 'amount', value: 250 } });
  assert.deepEqual(P.cleanRules(null), {}); assert.deepEqual(P.cleanRules('[]'), {});
});
ok('stored: only platform rules; a blank rule is allowed (and left out); anything else is refused (null)', () => {
  assert.equal(P.rulesSettingValue({ glovo: { kind: 'percent', value: 15 }, bolt_food: { kind: 'percent', value: '' } }), '{"glovo":{"kind":"percent","value":15}}');
  assert.equal(P.rulesSettingValue({}), '{}');
  assert.equal(P.rulesSettingValue({ cash: { kind: 'percent', value: 5 } }), null);
  assert.equal(P.rulesSettingValue({ glovo: { kind: 'percent', value: 900 } }), null);
  assert.equal(P.rulesSettingValue('[1]'), null);
});
ok('the rounding: one of four, exact by default; stored only when it is one of them', () => {
  assert.equal(P.cleanRounding('up10'), 'up10'); assert.equal(P.cleanRounding('"up5"'), 'up5');
  assert.equal(P.cleanRounding(undefined), 'exact'); assert.equal(P.cleanRounding('up3'), 'exact');
  assert.equal(P.roundingSettingValue('shilling'), 'shilling'); assert.equal(P.roundingSettingValue('round'), null);
});
ok('an item\'s own prices: per platform; blank / 0 dropped; a bad price refused when stored', () => {
  assert.deepEqual(P.cleanOwnPrices('{"glovo":1200,"uber_eats":0,"cash":5}'), { glovo: 1200 });
  assert.deepEqual(P.ownPricesValue({ glovo: '1200', bolt_food: '' }), { glovo: 1200 });
  assert.deepEqual(P.ownPricesValue(null), {});
  assert.equal(P.ownPricesValue({ glovo: 'abc' }), null); assert.equal(P.ownPricesValue({ glovo: -1 }), null);
  assert.equal(P.ownPricesValue({ mpesa: 100 }), null);
});
ok('what a POS holds: { rounding, rules }; unreadable = normal prices', () => {
  assert.deepEqual(P.cleanPricing({ rounding: 'up5', rules: { glovo: { kind: 'percent', value: 15 } } }), pct(15, 'up5'));
  assert.deepEqual(P.cleanPricing('garbage'), { rounding: 'exact', rules: {} });
});

console.log('\nThe price');
ok('the owner\'s example: +15% — 1,000 becomes 1,150', () => {
  assert.equal(P.platformUnitPrice({ unit: 1000 }, { kind: 'percent', value: 15 }, 'exact'), 1150);
});
ok('a fixed amount on EVERY item: +250 — a 350 soda becomes 600', () => {
  assert.equal(P.platformUnitPrice({ unit: 350 }, { kind: 'amount', value: 250 }, 'exact'), 600);
});
ok('no rule (blank / 0) = normal prices', () => {
  assert.equal(P.platformUnitPrice({ unit: 1000 }, null, 'up10'), 1000);
  assert.deepEqual(P.priceLineForPlatform(line(1000), 'glovo', { rounding: 'up10', rules: {} }).unitPrice, 1000);
});
ok('money to the cent: 333.33 + 15% = 383.33 (exact)', () => {
  assert.equal(P.platformUnitPrice({ unit: 333.33 }, { kind: 'percent', value: 15 }, 'exact'), 383.33);
  assert.equal(P.platformUnitPrice({ unit: 99.99 }, { kind: 'percent', value: 12.5 }, 'exact'), 112.49);
});
ok('every rounding, on each bumped UNIT price: exact, nearest shilling, up to 5, up to 10', () => {
  const r = { kind: 'percent', value: 15 };
  assert.equal(P.platformUnitPrice({ unit: 333 }, r, 'exact'), 382.95);
  assert.equal(P.platformUnitPrice({ unit: 333 }, r, 'shilling'), 383);
  assert.equal(P.platformUnitPrice({ unit: 331 }, r, 'shilling'), 381);   // 380.65 → 381
  assert.equal(P.platformUnitPrice({ unit: 333 }, r, 'up5'), 385);
  assert.equal(P.platformUnitPrice({ unit: 333 }, r, 'up10'), 390);
  assert.equal(P.platformUnitPrice({ unit: 1000 }, r, 'up10'), 1150);   // a round price stays (never pushed up a step)
  assert.equal(P.roundPrice(1150, 'up5'), 1150); assert.equal(P.roundPrice(1150.01, 'up5'), 1155);
  assert.equal(P.roundPrice(380.5, 'shilling'), 381); assert.equal(P.roundPrice(12.345, 'exact'), 12.35);
});
ok('an item\'s own platform price wins over the uplift — charged exactly as set (drinks unchanged, a hand-priced combo)', () => {
  assert.equal(P.platformUnitPrice({ unit: 1000, own: 1200 }, { kind: 'percent', value: 15 }, 'up10'), 1200);
  assert.equal(P.platformUnitPrice({ unit: 150, own: 150 }, { kind: 'amount', value: 250 }, 'up10'), 150);   // the owner keeps a soda at 150
  assert.equal(P.platformUnitPrice({ unit: 1000, own: 1199.5 }, null, 'up10'), 1199.5);   // own price, no uplift set
  const l = { ...line(1000), product: { id: 'p1', name: 'Chicken', platform_prices: '{"glovo":1250}' } };
  assert.equal(P.priceLineForPlatform(l, 'glovo', pct(15)).unitPrice, 1250);
  assert.equal(P.priceLineForPlatform(l, 'uber_eats', { rounding: 'exact', rules: { uber_eats: { kind: 'percent', value: 10 } } }).unitPrice, 1100);
});
ok('…its options (size Large +200) are bumped by the percentage on top of the own price, then rounded', () => {
  assert.equal(P.platformUnitPrice({ unit: 1200, variants: 200, own: 1200 }, { kind: 'percent', value: 15 }, 'exact'), 1430);
  assert.equal(P.platformUnitPrice({ unit: 1200, variants: 200, own: 1200 }, { kind: 'amount', value: 250 }, 'exact'), 1400);
});
ok('add-ons / extras are re-priced too: a percentage bumps each; a fixed amount is per item (add-ons keep their price)', () => {
  const l = line(1000, 1, { selectedModifiers: [{ groupName: 'Extras', optionName: 'Cheese', price: 100 }, { groupName: 'Extras', optionName: 'No onion', price: 0 }] });
  const p = P.priceLineForPlatform(l, 'glovo', pct(15));
  assert.equal(p.unitPrice, 1150); assert.deepEqual(p.selectedModifiers.map((m) => m.price), [115, 0]); assert.equal(p.lineTotal, 1265);
  assert.equal(p.selectedModifiers[0].optionName, 'Cheese');   // the add-on is the same add-on
  const a = P.priceLineForPlatform(l, 'glovo', amt(250));
  assert.equal(a.unitPrice, 1250); assert.deepEqual(a.selectedModifiers.map((m) => m.price), [100, 0]); assert.equal(a.lineTotal, 1350);
});
ok('quantity 2 = 2 × the bumped unit price', () => {
  const p = P.priceLineForPlatform(line(350, 2), 'glovo', amt(250));
  assert.equal(p.unitPrice, 600); assert.equal(p.lineTotal, 1200);
  const w = P.priceLineForPlatform(line(650, 0.452), 'glovo', pct(10));   // a weighed line: per kg
  assert.equal(w.unitPrice, 715); assert.equal(w.lineTotal, 323.18);
});
ok('a line with no catalogue product (a parking bill, a quick charge) keeps its price', () => {
  const fuel = { product: null, quantity: 10, unitPrice: 180, lineTotal: 1800 };
  assert.equal(P.priceLineForPlatform(fuel, 'glovo', pct(15)), fuel);
});

console.log('\nThe cart');
const cart = [line(1000), { ...line(350, 2), product: { id: 'p2', name: 'Soda' } }];
ok('picking Glovo re-prices every line; picking Cash again restores the normal prices (the same lines)', () => {
  const g = P.priceCartForPlatform(cart, 'glovo', pct(15));
  assert.deepEqual(g.map((l) => l.lineTotal), [1150, 805]);
  assert.equal(P.priceCartForPlatform(cart, 'cash', pct(15)), cart);
  assert.equal(P.priceCartForPlatform(cart, null, pct(15)), cart);
  assert.deepEqual(cart.map((l) => l.lineTotal), [1000, 700]);   // the rung lines are never changed
});
ok('the quote: what changed ("1,000 → 1,150"), the platform subtotal and the uplift (platform − normal)', () => {
  const q = P.platformQuote(cart, 'glovo', pct(15));
  assert.equal(q.normalSubtotal, 1700); assert.equal(q.platformSubtotal, 1955); assert.equal(q.uplift, 255);
  assert.deepEqual(q.changes[0], { name: '3 Piece Chicken', from: 1000, to: 1150 });
  assert.equal(P.changesText(q.changes), '1,000 → 1,150 (+1 more)');
  assert.equal(P.changesText([]), 'normal prices');
  assert.equal(P.platformQuote(cart, 'mpesa', pct(15)), null);
});
ok('the record an order keeps: the platform, its rule and the rounding, the uplift (later rate changes never rewrite it)', () => {
  assert.deepEqual(P.platformRecord('glovo', pct(15, 'up10'), 255),
    { price_list: 'glovo', platform_rule: { kind: 'percent', value: 15, rounding: 'up10' }, platform_uplift: 255 });
  assert.deepEqual(P.platformRecord('bolt_food', pct(15), 0).platform_rule, { kind: null, value: 0, rounding: 'exact' });
});

console.log('\nThe payment flow');
ok('a sale is priced for a platform only when its ONE payment is that platform (a split is never)', () => {
  assert.equal(P.salePlatform('glovo', ['glovo']), 'glovo');
  assert.equal(P.salePlatform('glovo', ['glovo', 'cash']), null);
  assert.equal(P.salePlatform('glovo', ['cash']), null);
  assert.equal(P.salePlatform(null, ['glovo']), null);
  assert.equal(P.salePlatform('cash', ['cash']), null);
});
ok('a platform pays the whole bill on the desktop screen too (renderer/lib/payment.ts): one leg, never a split', () => {
  const isP = P.isPlatformMethod;
  assert.equal(PAY.platformOfLegs([{ method: 'uber_eats' }], isP), 'uber_eats');
  assert.equal(PAY.platformOfLegs([{ method: 'glovo' }, { method: 'cash' }], isP), null);
  assert.equal(PAY.platformOfLegs([{ method: 'cash' }], isP), null);
  const legs = [{ method: 'cash', amount: '500', tendered: '', reference: '' }, { method: 'mpesa', amount: '', tendered: '', reference: 'X' }];
  assert.deepEqual(PAY.legsAfterPick(legs, 1, 'glovo', isP), [{ method: 'glovo', amount: '', tendered: '', reference: 'X' }]);
  assert.deepEqual(PAY.legsAfterPick(legs, 0, 'card', isP).map((l) => l.method), ['card', 'mpesa']);
  // the desktop screen asks the catalogue whether a method is a platform — the same list
  for (const m of C.PAYMENT_CATALOGUE) assert.equal(C.catalogueMethod(m.code).kind === 'delivery', P.isPlatformMethod(m.code), m.code);
});
ok('the confirmation only for a platform: Glovo / Uber Eats / Bolt Food ask; Cash, M-Pesa, Card charge at once', () => {
  for (const m of ['glovo', 'uber_eats', 'bolt_food']) assert.equal(P.needsPlatformConfirm(m), true, m);
  for (const m of ['cash', 'mpesa', 'card', 'credit', 'my_bank']) assert.equal(P.needsPlatformConfirm(m), false, m);
});

console.log('\nThe chain');
ok('ONE file: packages/core/src/platformPrices.ts, no copy left (every app imports @zaptill/core/platformPrices)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'packages/core/src/platformPrices.ts')));
  for (const p of ['shared/platformPrices.ts', 'apps/server/src/lib/platformPrices.ts', 'apps/desktop/src/shared/platformPrices.ts', 'apps/desktop/src/main/platformPrices.ts', 'apps/dashboard/src/lib/platformPrices.ts'])
    assert.ok(!fs.existsSync(path.join(ROOT, p)), p);
});
ok('both payment screens price with it and ask before charging a platform', () => {
  const web = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
  assert.match(web, /platformPrices'/); assert.match(web, /needsPlatformConfirm\(/); assert.match(web, /Charge to \$\{/);
  // the desktop loads the file when the payment screen opens (its first load stays small — lazy-load-a517)
  const desk = read('apps/desktop/src/renderer/components/PaymentModal.tsx'), page = read('apps/desktop/src/renderer/pages/POSPage.tsx');
  assert.match(desk, /platformOfLegs\(legs, isPlatform\)/); assert.match(desk, /Charge to \{platformName\}/);
  assert.match(page, /import\('@zaptill\/core\/platformPrices'\)/);
  assert.doesNotMatch(page, /^import \{[^}]*\} from '@zaptill\/core\/platformPrices'/m);
  assert.doesNotMatch(desk, /^import \{[^}]*\} from '@zaptill\/core\/platformPrices'/m);
});
ok('the till\'s sale (main), the cloud\'s check and the pull use it', () => {
  assert.match(read('apps/desktop/src/main/ipc/sale.ts'), /checkPlatformSale\(/);
  assert.match(read('apps/server/src/routes/orders.ts'), /platformUnitPrice\(/);
  assert.match(read('apps/server/src/routes/pos.ts'), /platformPrices:/);
  assert.match(read('apps/desktop/src/main/syncEngine.ts'), /setPlatformPricing\(/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
