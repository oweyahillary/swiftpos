/**
 * test-migration-147.mjs — A520 (owner, 2026-10-17: "break close day and close branch as two, supervisor can have close
 * day but not branch, a manager can both"): shifts.close_branch registered with the catalogue's words, given once to every
 * role holding shifts.close_day except supervisors, and to the owner roles; shifts.close_day relabelled. Run for real
 * against the WHOLE schema (every migration replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the supervisor exclusion removed → "a Supervisor keeps Close Day only" fails; the guard
 * removed → "an owner's later untick stays" fails; a label changed in the SQL → "the catalogue's exact words" fails.
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
const THIS = '147_close_branch_right.sql';
for (const f of files.filter((f) => num(f) < 147)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 147 (Close the branch, its own right) — PGlite, every migration\n');
const CAT = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xb);
const R = { mgr: id(0xb1), sup: id(0xb2), old: id(0xb3), cash: id(0xb4), owner: id(0xb5) };
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
for (const [rid, name] of [[R.mgr, 'Manager'], [R.sup, ' Super_visor '], [R.old, 'Shift lead'], [R.cash, 'Cashier'], [R.owner, 'Owner']]) await put('roles', { id: rid, business_id: A, name });
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
await grant(R.mgr, ['shifts.close_day', 'shifts.confirm']);
await grant(R.sup, ['shifts.close_day', 'shifts.confirm']);
// A role 134 rewrote from settings.manage: it holds close_day among the settings keys (it could close the branch before).
await grant(R.old, ['settings.business', 'receipt.manage', 'shifts.close_day', 'shifts.force_close']);
await grant(R.cash, ['orders.create']);
const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const before = { cash: await keysOf(R.cash), sup: await keysOf(R.sup) };

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('147 runs', async () => { await db.exec(sanitize(sql)); });
await ok('shifts.close_branch is registered with the catalogue\'s exact words; close_day relabelled', async () => {
  for (const key of ['shifts.close_branch', 'shifts.close_day']) {
    const p = CAT.PERMISSIONS.find((x) => x.key === key);
    const r = await one(`SELECT label, module, description FROM public.permissions WHERE key = $1`, [key]);
    assert.equal(r.label, p.label, key); assert.equal(r.module, p.group, key); assert.equal(r.description, p.description, key);
  }
});
await ok('a Manager can close the branch (and keeps Close Day)', async () => {
  const k = await keysOf(R.mgr);
  assert.ok(k.includes('shifts.close_branch')); assert.ok(k.includes('shifts.close_day'));
});
await ok('a Supervisor (any case, spaces, underscores) keeps Close Day only — never Close Branch', async () => {
  const k = await keysOf(R.sup);
  assert.ok(!k.includes('shifts.close_branch')); assert.deepEqual(k, before.sup);
});
await ok('a settings.manage-era role holding close_day gets Close Branch (nothing lost)', async () => {
  assert.ok((await keysOf(R.old)).includes('shifts.close_branch'));
});
await ok('the owner role gets it; a Cashier is untouched', async () => {
  assert.ok((await keysOf(R.owner)).includes('shifts.close_branch'));
  assert.deepEqual(await keysOf(R.cash), before.cash);
});
await ok('147 runs twice, records itself once, and an owner\'s later untick stays', async () => {
  await db.query(`DELETE FROM public.role_permissions WHERE role_id = $1 AND permission_id = (SELECT id FROM public.permissions WHERE key = 'shifts.close_branch')`, [R.mgr]);
  await db.exec(sanitize(sql));
  assert.ok(!(await keysOf(R.mgr)).includes('shifts.close_branch'));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '147_close_branch_right'`)).n, 1);
});
await ok('the catalogue: Manager holds both, the built-in Supervisor Close Day only; settings.manage stands for both', async () => {
  const role = (n) => CAT.BUILT_IN_ROLES.find((r) => r.name === n).keys;
  assert.ok(role('Manager').includes('shifts.close_branch') && role('Manager').includes('shifts.close_day'));
  assert.ok(role('Supervisor').includes('shifts.close_day') && !role('Supervisor').includes('shifts.close_branch'));
  assert.ok(CAT.LEGACY['settings.manage'].includes('shifts.close_branch'));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
