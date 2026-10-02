/**
 * test-migration-106.mjs — A325: business_branding.theme_id, against real Postgres (PGlite).
 * Runs 104 (the table) and 105, then 106. Every assertion is awaited (the A305 lesson: an un-awaited
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
const SQL106 = fs.readFileSync(path.join(ROOT, 'migrations/106_branding_theme.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const col = async (db, table, c) => {
  const r = await db.query(`SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='${c}'`);
  return r.rows[0] ?? null;
};

console.log('\nMigration 106 (theme_id) — PGlite\n');
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
  await db.exec(SQL104); await db.exec(SQL105);
  const B = '00000000-0000-0000-0000-0000000000bb';
  await db.exec(`INSERT INTO public.businesses (id, name) VALUES ('${B}', 'Acme');`);
  await db.exec(`INSERT INTO public.business_branding (business_id, accent_hex) VALUES ('${B}', '#F5B800');`);
  await ok('column absent before 106', async () => assert.strictEqual(await col(db, 'business_branding', 'theme_id'), null));

  await db.exec(SQL106);
  await ok('column added: text, nullable, no default', async () => {
    const c = await col(db, 'business_branding', 'theme_id');
    assert.ok(c, 'column missing');
    assert.strictEqual(c.data_type, 'text');
    assert.strictEqual(c.is_nullable, 'YES');
    assert.strictEqual(c.column_default, null);
  });
  await ok('an existing row reads NULL (never chosen) and keeps its brand colour', async () => {
    const r = await db.query(`SELECT theme_id, accent_hex FROM public.business_branding WHERE business_id='${B}'`);
    assert.strictEqual(r.rows[0].theme_id, null);
    assert.strictEqual(r.rows[0].accent_hex, '#F5B800');
  });
  await ok('a theme id can be stored', async () => {
    await db.exec(`UPDATE public.business_branding SET theme_id='sky' WHERE business_id='${B}'`);
    const r = await db.query(`SELECT theme_id FROM public.business_branding WHERE business_id='${B}'`);
    assert.strictEqual(r.rows[0].theme_id, 'sky');
  });
  await ok('NO database CHECK on the value — the registry (themes.ts) is the one list; a retired id resolves to the default', async () => {
    await db.exec(`UPDATE public.business_branding SET theme_id='retired-theme' WHERE business_id='${B}'`);
    const r = await db.query(`SELECT theme_id FROM public.business_branding WHERE business_id='${B}'`);
    assert.strictEqual(r.rows[0].theme_id, 'retired-theme');
  });
  await ok('a theme change bumps updated_at (the catalogue-version signal tills poll)', async () => {
    const before = (await db.query(`SELECT updated_at FROM public.business_branding WHERE business_id='${B}'`)).rows[0].updated_at;
    await new Promise((r) => setTimeout(r, 15));
    await db.exec(`UPDATE public.business_branding SET theme_id='violet' WHERE business_id='${B}'`);
    const after = (await db.query(`SELECT updated_at FROM public.business_branding WHERE business_id='${B}'`)).rows[0].updated_at;
    assert.ok(new Date(after) > new Date(before), `${before} → ${after}`);
  });
  await ok('re-running 106 is harmless (idempotent) and keeps the value', async () => {
    await db.exec(SQL106);
    const r = await db.query(`SELECT theme_id FROM public.business_branding WHERE business_id='${B}'`);
    assert.strictEqual(r.rows[0].theme_id, 'violet');
  });
  await ok('recorded in schema_migrations', async () => {
    const r = await db.query(`SELECT version FROM public.schema_migrations WHERE version='106_branding_theme'`);
    assert.strictEqual(r.rows.length, 1);
  });
  await db.close();
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
