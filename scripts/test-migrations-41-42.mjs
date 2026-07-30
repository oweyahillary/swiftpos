#!/usr/bin/env node
/**
 * test-migrations-41-42.mjs — execute migration 41 against a real PostgreSQL.
 *
 * Migration 41 introduces the trading-day model the tills enforce, and it is the
 * first migration in this repo carrying a partial unique index, an expression
 * index and a widened CHECK constraint — three things that either work or take
 * production down, with no middle ground and no way to tell by reading.
 *
 * This runs the file verbatim against PGlite (PostgreSQL compiled to WASM) on a
 * fixture reproducing 00_baseline.sql's shifts/orders/businesses/branches, then
 * asserts the behaviour rather than the absence of an error. Re-applies the file
 * a second time to prove idempotency, since it will be run against dev, staging
 * and each branch's database in turn.
 *
 *   npm i --no-save @electric-sql/pglite && node scripts/test-migrations-41-42.mjs
 *
 * PGlite tracks a newer PostgreSQL major than Supabase runs, so this proves the
 * SQL is valid and the semantics hold; it is not a substitute for applying the
 * migration to a staging copy of the real database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG  = path.join(ROOT, 'migrations', '41_business_days_and_shift_attribution.sql');
const MIG2 = path.join(ROOT, 'migrations', '42_one_open_shift_per_cashier.sql');

// Optional dev-only dependency, deliberately not in package.json: this is a
// verification tool, not something the app or the build needs.
let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('@electric-sql/pglite is not installed.\n  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const db = await PGlite.create();

// ── Fixture: the objects migration 41 depends on, faithful to 00_baseline.sql ──
// auth.uid() is Supabase-provided; stubbed so the RLS policy body compiles.
const fixture = `
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

  CREATE TABLE public.schema_migrations (
    version     text        PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    applied_by  text        NOT NULL DEFAULT current_user,
    notes       text
  );

  CREATE TABLE public.businesses (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid
  );

  CREATE TABLE public.branches (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL
  );

  -- Verbatim from 00_baseline.sql (lines 1579-1596) + migration 22's additions.
  CREATE TABLE public.shifts (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      business_id uuid NOT NULL,
      branch_id uuid NOT NULL,
      cashier_id uuid NOT NULL,
      opened_at timestamp with time zone DEFAULT now() NOT NULL,
      closed_at timestamp with time zone,
      status text DEFAULT 'open'::text NOT NULL,
      opening_float numeric(12,2) DEFAULT 0 NOT NULL,
      closing_float numeric(12,2),
      expected_cash numeric(12,2),
      cash_variance numeric(12,2),
      notes text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      denomination_breakdown jsonb,
      CONSTRAINT shifts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
  );
  ALTER TABLE ONLY public.shifts ADD CONSTRAINT shifts_pkey PRIMARY KEY (id);

  CREATE TABLE public.orders (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_id  uuid,
    device_id text
  );
`;

await db.exec(fixture);

// ── Seed rows that exercise the backfill arms ────────────────────────────────
const biz = (await db.query(`INSERT INTO businesses (owner_id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
const br  = (await db.query(`INSERT INTO branches (business_id) VALUES ($1) RETURNING id`, [biz])).rows[0].id;

const mk = async (openedAt) => (await db.query(
  `INSERT INTO shifts (business_id, branch_id, cashier_id, opened_at, status)
   VALUES ($1,$2,gen_random_uuid(),$3,'closed') RETURNING id`, [biz, br, openedAt])).rows[0].id;

// A shift whose orders all came from one till -> device_id should be recovered.
const sA = await mk('2026-07-28T05:30:00Z');
await db.query(`INSERT INTO orders (shift_id, device_id) VALUES ($1,'till-1'),($1,'till-1')`, [sA]);

// A shift whose orders disagree -> must stay NULL rather than guess.
const sB = await mk('2026-07-28T06:00:00Z');
await db.query(`INSERT INTO orders (shift_id, device_id) VALUES ($1,'till-1'),($1,'till-2')`, [sB]);

// A shift opened 22:30 UTC = 01:30 next day Nairobi -> tests the tz backfill.
const sC = await mk('2026-07-28T22:30:00Z');

// ── Run the migration verbatim ───────────────────────────────────────────────
await db.exec(fs.readFileSync(MIG, 'utf8'));
console.log('migration 41 applied cleanly');

// ── Assertions ───────────────────────────────────────────────────────────────
const fail = [];
const check = (label, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ` -> got ${JSON.stringify(got)}`}`); if (!cond) fail.push(label); };

const dev = async (id) => (await db.query(`SELECT device_id, business_date FROM shifts WHERE id=$1`, [id])).rows[0];

const a = await dev(sA), b = await dev(sB), c = await dev(sC);
check('device_id recovered when orders agree', a.device_id === 'till-1', a.device_id);
check('device_id left NULL when orders disagree', b.device_id === null, b.device_id);
check('business_date backfilled', a.business_date !== null, a.business_date);
// The driver hands back a JS Date for a `date` column, so normalise before
// comparing — otherwise this asserts on the serialisation, not the value.
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
check('22:30Z rolls to next Nairobi date', ymd(c.business_date) === '2026-07-29', ymd(c.business_date));
check('05:30Z stays on the same Nairobi date', ymd(a.business_date) === '2026-07-28', ymd(a.business_date));

// closed_unreconciled must now be accepted.
try {
  await db.query(`UPDATE shifts SET status='closed_unreconciled' WHERE id=$1`, [sA]);
  check('status closed_unreconciled accepted', true);
} catch (e) { check('status closed_unreconciled accepted', false, e.message); }

// Junk status must still be rejected.
try {
  await db.query(`UPDATE shifts SET status='banana' WHERE id=$1`, [sA]);
  check('invalid status still rejected', false, 'accepted banana');
} catch { check('invalid status still rejected', true); }

// One open day per till.
await db.query(`INSERT INTO business_days (business_id, branch_id, device_id, business_date)
                VALUES ($1,$2,'till-1','2026-07-28')`, [biz, br]);
try {
  await db.query(`INSERT INTO business_days (business_id, branch_id, device_id, business_date)
                  VALUES ($1,$2,'till-1','2026-07-29')`, [biz, br]);
  check('second open day on same till blocked', false, 'insert succeeded');
} catch { check('second open day on same till blocked', true); }

// A different till is unaffected.
try {
  await db.query(`INSERT INTO business_days (business_id, branch_id, device_id, business_date)
                  VALUES ($1,$2,'till-2','2026-07-29')`, [biz, br]);
  check('other till can still open its day', true);
} catch (e) { check('other till can still open its day', false, e.message); }

// Once closed, the same till may open the next day.
await db.query(`UPDATE business_days SET status='closed' WHERE device_id='till-1'`);
try {
  await db.query(`INSERT INTO business_days (business_id, branch_id, device_id, business_date)
                  VALUES ($1,$2,'till-1','2026-07-29')`, [biz, br]);
  check('till reopens after previous day closed', true);
} catch (e) { check('till reopens after previous day closed', false, e.message); }

// Duplicate day rows for the same till+date must be impossible.
try {
  await db.query(`INSERT INTO business_days (business_id, branch_id, device_id, business_date, status)
                  VALUES ($1,$2,'till-2','2026-07-29','closed')`, [biz, br]);
  check('duplicate till+date blocked', false, 'insert succeeded');
} catch { check('duplicate till+date blocked', true); }

// close_method is constrained.
try {
  await db.query(`UPDATE shifts SET close_method='guessed' WHERE id=$1`, [sA]);
  check('close_method constrained', false, 'accepted guessed');
} catch { check('close_method constrained', true); }

// Custody columns: a drawer that moves between tills must still record cleanly,
// and two shifts on the SAME till must be able to name DIFFERENT drawers.
await db.query(
  `UPDATE shifts SET device_id='till-1', drawer_label='Drawer 2', opened_by=gen_random_uuid() WHERE id=$1`, [sB]);
await db.query(
  `UPDATE shifts SET drawer_label='Drawer 1' WHERE id=$1`, [sA]);
const drawers = await db.query(
  `SELECT drawer_label, opened_by FROM shifts WHERE device_id='till-1' ORDER BY drawer_label`);
check('same till can record different drawers',
  drawers.rows.map(r => r.drawer_label).join(',') === 'Drawer 1,Drawer 2',
  drawers.rows.map(r => r.drawer_label));
check('opened_by recorded separately from cashier_id', drawers.rows.some(r => r.opened_by !== null));

// The same drawer moving to another till must NOT collide with anything —
// drawers are labels, not entities, so nothing is unique on them.
try {
  await db.query(`UPDATE shifts SET device_id='till-3', drawer_label='Drawer 2' WHERE id=$1`, [sC]);
  check('a drawer label may appear on another till', true);
} catch (e) { check('a drawer label may appear on another till', false, e.message); }

// Idempotency: re-running the whole file must be a no-op.
try {
  await db.exec(fs.readFileSync(MIG, 'utf8'));
  check('41 is idempotent on re-run', true);
} catch (e) { check('41 is idempotent on re-run', false, e.message); }

// ── One open shift per cashier, business-wide ────────────────────────────────
// The scenario this exists for: cashier A abandons a drawer on till A, then
// works till B the next day. Till B cannot see till A's SQLite, so only the
// database can stop the second open shift landing.
const cashier = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
const openOn = (dev, at) => db.query(
  `INSERT INTO shifts (business_id, branch_id, cashier_id, device_id, opened_at, status, business_date)
   VALUES ($1,$2,$3,$4,$5,'open',$6)`, [biz, br, cashier, dev, at, at.slice(0, 10)]);

await openOn('till-A', '2026-07-28T06:00:00Z');

// 41 is ADDITIVE ONLY. It must NOT reject a second open shift — that is the
// point of the split: 41 can be applied to a live database without any chance of
// failing a sync push. The rule arrives in 42.
try {
  await openOn('till-B', '2026-07-29T06:00:00Z');
  check('41 alone does NOT enforce one-open-per-cashier', true);
} catch (e) { check('41 alone does NOT enforce one-open-per-cashier', false, e.message); }

// Now apply 42. Its pre-flight must resolve the duplicate we just created,
// otherwise CREATE UNIQUE INDEX aborts — which is exactly the state a real
// database will be in.
try {
  await db.exec(fs.readFileSync(MIG2, 'utf8'));
  check('42 applies over pre-existing duplicates', true);
} catch (e) { check('42 applies over pre-existing duplicates', false, e.message); }

const openForCashier = await db.query(
  `SELECT COUNT(*)::int AS n FROM shifts WHERE cashier_id=$1 AND status='open'`, [cashier]);
check('42 pre-flight leaves exactly one open shift', openForCashier.rows[0].n === 1, openForCashier.rows[0].n);

try {
  await openOn('till-C', '2026-07-30T06:00:00Z');
  check('42 now blocks a second open shift', false, 'insert succeeded');
} catch { check('42 now blocks a second open shift', true); }

// A manager force-closing the abandoned drawer must release the cashier at once.
// Clear whatever is still open for them — after 42's pre-flight that is the
// newest shift, not necessarily the one on till-A.
await db.query(
  `UPDATE shifts SET status='closed_unreconciled', close_method='forced'
    WHERE cashier_id=$1 AND status='open'`, [cashier]);
const stillOpen = await db.query(
  `SELECT COUNT(*)::int AS n FROM shifts WHERE cashier_id=$1 AND status='open'`, [cashier]);
check('force-close leaves no open shift for the cashier', stillOpen.rows[0].n === 0, stillOpen.rows[0].n);
try {
  await openOn('till-B', '2026-07-30T07:00:00Z');
  check('force-close releases the cashier', true);
} catch (e) { check('force-close releases the cashier', false, e.message); }

// closed_unreconciled must be OUTSIDE the index, so a forced close releases the
// cashier immediately rather than leaving them locked out pending a real count.
const forced = await db.query(
  `SELECT COUNT(*)::int AS n FROM shifts WHERE cashier_id=$1 AND status='closed_unreconciled'`, [cashier]);
check('forced closes are excluded from the unique index', forced.rows[0].n >= 1, forced.rows[0].n);

// A DIFFERENT cashier is unaffected — the rule is per person, not per till.
try {
  await db.query(
    `INSERT INTO shifts (business_id, branch_id, cashier_id, device_id, opened_at, status)
     VALUES ($1,$2,gen_random_uuid(),'till-B',now(),'open')`, [biz, br]);
  check('another cashier unaffected', true);
} catch (e) { check('another cashier unaffected', false, e.message); }

// ── Pre-flight cleanup ───────────────────────────────────────────────────────
// Needs a database where the violation exists BEFORE the migration runs, which
// is the state any real deployment is in. Without the cleanup the CREATE UNIQUE
// INDEX aborts the whole file, so this is the arm that decides whether the
// migration can be applied to production at all.
{
  const db2 = await PGlite.create();
  await db2.exec(fixture);
  const b2 = (await db2.query(`INSERT INTO businesses (owner_id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
  const r2 = (await db2.query(`INSERT INTO branches (business_id) VALUES ($1) RETURNING id`, [b2])).rows[0].id;
  const c2 = (await db2.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;

  // Three open shifts for one cashier — the exact mess sync/push can create.
  for (const at of ['2026-07-26T06:00:00Z', '2026-07-27T06:00:00Z', '2026-07-28T06:00:00Z']) {
    await db2.query(
      `INSERT INTO shifts (business_id, branch_id, cashier_id, opened_at, status, opening_float)
       VALUES ($1,$2,$3,$4,'open',500)`, [b2, r2, c2, at]);
  }

  try {
    await db2.exec(fs.readFileSync(MIG, 'utf8'));
    await db2.exec(fs.readFileSync(MIG2, 'utf8'));
    check('41+42 apply despite pre-existing duplicates', true);
  } catch (e) { check('41+42 apply despite pre-existing duplicates', false, e.message); }

  const after = await db2.query(
    `SELECT status, close_method, closing_float, cash_variance, opened_at
       FROM shifts WHERE cashier_id=$1 ORDER BY opened_at DESC`, [c2]);
  check('newest open shift survives',
    after.rows[0].status === 'open', after.rows[0].status);
  check('older duplicates demoted to closed_unreconciled',
    after.rows.slice(1).every(r => r.status === 'closed_unreconciled' && r.close_method === 'forced'),
    after.rows.slice(1).map(r => r.status));
  check('demoted shifts have NULL cash figures, never 0',
    after.rows.slice(1).every(r => r.closing_float === null && r.cash_variance === null),
    after.rows.slice(1).map(r => [r.closing_float, r.cash_variance]));
}

const rec = await db.query(`SELECT version FROM schema_migrations WHERE version LIKE '4%' ORDER BY version`);
check('both migrations self-record', rec.rows.length === 2, rec.rows.map(r => r.version));

console.log(fail.length ? `\n${fail.length} FAILING` : '\nall green');
process.exit(fail.length ? 1 : 0);
