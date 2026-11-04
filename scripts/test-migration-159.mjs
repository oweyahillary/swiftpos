/**
 * test-migration-159.mjs — A550: every business gets the built-in roles it does not have (General Manager, Operations
 * Manager, Finance Manager, Auditor, Kitchen Manager), with exactly the default keys of packages/core/src/permissions.ts
 * BUILT_IN_ROLES, nobody assigned, and never a change to a role of that name the business already has — run for real
 * against the WHOLE schema (every migration replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the NOT EXISTS name check dropped → the run fails on the unique name or "an existing General
 * Manager is left alone" fails; a key added to / removed from a role in the SQL or in BUILT_IN_ROLES → "exactly the shared
 * defaults" fails; the guard removed → "a role the owner deleted is not brought back" fails; a key with no permissions row
 * → "every key lands" fails.
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
const THIS = '159_partner_roles.sql';
for (const f of files.filter((f) => num(f) < 159)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
const NAMES = ['General Manager', 'Operations Manager', 'Finance Manager', 'Auditor', 'Kitchen Manager'];
// A594: keys a LATER migration registers and gives (175: shifts.cash_out, expenses.record — the General Manager gets them
// there, test-migration-175.mjs); 159 is applied in production and is not changed, so it is compared without them.
// A595: and the 36 narrower rights 176 registers and carries over (test-migration-176.mjs).
// A599: and the attendance rights 180 registers and gives (test-migration-180.mjs).
const LATER_KEYS = ['shifts.cash_out', 'expenses.record', ...Object.values(P.SPLITS).flat(), 'customers.credit_limit', 'attendance.view', 'attendance.edit', 'attendance.devices'];
const ROLES = NAMES.map((n) => P.BUILT_IN_ROLES.find((r) => r.name === n))
  .map((r) => r && ({ ...r, keys: r.keys.filter((k) => !LATER_KEYS.includes(k)) }));

console.log('\nMigration 159 (A550 built-in roles) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
await put('businesses', { id: B, name: 'Pump One', type: 'petrol_station' });
const R = { aOwner: id(0xa1), aGm: id(0xa2), aAcct: id(0xa3), bOwner: id(0xb1) };
for (const [rid, biz, name] of [[R.aOwner, A, 'Admin'], [R.aGm, A, ' general_manager '], [R.aAcct, A, 'Accountant'], [R.bOwner, B, 'owner']]) {
  await put('roles', { id: rid, business_id: biz, name, description: name === ' general_manager ' ? 'our own' : null });
}
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
await grant(R.aGm, ['orders.create']);
await grant(R.aAcct, ['reports.sales']);
const U1 = id(0xa9);
await put('users', { id: U1, business_id: A, name: 'Achieng', role_id: R.aGm, status: 'active' });

const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const rolesOf = async (biz) => q(`SELECT id, name, description, is_default FROM public.roles WHERE business_id = $1 ORDER BY name`, [biz]);
const roleNamed = async (biz, name) => (await rolesOf(biz)).find((r) => r.name === name);
const sorted = (a) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
const want = (name) => sorted(new Set(ROLES.find((r) => r.name === name).keys));
const before = { aGm: await keysOf(R.aGm), aAcct: await keysOf(R.aAcct) };

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('the SQL carries exactly the A550 roles of shared BUILT_IN_ROLES (names, descriptions, keys)', async () => {
  for (const r of ROLES) assert.ok(r, 'a role is missing from BUILT_IN_ROLES');
  const built = [...sql.matchAll(/^\s+\('([^']+)', '([^']*)', (true|false)\)/gm)].map((m) => ({ name: m[1], description: m[2], fuel: m[3] === 'true' }));
  // A580: Kitchen Manager is now food-only in BUILT_IN_ROLES (restaurant / café); 159 gave it to every business as it ran —
  // migration 169 takes the unused ones off shops. "fuel" is the petrol-station typing only.
  assert.deepEqual(built, ROLES.map((r) => ({ name: r.name, description: r.description, fuel: !!r.types && r.types.includes('petrol_station') })));
  const pairs = [...sql.matchAll(/^\s+\('([^']+)', '([a-z_]+\.[a-z_]+)'\)/gm)].map((m) => `${m[1]}|${m[2]}`).sort();
  assert.deepEqual(pairs, ROLES.flatMap((r) => [...new Set(r.keys)].map((k) => `${r.name}|${k}`)).sort());
  for (const r of ROLES) for (const k of r.keys) assert.ok(P.isPermissionKey(k), `${r.name}: ${k}`);
});
await ok('every key lands: each one is a registered permission (migration 134 registers the catalogue)', async () => {
  const have = new Set((await q('SELECT key FROM public.permissions')).map((r) => r.key));
  for (const r of ROLES) for (const k of r.keys) assert.ok(have.has(k), `${r.name}: ${k}`);
});
await ok('159 runs', async () => { await db.exec(sanitize(sql)); });
await ok('a business gets the A550 roles it lacks with exactly the shared defaults, is_default, nobody on them', async () => {
  for (const name of ['Operations Manager', 'Finance Manager', 'Auditor', 'Kitchen Manager']) {
    const r = await roleNamed(A, name);
    assert.ok(r, name);
    assert.equal(r.is_default, true, name);
    assert.equal(r.description, ROLES.find((b) => b.name === name).description, name);
    assert.deepEqual(await keysOf(r.id), want(name), name);
    assert.equal((await one(`SELECT count(*)::int AS n FROM public.users WHERE role_id = $1`, [r.id])).n, 0, name);
  }
  for (const name of NAMES) {
    const r = await roleNamed(B, name);
    assert.ok(r, `fuel business: ${name}`);
    assert.deepEqual(await keysOf(r.id), want(name), name);
  }
});
await ok('an existing General Manager (any case, spaces or underscores) is left alone — its keys, its description, its people, no second one', async () => {
  const rows = (await rolesOf(A)).filter((r) => r.name.trim().toLowerCase().replace(/[\s_]+/g, ' ') === 'general manager');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'our own');
  assert.deepEqual(await keysOf(R.aGm), before.aGm);
  assert.equal((await one(`SELECT role_id FROM public.users WHERE id = $1`, [U1])).role_id, R.aGm);
});
await ok('the Accountant (A514) and the owner\'s role are untouched', async () => {
  assert.deepEqual(await keysOf(R.aAcct), before.aAcct);
  assert.deepEqual(await keysOf(R.aOwner), []);
  assert.equal((await rolesOf(A)).filter((r) => r.name.toLowerCase() === 'accountant').length, 1);
});
await ok('the General Manager holds every catalogue key; the Auditor exactly the view keys', async () => {
  assert.deepEqual(await keysOf((await roleNamed(B, 'General Manager')).id), sorted(P.PERMISSION_KEYS.filter((k) => !LATER_KEYS.includes(k))));
  assert.deepEqual(await keysOf((await roleNamed(B, 'Auditor')).id), sorted(P.VIEW_KEYS.filter((k) => !LATER_KEYS.includes(k))));
});
await ok('159 runs twice, records itself once, and a role the owner deleted is not brought back', async () => {
  const w = await roleNamed(A, 'Auditor');
  await db.query(`DELETE FROM public.role_permissions WHERE role_id = $1`, [w.id]);
  await db.query(`DELETE FROM public.roles WHERE id = $1`, [w.id]);
  await db.exec(sanitize(sql));
  assert.ok(!(await roleNamed(A, 'Auditor')));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '159_partner_roles'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
