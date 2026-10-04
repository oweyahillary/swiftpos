/**
 * test-migration-120.mjs — A394: stock take (stock_takes, stock_take_lines, ingredient movements' reference, the
 * inventory.count permission) — PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: the one-open-count index dropped → "one open count per branch" fails; the kind CHECK
 * dropped → "a line is a product or an ingredient" fails; the grant matching '%manager%' or every role → "managers
 * count, cashiers do not" fails; RLS left off → "only the cloud reads counts" fails.
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
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/120_stock_take.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

console.log('\nMigration 120 (stock take) — PGlite\n');
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.branches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid REFERENCES public.businesses(id), name text);
  CREATE TABLE public.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.ingredients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.ingredient_stock_movements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ingredient_id uuid, quantity_change numeric);
  CREATE TABLE public.permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, label text, module text, description text);
  CREATE TABLE public.roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
  CREATE TABLE public.role_permissions (role_id uuid REFERENCES public.roles(id), permission_id uuid REFERENCES public.permissions(id), PRIMARY KEY (role_id, permission_id));
  INSERT INTO public.businesses (id, name) VALUES ('00000000-0000-0000-0000-0000000000b1', 'African Fries');
  INSERT INTO public.branches (id, business_id, name) VALUES
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Westlands'),
    ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', 'CBD');
  INSERT INTO public.products (id, name) VALUES ('00000000-0000-0000-0000-0000000000c1', 'Coke 500ml');
  INSERT INTO public.ingredients (id, name) VALUES ('00000000-0000-0000-0000-0000000000d1', 'Cooking oil');
  INSERT INTO public.roles (name) VALUES ('Manager'), ('Branch Manager'), ('Cashier'), ('Trainee Manager'), ('Owner');
`);
await db.exec(SQL);

const B = '00000000-0000-0000-0000-0000000000b1', W = '00000000-0000-0000-0000-0000000000a1', C = '00000000-0000-0000-0000-0000000000a2';
const start = (branch, ref) => db.query(`INSERT INTO public.stock_takes (business_id, branch_id, ref) VALUES ($1, $2, $3) RETURNING id, status, freeze_sales`, [B, branch, ref]);

await ok('a count starts counting, not frozen unless the owner said so', async () => {
  const r = (await start(W, 'ST-0001')).rows[0];
  assert.equal(r.status, 'counting'); assert.equal(r.freeze_sales, false);
});
await ok('one open count per branch (counting or review); another branch may count; a closed one frees it', async () => {
  await assert.rejects(start(W, 'ST-0002'));
  await start(C, 'ST-0002');
  await db.exec(`UPDATE public.stock_takes SET status = 'review' WHERE ref = 'ST-0001'`);
  await assert.rejects(start(W, 'ST-0003'));
  await db.exec(`UPDATE public.stock_takes SET status = 'posted' WHERE ref = 'ST-0001'`);
  await start(W, 'ST-0003');
  await assert.rejects(db.exec(`UPDATE public.stock_takes SET status = 'done' WHERE ref = 'ST-0003'`));
});
await ok('a line is a product or an ingredient, once per count; a count is never negative', async () => {
  const take = (await db.query(`SELECT id FROM public.stock_takes WHERE ref = 'ST-0003'`)).rows[0].id;
  await db.query(`INSERT INTO public.stock_take_lines (stock_take_id, business_id, item_kind, product_id, name) VALUES ($1, $2, 'product', '00000000-0000-0000-0000-0000000000c1', 'Coke 500ml')`, [take, B]);
  await db.query(`INSERT INTO public.stock_take_lines (stock_take_id, business_id, item_kind, ingredient_id, name) VALUES ($1, $2, 'ingredient', '00000000-0000-0000-0000-0000000000d1', 'Cooking oil')`, [take, B]);
  await assert.rejects(db.query(`INSERT INTO public.stock_take_lines (stock_take_id, business_id, item_kind, product_id, name) VALUES ($1, $2, 'product', '00000000-0000-0000-0000-0000000000c1', 'again')`, [take, B]));
  await assert.rejects(db.query(`INSERT INTO public.stock_take_lines (stock_take_id, business_id, item_kind, ingredient_id, name) VALUES ($1, $2, 'product', '00000000-0000-0000-0000-0000000000d1', 'wrong kind')`, [take, B]));
  await assert.rejects(db.query(`INSERT INTO public.stock_take_lines (stock_take_id, business_id, item_kind, name) VALUES ($1, $2, 'product', 'no item')`, [take, B]));
  await assert.rejects(db.query(`UPDATE public.stock_take_lines SET counted_qty = -1 WHERE stock_take_id = $1`, [take]));
  await db.query(`UPDATE public.stock_take_lines SET counted_qty = 12.5, expected_qty = 14 WHERE stock_take_id = $1`, [take]);
});
await ok('an ingredient movement can name its order or its count', async () => {
  await db.exec(`INSERT INTO public.ingredient_stock_movements (ingredient_id, quantity_change, reference_type, reference_id)
                 VALUES ('00000000-0000-0000-0000-0000000000d1', -1, 'order', gen_random_uuid())`);
});
await ok('managers count; cashiers and a "Trainee Manager" do not (same name match as 75/83)', async () => {
  const r = (await db.query(`SELECT r.name FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    JOIN public.permissions p ON p.id = rp.permission_id WHERE p.key = 'inventory.count' ORDER BY r.name`)).rows.map((x) => x.name);
  assert.deepEqual(r, ['Branch Manager', 'Manager', 'Owner']);
});
await ok('only the cloud reads counts (RLS on, no policy)', async () => {
  for (const t of ['stock_takes', 'stock_take_lines']) {
    assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [t])).rows[0].relrowsecurity, true, t);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = $1`, [t])).rows[0].n, 0, t);
  }
});
await ok('it runs twice without error, grants once, records itself once', async () => {
  await db.exec(SQL);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id WHERE p.key = 'inventory.count'`)).rows[0].n, 3);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '120_stock_take'`)).rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
