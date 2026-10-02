/**
 * test-migration-105.mjs — A311: receipt_logo_enabled on business_branding, against real Postgres (PGlite).
 * Runs 104 first (the table), then 105. Every assertion is awaited (the A305 lesson: an un-awaited
 * body races db.close() and the runner hangs).
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL104 = fs.readFileSync(path.join(ROOT, 'migrations/104_business_branding.sql'), 'utf8');
const SQL105 = fs.readFileSync(path.join(ROOT, 'migrations/105_receipt_logo_toggle.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const col = async (db, table, c) => {
  const r = await db.query(`SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='${c}'`);
  return r.rows[0] ?? null;
};

console.log('\nMigration 105 (receipt_logo_enabled) — PGlite\n');
await (async () => {
  const db = new PGlite();
  await db.exec(`
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, owner_id uuid);
    CREATE TABLE public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid);
    CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  `);
  await db.exec(SQL104);
  await ok('column absent before 105', async () => assert.strictEqual(await col(db, 'business_branding', 'receipt_logo_enabled'), null));

  await db.exec(SQL105);
  await ok('column added: boolean NOT NULL DEFAULT false', async () => {
    const c = await col(db, 'business_branding', 'receipt_logo_enabled');
    assert.ok(c, 'column missing');
    assert.strictEqual(c.data_type, 'boolean');
    assert.strictEqual(c.is_nullable, 'NO');
    assert.strictEqual(c.column_default, 'false');
  });

  const B = '00000000-0000-0000-0000-0000000000bb';
  await db.exec(`INSERT INTO public.businesses (id, name) VALUES ('${B}', 'Acme');`);
  await db.exec(`INSERT INTO public.business_branding (business_id, accent_hex) VALUES ('${B}', '#0d9488');`);
  await ok('an existing-style row defaults to OFF (opt-in)', async () => {
    const r = await db.query(`SELECT receipt_logo_enabled FROM public.business_branding WHERE business_id='${B}'`);
    assert.strictEqual(r.rows[0].receipt_logo_enabled, false);
  });
  await ok('the toggle can be set, and the A291 trigger still bumps updated_at', async () => {
    const before = (await db.query(`SELECT updated_at FROM public.business_branding WHERE business_id='${B}'`)).rows[0].updated_at;
    await db.exec(`UPDATE public.business_branding SET updated_at='2000-01-01', receipt_logo_enabled=true WHERE business_id='${B}'`);
    const r = await db.query(`SELECT receipt_logo_enabled, updated_at FROM public.business_branding WHERE business_id='${B}'`);
    assert.strictEqual(r.rows[0].receipt_logo_enabled, true);
    assert.ok(new Date(r.rows[0].updated_at).getFullYear() > 2000, 'trigger did not override updated_at');
    void before;
  });
  await ok('logo_receipt still text (untouched)', async () => assert.strictEqual((await col(db, 'business_branding', 'logo_receipt')).data_type, 'text'));
  await ok('self-registered in schema_migrations', async () => {
    const r = await db.query(`SELECT count(*)::int c FROM public.schema_migrations WHERE version='105_receipt_logo_toggle'`);
    assert.strictEqual(r.rows[0].c, 1);
  });
  await ok('idempotent: a second run does not throw and keeps one ledger row', async () => {
    await db.exec(SQL105);
    const r = await db.query(`SELECT count(*)::int c FROM public.schema_migrations WHERE version='105_receipt_logo_toggle'`);
    assert.strictEqual(r.rows[0].c, 1);
  });
  await db.close();
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
