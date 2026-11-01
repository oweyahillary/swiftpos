/**
 * test-migration-184.mjs — A616 (owner, 2026-10-31): attendance shifts per branch, and a shift pinned to a person. Run for
 * real against the WHOLE schema (every migration before 184 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the partial unique index without WHERE active → "an ended shift's name can be used again"
 * fails; shift_id without ON DELETE SET NULL → "a shift deleted unpins its people" fails; the start CHECK dropped → "a
 * start outside the day is refused" fails.
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
const THIS = '184_attendance_shifts.sql';
for (const f of files.filter((f) => num(f) < 184)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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



console.log('\nMigration 184 (attendance shifts) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B1 = id(0xb1), B2 = id(0xb2), P1 = id(0xc1);
await put('businesses', { id: A, name: 'Sample Shop', type: 'retail' });
await put('branches', { id: B1, business_id: A, name: 'Main' });
await put('branches', { id: B2, business_id: A, name: 'Second' });
await db.query(`INSERT INTO public.attendance_people (id, business_id, branch_id, name, attendance_no) VALUES ($1, $2, $3, 'Guard', 7)`, [P1, A, B1]);
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
const shift = (branch, name, start, end, extra = '') => db.query(
  `INSERT INTO public.attendance_shifts (business_id, branch_id, name, start_min, end_min${extra ? ', grace_min' : ''}) VALUES ($1, $2, $3, $4, $5${extra ? ', ' + extra : ''}) RETURNING id`,
  [A, branch, name, start, end]);

await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });
await ok('a shift: grace 10 by default, active; one past midnight (17:00 → 00:00) is fine', async () => {
  const r = (await shift(B1, 'Morning', 540, 1020)).rows[0];
  const row = await one(`SELECT grace_min, active FROM public.attendance_shifts WHERE id = $1`, [r.id]);
  assert.equal(row.grace_min, 10); assert.equal(row.active, true);
  await shift(B1, 'Evening', 1020, 0);
});
await ok('a start outside the day, a grace over 120 and an empty name are refused', async () => {
  await assert.rejects(shift(B1, 'Bad', 1440, 60), /check/i);
  await assert.rejects(shift(B1, 'Bad', 60, 120, '121'), /check/i);
  await assert.rejects(shift(B1, '  ', 60, 120), /check/i);
});
await ok('one active shift of a name per branch (any case); another branch may use the name', async () => {
  await assert.rejects(shift(B1, ' morning', 600, 1080), (e) => /duplicate|unique/i.test(String(e.message)));
  await shift(B2, 'Morning', 540, 1020);
});
await ok('an ended shift\'s name can be used again', async () => {
  await db.query(`UPDATE public.attendance_shifts SET active = false WHERE branch_id = $1 AND name = 'Evening'`, [B1]);
  await shift(B1, 'Evening', 1050, 30);
});
await ok('a person pinned to a shift; a shift deleted unpins its people (SET NULL)', async () => {
  const s = (await shift(B1, 'Night', 1080, 360)).rows[0].id;
  await db.query(`UPDATE public.attendance_people SET shift_id = $1 WHERE id = $2`, [s, P1]);
  assert.equal((await one(`SELECT shift_id FROM public.attendance_people WHERE id = $1`, [P1])).shift_id, s);
  await db.query(`DELETE FROM public.attendance_shifts WHERE id = $1`, [s]);
  assert.equal((await one(`SELECT shift_id FROM public.attendance_people WHERE id = $1`, [P1])).shift_id, null);
});
await ok('service role only: RLS on, nothing granted to anon or authenticated', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.attendance_shifts'::regclass`)).relrowsecurity, true);
  assert.equal((await one(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_name = 'attendance_shifts' AND grantee IN ('anon', 'authenticated')`)).n, 0);
});
await ok('recording itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '184_attendance_shifts'`)).n, 1);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
