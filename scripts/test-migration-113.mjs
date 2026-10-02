/**
 * test-migration-113.mjs — 0.6.31: products.show_days (a product shown only on chosen days) — PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: drop the CHECK → "a day outside 0–6 is refused" fails; make the column NOT NULL →
 * "every existing product stays every day" fails.
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
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/113_product_show_days.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('\nMigration 113 (products.show_days) — PGlite\n');
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.products (id serial PRIMARY KEY, name text NOT NULL);
  INSERT INTO public.products (name) VALUES ('Margherita Pizza');
`);
await db.exec(SQL);

await ok('every existing product stays every day (NULL)', async () => {
  const r = await db.query(`SELECT show_days FROM public.products WHERE name = 'Margherita Pizza'`);
  assert.strictEqual(r.rows[0].show_days, null);
});
await ok('Tuesday and Thursday are stored', async () => {
  await db.exec(`INSERT INTO public.products (name, show_days) VALUES ('Offer', ARRAY[2,4]::smallint[])`);
  const r = await db.query(`SELECT show_days FROM public.products WHERE name = 'Offer'`);
  assert.deepStrictEqual(r.rows[0].show_days, [2, 4]);
});
await ok('a day outside 0–6 is refused', async () => {
  const e = await threw(() => db.exec(`INSERT INTO public.products (name, show_days) VALUES ('Bad', ARRAY[7]::smallint[])`));
  assert.ok(e && /products_show_days_range/.test(e.message), e?.message);
});
await ok('an empty list or all seven days is refused (that is NULL — every day)', async () => {
  const e1 = await threw(() => db.exec(`INSERT INTO public.products (name, show_days) VALUES ('Empty', ARRAY[]::smallint[])`));
  const e2 = await threw(() => db.exec(`INSERT INTO public.products (name, show_days) VALUES ('All', ARRAY[0,1,2,3,4,5,6]::smallint[])`));
  assert.ok(e1 && e2);
});
await ok('re-running is harmless (idempotent) and recorded once', async () => {
  await db.exec(SQL);
  const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '113_product_show_days'`);
  assert.strictEqual(r.rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
