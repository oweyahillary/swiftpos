// A619 — delivery platform prices on the desktop POS, offline too.
//
// Owner, 2026-11-01: "assume 3 piece chicken is 1000 normal price ordering with glovo it is 1150 a 15% bump so the receipt
// shows 1150 not the percentage increase but the price in glovo"; "the moment a cashier picks glovo or uber eats as the
// payment method the price changes"; "a confirmation of payment method when a cashier clicks charge glovo, uber but cash
// there is no need".
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, syncEngine — the catalogue pull from a stand-in cloud,
// createLocalOrder, the sync queue —, referenceBundle, and the real order:create from ipc/sale.ts on a stand-in `handle`)
// on a REAL SQLite file; the payment screen's pricing is the till's own copy of shared/platformPrices.ts.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/platform-prices-a619.test.mjs
//
//   1  local schema 79 (device_config.platform_prices, products.platform_prices); REQUIRED moves with it.
//   2  the pull carries the rules and each item's own platform prices; an older cloud (no key) keeps what the POS holds.
//   3  the branch server relays both to its tills.
//   4  the sale: a Glovo sale at Glovo prices is accepted and saved at them (order_items, the sync queue's payload with
//      price_list, the rule and the uplift; the hints never leave main); a wrong platform price, a split and a stale rule
//      are refused; an item's own platform price; a cash sale is untouched.
//   5  the screens: the payment screen asks before charging a platform only, prices with the shared file, and the sale
//      screen sends the normal lines with the platform's.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - order:create without checkPlatformSale                     → 4 "a Glovo price LOWER than the rule" fails
//   - checkPlatformSale not refusing a claim with a split        → 4 "Glovo + cash" fails
//   - setPlatformPricing storing on undefined (an older cloud)    → 2 "an older cloud keeps" fails
//   - writeProducts without platform_prices                      → 2 "the item's own platform price" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a619-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.22', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }, net: { isOnline: () => true }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const throwsMsg = async (fn) => { try { await fn(); return null; } catch (e) { return e?.message ?? String(e); } };
const PP = await import(pathToFileURL(path.join(here, '..', 'src', 'shared', 'platformPrices.ts')).href);

// ── The stand-in cloud ───────────────────────────────────────────────────────────────────────────────────────────────
const BR = 'br-1';
const PRODUCTS = [
  { id: 'p-chicken', name: '3 Piece Chicken', base_price: 1000 },
  { id: 'p-soda', name: 'Soda', base_price: 350 },
  { id: 'p-combo', name: 'Family Combo', base_price: 2000, platform_prices: { glovo: 2200 } },
].map((p) => ({ status: 'active', track_stock: false, description: null, image_url: null, has_variants: false, has_modifiers: false, branch_price: null,
  category_id: null, barcode: null, is_kitchen: null, show_days: null, platform_prices: null, ...p }));
const PRICES = { rounding: 'exact', rules: { glovo: { kind: 'percent', value: 15 }, uber_eats: { kind: 'amount', value: 250 } } };
const initWith = (extra) => ({ products: PRODUCTS, categories: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
  vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'restaurant', businessName: 'Kuku Grill', currency: 'KES', ...extra });
const cloud = { init: initWith({ platformPrices: PRICES }) };
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
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'r1', 'u-owner', 'biz-1', 'Kuku Grill', '2026-11-01T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'POS 1', business_type: 'restaurant' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const S = require(path.join(dist, 'shiftService.js'));
const RB = require(path.join(dist, 'referenceBundle.js'));

