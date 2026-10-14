/**
 * change-apply-retry.test.mjs — cloud audit 2026-10-14 (P1-8b): a change made on a till (A448) is `refused` only for a
 * DECISION; a failure that says nothing about the change answers `refused` + `retry: true`.
 *
 * On a plain `refused` the till undoes a create (localChanges.undoRefusedCreate): a product, a cashier or a station made on
 * the till was deleted there because the cloud's database had a hiccup. Now: a failed read or write (no code, a timeout, the
 * gateway) and anything unexpected → retry (not recorded, sent again); a value the database refuses on its merits (class 22
 * / 23, e.g. 23505 'already exists'), who may not, a PIN someone else has → refused as before (recorded).
 *
 * RUNS the COMPILED lib/changeApply.js against an in-memory database (tests/lib-memdb.mjs).
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/change-apply-retry.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - the final catch back to a plain refused                     → "an unexpected throw … retry" fails
 *   - writeRefusal treating every error as a refusal                → "a create whose insert failed on the network … retry" fails
 *   - the current-row read's error ignored (readOk removed)         → "a failed read is never 'it no longer exists'" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/changeApply.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const { applyChange } = require(path.join(DIST, 'lib/changeApply.js'));

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const OWNER = '44444444-4444-4444-8444-444444444444', CASHIER = 'cccccccc-0000-4000-8000-000000000001';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const reset = () => {
  mem.fail = () => null;
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER }],
    users: [{ id: OWNER, business_id: B, name: 'Owner', status: 'active' }, { id: CASHIER, business_id: B, name: 'Cashier', status: 'active', roles: { role_permissions: [] }, user_permissions: [] }],
    products: [{ id: P1, business_id: B, name: 'Chips', base_price: 200, category_id: null, status: 'active' }],
    categories: [], change_requests: [], notifications: [],
  };
};
const ctx = { businessId: B, branchId: BR, deviceId: 'dev-T1', callerIsOwner: true, callerUserId: OWNER, callerKeys: ['*'] };
const change = (over) => ({ id: randomUUID(), entity: 'product', op: 'create', entity_id: randomUUID(), base: null,
  data: { name: 'Mandazi', base_price: 20 }, made_by: OWNER, made_by_name: 'Owner', made_at: '2026-10-14T09:00:00Z', ...over });
const recorded = (c) => mem.db.change_requests.some((r) => r.id === c.id);

reset();
await ok('a create whose insert failed on the network: refused + retry (the till keeps its product), not recorded', async () => {
  mem.fail = (t, op) => (t === 'products' && op === 'insert' ? { message: 'fetch failed' } : null);
  const c = change();
  const r = await applyChange(ctx, c);
  assert.equal(r.status, 'refused'); assert.equal(r.retry, true, JSON.stringify(r)); assert.equal(recorded(c), false);
});
reset();
await ok('a create the database refuses on its data (23505): refused, no retry — a decision (answered as before)', async () => {
  mem.fail = (t, op) => (t === 'products' && op === 'insert' ? { code: '23505', message: 'duplicate key value violates unique constraint "products_barcode_key"' } : null);
  const c = change();
  const r = await applyChange(ctx, c);
  assert.equal(r.status, 'refused'); assert.ok(!r.retry, JSON.stringify(r)); assert.equal(r.message, 'already exists');
});
reset();
await ok('a failed read is never "it no longer exists": an update whose current-row read failed → retry', async () => {
  mem.fail = (t, op) => (t === 'products' && op === 'select' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null);
  const c = change({ op: 'update', entity_id: P1, base: { name: 'Chips' }, data: { name: 'Chips (L)' } });
  const r = await applyChange(ctx, c);
  assert.equal(r.status, 'refused'); assert.equal(r.retry, true, JSON.stringify(r)); assert.equal(recorded(c), false);
});
reset();
await ok('an update write that timed out → retry; the product unchanged', async () => {
  mem.fail = (t, op) => (t === 'products' && op === 'update' ? { code: '57014', message: 'timeout' } : null);
  const c = change({ op: 'update', entity_id: P1, base: { name: 'Chips' }, data: { name: 'Chips (L)' } });
  const r = await applyChange(ctx, c);
  assert.equal(r.retry, true, JSON.stringify(r)); assert.equal(mem.db.products[0].name, 'Chips');
});
reset();
await ok('a delete whose write failed on the network → retry', async () => {
  mem.fail = (t, op) => (t === 'products' && op === 'update' ? { message: 'upstream connect error' } : null);
  const c = change({ op: 'delete', entity_id: P1, base: {}, data: {} });
  const r = await applyChange(ctx, c);
  assert.equal(r.retry, true, JSON.stringify(r));
});
reset();
await ok('the replay check failing → retry (never applied twice, never refused for it)', async () => {
  mem.fail = (t, op) => (t === 'change_requests' && op === 'select' ? { message: 'fetch failed' } : null);
  const r = await applyChange(ctx, change());
  assert.equal(r.retry, true, JSON.stringify(r)); assert.equal(mem.db.products.length, 1);
});
reset();
await ok('the maker\'s permission read failing (sent by the till\'s own session) → retry, not "may not make this change"', async () => {
  mem.fail = (t, op) => (t === 'users' && op === 'select' ? { message: 'fetch failed' } : null);
  const r = await applyChange({ ...ctx, callerIsOwner: false, callerKeys: [], callerUserId: null }, change({ made_by: CASHIER }));
  assert.equal(r.retry, true, JSON.stringify(r));
});
reset();
await ok('an unexpected throw → retry', async () => {
  const realFrom = supabase.from;
  let n = 0;
  supabase.from = (t) => { if (t === 'products' && ++n === 2) throw new Error('socket hang up'); return realFrom(t); };
  try {
    const r = await applyChange(ctx, change());
    assert.equal(r.retry, true, JSON.stringify(r));
  } finally { supabase.from = realFrom; }
});
reset();
await ok('a DECISION stays a plain refusal: a cashier without products.manage may not (recorded, no retry)', async () => {
  const c = change({ made_by: CASHIER, made_by_name: 'Cashier' });
  const r = await applyChange({ ...ctx, callerIsOwner: false, callerKeys: [], callerUserId: null }, c);
  assert.equal(r.status, 'refused'); assert.ok(!r.retry, JSON.stringify(r)); assert.equal(recorded(c), true);
});
reset();
await ok('and a create that works is applied, as before', async () => {
  const c = change();
  const r = await applyChange(ctx, c);
  assert.equal(r.status, 'applied', JSON.stringify(r)); assert.ok(mem.db.products.some((p) => p.id === c.entity_id));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
