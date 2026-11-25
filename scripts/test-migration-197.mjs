/**
 * test-migration-197.mjs — A626 Phase 2b (owner, 2026-11-25): the cloud credit wallet. Migration 197 adds
 * business_cloud_credit (a balance per client, never negative) and cloud_credit_entries (the ledger). Run against the
 * WHOLE schema in PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: drop the balance>=0 CHECK → "a negative balance is refused" fails; drop the PK → "one wallet
 * per client" fails; drop the schema_migrations insert → "records itself" fails.
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
const THIS = '197_cloud_credit_wallet.sql';
for (const f of files.filter((f) => num(f) < 197)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const throws = async (s, p = []) => { try { await db.query(s, p); return false; } catch { return true; } };
const colsOf = new Map();
const put = async (table, rowData) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]));
  const full = { ...rowData };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : 'x';
  }
  const k = Object.keys(full);
  await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => full[x]));
};
const B = '00000000-0000-0000-0000-0000000000a1';
await put('businesses', { id: B, name: 'Acme Co', type: 'retail', created_at: '2026-01-01T00:00:00Z' });

console.log('\nMigration 197 (the cloud credit wallet) — PGlite, every migration\n');

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });

await ok('a wallet starts at 0, one per client (primary key)', async () => {
  await db.query(`INSERT INTO public.business_cloud_credit (business_id) VALUES ($1)`, [B]);
  assert.equal(Number((await one(`SELECT balance FROM public.business_cloud_credit WHERE business_id=$1`, [B])).balance), 0);
  assert.equal(await throws(`INSERT INTO public.business_cloud_credit (business_id) VALUES ($1)`, [B]), true, 'one wallet per client');
});
await ok('a negative balance is refused', async () => {
  assert.equal(await throws(`UPDATE public.business_cloud_credit SET balance = -1 WHERE business_id=$1`, [B]), true);
  await db.query(`UPDATE public.business_cloud_credit SET balance = 2500 WHERE business_id=$1`, [B]);
});
await ok('the ledger records entries (a payment in, a settlement out)', async () => {
  await db.query(`INSERT INTO public.cloud_credit_entries (business_id, delta, reason) VALUES ($1, 10000, 'M-Pesa QJK7XT3L5P'), ($1, -7500, 'Paid INV-2026-0001')`, [B]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.cloud_credit_entries WHERE business_id=$1`, [B])).n, 2);
});
await ok('both tables have RLS enabled', async () => {
  const r = await q(`SELECT relname FROM pg_class WHERE relname IN ('business_cloud_credit','cloud_credit_entries') AND relrowsecurity=true`);
  assert.equal(r.length, 2);
});
await ok('records itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='197_cloud_credit_wallet'`)).n, 1);
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
