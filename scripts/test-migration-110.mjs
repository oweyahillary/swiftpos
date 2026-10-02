/**
 * test-migration-110.mjs — A365: a manager confirms every shift (shifts.declared_methods / expected_methods /
 * confirmed_methods / confirmed_by / confirmed_at / confirm_self). Against real Postgres (PGlite). Every assertion is
 * awaited (the A305 lesson).
 *
 * MUTATIONS TO CONFIRM BITE: drop shifts_confirmation_whole → "a half confirmation is refused" fails; drop the foreign
 * key → "a confirmer who is not a staff member is refused" fails.
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
const SQL110 = fs.readFileSync(path.join(ROOT, 'migrations/110_shift_confirmation.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const CASHIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANAGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD     = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW     = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const BIZ     = '11111111-1111-4111-8111-111111111111';

console.log('\nMigration 110 (shift confirmation) — PGlite\n');
await (async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
    CREATE TABLE public.users (id uuid PRIMARY KEY, name text);
    INSERT INTO public.users VALUES ('${CASHIER}', 'Cashier Jane'), ('${MANAGER}', 'Manager Tom');
    CREATE TABLE public.shifts (
      id uuid PRIMARY KEY, business_id uuid NOT NULL, cashier_id uuid, status text NOT NULL DEFAULT 'open',
      closing_float numeric, closed_at timestamptz
    );
    INSERT INTO public.shifts (id, business_id, cashier_id, status, closing_float, closed_at)
      VALUES ('${OLD}', '${BIZ}', '${CASHIER}', 'closed', 24740, now() - interval '1 day');
  `);
  await db.exec(SQL110);

  await ok('a shift closed before 110 is left alone — nothing declared, nothing awaited', async () => {
    const r = await db.query(`SELECT declared_methods, confirmed_at, confirm_self FROM public.shifts WHERE id='${OLD}'`);
    assert.deepStrictEqual(r.rows[0], { declared_methods: null, confirmed_at: null, confirm_self: false });
  });
  await ok('a new close declares every method; it awaits a manager (the dashboard index finds it)', async () => {
    await db.exec(`INSERT INTO public.shifts (id, business_id, cashier_id, status, closing_float, closed_at, declared_methods)
                   VALUES ('${NEW}', '${BIZ}', '${CASHIER}', 'closed', 5500, now(), '{"cash": 5500, "mpesa": 3250, "card": 0}')`);
    const r = await db.query(`SELECT id FROM public.shifts WHERE business_id='${BIZ}' AND declared_methods IS NOT NULL AND confirmed_at IS NULL`);
    assert.deepStrictEqual(r.rows.map((x) => x.id), [NEW]);
    const i = await db.query(`SELECT indexname FROM pg_indexes WHERE indexname='shifts_awaiting_confirmation'`);
    assert.strictEqual(i.rows.length, 1);
  });
  await ok('a half confirmation is refused (who/when without the recount, or the reverse)', async () => {
    const a = await threw(() => db.exec(`UPDATE public.shifts SET confirmed_at = now() WHERE id='${NEW}'`));
    assert.ok(a && /shifts_confirmation_whole/.test(a.message), a?.message);
    const b = await threw(() => db.exec(`UPDATE public.shifts SET confirmed_methods = '{"cash": 5000}' WHERE id='${NEW}'`));
    assert.ok(b && /shifts_confirmation_whole/.test(b.message), b?.message);
  });
  await ok('a whole confirmation lands: the recount, who, when, expected, self flag', async () => {
    await db.exec(`UPDATE public.shifts SET confirmed_methods='{"cash": 5400, "mpesa": 3250, "card": 0}',
                     expected_methods='{"cash": 5500, "mpesa": 3250}', confirmed_by='${MANAGER}', confirmed_at=now(), confirm_self=false
                   WHERE id='${NEW}'`);
    const r = await db.query(`SELECT (confirmed_methods->>'cash')::numeric AS c, confirmed_by FROM public.shifts WHERE id='${NEW}'`);
    assert.strictEqual(Number(r.rows[0].c), 5400);
    assert.strictEqual(r.rows[0].confirmed_by, MANAGER);
  });
  await ok('a confirmer who is not a staff member is refused (foreign key to users)', async () => {
    const e = await threw(() => db.exec(`UPDATE public.shifts SET confirmed_by='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' WHERE id='${NEW}'`));
    assert.ok(e && /shifts_confirmed_by_fkey/.test(e.message), e?.message);
  });
  await ok('idempotent: running 110 again changes nothing, one migration row', async () => {
    await db.exec(SQL110);
    const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='110_shift_confirmation'`);
    assert.strictEqual(r.rows[0].n, 1);
    const g = await db.query(`SELECT confirmed_by FROM public.shifts WHERE id='${NEW}'`);
    assert.strictEqual(g.rows[0].confirmed_by, MANAGER);
  });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
