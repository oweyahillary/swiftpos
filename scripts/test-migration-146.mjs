/**
 * test-migration-146.mjs — A520: roles named manager / supervisor / branch manager get shifts.close_day, shifts.force_close
 * and shifts.confirm back (before A490 their NAME let them close the day; 134 gave the key only through settings.manage),
 * run for real against the WHOLE schema (every migration replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the name list narrowed to 'manager' → "a Supervisor and a Branch_Manager get it" fails; the
 * guard removed → "an owner's later untick stays" fails.
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
const THIS = '146_manager_close_day.sql';
for (const f of files.filter((f) => num(f) < 146)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 146 (managers close the day) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa);
const R = { mgr: id(0xa1), sup: id(0xa2), bm: id(0xa3), cash: id(0xa4), kitchen: id(0xa5) };
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
for (const [rid, name] of [[R.mgr, 'Manager'], [R.sup, ' supervisor '], [R.bm, 'Branch_Manager'], [R.cash, 'Cashier'], [R.kitchen, 'Kitchen Lead']]) await put('roles', { id: rid, business_id: A, name });
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
await grant(R.mgr, ['orders.create', 'sales.void']);   // a Manager as 134 left it: no close_day
await grant(R.cash, ['orders.create']);
const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const before = { cash: await keysOf(R.cash), kitchen: await keysOf(R.kitchen) };
const KEYS = ['shifts.close_day', 'shifts.confirm', 'shifts.force_close'];

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('146 runs', async () => { await db.exec(sanitize(sql)); });
await ok('a Manager can close the day and the branch again — and keeps what it had', async () => {
  const k = await keysOf(R.mgr);
  for (const x of [...KEYS, 'orders.create', 'sales.void']) assert.ok(k.includes(x), x);
});
await ok('a Supervisor and a Branch_Manager get it too (case, spaces and underscores aside)', async () => {
  for (const rid of [R.sup, R.bm]) { const k = await keysOf(rid); for (const x of KEYS) assert.ok(k.includes(x), `${rid} ${x}`); }
});
await ok('other roles are not touched (Cashier, Kitchen Lead)', async () => {
  assert.deepEqual(await keysOf(R.cash), before.cash);
  assert.deepEqual(await keysOf(R.kitchen), before.kitchen);
});
await ok("146 runs twice, records itself once, and an owner's later untick stays", async () => {
  await db.query(`DELETE FROM public.role_permissions WHERE role_id = $1 AND permission_id = (SELECT id FROM public.permissions WHERE key = 'shifts.force_close')`, [R.mgr]);
  await db.exec(sanitize(sql));
  assert.ok(!(await keysOf(R.mgr)).includes('shifts.force_close'));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '146_manager_close_day'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
