/**
 * test-migration-188.mjs — A621 (owner, 2026-11-02): M-Pesa payment notifications (Safaricom C2B). A branch's settings
 * (branch_c2b_settings: on/off, the Buy Goods store number, the hash of its callback token, the registration) and the
 * payments Safaricom confirmed (mpesa_c2b_payments: once per M-Pesa code, received → held → used, never a full phone
 * number). Run for real against the WHOLE schema (every migration before 188 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the trans_id UNIQUE dropped → "one row per M-Pesa code" fails; the phone CHECK dropped →
 * "a full phone number is refused" fails; the held CHECK dropped → "held names who holds it" fails; ON DELETE SET NULL
 * on order_id changed to CASCADE → "an order deleted clears the link, the payment stays" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
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
const THIS = '188_mpesa_c2b.sql';
for (const f of files.filter((f) => num(f) < 188)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 188 (M-Pesa payment notifications) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B1 = id(0xb1), B2 = id(0xb2), O1 = id(0xd1);
await put('businesses', { id: A, name: 'Sample Grill', type: 'restaurant' });
await put('branches', { id: B1, business_id: A, name: 'Main' });
await put('branches', { id: B2, business_id: A, name: 'Second' });
await put('orders', { id: O1, business_id: A, branch_id: B1, order_number: 'T1-1', total: 1080, subtotal: 1080 });
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
const HASH = 'a'.repeat(64);
const insert = (table, row) => {
  const k = Object.keys(row);
  return db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => row[x]));
};
const payment = (over = {}) => insert('mpesa_c2b_payments', { business_id: A, branch_id: B1, shortcode: '174379', trans_id: 'QJK7XT3L5P', amount: 1080, ...over });

await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });
await ok('a branch\'s settings: off by default; the store number, the token hash and the registration kept', async () => {
  await insert('branch_c2b_settings', { branch_id: B1, business_id: A });
  assert.equal((await one(`SELECT enabled FROM public.branch_c2b_settings WHERE branch_id = $1`, [B1])).enabled, false);
  await db.query(`UPDATE public.branch_c2b_settings SET enabled = true, store_number = '600100', token_hash = $2, registered_at = now(),
    registered_shortcode = '174379', registered_environment = 'sandbox' WHERE branch_id = $1`, [B1, HASH]);
});
await ok('the settings refuse a bad store number, a token that is not a SHA-256, an unknown environment', async () => {
  await assert.rejects(db.query(`UPDATE public.branch_c2b_settings SET store_number = '12ab' WHERE branch_id = $1`, [B1]), /check/i);
  await assert.rejects(db.query(`UPDATE public.branch_c2b_settings SET token_hash = 'plain-token' WHERE branch_id = $1`, [B1]), /check/i);
  await assert.rejects(db.query(`UPDATE public.branch_c2b_settings SET registered_environment = 'live' WHERE branch_id = $1`, [B1]), /check/i);
});
await ok('one branch per token', async () => {
  await assert.rejects(insert('branch_c2b_settings', { branch_id: B2, business_id: A, token_hash: HASH }), /duplicate|unique/i);
});
await ok('a payment: received by default, its time of arrival set', async () => {
  await payment();
  const p = await one(`SELECT status, created_at FROM public.mpesa_c2b_payments WHERE trans_id = 'QJK7XT3L5P'`);
  assert.equal(p.status, 'received'); assert.ok(p.created_at);
});
await ok('one row per M-Pesa code (Safaricom\'s retries are one payment)', async () => {
  await assert.rejects(payment(), /duplicate|unique/i);
});
await ok('a full phone number is refused; a masked one is kept', async () => {
  await assert.rejects(payment({ trans_id: 'PHONE00001', phone_masked: '254712345149' }), /check/i);
  await assert.rejects(payment({ trans_id: 'PHONE00002', phone_masked: '0712345149' }), /check/i);
  await payment({ trans_id: 'PHONE00003', phone_masked: '071****149' });
});
await ok('an amount of 0 or less, an unknown status are refused', async () => {
  await assert.rejects(payment({ trans_id: 'AMT0000001', amount: 0 }), /check/i);
  await assert.rejects(payment({ trans_id: 'STA0000001', status: 'paid' }), /check/i);
});
await ok('held names who holds it and since when', async () => {
  await assert.rejects(db.query(`UPDATE public.mpesa_c2b_payments SET status = 'held' WHERE trans_id = 'QJK7XT3L5P'`), /check/i);
  await db.query(`UPDATE public.mpesa_c2b_payments SET status = 'held', held_by = 'device:T1', held_ref = 'PAY-1', held_at = now() WHERE trans_id = 'QJK7XT3L5P'`);
});
await ok('the claim is one UPDATE … WHERE status = \'received\': a second POS changes nothing', async () => {
  const r = await db.query(`UPDATE public.mpesa_c2b_payments SET status = 'held', held_by = 'device:T2', held_at = now()
    WHERE trans_id = 'QJK7XT3L5P' AND status = 'received' RETURNING trans_id`);
  assert.equal(r.rows.length, 0);
  assert.equal((await one(`SELECT held_by FROM public.mpesa_c2b_payments WHERE trans_id = 'QJK7XT3L5P'`)).held_by, 'device:T1');
});
await ok('used with its order; an order deleted clears the link, the payment stays', async () => {
  await db.query(`UPDATE public.mpesa_c2b_payments SET status = 'used', order_id = $1, used_at = now() WHERE trans_id = 'QJK7XT3L5P'`, [O1]);
  await db.query(`DELETE FROM public.orders WHERE id = $1`, [O1]);
  const p = await one(`SELECT status, order_id FROM public.mpesa_c2b_payments WHERE trans_id = 'QJK7XT3L5P'`);
  assert.equal(p.status, 'used'); assert.equal(p.order_id, null);
});
await ok('a branch deleted takes its settings and its payments (CASCADE)', async () => {
  await insert('branch_c2b_settings', { branch_id: B2, business_id: A });
  await payment({ trans_id: 'BR2PAY0001', branch_id: B2 });
  await db.query(`DELETE FROM public.branches WHERE id = $1`, [B2]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.branch_c2b_settings WHERE branch_id = $1`, [B2])).n, 0);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.mpesa_c2b_payments WHERE branch_id = $1`, [B2])).n, 0);
});
await ok('a second run keeps the rows', async () => {
  await db.exec(sql);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.mpesa_c2b_payments`)).n, 2);
});
await ok('the POS list\'s index: branch, status, newest first', async () => {
  const ix = await one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'mpesa_c2b_payments_branch_status'`);
  assert.match(ix.indexdef, /\(branch_id, status, created_at DESC\)/);
});
await ok('service role only: RLS on, nothing granted to anon or authenticated', async () => {
  for (const t of ['branch_c2b_settings', 'mpesa_c2b_payments']) {
    assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`])).relrowsecurity, true, t);
    assert.equal((await one(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee IN ('anon', 'authenticated')`, [t])).n, 0, t);
  }
});
await ok('recording itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '188_mpesa_c2b'`)).n, 1);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
