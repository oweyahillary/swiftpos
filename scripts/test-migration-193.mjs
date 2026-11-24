/**
 * test-migration-193.mjs — A624 (owner, 2026-11-23): unify cloud billing on per-branch. Migration 193 backfills each
 * branch's premium[] from the CURRENT two-layer model (per-business master switch AND per-branch premium / billed-as-one),
 * so no client's Analytics/Attendance/Themes access changes when the server stops reading the feature_flags switches.
 * Run for real against the WHOLE schema (every migration before 193 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: drop the masterOn condition → "off switch strips a paying branch" fails; drop the
 * billed-as-one branch creation → "billed-as-one: rows made and granted" fails; drop the "AND the branch pays" leg →
 * "per-branch: only the paying branch keeps it" fails; drop the schema_migrations insert → "records itself" fails.
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
const THIS = '193_unify_per_branch_premium.sql';
for (const f of files.filter((f) => num(f) < 193)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const flag = (biz, key) => put('feature_flags', { business_id: biz, key, enabled: true });
const plan = (biz) => db.query(`INSERT INTO public.cloud_plans (business_id, period, amount, created_at, billing_from) VALUES ($1, 'monthly', 3000, '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z')`, [biz]);
const bplan = (branch, biz, premium, pkg = false) => db.query(`INSERT INTO public.branch_cloud_plans (branch_id, business_id, amount, premium, package) VALUES ($1, $2, 3000, $3, $4)`, [branch, biz, premium, pkg]);
const prem = async (branch) => (await one(`SELECT premium, package FROM public.branch_cloud_plans WHERE branch_id = $1`, [branch]));

console.log('\nMigration 193 (unify per-branch premium: access-preserving backfill) — PGlite, every migration\n');

// A — per-branch, analytics switch ON; A1 pays, A2 does not.
const A = id(0xa), A1 = id(0xa1), A2 = id(0xa2);
await put('businesses', { id: A, name: 'Per-branch', type: 'retail', web_access_expires_at: '2026-12-01T21:00:00Z' });
await put('branches', { id: A1, business_id: A, name: 'Pays' }); await put('branches', { id: A2, business_id: A, name: 'Not' });
await plan(A); await bplan(A1, A, ['analytics']); await bplan(A2, A, []); await flag(A, 'analytics');
// B — per-branch, analytics switch OFF, but B1's row has analytics (must be stripped: masterOn AND pays).
const B = id(0xb), B1 = id(0xb1);
await put('businesses', { id: B, name: 'Switch off', type: 'retail', web_access_expires_at: '2026-12-01T21:00:00Z' });
await put('branches', { id: B1, business_id: B, name: 'Main' }); await plan(B); await bplan(B1, B, ['analytics']);
// C — billed as one (no branch rows), attendance switch ON, two branches.
const C = id(0xc), C1 = id(0xc1), C2 = id(0xc2);
await put('businesses', { id: C, name: 'Billed as one', type: 'retail', web_access_expires_at: '2026-12-01T21:00:00Z' });
await put('branches', { id: C1, business_id: C, name: 'One' }); await put('branches', { id: C2, business_id: C, name: 'Two' });
await plan(C); await flag(C, 'attendance');
// D — billed as one, no switch.
const D = id(0xd), D1 = id(0xd1);
await put('businesses', { id: D, name: 'No premium', type: 'retail', web_access_expires_at: '2026-12-01T21:00:00Z' });
await put('branches', { id: D1, business_id: D, name: 'Main' }); await plan(D);
// E — no plan, themes switch ON (trial/complimentary).
const E = id(0xe), E1 = id(0xe1);
await put('businesses', { id: E, name: 'Trial themes', type: 'retail', web_access_expires_at: '2026-12-01T21:00:00Z' });
await put('branches', { id: E1, business_id: E, name: 'Main' }); await flag(E, 'themes');
// F — no plan, no switch: nothing to preserve, no row made.
const F = id(0xf), F1 = id(0xf1);
await put('businesses', { id: F, name: 'Nothing', type: 'retail' }); await put('branches', { id: F1, business_id: F, name: 'Main' });
// G — per-branch package branch, all switches on: the package is left as-is.
const G = id(0x6), G1 = id(0x61);
await put('businesses', { id: G, name: 'Package', type: 'retail', web_access_expires_at: '2026-12-01T21:00:00Z' });
await put('branches', { id: G1, business_id: G, name: 'Main' }); await plan(G); await bplan(G1, G, [], true);
await flag(G, 'analytics'); await flag(G, 'attendance'); await flag(G, 'themes');

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });

await ok('per-branch: only the paying branch keeps it (A1 analytics, A2 none)', async () => {
  assert.deepEqual((await prem(A1)).premium, ['analytics']);
  assert.deepEqual((await prem(A2)).premium, []);
});
await ok('off switch strips a paying branch (B1 loses analytics)', async () => {
  assert.deepEqual((await prem(B1)).premium, []);
});
await ok('billed-as-one: rows made and the switch granted to every branch (C1, C2 attendance)', async () => {
  assert.deepEqual((await prem(C1)).premium, ['attendance']);
  assert.deepEqual((await prem(C2)).premium, ['attendance']);
});
await ok('billed-as-one, no switch: a row is made (inherits the plan) with empty premium (D1)', async () => {
  const r = await prem(D1); assert.ok(r, 'D1 row exists'); assert.deepEqual(r.premium, []);
});
await ok('no plan but a switch: a default row carries the premium (E1 themes, amount 0)', async () => {
  const r = await one(`SELECT premium, amount::float AS amount, period FROM public.branch_cloud_plans WHERE branch_id = $1`, [E1]);
  assert.ok(r, 'E1 row exists'); assert.deepEqual(r.premium, ['themes']); assert.deepEqual([r.amount, r.period], [0, 'monthly']);
});
await ok('no plan, no switch: no row made (F1 follows its business)', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.branch_cloud_plans WHERE branch_id = $1`, [F1])).n, 0);
});
await ok('a package branch keeps the package, premium left alone (G1)', async () => {
  const r = await prem(G1); assert.equal(r.package, true);
});
await ok('each newly-made row inherits the business plan paid-until (C1, C2, D1, E1)', async () => {
  for (const b of [C1, C2, D1, E1]) assert.equal(new Date((await one(`SELECT paid_until FROM public.branch_cloud_plans WHERE branch_id = $1`, [b])).paid_until).toISOString(), '2026-12-01T21:00:00.000Z', `branch ${b}`);
});
await ok('records itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '193_unify_per_branch_premium'`)).n, 1);
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
