/**
 * offline-signin-write.test.mjs — A167.
 *
 * The offline-auth-fallback test models the ROUTING decision (5xx → fall back,
 * 401 → final reject) and is correct, but it never runs signInLocal, so it never
 * writes a row through the real staff_session schema — and that write is where
 * the bug lived: `token TEXT NOT NULL` (localDb.ts) vs an INSERT of `token=NULL`,
 * which throws `NOT NULL constraint failed: staff_session.token` the moment the
 * cloud is unreachable and the offline path runs. Rules 8 and 24: a passing
 * routing assertion cannot prove the write it routes to succeeds.
 *
 * This test builds the REAL staff_session schema and runs the REAL statement
 * signInLocal issues, so a future column change that breaks the offline write is
 * caught on the bench instead of on a till during an outage.
 *
 * Engine note (rule 9): node:sqlite on Linux/Node 22 here, not the target's
 * better-sqlite3 under Electron. NOT NULL is standard SQLite and identical
 * across builds, so this is a strong claim about the constraint; the full
 * Electron IPC path is still target-only (rule 16).
 */
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); } };

// EXACT copy of the staff_session block in apps/desktop/src/main/localDb.ts.
// Kept verbatim on purpose: if the schema drifts, update it here and the test
// re-proves the offline write against the new shape.
const STAFF_SESSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS staff_session (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    staff_id      TEXT NOT NULL,
    staff_name    TEXT NOT NULL,
    role_name     TEXT,
    branch_id     TEXT NOT NULL,
    branch_name   TEXT,
    permissions   TEXT NOT NULL DEFAULT '{}',
    token         TEXT NOT NULL,
    refresh_token TEXT,
    logged_in_at  TEXT NOT NULL
  );`;

// The exact statement signInLocal runs (ipcHandlers.ts). tokenSql is the only
// variable: '' is the fix, NULL is the pre-A167 defect used for the mutation.
function offlineSignInInsert(db, tokenSql) {
  db.prepare(`
    INSERT INTO staff_session
      (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ${tokenSql}, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      staff_id=excluded.staff_id, staff_name=excluded.staff_name, role_name=excluded.role_name,
      branch_id=excluded.branch_id, branch_name=excluded.branch_name, permissions=excluded.permissions,
      token=${tokenSql}, refresh_token=NULL, logged_in_at=excluded.logged_in_at
  `).run('s1', 'Eugene', 'cashier', 'b1', 'Main', '{}', new Date().toISOString());
}

function freshDb() { const db = new DatabaseSync(':memory:'); db.exec(STAFF_SESSION_SCHEMA); return db; }

// 1. The fix: an offline sign-in row inserts cleanly with token=''.
{
  const db = freshDb();
  let threw = null;
  try { offlineSignInInsert(db, `''`); } catch (e) { threw = e.message; }
  ok('offline sign-in INSERT (token="") succeeds', threw === null);
  const row = db.prepare(`SELECT token, staff_name FROM staff_session WHERE id=1`).get();
  ok('row is written and readable', row && row.staff_name === 'Eugene');
  ok('token stored as empty string, not null', row && row.token === '');
}

// 2. Re-sign-in on the same till hits ON CONFLICT DO UPDATE — must also hold.
{
  const db = freshDb();
  let threw = null;
  try { offlineSignInInsert(db, `''`); offlineSignInInsert(db, `''`); } catch (e) { threw = e.message; }
  ok('second offline sign-in (ON CONFLICT UPDATE) succeeds', threw === null);
}

// 3. MUTATION (rules 10, 23): reintroduce token=NULL and confirm the test goes
//    red naming the right column — i.e. the assertion measures the write, not
//    just the routing.
{
  const db = freshDb();
  let threw = null;
  try { offlineSignInInsert(db, 'NULL'); } catch (e) { threw = e.message; }
  ok('mutation: token=NULL throws NOT NULL on staff_session.token',
     threw === 'NOT NULL constraint failed: staff_session.token');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
