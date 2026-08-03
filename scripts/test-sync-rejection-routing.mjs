#!/usr/bin/env node
/**
 * test-sync-rejection-routing.mjs — the /api/sync/push rejection block, executed.
 *
 * The bug this proves is invisible to every other gate. The server rejects a row
 * and names its table; the client applied EVERY rejection to `shifts`. For a
 * business_day id that UPDATE matches zero rows — SQLite reports changes:0 and
 * raises nothing — and the row was then marked 'synced' by the commit loop that
 * followed. A refused trading day was recorded as delivered and never retried.
 *
 * tsc cannot see it (the SQL is a string), check-sql-binds cannot see it (the
 * placeholders ARE bound), and check-own-rows cannot see it (the query is keyed).
 * Only running it shows anything, so this runs it.
 *
 * Uses node:sqlite rather than better-sqlite3 — the native binding cannot be
 * built in every environment, and the SQL under test is the artefact that
 * matters, not the driver wrapping it. Both are SQLite.
 *
 *   node scripts/test-sync-rejection-routing.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from './lib/sqlite-open.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Prefers better-sqlite3 — the driver the app actually uses — and falls back to
// node:sqlite only where it is available. Which one ran is printed, because a
// pass against a different engine than the app is a weaker claim than it looks.
const { db: _probe, driver: DRIVER, isAppDriver: IS_APP_DRIVER } = openSqlite(REPO, ':memory:');
_probe.close();
const openMemoryDb = () => openSqlite(REPO, ':memory:').db;

console.log(`\ndriver: ${DRIVER}`);
let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** The four push tables, with the column shapes that matter here. */
function freshDb() {
  const db = openMemoryDb();
  db.exec(`
    CREATE TABLE shifts (
      id TEXT PRIMARY KEY, status TEXT, notes TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE business_days (
      id TEXT PRIMARY KEY, status TEXT, notes TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending');
    -- No notes column. This is the real local schema, and the reason the fix
    -- cannot simply write the reason into all four tables.
    CREATE TABLE float_transactions (
      id TEXT PRIMARY KEY, reason TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE expenses (
      id TEXT PRIMARY KEY, description TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending');
  `);
  db.exec(`
    INSERT INTO shifts (id, status) VALUES ('shift-1','open'), ('shift-2','open');
    INSERT INTO business_days (id, status) VALUES ('day-1','open');
    INSERT INTO float_transactions (id) VALUES ('float-1');
    INSERT INTO expenses (id) VALUES ('exp-1');
  `);
  return db;
}

const status = (db, table, id) =>
  db.prepare(`SELECT sync_status, ${table === 'float_transactions' || table === 'expenses'
    ? `NULL AS notes` : 'notes'} FROM ${table} WHERE id=?`).get(id);

// The push payload this pass collected, and what the server said about it.
const PAYLOAD = {
  shifts:             [{ id: 'shift-1', status: 'open' }, { id: 'shift-2', status: 'open' }],
  floats:             [{ id: 'float-1' }],
  expenses:           [{ id: 'exp-1' }],
  business_days:      [{ id: 'day-1' }],
};
const REJECTED = [{
  id: 'day-1',
  code: 'duplicate_open_day',
  table: 'business_days',
  error: 'This till already has an open trading day. It must be closed before this one can sync.',
}];

// ── 1. The old behaviour, reproduced ────────────────────────────────────────
console.log('\n1. OLD behaviour — every rejection applied to `shifts`');
{
  const db = freshDb();
  const mark = db.prepare(
    `UPDATE shifts SET sync_status='conflict',
     notes = TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?`);

  let threw = null;
  let changes = null;
  try { changes = mark.run(`Sync rejected: ${REJECTED[0].error}`, REJECTED[0].id).changes; }
  catch (e) { threw = e; }

  ok('the wrong-table UPDATE does not throw', threw === null,
     threw ? String(threw.message) : '');
  ok('the wrong-table UPDATE changes 0 rows (silent)', changes === 0, `changes=${changes}`);

  // The commit loop, exactly as it was: unconditional over business_days.
  const markDay = db.prepare(`UPDATE business_days SET sync_status='synced' WHERE id=?`);
  for (const d of PAYLOAD.business_days) markDay.run(d.id);

  const day = status(db, 'business_days', 'day-1');
  ok('THE BUG: the refused trading day is marked synced', day.sync_status === 'synced',
     `sync_status=${day.sync_status}`);
  ok('THE BUG: no reason is recorded anywhere', day.notes === null, `notes=${day.notes}`);
  db.close();
}

