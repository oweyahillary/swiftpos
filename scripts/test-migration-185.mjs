/**
 * test-migration-185.mjs — A617 (owner, 2026-11-01): a branch's own prices, and current clients keep Themes, free.
 * branch_cloud_plans.own_prices (optional per-branch prices for analytics, attendance, themes, the package) and the
 * grandfathering: every branch row of a business with the 'themes' flag on gets 'themes' and an own Themes price of 0.
 * Run for real against the WHOLE schema (every migration before 185 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the feature_flags EXISTS dropped (every row grandfathered) → "only businesses with the themes
 * flag" fails; the CASE on 'themes' = ANY dropped (array_append always) → "never twice" fails; the own_prices CASE dropped
 * (|| always) → "…each row's guards keep an own price already set" fails; the CHECK's number rule dropped → "own_prices
 * checked" fails. (Each made, seen to fail, reverted.)
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
const THIS = '185_branch_own_prices.sql';
for (const f of files.filter((f) => num(f) < 185)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 185 (branch_cloud_plans.own_prices; current clients keep Themes, free) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
// T: themes flag on (two branches: one plain, one already paying Themes at its own price). O: flag off. X: no flag row.
const T = id(0xa), T1 = id(0xa1), T2 = id(0xa2), O = id(0xb), O1 = id(0xb1), X = id(0xc), X1 = id(0xc1);
for (const [biz, br] of [[T, [T1, T2]], [O, [O1]], [X, [X1]]]) {
  await put('businesses', { id: biz, name: `Biz ${biz.slice(-1)}`, type: 'retail' });
  for (const b of br) {
    await put('branches', { id: b, business_id: biz, name: `Branch ${b.slice(-2)}` });
    await db.query(`INSERT INTO public.branch_cloud_plans (branch_id, business_id, amount) VALUES ($1, $2, 3000)`, [b, biz]);
  }
}
await put('feature_flags', { business_id: T, key: 'themes', enabled: true });
await put('feature_flags', { business_id: O, key: 'themes', enabled: false });
// T2 already pays for Analytics and Themes (no own price yet): it keeps them, Themes now free.
await db.query(`UPDATE public.branch_cloud_plans SET premium = ARRAY['analytics','themes'] WHERE branch_id = $1`, [T2]);
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
const planOf = (b) => one(`SELECT premium, own_prices, updated_by FROM public.branch_cloud_plans WHERE branch_id = $1`, [b]);

await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });
await ok('the column: own_prices jsonb, nullable, NULL on an untouched row', async () => {
  const c = await one(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'branch_cloud_plans' AND column_name = 'own_prices'`);
  assert.deepEqual([c.data_type, c.is_nullable], ['jsonb', 'YES']);
  assert.equal((await planOf(X1)).own_prices, null);
});
await ok('current clients keep Themes, free: a branch of a business with the themes flag gets themes and an own price 0', async () => {
  const r = await planOf(T1);
  assert.deepEqual(r.premium, ['themes']);
  assert.deepEqual(r.own_prices, { themes: 0 });
  assert.equal(r.updated_by, 'migration 185');
});
await ok('never twice: a branch that already had themes keeps one, beside its other premium', async () => {
  const r = await planOf(T2);
  assert.deepEqual(r.premium, ['analytics', 'themes']);
  assert.deepEqual(r.own_prices, { themes: 0 });
});
await ok('only businesses with the themes flag on: flag off or no flag row — nothing changes', async () => {
  for (const b of [O1, X1]) {
    const r = await planOf(b);
    assert.deepEqual([r.premium, r.own_prices], [[], null], b);
  }
});
await ok('the deal on the business: ZapTill\'s themes_free flag on every business with Themes on, none for the others', async () => {
  const flags = await q(`SELECT business_id, enabled, set_by FROM public.feature_flags WHERE key = 'themes_free' ORDER BY business_id`);
  assert.deepEqual(flags.map((f) => [f.business_id, f.enabled, f.set_by]), [[T, true, 'migration 185']]);
});
await ok('own_prices checked: an object of analytics, attendance, themes, package — each a non-negative number', async () => {
  await db.query(`UPDATE public.branch_cloud_plans SET own_prices = '{"analytics": 7500, "package": 12000.5}' WHERE branch_id = $1`, [O1]);
  await db.query(`UPDATE public.branch_cloud_plans SET own_prices = NULL WHERE branch_id = $1`, [O1]);
  for (const bad of ['[1]', '5', '"themes"', '{"images": 1}', '{"themes": -1}', '{"themes": "free"}', '{"themes": null}']) {
    await assert.rejects(db.query(`UPDATE public.branch_cloud_plans SET own_prices = $2::jsonb WHERE branch_id = $1`, [O1, bad]), undefined, bad);
  }
});
await ok('a re-run never overwrites an own price already set (nor puts back a Themes taken off)', async () => {
  await db.query(`UPDATE public.branch_cloud_plans SET own_prices = '{"themes": 500}' WHERE branch_id = $1`, [T1]);
  await db.query(`UPDATE public.branch_cloud_plans SET premium = '{}', own_prices = NULL WHERE branch_id = $1`, [T2]);
  await db.exec(sql);
  assert.deepEqual((await planOf(T1)).own_prices, { themes: 500 });
  assert.deepEqual((await planOf(T2)).premium, [], 'the once-guard: a super admin\'s change stays');
});
await ok('…and even without the once-guard, each row\'s guards keep an own price already set', async () => {
  await db.query(`DELETE FROM public.schema_migrations WHERE version = '185_branch_own_prices'`);
  await db.query(`UPDATE public.branch_cloud_plans SET premium = '{}' WHERE branch_id = $1`, [T1]);
  await db.exec(sql);
  const r = await planOf(T1);
  assert.deepEqual(r.premium, ['themes']);
  assert.deepEqual(r.own_prices, { themes: 500 });
});
await ok('recording itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '185_branch_own_prices'`)).n, 1);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
