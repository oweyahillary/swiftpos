/**
 * test-migration-142.mjs — A514: every business gets the built-in roles it does not have (Supervisor, Waiter, Kitchen,
 * Storekeeper, Accountant; Fuel attendant at a fuel business; Manager / Cashier where missing), with exactly the default
 * keys of packages/core/src/permissions.ts BUILT_IN_ROLES, nobody assigned, and never a change to a role of that name the business
 * already has — run for real against the WHOLE schema (every migration replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the NOT EXISTS name check dropped → the run fails on the unique name or "an existing
 * Supervisor is left alone" fails; the fuel condition dropped → "Fuel attendant only at a fuel business" fails; a key
 * added to / removed from a role in the SQL or in BUILT_IN_ROLES → "exactly the shared defaults" fails; the guard removed
 * → "a role the owner deleted is not brought back" fails.
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
const THIS = '142_built_in_roles.sql';
for (const f of files.filter((f) => num(f) < 142)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 142 (built-in roles) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), C = id(0xc);
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
await put('businesses', { id: B, name: 'Pump One', type: 'petrol_station' });
await put('businesses', { id: C, name: 'Corner Shop', type: 'retail' });
const R = { aOwner: id(0xa1), aMgr: id(0xa2), aCash: id(0xa3), aSup: id(0xa4), bOwner: id(0xb1), bMgr: id(0xb2), bCash: id(0xb3), cOwner: id(0xc1), cStore: id(0xc2) };
for (const [rid, biz, name] of [[R.aOwner, A, 'Admin'], [R.aMgr, A, 'Manager'], [R.aCash, A, 'cashier'], [R.aSup, A, ' supervisor '],
  [R.bOwner, B, 'owner'], [R.bMgr, B, 'manager'], [R.bCash, B, 'Cashier'], [R.cOwner, C, 'Admin'], [R.cStore, C, 'STOREKEEPER']]) {
  await put('roles', { id: rid, business_id: biz, name, description: name === ' supervisor ' ? 'our own' : null });
}
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
await grant(R.aSup, ['orders.create']);
await grant(R.aCash, ['orders.create', 'products.view']);
await grant(R.cStore, ['inventory.view']);
const U1 = id(0xa9);
await put('users', { id: U1, business_id: A, name: 'Wanjiru', role_id: R.aCash, status: 'active' });

const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const rolesOf = async (biz) => q(`SELECT id, name, description, is_default FROM public.roles WHERE business_id = $1 ORDER BY name`, [biz]);
const roleNamed = async (biz, name) => (await rolesOf(biz)).find((r) => r.name === name);
// A518: keys a LATER migration gives the built-in roles 142 made (142 is applied in production and is not changed) — 143
// gives the Accountant payables.view. 142 itself carries the shared defaults without them.
// A520: 147 gives the Manager shifts.close_branch (every role holding close_day, supervisors aside); 146 gives roles named
// supervisor shifts.close_day — the built-in Supervisor's defaults carry it since A520.
const LATER = { Accountant: ['payables.view'], Manager: ['shifts.close_branch'], Supervisor: ['shifts.close_day'] };
const keys142 = (r) => [...new Set(r.keys)].filter((k) => !(LATER[r.name] ?? []).includes(k));
// A550: the roles migration 159 adds later (General Manager, Operations Manager, …) are not 142's — 142 is compared with the
// built-in roles it made, in their order (scripts/test-migration-159.mjs compares the rest).
const LATER_ROLES = ['General Manager', 'Operations Manager', 'Finance Manager', 'Auditor', 'Kitchen Manager'];
const ROLES_142 = P.BUILT_IN_ROLES.filter((r) => !LATER_ROLES.includes(r.name));
const want = (name) => keys142(ROLES_142.find((r) => r.name === name)).sort();
const before = { aSup: await keysOf(R.aSup), aCash: await keysOf(R.aCash), cStore: await keysOf(R.cStore), aMgr: await keysOf(R.aMgr) };

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('the SQL carries exactly shared BUILT_IN_ROLES (names, descriptions, fuel-only, keys)', async () => {
  const built = [...sql.matchAll(/^\s+\('([^']+)', '([^']*)', (true|false)\)/gm)].map((m) => ({ name: m[1], description: m[2], fuel: m[3] === 'true' }));
  // A580: Waiter and Kitchen are now food-only in BUILT_IN_ROLES (restaurant / café) — 142 gave them to every business as it
  // ran; migration 169 takes the unused ones off shops. So "fuel-only" is the petrol-station typing, not any typing.
  const fuelOnly = (r) => !!r.types && r.types.includes('petrol_station');
  assert.deepEqual(built, ROLES_142.map((r) => ({ name: r.name, description: r.description, fuel: fuelOnly(r) })));
  for (const r of ROLES_142) if (r.types) assert.deepEqual([...r.types], fuelOnly(r) ? ['petrol_station'] : ['restaurant', 'cafe'], r.name);
  const pairs = [...sql.matchAll(/^\s+\('([^']+)', '([a-z_]+\.[a-z_]+)'\)/gm)].map((m) => `${m[1]}|${m[2]}`).sort();
  assert.deepEqual(pairs, ROLES_142.flatMap((r) => keys142(r).map((k) => `${r.name}|${k}`)).sort());
  for (const [name, ks] of Object.entries(LATER)) for (const k of ks) assert.ok(ROLES_142.find((r) => r.name === name).keys.includes(k), `${name}: ${k}`);
  for (const r of ROLES_142) for (const k of r.keys) assert.ok(P.isPermissionKey(k), `${r.name}: ${k}`);
});
await ok('142 runs', async () => { await db.exec(sanitize(sql)); });
await ok('a restaurant gets Waiter, Kitchen, Storekeeper and Accountant with exactly the shared defaults, is_default, nobody on them', async () => {
  for (const name of ['Waiter', 'Kitchen', 'Storekeeper', 'Accountant']) {
    const r = await roleNamed(A, name);
    assert.ok(r, name);
    assert.equal(r.is_default, true, name);
    assert.equal(r.description, P.BUILT_IN_ROLES.find((b) => b.name === name).description, name);
    assert.deepEqual(await keysOf(r.id), want(name), name);
    assert.equal((await one(`SELECT count(*)::int AS n FROM public.users WHERE role_id = $1`, [r.id])).n, 0, name);
  }
  assert.ok(!(await roleNamed(A, 'Fuel attendant')), 'no Fuel attendant at a restaurant');
});
await ok('the Waiter never has the staff list or customer credit; the Kitchen and the Accountant never sell', async () => {
  const w = await keysOf((await roleNamed(A, 'Waiter')).id);
  assert.ok(!w.includes('staff.view') && !w.includes('customers.credit') && !w.includes('sales.refund'));
  for (const name of ['Kitchen', 'Accountant', 'Storekeeper']) assert.ok(!(await keysOf((await roleNamed(A, name)).id)).includes('orders.create'), name);
});
await ok('an existing Supervisor (any case and spaces) is left alone — its keys, its description, no second one', async () => {
  const rows = (await rolesOf(A)).filter((r) => r.name.trim().toLowerCase() === 'supervisor');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'our own');
  assert.deepEqual(await keysOf(R.aSup), before.aSup);
  assert.deepEqual(await keysOf(R.aCash), before.aCash, 'the existing cashier role untouched');
  assert.deepEqual(await keysOf(R.aMgr), before.aMgr, 'the existing manager role untouched');
  assert.equal((await one(`SELECT role_id FROM public.users WHERE id = $1`, [U1])).role_id, R.aCash);
});
await ok('Fuel attendant only at a fuel business — with the shared defaults (plus every other built-in role it lacked)', async () => {
  const f = await roleNamed(B, 'Fuel attendant');
  assert.ok(f);
  assert.deepEqual(await keysOf(f.id), want('Fuel attendant'));
  for (const name of ['Supervisor', 'Waiter', 'Kitchen', 'Storekeeper', 'Accountant']) assert.ok(await roleNamed(B, name), name);
  assert.equal((await rolesOf(B)).filter((r) => r.name.toLowerCase() === 'manager').length, 1, 'its manager role not doubled');
  assert.ok(!(await roleNamed(C, 'Fuel attendant')));
});
await ok('a business missing Manager and Cashier gets them (catalogue defaults); its own STOREKEEPER is kept', async () => {
  assert.deepEqual(await keysOf((await roleNamed(C, 'Manager')).id), want('Manager'));
  assert.deepEqual(await keysOf((await roleNamed(C, 'Cashier')).id), want('Cashier'));
  assert.deepEqual(await keysOf(R.cStore), before.cStore);
  assert.equal((await rolesOf(C)).filter((r) => r.name.toLowerCase() === 'storekeeper').length, 1);
});
await ok('142 runs twice, records itself once, and a role the owner deleted is not brought back', async () => {
  const w = await roleNamed(A, 'Waiter');
  await db.query(`DELETE FROM public.role_permissions WHERE role_id = $1`, [w.id]);
  await db.query(`DELETE FROM public.roles WHERE id = $1`, [w.id]);
  await db.exec(sanitize(sql));
  assert.ok(!(await roleNamed(A, 'Waiter')));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '142_built_in_roles'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
