/**
 * test-migration-155.mjs — A537: menus (Food, Soft drinks, Alcohol, Tea …) and categories.menu_id, run for real against
 * the WHOLE schema (every migration before 155 replayed into PGlite, 150 and 151 included).
 *
 * Owner, 2026-10-20: "some restaurants have different menus — food menu, non-alcoholic drinks menu, alcoholic drinks
 * menu, tea menu etc, can we include such?" — plain menus, one menu per category.
 *
 *   - 155 runs twice, recorded once; the columns match scripts/schema-index.json; RLS on with the owner policy;
 *     log_menu_sync_change is not callable by anon / authenticated.
 *   - categories.menu_id: a category takes a menu; deleting the menu for real leaves the category with none (SET NULL).
 *   - a name is unique per business among the menus not deleted (another business, or a deleted one, may share it).
 *   - sync: a new menu writes ONE entry (menus, the menu, topic menu, upsert) and moves the catalogue version; a rename is
 *     one entry; an update that changes nothing writes nothing; a soft delete is an upsert (the cloud answers it as a
 *     delete); a real delete is a delete; one transaction writes a menu once; a category moved between menus is ONE
 *     categories entry.
 *   - the trigger never fails the write (sync_changes refusing the entry: the menu still saves).
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
 *   - ON DELETE SET NULL removed from menu_id                       → "deleting the menu leaves the category" fails
 *   - the coalescing flag removed                                   → "one transaction: once" fails
 *   - the updated_at-only check removed                             → "changes nothing writes nothing" fails
 *   - the catalogue-version trigger block removed                   → "moves the catalogue version" fails
 *   - RAISE instead of RAISE WARNING in the handler                 → "never fails the write" fails
 *   - the unique index without WHERE deleted_at IS NULL             → "a deleted one may share it" fails
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
const THIS = '155_menus.sql';
for (const f of files.filter((f) => num(f) < 155)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const fill = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : `x-${crypto.randomUUID().slice(0, 8)}`;
  }
  return full;
};
const put = async (table, row) => {
  const full = await fill(table, row);
  const k = Object.keys(full);
  return (await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => full[x]))).rows[0];
};
const maxSeq = async () => Number((await one(`SELECT COALESCE(max(seq), 0) AS m FROM public.sync_changes`)).m);
const since = async (from) => (await q(`SELECT table_name, row_id, topic, op, branch_id FROM public.sync_changes WHERE seq > $1 ORDER BY seq`, [from]))
  .map((r) => `${r.table_name}:${r.row_id}:${r.topic}:${r.op}${r.branch_id ? '@branch' : ''}`);
const ver = async (biz) => Number((await one(`SELECT version FROM public.sync_versions WHERE business_id = $1 AND topic = 'catalogue'`, [biz]))?.version ?? -1);

console.log('\nMigration 155 (menus) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), CAT = id(0xa4), CAT2 = id(0xa6);
await put('businesses', { id: A, name: 'Test Grill', type: 'restaurant' });
await put('businesses', { id: B, name: 'Other', type: 'restaurant' });
await put('categories', { id: CAT, business_id: A, name: 'Burgers' });
await put('categories', { id: CAT2, business_id: A, name: 'Sodas' });

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('155 runs (and again — idempotent), recorded once', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '155_menus'`)).n), 1);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_trigger WHERE tgrelid = 'public.menus'::regclass AND NOT tgisinternal`)).n), 3, 'updated_at, sync change, catalogue version');
});
await ok('the columns match scripts/schema-index.json (menus, categories.menu_id)', async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  assert.ok(idx.menus, 'menus missing from schema-index.json');
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'menus'`)).map((r) => r.column_name).sort();
  // A578: menus.availability is migration 165's (this test replays up to 155 only) — test-migration-165 checks it.
  const LATER = new Set(['availability']);
  assert.deepEqual(Object.keys(idx.menus).filter((c) => !LATER.has(c)).sort(), cols);
  assert.ok(idx.categories.menu_id, 'categories.menu_id missing from schema-index.json');
});
await ok('RLS on menus with the owner policy; log_menu_sync_change not callable by anon or authenticated', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.menus'::regclass`)).relrowsecurity, true);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'menus' AND policyname = 'owner can manage menus'`)).n), 1);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await one(`SELECT has_function_privilege($1, 'public.log_menu_sync_change()', 'EXECUTE') AS x`, [role])).x, false, role);
  }
});

let FOOD, DRINKS;
await ok('a new menu: ONE entry (menus, upsert, topic menu, every branch) and the catalogue version moves', async () => {
  const s = await maxSeq(); const v = await ver(A);
  FOOD = (await put('menus', { business_id: A, name: 'Food', sort_order: 1 })).id;
  assert.deepEqual(await since(s), [`menus:${FOOD}:menu:upsert`]);
  assert.ok(await ver(A) > v, 'catalogue version moved');
  DRINKS = (await put('menus', { business_id: A, name: 'Soft drinks', sort_order: 2 })).id;
});
await ok('a category moved into a menu: ONE categories entry (151), the menu itself writes nothing', async () => {
  const s = await maxSeq();
  await db.query(`UPDATE public.categories SET menu_id = $1 WHERE id = $2`, [FOOD, CAT]);
  assert.deepEqual(await since(s), [`categories:${CAT}:menu:upsert`]);
  const s2 = await maxSeq();
  await db.query(`UPDATE public.categories SET menu_id = $1 WHERE id = $2`, [DRINKS, CAT]);
  assert.deepEqual(await since(s2), [`categories:${CAT}:menu:upsert`], 'moved between menus');
  await db.query(`UPDATE public.categories SET menu_id = $1 WHERE id = $2`, [FOOD, CAT]);
});
await ok('a renamed menu: ONE entry; an update that changes nothing writes nothing', async () => {
  const s = await maxSeq();
  await db.query(`UPDATE public.menus SET name = 'Food menu' WHERE id = $1`, [FOOD]);
  assert.deepEqual(await since(s), [`menus:${FOOD}:menu:upsert`]);
  const s2 = await maxSeq();
  await db.query(`UPDATE public.menus SET name = 'Food menu' WHERE id = $1`, [FOOD]);
  assert.deepEqual(await since(s2), []);
});
await ok('one transaction: a menu changed three times is written once', async () => {
  const s = await maxSeq();
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE public.menus SET sort_order = 5 WHERE id = $1`, [DRINKS]);
    await tx.query(`UPDATE public.menus SET sort_order = 6 WHERE id = $1`, [DRINKS]);
    await tx.query(`UPDATE public.menus SET active = false WHERE id = $1`, [DRINKS]);
  });
  assert.deepEqual(await since(s), [`menus:${DRINKS}:menu:upsert`]);
});
await ok('a name is unique per business among menus not deleted (another business, or a deleted one, may share it)', async () => {
  await assert.rejects(() => put('menus', { business_id: A, name: ' food MENU ' }), /duplicate|unique/i);
  await put('menus', { business_id: B, name: 'Food menu' });
  const T = (await put('menus', { business_id: A, name: 'Tea' })).id;
  const s = await maxSeq();
  await db.query(`UPDATE public.menus SET deleted_at = now() WHERE id = $1`, [T]);
  assert.deepEqual(await since(s), [`menus:${T}:menu:upsert`], 'a soft delete is an upsert (the cloud answers a delete)');
  await put('menus', { business_id: A, name: 'Tea' });
});
await ok('deleting a menu for real: a delete entry, and its categories are left with none (ON DELETE SET NULL)', async () => {
  const S = (await put('menus', { business_id: A, name: 'Shisha' })).id;
  await db.query(`UPDATE public.categories SET menu_id = $1 WHERE id = $2`, [S, CAT2]);
  const s = await maxSeq();
  await db.query(`DELETE FROM public.menus WHERE id = $1`, [S]);
  const got = await since(s);
  assert.ok(got.includes(`menus:${S}:menu:delete`), got.join(', '));
  const c = await one(`SELECT menu_id, name FROM public.categories WHERE id = $1`, [CAT2]);
  assert.equal(c.menu_id, null); assert.equal(c.name, 'Sodas');
});
await ok('the trigger never fails the write (sync_changes refusing the entry: the menu still saves)', async () => {
  await db.exec(`ALTER TABLE public.sync_changes ADD CONSTRAINT no_menus_here CHECK (table_name <> 'menus') NOT VALID`);
  try {
    await put('menus', { business_id: A, name: 'Still saves' });
    assert.ok(await one(`SELECT id FROM public.menus WHERE name = 'Still saves'`));
  } finally { await db.exec(`ALTER TABLE public.sync_changes DROP CONSTRAINT no_menus_here`); }
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