// ── 2. The new behaviour ────────────────────────────────────────────────────
console.log('\n2. NEW behaviour — routed to the table the server named');
{
  const db = freshDb();

  const TABLE_BY_CODE = {
    duplicate_open_day:   'business_days',
    missing_business_day: 'shifts',
    duplicate_open_shift: 'shifts',
  };
  const VALID = new Set(['shifts', 'business_days', 'float_transactions', 'expenses']);
  const tableOf = r => {
    const t = r.table ?? TABLE_BY_CODE[r.code];
    return VALID.has(t) ? t : null;
  };

  const rejectedByTable = {
    shifts: new Set(), business_days: new Set(),
    float_transactions: new Set(), expenses: new Set(),
  };
  const unrouted = [];

  const withNote = t => db.prepare(
    `UPDATE ${t} SET sync_status='conflict',
     notes = TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?`);
  const stmt = {
    shifts: withNote('shifts'),
    business_days: withNote('business_days'),
    float_transactions: db.prepare(`UPDATE float_transactions SET sync_status='conflict' WHERE id=?`),
    expenses: db.prepare(`UPDATE expenses SET sync_status='conflict' WHERE id=?`),
  };

  for (const r of REJECTED) {
    const t = tableOf(r);
    if (!t) { unrouted.push(r); continue; }
    rejectedByTable[t].add(r.id);
    if (t === 'shifts' || t === 'business_days') stmt[t].run(`Sync rejected: ${r.error}`, r.id);
    else stmt[t].run(r.id);
  }

  const markShift = db.prepare(`UPDATE shifts SET sync_status='synced' WHERE id=?`);
  const markFloat = db.prepare(`UPDATE float_transactions SET sync_status='synced' WHERE id=?`);
  const markExp   = db.prepare(`UPDATE expenses SET sync_status='synced' WHERE id=?`);
  const markDay   = db.prepare(`UPDATE business_days SET sync_status='synced' WHERE id=?`);
  for (const s of PAYLOAD.shifts) if (s.status !== 'closed' && !rejectedByTable.shifts.has(s.id)) markShift.run(s.id);
  for (const f of PAYLOAD.floats)        if (!rejectedByTable.float_transactions.has(f.id)) markFloat.run(f.id);
  for (const e of PAYLOAD.expenses)      if (!rejectedByTable.expenses.has(e.id))           markExp.run(e.id);
  for (const d of PAYLOAD.business_days) if (!rejectedByTable.business_days.has(d.id))      markDay.run(d.id);

  const day = status(db, 'business_days', 'day-1');
  ok('the refused day is conflict, not synced', day.sync_status === 'conflict',
     `sync_status=${day.sync_status}`);
  ok('the server\'s own reason is recorded on the day',
     typeof day.notes === 'string' && day.notes.includes('open trading day'), `notes=${day.notes}`);
  ok('no shift was touched by a business_days rejection',
     status(db, 'shifts', 'shift-1').notes === null);
  ok('accepted shifts still reach synced',
     status(db, 'shifts', 'shift-1').sync_status === 'synced' &&
     status(db, 'shifts', 'shift-2').sync_status === 'synced');
  ok('accepted floats and expenses still reach synced',
     status(db, 'float_transactions', 'float-1').sync_status === 'synced' &&
     status(db, 'expenses', 'exp-1').sync_status === 'synced');
  db.close();
}

// ── 3. Why the note is not written to all four ──────────────────────────────
console.log('\n3. float_transactions/expenses have no `notes` column');
{
  const db = freshDb();
  let threw = null;
  try {
    db.prepare(`UPDATE float_transactions SET sync_status='conflict',
      notes = TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?`).run('x', 'float-1');
  } catch (e) { threw = e; }
  ok('writing notes to float_transactions throws', threw !== null,
     threw ? '' : 'it did not throw — check the local schema');
  ok('the status-only UPDATE used instead does not throw', (() => {
    try { db.prepare(`UPDATE float_transactions SET sync_status='conflict' WHERE id=?`).run('float-1'); return true; }
    catch { return false; }
  })());
  db.close();
}

