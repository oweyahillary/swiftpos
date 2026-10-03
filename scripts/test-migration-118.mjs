/**
 * test-migration-118.mjs — 0.6.37 (A388): float_transactions / expenses .approved_by (+ _name) — PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: a foreign key on approved_by → "an approver the cloud does not know never refuses the
 * drawer's record" fails; NOT NULL → "an older till's push (no approver) still lands" fails.
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
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/118_payout_approval.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

console.log('\nMigration 118 (who approved a cash-out or an expense) — PGlite\n');
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.float_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, amount numeric NOT NULL);
  CREATE TABLE public.expenses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), description text NOT NULL, amount numeric NOT NULL);
  INSERT INTO public.float_transactions (type, amount) VALUES ('float_out', 200);
  INSERT INTO public.expenses (description, amount) VALUES ('Gas', 500);
`);
await db.exec(SQL);

await ok('every existing pay-out and expense has no approver (recorded before 0.6.37)', async () => {
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM public.float_transactions WHERE approved_by IS NULL AND approved_by_name IS NULL`)).rows[0].n, 1);
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM public.expenses WHERE approved_by IS NULL AND approved_by_name IS NULL`)).rows[0].n, 1);
});
await ok('the approver and their name are stored', async () => {
  await db.exec(`INSERT INTO public.float_transactions (type, amount, approved_by, approved_by_name) VALUES ('float_out', 300, gen_random_uuid(), 'Mary')`);
  await db.exec(`INSERT INTO public.expenses (description, amount, approved_by, approved_by_name) VALUES ('Boda', 150, gen_random_uuid(), 'Mary')`);
  assert.strictEqual((await db.query(`SELECT approved_by_name FROM public.expenses WHERE description = 'Boda'`)).rows[0].approved_by_name, 'Mary');
});
await ok('an approver the cloud does not know never refuses the drawer\'s record (no foreign key)', async () => {
  await db.exec(`INSERT INTO public.float_transactions (type, amount, approved_by) VALUES ('float_out', 50, '00000000-0000-0000-0000-000000000001')`);
});
await ok('an older till\'s push (no approver) still lands', async () => {
  await db.exec(`INSERT INTO public.float_transactions (type, amount) VALUES ('float_in', 1000)`);
  await db.exec(`INSERT INTO public.expenses (description, amount) VALUES ('Water', 80)`);
});
await ok('it runs twice without error and records itself once', async () => {
  await db.exec(SQL);
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '118_payout_approval'`)).rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
