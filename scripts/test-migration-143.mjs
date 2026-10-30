/**
 * test-migration-143.mjs — A518: payables.view (read-only supplier bills) registered with the catalogue's words, and given
 * once to every role holding payables.manage, the built-in Accountant roles (is_default, any case and spaces) and the
 * owner roles — run for real against the WHOLE schema (every migration replayed into PGlite, 142 included).
 *
 * MUTATIONS TO CONFIRM BITE: the payables.manage condition dropped → "a role holding payables.manage" fails; is_default
 * dropped → "a hand-made Accountant is left alone" fails; the guard removed → "runs twice" fails (an owner's untick is
 * undone); the description changed → "the catalogue's words" fails.
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
const THIS = '143_payables_view.sql';
for (const f of files.filter((f) => num(f) < 143)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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




const { pathToFileURL } = await import('node:url');
const P = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);

console.log('\nMigration 143 (payables.view) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa);
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
const R = { owner: id(0xa1), mgr: id(0xa2), payer: id(0xa3), acct: id(0xa4), handAcct: id(0xa5), cash: id(0xa6) };
for (const [rid, name, isDefault] of [[R.owner, 'Admin', true], [R.mgr, 'Manager', true], [R.payer, 'Bookkeeper', false],
  [R.acct, ' ACCOUNTANT ', true], [R.handAcct, 'accountant_2', false], [R.cash, 'Cashier', true]]) {
  await put('roles', { id: rid, business_id: A, name, is_default: isDefault });
}
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
await grant(R.payer, ['payables.manage']);
await grant(R.acct, ['reports.overview']);
await grant(R.cash, ['orders.create']);
const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const has = async (rid) => (await keysOf(rid)).includes('payables.view');

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
const def = P.PERMISSIONS.find((p) => p.key === 'payables.view');
await ok('the catalogue has payables.view in the payables.manage group, and the SQL carries its words exactly', async () => {
  assert.ok(def, 'in the catalogue');
  assert.equal(def.group, P.PERMISSIONS.find((p) => p.key === 'payables.manage').group);
  assert.equal(def.label, 'See supplier bills');
  assert.equal(def.description, 'See supplier bills, payments and returns, without recording or paying them');
  const m = sql.match(/\('payables\.view', '([^']+)', '([a-z_]+)', '([^']+)'\)/);
  assert.ok(m, 'registration row');
  assert.equal(m[1], def.label); assert.equal(m[2], def.group); assert.equal(m[3], def.description);
  assert.ok(P.BUILT_IN_ROLES.find((r) => r.name === 'Accountant').keys.includes('payables.view'), 'the Accountant default');
  assert.ok(!P.BUILT_IN_ROLES.find((r) => r.name === 'Manager').keys.includes('payables.manage'), 'Manager has no payables.manage, so no payables.view');
});
await ok('143 runs', async () => { await db.exec(sanitize(sql)); });
await ok('registered with the catalogue words', async () => {
  const r = await one(`SELECT label, module, description FROM public.permissions WHERE key = 'payables.view'`);
  assert.deepEqual(r, { label: def.label, module: def.group, description: def.description });
});
await ok('a role holding payables.manage gets payables.view (nothing gained)', async () => { assert.ok(await has(R.payer)); });
await ok('the built-in Accountant (any case and spaces) and the owner role get it', async () => {
  assert.ok(await has(R.acct)); assert.ok(await has(R.owner));
});
await ok('a hand-made Accountant, the Manager and the Cashier are left alone', async () => {
  assert.ok(!(await has(R.handAcct))); assert.ok(!(await has(R.mgr))); assert.ok(!(await has(R.cash)));
  assert.deepEqual(await keysOf(R.cash), ['orders.create']);
});
await ok('143 runs twice, records itself once, and an owner untick is not undone', async () => {
  await db.query(`DELETE FROM public.role_permissions WHERE role_id = $1 AND permission_id = (SELECT id FROM public.permissions WHERE key = 'payables.view')`, [R.acct]);
  await db.exec(sanitize(sql));
  assert.ok(!(await has(R.acct)));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '143_payables_view'`)).n, 1);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.permissions WHERE key = 'payables.view'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
