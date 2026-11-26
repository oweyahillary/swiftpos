/**
 * test-migration-199.mjs — A627, the "See a running total in History" right (sales.history_total) and the retirement of the
 * two "cashiers see sales" switches. Owner, 2026-11-26: "remove all sales toggle and add them as user rights". Run for real
 * against the WHOLE schema (every migration before 199 replayed into PGlite).
 *
 *   node --no-warnings scripts/test-migration-199.mjs
 *
 * Checks: the key is registered with the catalogue's words (selling group); granted to the owner roles and the built-in
 * seniors, never a Cashier/Waiter by default; the PRESERVE grants — shifts.see_shift_sales to every role of a business where
 * the close-shift switch was on (business- or branch-level), and sales.history_total where BOTH switches were on; a business
 * with the switch off gets neither; nothing taken away; idempotent; the catalogue agrees.
 *
 * MUTATIONS TO CONFIRM BITE: the preserve grant 3 dropped → "a cashier where the switch was on keeps sales" fails; the BOTH
 * condition on grant 4 relaxed → "history total needs both switches" fails; the schema_migrations guard removed → "an un-tick
 * stays" fails; sales.history_total off the Supervisor list → "the catalogue agrees" fails.
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
const THIS = '199_sales_history_total_permission.sql';
for (const f of files.filter((f) => num(f) < 199)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 199 (A627: the History-total right + retire the switches) — PGlite, every migration\n');
const CAT = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), C = id(0xc);
await put('businesses', { id: A, name: 'Sample Grill', type: 'restaurant' });   // both switches on (business level)
await put('businesses', { id: B, name: 'Sample Shop', type: 'retail' });        // no switches
await put('businesses', { id: C, name: 'Sample Cafe', type: 'cafe' });          // close-shift on via a branch only
const R = { aCash: id(0xa1), aSup: id(0xa2), aOwner: id(0xa3), bMgr: id(0xb1), bCustomSup: id(0xb2), bCash: id(0xb3), cCash: id(0xc1) };
const ROLES = [
  [R.aCash, A, 'Cashier', true], [R.aSup, A, 'Supervisor', true], [R.aOwner, A, 'Owner', false],
  [R.bMgr, B, 'Manager', true], [R.bCustomSup, B, 'Supervisor', false], [R.bCash, B, 'Cashier', true],
  [R.cCash, C, 'Cashier', true],
];
for (const [rid, biz, name, isDefault] of ROLES) await put('roles', { id: rid, business_id: biz, name, is_default: isDefault });
const CB = id(0xcb);
await put('branches', { id: CB, business_id: C, name: 'Hill', is_main: true, status: 'active' });
// A: both switches on (business); C: close-shift on via a branch; B: nothing.
for (const [biz, key, value] of [[A, 'cashier_sees_shift_sales', 'true'], [A, 'cashier_history_totals', 'true']])
  await put('business_settings', { business_id: biz, key, value });
await put('branch_settings', { business_id: C, branch_id: CB, key: 'cashier_sees_shift_sales', value: 'true' });

const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const before = Object.fromEntries(await Promise.all(Object.entries(R).map(async ([n, rid]) => [n, await keysOf(rid)])));
const TOTAL = 'sales.history_total', SEE = 'shifts.see_shift_sales';
const hasKey = async (rid, k) => (await keysOf(rid)).includes(k);

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('199 runs', async () => { await db.exec(sanitize(sql)); });
await ok('sales.history_total is registered with the catalogue\'s words (selling group)', async () => {
  const p = CAT.PERMISSIONS.find((x) => x.key === TOTAL);
  const row = await one(`SELECT label, module, description FROM public.permissions WHERE key = $1`, [TOTAL]);
  assert.deepEqual(row, { label: p.label, module: p.group, description: p.description });
});
await ok('sales.history_total: the owner roles and the built-in seniors get it; a Cashier does not by default', async () => {
  for (const r of [R.aOwner, R.aSup, R.bMgr]) assert.ok(await hasKey(r, TOTAL), r);   // owner + built-in Supervisor/Manager
  assert.ok(!(await hasKey(R.bCash, TOTAL)), 'B Cashier (no switch) does not get the History total');
  assert.ok(!(await hasKey(R.bCustomSup, TOTAL)), 'a custom-named Supervisor (not is_default, no switch) is left alone');
});
await ok('PRESERVE: shifts.see_shift_sales goes to EVERY role where the close-shift switch was on (business A, branch of C)', async () => {
  for (const r of [R.aCash, R.aSup, R.aOwner, R.cCash]) assert.ok(await hasKey(r, SEE), r);
  for (const r of [R.bMgr, R.bCash, R.bCustomSup]) assert.ok(!(await hasKey(r, SEE)), `${r} (B, switch off) must not get it`);
});
await ok('PRESERVE: sales.history_total goes to a role only where BOTH switches were on (A), not where only close-shift (C)', async () => {
  assert.ok(await hasKey(R.aCash, TOTAL), 'A Cashier: both switches on → gets the History total');
  assert.ok(!(await hasKey(R.cCash, TOTAL)), 'C Cashier: only close-shift on → no History total');
});
await ok('nothing is taken away', async () => {
  for (const [n, rid] of Object.entries(R)) {
    const now = (await keysOf(rid)).filter((k) => k !== TOTAL && k !== SEE);
    assert.deepEqual(now, before[n].filter((k) => k !== TOTAL && k !== SEE), n);
  }
});
await ok('199 runs twice, records itself once, and an owner\'s later un-tick stays', async () => {
  await db.query(`DELETE FROM public.role_permissions rp USING public.permissions p WHERE rp.permission_id = p.id AND p.key = $1 AND rp.role_id = $2`, [TOTAL, R.aCash]);
  await db.exec(sanitize(sql));
  assert.ok(!(await hasKey(R.aCash, TOTAL)), 'the un-tick stays');
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '199_sales_history_total_permission'`)).n, 1);
});
await ok('the catalogue agrees: the seniors hold sales.history_total, the Cashier/Waiter/Accountant do not; the owner everything', async () => {
  const role = (n) => new Set(CAT.BUILT_IN_ROLES.find((r) => r.name === n).keys);
  for (const n of ['Manager', 'General Manager', 'Supervisor', 'Operations Manager', 'Auditor']) assert.ok(role(n).has(TOTAL), n);
  for (const n of ['Cashier', 'Waiter', 'Accountant', 'Storekeeper']) assert.ok(!role(n).has(TOTAL), n);
  assert.ok(CAT.defaultKeysForRoleName('Owner').includes(TOTAL));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
