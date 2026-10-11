/**
 * offers-cloud.test.mjs — A445: the cloud's side of offers. RUNS the built routes (apps/server/dist) over real HTTP
 * against an in-memory database: who may create and change an offer (owner every branch, a manager only their own),
 * what an offer may name, what the tills are sent (pos/init), and the check of a sale's claimed offers
 * (orders.ts checkOfferClaim — the SAME engine as the till, on the cloud's own prices).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/offers-cloud.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: a manager's branch_ids not forced → "a manager's offer is for their own branch" fails;
 * mayEdit allowing a business-wide offer → "a manager cannot change the owner's every-branch offer" fails; the claim
 * not capped by the engine → "a sale never gets more off than the offers give" fails; another business's offer
 * honoured → its pin fails; the manual discount capped on the whole subtotal → its pin fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

if (!fs.existsSync(path.join(DIST, 'routes/offers.js'))) {
  console.log('\nCannot load apps/server/dist/routes/offers.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

const BZ = '11111111-1111-4111-8111-111111111111', OTHER_BZ = '99999999-9999-4999-8999-999999999999';
const BR_W = '22222222-2222-4222-8222-222222222222', BR_K = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444', MARY = '55555555-5555-4555-8555-555555555555';
const SODA = '66666666-6666-4666-8666-666666666666', BURGER = '77777777-7777-4777-8777-777777777777';
const FOREIGN = '88888888-8888-4888-8888-888888888888', DRINKS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let db; let seq = 0;
const reset = () => {
  db = {
    users: [{ id: OWNER, business_id: BZ, name: 'Owner', status: 'active', permissions_version: 0 },
            { id: MARY, business_id: BZ, name: 'Mary', status: 'active', permissions_version: 0 }],
    products: [{ id: SODA, business_id: BZ, category_id: DRINKS, base_price: 100 }, { id: BURGER, business_id: BZ, category_id: null, base_price: 600 },
               { id: FOREIGN, business_id: OTHER_BZ, category_id: null, base_price: 50 }],
    categories: [{ id: DRINKS, business_id: BZ }],
    branches: [{ id: BR_W, business_id: BZ }, { id: BR_K, business_id: BZ }],
    offers: [],
  };
};
reset();

// A small in-memory PostgREST: select / eq / in / is / order / maybeSingle / single / insert / update.
supabase.from = (table) => {
  const f = []; let op = 'select'; let payload = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (op === 'insert') {
      const row = { id: `0000000${++seq}-0000-4000-8000-000000000000`.slice(-36).replace(/^0+/, (m) => '0'.repeat(m.length)),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null, ...payload };
      row.id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
      (db[table] ??= []).push(row);
      return [row];
    }
    if (op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, payload)); return hit; }
    return rows();
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'insert') return (row) => { op = 'insert'; payload = row; return q; };
      if (prop === 'update') return (row) => { op = 'update'; payload = row; return q; };
      if (prop === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const d = run()[0]; return Promise.resolve(d ? { data: d, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/offers', require(path.join(DIST, 'routes/offers.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const URL_ = `http://127.0.0.1:${server.address().port}/api/offers`;
const tok = (who) => jwt.sign(who === 'owner'
  ? { userId: OWNER, businessId: BZ, branchId: null, isOwner: true, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'dashboard' }
  : { userId: MARY, businessId: BZ, branchId: BR_W, isOwner: false, permissionKeys: ['products.manage'], permissionsVersion: 0, sessionId: 's', surface: 'dashboard' },
  process.env.JWT_SECRET);
const call = async (who, method, url = '', body) => {
  const r = await fetch(`${URL_}${url}`, { method, headers: { Authorization: `Bearer ${tok(who)}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const drinks20 = { name: 'Drinks 20%', kind: 'percent_off', value: 20, applies_to: 'categories', category_ids: [DRINKS] };

console.log('\nWho may create and change an offer\n');
await ok('the owner creates an offer for every branch', async () => {
  const r = await call('owner', 'POST', '', drinks20);
  assert(r.status === 201 && r.body.branch_ids === null && r.body.created_by_name === 'Owner', JSON.stringify(r));
});
await ok('a manager\'s offer is for their own branch, whatever they send', async () => {
  const r = await call('mary', 'POST', '', { ...drinks20, name: 'Westlands only', branch_ids: [BR_K] });
  assert(r.status === 201 && JSON.stringify(r.body.branch_ids) === JSON.stringify([BR_W]), JSON.stringify(r.body));
});
await ok('a manager cannot change (or delete) the owner\'s every-branch offer', async () => {
  const owners = db.offers.find((o) => o.branch_ids === null);
  const p = await call('mary', 'PATCH', `/${owners.id}`, { value: 50 });
  const d = await call('mary', 'DELETE', `/${owners.id}`);
  assert(p.status === 403 && d.status === 403 && owners.value === 20 && owners.deleted_at === null, `${p.status} ${d.status}`);
});
await ok('…and sees it as not editable; their own is', async () => {
  const r = await call('mary', 'GET');
  const mine = r.body.find((o) => o.name === 'Westlands only'), owners = r.body.find((o) => o.name === 'Drinks 20%');
  assert(mine?.editable === true && owners?.editable === false, JSON.stringify(r.body.map((o) => [o.name, o.editable])));
});
await ok('a manager does not see another branch\'s offer', async () => {
  await call('owner', 'POST', '', { ...drinks20, name: 'Kilimani only', branch_ids: [BR_K] });
  const r = await call('mary', 'GET');
  assert(!r.body.some((o) => o.name === 'Kilimani only'), JSON.stringify(r.body.map((o) => o.name)));
});
await ok('an offer may name only the business\'s own products and branches', async () => {
  const a = await call('owner', 'POST', '', { name: 'X', kind: 'amount_off', value: 10, applies_to: 'products', product_ids: [FOREIGN] });
  const b = await call('owner', 'POST', '', { ...drinks20, branch_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] });
  assert(a.status === 400 && /not on your menu/.test(a.body.error) && b.status === 400, `${a.status} ${b.status}`);
});
await ok('a bad offer is refused with the reason (the shared rules)', async () => {
  const r = await call('owner', 'POST', '', { name: 'X', kind: 'percent_off', value: 150 });
  assert(r.status === 400 && /between 1 and 100/.test(r.body.error), JSON.stringify(r.body));
});
await ok('delete marks it (the tills\' catalogue check sees it; sales keep naming it)', async () => {
  const mine = db.offers.find((o) => o.name === 'Westlands only');
  const r = await call('mary', 'DELETE', `/${mine.id}`);
  assert(r.status === 200 && mine.deleted_at && mine.active === false && db.offers.includes(mine), JSON.stringify(mine));
});

console.log('\nWhat the tills are sent (pos/init)\n');
await ok('the offers a branch runs: on, not deleted, every-branch or this branch', async () => {
  const { offersForBranch } = require(path.join(DIST, 'routes/offers.js'));
  const w = (await offersForBranch(BZ, BR_W)).map((o) => o.name).sort();
  const k = (await offersForBranch(BZ, BR_K)).map((o) => o.name).sort();
  assert(JSON.stringify(w) === '["Drinks 20%"]' && JSON.stringify(k) === '["Drinks 20%","Kilimani only"]', `${w} | ${k}`);
});

console.log('\nThe cloud\'s check of a sale\'s offers\n');
const { checkOfferClaim, offerClaimFrom } = require(path.join(DIST, 'routes/orders.js'));
const drinks = db.offers.find((o) => o.name === 'Drinks 20%');
const lines = [{ key: '0', product_id: SODA, category_id: DRINKS, unit_price: 100, quantity: 3 }, { key: '1', product_id: BURGER, category_id: null, unit_price: 600, quantity: 1 }];
await ok('a sale\'s claim matching the offers is kept, with the offers by name', async () => {
  const r = await checkOfferClaim(BZ, BR_W, lines, offerClaimFrom({ offer_discount: 60, offers: [{ offer_id: drinks.id }] }), 900);
  assert(r.offerDiscount === 60 && r.offers[0].name === 'Drinks 20%' && r.offers[0].amount === 60, JSON.stringify(r));
});
await ok('a sale never gets more off than the offers give (a claim of 500 → 60)', async () => {
  const r = await checkOfferClaim(BZ, BR_W, lines, offerClaimFrom({ offer_discount: 500, offers: [{ offer_id: drinks.id }] }), 900);
  assert(r.offerDiscount === 60, JSON.stringify(r));
});
await ok('…a claim below what they give is the sale\'s own figure (the offer changed since)', async () => {
  const r = await checkOfferClaim(BZ, BR_W, lines, offerClaimFrom({ offer_discount: 40, offers: [{ offer_id: drinks.id }] }), 900);
  assert(r.offerDiscount === 40 && r.offers[0].amount === 40, JSON.stringify(r));
});
await ok('an offer switched off or deleted since is still honoured (the sale was made while it ran)', async () => {
  drinks.active = false;
  const r = await checkOfferClaim(BZ, BR_W, lines, offerClaimFrom({ offer_discount: 60, offers: [{ offer_id: drinks.id }] }), 900);
  drinks.active = true;
  assert(r.offerDiscount === 60, JSON.stringify(r));
});
await ok('another business\'s offer, or an unknown one, gives nothing', async () => {
  db.offers.push({ ...drinks, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', business_id: OTHER_BZ });
  const r = await checkOfferClaim(BZ, BR_W, lines, offerClaimFrom({ offer_discount: 60, offers: [{ offer_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] }), 900);
  const u = await checkOfferClaim(BZ, BR_W, lines, offerClaimFrom({ offer_discount: 60, offers: [{ offer_id: 'not-a-uuid' }] }), 900);
  assert(r.offerDiscount === 0 && u.offerDiscount === 0, `${JSON.stringify(r)} ${JSON.stringify(u)}`);
});
await ok('a sale with no offers is unchanged (older tills, the web without offers)', async () => {
  const r = await checkOfferClaim(BZ, BR_W, lines, offerClaimFrom({ discount_amount: 50 }), 900);
  assert(r.offerDiscount === 0 && r.offers.length === 0);
});
await ok('the manual discount is the rest of discount_amount, capped as before on what is left after offers', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/orders.ts'), 'utf8');
  assert(/const manualAsked = claim\.ids\.length \? Math\.max\(0, \(Number\(discountAmount\) \|\| 0\) - claim\.amount\) : discountAmount;/.test(src)
    && /const discount = round2\(offerDiscount \+ capDiscount\(manualAsked, round2\(subtotal - offerDiscount\)\)\);/.test(src), 'POST /api/orders');
  assert(/const payDiscount = round2\(payOffers\.offerDiscount \+ capDiscount\(payManualAsked, round2\(paySubtotal - payOffers\.offerDiscount\)\)\);/.test(src), 'POST /:id/pay');
  assert(/update\(\{ offer_discount: recomputed\.offerDiscount, offers: recomputed\.offers \}\)/.test(src), 'stored on the sale');
});

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
