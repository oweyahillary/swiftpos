/**
 * test-migration-107.mjs — A338: a till's open drawer always syncs, even while another drawer (the web POS standing in
 * for that till) is open on the same terminal. Against real Postgres (PGlite): migration 63 (the unique index), the
 * owner's failure reproduced, then 107.
 * Every assertion is awaited (the A305 lesson: an un-awaited body races db.close() and the runner hangs).
 *
 * MUTATION TO CONFIRM BITE: make 107's index UNIQUE again → "after 107: the till's drawer lands" and
 * "…and its sale lands" fail.
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
const SQL63  = fs.readFileSync(path.join(ROOT, 'migrations/63_shift_drawer_sessions.sql'), 'utf8');
const SQL107 = fs.readFileSync(path.join(ROOT, 'migrations/107_open_shifts_never_block_sync.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('\nMigration 107 (open drawers never block sync) — PGlite\n');
await (async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
    CREATE TABLE public.shifts (
      id uuid PRIMARY KEY, business_id uuid NOT NULL, branch_id uuid NOT NULL, cashier_id uuid,
      device_id text, terminal_code text, status varchar(30) NOT NULL DEFAULT 'open',
      opened_at timestamptz NOT NULL DEFAULT now(), opening_float numeric DEFAULT 0
    );
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY, business_id uuid NOT NULL, total numeric,
      shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL
    );
  `);
  await db.exec(SQL63);
  const B = '00000000-0000-0000-0000-0000000000bb', BR = '00000000-0000-0000-0000-0000000000b1';
  const WEB = '00000000-0000-0000-0000-00000000000a', TILL = '00000000-0000-0000-0000-00000000000b';
  // The web POS opened a drawer AS T1 (it adopts the till's device id, A273).
  await db.exec(`INSERT INTO public.shifts (id, business_id, branch_id, device_id, terminal_code, status) VALUES ('${WEB}', '${B}', '${BR}', 'dev-T1', 'T1', 'open')`);
  // The till's own drawer, already trading, arrives at /api/sync/push (upsert by id).
  const pushTill = () => db.exec(`INSERT INTO public.shifts (id, business_id, branch_id, device_id, terminal_code, status)
                                  VALUES ('${TILL}', '${B}', '${BR}', 'dev-T1', 'T1', 'open') ON CONFLICT (id) DO NOTHING`);
  const saleOnTill = () => db.exec(`INSERT INTO public.orders (id, business_id, total, shift_id) VALUES (gen_random_uuid(), '${B}', 1490, '${TILL}')`);

  await ok('BEFORE 107 (the owner\'s failure): the till\'s drawer is refused (23505) while the web\'s is open', async () => {
    const e = await threw(pushTill);
    assert.ok(e && /duplicate key|unique/i.test(e.message), e?.message ?? 'no error');
  });
  await ok('…and so is every sale on it (orders.shift_id → a drawer the cloud refused)', async () => {
    const e = await threw(saleOnTill);
    assert.ok(e && /foreign key/i.test(e.message), e?.message ?? 'no error');
  });

  await db.exec(SQL107);
  await ok('after 107: the till\'s drawer lands next to the web\'s — both open on T1', async () => {
    await pushTill();
    const r = await db.query(`SELECT count(*)::int AS n FROM public.shifts WHERE status='open' AND device_id='dev-T1'`);
    assert.strictEqual(r.rows[0].n, 2);
  });
  await ok('…and its sale lands', async () => {
    await saleOnTill();
    const r = await db.query(`SELECT count(*)::int AS n FROM public.orders WHERE shift_id='${TILL}'`);
    assert.strictEqual(r.rows[0].n, 1);
  });
  await ok('the old unique index is gone; a plain index on the same key serves the lookups', async () => {
    const r = await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='shifts' AND indexname IN ('shifts_one_open_per_terminal','shifts_open_by_terminal')`);
    assert.deepStrictEqual(r.rows.map((x) => x.indexname), ['shifts_open_by_terminal']);
    assert.ok(!/UNIQUE/i.test(r.rows[0].indexdef) && /shift_terminal_key/.test(r.rows[0].indexdef) && /status.*open/i.test(r.rows[0].indexdef), r.rows[0].indexdef);
  });
  await ok('idempotent: running 107 again changes nothing', async () => {
    await db.exec(SQL107);
    const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='107_open_shifts_never_block_sync'`);
    assert.strictEqual(r.rows[0].n, 1);
  });
  await ok('the app still refuses a SECOND drawer opened by hand (POST /api/shifts/open checks before insert)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/shifts.ts'), 'utf8');
    const open = src.slice(src.indexOf("router.post('/open'"), src.indexOf("router.post('/open'") + 3500);
    assert.match(open, /if \(onThisTerminal\.length > 0\) \{[\s\S]{0,80}res\.status\(409\)/);
  });
  await db.close();
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
