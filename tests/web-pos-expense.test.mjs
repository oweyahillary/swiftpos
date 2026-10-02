/**
 * web-pos-expense.test.mjs — A362 (2026-09-28): a cashier records an expense on the web POS; A360/A361 at run time.
 *
 * Owner: "web pos cannot record expences on cashier". The web POS had no expense screen at all, and the only cloud route
 * (POST /api/expenses) needs expenses.manage. The till lets any signed-in cashier record one into their shift.
 *
 *   node tests/web-pos-expense.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED shifts and expenses routers behind the real auth middleware over HTTP (database in memory; JWTs signed
 * with a per-run random secret) as a CASHIER holding only the cashier default keys.
 *
 * MUTATIONS TO CONFIRM BITE: a permission on POST /:id/expense → "a cashier records" fails; the open-shift filter dropped →
 * "a closed shift refuses" fails; paid_by/recorded_by from the body → "under the signed-in cashier" fails; the category
 * business check dropped → "another business's type" fails; a key back on GET /categories → "a cashier reads the types" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/shifts.js'))) {
  console.log('\nCannot load apps/server/dist/routes/shifts.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const CASHIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPEN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', CLOSED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GAS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', FOREIGN_TYPE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const db = {
  businesses: [{ id: BZ, name: 'B Foods', status: 'active' }],
  users: [{ id: CASHIER, business_id: BZ, name: 'Jane', status: 'active' }],
  shifts: [
    { id: OPEN, business_id: BZ, branch_id: BR, status: 'open' },
    { id: CLOSED, business_id: BZ, branch_id: BR, status: 'closed' },
  ],
  expense_categories: [
    { id: GAS, business_id: BZ, name: 'Gas' },
    { id: FOREIGN_TYPE, business_id: OTHER, name: 'Not yours' },
  ],
  expenses: [],
};
supabase.from = (table) => {
  const f = []; let inserted = null;
  const rows = () => inserted ? [inserted] : (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'insert') return (row) => { inserted = { id: `exp-${(db[table] ??= []).length + 1}`, ...row }; db[table].push(inserted); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = rows(); return Promise.resolve(r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/shifts', require(path.join(DIST, 'routes/shifts.js')).default);
app.use('/api/expenses', require(path.join(DIST, 'routes/expenses.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const token = jwt.sign({ userId: CASHIER, businessId: BZ, branchId: BR, isOwner: false,
  permissionKeys: ['orders.create', 'products.view', 'inventory.view', 'customers.view', 'customers.manage', 'invoice.create'],
  permissionsVersion: 0, sessionId: 's', surface: 'web' }, process.env.JWT_SECRET);
const call = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  await ok('A360: a cashier reads the expense types (this business only)', async () => {
    const r = await call('GET', '/api/expenses/categories');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map((c) => c.name), ['Gas']);
  });
  await ok('A360: a cashier still cannot ADD a type', async () => {
    const r = await call('POST', '/api/expenses/categories', { name: 'Sneaky' });
    assert.equal(r.status, 403);
  });
  await ok('A362: a cashier records an expense into their open shift, under the signed-in cashier (A361)', async () => {
    const r = await call('POST', `/api/shifts/${OPEN}/expense`,
      { description: '  Gas refill ', amount: 500, expense_category_id: GAS, paid_by: 'someone-else', recorded_by: 'someone-else' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const e = db.expenses.at(-1);
    assert.equal(e.shift_id, OPEN); assert.equal(e.branch_id, BR); assert.equal(e.business_id, BZ);
    assert.equal(e.description, 'Gas refill'); assert.equal(e.amount, 500); assert.equal(e.expense_category_id, GAS);
    assert.equal(e.paid_by, CASHIER); assert.equal(e.recorded_by, CASHIER);
    assert.match(e.expense_date, /^\d{4}-\d{2}-\d{2}$/);
  });
  await ok('A362: an expense with no type goes through untyped', async () => {
    const r = await call('POST', `/api/shifts/${OPEN}/expense`, { description: 'Water', amount: 50 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(db.expenses.at(-1).expense_category_id, null);
  });
  await ok('A362: a closed shift, or no description / amount, is refused with a plain message', async () => {
    const n = db.expenses.length;
    assert.equal((await call('POST', `/api/shifts/${CLOSED}/expense`, { description: 'x', amount: 5 })).status, 404);
    const noDesc = await call('POST', `/api/shifts/${OPEN}/expense`, { description: '  ', amount: 5 });
    assert.equal(noDesc.status, 400); assert.match(noDesc.body.error, /what the money was for/);
    for (const amount of [0, -3, 'abc']) assert.equal((await call('POST', `/api/shifts/${OPEN}/expense`, { description: 'x', amount })).status, 400);
    assert.equal(db.expenses.length, n, 'nothing written');
  });
  await ok('A362: another business\'s expense type is refused', async () => {
    const r = await call('POST', `/api/shifts/${OPEN}/expense`, { description: 'x', amount: 5, expense_category_id: FOREIGN_TYPE });
    assert.equal(r.status, 400); assert.match(r.body.error, /no longer exists/);
  });
  await ok('the back-office POST /api/expenses stays expenses.manage', async () => {
    const r = await call('POST', '/api/expenses', { branch_id: BR, category: 'Gas', description: 'x', amount: 5, date: '2026-09-28' });
    assert.equal(r.status, 403);
  });

  // The web POS screen (React is not run here)
  const modal = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/ShiftModal.tsx'), 'utf8');
  const screen = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/CashierScreen.tsx'), 'utf8');
  await ok('A362: the web POS has "🧾 Expense" beside Float, for anyone on the shift, posting to this route', async () => {
    assert.match(screen, /onClick=\{\(\) => setShiftModal\('expense'\)\}/);
    assert.match(modal, /export type ShiftModalMode = [^;]*'expense'/);
    assert.match(modal, /await posApi\.post\(`\/api\/shifts\/\$\{shiftId\}\/expense`, \{\s+description,\s+amount,\s+expense_category_id: expTypeId \|\| undefined,/);
    assert.match(modal, /posApi\.get<\{ id: string; name: string \}\[\]>\('\/api\/expenses\/categories'\)/);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
