/**
 * report-collected.test.mjs — A451: the web report's overview adds up to what the till counted.
 *
 * Owner, 2026-10-12 (Reports screenshot): "Gross Sales 8,900", payment methods M-Pesa 7,000 + Cash 2,050 (78.7% + 23.0% —
 * over 100%), against the till's count "Cash 2050, Mpesa 7000, Total 9050": "the total is off" — "we need a card of total
 * sales inclusive VAT". Each payment covers the bill + a delivery fee + a tip (create_order_atomic), the sales count the
 * bill only. The overview now shows Total Collected (incl. VAT) = sales + delivery fees + tips — what the methods add to.
 *
 * RUNS the built route (apps/server/dist/routes/reports.js GET /master) against an in-memory database.
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/report-collected.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: totalCollected without the delivery fees → "9,050" fails; a free delivery's fee counted →
 * "a free delivery adds nothing" fails.
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
if (!fs.existsSync(path.join(DIST, 'routes/reports.js'))) { console.log('\nBuild the server first: cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222', OWNER = '44444444-4444-4444-8444-444444444444';
const at = '2026-10-11T09:00:00Z';
const o = (id, type, total, legs, extra = {}) => ({ id, business_id: BZ, branch_id: BR, order_number: id, order_type: type, status: 'completed',
  subtotal: total, vat_amount: +(total * 16 / 118).toFixed(2), ctl_amount: +(total * 2 / 118).toFixed(2), discount_amount: 0, total,
  tip_amount: 0, delivery_fee: 0, delivery_free: false, refunded_amount: 0, refunded_at: null, created_at: at, cashier_id: null,
  branches: { name: 'Westlands' }, payments: legs.map(([method, amount]) => ({ method, amount, status: 'completed' })), ...extra });
let db = {
  businesses: [{ id: BZ, owner_id: OWNER, type: 'restaurant', ctl_rate: 2 }],
  users: [{ id: OWNER, business_id: BZ, name: 'Owner', status: 'active', permissions_version: 0 }],
  // The owner's day: cash 2,050 + M-Pesa 7,000 = 9,050 — sales 8,900 and a 150 delivery fee.
  orders: [
    o('o1', 'retail', 5550, [['mpesa', 5550]]),
    o('o2', 'takeaway', 2050, [['cash', 2050]]),
    o('o3', 'delivery', 1300, [['mpesa', 1450]], { delivery_fee: 150 }),
    o('o4', 'delivery', 0, [], { delivery_fee: 100, delivery_free: true, status: 'voided' }),
  ],
  order_items: [], categories: [], expenses: [], business_settings: [],
};
// A small in-memory PostgREST: select / eq / in / is / order / limit / maybeSingle / single / insert / update / delete / rpc.
supabase.from = (table) => {
  const f = []; let op = 'select'; let payload = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (op === 'insert') {
      for (const p of [].concat(payload)) {
        db[table].push({ ...p });
      }
      return { data: null, error: null };
    }
    if (op === 'update') {
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
app.use('/api/reports', require(path.join(DIST, 'routes/reports.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const tok = jwt.sign({ userId: OWNER, businessId: BZ, branchId: null, isOwner: true, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'dashboard' }, process.env.JWT_SECRET);
const master = async () => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/reports/master?from=2026-10-11&to=2026-10-11`, { headers: { Authorization: `Bearer ${tok}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('\nThe overview adds up to what was paid\n');
await ok('Total Collected (incl. VAT) is 9,050 — the sales 8,900 + the 150 delivery fee, as the till counted', async () => {
  const r = await master();
  const s = r.body?.summary;
  assert(r.status === 200 && s.totalSale === 8900 && s.totalDeliveryFees === 150 && s.totalTips === 0 && s.totalCollected === 9050, JSON.stringify(s));
});
await ok('…which is what the payment methods add up to (M-Pesa 7,000 + cash 2,050)', async () => {
  const r = await master();
  const paid = r.body.payments.reduce((a, p) => a + p.amount, 0);
  assert(paid === r.body.summary.totalCollected && r.body.payments.find((p) => p.method === 'mpesa').amount === 7000, JSON.stringify(r.body.payments));
});
await ok('a free delivery adds nothing (the customer paid no fee)', async () => {
  db.orders.find((x) => x.id === 'o4').status = 'completed';
  const r = await master();
  db.orders.find((x) => x.id === 'o4').status = 'voided';
  assert(r.body.summary.totalDeliveryFees === 150, JSON.stringify(r.body.summary));
});
await ok('a tip is collected too', async () => {
  db.orders.find((x) => x.id === 'o2').tip_amount = 50;
  const r = await master();
  db.orders.find((x) => x.id === 'o2').tip_amount = 0;
  assert(r.body.summary.totalTips === 50 && r.body.summary.totalCollected === 9100, JSON.stringify(r.body.summary));
});
await ok('the web shows it first, and the payment shares are of what was paid (they add to 100%)', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/ReportsPage.tsx'), 'utf8');
  assert(/label="Total Collected \(incl\. VAT\)"/.test(src) && /p\.amount \/ paidTotal\) \* 100/.test(src), 'ReportsPage');
});

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
