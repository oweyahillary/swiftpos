/**
 * test-migration-152.mjs — A533: log_requests (ZapTill support pulls a till's or a branch server's log from the admin
 * portal), run for real against the WHOLE schema (every migration before 152 replayed into PGlite).
 *
 * Owner, 2026-10-19: "add a feature where we can pull local logs of a server or a till to cloud so that we can be
 * investigating such issues".
 *
 * 152 creates the table with its defaults (status waiting, range 24 h, include {}, expires 7 days on), the range and
 * status checks, the link to the stored log (support_logs: ON DELETE SET NULL), RLS on with no policy (only the cloud's
 * service role reads it), and runs twice without error, recording itself once.
 *
 * MUTATIONS TO CONFIRM BITE: the range_hours CHECK dropped → "only 24, 72 or 168 hours" fails; ENABLE ROW LEVEL
 * SECURITY dropped → "RLS on, no policy" fails; the expires_at default changed to now() → "expires 7 days on" fails.
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
const THIS = '152_log_requests.sql';
for (const f of files.filter((f) => num(f) < 152)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];

console.log('\nMigration 152 (log requests) — PGlite, every migration\n');
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
await put('businesses', { id: B, name: 'Pollo', type: 'restaurant' });
const sql152 = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('152 runs (and again — idempotent), recorded once', async () => {
  await db.exec(sql152); await db.exec(sql152);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '152_log_requests'`)).n), 1);
});
await ok('a business to ask for (fixture)', async () => { assert.ok(B, 'no business row could be made'); });
await ok('a request is stored with its defaults (waiting, 24 h, include {}, expires 7 days on)', async () => {
  await db.query(`INSERT INTO public.log_requests (business_id, device_id, reason) VALUES ($1, 'dev-T1', 'printer stops')`, [B]);
  const r = await one(`SELECT id, status, range_hours, include, requested_at, expires_at, delivered_at, support_log_id FROM public.log_requests WHERE reason = 'printer stops'`);
  assert.ok(r.id); assert.equal(r.status, 'waiting'); assert.equal(r.range_hours, 24); assert.deepEqual(r.include, {});
  assert.equal(r.delivered_at, null); assert.equal(r.support_log_id, null);
  const days = (new Date(r.expires_at) - new Date(r.requested_at)) / 86_400_000;
  assert.ok(Math.abs(days - 7) < 0.01, `expires ${days} days on`);
});
await ok('only 24, 72 or 168 hours — and only waiting, delivered, expired, cancelled', async () => {
  for (const h of [72, 168]) await db.query(`INSERT INTO public.log_requests (business_id, device_id, reason, range_hours) VALUES ($1, 'd', 'x', $2)`, [B, h]);
  await assert.rejects(db.query(`INSERT INTO public.log_requests (business_id, device_id, reason, range_hours) VALUES ($1, 'd', 'x', 48)`, [B]));
  await assert.rejects(db.query(`INSERT INTO public.log_requests (business_id, device_id, reason, status) VALUES ($1, 'd', 'x', 'sent')`, [B]));
});
await ok('device and reason are required', async () => {
  await assert.rejects(db.query(`INSERT INTO public.log_requests (business_id, reason) VALUES ($1, 'x')`, [B]));
  await assert.rejects(db.query(`INSERT INTO public.log_requests (business_id, device_id) VALUES ($1, 'd')`, [B]));
});
await ok('delivered links the stored log; the log deleted → the link cleared, the request kept', async () => {
  const log = await one(`INSERT INTO public.support_logs (business_id, device_id, reference, log_gz_b64) VALUES ($1, 'dev-T1', 'K7Q2XM', 'H4sI') RETURNING id`, [B]);
  const r = await one(`INSERT INTO public.log_requests (business_id, device_id, reason, status, support_log_id, delivered_at) VALUES ($1, 'dev-T1', 'linked', 'delivered', $2, now()) RETURNING id`, [B, log.id]);
  await db.query(`DELETE FROM public.support_logs WHERE id = $1`, [log.id]);
  const after = await one(`SELECT status, support_log_id FROM public.log_requests WHERE id = $1`, [r.id]);
  assert.equal(after.status, 'delivered'); assert.equal(after.support_log_id, null);
});
await ok('RLS on, no policy (only the service role reads it)', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.log_requests'::regclass`)).relrowsecurity, true);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'log_requests'`)).n), 0);
});
await ok('the indexes exist (newest first per business; a device\'s waiting requests)', async () => {
  const idx = (await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'log_requests'`));
  const a = idx.find((r) => r.indexname === 'log_requests_business_requested');
  const w = idx.find((r) => r.indexname === 'log_requests_device_waiting');
  assert.ok(a && w, idx.map((r) => r.indexname).join(','));
  assert.match(a.indexdef, /\(business_id, requested_at DESC\)/); assert.match(w.indexdef, /WHERE \(status = 'waiting'::text\)/);
});
await ok('the columns match scripts/schema-index.json', async () => {
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8')).log_requests;
  assert.ok(want, 'log_requests missing from schema-index.json');
  const have = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'log_requests'`)).map((r) => r.column_name).sort();
  assert.deepEqual(have, Object.keys(want).sort());
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
