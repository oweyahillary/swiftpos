/**
 * test-migration-111.mjs — 0.6.27: orders.delivery_fee (pass-through, in create_order_atomic), expenses.payment_method,
 * shifts.confirm_reasons. Against real Postgres (PGlite); the real function body from the migration is RUN. Every
 * assertion is awaited (the A305 lesson).
 *
 * MUTATIONS TO CONFIRM BITE: drop `+ v_fee` from v_due → "an M-Pesa leg of bill + fee is accepted" fails; drop v_fee
 * from the INSERT → "the fee is stored, total stays the bill" fails; drop the payment_method DEFAULT → "existing
 * expenses read as cash" fails; drop orders_delivery_fee_nonneg → "a negative fee is refused" fails; drop the order_id
 * foreign key → "a rider's pay-out names its sale" fails.
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
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/111_prospect_requests.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const BIZ = '11111111-1111-4111-8111-111111111111';
const BR  = '22222222-2222-4222-8222-222222222222';
const SH  = '33333333-3333-4333-8333-333333333333';

console.log('\nMigration 111 (delivery fee, expense method, confirm reasons) — PGlite\n');
await (async () => {
  const db = new PGlite();
  // The tables as they stand before 111 (the columns create_order_atomic writes).
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
    INSERT INTO public.expenses (business_id, amount, description) VALUES ('${BIZ}', 500, 'Gas (paid from the drawer)');
    CREATE TABLE public.float_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shift_id uuid NOT NULL,
      branch_id uuid NOT NULL, cashier_id uuid NOT NULL, type text NOT NULL, amount numeric(12,2) NOT NULL, reason text);
    CREATE TABLE public.shifts (id uuid PRIMARY KEY, business_id uuid);
    INSERT INTO public.shifts VALUES ('${SH}', '${BIZ}');
  `);
  await db.exec(SQL);

  const order = (extra) => JSON.stringify({ business_id: BIZ, branch_id: BR, order_number: 'T1-1', order_type: 'delivery',
    delivery_person: 'Eugene', subtotal: 1000, vat_amount: 0, ctl_amount: 0, discount_amount: 0, total: 1000, ...extra });
  const items = JSON.stringify([{ item: { product_name: 'Chicken', unit_price: 1000, quantity: 1, subtotal: 1000 } }]);
  const rpc = (o, legs) => db.query(`SELECT * FROM public.create_order_atomic($1::jsonb, $2::jsonb, $3::jsonb)`, [o, items, JSON.stringify(legs)]);

  await ok('an M-Pesa leg of bill + fee is accepted (1000 + 300 = 1300)', async () => {
    const r = await rpc(order({ delivery_fee: 300 }), [{ method: 'mpesa', amount: 1300 }]);
    assert.strictEqual(r.rows.length, 1);
  });
  await ok('the fee is stored, total stays the bill — sales are unchanged', async () => {
    const r = await db.query(`SELECT total::numeric AS t, delivery_fee::numeric AS f FROM public.orders WHERE order_number='T1-1'`);
    assert.deepStrictEqual([Number(r.rows[0].t), Number(r.rows[0].f)], [1000, 300]);
  });
  await ok('legs of the bill alone are refused when a fee is due (the error names the fee)', async () => {
    const e = await threw(() => rpc(order({ order_number: 'T1-2', delivery_fee: 300 }), [{ method: 'mpesa', amount: 1000 }]));
    assert.ok(e && /delivery fee 300/.test(e.message), e?.message);
  });
  await ok('an order without delivery_fee (a till before 0.6.27) is unchanged: fee 0, legs = bill (+ tip)', async () => {
    await rpc(order({ order_number: 'T1-3', order_type: 'takeaway', tip_amount: 50 }), [{ method: 'cash', amount: 1050 }]);
    const r = await db.query(`SELECT delivery_fee::numeric AS f FROM public.orders WHERE order_number='T1-3'`);
    assert.strictEqual(Number(r.rows[0].f), 0);
  });
  await ok('a negative fee is refused', async () => {
    const e = await threw(() => db.exec(`UPDATE public.orders SET delivery_fee = -1 WHERE order_number='T1-1'`));
    assert.ok(e && /orders_delivery_fee_nonneg/.test(e.message), e?.message);
  });
  await ok('existing expenses read as cash (what the drawer paid); a new one can be M-Pesa', async () => {
    const r = await db.query(`SELECT payment_method FROM public.expenses`);
    assert.deepStrictEqual(r.rows.map((x) => x.payment_method), ['cash']);
    await db.exec(`INSERT INTO public.expenses (business_id, amount, description, payment_method) VALUES ('${BIZ}', 1200, 'Supplier', 'mpesa')`);
  });
  await ok('an expense method outside the payment-code format is refused', async () => {
    const e = await threw(() => db.exec(`INSERT INTO public.expenses (business_id, amount, description, payment_method) VALUES ('${BIZ}', 1, 'x', 'M-Pesa!')`));
    assert.ok(e && /expenses_payment_method_format/.test(e.message), e?.message);
  });
  await ok('a rider\'s pay-out names its sale (only a real sale)', async () => {
    const o = await db.query(`SELECT id FROM public.orders WHERE order_number='T1-1'`);
    const oid = o.rows[0].id;
    await db.exec(`INSERT INTO public.float_transactions (shift_id, branch_id, cashier_id, type, amount, reason, order_id)
                   VALUES ('${SH}', '${BR}', '${BIZ}', 'float_out', 300, 'Delivery fee — Eugene (#T1-1)', '${oid}')`);
    const e = await threw(() => db.exec(`INSERT INTO public.float_transactions (shift_id, branch_id, cashier_id, type, amount, order_id)
                   VALUES ('${SH}', '${BR}', '${BIZ}', 'float_out', 1, '99999999-9999-4999-8999-999999999999')`));
    assert.ok(e && /float_transactions_order_id_fkey/.test(e.message), e?.message);
  });
  await ok('a manager\'s reasons are stored per method', async () => {
    await db.exec(`UPDATE public.shifts SET confirm_reasons = '{"cash": "200 found under the tray"}' WHERE id='${SH}'`);
    const r = await db.query(`SELECT confirm_reasons->>'cash' AS c FROM public.shifts WHERE id='${SH}'`);
    assert.strictEqual(r.rows[0].c, '200 found under the tray');
  });
  await ok('idempotent: running 111 again changes nothing, one migration row', async () => {
    await db.exec(SQL);
    const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='111_prospect_requests'`);
    assert.strictEqual(r.rows[0].n, 1);
    const o = await db.query(`SELECT count(*)::int AS n FROM public.orders`);
    assert.strictEqual(o.rows[0].n, 2);
  });
})();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
