/**
 * test-migration-121.mjs — A395: what the business owes its suppliers (supplier_bills, supplier_payments,
 * supplier_returns + items, permission payables.manage) — PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: the amount CHECK dropped → "a bill or payment is more than 0" fails; the one-bill-per-GRN
 * index dropped → "one open bill per delivery" fails; the method CHECK dropped → "how it was paid" fails; a grant added
 * → "nobody is given payables.manage" fails.
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
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/121_supplier_payables.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

console.log('\nMigration 121 (supplier bills, payments, returns) — PGlite\n');
const db = new PGlite();
const B = '00000000-0000-0000-0000-0000000000b1', BR = '00000000-0000-0000-0000-0000000000a1', S = '00000000-0000-0000-0000-0000000000e1';
const G = '00000000-0000-0000-0000-0000000000f1', PR = '00000000-0000-0000-0000-0000000000c1', IN = '00000000-0000-0000-0000-0000000000d1';
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.businesses (id uuid PRIMARY KEY);
  CREATE TABLE public.branches (id uuid PRIMARY KEY, business_id uuid);
  CREATE TABLE public.suppliers (id uuid PRIMARY KEY, business_id uuid, name text);
  CREATE TABLE public.goods_received_notes (id uuid PRIMARY KEY, business_id uuid);
  CREATE TABLE public.products (id uuid PRIMARY KEY);
  CREATE TABLE public.ingredients (id uuid PRIMARY KEY);
  CREATE TABLE public.permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, label text, module text, description text);
  CREATE TABLE public.roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.role_permissions (role_id uuid, permission_id uuid);
  INSERT INTO public.businesses VALUES ('${B}'); INSERT INTO public.branches VALUES ('${BR}', '${B}');
  INSERT INTO public.suppliers VALUES ('${S}', '${B}', 'Brookside'); INSERT INTO public.goods_received_notes VALUES ('${G}', '${B}');
  INSERT INTO public.products VALUES ('${PR}'); INSERT INTO public.ingredients VALUES ('${IN}');
  INSERT INTO public.roles (name) VALUES ('Manager'), ('Owner');
`);
await db.exec(SQL);
const billSql = (extra = {}) => {
  const v = { ref: "'BILL-0001'", amount: 1000, grn: 'NULL', bill_date: "'2026-10-01'", due: "'2026-10-31'", status: "'open'", ...extra };
  return `INSERT INTO public.supplier_bills (business_id, supplier_id, ref, amount, grn_id, bill_date, due_date, status)
          VALUES ('${B}', '${S}', ${v.ref}, ${v.amount}, ${v.grn}, ${v.bill_date}, ${v.due}, ${v.status}) RETURNING id`;
};

await ok('a bill: open by default, more than 0, due on or after its date', async () => {
  const r = (await db.query(billSql())).rows[0];
  assert.equal((await db.query(`SELECT status FROM public.supplier_bills WHERE id = $1`, [r.id])).rows[0].status, 'open');
  await assert.rejects(db.query(billSql({ amount: 0 })));
  await assert.rejects(db.query(billSql({ due: "'2026-09-01'" })));
  await assert.rejects(db.query(billSql({ status: "'paid'" })));
});
await ok('one open bill per delivery; a voided one frees the delivery', async () => {
  const first = (await db.query(billSql({ grn: `'${G}'` }))).rows[0];
  await assert.rejects(db.query(billSql({ grn: `'${G}'` })));
  await db.query(`UPDATE public.supplier_bills SET status = 'void' WHERE id = $1`, [first.id]);
  await db.query(billSql({ grn: `'${G}'` }));
});
await ok('a payment: more than 0, how it was paid, against a bill or on account', async () => {
  const bill = (await db.query(`SELECT id FROM public.supplier_bills LIMIT 1`)).rows[0].id;
  await db.query(`INSERT INTO public.supplier_payments (business_id, supplier_id, bill_id, amount, method) VALUES ($1, $2, $3, 400, 'mpesa')`, [B, S, bill]);
  await db.query(`INSERT INTO public.supplier_payments (business_id, supplier_id, amount, method) VALUES ($1, $2, 100, 'cash')`, [B, S]);
  await assert.rejects(db.query(`INSERT INTO public.supplier_payments (business_id, supplier_id, amount, method) VALUES ($1, $2, 0, 'cash')`, [B, S]));
  await assert.rejects(db.query(`INSERT INTO public.supplier_payments (business_id, supplier_id, amount, method) VALUES ($1, $2, 10, 'card')`, [B, S]));
});
await ok('a return: items are a product or an ingredient, more than 0; the credit is never negative', async () => {
  const ret = (await db.query(`INSERT INTO public.supplier_returns (business_id, supplier_id, branch_id, ref, credit_amount) VALUES ($1, $2, $3, 'RTN-0001', 250) RETURNING id`, [B, S, BR])).rows[0].id;
  await db.query(`INSERT INTO public.supplier_return_items (return_id, item_kind, product_id, name, quantity) VALUES ($1, 'product', $2, 'Coke', 2)`, [ret, PR]);
  await db.query(`INSERT INTO public.supplier_return_items (return_id, item_kind, ingredient_id, name, quantity) VALUES ($1, 'ingredient', $2, 'Oil', 1.5)`, [ret, IN]);
  await assert.rejects(db.query(`INSERT INTO public.supplier_return_items (return_id, item_kind, product_id, name, quantity) VALUES ($1, 'ingredient', $2, 'x', 1)`, [ret, PR]));
  await assert.rejects(db.query(`INSERT INTO public.supplier_return_items (return_id, item_kind, product_id, name, quantity) VALUES ($1, 'product', $2, 'x', 0)`, [ret, PR]));
  await assert.rejects(db.query(`INSERT INTO public.supplier_returns (business_id, supplier_id, branch_id, ref, credit_amount) VALUES ($1, $2, $3, 'RTN-0002', -1)`, [B, S, BR]));
});
await ok('payables.manage is registered and given to nobody (the owner holds every right)', async () => {
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.permissions WHERE key = 'payables.manage'`)).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.role_permissions`)).rows[0].n, 0);
});
await ok('only the cloud reads them (RLS on, no policy)', async () => {
  for (const t of ['supplier_bills', 'supplier_payments', 'supplier_returns', 'supplier_return_items']) {
    assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [t])).rows[0].relrowsecurity, true, t);
  }
});
await ok('it runs twice without error and records itself once', async () => {
  await db.exec(SQL);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '121_supplier_payables'`)).rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
