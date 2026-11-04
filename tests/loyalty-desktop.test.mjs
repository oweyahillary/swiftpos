// Loyalty points on the desktop POS (owner, 2026-11-04: "1-5 yes only if the web licence is active").
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/loyalty-desktop.test.mjs
//
// When a customer is on the sale and the business has loyalty on, the desktop POS shows the points the sale earns and the
// customer's new balance after the sale, as the web's payment screen does — read online (the desktop holds no points) when
// the payment screen opens, with the online licence; offline, unlicensed or refused it shows nothing and never holds the
// sale up. GET /api/loyalty/customer/:id/points runs in the COMPILED server (the real requireAuth and
// requireAnyPermission) over HTTP on the in-memory database (tests/lib-memdb.mjs).
//
//   R  the read: a cashier (orders.create) gets the points, the tier and the earn rate; loyalty off → { enabled: false };
//      another business's customer 404; no right 403; nothing personal in the answer.
//   D  the desktop: a cashier's PIN sign-in with the licence 200; without 403 ONLINE_LICENCE_REQUIRED.
//   P  the rule (packages/core/tender): points earned as the cloud credits them (earn rate × tier), the new balance.
//   W  the wiring: main asks only with the licence and answers null on any failure; the sale screen asks when the payment
//      screen opens with a saved customer and the licence, never waits for it, and shows the two lines only with an answer.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - loyalty.ts /points without the desktopWithoutLicence check        → D "without the licence"
//   - loyalty.ts /points without .eq('business_id') on customers        → R "another business's customer"
//   - loyalty.ts /points not answering { enabled: false } when off      → R "loyalty off"
//   - tender.ts pointsEarned ignoring earnRate                          → P "the earn rate"
//   - customerDetails.ts without the licensed() check                   → W "main asks only with the licence"
//   - POSPage reading loyalty without onlineLicence                     → W "the sale screen"
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/onlineLicence.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.TERMINAL_WRITE_ENFORCE = 'true';
process.env.TILL_SCOPE_ENFORCE = 'true';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const warn = console.warn; console.warn = () => {};
const err = console.error; console.error = () => {};
const T8 = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/tender.ts')).href);

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', CATE = 'aaaaaaaa-0000-4000-8000-000000000002', KITCH = 'aaaaaaaa-0000-4000-8000-000000000004';
const MARY = 'dddddddd-0000-4000-8000-000000000001', THEIRS = 'dddddddd-0000-4000-8000-000000000002';
const perms = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });

