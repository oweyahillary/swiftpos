/**
 * test-migration-104.mjs — business_branding (A303), against real Postgres (PGlite).
 * Pins the cloud branding table: columns + types, RLS enabled, the set_updated_at trigger
 * bumps updated_at on UPDATE (the A291 freshness signal), FK cascade from businesses, and
 * idempotent re-run. Runs in CI (needs @electric-sql/pglite); mirrors test-migration-102.mjs.
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/104_business_branding.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

const colType = async (db, table, col) => {
  const r = await db.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, col]);
  return r.rows[0]?.data_type ?? null;
};

console.log('\nMigration 104 (business_branding) — PGlite\n');
await (async () => {
  const db = new PGlite();
  // Prerequisites the migration references: auth.uid(), businesses (FK), users (RLS policy),
  // set_updated_at() (trigger), schema_migrations (self-registration), and the Supabase roles
  // the GRANTs target (present in real Supabase; absent in bare PGlite).
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

  await ok('table absent before migration', async () => {
    assert.strictEqual(await colType(db, 'business_branding', 'accent_hex'), null);
  });

  await db.exec(SQL);

  await ok('columns and types', async () => {
    assert.strictEqual(await colType(db, 'business_branding', 'business_id'), 'uuid');
    assert.strictEqual(await colType(db, 'business_branding', 'accent_hex'), 'text');
    assert.strictEqual(await colType(db, 'business_branding', 'logo_png'), 'text');
    assert.strictEqual(await colType(db, 'business_branding', 'logo_receipt'), 'text');
    assert.strictEqual(await colType(db, 'business_branding', 'updated_at'), 'timestamp with time zone');
  });

  await ok('RLS is enabled', async () => {
    const r = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='business_branding'`);
    assert.strictEqual(r.rows[0]?.relrowsecurity, true);
  });

  await ok('business_id is the primary key', async () => {
    const r = await db.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid='public.business_branding'::regclass AND i.indisprimary`);
    assert.strictEqual(r.rows[0]?.attname, 'business_id');
  });

  const B = '00000000-0000-0000-0000-0000000000aa';
  await db.exec(`INSERT INTO public.businesses (id, name) VALUES ('${B}', 'Acme');`);
  await db.exec(`INSERT INTO public.business_branding (business_id, accent_hex, logo_png)
                 VALUES ('${B}', '#0d9488', 'data:image/png;base64,AAAA');`);

  await ok('set_updated_at trigger overrides updated_at to now() on UPDATE (A291 signal)', async () => {
    // Write a deliberately OLD updated_at; the BEFORE UPDATE trigger must override it to now().
    await db.exec(`UPDATE public.business_branding SET updated_at='2000-01-01T00:00:00Z', accent_hex='#e11d48' WHERE business_id='${B}';`);
    const after = (await db.query(`SELECT updated_at FROM public.business_branding WHERE business_id='${B}'`)).rows[0].updated_at;
    assert.ok(new Date(after).getFullYear() > 2001, `trigger did not fire — updated_at stuck at ${after}`);
  });

  await ok('FK cascade: deleting the business removes its branding', async () => {
    await db.exec(`DELETE FROM public.businesses WHERE id='${B}';`);
    const r = await db.query(`SELECT count(*)::int c FROM public.business_branding WHERE business_id='${B}'`);
    assert.strictEqual(r.rows[0].c, 0);
  });

  await ok('self-registered in schema_migrations', async () => {
    const r = await db.query(`SELECT count(*)::int c FROM public.schema_migrations WHERE version='104_business_branding'`);
    assert.strictEqual(r.rows[0].c, 1);
  });

  await ok('idempotent: a second run does not throw', async () => {
    await db.exec(SQL);   // DROP ... IF EXISTS before CREATE POLICY/TRIGGER makes this safe
  });

  await db.close();
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
