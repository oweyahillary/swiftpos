/**
 * test-migration-183.mjs — A614 (owner, 2026-10-30): one attendance device per branch. A unique index over the devices not
 * removed; the migration stops (nothing changed) when a branch already has two. Run for real against the WHOLE schema
 * (every migration before 183 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the index's WHERE removed_at IS NULL dropped → "a removed device does not count" fails; the
 * duplicate check removed → "stops when a branch already has two" fails (the index error instead of the named branches).
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
const THIS = '183_one_attendance_device.sql';
for (const f of files.filter((f) => num(f) < 183)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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


console.log('\nMigration 183 (one attendance device per branch) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B1 = id(0xb1), B2 = id(0xb2);
await put('businesses', { id: A, name: 'Sample Shop', type: 'retail' });
await put('branches', { id: B1, business_id: A, name: 'Main' });
await put('branches', { id: B2, business_id: A, name: 'Second' });
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
const dev = (branch, name, removed = null) => db.query(`INSERT INTO public.attendance_devices (business_id, branch_id, name, ip, removed_at) VALUES ($1, $2, $3, '192.168.1.201', $4)`, [A, branch, name, removed]);

await ok('stops when a branch already has two active devices — the branch named, nothing changed', async () => {
  await dev(B1, 'Front'); await dev(B1, 'Back');
  await assert.rejects(db.exec(sql), /more than one attendance device/);
  assert.equal((await one(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'attendance_devices_one_per_branch'`)).n, 0);
  await db.query(`UPDATE public.attendance_devices SET removed_at = now() WHERE name = 'Back'`);
});
await ok('runs, and again (idempotent) once each branch has one', async () => { await db.exec(sql); await db.exec(sql); });
await ok('a second active device on a branch is refused (23505)', async () => {
  await assert.rejects(dev(B1, 'Another'), (e) => /duplicate|unique/i.test(String(e.message)));
});
await ok('a removed device does not count: the branch can have its one active device beside removed ones', async () => {
  await db.query(`UPDATE public.attendance_devices SET removed_at = now() WHERE name = 'Front'`);
  await dev(B1, 'Replacement');
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.attendance_devices WHERE branch_id = $1 AND removed_at IS NULL`, [B1])).n, 1);
});
await ok('another branch has its own one', async () => { await dev(B2, 'Second door'); });
await ok('recording itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '183_one_attendance_device'`)).n, 1);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
