/**
 * test-migration-138.mjs — A502 / A505: menu.promotions, inventory.count_freeze and settings.reversals registered as
 * permissions and given to the owner's roles only, run for real against the WHOLE schema (every migration replayed into
 * PGlite).
 *
 * Every migration before 138 is replayed, roles exist the way they do in production (Admin / owner / Manager / Cashier,
 * the Manager already holding another key), then 138 runs: the three keys are registered (module menu / stock /
 * settings); only roles named owner / admin get them; nobody else gains or loses anything; a key the cloud's boot-time
 * self-heal registered first is updated, not duplicated; 138 runs twice without error, records itself once and changes
 * nothing the second time.
 *
 * MUTATIONS TO CONFIRM BITE: the WHERE lower(trim(r.name)) IN ('owner','admin') dropped → "no other role is given them"
 * fails; ON CONFLICT (key) DO UPDATE removed → "138 runs" fails on the self-healed key.
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
const THIS = '138_owner_assignable_rights.sql';
for (const f of files.filter((f) => num(f) < 138)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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



console.log('\nMigration 138 (owner-assignable rights) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), R_ADMIN = id(0xa1), R_OWNER = id(0xa2), R_MGR = id(0xa3), R_CASH = id(0xa4);
const KEYS = ['menu.promotions', 'inventory.count_freeze', 'settings.reversals'];
await put('businesses', { id: A, name: 'Pollo', type: 'restaurant' });
for (const [rid, name] of [[R_ADMIN, 'Admin'], [R_OWNER, ' owner '], [R_MGR, 'Manager'], [R_CASH, 'Cashier']]) await put('roles', { id: rid, business_id: A, name });
// The cloud's boot-time self-heal (lib/permissionCatalogue.ts) may register a key before 138 runs, with its own words.
await db.query(`INSERT INTO public.permissions (key, label, module, description) VALUES ('menu.promotions', 'x', 'x', 'x') ON CONFLICT (key) DO NOTHING`);
await db.query(`INSERT INTO public.permissions (key, label, module, description) VALUES ('sales.void', 'Void', 'selling', 'v') ON CONFLICT (key) DO NOTHING`);
await db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions WHERE key = 'sales.void' ON CONFLICT DO NOTHING`, [R_MGR]);
const grants = async () => (await q(`SELECT r.name, p.key FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
  JOIN public.permissions p ON p.id = rp.permission_id ORDER BY r.name, p.key`)).map((x) => `${x.name.trim()}:${x.key}`);
const before = await grants();

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('138 runs', async () => { await db.exec(sanitize(sql)); });
await ok('the three keys are registered once each, with their groups (a self-healed row updated, not duplicated)', async () => {
  const rows = await q(`SELECT key, module, label FROM public.permissions WHERE key = ANY($1) ORDER BY key`, [KEYS]);
  assert.deepEqual(rows.map((r) => r.key), [...KEYS].sort());
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.key, r.module])),
    { 'inventory.count_freeze': 'stock', 'menu.promotions': 'menu', 'settings.reversals': 'settings' });
  assert.equal(rows.find((r) => r.key === 'menu.promotions').label, 'Promotions');
});
await ok('the owner\'s roles (Admin, owner — case and spaces aside) get all three', async () => {
  const g = await grants();
  for (const k of KEYS) { assert.ok(g.includes(`Admin:${k}`), k); assert.ok(g.includes(`owner:${k}`), k); }
});
await ok('no other role is given them, and nobody loses anything', async () => {
  const g = await grants();
  assert.ok(!g.some((x) => /^(Manager|Cashier):/.test(x) && KEYS.some((k) => x.endsWith(':' + k))), g.join(' '));
  for (const x of before) assert.ok(g.includes(x), `lost ${x}`);
  assert.equal(g.length, before.length + 6);
});
await ok('138 runs twice without error, records itself once, and the second run changes nothing', async () => {
  const g1 = await grants();
  await db.exec(sanitize(sql));
  assert.deepEqual(await grants(), g1);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '138_owner_assignable_rights'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
