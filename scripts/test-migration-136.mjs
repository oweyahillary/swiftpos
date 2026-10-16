/**
 * test-migration-136.mjs — A494: users.permissions_version is bumped when a person's branches or status change, run for
 * real against the WHOLE schema (every migration replayed into PGlite, as test-migration-134.mjs).
 *
 * MUTATIONS TO CONFIRM BITE: the user_branches trigger dropped → "a branch added / removed bumps" fails; the status
 * trigger dropped → "deactivating bumps" fails; the IS DISTINCT FROM test removed → "an update that leaves the status
 * alone does not bump" fails.
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
const THIS = '136_branch_status_bump_pv.sql';
for (const f of files.filter((f) => num(f) < 136)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const pv = async (u) => Number((await one(`SELECT permissions_version FROM public.users WHERE id = $1`, [u])).permissions_version);

console.log('\nMigration 136 (branches and status bump permissions_version) — PGlite, every migration\n');

const B = id(0xb0), BR1 = id(0xb1), BR2 = id(0xb2), U = id(0xc1), OTHER = id(0xc2);
await put('businesses', { id: B, name: 'Pollo', type: 'restaurant' });
await put('branches', { id: BR1, business_id: B, name: 'Westlands' });
await put('branches', { id: BR2, business_id: B, name: 'Kilimani' });
await put('users', { id: U, business_id: B, name: 'Mary', email: 'mary@x.co', status: 'active', permissions_version: 1 });
await put('users', { id: OTHER, business_id: B, name: 'Joe', email: 'joe@x.co', status: 'active', permissions_version: 1 });

await ok('before 136: a branch added does not bump (the gap this closes)', async () => {
  await db.query(`INSERT INTO public.user_branches (user_id, branch_id) VALUES ($1, $2)`, [U, BR1]);
  assert.equal(await pv(U), 1);
});

await db.exec(sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8')));

await ok('a branch added bumps that person only', async () => {
  const a = await pv(U), o = await pv(OTHER);
  await db.query(`INSERT INTO public.user_branches (user_id, branch_id) VALUES ($1, $2)`, [U, BR2]);
  assert.equal(await pv(U), a + 1);
  assert.equal(await pv(OTHER), o);
});
await ok('a branch removed bumps', async () => {
  const a = await pv(U);
  await db.query(`DELETE FROM public.user_branches WHERE user_id = $1 AND branch_id = $2`, [U, BR1]);
  assert.equal(await pv(U), a + 1);
});
await ok('every branch removed at once bumps once per row', async () => {
  await db.query(`INSERT INTO public.user_branches (user_id, branch_id) VALUES ($1, $2)`, [U, BR1]);
  const a = await pv(U);
  await db.query(`DELETE FROM public.user_branches WHERE user_id = $1`, [U]);
  assert.equal(await pv(U), a + 2);
});
await ok('deactivating bumps; reactivating bumps', async () => {
  const a = await pv(U);
  await db.query(`UPDATE public.users SET status = 'inactive' WHERE id = $1`, [U]);
  assert.equal(await pv(U), a + 1);
  await db.query(`UPDATE public.users SET status = 'active' WHERE id = $1`, [U]);
  assert.equal(await pv(U), a + 2);
});
await ok('an update that leaves the status alone does not bump', async () => {
  const a = await pv(U);
  await db.query(`UPDATE public.users SET name = 'Mary W', status = 'active' WHERE id = $1`, [U]);
  assert.equal(await pv(U), a);
});
await ok('the role-change bump of migration 13 still works alongside', async () => {
  const R = id(0xd1);
  await put('roles', { id: R, business_id: B, name: 'Manager' });
  const a = await pv(U);
  await db.query(`UPDATE public.users SET role_id = $2 WHERE id = $1`, [U, R]);
  assert.equal(await pv(U), a + 1);
});
await ok('136 runs twice without error and records itself once', async () => {
  await db.exec(sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8')));
  const a = await pv(U);
  await db.query(`INSERT INTO public.user_branches (user_id, branch_id) VALUES ($1, $2)`, [U, BR1]);
  assert.equal(await pv(U), a + 1, 'one trigger, not two');
  const r = await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '136_branch_status_bump_pv'`);
  assert.equal(r.n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
