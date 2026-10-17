/**
 * test-migration-149.mjs — A525: ops_events (the server's starts, the GitHub deploy check and dependency scan), run for
 * real against the WHOLE schema (every migration before 149 replayed into PGlite).
 *
 * 149 creates the table with its defaults (id, details '{}', source 'server', created_at), the kind and status checks,
 * the newest-first index, RLS on with no policy (only the cloud's service role reads it), and runs twice without error,
 * recording itself once.
 *
 * MUTATIONS TO CONFIRM BITE: the kind CHECK dropped → "only boot, deploy_check, vuln_scan" fails; ENABLE ROW LEVEL
 * SECURITY dropped → "RLS on, no policy" fails; the (kind, created_at) index dropped → "the index exists" fails.
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
const THIS = '149_ops_events.sql';
for (const f of files.filter((f) => num(f) < 149)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];

console.log('\nMigration 149 (ops events) — PGlite, every migration\n');
const sql149 = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('149 runs (and again — idempotent), recorded once', async () => {
  await db.exec(sql149); await db.exec(sql149);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '149_ops_events'`)).n), 1);
});
await ok('a row is stored with its defaults (id, details {}, source server, created_at) — commit may be null', async () => {
  await db.query(`INSERT INTO public.ops_events (kind, status, title) VALUES ('boot', 'ok', 'Server started')`);
  const r = await one(`SELECT id, commit, details, source, created_at FROM public.ops_events WHERE title = 'Server started'`);
  assert.ok(r.id && r.created_at); assert.equal(r.commit, null); assert.deepEqual(r.details, {}); assert.equal(r.source, 'server');
});
await ok('a GitHub row: commit, details and source kept', async () => {
  await db.query(`INSERT INTO public.ops_events (kind, status, commit, title, details, source) VALUES ('vuln_scan', 'warn', 'abc123', 'scan', $1, 'github')`,
    [JSON.stringify({ totals: { high: 0, moderate: 2 } })]);
  const r = await one(`SELECT commit, details, source FROM public.ops_events WHERE kind = 'vuln_scan'`);
  assert.equal(r.commit, 'abc123'); assert.equal(r.details.totals.moderate, 2); assert.equal(r.source, 'github');
});
await ok('only boot, deploy_check, vuln_scan — and only ok, warn, fail', async () => {
  await assert.rejects(db.query(`INSERT INTO public.ops_events (kind, status, title) VALUES ('reboot', 'ok', 'x')`));
  await assert.rejects(db.query(`INSERT INTO public.ops_events (kind, status, title) VALUES ('boot', 'bad', 'x')`));
});
await ok('kind, status and title are required', async () => {
  await assert.rejects(db.query(`INSERT INTO public.ops_events (status, title) VALUES ('ok', 'x')`));
  await assert.rejects(db.query(`INSERT INTO public.ops_events (kind, title) VALUES ('boot', 'x')`));
  await assert.rejects(db.query(`INSERT INTO public.ops_events (kind, status) VALUES ('boot', 'ok')`));
});
await ok('RLS on, no policy (only the service role reads it)', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ops_events'::regclass`)).relrowsecurity, true);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'ops_events'`)).n), 0);
});
await ok('the index exists (kind, created_at DESC)', async () => {
  const idx = await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'ops_events'`);
  const k = idx.find((r) => r.indexname === 'ops_events_kind_created');
  assert.ok(k, idx.map((r) => r.indexname).join(',')); assert.match(k.indexdef, /\(kind, created_at DESC\)/);
});
await ok('the columns match scripts/schema-index.json', async () => {
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8')).ops_events;
  const have = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ops_events'`)).map((r) => r.column_name).sort();
  assert.deepEqual(have, Object.keys(want).sort());
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
