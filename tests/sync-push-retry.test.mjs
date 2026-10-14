/**
 * sync-push-retry.test.mjs — cloud audit 2026-10-14: POST /api/sync/push parks only what a retry can never fix.
 *
 *   P1-5  floats / expenses / kitchen voids: a row goes into `rejected` (the till parks it for a person) only for a data
 *         error — Postgres class 22 / 23 — or the route's own validation. A network failure, a timeout (57014), an unknown
 *         error answers 503 SYNC_RETRY for the WHOLE push: the till sends it again (every write is an idempotent upsert).
 *   P1-6  shifts: a data error other than 23505 (23503 shifts.cashier_id for a cashier created offline …) is refused for
 *         that shift alone, with its code — it used to 500 the whole push on every pass. Day / shift / float ids go
 *         through partitionByValidId (a non-UUID id is refused alone).
 *   F12   a shift in ANY status but 'open' (a web force-close writes 'closed_unreconciled') is never reopened by a push.
 *   P2-10 the shift write is conditional: an existing row is updated only while open; a new row is inserted with
 *         ignoreDuplicates — a close racing the push is never undone.
 *   P2-17 a business_days 23505 names the index that refused it: duplicate_business_date / duplicate_open_day.
 *
 * RUNS the COMPILED sync router behind the REAL auth middleware over HTTP; the database is in memory (tests/lib-memdb.mjs).
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/sync-push-retry.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - judgeRowError rejecting every error (no isDataError check)   → "a float that failed on the network … 503" fails
 *   - the shifts arm's alreadyClosed back to status === 'closed'    → "a force-closed shift is not reopened" fails
 *   - the conditional update's .eq('status','open') removed         → "a close racing the push is not undone" fails
 *   - duplicateDayCode always duplicate_open_day                    → "duplicate_business_date" fails
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
if (!fs.existsSync(path.join(DIST, 'routes/sync.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const TOM = 'cccccccc-0000-4000-8000-000000000001';
const u = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S1 = u(1), S2 = u(2), S3 = u(3), DAY = u(10), DAY2 = u(11), F1 = u(20), F2 = u(21), E1 = u(30), K1 = u(40);
const reset = () => {
  mem.fail = () => null; mem.calls = [];
  mem.db = { users: [{ id: TOM, name: 'Tom', status: 'active', business_id: B }], user_devices: [], shifts: [], business_days: [],
    float_transactions: [], expenses: [], kitchen_voids: [] };
};
const shiftRow = (id, extra = {}) => ({ id, branch_id: BR, cashier_id: TOM, opened_at: '2026-10-14T05:00:00Z', opening_float: 100, device_id: 'dev-T1', terminal_code: 'T1', ...extra });

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/sync', require(path.join(DIST, 'routes/sync.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const push = async (body) => {
  const t = jwt.sign({ userId: TOM, businessId: B, branchId: BR, isOwner: false, permissionKeys: [], permissionsVersion: 0, sessionId: 's', surface: 'desktop', pinSignIn: true },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sync/push`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sh = (id) => mem.db.shifts.find((s) => s.id === id);

try {
  console.log('\nP1-6 — a shift refused alone\n');
  reset();
  mem.fail = (t, op, _f, p) => (t === 'shifts' && op === 'upsert' && p?.id === S2
    ? { code: '23503', message: 'insert or update on table "shifts" violates foreign key constraint "shifts_cashier_id_fkey"' } : null);
  await ok('23503 on one shift: 200, that shift rejected (table shifts, code 23503), the others land', async () => {
    const r = await push({ shifts: [shiftRow(S1), shiftRow(S2), shiftRow('not-a-uuid')] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rej = Object.fromEntries(r.body.rejected.map((x) => [x.id, x]));
    assert.equal(rej[S2]?.table, 'shifts'); assert.equal(rej[S2]?.code, '23503');
    assert.equal(rej['not-a-uuid']?.code, 'invalid_id'); assert.equal(rej['not-a-uuid']?.table, 'shifts');
    assert.ok(sh(S1)); assert.equal(sh(S1).opened_via, 'till');
  });
  reset();
  mem.fail = (t, op) => (t === 'shifts' && op === 'upsert' ? { message: 'fetch failed' } : null);
  await ok('a shift write that failed on the network: 503 SYNC_RETRY (the till sends the push again)', async () => {
    const r = await push({ shifts: [shiftRow(S1)] });
    assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'SYNC_RETRY');
  });

  console.log('\nF12 / P2-10 — never reopened\n');
  reset();
  mem.db.shifts.push({ ...shiftRow(S1), business_id: B, status: 'closed_unreconciled', closed_at: '2026-10-14T12:00:00Z' });
  await ok('a force-closed shift (closed_unreconciled) is not reopened by a stale open push', async () => {
    const r = await push({ shifts: [shiftRow(S1, { opening_float: 999 })] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sh(S1).status, 'closed_unreconciled'); assert.equal(sh(S1).opening_float, 100);
    // Left alone: not even written (the insert-if-absent of P2-10 would also protect it — this is F12 on its own).
    assert.equal(r.body.upserted.shifts, 0);
    assert.ok(!mem.calls.some((c) => c.table === 'shifts' && c.op !== 'select'), 'no write to the closed shift');
  });
  reset();
  mem.db.shifts.push({ ...shiftRow(S1), business_id: B, status: 'open' });
  // The race: between the push's read and its write, the shift is closed on the web.
  mem.fail = (t, op, _f, p) => { if (t === 'shifts' && op === 'update' && p?.opening_float === 999) sh(S1).status = 'closed'; return null; };
  await ok('a close racing the push is not undone (the update is conditional on status open)', async () => {
    const r = await push({ shifts: [shiftRow(S1, { opening_float: 999 })] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sh(S1).status, 'closed'); assert.equal(sh(S1).opening_float, 100);
  });
  reset();
  mem.db.shifts.push({ ...shiftRow(S1), business_id: B, status: 'open' });
  await ok('an open shift is still updated by its till (attribution fields), and stays open', async () => {
    const r = await push({ shifts: [shiftRow(S1, { drawer_label: 'Drawer A' })] });
    assert.equal(r.status, 200); assert.equal(sh(S1).drawer_label, 'Drawer A'); assert.equal(sh(S1).status, 'open');
  });
  reset();
  // A new row: someone inserts — and closes — the same id between the read and the write.
  mem.fail = (t, op, _f, p) => { if (t === 'shifts' && op === 'upsert' && !sh(p.id)) mem.db.shifts.push({ ...shiftRow(p.id), business_id: B, status: 'closed' }); return null; };
  await ok('a new shift is inserted with ON CONFLICT DO NOTHING — a row that appeared closed meanwhile stays closed', async () => {
    const r = await push({ shifts: [shiftRow(S3)] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(sh(S3).status, 'closed');
  });

  console.log('\nP1-5 — floats, expenses, kitchen voids\n');
  reset();
  mem.db.shifts.push({ ...shiftRow(S1), business_id: B, status: 'open' });
  mem.fail = (t, op, _f, p) => (t === 'float_transactions' && op === 'upsert' && p?.id === F2 ? { message: 'fetch failed' } : null);
  await ok('a float that failed on the network: 503 SYNC_RETRY — not parked', async () => {
    const r = await push({ floats: [{ id: F1, shift_id: S1, type: 'float_in', amount: 50 }, { id: F2, shift_id: S1, type: 'float_out', amount: 20 }] });
    assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'SYNC_RETRY');
  });
  mem.db.float_transactions = [];
  mem.fail = (t, op, _f, p) => (t === 'float_transactions' && op === 'upsert' && p?.id === F2 ? { code: '23514', message: 'violates check constraint' } : null);
  await ok('a float the database refuses on its merits (23514) is parked; a float whose shift is missing is parked', async () => {
    const r = await push({ floats: [{ id: F1, shift_id: S1, type: 'float_in', amount: 50 }, { id: F2, shift_id: S1, type: 'x', amount: 20 },
      { id: u(22), shift_id: S2, type: 'float_in', amount: 5 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const codes = Object.fromEntries(r.body.rejected.map((x) => [x.id, x.code]));
    assert.equal(codes[F2], '23514'); assert.equal(codes[u(22)], 'missing_shift'); assert.equal(r.body.upserted.floats, 1);
  });
  reset();
  mem.db.shifts.push({ ...shiftRow(S1), business_id: B, status: 'open' });
  mem.db.orders = [{ id: u(50), business_id: B }, { id: u(52), business_id: 'ffffffff-0000-4000-8000-000000000009' }];
  await ok('A484: a pay-out keeps the sale it was for when that sale is here; a sale not here yet (or of another business) is left empty, never refused', async () => {
    const r = await push({ floats: [{ id: F1, shift_id: S1, type: 'float_out', amount: 50, order_id: u(50) },
      { id: F2, shift_id: S1, type: 'float_out', amount: 20, order_id: u(51) },
      { id: u(23), shift_id: S1, type: 'float_out', amount: 10, order_id: u(52) }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rejected, []); assert.equal(r.body.upserted.floats, 3);
    const f = (id) => mem.db.float_transactions.find((x) => x.id === id);
    assert.equal(f(F1).order_id, u(50)); assert.equal(f(F2).order_id, null); assert.equal(f(u(23)).order_id, null);
  });
  reset();
  mem.fail = (t, op) => (t === 'expenses' && op === 'upsert' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null);
  await ok('an expense that timed out (57014): 503 SYNC_RETRY', async () => {
    const r = await push({ expenses: [{ id: E1, branch_id: BR, description: 'Gas', amount: 300, expense_date: '2026-10-14' }] });
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });
  mem.fail = (t, op) => (t === 'expenses' && op === 'upsert' ? { code: '23503', message: 'violates foreign key constraint "expenses_branch_id_fkey"' } : null);
  await ok('an expense refused on its data (23503) is parked with its code', async () => {
    const r = await push({ expenses: [{ id: E1, branch_id: BR, description: 'Gas', amount: 300, expense_date: '2026-10-14' }] });
    assert.equal(r.status, 200); assert.equal(r.body.rejected[0].code, '23503'); assert.equal(r.body.rejected[0].table, 'expenses');
  });
  reset();
  mem.fail = (t, op) => (t === 'kitchen_voids' && op === 'upsert' ? { message: 'upstream connect error' } : null);
  await ok('a kitchen void that failed on the network: 503; one with an unknown reason is still parked (invalid_reason)', async () => {
    const r = await push({ kitchen_voids: [{ id: K1, reason: 'wrong_item', quantity: 1, product_name: 'Chips' }] });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    mem.fail = () => null;
    const r2 = await push({ kitchen_voids: [{ id: K1, reason: 'made-up', quantity: 1 }] });
    assert.equal(r2.status, 200); assert.equal(r2.body.rejected[0].code, 'invalid_reason');
  });
  reset();
  mem.fail = (t, op) => (t === 'expenses' && op === 'select' ? { message: 'connection refused' } : null);
  await ok('a failed pre-read is a 503 too — never a 200 that marks the rows synced', async () => {
    const r = await push({ expenses: [{ id: E1, branch_id: BR, description: 'Gas', amount: 300, expense_date: '2026-10-14' }] });
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });

  console.log('\nP2-17 — which day index\n');
  reset();
  mem.fail = (t, op, _f, p) => (t === 'business_days' && op === 'upsert'
    ? (p.id === DAY ? { code: '23505', message: 'duplicate key value violates unique constraint "business_days_till_date_uniq"' }
      : { code: '23505', message: 'duplicate key value violates unique constraint "business_days_one_open_per_till"' }) : null);
  await ok('one day per till per date → duplicate_business_date; one open day per till → duplicate_open_day', async () => {
    const day = (id) => ({ id, branch_id: BR, device_id: 'dev-T1', business_date: '2026-10-14', opened_at: '2026-10-14T05:00:00Z', status: 'open' });
    const r = await push({ business_days: [day(DAY), day(DAY2)] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const codes = Object.fromEntries(r.body.rejected.map((x) => [x.id, x.code]));
    assert.equal(codes[DAY], 'duplicate_business_date'); assert.equal(codes[DAY2], 'duplicate_open_day');
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
