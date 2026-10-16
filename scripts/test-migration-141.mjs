/**
 * test-migration-141.mjs — A514: roles named waiter or teller lose staff.view and customers.credit (migration 140's rule for
 * cashier roles, applied to the other counter roles), run for real against the WHOLE schema (every migration replayed into
 * PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the name condition dropped → "other roles keep them" fails; 'teller' left out → "every role
 * named waiter or teller" fails; the guard removed → "runs twice" fails (an owner's tick-back is taken away again).
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
const THIS = '141_counter_roles_rights.sql';
for (const f of files.filter((f) => num(f) < 141)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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




console.log('\nMigration 141 (waiter and teller rights) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), R_WAIT = id(0xa1), R_TELL = id(0xa2), R_MGR = id(0xa3), R_OWNER = id(0xa4), R_HEAD = id(0xa5), R_CASH = id(0xa6);
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
for (const [rid, name] of [[R_WAIT, 'Waiter'], [R_TELL, ' TELLER '], [R_MGR, 'Manager'], [R_OWNER, 'Admin'], [R_HEAD, 'Head waiter'], [R_CASH, 'Cashier']]) {
  await put('roles', { id: rid, business_id: A, name });
}
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
const COUNTER = ['orders.create', 'sales.discount', 'customers.credit', 'customers.view', 'staff.view', 'products.view'];
for (const rid of [R_WAIT, R_TELL, R_HEAD, R_CASH]) await grant(rid, COUNTER);
await grant(R_MGR, ['orders.create', 'customers.credit', 'staff.view', 'sales.void']);
await grant(R_OWNER, ['customers.credit', 'staff.view']);
const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const before = { mgr: await keysOf(R_MGR), owner: await keysOf(R_OWNER), head: await keysOf(R_HEAD), cash: await keysOf(R_CASH) };

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('141 runs', async () => { await db.exec(sanitize(sql)); });
await ok('every role named waiter or teller (case and spaces aside) loses the staff list and customer credit — and keeps selling', async () => {
  for (const rid of [R_WAIT, R_TELL]) {
    const k = await keysOf(rid);
    assert.ok(!k.includes('staff.view') && !k.includes('customers.credit'), k.join(' '));
    for (const x of ['orders.create', 'sales.discount', 'customers.view', 'products.view']) assert.ok(k.includes(x), x);
  }
});
await ok('other roles keep them (the manager, the owner, a "Head waiter", a cashier role — 140 decides those)', async () => {
  assert.deepEqual(await keysOf(R_MGR), before.mgr);
  assert.deepEqual(await keysOf(R_OWNER), before.owner);
  assert.deepEqual(await keysOf(R_HEAD), before.head);
  assert.deepEqual(await keysOf(R_CASH), before.cash);
});
await ok('141 runs twice, records itself once, and leaves an owner\'s later choice alone', async () => {
  await grant(R_WAIT, ['staff.view']);   // the owner ticked it back
  await grant(R_TELL, ['customers.credit']);
  await db.exec(sanitize(sql));
  assert.ok((await keysOf(R_WAIT)).includes('staff.view'));
  assert.ok((await keysOf(R_TELL)).includes('customers.credit'));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '141_counter_roles_rights'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
