/**
 * pos-init-paging.test.mjs — cloud audit 2026-10-14 (P1-9): GET /api/pos/init reads a menu of any size.
 *
 * Before: the products read was one plain select (cut short at Supabase's row cap, 1000, silently), and variant_groups and
 * branch_prices were read with `.in('product_id', <every product id>)` — about 37 characters of URL per product, past the
 * 8 KB request line at ~220 products: /init failed (variants) or the branch's prices silently came back empty (the till
 * then sold at the base price). Now every list read in /init is paged (lib/pgQuery.pageAll) and every id list chunked
 * (chunkPaged, 150 ids).
 *
 * RUNS the COMPILED pos router behind the REAL auth middleware over HTTP; the database is in memory (tests/lib-memdb.mjs)
 * with Supabase's 1000-row cap, and any `.in()` of more than 200 ids refused the way the gateway refuses a long URL.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/pos-init-paging.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - the products read back to one plain select              → "all 1200 products" fails
 *   - branch_prices back to one .in() of every id              → "every product carries its branch price" fails
 *   - variant_groups back to one .in() of every id             → "/init answers 200 …" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/pos.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const pid = (i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
const N = 1200;
mem.db = {
  businesses: [{ id: B, name: 'Big Menu', type: 'restaurant', currency: 'KES', vat_rate: 16, ctl_rate: 0, status: 'active' }],
  branches: [{ id: BR, business_id: B, is_main: true, desktop_licensed: true, name: 'Main' }],
  products: Array.from({ length: N }, (_, i) => ({ id: pid(i), business_id: B, name: `Item ${i}`, base_price: 100, status: 'active', is_combo: false })),
  categories: [{ id: 'c2', business_id: B, name: 'B', status: 'active', sort_order: 2 }, { id: 'c1', business_id: B, name: 'A', status: 'active', sort_order: 1 }],
  variant_groups: [
    ...Array.from({ length: N }, (_, i) => ({ id: `vg-${String(i).padStart(5, '0')}`, product_id: pid(i), name: 'Size', sort_order: 0, variant_options: [] })),
    // One product with more groups than the row cap: a chunk of ids must be paged too.
    ...Array.from({ length: 1100 }, (_, i) => ({ id: `vx-${String(i).padStart(5, '0')}`, product_id: pid(0), name: `Extra ${i}`, sort_order: 1, variant_options: [] })),
  ],
  branch_prices: Array.from({ length: N }, (_, i) => ({ id: `bp-${String(i).padStart(5, '0')}`, branch_id: BR, product_id: pid(i), price: 150 })),
  business_settings: [], branch_settings: [], feature_flags: [], business_branding: [], payment_methods: [], offers: [], stock_takes: [],
  // A494: requireAuth refuses a token whose person has no users row — the signed-in person is a row of this business.
  users: [{ id: 'aaaaaaaa-0000-4000-8000-0000000000a1', business_id: B, status: 'active', permissions_version: 1 }],
};
mem.rowCap = 1000;
mem.fail = (_t, _op, filters) => {
  for (const [k, v] of Object.entries(filters)) if (k.endsWith(':in') && Array.isArray(v) && v.length > 200) return { message: '414 Request-URI Too Large' };
  return null;
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/pos', require(path.join(DIST, 'routes/pos.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
try {
  const t = jwt.sign({ userId: 'aaaaaaaa-0000-4000-8000-0000000000a1', businessId: B, branchId: BR, isOwner: false, permissionKeys: [], permissionsVersion: 0, sessionId: 's', surface: 'web' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/pos/init?branch_id=${BR}`, { headers: { Authorization: `Bearer ${t}` } });
  const body = await res.json().catch(() => null);
  await ok('/init answers 200 for a 1200-product menu (no id list overflows the URL)', () => assert.equal(res.status, 200, JSON.stringify(body)?.slice(0, 300)));
  await ok('all 1200 products reach the till (paged past the 1000-row cap)', () => assert.equal(body.products.length, N));
  await ok('every product carries its branch price (chunked, never silently empty)', () =>
    assert.ok(body.products.every((p) => Number(p.branch_price) === 150), String(body.products.filter((p) => Number(p.branch_price) !== 150).length)));
  await ok('every product\'s variants arrive — all 1101 groups of the one past the row cap too (each chunk paged)', () => {
    assert.equal(Object.keys(body.variantsByProduct).length, N);
    assert.equal(body.variantsByProduct[pid(0)].length, 1101);
  });
  await ok('categories in the menu\'s own order (sort_order), as before', () => assert.deepEqual(body.categories.map((c) => c.name), ['A', 'B']));
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