// ── 4. An older server that does not send `table` ───────────────────────────
console.log('\n4. Code-map fallback, and an unknown code');
{
  const TABLE_BY_CODE = {
    duplicate_open_day:   'business_days',
    missing_business_day: 'shifts',
    duplicate_open_shift: 'shifts',
  };
  const VALID = new Set(['shifts', 'business_days', 'float_transactions', 'expenses']);
  const tableOf = r => { const t = r.table ?? TABLE_BY_CODE[r.code]; return VALID.has(t) ? t : null; };

  ok('old server, no table field, day code → business_days',
     tableOf({ id: 'day-1', code: 'duplicate_open_day', error: '' }) === 'business_days');
  ok('old server, no table field, shift code → shifts',
     tableOf({ id: 'shift-1', code: 'duplicate_open_shift', error: '' }) === 'shifts');
  ok('unknown code is NOT defaulted to shifts',
     tableOf({ id: '?', code: 'some_future_code', error: '' }) === null);
  ok('a table this build does not know is refused, not coerced',
     tableOf({ id: '?', code: 'x', table: 'payments', error: '' }) === null);
}

// ── 5. Unknown rejections must not be marked synced ─────────────────────────
console.log('\n5. An unroutable rejection parks the row rather than losing it');
{
  const db = freshDb();
  const VALID = new Set(['shifts', 'business_days', 'float_transactions', 'expenses']);
  const TABLE_BY_CODE = { duplicate_open_day: 'business_days',
                          missing_business_day: 'shifts', duplicate_open_shift: 'shifts' };
  const tableOf = r => { const t = r.table ?? TABLE_BY_CODE[r.code]; return VALID.has(t) ? t : null; };

  const rejectedByTable = { shifts: new Set(), business_days: new Set(),
                            float_transactions: new Set(), expenses: new Set() };
  const unrouted = [];

  // Exactly the loop in syncEngine, not a stub of it. The first version of this
  // fix pushed unroutable rejections onto `unrouted` and nothing else, which left
  // them out of every set — so the commit loop below marked them synced anyway.
  // That is the original bug one branch further along, and this section is what
  // found it.
  for (const r of [{ id: 'day-1', code: 'some_future_code', error: 'refused' }]) {
    const t = tableOf(r);
    if (!t) { unrouted.push(r); for (const s of Object.values(rejectedByTable)) s.add(r.id); continue; }
    rejectedByTable[t].add(r.id);
  }

  const markDay = db.prepare(`UPDATE business_days SET sync_status='synced' WHERE id=?`);
  for (const d of PAYLOAD.business_days) if (!rejectedByTable.business_days.has(d.id)) markDay.run(d.id);

  ok('an unroutable rejection leaves the row pending for the next pass',
     status(db, 'business_days', 'day-1').sync_status === 'pending');
  ok('and it is reported rather than swallowed', unrouted.length === 1);

  // The other three tables must still push normally in the same pass — one
  // unknown rejection cannot stall the rest of the cash push.
  const markShift = db.prepare(`UPDATE shifts SET sync_status='synced' WHERE id=?`);
  for (const s of PAYLOAD.shifts) if (!rejectedByTable.shifts.has(s.id)) markShift.run(s.id);
  ok('unrelated rows in the same pass still reach synced',
     status(db, 'shifts', 'shift-1').sync_status === 'synced');
  db.close();
}

console.log(`\n${passed} passed, ${failed} failed` + (IS_APP_DRIVER
  ? ' — against the app\'s own driver\n'
  : `\n\nNOTE: this ran on ${DRIVER}.\n`
    + 'Run it once with better-sqlite3 (npm i --no-save better-sqlite3 at the repo\n'
    + 'root) to prove these hold on the engine the till actually uses.\n'));
process.exit(failed ? 1 : 0);
