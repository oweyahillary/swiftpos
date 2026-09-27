/**
 * sibling-drawers.test.mjs — A342 (2026-09-27): closing a shift ON THE TILL also closes the web POS's own shift on that till,
 * and the till's one count covers both.
 *
 * Owner: "if a shift is closed on the till it should also close the web" — asked how the web shift's cash is counted:
 * "Till's count covers both".
 *
 *   node tests/sibling-drawers.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the real cloud: the COMPILED shifts router behind the REAL auth middleware, on a real Express server, over HTTP
 * with real signed tokens — the database replaced by an in-memory stand-in behind supabase.from() (as in
 * staff-role-ceiling.test.mjs). The till's side (its expected cash including the web shift) runs in
 * apps/desktop/test/shared-drawer.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - /close stops closing siblings                        → "the web's shift on T1 is closed too" fails
 *   - siblings closed on a WEB close as well               → "a web close never closes the till's" fails
 *   - siblingsOf matches any open shift (not same till)    → "another till's shift is untouched" fails
 *   - foreign-cash stops reporting siblings                → "the till is told …" fails
 *   - foreign-cash / foreign-orders out of the till write allowlist → "the REAL till write guard …" fails
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
process.env.JWT_SECRET = randomBytes(24).toString('hex');          // made up per run — never a literal
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');

const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const rule = require(path.join(DIST, 'lib/siblingDrawers.js'));

// ── The database, in memory ──
const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const JANE = 'cccccccc-0000-4000-8000-000000000001', TOM = 'cccccccc-0000-4000-8000-000000000002';
const TILL_SHIFT = 'dddddddd-0000-4000-8000-000000000001', WEB_SHIFT = 'dddddddd-0000-4000-8000-000000000002';
const T2_SHIFT = 'dddddddd-0000-4000-8000-000000000003', WEBTILL_SHIFT = 'dddddddd-0000-4000-8000-000000000004';
let db;
const reset = () => {
  db = {
    users: [{ id: JANE, name: 'Jane', status: 'active', business_id: B }, { id: TOM, name: 'Tom', status: 'active', business_id: B }],
    shifts: [
      // T1's own drawer (the till) and the web's own drawer standing in as T1 (A273) — two drawers, one till (migration 107).
      { id: TILL_SHIFT, business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', status: 'open', opening_float: 1000, opened_by: TOM, cashier_id: TOM, opened_at: '2026-09-27T08:00:00Z' },
      { id: WEB_SHIFT, business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', status: 'open', opening_float: 500, opened_by: JANE, cashier_id: JANE, opened_at: '2026-09-27T09:00:00Z' },
      // Another till, and the branch web till — never touched by T1's close.
      { id: T2_SHIFT, business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: 'T2', status: 'open', opening_float: 300, opened_by: JANE, cashier_id: JANE, opened_at: '2026-09-27T09:00:00Z' },
      { id: WEBTILL_SHIFT, business_id: B, branch_id: BR, device_id: null, terminal_code: null, status: 'open', opening_float: 0, opened_by: JANE, cashier_id: JANE, opened_at: '2026-09-27T09:00:00Z' },
    ],
    orders: [
      { id: 'o-till', shift_id: TILL_SHIFT, status: 'completed', business_id: B },
      { id: 'o-web', shift_id: WEB_SHIFT, status: 'completed', business_id: B },
    ],
    payments: [
      { order_id: 'o-till', method: 'cash', status: 'completed', amount: 400 },
      { order_id: 'o-web', method: 'cash', status: 'completed', amount: 230 },
    ],
    float_transactions: [], expenses: [],
  };
};
reset();
supabase.from = (table) => {
  const st = { filters: [], op: 'select', payload: null };
  const rows = () => (db[table] ?? []).filter((r) => st.filters.every(([k, fn]) => fn(r[k])));
  const run = () => {
    if (st.op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, st.payload)); return hit.map((r) => ({ ...r })); }
    return rows();
  };
  const q = {
    select() { return q; }, order() { return q; }, not() { return q; }, is() { return q; }, limit() { return q; }, range() { return q; },
    eq(k, v) { st.filters.push([k, (x) => x === v]); return q; },
    in(k, arr) { st.filters.push([k, (x) => arr.includes(x)]); return q; },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }); },
    single() { const r = run(); return Promise.resolve(r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } }); },
    then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
  };
  return q;
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/shifts', require(path.join(DIST, 'routes/shifts.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/shifts`;
// A till's staff token is surface 'desktop'; the web POS's is 'web' (routes/auth.ts). Both are T1 by x-device-id.
const call = (surface, userId) => async (method, p, body) => {
  const t = jwt.sign({ userId, businessId: B, branchId: BR, isOwner: false, permissionKeys: ['shifts.manage'], permissionsVersion: 0, sessionId: 's', surface }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'x-device-id': 'dev-T1' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const till = call('desktop', TOM), web = call('web', JANE);
const shift = (id) => db.shifts.find((s) => s.id === id);

try {
  await ok('the REAL till write guard lets the till\'s read-only foreign-cash / foreign-orders through (enforce-ready)', () => {
    const { terminalWriteDenied } = require(path.join(DIST, 'middleware/auth.js'));
    for (const p of [`/api/shifts/${TILL_SHIFT}/foreign-cash`, `/api/shifts/${TILL_SHIFT}/foreign-orders`, `/api/shifts/${TILL_SHIFT}/close`])
      assert.equal(terminalWriteDenied('desktop', 'POST', p), false, p);
    assert.equal(terminalWriteDenied('desktop', 'POST', '/api/shifts'), true, 'opening a shift by hand from a till token stays denied');
  });
  await ok('the rule: siblings are the OTHER open shifts on the same till only', () => {
    const got = rule.siblingsOf(shift(TILL_SHIFT), db.shifts).map((s) => s.id);
    assert.deepEqual(got, [WEB_SHIFT]);
  });

  await ok('the till is told about the web\'s shift on T1 (foreign-cash reports it: Jane, expected 500 + 230 = 730)', async () => {
    const r = await till('POST', `/${TILL_SHIFT}/foreign-cash`, { order_ids: ['o-till'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.siblings.count, 1); assert.equal(r.body.siblings.expected, 730);
    assert.equal(r.body.siblings.shifts[0].opened_by_name, 'Jane');
  });

  await ok('a WEB close never closes the till\'s shift', async () => {
    const r = await web('POST', `/${WEB_SHIFT}/close`, { closing_float: 730 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(shift(TILL_SHIFT).status, 'open');
    assert.deepEqual(r.body.closed_with, []);
  });

  reset();
  await ok('the TILL\'s close counts both drawers: expected 1000 + 400 + 730 = 2130, count 2130 → variance 0', async () => {
    const r = await till('POST', `/${TILL_SHIFT}/close`, { closing_float: 2130 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.expected_cash, 2130); assert.equal(r.body.cash_variance, 0);
  });
  await ok('…and the web\'s shift on T1 is closed too: counted inside the till\'s drawer, no variance of its own, a note saying so', () => {
    const w = shift(WEB_SHIFT);
    assert.equal(w.status, 'closed'); assert.equal(w.close_method, 'counted');
    assert.equal(w.closing_float, 730); assert.equal(w.expected_cash, 730); assert.equal(w.cash_variance, 0);
    assert.match(w.notes, /^Closed with T1's count \(shift dddddddd\)/);
  });
  await ok('another till\'s shift and the branch web till are untouched', () => {
    assert.equal(shift(T2_SHIFT).status, 'open'); assert.equal(shift(WEBTILL_SHIFT).status, 'open');
  });

  reset();
  await ok('a till close whose figures moved (web sold after the count) is recorded with a note, never refused (no retry loop)', async () => {
    const r = await till('POST', `/${TILL_SHIFT}/close`, { closing_float: 1400 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cash_variance, 1400 - 2130);
    assert.match(r.body.notes, /Variance recorded when the till's close reached the cloud/);
  });
  reset();
  await ok('…while a WEB close with a variance and no note is still refused (400)', async () => {
    const r = await web('POST', `/${WEB_SHIFT}/close`, { closing_float: 1 });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
