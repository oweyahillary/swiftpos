/**
 * void-owner-row.test.mjs — A451: an owner voids and refunds from the web even when their sign-in carries no users row.
 *
 * Owner, 2026-10-12 (console): POST /api/orders/8a523b99…/void → 500, twice. An owner whose account has no public.users
 * row signs in with the auth.users id (auth.ts, "fallback of last resort"); the void then wrote that id into
 * orders.voided_by / authorized_by — both REFERENCE public.users(id) — and the database refused it every time.
 *
 * RUNS the built routes (apps/server/dist/routes/orders.js) over real HTTP against an in-memory database that refuses a
 * voided_by / authorized_by / refunded_by / refund_authorized_by that is not a users row, as Postgres does (23503).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/void-owner-row.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: recordedPerson returning req.userId as it is → "the owner voids … 200" fails (500 again);
 * verifyPin's length guard removed → "a stored PIN of another shape is no match" fails (it throws).
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

if (!fs.existsSync(path.join(DIST, 'routes/orders.js'))) {
  console.log('\nCannot load apps/server/dist/routes/orders.js — build the server first:\n  cd apps/server && npm run build\n');
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
const OWNER_ROW = '44444444-4444-4444-8444-444444444444';      // the owner's users row
const AUTH_ID = '99999999-9999-4999-8999-999999999999';        // the owner's auth.users id — no users row
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', O2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sale = (id, n) => ({ id, business_id: BZ, branch_id: BR, order_number: n, status: 'completed', total: 1300, delivery_fee: 0,
  created_at: '2026-10-11T09:00:00Z', device_id: 'dev-T1', shift_id: null, customer_id: null, refunded_at: null,
  order_items: [{ product_id: null, quantity: 1 }],
  payments: [{ id: `p-${id}`, status: 'completed', amount: 1300, method: 'mpesa' }] });

let db;
const reset = (ownerId) => {
  db = {
    businesses: [{ id: BZ, owner_id: ownerId, type: 'restaurant' }],
    users: [{ id: OWNER_ROW, business_id: BZ, name: 'Owner', status: 'active', permissions_version: 0 }],
    orders: [sale(O1, 'T1-0001'), sale(O2, 'T1-0002')],
    payments: [], business_settings: [], kitchen_tickets: [], products: [], stock_movements: [], float_transactions: [],
  };
};
const FK = ['voided_by', 'authorized_by', 'refunded_by', 'refund_authorized_by', 'created_by'];
const refused = (payload) => FK.some((k) => payload?.[k] && !db.users.some((u) => u.id === payload[k]));

// A small in-memory PostgREST: select / eq / in / is / order / limit / maybeSingle / single / insert / update / delete / rpc.
supabase.from = (table) => {
  const f = []; let op = 'select'; let payload = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (op === 'insert') {
      for (const p of [].concat(payload)) {
        if (['orders', 'payments', 'stock_movements'].includes(table) && refused(p)) return { data: null, error: { code: '23503', message: 'violates foreign key constraint' } };
        db[table].push({ ...p });
      }
      return { data: null, error: null };
    }
    if (op === 'update') {
      if (table === 'orders' && refused(payload)) return { data: null, error: { code: '23503', message: 'insert or update on table "orders" violates foreign key constraint "orders_voided_by_fkey"' } };
      const hit = rows(); hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null };
    }
    if (op === 'delete') { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
    return { data: rows(), error: null };
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'insert') return (row) => { op = 'insert'; payload = row; return q; };
      if (prop === 'update') return (row) => { op = 'update'; payload = row; return q; };
      if (prop === 'delete') return () => { op = 'delete'; return q; };
      if (prop === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'maybeSingle') return () => { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); };
      if (prop === 'single') return () => { const r = run(); const d = r.data?.[0]; return Promise.resolve(r.error ? r : d ? { data: d, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/orders', require(path.join(DIST, 'routes/orders.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}/api/orders`;
// A494: the shape /auth/login issues — the owner's password session (ownerLogin, no surface). requireAuth skips the
// users-row check for this session only; the A451 case (no users row) is exactly this session.
const ownerToken = (userId) => jwt.sign({ userId, businessId: BZ, branchId: null, isOwner: true, ownerLogin: true, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's' }, process.env.JWT_SECRET);
const post = async (url, body, userId) => {
  const r = await fetch(`${BASE}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken(userId)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const order = (id) => db.orders.find((o) => o.id === id);

console.log('\nAn owner signed in without a users row\n');
reset(OWNER_ROW);
await ok('the owner voids a till\'s offline sale from the web — 200, not 500 (recorded as the owner\'s users row)', async () => {
  const r = await post(`/${O1}/void`, { reason: 'Wrong order' }, AUTH_ID);
  assert(r.status === 200 && order(O1).status === 'voided' && order(O1).voided_by === OWNER_ROW && order(O1).authorized_by === OWNER_ROW, JSON.stringify({ r, o: order(O1) }));
});
await ok('…and refunds one — 200, recorded the same way, the M-Pesa leg reversed', async () => {
  const r = await post(`/${O2}/refund`, { reason: 'Item returned' }, AUTH_ID);
  assert(r.status === 200 && order(O2).refunded_by === OWNER_ROW && db.payments.some((p) => p.order_id === O2 && p.amount === -1300 && p.method === 'mpesa'),
    JSON.stringify({ r, o: order(O2) }));
});
reset(AUTH_ID);   // the business's owner_id itself is not a users row
await ok('with no users row anywhere for the owner, the void still goes through (recorded as nobody)', async () => {
  const r = await post(`/${O1}/void`, { reason: 'Wrong order' }, AUTH_ID);
  assert(r.status === 200 && order(O1).status === 'voided' && order(O1).voided_by === null, JSON.stringify({ r, o: order(O1) }));
});
reset(OWNER_ROW);
await ok('an owner WITH a users row is recorded as themselves, as before', async () => {
  const r = await post(`/${O1}/void`, { reason: 'Wrong order' }, OWNER_ROW);
  assert(r.status === 200 && order(O1).voided_by === OWNER_ROW, JSON.stringify(r));
});

console.log('\nThe manager-PIN check\n');
await ok('a stored PIN of another shape is no match — not a crash for the whole business', async () => {
  const { verifyPin } = require(path.join(DIST, 'routes/auth.js'));
  const r = await verifyPin('1234', 'not-a-hash', BZ);
  const e = await verifyPin('1234', '', BZ);
  assert(r.valid === false && e.valid === false, JSON.stringify([r, e]));
});

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
