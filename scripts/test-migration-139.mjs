/**
 * test-migration-139.mjs — A510: roles that could sell before A490 get orders.create back (134 left them without it),
 * run for real against the WHOLE schema (every migration replayed into PGlite).
 *
 * Roles shaped like production (KRUNCH & CO / L MASTER): a Cashier made before 134 holding staff.view, reservations,
 * parking, fuel and the customers keys but not orders.create; a business that had the cashier_own_history switch; a
 * Manager that already sells; a role the owner made AFTER 134 without selling; the owner's role.
 *
 * MUTATIONS TO CONFIRM BITE: the created_at < 134 condition dropped → "a role made after 134 is not touched" fails; the
 * feature_flags NOT EXISTS dropped → "a business that limited cashiers keeps them limited" fails; the guard removed →
 * "runs twice" fails (permissions_version bumped twice).
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
const THIS = '139_restore_selling_rights.sql';
for (const f of files.filter((f) => num(f) < 139)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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


console.log('\nMigration 139 (selling rights back) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);
const R = { aCash: id(0xa1), aMgr: id(0xa2), aNew: id(0xa3), aOwner: id(0xa4), bCash: id(0xb1) };
const U_CASH = id(0xc1), U_MGR = id(0xc2);
await db.query(`UPDATE public.schema_migrations SET applied_at = '2026-10-15T07:33:49Z' WHERE version = '134_permission_catalogue'`);
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
await put('businesses', { id: B, name: 'L MASTER', type: 'restaurant' });
const role = (rid, biz, name, created) => put('roles', { id: rid, business_id: biz, name, created_at: created });
await role(R.aCash, A, 'cashier', '2026-09-01T10:00:00Z');
await role(R.aMgr, A, 'Manager', '2026-09-01T10:00:00Z');
await role(R.aNew, A, 'Kitchen', '2026-10-15T12:00:00Z');   // made by the owner after 134, no selling on purpose
await role(R.aOwner, A, 'Admin', '2026-09-01T10:00:00Z');
await role(R.bCash, B, 'cashier', '2026-09-01T10:00:00Z');
const PROD_CASHIER = ['customers.credit', 'customers.edit', 'customers.view', 'fuel.manage', 'inventory.view', 'parking.manage',
  'products.view', 'reservations.manage', 'staff.view'];
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
await grant(R.aCash, PROD_CASHIER); await grant(R.bCash, PROD_CASHIER);
await grant(R.aMgr, ['orders.create', 'sales.void']); await grant(R.aNew, ['products.view']);
await put('feature_flags', { business_id: B, key: 'cashier_own_history', enabled: false });   // B limited cashiers before 134
await put('users', { id: U_CASH, business_id: A, role_id: R.aCash, name: 'Test 1', permissions_version: 3 });
await put('users', { id: U_MGR, business_id: A, role_id: R.aMgr, name: 'Mo', permissions_version: 5 });
const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const before = { aMgr: await keysOf(R.aMgr), aNew: await keysOf(R.aNew), aOwner: await keysOf(R.aOwner) };

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('139 runs', async () => { await db.exec(sanitize(sql)); });
await ok('a cashier made before 134 can sell again, with discounts, every sale and cash in / out — and keeps what it had', async () => {
  const k = await keysOf(R.aCash);
  for (const x of ['orders.create', 'sales.discount', 'sales.history_all', 'shifts.cash_movements', ...PROD_CASHIER]) assert.ok(k.includes(x), x);
  assert.equal(k.length, PROD_CASHIER.length + 4);
});
await ok('a business that limited cashiers keeps them limited (own sales only) but they sell again', async () => {
  const k = await keysOf(R.bCash);
  assert.ok(k.includes('orders.create') && k.includes('sales.discount') && k.includes('shifts.cash_movements'));
  assert.ok(!k.includes('sales.history_all'));
});
await ok("a role that already sells, the owner's role, and a role made after 134 are not touched", async () => {
  assert.deepEqual(await keysOf(R.aMgr), before.aMgr);
  assert.deepEqual(await keysOf(R.aOwner), before.aOwner);
  assert.deepEqual(await keysOf(R.aNew), before.aNew);
});
await ok('the people in a repaired role renew into the new rights (permissions_version bumped); others not', async () => {
  assert.ok((await one(`SELECT permissions_version AS v FROM public.users WHERE id = $1`, [U_CASH])).v > 3);
  assert.equal((await one(`SELECT permissions_version AS v FROM public.users WHERE id = $1`, [U_MGR])).v, 5);
});
await ok('139 runs twice without error, records itself once, and the second run changes nothing', async () => {
  const k1 = await keysOf(R.aCash);
  const v1 = (await one(`SELECT permissions_version AS v FROM public.users WHERE id = $1`, [U_CASH])).v;
  await db.exec(sanitize(sql));
  assert.deepEqual(await keysOf(R.aCash), k1);
  assert.equal((await one(`SELECT permissions_version AS v FROM public.users WHERE id = $1`, [U_CASH])).v, v1);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '139_restore_selling_rights'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
