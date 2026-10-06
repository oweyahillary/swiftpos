/**
 * day-order.test.mjs — A363 (2026-09-29): the cloud writes a till's CLOSING trading day before its new one.
 *
 * T1, 2026-09-29: closed yesterday and opened today while offline; both days arrived in one /api/sync/push. They were
 * written concurrently, so today's open day could land before yesterday's close and hit business_days_one_open_per_till
 * (one open day per till) — refused duplicate_open_day, its shift refused missing_business_day, both parked on the till.
 *
 *   node tests/day-order.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED lib/dayOrder.js and POST /api/sync/push behind the real auth middleware over HTTP, against an
 * in-memory database that enforces the one-open-day-per-till index AT WRITE TIME (the moment Postgres would).
 * The till's side (re-send once, log, status, Z-report): apps/desktop/test/day-clash-sync.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: sync.ts back to one Promise.all over the rows → "today's day sent FIRST still lands" fails;
 * closesFirst returning the rows unsorted → its unit check and the route check fail.
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

if (!fs.existsSync(path.join(DIST, 'routes/sync.js'))) {
  console.log('\nCannot load apps/server/dist/routes/sync.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { closesFirst } = require(path.join(DIST, 'lib/dayOrder.js'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const DEV = 'ed377ee4-bbe6-46c1-8fd7-e851d9edadb9';
const DAY_Y = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DAY_T = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHIFT_T = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let db;
const reset = () => {
  db = {
    business_days: [{ id: DAY_Y, business_id: BZ, branch_id: BR, device_id: DEV, status: 'open' }],   // yesterday, still open on the cloud
    shifts: [],
    user_devices: [{ business_id: BZ, device_id: DEV, status: 'approved', retired_at: null }],   // A415: the till is on the business
  };
};
// In-memory stand-in. upsert enforces business_days_one_open_per_till the moment the row is written.
supabase.from = (table) => {
  const f = []; let upsertRow = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const write = () => {
    const r = upsertRow;
    if (table === 'business_days' && r.status === 'open'
      && db.business_days.some((x) => x.id !== r.id && x.status === 'open' && x.branch_id === r.branch_id && (x.device_id ?? '') === (r.device_id ?? ''))) {
      return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "business_days_one_open_per_till"' } };
    }
    const list = (db[table] ??= []);
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) list[i] = { ...list[i], ...r }; else list.push({ ...r });
    return { data: null, error: null };
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'upsert') return (row) => { upsertRow = row; return q; };
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
      if (prop === 'single') return () => Promise.resolve(rows()[0] ? { data: rows()[0], error: null } : { data: null, error: { message: 'none' } });
      if (prop === 'then') return (res, rej) => Promise.resolve(upsertRow ? write() : { data: rows(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json({ limit: '5mb' }));
app.use('/api/sync', require(path.join(DIST, 'routes/sync.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
// A415: the till's own session — the till, the business, the branch; no person.
const token = jwt.sign({ userId: null, deviceId: DEV, till: true, businessId: BZ, branchId: BR, isOwner: false, permissionKeys: ['*'],
  permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET);
const push = async (body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sync/push`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-device-id': DEV, 'X-Schema-Version': '999' },
    body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const day = (id, status, date) => ({ id, branch_id: BR, device_id: DEV, terminal_code: 'T1', business_date: date, opened_at: `${date}T06:55:00Z`,
  status, closed_at: status === 'closed' ? '2026-09-29T06:55:10Z' : null });

try {
  await ok('closesFirst: every closing day, then the rest (empty groups dropped)', () => {
    const g = closesFirst([{ id: 't', status: 'open' }, { id: 'y', status: 'closed' }, { id: 'z', status: 'open' }]);
    assert.deepEqual(g.map((x) => x.map((r) => r.id)), [['y'], ['t', 'z']]);
    assert.deepEqual(closesFirst([{ id: 't', status: 'open' }]).map((x) => x.map((r) => r.id)), [['t']]);
    assert.deepEqual(closesFirst([]), []);
  });

  await ok('T1\'s morning: today\'s day sent FIRST, yesterday\'s close after it — both land, nothing refused', async () => {
    reset();
    const r = await push({
      business_days: [day(DAY_T, 'open', '2026-09-29'), day(DAY_Y, 'closed', '2026-09-28')],
      shifts: [{ id: SHIFT_T, branch_id: BR, cashier_id: 'u', opened_at: '2026-09-29T06:55:40Z', status: 'open', opening_float: 3000,
                 business_day_id: DAY_T, business_date: '2026-09-29', device_id: DEV, terminal_code: 'T1' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rejected ?? [], [], JSON.stringify(r.body));
    assert.equal(db.business_days.find((d) => d.id === DAY_Y).status, 'closed');
    assert.equal(db.business_days.find((d) => d.id === DAY_T).status, 'open');
    assert.ok(db.shifts.some((s) => s.id === SHIFT_T), 'today\'s shift is on the cloud — the web sees T1 open');
  });

  await ok('a real clash is still refused: a second open day with yesterday\'s NOT closed', async () => {
    reset();
    const r = await push({ business_days: [day(DAY_T, 'open', '2026-09-29')] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body.rejected ?? []).map((x) => x.code), ['duplicate_open_day']);
  });

  await ok('the route writes the days through closesFirst, one group after the other', () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/sync.ts'), 'utf8');
    assert.match(src, /for \(const group of closesFirst<\(typeof rows\)\[number\]>\(rows\)\) \{\s+results\.push\(\.\.\.await Promise\.all\(/);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
