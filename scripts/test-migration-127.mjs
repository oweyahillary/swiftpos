/**
 * test-migration-127.mjs — A415: a till signs in as itself — run for real against the WHOLE schema (every migration up to
 * 126 replayed into PGlite, data seeded the way the owner-era till left it, then 127).
 *
 * MUTATIONS TO CONFIRM BITE: the user_devices UPDATE without the 'desktop:%' filter → "a cashier's browser keeps its
 * person" fails; the refresh_tokens UPDATE without session_kind = 'device' → "a person's session keeps its person" fails;
 * a DROP NOT NULL removed → "a till with no person" fails.
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
const before = files.filter((f) => +f.split('_')[0] < 127);
for (const f of before) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const one = async (s, p = []) => (await db.query(s, p)).rows[0];
const refused = async (p) => { try { await p; return false; } catch { return true; } };

console.log('\nMigration 127 (a till signs in as itself) — PGlite, every migration\n');
const B = '00000000-0000-0000-0000-0000000000b1', BR = '00000000-0000-0000-0000-0000000000a1';
const OWNER = '00000000-0000-0000-0000-0000000000e1', CASHIER = '00000000-0000-0000-0000-0000000000e2';
await db.exec(`
  INSERT INTO public.businesses (id, name, type) VALUES ('${B}', 'B Foods', 'restaurant');
  INSERT INTO public.branches (id, business_id, name) VALUES ('${BR}', '${B}', 'Town');
  INSERT INTO public.users (id, business_id, name, email) VALUES ('${OWNER}', '${B}', 'Owner', 'o@b.test'), ('${CASHIER}', '${B}', 'Jane', 'j@b.test');
  INSERT INTO public.user_devices (user_id, business_id, fingerprint, device_id, status) VALUES
    ('${OWNER}', '${B}', 'desktop:dev-T1', 'dev-T1', 'approved'),
    ('${CASHIER}', '${B}', 'browser-hash-1', NULL, 'approved');
  INSERT INTO public.refresh_tokens (jti, user_id, business_id, session_id, device_hint, expires_at, session_kind) VALUES
    ('j1', '${OWNER}', '${B}', 's1', 'dev-T1', now() + interval '30 days', 'device'),
    ('j2', '${OWNER}', '${B}', 's2', 'Mozilla', now() + interval '30 days', 'web'),
    ('j3', '${CASHIER}', '${B}', 's3', 'dev-T1', now() + interval '30 days', 'pin');
  INSERT INTO public.device_enrolment_codes (business_id, branch_id, code_hash, created_by, expires_at) VALUES
    ('${B}', '${BR}', 'h1', '${OWNER}', now() + interval '1 day');`);
await ok('before 127: a till row with no person is refused (what A415 needs changed)', async () => {
  assert.ok(await refused(db.query(`INSERT INTO public.user_devices (business_id, fingerprint, device_id, status) VALUES ('${B}', 'desktop:dev-T2', 'dev-T2', 'approved')`)));
});

await db.exec(sanitize(fs.readFileSync(path.join(MIG, '127_till_own_signin.sql'), 'utf8')));

await ok('the owner is gone from the till: its device row, its session and the enrolment code', async () => {
  assert.equal((await one(`SELECT user_id FROM public.user_devices WHERE device_id = 'dev-T1'`)).user_id, null);
  assert.equal((await one(`SELECT user_id FROM public.refresh_tokens WHERE jti = 'j1'`)).user_id, null);
  assert.equal((await one(`SELECT created_by FROM public.device_enrolment_codes WHERE code_hash = 'h1'`)).created_by, null);
});
await ok('a cashier\'s browser keeps its person; a person\'s session keeps its person', async () => {
  assert.equal((await one(`SELECT user_id FROM public.user_devices WHERE fingerprint = 'browser-hash-1'`)).user_id, CASHIER);
  assert.equal((await one(`SELECT user_id FROM public.refresh_tokens WHERE jti = 'j2'`)).user_id, OWNER);
  assert.equal((await one(`SELECT user_id FROM public.refresh_tokens WHERE jti = 'j3'`)).user_id, CASHIER);
});
await ok('a till with no person: its row, its session, a code with no owner', async () => {
  await db.query(`INSERT INTO public.user_devices (business_id, fingerprint, device_id, status) VALUES ('${B}', 'desktop:dev-T2', 'dev-T2', 'approved')`);
  await db.query(`INSERT INTO public.refresh_tokens (jti, business_id, session_id, device_hint, expires_at, session_kind) VALUES ('j4', '${B}', 's4', 'dev-T2', now() + interval '30 days', 'device')`);
  await db.query(`INSERT INTO public.device_enrolment_codes (business_id, branch_id, code_hash, expires_at) VALUES ('${B}', '${BR}', 'h2', now() + interval '1 day')`);
});
await ok('replaying 127 changes nothing (idempotent)', async () => {
  await db.exec(sanitize(fs.readFileSync(path.join(MIG, '127_till_own_signin.sql'), 'utf8')));
  assert.equal((await one(`SELECT user_id FROM public.refresh_tokens WHERE jti = 'j2'`)).user_id, OWNER);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
