/**
 * test-migration-115.mjs — 0.6.33: orders.delivery_free (the shop pays the rider, the customer pays no fee) and
 * create_order_atomic. Against real Postgres (PGlite): migrations 111 then 115 are RUN, and the real function body.
 *
 * MUTATIONS TO CONFIRM BITE: v_due keeping the fee on a free delivery → "a free delivery's legs are the bill alone" fails;
 * v_free not stored → "the flag and the rider's fee are both stored" fails; v_free without `AND v_fee > 0` → "free with no
 * fee is not a free delivery" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL111 = fs.readFileSync(path.join(ROOT, 'migrations/111_prospect_requests.sql'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/115_free_delivery.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const BIZ = '11111111-1111-4111-8111-111111111111';
const BR  = '22222222-2222-4222-8222-222222222222';

console.log('\nMigration 115 (free delivery) — PGlite\n');
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid, branch_id uuid, customer_id uuid,
    customer_name text, customer_phone text, order_number text, order_type text, delivery_person text, status text,
    subtotal numeric, vat_amount numeric, ctl_amount numeric, discount_amount numeric, discount_id uuid,
    loyalty_points_used int, total numeric, tip_amount numeric DEFAULT 0, shift_id uuid, seated_at timestamptz,
    idempotency_key text, cashier_id uuid, device_id text, pump_id uuid, sync_status text, created_at timestamptz
  );
  CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, product_id uuid,
    product_name text, category_name text, unit_price numeric, quantity numeric, subtotal numeric, notes text);
  CREATE TABLE public.order_item_variants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid,
    variant_group_name text, variant_option_name text, price_adjustment numeric);
  CREATE TABLE public.order_item_modifiers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid,
    modifier_group_name text, modifier_option_name text, price numeric);
  CREATE TABLE public.payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, business_id uuid,
    branch_id uuid, method text, amount numeric, amount_tendered numeric, change_given numeric, reference text,
    status text, sync_status text);
  CREATE TABLE public.expenses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid, amount numeric, description text);
  CREATE TABLE public.float_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shift_id uuid NOT NULL,
    branch_id uuid NOT NULL, cashier_id uuid NOT NULL, type text NOT NULL, amount numeric(12,2) NOT NULL, reason text);
  CREATE TABLE public.shifts (id uuid PRIMARY KEY, business_id uuid);
`);
await db.exec(SQL111);
await db.exec(SQL);

const order = (extra) => JSON.stringify({ business_id: BIZ, branch_id: BR, order_number: 'T1-1', order_type: 'delivery',
  delivery_person: 'Eugene', subtotal: 1000, vat_amount: 0, ctl_amount: 0, discount_amount: 0, total: 1000, ...extra });
const items = JSON.stringify([{ item: { product_name: 'Pizza', unit_price: 1000, quantity: 1, subtotal: 1000 } }]);
const rpc = (o, legs) => db.query(`SELECT * FROM public.create_order_atomic($1::jsonb, $2::jsonb, $3::jsonb)`, [o, items, JSON.stringify(legs)]);
const row = async (n) => (await db.query(`SELECT total::numeric AS t, delivery_fee::numeric AS f, delivery_free AS free FROM public.orders WHERE order_number=$1`, [n])).rows[0];

await ok('a free delivery\'s legs are the bill alone (the customer pays no fee)', async () => {
  const r = await rpc(order({ order_number: 'F-1', delivery_fee: 300, delivery_free: true }), [{ method: 'mpesa', amount: 1000 }]);
  assert.strictEqual(r.rows.length, 1);
});
await ok('the flag and the rider\'s fee are both stored; total stays the bill', async () => {
  const r = await row('F-1');
  assert.deepStrictEqual([Number(r.t), Number(r.f), r.free], [1000, 300, true]);
});
await ok('a free delivery paid bill + fee is refused (the customer would be charged it)', async () => {
  const e = await threw(() => rpc(order({ order_number: 'F-2', delivery_fee: 300, delivery_free: true }), [{ method: 'mpesa', amount: 1300 }]));
  assert.ok(e && /free delivery yes/.test(e.message), e?.message);
});
await ok('a paid delivery is unchanged: legs = bill + fee, flag false', async () => {
  await rpc(order({ order_number: 'P-1', delivery_fee: 300 }), [{ method: 'mpesa', amount: 1300 }]);
  const r = await row('P-1');
  assert.deepStrictEqual([Number(r.f), r.free], [300, false]);
  const e = await threw(() => rpc(order({ order_number: 'P-2', delivery_fee: 300 }), [{ method: 'mpesa', amount: 1000 }]));
  assert.ok(e && /delivery fee 300/.test(e.message), e?.message);
});
await ok('free with no fee is not a free delivery (nothing for the shop to pay)', async () => {
  await rpc(order({ order_number: 'Z-1', delivery_free: true }), [{ method: 'cash', amount: 1000 }]);
  assert.strictEqual((await row('Z-1')).free, false);
});
await ok('every order before 0.6.33 reads as not free', async () => {
  const r = await db.query(`SELECT count(*)::int AS n FROM public.orders WHERE delivery_free IS NULL`);
  assert.strictEqual(r.rows[0].n, 0);
});
await ok('re-running is harmless (idempotent) and recorded once', async () => {
  await db.exec(SQL);
  const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='115_free_delivery'`);
  assert.strictEqual(r.rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
