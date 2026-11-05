/**
 * test-migration-189.mjs — Android Stage 0 (docs/ANDROID-APP-DESIGN.md): businesses.android_till_approved_version and
 * mobile_approved_version — per-business approval of the ZapTill Android app, one column per surface (NULL = hold, as
 * the desktop's migration 108). Run for real against the WHOLE schema (every migration before 189 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: drop either CHECK → "a value that is not x.y.z is refused" fails; give a column a DEFAULT
 * version → "every business starts HELD" fails; drop the schema_migrations insert → "recording itself" fails.
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
const THIS = '189_android_approved_versions.sql';
for (const f of files.filter((f) => num(f) < 189)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];

console.log('\nMigration 189 (Android app approvals) — PGlite, every migration\n');
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
await db.query(`INSERT INTO public.businesses (id, name, type) VALUES ($1, 'Sample Grill', 'restaurant'), ($2, 'Corner Shop', 'retail')`, [A, B]);
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
const COLS = ['android_till_approved_version', 'mobile_approved_version'];

await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });
await ok('every business starts HELD (NULL), and a new one too', async () => {
  await db.query(`INSERT INTO public.businesses (id, name, type) VALUES (gen_random_uuid(), 'New', 'restaurant')`);
  for (const c of COLS) assert.equal((await one(`SELECT count(*)::int AS n FROM public.businesses WHERE ${c} IS NOT NULL`)).n, 0, c);
});
await ok('each surface is approved on its own, and held again with NULL', async () => {
  await db.query(`UPDATE public.businesses SET android_till_approved_version = '0.1.0', mobile_approved_version = '0.2.0' WHERE id = $1`, [A]);
  const r = await one(`SELECT android_till_approved_version AS t, mobile_approved_version AS m FROM public.businesses WHERE id = $1`, [A]);
  assert.deepEqual([r.t, r.m], ['0.1.0', '0.2.0']);
  assert.equal((await one(`SELECT android_till_approved_version AS t FROM public.businesses WHERE id = $1`, [B])).t, null, 'another client stays held');
  await db.query(`UPDATE public.businesses SET mobile_approved_version = NULL WHERE id = $1`, [A]);
});
await ok('a value that is not x.y.z is refused, for either surface', async () => {
  for (const c of COLS) for (const bad of ['v0.1.0', 'latest', '0.1', '', '0.1.0-beta', '1.2.3.4']) {
    await assert.rejects(db.query(`UPDATE public.businesses SET ${c} = $2 WHERE id = $1`, [A, bad]), new RegExp(`${c}_format`), `${c} ${bad}`);
  }
});
await ok('a second run keeps an approval', async () => {
  await db.exec(sql);
  assert.equal((await one(`SELECT android_till_approved_version AS t FROM public.businesses WHERE id = $1`, [A])).t, '0.1.0');
});
await ok('recording itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '189_android_approved_versions'`)).n, 1);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
