/**
 * test-migration-186.mjs — A618 (owner, 2026-11-01: "it should be per branch since different branches might have
 * different payment method some paybill some buy goods"): a branch's own M-Pesa STK push details. Run for real against
 * the WHOLE schema (every migration before 186 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: branch_id without ON DELETE CASCADE → "a branch deleted takes its row" fails; the type CHECK
 * dropped → "an unknown type … refused" fails; the REVOKE removed → "service role only" fails; branch_id not the primary
 * key → "one row per branch" fails.
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
const THIS = '186_branch_mpesa.sql';
for (const f of files.filter((f) => num(f) < 186)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 186 (M-Pesa STK push details per branch) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B1 = id(0xb1), B2 = id(0xb2), B3 = id(0xb3);
await put('businesses', { id: A, name: 'Sample Shop', type: 'retail' });
await put('branches', { id: B1, business_id: A, name: 'Main' });
await put('branches', { id: B2, business_id: A, name: 'Second' });
await put('branches', { id: B3, business_id: A, name: 'Third' });
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
const own = (branch, over = {}) => {
  const row = { branch_id: branch, business_id: A, type: 'CustomerBuyGoodsOnline', shortcode: '174379', till_number: '163726',
    consumer_key: 'ck-123456', consumer_secret: 'v1:a:b:c', passkey: 'v1:d:e:f', environment: 'sandbox', ...over };
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  const k = Object.keys(row);
  return db.query(`INSERT INTO public.branch_mpesa_settings (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => row[x]));
};

await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });
await ok('a branch\'s own Buy Goods details; a Paybill without a Till number; updated_at set, environment Live by default', async () => {
  await own(B1);
  await own(B2, { type: 'CustomerPayBillOnline', till_number: null, environment: undefined });
  const r = await one(`SELECT environment, updated_at FROM public.branch_mpesa_settings WHERE branch_id = $1`, [B2]);
  assert.equal(r.environment, 'production'); assert.ok(r.updated_at);
});
await ok('one row per branch', async () => {
  await assert.rejects(own(B1, { shortcode: '600000' }), (e) => /duplicate|unique|pkey/i.test(String(e.message)));
});
await ok('an unknown type, a shortcode or Till number not 5-8 digits, an unknown environment, an empty key and no business are refused', async () => {
  await assert.rejects(own(B3, { type: 'Paybill' }), /check/i);
  await assert.rejects(own(B3, { shortcode: '12a45' }), /check/i);
  await assert.rejects(own(B3, { shortcode: '1234' }), /check/i);
  await assert.rejects(own(B3, { till_number: '123456789' }), /check/i);
  await assert.rejects(own(B3, { environment: 'live' }), /check/i);
  await assert.rejects(own(B3, { consumer_key: '  ' }), /check/i);
  await assert.rejects(own(B3, { business_id: null }), /null/i);
});
await ok('a branch deleted takes its row (CASCADE); the others stay', async () => {
  await db.query(`DELETE FROM public.branches WHERE id = $1`, [B2]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.branch_mpesa_settings WHERE branch_id = $1`, [B2])).n, 0);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.branch_mpesa_settings WHERE branch_id = $1`, [B1])).n, 1);
});
await ok('a second run keeps the rows', async () => {
  await db.exec(sql);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.branch_mpesa_settings`)).n, 1);
});
await ok('service role only: RLS on, nothing granted to anon or authenticated', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.branch_mpesa_settings'::regclass`)).relrowsecurity, true);
  assert.equal((await one(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_name = 'branch_mpesa_settings' AND grantee IN ('anon', 'authenticated')`)).n, 0);
});
await ok('the business default stays in business_settings (no column added there)', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'business_settings' AND column_name = 'branch_id'`)).n, 0);
});
await ok('recording itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '186_branch_mpesa'`)).n, 1);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
