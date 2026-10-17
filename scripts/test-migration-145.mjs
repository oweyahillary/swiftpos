/**
 * test-migration-145.mjs — A519: support_logs (a till's redacted 24-hour log sent to support), run for real against the
 * WHOLE schema (every migration before 145 replayed into PGlite).
 *
 * 145 creates the table with its reference unique, the business cascade, RLS on with no policy (only the cloud's service
 * role reads it), and runs twice without error, recording itself once.
 *
 * MUTATIONS TO CONFIRM BITE: the unique index on reference dropped → "a reference is unique" fails; ENABLE ROW LEVEL
 * SECURITY dropped → "RLS on, no policy" fails; ON DELETE CASCADE dropped → "a deleted business takes its logs" fails.
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
const THIS = '145_support_logs.sql';
for (const f of files.filter((f) => num(f) < 145)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 145 (support logs) — PGlite, every migration\n');
const sql145 = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('145 runs (and again — idempotent), recorded once', async () => {
  await db.exec(sql145); await db.exec(sql145);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '145_support_logs'`)).n), 1);
});
const B = crypto.randomUUID();
await put('businesses', { id: B, name: 'Pollo', type: 'restaurant' });
await ok('a log is stored with its defaults (id, created_at, bytes 0, trimmed false)', async () => {
  await db.query(`INSERT INTO public.support_logs (business_id, device_id, reference, log_gz_b64) VALUES ($1, 'dev-1', 'K7Q2XM', 'H4sI')`, [B]);
  const r = await one(`SELECT id, created_at, bytes, trimmed FROM public.support_logs WHERE reference = 'K7Q2XM'`);
  assert.ok(r.id && r.created_at); assert.equal(r.bytes, 0); assert.equal(r.trimmed, false);
});
await ok('a reference is unique', async () => {
  await assert.rejects(db.query(`INSERT INTO public.support_logs (business_id, device_id, reference, log_gz_b64) VALUES ($1, 'dev-2', 'K7Q2XM', 'x')`, [B]));
});
await ok('the log text and the device are required', async () => {
  await assert.rejects(db.query(`INSERT INTO public.support_logs (business_id, device_id, reference) VALUES ($1, 'd', 'AAAAAA')`, [B]));
  await assert.rejects(db.query(`INSERT INTO public.support_logs (business_id, reference, log_gz_b64) VALUES ($1, 'BBBBBB', 'x')`, [B]));
});
await ok('RLS on, no policy (only the service role reads it)', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.support_logs'::regclass`)).relrowsecurity, true);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'support_logs'`)).n), 0);
});
await ok('the list and the rate-limit indexes exist', async () => {
  const names = (await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'support_logs'`)).map((r) => r.indexname);
  for (const n of ['support_logs_reference_unique', 'support_logs_business_created', 'support_logs_device_created']) assert.ok(names.includes(n), names.join(','));
});
await ok('a deleted business takes its logs (ON DELETE CASCADE)', async () => {
  const fk = await one(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.support_logs'::regclass AND contype = 'f'`);
  assert.equal(fk.confdeltype, 'c');
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
