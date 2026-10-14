/**
 * test-migration-131.mjs — A477: the renewal handshake and the till's machine — run for real against the WHOLE schema
 * (every migration up to 130 replayed into PGlite, sessions seeded mid-flight the way the old rotation leaves them,
 * then 131).
 *
 * MUTATIONS TO CONFIRM BITE: the backfill without its NOT (…) exception → "a reply lost just before the deploy stays
 * re-askable" fails; the backfill removed → "every other row is confirmed" fails; a column dropped → "the machine
 * columns" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort((a, b) => (+a.split('_')[0]) - (+b.split('_')[0]) || a.localeCompare(b));
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith('\\') || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
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
for (const f of files.filter((f) => +f.split('_')[0] < 131)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const one = async (s, p = []) => (await db.query(s, p)).rows[0];

console.log('\nMigration 131 (the renewal handshake, the till\'s machine) — PGlite, every migration\n');
const B = '00000000-0000-0000-0000-0000000000b1';
const A = '00000000-0000-0000-0000-0000000000c1', S = '00000000-0000-0000-0000-0000000000c2';
const L = '00000000-0000-0000-0000-0000000000c3', X = '00000000-0000-0000-0000-0000000000c4', R = '00000000-0000-0000-0000-0000000000c5';
await db.exec(`
  INSERT INTO public.businesses (id, name, type) VALUES ('${B}', 'B Foods', 'restaurant');
  INSERT INTO public.user_devices (business_id, fingerprint, device_id, status) VALUES ('${B}', 'desktop:dev-T1', 'dev-T1', 'approved');
  -- a rotation the old code finished: A consumed (revoked), S its successor and the live head — the till may never have got S
  INSERT INTO public.refresh_tokens (id, jti, business_id, session_id, device_hint, expires_at, session_kind, revoked_at, replaced_by, created_at) VALUES
    ('${S}', 'jS', '${B}', 's1', 'dev-T1', now() + interval '30 days', 'device', NULL, NULL, now() - interval '1 hour'),
    ('${A}', 'jA', '${B}', 's1', 'dev-T1', now() + interval '30 days', 'device', now() - interval '1 hour', '${S}', now() - interval '2 hours'),
  -- a fresh sign-in never renewed, an old revoked token with no successor (a logout), a live head whose parent is gone
    ('${L}', 'jL', '${B}', 's2', 'Mozilla', now() + interval '30 days', 'web', NULL, NULL, now() - interval '3 hours'),
    ('${X}', 'jX', '${B}', 's3', 'Mozilla', now() + interval '30 days', 'web', now(), NULL, now() - interval '4 hours'),
    ('${R}', 'jR', '${B}', 's4', 'dev-T1', now() + interval '30 days', 'device', NULL, NULL, now() - interval '5 hours');`);

await db.exec(sanitize(fs.readFileSync(path.join(MIG, '131_refresh_ack.sql'), 'utf8')));

await ok('every other row is confirmed, as of when it was made (sessions mid-flight rotate as before)', async () => {
  for (const id of [A, L, X, R]) {
    const r = await one(`SELECT acked_at = created_at AS same FROM public.refresh_tokens WHERE id = $1`, [id]);
    assert.equal(r.same, true, id);
  }
});
await ok('a reply lost just before the deploy stays re-askable: the live successor of a revoked token is unconfirmed', async () => {
  assert.equal((await one(`SELECT acked_at FROM public.refresh_tokens WHERE id = $1`, [S])).acked_at, null);
});
await ok('a new token is unconfirmed until the client says it holds it (no default)', async () => {
  await db.query(`INSERT INTO public.refresh_tokens (jti, business_id, session_id, expires_at) VALUES ('jN', '${B}', 's5', now() + interval '30 days')`);
  assert.equal((await one(`SELECT acked_at FROM public.refresh_tokens WHERE jti = 'jN'`)).acked_at, null);
});
await ok('the machine columns on the till\'s row, and the security alert', async () => {
  await db.query(`UPDATE public.user_devices SET machine_guid_hash = 'g', serial_hash = 's', identity_seen_at = now(), security_alert_at = now(), security_alert_reason = 'r' WHERE device_id = 'dev-T1'`);
  const r = await one(`SELECT machine_guid_hash, serial_hash, security_alert_reason FROM public.user_devices WHERE device_id = 'dev-T1'`);
  assert.deepEqual([r.machine_guid_hash, r.serial_hash, r.security_alert_reason], ['g', 's', 'r']);
});
await ok('replaying 131 changes nothing (idempotent) — the confirmed stay confirmed, the unconfirmed stay so', async () => {
  await db.exec(sanitize(fs.readFileSync(path.join(MIG, '131_refresh_ack.sql'), 'utf8')));
  assert.equal((await one(`SELECT acked_at FROM public.refresh_tokens WHERE id = $1`, [S])).acked_at, null);
  assert.equal((await one(`SELECT acked_at = created_at AS same FROM public.refresh_tokens WHERE id = $1`, [L])).same, true);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '131_refresh_ack'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
