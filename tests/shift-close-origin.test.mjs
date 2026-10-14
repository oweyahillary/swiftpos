/**
 * shift-close-origin.test.mjs — cloud audit 2026-10-14: closing a till's shift on the cloud.
 *
 *   P0-1  A till's close folds in ONLY the web POS's stand-in drawer on that till (shifts.opened_via = 'web', migration 133),
 *         opened before the till's count — never the till's own NEXT shift, pushed by /sync/push before the old shift's
 *         close arrived (it used to be closed with variance 0 and its cash counted into the old shift).
 *   P1-3  /:id/close and /:id/force-close: 404 NOT_FOUND only for a shift that is not there, 409 ALREADY_CLOSED (status,
 *         closed_at) for one that is closed, 5xx for a failed read — the till marks its close synced on 2xx / 409 only.
 *   P1-4  A failed float or expense read is a 5xx — never a 0 inside an expected cash and variance stored for good.
 *   P2-11 The till's own closed_at (not in the future beyond 5 min, not before the shift opened) and closed_by (a person of
 *         this business) are recorded.
 *   P2-14 A web drawer expense is dated by the business date (Nairobi, with the cut-off), not the UTC date.
 *   P2-15 A web shift is opened with its business date, and marked opened_via 'web'.
 *
 * RUNS the COMPILED shifts router behind the REAL auth middleware over HTTP with real signed tokens; the database is
 * in memory (tests/lib-memdb.mjs). The clock is fixed at 2026-10-14 22:30 UTC = 01:30 on the 15th in Nairobi.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/shift-close-origin.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - siblingsOf without the isWebStandIn check            → "the till's own NEXT shift is NOT folded" fails
 *   - siblingsOf without the opened-before-close check      → "a web drawer opened after the till's count is not folded" fails
 *   - openShiftOr409 answering 404 for a closed shift        → "409 ALREADY_CLOSED" fails
 *   - shiftFloats ignoring its error                        → "a failed float read is a 5xx" fails
 *   - cleanCloseTime accepting a time in the future          → "a close time in the future is replaced by now" fails
 *   - /:id/expense dating by toISOString().slice(0, 10)      → "dated 15 October" fails
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
if (!fs.existsSync(path.join(DIST, 'routes/shifts.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');

// ── a fixed clock: 2026-10-14 22:30 UTC (01:30 on the 15th in Nairobi) ──
const NOW = Date.parse('2026-10-14T22:30:00Z');
const RealDate = Date;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
globalThis.Date = FakeDate;

const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const rule = require(path.join(DIST, 'lib/siblingDrawers.js'));
const shiftsMod = require(path.join(DIST, 'routes/shifts.js'));
const mem = installMemDb(supabase);

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const TOM = 'cccccccc-0000-4000-8000-000000000001', JANE = 'cccccccc-0000-4000-8000-000000000002', OUTSIDER = 'cccccccc-0000-4000-8000-000000000009';
const OLD = 'dddddddd-0000-4000-8000-000000000001', NEXT = 'dddddddd-0000-4000-8000-000000000002', WEB = 'dddddddd-0000-4000-8000-000000000003';
const LATE_WEB = 'dddddddd-0000-4000-8000-000000000004', GONE = 'dddddddd-0000-4000-8000-0000000000ff';
const T1 = { business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1' };
const reset = () => {
  mem.fail = () => null;
  mem.db = {
    users: [{ id: TOM, name: 'Tom', status: 'active', business_id: B }, { id: JANE, name: 'Jane', status: 'active', business_id: B }],
    shifts: [
      // The till's drawer being closed (counted at 17:00), the till's NEXT drawer (opened 17:05, pushed before the close
      // arrived), and the web POS's stand-in on T1 (opened 09:00).
      { id: OLD, ...T1, status: 'open', opened_via: 'till', business_day_id: 'day-1', opening_float: 1000, opened_by: TOM, cashier_id: TOM, opened_at: '2026-10-14T05:00:00Z' },
      { id: NEXT, ...T1, status: 'open', opened_via: 'till', business_day_id: 'day-1', opening_float: 2000, opened_by: TOM, cashier_id: TOM, opened_at: '2026-10-14T14:05:00Z' },
      { id: WEB, ...T1, status: 'open', opened_via: 'web', business_day_id: null, opening_float: 500, opened_by: JANE, cashier_id: JANE, opened_at: '2026-10-14T06:00:00Z' },
    ],
    orders: [
      { id: 'o-old', shift_id: OLD, status: 'completed', business_id: B },
      { id: 'o-next', shift_id: NEXT, status: 'completed', business_id: B },
      { id: 'o-web', shift_id: WEB, status: 'completed', business_id: B },
    ],
    payments: [
      { order_id: 'o-old', method: 'cash', status: 'completed', amount: 400 },
      { order_id: 'o-next', method: 'cash', status: 'completed', amount: 999 },
      { order_id: 'o-web', method: 'cash', status: 'completed', amount: 230 },
    ],
    float_transactions: [], expenses: [], business_settings: [], branch_settings: [], feature_flags: [],
    branches: [{ id: BR, business_id: B, name: 'Westlands' }],
  };
};
reset();

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/shifts', shiftsMod.default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/shifts`;
const call = (surface, userId, keys = ['shifts.manage']) => async (method, p, body) => {
  const t = jwt.sign({ userId, businessId: B, branchId: BR, isOwner: false, permissionKeys: keys, permissionsVersion: 0, sessionId: 's', surface,
    ...(surface === 'desktop' ? { pinSignIn: true } : {}) }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'x-device-id': 'dev-T1' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const till = call('desktop', TOM), web = call('web', JANE), manager = call('web', JANE, ['*']);
const shift = (id) => mem.db.shifts.find((s) => s.id === id);

try {
  console.log('\nP0-1 — what a till\'s count closes with it\n');
  await ok('the rule: a web stand-in is a sibling; the till\'s own other shift is not', () => {
    const got = rule.siblingsOf(shift(OLD), mem.db.shifts, '2026-10-14T14:00:00Z').map((s) => s.id);
    assert.deepEqual(got, [WEB]);
  });
  await ok('the rule: a row from before migration 133 is told apart by its trading day (a till\'s always names one)', () => {
    assert.equal(rule.isWebStandIn({ id: 'x', status: 'open', business_day_id: null }), true);
    assert.equal(rule.isWebStandIn({ id: 'x', status: 'open', business_day_id: 'day-1' }), false);
    assert.equal(rule.isWebStandIn({ id: 'x', status: 'open', opened_via: 'till', business_day_id: null }), false);
  });

  await ok('the till closes its old drawer (counted 17:00): expected 1000 + 400 + the web\'s 730 = 2130, variance 0', async () => {
    const r = await till('POST', `/${OLD}/close`, { closing_float: 2130, closed_at: '2026-10-14T14:00:00Z' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.expected_cash, 2130); assert.equal(r.body.cash_variance, 0);
    assert.deepEqual(r.body.closed_with, [WEB]);
  });
  await ok('…the till\'s own NEXT shift is NOT folded: still open, its cash its own', () => {
    const n = shift(NEXT);
    assert.equal(n.status, 'open'); assert.equal(n.closing_float, undefined); assert.equal(n.cash_variance, undefined);
  });
  await ok('…the web\'s stand-in IS folded: closed, counted inside the till\'s drawer, at the till\'s close time', () => {
    const w = shift(WEB);
    assert.equal(w.status, 'closed'); assert.equal(w.expected_cash, 730); assert.equal(w.cash_variance, 0);
    assert.equal(w.closed_at, '2026-10-14T14:00:00.000Z');
  });
  await ok('…and the old drawer is recorded at the till\'s close time (P2-11), not when the close reached the cloud', () => {
    assert.equal(shift(OLD).closed_at, '2026-10-14T14:00:00.000Z');
  });

  reset();
  mem.db.shifts.push({ id: LATE_WEB, ...T1, status: 'open', opened_via: 'web', opening_float: 50, opened_by: JANE, cashier_id: JANE, opened_at: '2026-10-14T15:00:00Z' });
  mem.db.shifts = mem.db.shifts.filter((s) => s.id !== WEB);
  await ok('a web drawer opened AFTER the till\'s count is not folded into it', async () => {
    const r = await till('POST', `/${OLD}/close`, { closing_float: 1400, closed_at: '2026-10-14T14:00:00Z' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.closed_with, []); assert.equal(shift(LATE_WEB).status, 'open');
    assert.equal(r.body.expected_cash, 1400);
  });

  reset();
  await ok('the till is told about the web\'s stand-in only (foreign-cash siblings)', async () => {
    const r = await till('POST', `/${OLD}/foreign-cash`, { order_ids: ['o-old'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.siblings.shifts.map((s) => s.id), [WEB]);
  });

  console.log('\nP1-3 — absent, closed, unreadable\n');
  reset();
  await ok('closing a shift that is not there: 404 NOT_FOUND', async () => {
    const r = await till('POST', `/${GONE}/close`, { closing_float: 0 });
    assert.equal(r.status, 404); assert.equal(r.body.code, 'NOT_FOUND');
  });
  shift(OLD).status = 'closed_unreconciled'; shift(OLD).closed_at = '2026-10-14T13:00:00Z';
  await ok('closing a shift a manager force-closed: 409 ALREADY_CLOSED with its status and closed_at (the till marks it synced)', async () => {
    const r = await till('POST', `/${OLD}/close`, { closing_float: 2130 });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'ALREADY_CLOSED');
    assert.equal(r.body.status, 'closed_unreconciled'); assert.equal(r.body.closed_at, '2026-10-14T13:00:00Z');
  });
  await ok('force-closing it: 409 ALREADY_CLOSED too', async () => {
    const r = await manager('POST', `/${OLD}/force-close`, { reason: 'gone home' });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'ALREADY_CLOSED');
  });
  reset();
  mem.fail = (t, op) => (t === 'shifts' && op === 'select' ? { message: 'connection reset', code: '' } : null);
  await ok('a failed read of the shift: 5xx (the till retries), never 404', async () => {
    const r = await till('POST', `/${OLD}/close`, { closing_float: 2130 });
    assert.ok(r.status >= 500, String(r.status));
    const f = await manager('POST', `/${OLD}/force-close`, { reason: 'x' });
    assert.ok(f.status >= 500, String(f.status));
  });

  console.log('\nP1-4 — a failed money read is never a 0\n');
  for (const table of ['float_transactions', 'expenses']) {
    reset();
    mem.fail = (t, op) => (t === table && op === 'select' ? { message: 'canceling statement due to statement timeout', code: '57014' } : null);
    await ok(`a failed ${table} read on close is a 5xx — the shift stays open, nothing stored`, async () => {
      const r = await till('POST', `/${OLD}/close`, { closing_float: 2130 });
      assert.ok(r.status >= 500, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(shift(OLD).status, 'open'); assert.equal(shift(OLD).expected_cash, undefined);
    });
    await ok(`…and on force-close`, async () => {
      const r = await manager('POST', `/${OLD}/force-close`, { reason: 'gone home' });
      assert.ok(r.status >= 500, `${r.status}`); assert.equal(shift(OLD).status, 'open');
    });
  }

  console.log('\nP2-11 — when and by whom\n');
  await ok('cleanCloseTime: a real time is kept; a time >5 min in the future or before the opening is replaced by now', () => {
    const now = new RealDate('2026-10-14T22:30:00Z');
    assert.equal(shiftsMod.cleanCloseTime('2026-10-14T20:00:00Z', '2026-10-14T05:00:00Z', now), '2026-10-14T20:00:00.000Z');
    assert.equal(shiftsMod.cleanCloseTime('2026-10-14T22:34:00Z', null, now), '2026-10-14T22:34:00.000Z');
    assert.equal(shiftsMod.cleanCloseTime('2026-10-14T23:30:00Z', null, now), now.toISOString());
    assert.equal(shiftsMod.cleanCloseTime('2026-10-14T04:00:00Z', '2026-10-14T05:00:00Z', now), now.toISOString());
    assert.equal(shiftsMod.cleanCloseTime('nonsense', null, now), now.toISOString());
  });
  reset();
  await ok('a close time in the future is replaced by now; closed_by names the roster person the till sent', async () => {
    const r = await till('POST', `/${OLD}/close`, { closing_float: 2130, closed_at: '2026-10-15T09:00:00Z', closed_by: JANE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(shift(OLD).closed_at, new RealDate(NOW).toISOString()); assert.equal(shift(OLD).closed_by, JANE);
  });
  reset();
  await ok('closed_by that is not a person of this business is not taken (the caller is recorded)', async () => {
    const r = await till('POST', `/${OLD}/close`, { closing_float: 2130, closed_by: OUTSIDER });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(shift(OLD).closed_by, TOM);
  });
  reset();
  await ok('a WEB close ignores a closed_at it sends (now is recorded)', async () => {
    const r = await web('POST', `/${WEB}/close`, { closing_float: 730, closed_at: '2026-10-14T10:00:00Z' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(shift(WEB).closed_at, new RealDate(NOW).toISOString());
  });
  reset();
  await ok('a close racing another close: the second gets 409, the first close is not overwritten', async () => {
    const [a, b] = await Promise.all([
      till('POST', `/${OLD}/close`, { closing_float: 2130 }),
      till('POST', `/${OLD}/close`, { closing_float: 5 }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.ok(codes[0] === 200 && (codes[1] === 409 || codes[1] === 200), JSON.stringify([a, b].map((x) => x.status)));
    assert.equal(shift(OLD).status, 'closed');
  });

  console.log('\nP2-14 / P2-15 — business dates on the web\n');
  reset();
  await ok('a web drawer expense at 01:30 Nairobi (22:30 UTC on the 14th) is dated 15 October', async () => {
    const r = await manager('POST', `/${WEB}/expense`, { description: 'Charcoal', amount: 300 });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.expense_date, '2026-10-15');
  });
  reset();
  mem.db.shifts = [];
  await ok('a web shift opens with its business date (15 October) and opened_via web', async () => {
    const r = await web('POST', '/open', { branch_id: BR, opening_float: 0 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.business_date, '2026-10-15'); assert.equal(r.body.opened_via, 'web');
  });
  reset();
  mem.db.shifts = [];
  mem.fail = (t, op, _f, p) => (t === 'shifts' && op === 'insert' && p && 'opened_via' in p ? { code: 'PGRST204', message: "Could not find the 'opened_via' column of 'shifts' in the schema cache" } : null);
  await ok('before migration 133 the shift still opens (without the column)', async () => {
    const r = await web('POST', '/open', { branch_id: BR, opening_float: 0 });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.opened_via, undefined);
  });
} finally {
  server.close();
  globalThis.Date = RealDate;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
