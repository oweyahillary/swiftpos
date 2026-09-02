/**
 * expense-id-repair.test.mjs — A179.
 *
 * A till minted expense ids as `exp_<ts>_<rand>` (not a UUID). The cloud
 * expenses.id is uuid, so the row 500s (22P02) and — batched with shifts/days/
 * floats — blocks all of them. The generator is fixed to uuid(); this covers the
 * startup self-heal that repairs rows already stuck in the field.
 */
import assert from 'assert';
import Module from 'module';
import { randomUUID } from 'node:crypto';

const require0 = Module.createRequire(new URL('../package.json', import.meta.url).pathname);
let db, driver;
try { db = new (require0('better-sqlite3'))(':memory:'); driver = 'better-sqlite3'; }
catch { const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(':memory:'); driver = 'node:sqlite'; }

db.exec(`CREATE TABLE expenses (id TEXT PRIMARY KEY, sync_status TEXT)`);
db.prepare(`INSERT INTO expenses VALUES ('exp_1787776714494_w0ash','pending')`).run();       // the field bug
db.prepare(`INSERT INTO expenses VALUES ('11111111-2222-3333-4444-555555555555','pending')`).run(); // already good
db.prepare(`INSERT INTO expenses VALUES ('exp_already_sent_xyz','synced')`).run();           // bad id but already synced — must NOT touch

// The exact self-heal from localDb.ts.
const repair = () => {
  const bad = db.prepare(`SELECT id FROM expenses WHERE sync_status='pending' AND id NOT GLOB '*-*-*-*-*'`).all();
  const fix = db.prepare(`UPDATE expenses SET id=? WHERE id=?`);
  for (const r of bad) fix.run(randomUUID(), r.id);
  return bad.length;
};

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

console.log(`expense id repair (driver: ${driver})\n`);

const n = repair();
ok('exactly one pending non-UUID id was repaired', n === 1);
ok('the bad pending id is now a valid UUID',
  isUuid(db.prepare(`SELECT id FROM expenses WHERE sync_status='pending' AND id NOT LIKE '11111111%'`).get()?.id ?? ''));
ok('the already-good pending id is untouched',
  !!db.prepare(`SELECT 1 FROM expenses WHERE id='11111111-2222-3333-4444-555555555555'`).get());
ok('a SYNCED bad id is NOT touched (never re-key what the cloud already has)',
  !!db.prepare(`SELECT 1 FROM expenses WHERE id='exp_already_sent_xyz'`).get());
ok('idempotent: a second pass repairs nothing', repair() === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
