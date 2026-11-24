/**
 * a625-per-branch-menu.test.mjs — A625 (owner, 2026-11-23): a product can be off a branch's menu.
 *   - lib/branchMenu.ts: hiddenProductsAt (the hidden ids) and branchMenuRefusal (a LIVE web sale of a hidden product → NOT_ON_MENU).
 *   - the wiring: pos.ts drops the hidden products from the branch's pull; orders.ts refuses a live web sale of one; products.ts
 *     exposes GET /branch-availability and PUT /:id/branches.
 * No rows = every product on every branch (the default) — so nothing changes for existing businesses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';
import assert from 'node:assert';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/branchMenu.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const M = require(path.join(DIST, 'lib/branchMenu.js'));
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const B = '11111111-1111-4111-8111-111111111111';
const BR1 = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-2222-4222-8222-222222222222';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001', P2 = 'aaaaaaaa-0000-4000-8000-000000000002';

console.log('\nA625 — per-branch menu (lib/branchMenu + the wiring)\n');

mem.db = { product_branches_hidden: [{ product_id: P1, branch_id: BR2, business_id: B }] };   // P1 off CBD (BR2) only

await ok('hiddenProductsAt: the branch with an exclusion returns it; another branch returns nothing', async () => {
  assert.deepEqual([...await M.hiddenProductsAt(B, BR2)], [P1]);
  assert.deepEqual([...await M.hiddenProductsAt(B, BR1)], []);
  assert.deepEqual([...await M.hiddenProductsAt(B, null)], [], 'no branch = nothing');
});
await ok('branchMenuRefusal: a LIVE sale of a hidden product at that branch is NOT_ON_MENU', async () => {
  const r = await M.branchMenuRefusal(B, BR2, [{ product_id: P1 }, { product_id: P2 }]);
  assert.equal(r?.code, 'NOT_ON_MENU');
  assert.deepEqual(r.items, [{ product_id: P1 }], 'only the hidden one');
});
await ok('branchMenuRefusal: a product on the menu, or a different branch, is allowed (null)', async () => {
  assert.equal(await M.branchMenuRefusal(B, BR2, [{ product_id: P2 }]), null, 'P2 is on CBD');
  assert.equal(await M.branchMenuRefusal(B, BR1, [{ product_id: P1 }]), null, 'P1 is on Westlands');
  assert.equal(await M.branchMenuRefusal(B, BR2, []), null, 'no items');
});
await ok('no rows = nothing hidden anywhere (the default)', async () => {
  mem.db.product_branches_hidden = [];
  assert.deepEqual([...await M.hiddenProductsAt(B, BR2)], []);
  assert.equal(await M.branchMenuRefusal(B, BR2, [{ product_id: P1 }]), null);
});

// ── the wiring ───────────────────────────────────────────────────────────────────────────────────────────────────
const pos = src('apps/server/src/routes/pos.ts');
await ok('pos.ts drops the products hidden at the operating branch from the pull', () => {
  assert.match(pos, /const hidden = await hiddenProductsAt\(req\.businessId, opBranchId\);/);
  assert.match(pos, /products = products\.filter\(\(p: \{ id: string \}\) => !hidden\.has\(p\.id\)\);/);
});
const orders = src('apps/server/src/routes/orders.ts');
await ok('orders.ts refuses a LIVE web sale of a product off the branch menu (beside the SOLD_OUT gate)', () => {
  assert.match(orders, /const offMenu = await branchMenuRefusal\(req\.businessId, branch_id, items\);/);
  assert.match(orders, /if \(offMenu\) \{ res\.status\(409\)\.json\(offMenu\); return; \}/);
});
const products = src('apps/server/src/routes/products.ts');
await ok('products.ts exposes GET /branch-availability and PUT /:id/branches (menu.edit)', () => {
  assert.match(products, /router\.get\('\/branch-availability', requirePermission\('menu\.edit'\)/);
  assert.match(products, /router\.put\('\/:id\/branches', requirePermission\('menu\.edit'\)/);
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
