/**
 * test-migration-154.mjs — A534: user_devices.update_state / update_state_at (each till reports where it is with its
 * update, for the admin portal's Desktop updates card), run for real against the WHOLE schema (every migration before
 * 154 replayed into PGlite).
 *
 * Owner, 2026-10-20: "add all of them since effort is small" — "why isn't this till updating?" (TJ'S PIZZA T1 sat on
 * 1.0.5 while 1.0.19 was approved, and the card showed only the version).
 *
 * 154 adds the two columns (nullable: an older till never reports), runs twice without error and records itself once;
 * a report stored on a till's row does NOT move the business's staff version (migration 150: a till merely reporting is
 * no staff change), while a till rejected still does; the columns match scripts/schema-index.json.
 *
 * MUTATIONS TO CONFIRM BITE: update_state as text → "jsonb" fails; ADD COLUMN without IF NOT EXISTS → "runs twice"
 * fails; the 150 trigger's WHEN without its column list (any update bumps) → "a report moves no staff version" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import crypto from 'node:crypto'; import { fileURLToPath } from 'node:url';
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
const THIS = '154_device_update_state.sql';
for (const f of files.filter((f) => num(f) < 154)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];

console.log('\nMigration 154 (a till\'s update state) — PGlite, every migration\n');
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
const B = crypto.randomUUID();
const D = crypto.randomUUID();
await put('businesses', { id: B, name: 'TJS Pizza', type: 'restaurant' });
await put('user_devices', { id: D, business_id: B, fingerprint: 'desktop:dev-T1', device_id: 'dev-T1', status: 'approved', app_version: '1.0.20' });
const sql154 = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('154 runs (and again — idempotent), recorded once', async () => {
  await db.exec(sql154); await db.exec(sql154);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '154_device_update_state'`)).n), 1);
});
await ok('update_state is jsonb, update_state_at a timestamp — both nullable (an older till reports nothing)', async () => {
  const c = await q(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_devices' AND column_name IN ('update_state', 'update_state_at') ORDER BY column_name`);
  assert.deepEqual(c.map((r) => [r.column_name, r.data_type, r.is_nullable]),
    [['update_state', 'jsonb', 'YES'], ['update_state_at', 'timestamp with time zone', 'YES']]);
  assert.equal((await one(`SELECT update_state FROM public.user_devices WHERE id = $1`, [D])).update_state, null);
});
const staffVersion = async () => Number((await one(`SELECT version FROM public.sync_versions WHERE business_id = $1 AND topic = 'staff'`, [B]))?.version ?? 0);
await ok('a report is stored and read back as it was sent', async () => {
  const r = { running: '1.0.20', state: 'downloaded', version: '1.0.21', since: '2026-10-20T14:02:00.000Z', task: true };
  await db.query(`UPDATE public.user_devices SET update_state = $1, update_state_at = now() WHERE id = $2`, [JSON.stringify(r), D]);
  const got = await one(`SELECT update_state, update_state_at FROM public.user_devices WHERE id = $1`, [D]);
  assert.deepEqual(got.update_state, r); assert.ok(got.update_state_at);
});
await ok('a report moves no staff version (150); a till rejected still does', async () => {
  const v0 = await staffVersion();
  await db.query(`UPDATE public.user_devices SET update_state = '{"state":"error"}'::jsonb, update_state_at = now() WHERE id = $1`, [D]);
  assert.equal(await staffVersion(), v0, 'a report bumped the staff version');
  await db.query(`UPDATE public.user_devices SET status = 'rejected' WHERE id = $1`, [D]);
  assert.ok(await staffVersion() > v0, 'rejecting a till no longer bumps the staff version');
});
await ok('the columns are in scripts/schema-index.json', async () => {
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8')).user_devices;
  assert.equal(want.update_state, '"jsonb"'); assert.equal(want.update_state_at, '"timestamp with time zone"');
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
