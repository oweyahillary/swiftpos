/**
 * test-migration-181.mjs — A607 (owner, 2026-10-28): customer details at the counter. orders.buyer_kra_pin — the sale's
 * buyer KRA PIN (A or P, 9 digits, a letter; NULL = none) — and mpesa_stk_requests, the desktop POS's M-Pesa prompts.
 * Idempotent. Run for real against the WHOLE schema (every migration before 181 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the buyer PIN CHECK dropped → "only a KRA PIN" fails; the IF NOT EXISTS guard on the
 * constraint dropped → "runs, and again" fails; the amount CHECK dropped → "1 to 250,000" fails; the schema_migrations insert
 * dropped → "recording itself" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const num = (f) => +f.split('_')[0];
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql') && Number.isFinite(num(f))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
const BS = String.fromCharCode(92);
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith(BS) || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
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
const THIS = '181_customer_details.sql';
for (const f of files.filter((f) => num(f) < 181)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const put = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : 'x';
  }
  const k = Object.keys(full);
  await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => full[x]));
};


console.log('\nMigration 181 (customer details: orders.buyer_kra_pin, mpesa_stk_requests) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), BR = id(0xb), O1 = id(0x1), O2 = id(0x2);
await put('businesses', { id: A, name: 'Sample Shop', type: 'retail' });
await put('branches', { id: BR, business_id: A, name: 'Main' });
await put('orders', { id: O1, business_id: A, branch_id: BR, order_number: 'T1-0001' });
const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('181 runs, and again (idempotent), recording itself once', async () => {
  await db.exec(sanitize(sql)); await db.exec(sanitize(sql));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '181_customer_details'`)).n, 1);
});
await ok('an existing order keeps everything; its buyer PIN starts NULL (none)', async () => {
  const r = await one(`SELECT order_number, buyer_kra_pin FROM public.orders WHERE id = $1`, [O1]);
  assert.deepEqual([r.order_number, r.buyer_kra_pin], ['T1-0001', null]);
});
await ok('a KRA PIN is stored — A (a person) and P (a company)', async () => {
  for (const pin of ['A123456789Z', 'P051234567X']) {
    await db.query(`UPDATE public.orders SET buyer_kra_pin = $2 WHERE id = $1`, [O1, pin]);
    assert.equal((await one(`SELECT buyer_kra_pin FROM public.orders WHERE id = $1`, [O1])).buyer_kra_pin, pin);
  }
  await put('orders', { id: O2, business_id: A, branch_id: BR, order_number: 'T1-0002', buyer_kra_pin: 'A000000001B' });
});
await ok('only a KRA PIN or NULL — lower case, another first letter, 8 or 10 digits, spaces or junk refused', async () => {
  for (const bad of ['a123456789z', 'B123456789Z', 'A12345678Z', 'A1234567890Z', 'A123456789', 'A 123456789Z', '123456789', 'x']) {
    await assert.rejects(db.query(`UPDATE public.orders SET buyer_kra_pin = $2 WHERE id = $1`, [O1, bad]), undefined, bad);
  }
  await db.query(`UPDATE public.orders SET buyer_kra_pin = NULL WHERE id = $1`, [O1]);
});
await ok('a desktop POS prompt is kept: pending, its checkout id unique', async () => {
  await db.query(`INSERT INTO public.mpesa_stk_requests (business_id, branch_id, device_id, client_ref, amount, mpesa_phone, mpesa_checkout_id)
    VALUES ($1, $2, 'dev-1', 'T1-0003', 450, '254712345678', 'ws_CO_1')`, [A, BR]);
  const r = await one(`SELECT status, amount::float AS amount, mpesa_requested_at IS NOT NULL AS stamped FROM public.mpesa_stk_requests WHERE mpesa_checkout_id = 'ws_CO_1'`);
  assert.deepEqual([r.status, r.amount, r.stamped], ['pending', 450, true]);
  await assert.rejects(db.query(`INSERT INTO public.mpesa_stk_requests (business_id, client_ref, amount, mpesa_phone, mpesa_checkout_id)
    VALUES ($1, 'x', 10, '254712345678', 'ws_CO_1')`, [A]), undefined, 'a second row with the same checkout id');
});
await ok('a prompt is 1 to 250,000 shillings, to a Kenyan 2547/2541 number, with a known status', async () => {
  const add = (amount, phone, status = 'pending') => db.query(`INSERT INTO public.mpesa_stk_requests (business_id, client_ref, amount, mpesa_phone, status)
    VALUES ($1, 'r', $2, $3, $4)`, [A, amount, phone, status]);
  await add(1, '254112345678'); await add(250000, '254712345678');
  await assert.rejects(add(0.5, '254712345678'), undefined, 'below 1');
  await assert.rejects(add(250001, '254712345678'), undefined, 'over 250,000');
  for (const p of ['0712345678', '+254712345678', '254812345678', '25471234567']) await assert.rejects(add(10, p), undefined, p);
  await assert.rejects(add(10, '254712345678', 'paid'), undefined, 'status paid');
});
await ok('only the service role: RLS on, no policy', async () => {
  const r = await one(`SELECT relrowsecurity FROM pg_class WHERE relname = 'mpesa_stk_requests'`);
  assert.equal(r.relrowsecurity, true);
  assert.equal((await one(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'mpesa_stk_requests'`)).n, 0);
});
await ok('the business going takes its prompts with it', async () => {
  await db.query(`DELETE FROM public.orders WHERE business_id = $1`, [A]);
  await db.query(`DELETE FROM public.branches WHERE business_id = $1`, [A]);
  await db.query(`DELETE FROM public.businesses WHERE id = $1`, [A]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.mpesa_stk_requests`)).n, 0);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
