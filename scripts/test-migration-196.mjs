/**
 * test-migration-196.mjs — A626 Phase 2a (owner, 2026-11-25): a billing code per business (the Paybill account number).
 * Migration 196 adds businesses.billing_code (+ _norm, unique on the normalised form) and backfills a code for every
 * current business from its name, made unique by a numeric suffix on a clash. Run against the WHOLE schema in PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: drop the unique index → "two clients cannot share a normalised code" fails; drop the suffix
 * loop → "a name clash gets a distinct code" fails; drop the schema_migrations insert → "records itself" fails.
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
const THIS = '196_business_billing_code.sql';
for (const f of files.filter((f) => num(f) < 196)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), C = id(3);

// Two names that normalise to the same base, and an empty-ish name.
await put('businesses', { id: A, name: "Mama's Kitchen", type: 'restaurant', created_at: '2026-01-01T00:00:00Z' });
await put('businesses', { id: B, name: 'Mamas Kitchen', type: 'restaurant', created_at: '2026-01-02T00:00:00Z' });
await put('businesses', { id: C, name: '!!!', type: 'retail', created_at: '2026-01-03T00:00:00Z' });

console.log('\nMigration 196 (a billing code per business) — PGlite, every migration\n');

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });

await ok('every business gets a code and a matching normalised form', async () => {
  const rows = await q(`SELECT id, billing_code, billing_code_norm FROM public.businesses ORDER BY created_at`);
  for (const r of rows) {
    assert.ok(r.billing_code, `${r.id} has a code`);
    assert.equal(r.billing_code_norm, r.billing_code.toUpperCase().replace(/[^A-Z0-9]/g, ''), 'norm matches the code');
  }
});
await ok('a name clash gets a distinct code (Mama\'s Kitchen vs Mamas Kitchen)', async () => {
  const a = (await one(`SELECT billing_code_norm n FROM public.businesses WHERE id=$1`, [A])).n;
  const b = (await one(`SELECT billing_code_norm n FROM public.businesses WHERE id=$1`, [B])).n;
  assert.equal(a, 'MAMASK');
  assert.notEqual(a, b); assert.equal(b, 'MAMASK2');
});
await ok('an all-punctuation name falls back to a code', async () => {
  const c = (await one(`SELECT billing_code_norm n FROM public.businesses WHERE id=$1`, [C])).n;
  assert.match(c, /^BIZ/);
});
await ok('two clients cannot share a normalised code (the unique index)', async () => {
  assert.equal(await throws(`UPDATE public.businesses SET billing_code_norm='MAMASK' WHERE id=$1`, [B]), true);
});
await ok('records itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='196_business_billing_code'`)).n, 1);
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
