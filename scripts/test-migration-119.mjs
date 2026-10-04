/**
 * test-migration-119.mjs — A391 / A392: sign-in codes (admin_users / users settings, login_otp_codes) and muting an
 * alert (watchdog_alerts.acknowledged_*) — PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: otp_method without its default → "every existing account gets emailed codes" fails; the
 * CHECK dropped → "only email or totp" fails; RLS left off the code table → "only the cloud reads the codes" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/119_login_otp.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

console.log('\nMigration 119 (sign-in codes; muting an alert) — PGlite\n');
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.admin_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL);
  CREATE TABLE public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE TABLE public.watchdog_alerts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alert_key text NOT NULL);
  INSERT INTO public.admin_users (email) VALUES ('hillary@zaptill.co.ke');
  INSERT INTO public.users (email) VALUES ('owner@x.co.ke'), ('cashier@x.co.ke');
  INSERT INTO public.watchdog_alerts (alert_key) VALUES ('k');
`);
await db.exec(SQL);

await ok('every existing account gets emailed codes, version 1, no secret', async () => {
  for (const t of ['admin_users', 'users']) {
    const r = (await db.query(`SELECT otp_method, otp_totp_secret, otp_version FROM public.${t}`)).rows;
    assert.ok(r.length && r.every((x) => x.otp_method === 'email' && x.otp_totp_secret === null && x.otp_version === 1), t);
  }
});
await ok('only email or totp', async () => {
  await db.exec(`UPDATE public.users SET otp_method = 'totp', otp_totp_secret = 'v1:x' WHERE email = 'owner@x.co.ke'`);
  await assert.rejects(db.exec(`UPDATE public.admin_users SET otp_method = 'sms'`));
  await assert.rejects(db.exec(`UPDATE public.users SET otp_method = 'sms'`));
});
await ok('a code row: hashed, expiring, tries counted; only admin or user subjects', async () => {
  await db.exec(`INSERT INTO public.login_otp_codes (subject_kind, subject_id, code_hash, expires_at) VALUES ('admin', gen_random_uuid(), 'h', now() + interval '10 minutes')`);
  const r = (await db.query(`SELECT attempts, consumed_at FROM public.login_otp_codes`)).rows[0];
  assert.equal(r.attempts, 0); assert.equal(r.consumed_at, null);
  await assert.rejects(db.exec(`INSERT INTO public.login_otp_codes (subject_kind, subject_id, code_hash, expires_at) VALUES ('guest', gen_random_uuid(), 'h', now())`));
});
await ok('only the cloud reads the codes (RLS on, no policy)', async () => {
  const r = (await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'login_otp_codes'`)).rows[0];
  assert.equal(r.relrowsecurity, true);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'login_otp_codes'`)).rows[0].n, 0);
});
await ok('an alert can be muted, and by whom', async () => {
  await db.exec(`UPDATE public.watchdog_alerts SET acknowledged_at = now(), acknowledged_by = 'hillary@zaptill.co.ke'`);
  assert.equal((await db.query(`SELECT acknowledged_by FROM public.watchdog_alerts`)).rows[0].acknowledged_by, 'hillary@zaptill.co.ke');
});
await ok('it runs twice without error and records itself once', async () => {
  await db.exec(SQL);
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '119_login_otp'`)).rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
