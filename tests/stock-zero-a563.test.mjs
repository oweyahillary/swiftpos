/**
 * stock-zero-a563.test.mjs — A563: when an item's stock reaches zero — sell as normal, show as sold out, or hide (the
 * owner's choice). The cloud's half and the web.
 *
 * Owner, 2026-10-22: "add a feature where an owner can enable not to prevent items with zero stock from appearing in the
 * inventory or if they do they cannot be sold".
 *
 * RUNS the COMPILED controls, pos and orders routers behind the REAL auth middleware over HTTP; the database in memory
 * (tests/lib-memdb.mjs), create_order_atomic emulated. The shared rules (packages/core/src/stockGate.ts) run directly.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/stock-zero-a563.test.mjs
 *
 *   S  the rules: the choice from the switches; a tracked level ≤ 0 is out; unknown and untracked sell; a combo is out
 *      when a tracked item in it is; a sale refused only for the lines stock is known not to cover.
 *   N  OFF for every client (owner, 2026-10-22): a freshly created business reads "Sell as normal"; nothing that creates a
 *      business (onboarding, admin create-client, migrations, seeds) writes either switch — only the owner turns it on.
 *   O  the owner sets it: PUT /api/controls/stock-zero (settings.pos; a cashier 403; a bad mode 400), GET /api/controls
 *      reads it back; the two switches are the owner's (the admin portal is refused, OWNER_SETS); pos/init's
 *      posFeatures carries them (the setting syncs to the tills).
 *   W  a LIVE web sale of a sold-out item is refused (409 SOLD_OUT) in "sold out" and "hide"; sold in "sell"; an untracked
 *      or unknown item always sold; an open bill charged on the web refused for the line that sold out since.
 *   T  a till's pushed sale is NEVER refused for stock (it already happened) — X-Device-Id, or made with its own time.
 *   V  GET /api/pos/stock-view: the choice and this branch's levels (another branch's: 403); the web POS greys or hides.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - orders.ts POST / without the webSaleStockRefusal check           → W "refused in sold-out mode" fails
 *   - the check applied to a till's sale too (condition removed)       → T "a till's push is never refused" fails
 *   - stockRefusals ignoring the mode (refusing in "sell")             → S "refusals: …" fails
 *   - controls.ts ownerSetsFeature without STOCK_ZERO_KEYS              → O "the admin portal is refused" fails
 *   - branchStockView without the track_stock filters (the query's and the row filter together — each alone is still
 *     caught by the other)                                             → W "an untracked item at 0 is sold" + V fail
 *   - outOfStockMode ignoring stock_zero_hide                           → S "the choice", O, W "hide" and V fail
 *   - availableOf treating no level as 0                                → S "out = …", W "unknown … is sold" fail
 *   - POST /:id/pay without the check                                  → W "an open bill … refused" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/stockGateStore.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
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
const log = console.log; const quiet = () => {}; console.info = quiet; console.warn = quiet; console.error = quiet;
const G = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/stockGate.ts')).href);

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-2222-4222-8222-222222222222';
const OWNER = '44444444-4444-4444-8444-444444444444', TOM = 'cccccccc-0000-4000-8000-000000000001';
const CHIPS = 'aaaaaaaa-0000-4000-8000-000000000001', TEA = 'aaaaaaaa-0000-4000-8000-000000000002', SODA = 'aaaaaaaa-0000-4000-8000-000000000003';
const NEW = 'aaaaaaaa-0000-4000-8000-000000000004', BURGER = 'aaaaaaaa-0000-4000-8000-000000000005', COMBO = 'aaaaaaaa-0000-4000-8000-000000000006';
const reset = (flags = {}) => {
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity;
  mem.db = {
    businesses: [{ id: B, name: 'Mama Ngina Foods', owner_id: OWNER, currency: 'KES', vat_rate: 16, ctl_rate: 0, type: 'restaurant', status: 'active' }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B }, { id: TOM, name: 'Tom', status: 'active', business_id: B }],
    branches: [{ id: BR, business_id: B, name: 'Westlands' }, { id: BR2, business_id: B, name: 'Kilimani' }],
    products: [
      { id: CHIPS, business_id: B, name: 'Chips', base_price: 100, track_stock: true, status: 'active' },
      { id: TEA, business_id: B, name: 'Tea', base_price: 100, track_stock: false, status: 'active' },
      { id: SODA, business_id: B, name: 'Soda', base_price: 100, track_stock: true, status: 'active' },
      { id: NEW, business_id: B, name: 'Samosa', base_price: 100, track_stock: true, status: 'active' },
      { id: BURGER, business_id: B, name: 'Burger', base_price: 100, track_stock: true, status: 'active' },
      { id: COMBO, business_id: B, name: 'Burger Combo', base_price: 100, track_stock: false, is_combo: true, status: 'active' },
    ],
    stock_levels: [
      { id: 's1', product_id: CHIPS, branch_id: BR, quantity: 0 }, { id: 's2', product_id: TEA, branch_id: BR, quantity: 0 },
      { id: 's3', product_id: SODA, branch_id: BR, quantity: 2 }, { id: 's4', product_id: BURGER, branch_id: BR, quantity: 5 },
      { id: 's5', product_id: NEW, branch_id: BR2, quantity: 9 }, { id: 's6', product_id: CHIPS, branch_id: BR2, quantity: 7 },
    ],
    combo_items: [{ id: 'c1', combo_id: COMBO, product_id: BURGER, quantity: 1 }, { id: 'c2', combo_id: COMBO, product_id: CHIPS, quantity: 1 }],
    variant_groups: [], modifier_groups: [], branch_prices: [], change_requests: [], user_devices: [], orders: [], order_items: [], payments: [],
    order_price_variances: [], kitchen_tickets: [], business_settings: [], branch_settings: [], shifts: [], stock_takes: [],
    feature_flags: Object.entries(flags).map(([key, enabled]) => ({ business_id: B, key, enabled })),
  };
};
reset();
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
const controls = require(path.join(DIST, 'routes/controls.js'));
app.use('/api/controls', controls.default);
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
const line = (id, name, quantity = 1) => ({ product: { id, name }, quantity, unitPrice: 100, lineTotal: 100 * quantity });
const sale = (items) => { const total = items.reduce((s, i) => s + i.lineTotal, 0);
  return { branch_id: BR, order_number: `W-${Math.floor(Math.random() * 1e6)}`, items, total, subtotal: total, payments: [{ method: 'cash', amount: total }] }; };
const webSale = (items) => req('POST', '/api/orders', sale(items), cashier);
const tillPush = (items, headers = { 'X-Device-Id': 'dev-T1' }) => req('POST', '/api/orders', { created_at: '2026-10-22T09:00:00Z', ...sale(items) },
  tok('desktop', TOM), { 'X-Idempotency-Key': randomUUID(), ...headers });
const mode = (m) => Object.fromEntries(Object.entries(G.outOfStockFlags(m)));

try {
  log('\nS — the rules (packages/core/src/stockGate.ts)\n');
  await ok('the choice from the switches: none → sell; sold out; hide (hide wins over sold out)', () => {
    assert.equal(G.outOfStockMode(null), 'sell'); assert.equal(G.outOfStockMode({ stock_zero_sold_out: true }), 'sold_out');
    assert.equal(G.outOfStockMode({ stock_zero_hide: true, stock_zero_sold_out: true }), 'hide');
    assert.equal(G.outOfStockMode({ stock_zero_hide: 'true' }), 'sell');   // only a real true
  });
  await ok('out = a known tracked level ≤ 0; unknown never; a combo when a tracked item in it is (fewest whole combos)', () => {
    const v = { levels: { a: 0, b: 3, c: -2 }, combos: { k: [{ product_id: 'b', quantity: 2 }, { product_id: 'z', quantity: 1 }] } };
    assert.ok(G.isOutOfStock(v, 'a') && G.isOutOfStock(v, 'c') && !G.isOutOfStock(v, 'b') && !G.isOutOfStock(v, 'z'));
    assert.equal(G.availableOf(v, 'z'), null); assert.equal(G.availableOf(v, 'k'), 1);
    assert.ok(G.isOutOfStock({ levels: { b: 1 }, combos: v.combos }, 'k'));
  });
  await ok('sold out greys, hide hides, sell does neither', () => {
    const v = { levels: { a: 0 } };
    assert.ok(G.showsSoldOut('sold_out', v, 'a') && !G.hiddenOutOfStock('sold_out', v, 'a'));
    assert.ok(G.hiddenOutOfStock('hide', v, 'a') && !G.showsSoldOut('hide', v, 'a'));
    assert.ok(!G.showsSoldOut('sell', v, 'a') && !G.hiddenOutOfStock('sell', v, 'a'));
  });
  await ok('refusals: only the lines stock does not cover, counting the whole sale (a combo uses its items)', () => {
    const v = { levels: { a: 0, b: 2 }, combos: { k: [{ product_id: 'b', quantity: 1 }] } };
    assert.deepEqual(G.stockRefusals('sell', v, [{ product_id: 'a', name: 'A', quantity: 1 }]), []);
    const r = G.stockRefusals('sold_out', v, [{ product_id: 'a', name: 'A', quantity: 1 }, { product_id: 'b', name: 'B', quantity: 1 }, { product_id: 'x', name: 'X', quantity: 9 }]);
    assert.deepEqual(r.map((x) => x.index), [0]); assert.equal(r[0].message, 'A is sold out.');
    const r2 = G.stockRefusals('hide', v, [{ product_id: 'b', name: 'B', quantity: 2 }, { product_id: 'k', name: 'K', quantity: 1 }]);
    assert.deepEqual(r2.map((x) => x.index), [0, 1]); assert.match(r2[0].message, /Only 2 of B left/);
  });

  log('\nN — off by default for every client\n');
  await ok('a freshly created business (no switch rows) reads "Sell as normal" — the POS switches, the cloud\'s check, GET /api/controls', async () => {
    reset();
    const fresh = randomUUID();
    mem.db.businesses.push({ id: fresh, name: 'New Client', owner_id: OWNER, currency: 'KES', type: 'retail', status: 'active' });
    const { businessPosFeatures } = require(path.join(DIST, 'lib/posFeatureFlags.js'));
    const f = await businessPosFeatures(fresh);
    assert.equal(f.stock_zero_sold_out, false); assert.equal(f.stock_zero_hide, false);
    assert.equal(G.outOfStockMode(f), 'sell');
    const { businessOutOfStockMode } = require(path.join(DIST, 'lib/stockGateStore.js'));
    assert.equal(await businessOutOfStockMode(fresh), 'sell');
    assert.deepEqual((await req('GET', '/api/controls', null, owner)).body.stock, { when_zero: 'sell' });
  });
  await ok('nothing that creates a business sets it: onboarding, admin create-client, enrolment, sign-up, migrations and scripts never name the switches', () => {
    for (const f of ['apps/server/src/routes/onboarding.ts', 'apps/server/src/routes/admin.ts', 'apps/server/src/routes/enrol.ts', 'apps/server/src/routes/auth.ts']) {
      assert.doesNotMatch(read(f), /stock_zero/, f);
    }
    for (const dir of ['migrations', 'scripts']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => /\.(sql|mjs|js)$/.test(x))) assert.doesNotMatch(read(`${dir}/${f}`), /stock_zero/, `${dir}/${f}`);
    }
    // The one writer is the owner's PUT /api/controls/stock-zero (settings.pos).
    assert.match(read('apps/server/src/routes/controls.ts'), /router\.put\('\/stock-zero', requirePermission\('settings\.pos'\)/);
  });

  log('\nO — the owner sets it; it syncs\n');
  await ok('GET /api/controls: "sell" until set', async () => {
    const r = await req('GET', '/api/controls', null, owner);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.stock, { when_zero: 'sell' });
  });
  await ok('PUT /api/controls/stock-zero { mode: "hide" } (owner): the two switches written; read back as "hide"', async () => {
    const r = await req('PUT', '/api/controls/stock-zero', { mode: 'hide' }, owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = Object.fromEntries(mem.db.feature_flags.filter((x) => x.business_id === B).map((x) => [x.key, x.enabled]));
    assert.deepEqual({ s: f.stock_zero_sold_out, h: f.stock_zero_hide }, { s: false, h: true });
    assert.deepEqual((await req('GET', '/api/controls', null, owner)).body.stock, { when_zero: 'hide' });
    await req('PUT', '/api/controls/stock-zero', { mode: 'sold_out' }, owner);
    assert.deepEqual((await req('GET', '/api/controls', null, owner)).body.stock, { when_zero: 'sold_out' });
  });
  await ok('a bad mode 400; a cashier (no settings.pos) 403', async () => {
    assert.equal((await req('PUT', '/api/controls/stock-zero', { mode: 'never' }, owner)).status, 400);
    assert.equal((await req('PUT', '/api/controls/stock-zero', { mode: 'sell' }, cashier)).status, 403);
  });
  await ok('the switches are the owner\'s: the admin portal is refused (OWNER_SETS)', () => {
    assert.ok(controls.ownerSetsFeature('stock_zero_sold_out') && controls.ownerSetsFeature('stock_zero_hide'));
    assert.match(read('apps/admin/src/ownerSettings.ts'), /'stock_zero_sold_out', 'stock_zero_hide'(, 'approval_pin')?\] as const;/);
  });
  await ok('the setting syncs: the cloud\'s POS switches (what pos/init sends as posFeatures) carry it', async () => {
    const { businessPosFeatures } = require(path.join(DIST, 'lib/posFeatureFlags.js'));
    const f = await businessPosFeatures(B);
    assert.equal(f.stock_zero_sold_out, true); assert.equal(f.stock_zero_hide, false);
    assert.match(read('apps/server/src/routes/pos.ts'), /const \{ data \} = await supabase\.from\('feature_flags'\)\.select\('key, enabled'\)\n\s+\.eq\('business_id', req\.businessId\)\.in\('key', \[\.\.\.POS_FEATURE_KEYS, ATTENDANCE_FLAG, 'etims_enabled'\]\);[\s\S]{0,200}posFeatures: parsePosFeatures\(rows\.filter\(\(r\) => r\.key !== ATTENDANCE_FLAG && r\.key !== 'etims_enabled'\)\)/);   // A599 / A607: the same read carries the attendance and eTIMS flags
  });

  log('\nW — a live web sale\n');
  await ok('sell as normal: a web sale of Chips at 0 goes through', async () => {
    reset(); const r = await webSale([line(CHIPS, 'Chips')]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
  await ok('sold out: a web sale of Chips at 0 is refused (409 SOLD_OUT, "Chips is sold out.") and nothing is saved', async () => {
    reset(mode('sold_out')); const r = await webSale([line(CHIPS, 'Chips'), line(BURGER, 'Burger')]);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'SOLD_OUT');
    assert.match(r.body.error, /Chips is sold out\./); assert.doesNotMatch(r.body.error, /Burger/);
    assert.deepEqual(r.body.items.map((i) => i.product_id), [CHIPS]); assert.equal(mem.db.orders.length, 0);
  });
  await ok('hide: refused the same way; more than the branch has: "Only 2 of Soda left."', async () => {
    reset(mode('hide'));
    assert.equal((await webSale([line(CHIPS, 'Chips')])).status, 409);
    const r = await webSale([line(SODA, 'Soda', 3)]);
    assert.equal(r.status, 409); assert.match(r.body.error, /Only 2 of Soda left\./);
    assert.equal((await webSale([line(SODA, 'Soda', 2)])).status, 201);
  });
  await ok('an untracked item at 0 is sold; an item with no level at this branch (unknown) is sold', async () => {
    reset(mode('sold_out'));
    assert.equal((await webSale([line(TEA, 'Tea')])).status, 201);
    assert.equal((await webSale([line(NEW, 'Samosa')])).status, 201);
  });
  await ok('a combo with a tracked item out is refused', async () => {
    reset(mode('sold_out')); const r = await webSale([line(COMBO, 'Burger Combo')]);
    assert.equal(r.status, 409); assert.match(r.body.error, /Burger Combo is sold out/);
  });
  await ok('a read that fails = nothing known = the sale goes ahead', async () => {
    reset(mode('sold_out')); mem.fail = (t, op) => (t === 'stock_levels' && op === 'select' ? { message: 'timeout' } : null);
    assert.equal((await webSale([line(CHIPS, 'Chips')])).status, 201);
  });
  await ok('an open bill charged on the web: the line that sold out since it was opened is refused', async () => {
    reset(mode('sold_out'));
    const id = randomUUID();
    mem.db.orders.push({ id, business_id: B, branch_id: BR, order_number: 'W-OPEN', status: 'open', total: 200, subtotal: 200,
      order_items: [{ id: 'oi1', product_id: CHIPS, product_name: 'Chips', quantity: 1, unit_price: 100, subtotal: 100 },
        { id: 'oi2', product_id: BURGER, product_name: 'Burger', quantity: 1, unit_price: 100, subtotal: 100 }] });
    const r = await req('POST', `/api/orders/${id}/pay`, { payments: [{ method: 'cash', amount: 200 }] }, cashier);
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.match(r.body.error, /Chips is sold out\./);
  });

  log('\nT — a till\'s pushed sale is never refused\n');
  await ok('sold out / hide: a till\'s push of Chips sold at 0 is recorded (201) — with X-Device-Id', async () => {
    for (const m of ['sold_out', 'hide']) {
      reset(mode(m)); const r = await tillPush([line(CHIPS, 'Chips', 3)]);
      assert.equal(r.status, 201, `${m}: ${JSON.stringify(r.body)}`);
    }
  });
  await ok('…and without the header (made with its own time): recorded', async () => {
    reset(mode('sold_out')); const r = await tillPush([line(CHIPS, 'Chips')], {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  log('\nV — the web POS\'s view\n');
  await ok('GET /api/pos/stock-view: the choice and this branch\'s known levels of tracked items (no untracked, no other branch)', async () => {
    reset(mode('hide'));
    const r = await req('GET', `/api/pos/stock-view?branch_id=${BR}`, null, cashier);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.mode, 'hide');
    assert.deepEqual(r.body.levels, { [CHIPS]: 0, [SODA]: 2, [BURGER]: 5 });
    assert.equal(r.body.combos[COMBO].length, 2);
    reset();
    const s = await req('GET', `/api/pos/stock-view?branch_id=${BR}`, null, cashier);
    assert.equal(s.body.mode, 'sell'); assert.deepEqual(s.body.levels, {});
  });
  await ok('…another branch: 403', async () => {
    assert.equal((await req('GET', `/api/pos/stock-view?branch_id=${BR2}`, null, cashier)).status, 403);
  });
  await ok('the web POS greys a sold-out card, hides one in hide mode, refuses a tap; the setting is a radio on POS options', () => {
    const c = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    assert.match(c, /const matchStock = !hiddenOutOfStock\(stockView\.mode, stockView, p\.id\);/);
    assert.match(c, /const soldOut = showsSoldOut\(stockView\.mode, stockView, product\.id\);/);
    assert.match(c, /const mine = stockRefusals\(stockView\.mode, stockView, lines\)\.find/);
    const o = read('apps/dashboard/src/pages/settings/OwnerControls.tsx');
    assert.match(o, /When an item's stock reaches zero/); assert.match(o, /api\.put\('\/api\/controls\/stock-zero', \{ mode \}\)/);
  });
} finally {
  server.close();
}
log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
