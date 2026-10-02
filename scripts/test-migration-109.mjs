/**
 * test-migration-109.mjs — A361: expenses.recorded_by (who entered an expense). Against real Postgres (PGlite). Every
 * assertion is awaited (the A305 lesson).
 *
 * MUTATIONS TO CONFIRM BITE: backfill without `shift_id IS NOT NULL` → "a web row is NOT guessed" fails; drop the
 * foreign key → "a recorder that is not a staff member is refused" fails.
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
const SQL109 = fs.readFileSync(path.join(ROOT, 'migrations/109_expense_recorded_by.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const CASHIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANAGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHIFT   = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

console.log('\nMigration 109 (expenses.recorded_by) — PGlite\n');
await (async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
    CREATE TABLE public.users (id uuid PRIMARY KEY, name text);
    INSERT INTO public.users VALUES ('${CASHIER}', 'Cashier Jane'), ('${MANAGER}', 'Manager Tom');
    CREATE TABLE public.expenses (
      id serial PRIMARY KEY, description text NOT NULL, amount numeric NOT NULL,
      paid_by uuid REFERENCES public.users(id) ON DELETE SET NULL, shift_id uuid
    );
    -- a till expense (synced: shift_id set, paid_by = the till's signed-in staff)
    INSERT INTO public.expenses (description, amount, paid_by, shift_id) VALUES ('Gas', 500, '${CASHIER}', '${SHIFT}');
    -- a web expense: "Paid By" picked on the form — NOT necessarily who typed it
    INSERT INTO public.expenses (description, amount, paid_by, shift_id) VALUES ('Rent', 9000, '${MANAGER}', NULL);
    -- a web expense with no Paid By at all
    INSERT INTO public.expenses (description, amount, paid_by, shift_id) VALUES ('Water', 300, NULL, NULL);
  `);
  await db.exec(SQL109);

  await ok('a till expense gets its recorder from the till\'s signed-in staff (paid_by)', async () => {
    const r = await db.query(`SELECT recorded_by FROM public.expenses WHERE description='Gas'`);
    assert.strictEqual(r.rows[0].recorded_by, CASHIER);
  });
  await ok('a web row is NOT guessed from its Paid By pick — nobody knows who typed it', async () => {
    const r = await db.query(`SELECT description, recorded_by FROM public.expenses WHERE shift_id IS NULL ORDER BY id`);
    assert.deepStrictEqual(r.rows.map((x) => x.recorded_by), [null, null]);
  });
  await ok('a recorder that is not a staff member is refused (foreign key to users)', async () => {
    const e = await threw(() => db.exec(`UPDATE public.expenses SET recorded_by='dddddddd-dddd-4ddd-8ddd-dddddddddddd' WHERE description='Water'`));
    assert.ok(e && /expenses_recorded_by_fkey/.test(e.message), e?.message);
  });
  await ok('a staff member removed later leaves the expense, recorder NULL', async () => {
    await db.exec(`INSERT INTO public.users VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Temp')`);
    await db.exec(`UPDATE public.expenses SET recorded_by='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' WHERE description='Water'`);
    await db.exec(`DELETE FROM public.users WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'`);
    const r = await db.query(`SELECT recorded_by FROM public.expenses WHERE description='Water'`);
    assert.strictEqual(r.rows[0].recorded_by, null);
  });
  await ok('idempotent: running 109 again changes nothing, one migration row', async () => {
    await db.exec(SQL109);
    const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='109_expense_recorded_by'`);
    assert.strictEqual(r.rows[0].n, 1);
    const g = await db.query(`SELECT recorded_by FROM public.expenses WHERE description='Gas'`);
    assert.strictEqual(g.rows[0].recorded_by, CASHIER);
  });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
