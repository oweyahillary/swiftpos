/**
 * scale-barcode-a577.test.mjs — A577: items sold by weight and the barcodes a weighing scale prints (the cloud's half,
 * the shared rules, the web).
 *
 * Owner, 2026-10-23 (approved): an item sold by weight; a scale label (EAN-13, 21–29, the item's scale code and its price
 * or weight inside) scanned at the till adds it with the weight as the quantity (0.452 kg) and the right amount.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/scale-barcode-a577.test.mjs
 *
 *   P  the parser (shared/scaleBarcode.ts) for every preset and a hand-set layout: GS1's check digits (the published
 *      examples), a wrong check digit refused, prefix 20 (ZapTill's own codes) NEVER a scale label, prefixes not chosen
 *      ignored, price vs weight, decimals, the single "2" prefix with a 6-digit code, off = nothing read.
 *   L  the weighed line: kg × price per kg rounded to the cent; a price label's price IS the amount, the weight worked
 *      back to the gram; the cloud's half-a-gram tolerance; the item found by its scale code (leading zeros, the till's
 *      `plu` or the cloud's `plu_code`, never an inactive item); quantities shown "0.452" / "452 g".
 *   S  the settings: a layout that is not 13 digits, a 20 prefix, mixed prefix lengths refused in plain words; the default.
 *   H  over HTTP (the COMPILED routers, real auth, the database in memory): POST /api/business/settings stores the clean
 *      layout and refuses a bad one (400) and a cashier (403); GET /settings reads it back; pos/init sends it
 *      (`scaleBarcodes`, the default when unset) — so tills and the web POS read labels offline.
 *   O  the sale: a web sale of a price label (KES 294 for 0.452 kg at 650/kg) is stored at 294 with 0.452 kg; an amount
 *      further than half a gram's worth is re-priced (anti-tampering kept); a product NOT sold by weight is re-priced as
 *      before; a till's push of a weighed line keeps 0.452 and its amount (no price variance logged).
 *   W  the web wiring: MinimartPOS reads labels with the shared parser (the old "any 2…" decoder that took ZapTill's 20
 *      codes for weighed items is gone); CashierScreen asks for the weight on a tap in every mode and reads labels in a
 *      shop and a petrol station's shop; the product form's "Sold by weight"; Settings › Business › Scale labels.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A577 report):
 *   - explainScaleBarcode without the "20" refusal                    → P "prefix 20 is never a scale label" fails
 *   - the EAN check digit not checked                                  → P "a wrong check digit" fails
 *   - valueCheckDigit's 5- table for 2-                               → P "GS1's price check digit" fails
 *   - scaleLine using the label's price / kg without round3           → L "worked back to the gram" fails
 *   - weighedAmountAccepted's tolerance 0.005 per kg (10× wider)       → L + O "further than half a gram is re-priced" fail
 *   - orders.ts keeping the till's amount for any product (no weighedIds check) → O "not sold by weight: re-priced" fails
 *   - business.ts storing the value without cleanScaleSettings         → H "a 20 prefix refused (400)" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/scaleBarcode.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
const S = await import(pathToFileURL(path.join(ROOT, 'shared/scaleBarcode.ts')).href);

/** An EAN-13 with its check digit — by the published GS1 rule, written out here (not the module's own). */
const ean = (body12) => {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3);
  return body12 + ((10 - (sum % 10)) % 10);
};
const flipLast = (code) => code.slice(0, 12) + ((Number(code[12]) + 1) % 10);

