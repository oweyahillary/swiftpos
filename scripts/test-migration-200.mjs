/**
 * test-migration-200.mjs — A627 W3: per-person email-alert preferences (user_notification_prefs). Run for real against
 * the WHOLE schema (every migration before 200 replayed into PGlite).
 *
 *   node --no-warnings scripts/test-migration-200.mjs
 *
 * Checks: the table exists with the right columns; the PK is (user_id, alert_type); email_enabled defaults true; a second
 * row for the same (user, alert) is rejected; business_id cascades from businesses; a row survives.
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
const THIS = '200_user_notification_prefs.sql';
for (const f of files.filter((f) => num(f) < 200)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const throws = async (s, p = []) => { try { await db.query(s, p); return false; } catch { return true; } };
const colsOf = new Map();
const put = async (table, rowData) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]));
  const full = { ...rowData };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-11-01T10:00:00Z' : t === 'date' ? '2026-11-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : 'x';
  }
  const k = Object.keys(full);
  await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => full[x]));
};

console.log('\nMigration 200 (A627 W3: user_notification_prefs) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BIZ = id(0xb1), U = id(0xc1);
await put('businesses', { id: BIZ, name: 'Sample Co', type: 'retail' });

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('200 runs', async () => { await db.exec(sanitize(sql)); });
await ok('the table exists with the expected columns', async () => {
  const cols = (await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='user_notification_prefs' ORDER BY column_name`));
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['alert_type', 'business_id', 'email_enabled', 'updated_at', 'updated_by', 'user_id']);
  assert.equal(byName.email_enabled.data_type, 'boolean');
  assert.match(String(byName.email_enabled.column_default), /true/);
  assert.equal(byName.user_id.is_nullable, 'NO');
  assert.equal(byName.alert_type.is_nullable, 'NO');
});
await ok('the primary key is (user_id, alert_type)', async () => {
  const pk = (await q(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
    WHERE i.indrelid='public.user_notification_prefs'::regclass AND i.indisprimary ORDER BY a.attname`)).map((r) => r.attname);
  assert.deepEqual(pk, ['alert_type', 'user_id']);
});
await ok('email_enabled defaults true; a row survives; a duplicate (user, alert) is rejected', async () => {
  await db.query(`INSERT INTO public.user_notification_prefs (business_id, user_id, alert_type) VALUES ($1,$2,'daily_summary')`, [BIZ, U]);
  const row = await one(`SELECT email_enabled FROM public.user_notification_prefs WHERE user_id=$1 AND alert_type='daily_summary'`, [U]);
  assert.equal(row.email_enabled, true);
  assert.ok(await throws(`INSERT INTO public.user_notification_prefs (business_id, user_id, alert_type) VALUES ($1,$2,'daily_summary')`, [BIZ, U]), 'duplicate PK must throw');
  // a different alert for the same user is fine
  await db.query(`INSERT INTO public.user_notification_prefs (business_id, user_id, alert_type, email_enabled) VALUES ($1,$2,'low_stock', false)`, [BIZ, U]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM public.user_notification_prefs WHERE user_id=$1`, [U]))[0].n, 2);
});
await ok('deleting the business cascades its prefs away', async () => {
  await db.query(`DELETE FROM public.businesses WHERE id=$1`, [BIZ]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM public.user_notification_prefs WHERE business_id=$1`, [BIZ]))[0].n, 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
