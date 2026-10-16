/**
 * test-migration-137.mjs — A495: branches.kds_version and bump_kds_version (a new kitchen-display token revokes the older
 * ones for its branch), run for real against the WHOLE schema (every migration replayed into PGlite).
 *
 * Every migration before 137 is replayed, branches exist the way they do in production, then 137 runs: every existing
 * branch starts at version 0 (a token minted before 137 names no version and reads as 0, so it keeps working); a bump
 * moves only that branch, only within its own business, and hands back the new number; 137 runs twice without error and
 * records itself once.
 *
 * MUTATIONS TO CONFIRM BITE: the business_id condition dropped from the UPDATE → "another business's branch is never
 * bumped" fails; DEFAULT 0 removed → "existing branches start at 0" fails; RETURNING dropped → "hands back the new
 * number" fails.
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
const THIS = '137_kds_token_version.sql';
for (const f of files.filter((f) => num(f) < 137)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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


console.log('\nMigration 137 (KDS token revocation) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), BR1 = id(0xa1), BR2 = id(0xa2), BRB = id(0xb1);
await put('businesses', { id: A, name: 'Pollo', type: 'restaurant' });
await put('businesses', { id: B, name: 'Other', type: 'restaurant' });
await put('branches', { id: BR1, business_id: A, name: 'Main' });
await put('branches', { id: BR2, business_id: A, name: 'Two' });
await put('branches', { id: BRB, business_id: B, name: 'Theirs' });

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('137 runs', async () => { await db.exec(sanitize(sql)); });
await ok('existing branches start at version 0 (a pre-137 token keeps working)', async () => {
  const rows = await q(`SELECT kds_version FROM public.branches`);
  assert.equal(rows.length, 3); assert.ok(rows.every((r) => r.kds_version === 0));
});
await ok('a bump moves only that branch and hands back the new number', async () => {
  assert.equal((await one(`SELECT public.bump_kds_version($1, $2) AS v`, [BR1, A])).v, 1);
  assert.equal((await one(`SELECT public.bump_kds_version($1, $2) AS v`, [BR1, A])).v, 2);
  assert.equal((await one(`SELECT kds_version FROM public.branches WHERE id = $1`, [BR2])).kds_version, 0);
});
await ok('another business\'s branch is never bumped (the business must match)', async () => {
  const r = await one(`SELECT public.bump_kds_version($1, $2) AS v`, [BRB, A]);
  assert.equal(r.v, null);
  assert.equal((await one(`SELECT kds_version FROM public.branches WHERE id = $1`, [BRB])).kds_version, 0);
});
await ok('a new branch starts at 0; the column is never null', async () => {
  await put('branches', { id: id(0xa3), business_id: A, name: 'Three' });
  assert.equal((await one(`SELECT kds_version FROM public.branches WHERE id = $1`, [id(0xa3)])).kds_version, 0);
  await assert.rejects(db.query(`UPDATE public.branches SET kds_version = NULL WHERE id = $1`, [BR1]));
});
await ok('137 runs twice without error, recorded once, versions kept', async () => {
  await db.exec(sanitize(sql));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '137_kds_token_version'`)).n, 1);
  assert.equal((await one(`SELECT kds_version FROM public.branches WHERE id = $1`, [BR1])).kds_version, 2);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
