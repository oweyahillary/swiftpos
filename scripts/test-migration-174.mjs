/**
 * test-migration-174.mjs — A589: admin_settings (ZapTill's own alert settings), admin_notifications (the admin portal
 * bell, instead of one email per client problem or invoice) and ops_events kinds 'backup' / 'uptime' — run for real
 * against the WHOLE schema (every migration before 174 replayed into PGlite).
 *
 * Owner, 2026-10-25: "till not closed should not come as an email for each client; let it be a notification on the admin
 * portal" · "how can I be doing backups to protect my client data each night at 12am".
 *
 *   - 174 runs twice, recorded once; both tables match scripts/schema-index.json; RLS on both.
 *   - admin_settings: one row per key (upsert), a JSON value.
 *   - admin_notifications: a category of lower-case words only; a business deleted takes its notifications.
 *   - ops_events: 'backup' and 'uptime' accepted, every earlier kind still accepted; anything else refused.
 *
 *   node --no-warnings scripts/test-migration-174.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A589 report):
 *   - the ops_events check without 'backup'          → "ops_events kinds" fails
 *   - admin_notifications without ON DELETE CASCADE   → "a business deleted" fails
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
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
const THIS = '174_admin_alerts.sql';
for (const f of files.filter((f) => num(f) < 174)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const fill = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : `x-${crypto.randomUUID().slice(0, 8)}`;
  }
  return full;
};
const put = async (table, row) => {
  const full = await fill(table, row);
  const k = Object.keys(full);
  return (await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => full[x]))).rows[0];
};
console.log('\nMigration 174 (admin alerts: settings, the portal bell, backup and uptime events) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa);
await put('businesses', { id: A, name: 'Pollo', type: 'restaurant' });
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('174 runs (and again — idempotent), recorded once; both tables match scripts/schema-index.json; RLS on', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '174_admin_alerts'`)).n), 1);
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  for (const t of ['admin_settings', 'admin_notifications']) {
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t])).map((r) => r.column_name).sort();
    assert.deepEqual(Object.keys(idx[t] ?? {}).sort(), cols, t);
    assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`])).relrowsecurity, true, `${t} RLS`);
  }
});
await ok('admin_settings: one row per key, a JSON value, upserted', async () => {
  await db.query(`INSERT INTO public.admin_settings (key, value) VALUES ('alert_settings', '{"instant":["server_errors"]}')`);
  await assert.rejects(() => db.query(`INSERT INTO public.admin_settings (key, value) VALUES ('alert_settings', '{}')`), /duplicate|unique/i);
  await db.query(`INSERT INTO public.admin_settings (key, value, updated_by) VALUES ('alert_settings', '{"digest_time":"06:30"}', 'boss') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  const r = await one(`SELECT value, updated_by FROM public.admin_settings WHERE key = 'alert_settings'`);
  assert.equal(r.value.digest_time, '06:30'); assert.equal(r.updated_by, 'boss');
});
await ok('admin_notifications: lower-case category only; unread by default; a business deleted takes its notifications', async () => {
  const n = await put('admin_notifications', { category: 'day_not_closed', business_id: A, title: 'Pollo: day 2026-10-24 not closed' });
  assert.equal(n.read_at, null); assert.equal(n.digest_sent_at, null); assert.deepEqual(n.data, {});
  await put('admin_notifications', { category: 'billing', business_id: null, title: 'A system notice' });
  await assert.rejects(() => put('admin_notifications', { category: 'Billing Notice!', title: 'x' }), /check/i);
  await db.query(`DELETE FROM public.businesses WHERE id = $1`, [A]);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.admin_notifications WHERE business_id IS NOT NULL`)).n), 0);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.admin_notifications`)).n), 1);
});
await ok('ops_events kinds: backup and uptime accepted; boot, deploy_check, vuln_scan still; anything else refused', async () => {
  for (const k of ['boot', 'deploy_check', 'vuln_scan', 'backup', 'uptime']) await put('ops_events', { kind: k, status: 'ok', title: k });
  await assert.rejects(() => put('ops_events', { kind: 'restore', status: 'ok', title: 'x' }), /check/i);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
