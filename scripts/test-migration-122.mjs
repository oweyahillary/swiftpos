/**
 * test-migration-122.mjs — A396: clear a client's test data between two times — purge_test_data, run for real against
 * the WHOLE schema (every migration replayed into PGlite), with a test window and a real sale after it.
 *
 * Owner, 2026-10-04: "the purge i should be able to select the date it starts and time ... and the date and time testing
 * stopped so that i should not purge a real sale".
 *
 * MUTATIONS TO CONFIRM BITE: the window's upper bound dropped (created_at >= p_from only) → "the real sale after the
 * window is untouched" fails; the open-shift check removed → "a shift still open refuses" fails; stock 'undo' skipped →
 * "stock goes back" fails; dry_run ignored → "a preview changes nothing" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort((a, b) => (+a.split('_')[0]) - (+b.split('_')[0]) || a.localeCompare(b));
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith('\\') || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
for (const f of files) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));   // every migration, in order — a failure fails the test

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const count = async (t, w = 'true', p = []) => Number((await one(`SELECT count(*)::int AS n FROM public.${t} WHERE ${w}`, p)).n);

console.log('\nMigration 122 (clear test data between two times) — PGlite, every migration\n');
const B = '00000000-0000-0000-0000-0000000000b1', BR = '00000000-0000-0000-0000-0000000000a1', U = '00000000-0000-0000-0000-0000000000e1';
const OTHER = '00000000-0000-0000-0000-0000000000b2', OBR = '00000000-0000-0000-0000-0000000000a2';
const P = '00000000-0000-0000-0000-0000000000c1', I = '00000000-0000-0000-0000-0000000000d1', S = '00000000-0000-0000-0000-0000000000f1';
const FROM = '2026-10-01T08:00:00Z', TO = '2026-10-02T18:00:00Z';
await db.exec(`
  INSERT INTO public.businesses (id, name, type) VALUES ('${B}', 'African Fries', 'restaurant'), ('${OTHER}', 'Someone Else', 'restaurant');
  INSERT INTO public.branches (id, business_id, name) VALUES ('${BR}', '${B}', 'Westlands'), ('${OBR}', '${OTHER}', 'Other');
  INSERT INTO public.users (id, business_id, name) VALUES ('${U}', '${B}', 'Mary');
  INSERT INTO public.products (id, business_id, name) VALUES ('${P}', '${B}', 'Coke 500ml');
  INSERT INTO public.ingredients (id, business_id, name) VALUES ('${I}', '${B}', 'Cooking oil');
  INSERT INTO public.suppliers (id, business_id, name) VALUES ('${S}', '${B}', 'Brookside');
  -- stock before the test: 50 Coke, 20 L oil; the test sold 10 Coke and used 4 L oil; a real sale after sold 2 Coke
  INSERT INTO public.stock_levels (product_id, branch_id, quantity) VALUES ('${P}', '${BR}', 38);
  INSERT INTO public.ingredient_stock_levels (business_id, ingredient_id, branch_id, current_stock) VALUES ('${B}', '${I}', '${BR}', 16);
  INSERT INTO public.stock_movements (product_id, branch_id, movement_type, quantity_change, quantity_after, created_at) VALUES
    ('${P}', '${BR}', 'sale', -10, 40, '2026-10-01T12:00:00Z'), ('${P}', '${BR}', 'sale', -2, 38, '2026-10-03T09:00:00Z');
  INSERT INTO public.ingredient_stock_movements (business_id, ingredient_id, branch_id, movement_type, quantity_change, quantity_after, created_at)
    VALUES ('${B}', '${I}', '${BR}', 'sale', -4, 16, '2026-10-01T12:00:00Z');
  -- the test: a shift, a day, two sales, a payment, an expense, a pay-out, a customer with points, a supplier bill
  INSERT INTO public.business_days (id, business_id, branch_id, business_date, opened_at, closed_at, status)
    VALUES ('00000000-0000-0000-0000-00000000da01', '${B}', '${BR}', '2026-10-01', '2026-10-01T08:30:00Z', '2026-10-01T22:00:00Z', 'closed');
  INSERT INTO public.shifts (id, business_id, branch_id, cashier_id, opened_at, closed_at, status, business_day_id)
    VALUES ('00000000-0000-0000-0000-0000000005a1', '${B}', '${BR}', '${U}', '2026-10-01T09:00:00Z', '2026-10-01T21:00:00Z', 'closed', '00000000-0000-0000-0000-00000000da01');
  INSERT INTO public.customers (id, business_id, name, created_at) VALUES ('00000000-0000-0000-0000-00000000c051', '${B}', 'Test Customer', '2026-10-01T10:00:00Z'),
    ('00000000-0000-0000-0000-00000000c052', '${B}', 'Real Customer', '2026-09-20T10:00:00Z');
  INSERT INTO public.orders (id, business_id, branch_id, order_number, total, created_at, shift_id, customer_id) VALUES
    ('00000000-0000-0000-0000-0000000000a5', '${B}', '${BR}', 'T1-0001', 1000, '2026-10-01T12:00:00Z', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000000c051'),
    ('00000000-0000-0000-0000-0000000000a6', '${B}', '${BR}', 'T1-0002', 500,  '2026-10-01T13:00:00Z', '00000000-0000-0000-0000-0000000005a1', NULL),
    ('00000000-0000-0000-0000-0000000000a7', '${B}', '${BR}', 'T1-0003', 900,  '2026-10-03T09:00:00Z', NULL, '00000000-0000-0000-0000-00000000c052'),
    ('00000000-0000-0000-0000-0000000000a8', '${OTHER}', '${OBR}', 'X-0001', 700, '2026-10-01T12:00:00Z', NULL, NULL);
  INSERT INTO public.order_items (order_id, product_name, unit_price, subtotal) VALUES
    ('00000000-0000-0000-0000-0000000000a5', 'Coke', 100, 1000), ('00000000-0000-0000-0000-0000000000a7', 'Coke', 450, 900);
  INSERT INTO public.payments (order_id, business_id, branch_id, method, amount) VALUES
    ('00000000-0000-0000-0000-0000000000a5', '${B}', '${BR}', 'cash', 1000), ('00000000-0000-0000-0000-0000000000a7', '${B}', '${BR}', 'mpesa', 900);
  INSERT INTO public.loyalty_transactions (customer_id, business_id, order_id, type, points) VALUES
    ('00000000-0000-0000-0000-00000000c051', '${B}', '00000000-0000-0000-0000-0000000000a5', 'earn', 10);
  INSERT INTO public.expenses (business_id, branch_id, description, amount, created_at, shift_id) VALUES ('${B}', '${BR}', 'Test gas', 300, '2026-10-01T15:00:00Z', '00000000-0000-0000-0000-0000000005a1'),
    ('${B}', '${BR}', 'Real gas', 300, '2026-10-03T15:00:00Z', NULL);
  INSERT INTO public.float_transactions (shift_id, branch_id, cashier_id, type, amount, created_at) VALUES ('00000000-0000-0000-0000-0000000005a1', '${BR}', '${U}', 'float_out', 200, '2026-10-01T16:00:00Z');
  INSERT INTO public.supplier_bills (business_id, supplier_id, ref, amount, created_at) VALUES ('${B}', '${S}', 'BILL-0001', 5000, '2026-10-01T11:00:00Z');
`);
const run = (args) => one(`SELECT public.purge_test_data($1, $2, $3, $4, $5, $6, 'hillary@zaptill.co.ke', 'test') AS r`, args).then((x) => x.r);

await ok('a preview counts what is in the window — and changes nothing', async () => {
  const r = await run([B, FROM, TO, 'undo', true, true]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.counts.sales, 2); assert.equal(Number(r.counts.sales_value), 1500);
  assert.equal(r.counts.shifts, 1); assert.equal(r.counts.trading_days, 1); assert.equal(r.counts.expenses, 1);
  assert.equal(r.counts.stock_movements, 2); assert.equal(r.counts.supplier_bills, 1); assert.equal(r.counts.customers_created, 1);
  assert.ok(String(r.counts.next_sale_after).startsWith('2026-10-03'), 'the first real sale after the window is shown');
  assert.equal(await count('orders', `business_id = '${B}'`), 3);
});
await ok('it refuses a window that ends in the future, or before it starts', async () => {
  const fut = await run([B, FROM, '2099-01-01T00:00:00Z', 'undo', false, true]);
  assert.equal(fut.ok, false); assert.match(fut.problems.join(' '), /in the future/);
  const back = await run([B, TO, FROM, 'undo', false, true]);
  assert.equal(back.ok, false); assert.match(back.problems.join(' '), /must be after its start/);
});
await ok('a shift still open (or closed after the window) refuses — nothing is cut in two', async () => {
  await db.exec(`UPDATE public.shifts SET closed_at = NULL WHERE id = '00000000-0000-0000-0000-0000000005a1'`);
  const r = await run([B, FROM, TO, 'undo', false, false]);
  assert.equal(r.ok, false); assert.match(r.problems.join(' '), /shift\(s\) that began in the window are still open/);
  assert.equal(await count('orders', `business_id = '${B}'`), 3, 'nothing was removed');
  await db.exec(`UPDATE public.shifts SET closed_at = '2026-10-01T21:00:00Z' WHERE id = '00000000-0000-0000-0000-0000000005a1'`);
});
await ok('a real sale after the window on a test shift refuses', async () => {
  await db.exec(`UPDATE public.orders SET shift_id = '00000000-0000-0000-0000-0000000005a1' WHERE order_number = 'T1-0003'`);
  const r = await run([B, FROM, TO, 'undo', false, true]);
  assert.equal(r.ok, false); assert.match(r.problems.join(' '), /belong to a shift inside it/);
  await db.exec(`UPDATE public.orders SET shift_id = NULL WHERE order_number = 'T1-0003'`);
});
await ok('the clear: the window\'s sales, shift, day, expense, pay-out, bill, test customer go — in one go', async () => {
  const r = await run([B, FROM, TO, 'undo', true, false]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(await count('orders', `business_id = '${B}'`), 1);
  assert.equal(await count('order_items'), 1); assert.equal(await count('payments'), 1);
  assert.equal(await count('shifts'), 0); assert.equal(await count('business_days'), 0);
  assert.equal(await count('expenses'), 1); assert.equal(await count('float_transactions'), 0);
  assert.equal(await count('loyalty_transactions'), 0); assert.equal(await count('supplier_bills'), 0);
  assert.equal(await count('customers', `name = 'Test Customer'`), 0); assert.equal(r.counts.customers_deleted, 1);
});
await ok('the real sale after the window is untouched — its items, payment, customer, expense', async () => {
  const o = await one(`SELECT order_number, total FROM public.orders WHERE business_id = '${B}'`);
  assert.equal(o.order_number, 'T1-0003'); assert.equal(Number(o.total), 900);
  assert.equal(await count('payments', `method = 'mpesa'`), 1);
  assert.equal(await count('customers', `name = 'Real Customer'`), 1);
  assert.equal(await count('expenses', `description = 'Real gas'`), 1);
});
await ok('stock goes back to before the test (the real sale after still counts)', async () => {
  assert.equal(Number((await one(`SELECT quantity FROM public.stock_levels WHERE product_id = '${P}'`)).quantity), 48);
  assert.equal(Number((await one(`SELECT current_stock FROM public.ingredient_stock_levels WHERE ingredient_id = '${I}'`)).current_stock), 20);
  assert.equal(await count('stock_movements'), 1, 'only the real sale\'s movement is left');
});
await ok('another business is never touched; the clear is recorded', async () => {
  assert.equal(await count('orders', `business_id = '${OTHER}'`), 1);
  const rec = await one(`SELECT from_at, to_at, stock_mode, done_by, (counts->>'sales')::int AS sales FROM public.test_data_purges WHERE business_id = '${B}'`);
  assert.equal(rec.stock_mode, 'undo'); assert.equal(rec.done_by, 'hillary@zaptill.co.ke'); assert.equal(rec.sales, 2);
});
await ok('it runs twice without error and records itself once', async () => {
  await db.exec(sanitize(fs.readFileSync(path.join(MIG, '122_test_data_purge.sql'), 'utf8')));
  assert.equal(await count('schema_migrations', `version = '122_test_data_purge'`), 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