const log = console.log;
try {
  log('\nP — the parser\n');
  await ok('GS1\'s price check digit: the published examples (4 digits 2875 → 9, 5 digits 14685 → 6)', () => {
    assert.equal(S.valueCheckDigit('2875'), 9);
    assert.equal(S.valueCheckDigit('14685'), 6);
    assert.equal(S.valueCheckDigit('0000'), 0);
    assert.equal(S.valueCheckDigit('123'), null);
    assert.equal(S.eanCheckDigit('400638133393'), 1);   // 4006381333931 (GS1's own example)
  });
  await ok('the standard price label: 22 01234 00294 → item 01234, KES 294', () => {
    const r = S.parseScaleBarcode(ean('220123400294'), S.presetSettings('generic-price'));
    assert.deepEqual([r.prefix, r.itemCode, r.valueType, r.price], ['22', '01234', 'price', 294]);
  });
  await ok('the standard weight label: 21 01234 00452 → 0.452 kg', () => {
    const r = S.parseScaleBarcode(ean('210123400452'), S.presetSettings('generic-weight'));
    assert.deepEqual([r.itemCode, r.valueType, r.weightKg], ['01234', 'weight', 0.452]);
  });
  await ok('every preset reads its own layout (CAS price, DIGI price + check digit, Ishida weight, six-digit item)', () => {
    const cas = S.parseScaleBarcode(ean('290004501250'), S.presetSettings('cas'));
    assert.deepEqual([cas.itemCode, cas.price], ['00045', 1250]);
    const pc = S.valueCheckDigit('2875');
    const digi = S.parseScaleBarcode(ean(`2300123${pc}2875`), S.presetSettings('digi'));
    assert.deepEqual([digi.itemCode, digi.price], ['00123', 2875]);
    const ish = S.parseScaleBarcode(ean('250777701500'), S.presetSettings('ishida'));
    assert.deepEqual([ish.itemCode, ish.weightKg], ['07777', 1.5]);
    const six = S.parseScaleBarcode(ean('212345600294'), S.presetSettings('six-digit-item'));
    assert.deepEqual([six.prefix, six.itemCode, six.price], ['2', '123456', 294]);
  });
  await ok('a wrong check digit is not a label (scan it again) — the EAN\'s, and the DIGI price check digit', () => {
    const code = ean('220123400294');
    assert.equal(S.parseScaleBarcode(flipLast(code), S.DEFAULT_SCALE_SETTINGS), null);
    assert.match(S.explainScaleBarcode(flipLast(code), S.DEFAULT_SCALE_SETTINGS).reason, /check digit/);
    const wrong = (S.valueCheckDigit('2875') + 1) % 10;
    const r = S.explainScaleBarcode(ean(`2300123${wrong}2875`), S.presetSettings('digi'));
    assert.equal(r.ok, false); assert.match(r.reason, /price check digit is wrong/);
  });
  await ok('prefix 20 (ZapTill\'s own in-store codes, A571) is never a scale label — even with the single "2" prefix', () => {
    const own = ean('200000000001');
    for (const s of [S.DEFAULT_SCALE_SETTINGS, S.presetSettings('six-digit-item'), { ...S.DEFAULT_SCALE_SETTINGS, prefixes: ['2'], itemDigits: 6 }]) {
      assert.equal(S.parseScaleBarcode(own, s), null);
      assert.match(S.explainScaleBarcode(own, s).reason, /in-store code/);
    }
  });
  await ok('a prefix the business did not choose, a manufacturer\'s code, a short code, switched off → not a label', () => {
    const only22 = { ...S.DEFAULT_SCALE_SETTINGS, prefixes: ['22'] };
    assert.equal(S.parseScaleBarcode(ean('230123400294'), only22), null);
    assert.ok(S.parseScaleBarcode(ean('220123400294'), only22));
    assert.equal(S.parseScaleBarcode('5901234123457', S.DEFAULT_SCALE_SETTINGS), null);
    assert.equal(S.parseScaleBarcode('22012340029', S.DEFAULT_SCALE_SETTINGS), null);
    assert.equal(S.parseScaleBarcode(ean('220123400294'), { ...S.DEFAULT_SCALE_SETTINGS, enabled: false }), null);
  });
  await ok('decimals: a price in cents (29380 → 293.80), a weight in tens of grams (00045 → 0.45 kg)', () => {
    const cents = S.parseScaleBarcode(ean('220123429380'), { ...S.DEFAULT_SCALE_SETTINGS, decimals: 2 });
    assert.equal(cents.price, 293.8);
    const tens = S.parseScaleBarcode(ean('210123400045'), { ...S.presetSettings('generic-weight'), decimals: 2 });
    assert.equal(tens.weightKg, 0.45);
  });

  log('\nL — the weighed line\n');
  await ok('typed / weight label: kg × price per kg, rounded to the cent (650 × 0.452 = 293.80; 649.99 × 0.333 = 216.45)', () => {
    assert.deepEqual(S.weighedLine(650, 0.452), { quantity: 0.452, unitPrice: 650, lineTotal: 293.8 });
    assert.equal(S.weighedLine(649.99, 0.333).lineTotal, 216.45);
    assert.equal(S.weighedLine(650, 0.4525).quantity, 0.453);   // to the gram
    const r = S.parseScaleBarcode(ean('210123400452'), S.presetSettings('generic-weight'));
    assert.deepEqual(S.scaleLine(650, r), { quantity: 0.452, unitPrice: 650, lineTotal: 293.8 });
  });
  await ok('a price label: its price IS the amount; the weight worked back to the gram (294 / 650 → 0.452 kg)', () => {
    const r = S.parseScaleBarcode(ean('220123400294'), S.DEFAULT_SCALE_SETTINGS);
    assert.deepEqual(S.scaleLine(650, r), { quantity: 0.452, unitPrice: 650, lineTotal: 294 });
    assert.deepEqual(S.scaleLine(0, r), { quantity: 1, unitPrice: 294, lineTotal: 294 });   // no price per kg: 1 at the label's price
  });
  await ok('the cloud\'s check: within half a gram\'s worth (+1 cent) stands; further is re-priced', () => {
    assert.ok(S.weighedAmountAccepted(650, 0.452, 294));      // 293.80 + 0.20 ≤ 0.335
    assert.ok(S.weighedAmountAccepted(650, 0.452, 293.8));
    assert.ok(!S.weighedAmountAccepted(650, 0.452, 294.2));   // 0.40 > 0.335
    assert.ok(!S.weighedAmountAccepted(650, 0.452, 300));
    assert.ok(!S.weighedAmountAccepted(650, 0, 0));
  });
  await ok('the item by its scale code: leading zeros ignored, the till\'s plu or the cloud\'s plu_code, never inactive', () => {
    const items = [{ id: 'a', plu_code: '1234', status: 'active' }, { id: 'b', plu: '00077' }, { id: 'c', plu_code: '555', status: 'inactive' }, { id: 'd', plu_code: '' }];
    assert.equal(S.findScaleProduct(items, '01234')?.id, 'a');
    assert.equal(S.findScaleProduct(items, '00077')?.id, 'b');
    assert.equal(S.findScaleProduct(items, '00555'), undefined);
    assert.equal(S.findScaleProduct(items, '00000'), undefined);
  });
  await ok('quantities shown: 3 → "3", 0.452 → "0.452", 1.5 → "1.5"; "0.452 kg" / "452 g"', () => {
    assert.deepEqual([S.formatQty(3), S.formatQty(0.452), S.formatQty(1.5), S.formatQty(0.1 + 0.2)], ['3', '0.452', '1.5', '0.3']);
    assert.deepEqual([S.formatWeight(0.452), S.formatWeight(0.452, 'g'), S.formatWeight(1.5)], ['0.452 kg', '452 g', '1.500 kg']);
    assert.ok(S.isSoldByWeight({ sold_by: 'weight' }) && !S.isSoldByWeight({ sold_by: 'each' }));
    assert.equal(S.weightUnitOf({ unit_label: 'g' }), 'g'); assert.equal(S.weightUnitOf({ unit_label: 'pc' }), 'kg');
  });

  log('\nS — the settings\n');
  await ok('the default: 21–29, item 5, price 5, whole shillings; every preset adds up to 13 digits', () => {
    const d = S.cleanScaleSettings(null).settings;
    assert.deepEqual([d.prefixes.length, d.itemDigits, d.valueType, d.valueDigits, d.decimals, d.enabled], [9, 5, 'price', 5, 0, true]);
    for (const p of S.SCALE_PRESETS) assert.equal(S.layoutLength(S.presetSettings(p.id)), 13, p.id);
    assert.ok(S.cleanScaleSettings(JSON.stringify(S.presetSettings('digi'))).ok);
  });
  await ok('refused in plain words: not 13 digits, a 20 prefix, mixed prefix lengths, a check digit on a 6-digit value', () => {
    assert.match(S.cleanScaleSettings({ itemDigits: 6 }).error, /14 digits/);
    assert.match(S.cleanScaleSettings({ prefixes: ['20', '21'] }).error, /Prefix 20/);
    assert.match(S.cleanScaleSettings({ prefixes: ['2', '21'] }).error, /either the single prefix 2/);
    assert.match(S.cleanScaleSettings({ itemDigits: 3, valueDigits: 6, valueCheckDigit: true }).error, /4- or 5-digit/);
    assert.match(S.cleanScaleSettings('{nope').error, /could not be read/);
    assert.equal(S.scaleSettingsOrDefault({ prefixes: ['20'] }).prefixes.length, 9);   // a bad stored value → the default
  });

  log('\nH — the settings over HTTP, and pos/init\n');
  process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
  process.env.JWT_SECRET = randomBytes(24).toString('hex');
  process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
  process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
  delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;
  const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
  const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
  const mem = installMemDb(supabase);
  supabase.auth.admin.getUserById = async () => ({ data: null, error: { message: 'no user' } });
  const quiet = () => {}; console.info = quiet; console.warn = quiet; console.error = quiet;

  const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
  const OWNER = '44444444-4444-4444-8444-444444444444', TOM = 'cccccccc-0000-4000-8000-000000000001';
  const BEEF = 'aaaaaaaa-0000-4000-8000-000000000001', SODA = 'aaaaaaaa-0000-4000-8000-000000000002';
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity;
  mem.db = {
    businesses: [{ id: B, name: 'Mama Mboga Mart', owner_id: OWNER, currency: 'KES', vat_rate: 16, ctl_rate: 0, type: 'minimart', status: 'active' }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B }, { id: TOM, name: 'Tom', status: 'active', business_id: B }],
    branches: [{ id: BR, business_id: B, name: 'Kasarani', is_main: true, desktop_licensed: true }],
    products: [
      { id: BEEF, business_id: B, name: 'Beef steak', base_price: 650, track_stock: false, status: 'active', sold_by: 'weight', plu_code: '01234', unit_label: 'kg' },
      { id: SODA, business_id: B, name: 'Soda 500ml', base_price: 80, track_stock: false, status: 'active', sold_by: 'each' },
    ],
    categories: [], variant_groups: [], modifier_groups: [], branch_prices: [], change_requests: [], user_devices: [], orders: [],
    order_items: [], payments: [], order_price_variances: [], kitchen_tickets: [], business_settings: [], branch_settings: [],
    shifts: [], stock_takes: [], stock_levels: [], combo_items: [], feature_flags: [], offers: [], promotions: [], menus: [],
    business_branding: [], branch_branding: [], payment_methods: [], audit_log: [],
  };
  mem.rpc = async (fn, args) => {
    if (fn !== 'create_order_atomic') return { data: null, error: null };
    const o = args.p_order; const id = randomUUID();
    mem.db.orders.push({ id, ...o, status: 'completed' });
    for (const it of args.p_items) mem.db.order_items.push({ id: randomUUID(), order_id: id, ...it.item });
    for (const p of args.p_payments) mem.db.payments.push({ id: randomUUID(), order_id: id, ...p });
    return { data: [{ order_id: id, order_number: o.order_number }], error: null };
  };
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const app = express();
  app.use(express.json());
  app.use('/api/business', require(path.join(DIST, 'routes/business.js')).default);
  app.use('/api/pos', require(path.join(DIST, 'routes/pos.js')).default);
  app.use('/api/orders', require(path.join(DIST, 'routes/orders.js')).default);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const tok = (surface, userId, extra = {}) => jwt.sign({ userId, businessId: B, branchId: BR, isOwner: false, permissionKeys: ['orders.create'],
    permissionsVersion: 0, sessionId: 's', surface, ...(surface === 'desktop' ? { pinSignIn: true } : {}), ...extra }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const req = async (method, p, body, token, headers = {}) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const owner = tok('dashboard', OWNER, { isOwner: true, permissionKeys: ['*'] });
  const cashier = tok('web', TOM);
  try {
    await ok('pos/init sends the default layout when none is set (tills and the web POS read labels from day one)', async () => {
      const r = await req('GET', `/api/pos/init?branch_id=${BR}`, null, owner);
      assert.equal(r.status, 200, JSON.stringify(r.body)?.slice(0, 200));
      assert.deepEqual(r.body.scaleBarcodes, S.cleanScaleSettings(null).settings);
      const beef = r.body.products.find((p) => p.id === BEEF);
      assert.deepEqual([beef.sold_by, beef.plu_code, beef.unit_label], ['weight', '01234', 'kg']);   // the till's columns ride on products
    });
    await ok('the owner saves the DIGI layout: stored clean, read back by GET /settings and sent by pos/init', async () => {
      const r = await req('POST', '/api/business/settings', { key: 'scale_barcodes', value: { ...S.presetSettings('digi'), junk: 1 } }, owner);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const stored = JSON.parse(r.body.value);
      assert.deepEqual(stored, S.presetSettings('digi'));
      const g = await req('GET', '/api/business/settings', null, owner);
      assert.deepEqual(JSON.parse(g.body.find((x) => x.key === 'scale_barcodes').value), S.presetSettings('digi'));
      const i = await req('GET', `/api/pos/init?branch_id=${BR}`, null, owner);
      assert.deepEqual(i.body.scaleBarcodes, S.presetSettings('digi'));
    });
    await ok('a 20 prefix and a layout that is not 13 digits are refused (400, said why); a cashier may not (403)', async () => {
      let r = await req('POST', '/api/business/settings', { key: 'scale_barcodes', value: { prefixes: ['20'] } }, owner);
      assert.equal(r.status, 400); assert.match(r.body.error, /Prefix 20/);
      r = await req('POST', '/api/business/settings', { key: 'scale_barcodes', value: { itemDigits: 7 } }, owner);
      assert.equal(r.status, 400); assert.match(r.body.error, /15 digits/);
      r = await req('POST', '/api/business/settings', { key: 'scale_barcodes', value: S.DEFAULT_SCALE_SETTINGS }, cashier);
      assert.equal(r.status, 403);
      assert.deepEqual(JSON.parse(mem.db.business_settings.find((x) => x.key === 'scale_barcodes').value), S.presetSettings('digi'));
    });

    log('\nO — the sale\n');
    const weighed = (lineTotal, quantity = 0.452, id = BEEF, name = 'Beef steak', unitPrice = 650) => ({ product: { id, name }, quantity, unitPrice, lineTotal });
    const sale = (items) => { const total = items.reduce((s, i) => s + i.lineTotal, 0);
      return { branch_id: BR, order_number: `W-${Math.floor(Math.random() * 1e6)}`, items, total, subtotal: total, payments: [{ method: 'cash', amount: total }] }; };
    const lastItems = () => { const o = mem.db.orders[mem.db.orders.length - 1]; return { o, items: mem.db.order_items.filter((i) => i.order_id === o.id) }; };
    await ok('a web sale of a price label: KES 294 for 0.452 kg at 650/kg is stored at 294, quantity 0.452', async () => {
      const r = await req('POST', '/api/orders', sale([weighed(294)]), cashier);
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
      const { o, items } = lastItems();
      assert.deepEqual([Number(items[0].quantity), Number(items[0].subtotal), Number(o.total)], [0.452, 294, 294]);
    });
    await ok('…an amount further than half a gram\'s worth is re-priced (295 → 293.80): no inventing a price', async () => {
      const r = await req('POST', '/api/orders', sale([weighed(295)]), cashier);
      const { o, items } = lastItems();
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
      assert.deepEqual([Number(items[0].subtotal), Number(o.total)], [293.8, 293.8]);
    });
    await ok('…a product NOT sold by weight is re-priced as before (0.5 soda at 40.04 → 40, though within half a gram)', async () => {
      const r = await req('POST', '/api/orders', sale([weighed(40.04, 0.5, SODA, 'Soda 500ml', 80)]), cashier);
      const { items } = lastItems();
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
      assert.equal(Number(items[0].subtotal), 40);
    });
    await ok('a till\'s push of a weighed line keeps 0.452 and its amount, no price variance logged', async () => {
      const before = mem.db.order_price_variances.length;
      const r = await req('POST', '/api/orders', { created_at: '2026-10-23T09:00:00Z', ...sale([weighed(294)]) }, tok('desktop', TOM),
        { 'X-Idempotency-Key': randomUUID(), 'X-Device-Id': 'dev-T1' });
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
      const { items } = lastItems();
      assert.deepEqual([Number(items[0].quantity), Number(items[0].subtotal)], [0.452, 294]);
      assert.equal(mem.db.order_price_variances.length, before);
    });
  } finally { server.close(); }

  log('\nW — the web wiring\n');
  await ok('MinimartPOS reads labels with the shared parser; the old "any 2…" decoder (it took 20 codes for weighed items) is gone', () => {
    const m = read('apps/dashboard/src/pages/pos/MinimartPOS.tsx');
    assert.ok(!m.includes('decodeEan13Weight') && !/barcode\[0\] !== '2'/.test(m));
    assert.ok(m.includes('parseScaleBarcode(barcode, scaleSettings') && m.includes('findScaleProduct(products, reading.itemCode)')
      && m.includes('scaleLine(Number(product.base_price), reading)') && m.includes('onClick={() => pick(product)}'));
  });
  await ok('CashierScreen: a tap on a weighed item asks for the weight in every mode; labels read in a shop and a petrol station\'s shop', () => {
    const c = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    assert.ok(/if \(isSoldByWeight\(product as any\) && !\(product as any\)\.is_fuel\) \{ setWeighFor\(product\); return; \}/.test(c));
    assert.ok(c.includes("if (!((isRetailLike && !isMinimart) || (isPetrol && view === 'products'))) return;")
      && c.includes('if (scaleScanRef.current(buffer))') && c.includes('<WeightModal'));
    const cart = read('apps/dashboard/src/pages/pos/cashier/useCart.ts');
    assert.ok(cart.includes('addWeighedToCart') && cart.includes('if (item.measureUnit) return delta < 0 ? { ...item, quantity: 0 } : item;'));
  });
  await ok('the product form\'s "Sold by weight" (price per kg, kg or g, the scale code) and Settings › Business › Scale labels', () => {
    const p = read('apps/dashboard/src/pages/products/ProductsPage.tsx');
    assert.ok(p.includes('Sold by weight (price per kg)') && p.includes('plu_code: form.plu_code.trim() || null') && p.includes('Scale code (PLU)'));
    assert.ok(read('apps/dashboard/src/App.tsx').includes('<Route path="scale-labels" element={<ScaleLabelsTab />} />'));
    const t = read('apps/dashboard/src/pages/settings/ScaleLabelsTab.tsx');
    assert.ok(t.includes('explainScaleBarcode(code, settings)') && t.includes("key: SCALE_SETTINGS_KEY, value: settings"));
  });
  await ok('the web receipt and kitchen ticket carry the weighed line\'s unit ("0.452 kg @ 650/kg", "0.750 kg   GOAT MEAT")', () => {
    assert.ok(read('apps/dashboard/src/lib/buildReceiptOrder.ts').includes('...(c.measureUnit ? { measureUnit: c.measureUnit } : {})'));
    assert.ok(read('apps/dashboard/src/lib/printRouted.ts').includes('...(item.measureUnit ? { measureUnit: item.measureUnit } : {})'));
    assert.ok(read('apps/dashboard/src/lib/escposRenderer.js').includes('measureUnit'));   // the web's bundle rebuilt
  });
} finally {
  log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
