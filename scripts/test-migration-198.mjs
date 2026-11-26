/**
 * test-migration-198.mjs — A627, the "See own shift sales at close" right (shifts.see_shift_sales). Owner, 2026-11-26:
 * "can we make it a user right that the owner or the partner can give their team?" Run for real against the WHOLE schema
 * (every migration before 198 replayed into PGlite).
 *
 *   node --no-warnings scripts/test-migration-198.mjs
 *
 * Checks: the key is registered with the catalogue's words (drawer group); granted once to the owner roles and the BUILT-IN
 * Manager, General Manager, Supervisor, Operations Manager and Auditor (any spelling), never to a custom role so named, a
 * Cashier or a Waiter; nothing taken away; re-running records it once and leaves an owner's later un-tick alone; the
 * catalogue agrees for new businesses (the seniors hold it, the Cashier/Waiter do not).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — 2026-11-26):
 *   - the is_default condition dropped                 → "a custom role named Manager is left alone" fails
 *   - the schema_migrations guard removed              → "an owner's later un-tick stays" fails
 *   - 'supervisor' dropped from the names               → "the built-in seniors get it" fails
 *   - shifts.see_shift_sales off the Supervisor list    → "the catalogue agrees" fails
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
const THIS = '198_see_shift_sales_permission.sql';
for (const f of files.filter((f) => num(f) < 198)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 198 (A627: the shift-sales right, shifts.see_shift_sales) — PGlite, every migration\n');
const CAT = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);
await put('businesses', { id: A, name: 'Sample Grill', type: 'restaurant' });
await put('businesses', { id: B, name: 'Sample Shop', type: 'retail' });
const R = { mgr: id(0xa1), gm: id(0xa2), sup: id(0xa3), ops: id(0xa4), aud: id(0xa5), cash: id(0xa6), wait: id(0xa7), owner: id(0xa8), bMgr: id(0xb1), myMgr: id(0xb2) };
const ROLES = [
  [R.mgr, A, 'Manager', true, ['orders.create']],
  [R.gm, A, 'general_manager', true, ['settings.branches']],
  [R.sup, A, 'Supervisor', true, ['orders.create']],
  [R.ops, A, 'Operations Manager', true, ['menu.edit']],
  [R.aud, A, 'Auditor', true, ['reports.sales']],
  [R.cash, A, 'Cashier', true, ['orders.create']],
  [R.wait, A, 'Waiter', true, ['orders.create']],
  [R.owner, A, 'Owner', false, []],
  [R.bMgr, B, ' SUPERVISOR ', true, ['orders.create']],   // odd spelling, still built-in
  [R.myMgr, B, 'Supervisor', false, ['orders.create']],   // the owner's own role named Supervisor
];
for (const [rid, biz, name, isDefault] of ROLES) await put('roles', { id: rid, business_id: biz, name, is_default: isDefault });
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
for (const [rid, , , , keys] of ROLES) await grant(rid, keys);
const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const before = Object.fromEntries(await Promise.all(Object.entries(R).map(async ([n, rid]) => [n, await keysOf(rid)])));
const KEY = 'shifts.see_shift_sales';
const holds = async (rid) => (await keysOf(rid)).includes(KEY);

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('198 runs', async () => { await db.exec(sanitize(sql)); });
await ok('the key is registered with the catalogue\'s words (drawer group)', async () => {
  const p = CAT.PERMISSIONS.find((x) => x.key === KEY);
  const row = await one(`SELECT label, module, description FROM public.permissions WHERE key = $1`, [KEY]);
  assert.deepEqual(row, { label: p.label, module: p.group, description: p.description });
});
await ok('the owner roles and the built-in Manager, GM, Supervisor, Ops and Auditor (any spelling) get it', async () => {
  for (const r of [R.owner, R.mgr, R.gm, R.sup, R.ops, R.aud, R.bMgr]) assert.ok(await holds(r), r);
});
await ok('a custom role named Supervisor is left alone; a Cashier and a Waiter do not get it', async () => {
  for (const r of [R.myMgr, R.cash, R.wait]) assert.ok(!(await holds(r)), r);
});
await ok('nothing is taken away', async () => {
  for (const [n, rid] of Object.entries(R)) assert.deepEqual((await keysOf(rid)).filter((k) => k !== KEY), before[n], n);
});
await ok('198 runs twice, records itself once, and an owner\'s later un-tick stays', async () => {
  await db.query(`DELETE FROM public.role_permissions rp USING public.permissions p WHERE rp.permission_id = p.id AND p.key = $1 AND rp.role_id = $2`, [KEY, R.bMgr]);
  await db.exec(sanitize(sql));
  assert.ok(!(await holds(R.bMgr)), 'the un-tick stays');
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '198_see_shift_sales_permission'`)).n, 1);
});
await ok('the catalogue agrees for new businesses: the seniors hold it, the Cashier/Waiter/Accountant do not; the owner everything', async () => {
  const role = (n) => new Set(CAT.BUILT_IN_ROLES.find((r) => r.name === n).keys);
  for (const n of ['Manager', 'General Manager', 'Supervisor', 'Operations Manager', 'Auditor']) assert.ok(role(n).has(KEY), n);
  for (const n of ['Cashier', 'Waiter', 'Accountant', 'Storekeeper']) assert.ok(!role(n).has(KEY), n);
  assert.ok(CAT.defaultKeysForRoleName('Owner').includes(KEY));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