console.log('\nA619 — delivery platform prices on the desktop POS\n');
try {
  console.log('1. Local schema');
  {
    const required = Number((fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'lib', 'desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
    const pc = db.prepare(`PRAGMA table_info(products)`).all().map((c) => c.name);
    const dc = db.prepare(`PRAGMA table_info(device_config)`).all().map((c) => c.name);
    ok('local schema 79: device_config.platform_prices and products.platform_prices; REQUIRED moves with it',
      L.LOCAL_SCHEMA_VERSION >= 79 && required === L.LOCAL_SCHEMA_VERSION && pc.includes('platform_prices') && dc.includes('platform_prices'),
      JSON.stringify({ v: L.LOCAL_SCHEMA_VERSION, required }));
  }

  console.log('\n2. The pull carries the rules');
  {
    ok('before any pull: normal prices', JSON.stringify(DC.getPlatformPricing()) === JSON.stringify({ rounding: 'exact', rules: {} }));
    const r = await E.pullCatalogueNow();
    ok('the rules are stored and read back (offline from now on)', r.pulled === true && JSON.stringify(DC.getPlatformPricing()) === JSON.stringify(PRICES),
      JSON.stringify({ r, got: DC.getPlatformPricing() }));
    const combo = db.prepare(`SELECT platform_prices FROM products WHERE id = 'p-combo'`).get();
    const chicken = db.prepare(`SELECT platform_prices FROM products WHERE id = 'p-chicken'`).get();
    ok('the item\'s own platform price comes with the item; none = NULL', combo.platform_prices === '{"glovo":2200}' && chicken.platform_prices === null, JSON.stringify({ combo, chicken }));
    cloud.init = initWith({});   // an older cloud: no platformPrices key
    await E.pullCatalogueNow();
    ok('an older cloud (no key) keeps what the POS holds', JSON.stringify(DC.getPlatformPricing()) === JSON.stringify(PRICES));
    cloud.init = initWith({ platformPrices: { rounding: 'up10', rules: { glovo: { kind: 'percent', value: 15 }, nope: { kind: 'percent', value: 9 } } } });
    await E.pullCatalogueNow();
    ok('a new rule replaces it, cleaned (an unknown platform dropped)', JSON.stringify(DC.getPlatformPricing()) === JSON.stringify({ rounding: 'up10', rules: { glovo: { kind: 'percent', value: 15 } } }));
    cloud.init = initWith({ platformPrices: PRICES });
    await E.pullCatalogueNow();
    ok('the change log\'s money topic carries them (CONFIG_KEYS.money: platformPrices)', /money: \[[^\]]*'platformPrices'/.test(src('main/syncTopics.ts')));
  }

  console.log('\n3. The branch server relays them');
  {
    const bundle = RB.buildReferenceBundle(db, DC.getDeviceConfig());
    ok('the bundle carries the rules and each item\'s own prices', JSON.stringify(bundle.posInit.platformPrices) === JSON.stringify(PRICES)
      && bundle.posInit.products.find((p) => p.id === 'p-combo')?.platform_prices === '{"glovo":2200}', JSON.stringify(bundle.posInit.platformPrices));
    const back = RB.unpackNodeBundle(bundle);
    ok('…and a POS behind it unpacks them (an older server sends none → keep)', JSON.stringify(back.config.platformPrices) === JSON.stringify(PRICES)
      && RB.unpackNodeBundle({ posInit: {} }).config.platformPrices === undefined);
  }

  console.log('\n4. The sale (order:create)');
  {
    db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, 'u-cate', 'Cate', 'cashier', ?, ?, 'tok', '2026-11-01T06:00:00Z')`)
      .run(JSON.stringify({ 'catalogue.v2': true, 'orders.create': true }), BR);
    S.openShift(1000);
    const handlers = {};
    const { registerSaleHandlers } = require(path.join(dist, 'ipc', 'sale.js'));
    registerSaleHandlers({ handle: (name, fn) => { handlers[name] = fn; }, queueThermal: () => ({ failed: [] }), STATIONS_REFUSED: [], readOrderDetail: () => null });
    let n = 0;
    const rung = (id, name, unit, qty = 1, mods = []) => ({ product: { id, name, platform_prices: db.prepare(`SELECT platform_prices FROM products WHERE id = ?`).get(id)?.platform_prices ?? null },
      unitPrice: unit, quantity: qty, lineTotal: (unit + mods.reduce((s, m) => s + m.price, 0)) * qty, selectedVariants: [], selectedModifiers: mods });
    // What the sale screen sends (POSPage): the lines at the platform's prices, each with the line as it was rung.
    const platformSale = (cart, method, legs) => {
      const q = PP.platformQuote(cart, method, DC.getPlatformPricing());
      const items = q.lines.map((l, i) => ({ ...l, normal: { unitPrice: cart[i].unitPrice, modifiers: cart[i].selectedModifiers.map((m) => m.price) } }));
      return { branch_id: BR, order_number: `T1-${++n}`, order_type: 'delivery', subtotal: q.platformSubtotal, vat_amount: 0, total: q.platformSubtotal, items,
        price_list: method, payments: legs ?? [{ method, amount: q.platformSubtotal, amount_tendered: q.platformSubtotal, change_given: 0, reference: 'GLV-77' }] };
    };
    const charge = (p) => throwsMsg(() => handlers['order:create'](null, p));
    const lastOrder = () => db.prepare(`SELECT * FROM orders ORDER BY rowid DESC LIMIT 1`).get();
    const queued = (orderId) => JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id = ?`).get(orderId).payload);

    const m1 = await charge(platformSale([rung('p-chicken', '3 Piece Chicken', 1000)], 'glovo'));
    const o1 = lastOrder();
    ok('a Glovo sale at Glovo prices is accepted: 1,000 → 1,150, saved at 1,150', m1 === null && o1.total === 1150 && o1.subtotal === 1150
      && db.prepare(`SELECT unit_price FROM order_items WHERE order_id = ?`).get(o1.id).unit_price === 1150, m1 ?? JSON.stringify(o1));
    const q1 = queued(o1.id);
    ok('…the cloud gets the platform, its rule and what it added; the rung lines never leave main',
      q1.price_list === 'glovo' && JSON.stringify(q1.platform_rule) === '{"kind":"percent","value":15,"rounding":"exact"}' && q1.platform_uplift === 150
      && q1.items.every((i) => !('normal' in i)), JSON.stringify(q1));
    const m2 = await charge(platformSale([rung('p-soda', 'Soda', 350, 2, [{ groupName: 'Extras', optionName: 'Ice', price: 20 }])], 'uber_eats'));
    ok('Uber Eats +250 an item: a 350 soda is 600, quantity 2 = 1,200 (+ the add-on, unchanged by a fixed amount)', m2 === null && lastOrder().total === 1240, m2 ?? String(lastOrder().total));
    const m3 = await charge(platformSale([rung('p-combo', 'Family Combo', 2000)], 'glovo'));
    ok('the item\'s own Glovo price wins (Family Combo 2,200, not 2,300)', m3 === null && lastOrder().total === 2200, m3 ?? String(lastOrder().total));

    const before = db.prepare(`SELECT COUNT(*) AS c FROM orders`).get().c;
    const low = platformSale([rung('p-chicken', '3 Piece Chicken', 1000)], 'glovo');
    low.items[0].unitPrice = 1050; low.items[0].lineTotal = 1050; low.total = low.subtotal = 1050; low.payments[0].amount = 1050;
    ok('a Glovo price LOWER than the rule gives is refused (never at the screen\'s word)', /prices changed/.test(await charge(low) ?? ''));
    const split = platformSale([rung('p-chicken', '3 Piece Chicken', 1000)], 'glovo', [{ method: 'glovo', amount: 650 }, { method: 'cash', amount: 500, amount_tendered: 500, change_given: 0 }]);
    ok('Glovo + cash is refused: a platform pays the whole bill', /whole bill/.test(await charge(split) ?? ''));
    const stale = platformSale([rung('p-chicken', '3 Piece Chicken', 1000)], 'glovo');
    DC.setPlatformPricing({ rounding: 'exact', rules: { glovo: { kind: 'percent', value: 20 } } });   // the rule changed meanwhile
    ok('a rule that changed since the screen priced it is refused (open the payment again)', /prices changed/.test(await charge(stale) ?? ''));
    DC.setPlatformPricing(PRICES);
    ok('…nothing refused was saved', db.prepare(`SELECT COUNT(*) AS c FROM orders`).get().c === before);

    const cash = { branch_id: BR, order_number: `T1-${++n}`, order_type: 'retail', subtotal: 1000, vat_amount: 0, total: 1000, items: [rung('p-chicken', '3 Piece Chicken', 1000)],
      payments: [{ method: 'cash', amount: 1000, amount_tendered: 1000, change_given: 0 }] };
    const mc = await charge(cash);
    const qc = queued(lastOrder().id);
    ok('a cash sale is untouched: normal prices, no platform recorded', mc === null && lastOrder().total === 1000 && !('price_list' in qc) && !('platform_rule' in qc), mc ?? JSON.stringify(qc));
    const claimCash = { ...cash, order_number: `T1-${++n}`, price_list: 'cash' };
    ok('a claim that is not a platform is dropped', await charge(claimCash) === null && !('price_list' in queued(lastOrder().id)));
  }

  console.log('\n5. The screens');
  {
    const modal = src('renderer/components/PaymentModal.tsx');
    ok('the payment screen prices for a platform as the ONE payment (the shared file, loaded when the payment opens)',
      /platformOfLegs\(legs, isPlatform\)/.test(modal) && /platformCart\(platform\)/.test(modal)
      && /const isPlatform = \(code: string\) => catalogueMethod\(code\)\?\.kind === 'delivery';/.test(modal));
    ok('…and never charges a platform before its prices are there', /const platformWaiting = !!platform && !quote;/.test(modal) && /&& !platformWaiting;/.test(modal));
    ok('picking a platform leaves one leg (no split), and "+ Split payment" is not offered with it', /legsAfterPick\(prev, i, m\.code, isPlatform\)/.test(modal) && /pays the whole bill/.test(modal));
    ok('Charge asks first only for a platform — "Charge to Glovo?" with its order # — every other method charges at once',
      /onClick=\{platform \? \(\) => setConfirmingPlatform\(true\) : handleConfirm\}/.test(modal) && /Charge to \{platformName\}\?/.test(modal) && /data-testid="platform-confirm"/.test(modal));
    ok('the screen says the platform prices plainly ("Glovo prices: 1,000 → 1,150")', /\{platformName\} prices: \{quote\.label\}/.test(modal));
    const page = src('renderer/pages/POSPage.tsx');
    ok('the sale screen sends the platform\'s lines, its subtotal, the claim and the rung lines', /\(payment\.platform\?\.lines \?\? cart\)\.map/.test(page)
      && /price_list: payment\.platform\.platform/.test(page) && /normal: \{ unitPrice: cart\[idx\]\.unitPrice/.test(page));
    ok('…with the rules read again each time the payment opens (main checks against the same)', /if \(!showPayment\) return;\s*posApi\.pos\.paymentMethodsEnabled\(\)/.test(page)
      && /platformPrices: getPlatformPricing\(\)/.test(src('main/ipc/branchSettings.ts')));
  }
} finally {
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