const reset = ({ licensed = true, loyalty = true, rate = 2 } = {}) => {
  mem.fail = () => null; mem.calls = []; AC._resetAuthCache();
  const user = (id, name, role, branches) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, role_id: role ? `role-${id}` : null,
    roles: role, user_branches: branches.map((b) => ({ branch_id: b })), user_permissions: [] });
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Cafe', type: 'cafe', currency: 'KES', status: 'active' },
      { id: B2, owner_id: 'x', name: 'Other', type: 'cafe', currency: 'KES', status: 'active' }],
    branches: [{ id: W, business_id: B, name: 'Westlands', status: 'active', is_main: true }],
    users: [user(OWNER, 'Owner', { name: 'Admin', role_permissions: [] }, []),
      user(CATE, 'Cate', perms('Cashier', 'orders.create', 'products.view'), [W]),
      user(KITCH, 'Kit', perms('Kitchen', 'products.view'), [W])],
    user_devices: [],
    customers: [
      { id: MARY, business_id: B, name: 'Mary', phone: '0712345678', email: 'mary@example.com', loyalty_points: 1200 },
      { id: THEIRS, business_id: B2, name: 'Theirs', phone: '0700000000', loyalty_points: 99 }],
    business_settings: rate ? [{ business_id: B, key: 'loyalty_earn_rate', value: rate }] : [],
    feature_flags: [
      ...(licensed ? [{ business_id: B, key: 'web_hosting', enabled: true }] : []),
      ...(loyalty ? [{ business_id: B, key: 'loyalty_enabled', enabled: true }] : []),
    ],
    audit_log: [], refresh_tokens: [], sync_versions: [], sync_changes: [], branch_settings: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, isOwner: false, surface: 'dashboard', ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  cate: sign({ userId: CATE, branchId: W, permissionKeys: ['orders.create', 'products.view'] }),
  kitchen: sign({ userId: KITCH, branchId: W, permissionKeys: ['products.view'] }),
  cateTill: sign({ userId: CATE, branchId: W, permissionKeys: ['orders.create', 'products.view'], surface: 'desktop', pinSignIn: true }),
};
const points = async (id, token) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/loyalty/customer/${id}/points`, { headers: { authorization: `Bearer ${token}` } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body };
};

try {
  state._setPermissionsMigrated(true);

  console.log('\nR. the read\n');
  await ok('a cashier gets the points, the tier and the earn rate — nothing personal', async () => {
    reset();
    const r = await points(MARY, T.cate);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { enabled: true, points: 1200, tier: { name: 'Silver', multiplier: 1.5, next: 5000 }, earn_rate: 2 });
  });
  await ok('no earn rate set: 1', async () => {
    reset({ rate: 0 });
    assert.equal((await points(MARY, T.cate)).body.earn_rate, 1);
  });
  await ok('loyalty off: { enabled: false } (the POS shows nothing)', async () => {
    reset({ loyalty: false });
    const r = await points(MARY, T.cate);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { enabled: false });
  });
  await ok('another business\'s customer: 404', async () => {
    reset();
    assert.equal((await points(THEIRS, T.cate)).status, 404);
  });
  await ok('no right to sell or see customers: 403', async () => {
    reset();
    assert.equal((await points(MARY, T.kitchen)).status, 403);
  });

  console.log('\nD. the desktop POS\n');
  await ok('a cashier\'s PIN sign-in on a desktop POS with the online licence: 200', async () => {
    reset();
    const r = await points(MARY, T.cateTill);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.points, 1200);
  });
  await ok('without the online licence: 403 ONLINE_LICENCE_REQUIRED', async () => {
    reset({ licensed: false });
    const r = await points(MARY, T.cateTill);
    assert.equal(r.status, 403);
    assert.equal(r.body?.code, 'ONLINE_LICENCE_REQUIRED');
  });

  console.log('\nP. the rule\n');
  await ok('points earned as the cloud credits them: floor(floor(bill / 10) × earn rate × tier)', async () => {
    assert.equal(T8.pointsEarned(1234, 1.5, 2), Math.floor(Math.floor(1234 / 10) * 2 * 1.5));   // 369
    assert.equal(T8.pointsEarned(1234, 1.5), 184, 'the web\'s two-argument call is unchanged');
    assert.equal(T8.pointsEarned(9.99, 2, 2), 0);
    assert.equal(T8.pointsEarned(-50, 1, 1), 0);
  });
  await ok('the new balance is the points before the sale plus what it earns', async () => {
    assert.deepEqual(T8.pointsAfterSale({ points: 1200, multiplier: 1.5, earnRate: 2 }, 1234), { earned: 369, balance: 1569 });
    assert.deepEqual(T8.pointsAfterSale({ points: 0, multiplier: 1, earnRate: 1 }, 5), { earned: 0, balance: 0 });
  });

  console.log('\nW. the wiring\n');
  await ok('main asks only with the licence, as the person signed in, and answers null on any failure or loyalty off', async () => {
    const c = read('apps/desktop/src/main/ipc/customerDetails.ts');
    const h = c.slice(c.indexOf("handle('customer:loyaltyPoints'"));
    assert.match(h, /^handle\('customer:loyaltyPoints', async \(_e, customerId: string\) => \{\s+if \(!licensed\(\)\) return null;/);
    assert.match(h, /manageFetch\(`\/api\/loyalty\/customer\/\$\{encodeURIComponent\(customerId\)\}\/points`, 'GET'\)/);
    assert.match(h, /if \(r\?\.enabled !== true\) return null;/);
    assert.match(h, /\} catch \{\s+return null;/);
  });
  await ok('the sale screen: asks when the payment screen opens with a saved customer and the licence, never waits for it', async () => {
    const p = read('apps/desktop/src/renderer/pages/POSPage.tsx');
    assert.match(p, /const loyaltyCustomer: string \| null = onlineLicence \? \(buyer\?\.sale\?\.customer_id \?\? null\) : null;/);
    assert.match(p, /if \(!showPayment \|\| !loyaltyCustomer\) return;/);
    const charge = p.slice(p.indexOf('const handleCharge = async'), p.indexOf('const handleNewOrder'));
    assert.doesNotMatch(charge, /loyaltyPoints\(/, 'the charge does not ask (or wait)');
    assert.match(charge, /loyalty: loyaltyBefore \? pointsAfterSale\(loyaltyBefore, payment\.total\) : null/);
    assert.match(p, /\{completedOrder\.loyalty && \(\s+<div data-testid="loyalty-after-sale">/);
    assert.match(p, /<Row l="Points earned" v=\{`\+ \$\{completedOrder\.loyalty\.earned\.toLocaleString\(\)\} pts`\} \/>/);
    assert.match(p, /<Row l="New balance" v=\{`\$\{completedOrder\.loyalty\.balance\.toLocaleString\(\)\} pts`\} \/>/);
  });
} finally {
  server.close();
  console.warn = warn; console.error = err;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
