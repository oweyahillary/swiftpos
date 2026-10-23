/**
 * test-migration-165.mjs — A578: menus by time of day (menus.availability), run for real against the WHOLE schema (every
 * migration before 165 replayed into PGlite, 155's menus and their sync trigger included).
 *
 * Owner, 2026-10-23 (approved): each menu may carry optional availability — days of the week and one or more time
 * windows (Breakfast Mon–Fri 06:00–11:00); no schedule = always available.
 *
 *   - 165 runs twice, recorded once; the menus columns match scripts/schema-index.json (availability included).
 *   - every existing menu is NULL = always (nothing changes for anyone until an owner sets hours).
 *   - the column takes an object or NULL; an array, a string or a number is refused (the CHECK).
 *   - the schedule the cloud stores (shared/menuHours.ts checkAvailability) round-trips as it was written.
 *   - sync: setting / changing / clearing the hours is ONE menus entry (155's trigger, topic menu, upsert) and moves the
 *     catalogue version; writing the same hours again writes nothing.
 *   - RLS on menus is unchanged (the owner policy, on).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A578 report):
 *   - the CHECK constraint removed                          → "an array, a string or a number is refused" fails
 *   - the column added with DEFAULT '{}'                    → "every existing menu is NULL" fails
 *   - availability left out of schema-index.json            → "the columns match" fails
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
const THIS = '165_menu_hours.sql';
for (const f of files.filter((f) => num(f) < 165)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const maxSeq = async () => Number((await one(`SELECT COALESCE(max(seq), 0) AS m FROM public.sync_changes`)).m);
const since = async (from) => (await q(`SELECT table_name, row_id, topic, op FROM public.sync_changes WHERE seq > $1 ORDER BY seq`, [from]))
  .map((r) => `${r.table_name}:${r.row_id}:${r.topic}:${r.op}`);
const ver = async (biz) => Number((await one(`SELECT version FROM public.sync_versions WHERE business_id = $1 AND topic = 'catalogue'`, [biz]))?.version ?? -1);
const H = await import(pathToFileURL(path.join(ROOT, 'shared', 'menuHours.ts')).href);

console.log('\nMigration 165 (menu hours) — PGlite, every migration\n');
const A = '00000000-0000-0000-0000-00000000000a';
{
  // the businesses row with whatever NOT NULL columns this schema has, filled
  const cols = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND is_nullable = 'NO' AND column_default IS NULL`);
  const row = { id: A, name: 'Test Grill', type: 'restaurant' };
  for (const c of cols) if (!(c.column_name in row)) row[c.column_name] = c.data_type === 'uuid' ? crypto.randomUUID() : c.data_type === 'boolean' ? false : /int|numeric/.test(c.data_type) ? 0 : `x-${crypto.randomUUID().slice(0, 8)}`;
  const k = Object.keys(row);
  await db.query(`INSERT INTO public.businesses (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => row[x]));
}
const BREAKFAST = (await one(`INSERT INTO public.menus (business_id, name, sort_order) VALUES ($1, 'Breakfast', 1) RETURNING id`, [A])).id;

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('165 runs (and again — idempotent), recorded once', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '165_menu_hours'`)).n), 1);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'menus_availability_object'`)).n), 1);
});
await ok('the menus columns match scripts/schema-index.json (availability included)', async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'menus'`)).map((r) => r.column_name).sort();
  assert.deepEqual(Object.keys(idx.menus).sort(), cols);
  assert.equal(idx.menus.availability, '"jsonb"');
});
await ok('every existing menu is NULL = always (nothing changes until an owner sets hours)', async () => {
  assert.equal((await one(`SELECT availability FROM public.menus WHERE id = $1`, [BREAKFAST])).availability, null);
  const m = await one(`INSERT INTO public.menus (business_id, name, sort_order) VALUES ($1, 'Lunch', 2) RETURNING availability`, [A]);
  assert.equal(m.availability, null);
});
await ok('an object or NULL; an array, a string or a number is refused', async () => {
  for (const bad of ['[1,2]', '"06:00"', '7']) {
    await assert.rejects(db.query(`UPDATE public.menus SET availability = $1::jsonb WHERE id = $2`, [bad, BREAKFAST]), /menus_availability_object|check/i, bad);
  }
  await db.query(`UPDATE public.menus SET availability = NULL WHERE id = $1`, [BREAKFAST]);
});
const sched = H.checkAvailability({ days: [5, 1, 2, 3, 4], windows: [{ start: '6:00', end: '11:00' }] });
await ok('the schedule the cloud stores (checkAvailability) round-trips as written', async () => {
  assert.equal(sched.ok, true);
  await db.query(`UPDATE public.menus SET availability = $1::jsonb WHERE id = $2`, [JSON.stringify(sched.value), BREAKFAST]);
  const back = (await one(`SELECT availability FROM public.menus WHERE id = $1`, [BREAKFAST])).availability;
  assert.deepEqual(back, { days: [1, 2, 3, 4, 5], windows: [{ start: '06:00', end: '11:00' }] });
  assert.deepEqual(H.readAvailability(back), back);
});
await ok('sync: new hours are ONE menus entry and move the catalogue version; the same hours again write nothing; clearing them is one entry', async () => {
  const hours = JSON.stringify({ days: null, windows: [{ start: '06:00', end: '10:30' }] });
  let s = await maxSeq(); const v = await ver(A);
  await db.query(`UPDATE public.menus SET availability = $1::jsonb WHERE id = $2`, [hours, BREAKFAST]);
  assert.deepEqual(await since(s), [`menus:${BREAKFAST}:menu:upsert`]);
  assert.ok(await ver(A) > v, 'catalogue version moved');
  s = await maxSeq();
  await db.query(`UPDATE public.menus SET availability = $1::jsonb WHERE id = $2`, [hours, BREAKFAST]);
  assert.deepEqual(await since(s), [], 'the same hours: nothing');
  s = await maxSeq();
  await db.query(`UPDATE public.menus SET availability = NULL WHERE id = $1`, [BREAKFAST]);
  assert.deepEqual(await since(s), [`menus:${BREAKFAST}:menu:upsert`]);
});
await ok('RLS on menus unchanged (on, the owner policy)', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.menus'::regclass`)).relrowsecurity, true);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'menus' AND policyname = 'owner can manage menus'`)).n), 1);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
