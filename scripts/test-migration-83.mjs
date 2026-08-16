/**
 * test-migration-83.mjs — the shifts.force_close grant, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A59)
 * -----------------------------
 * Migration 75 REGISTERED shifts.force_close but granted it to no role, and
 * POST /api/shifts/:id/force-close enforced settings.manage — so the dedicated
 * key was inert. The route is now requireAnyPermission('shifts.force_close',
 * 'settings.manage') and the till gates its force-close trigger on
 * has('shifts.force_close') || has('settings.manage'). Migration 83 grants the
 * key to the manager role set so it is real. It must:
 *   - grant to manager, supervisor, branch_manager (and admin/owner);
 *   - match the SAME normalised name set as 75/76/78 ("Branch Manager" w/ space);
 *   - be ADDITIVE — grant only, revoke nothing;
 *   - be idempotent.
 *
 * Like 78, it does NOT self-register the key (75 did), so the fixture
 * pre-registers it — the production shape. Proven by RUNNING it (A30/A62).
 * Picked up by run-migration-tests.mjs's glob.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try {
  ({ PGlite } = require('@electric-sql/pglite'));
} catch {
  console.error('\n@electric-sql/pglite is not installed — this suite cannot run.\n' +
                '  npm i --no-save @electric-sql/pglite\n');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/83_force_close_grant.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

/** Subset of the real schema this migration touches. shifts.force_close is
 *  pre-registered because migration 75 registers it — 83 only grants. */
async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key varchar(100) NOT NULL,
      label varchar(255) NOT NULL DEFAULT '',
      module varchar(100) NOT NULL DEFAULT '',
      CONSTRAINT permissions_key_key UNIQUE (key)
    );
    CREATE TABLE roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(100) NOT NULL
    );
    CREATE TABLE role_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      CONSTRAINT role_permissions_role_id_permission_id_key UNIQUE (role_id, permission_id)
    );
    CREATE TABLE schema_migrations (
      version text PRIMARY KEY, notes text, applied_at timestamptz NOT NULL DEFAULT now()
    );
    -- 75 registered these keys; 83 only touches shifts.force_close.
    INSERT INTO permissions (key) VALUES ('shifts.force_close'), ('settings.manage');
    -- "Branch Manager" with a space is the A61 case; Cashier/Waiter must be missed.
    INSERT INTO roles (name) VALUES
      ('Manager'), ('Supervisor'), ('Branch Manager'), ('Admin'), ('Owner'),
      ('Cashier'), ('Waiter');
  `);
  return db;
}

const grantedRoles = async (db) => (await db.query(
  `SELECT r.name FROM role_permissions rp
   JOIN permissions p ON p.id = rp.permission_id AND p.key = 'shifts.force_close'
   JOIN roles r ON r.id = rp.role_id ORDER BY r.name`)).rows.map(x => x.name);

console.log('\nmigration 83 — shifts.force_close grant\n');

// ── 1. Grants the manager role set ───────────────────────────────────────────
console.log('1. grants shifts.force_close to the manager-level roles');
{
  const db = await fresh();
  await db.exec(SQL);

  const roles = await grantedRoles(db);
  ok('granted to Admin, Branch Manager, Manager, Owner, Supervisor (space name matched)',
     () => assert.deepStrictEqual(roles, ['Admin', 'Branch Manager', 'Manager', 'Owner', 'Supervisor']));
  ok('manager, supervisor AND branch_manager all granted',
     () => assert.ok(['Manager', 'Supervisor', 'Branch Manager'].every(r => roles.includes(r))));
  ok('NOT granted to Cashier or Waiter',
     () => assert.ok(!roles.includes('Cashier') && !roles.includes('Waiter')));

  const rec = await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='83_force_close_grant'`);
  ok('records itself in schema_migrations', () => assert.strictEqual(rec.rows[0].n, 1));
  await db.close();
}

// ── 2. Additive — an unrelated existing grant is untouched ───────────────────
console.log('\n2. additive — grants only, revokes nothing');
{
  const db = await fresh();
  // Cashier already holds settings.manage before 83 runs (contrived, but proves additivity).
  await db.exec(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name='Cashier' AND p.key='settings.manage';`);
  await db.exec(SQL);

  const cashierKeys = (await db.query(
    `SELECT p.key FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
     JOIN permissions p ON p.id=rp.permission_id WHERE r.name='Cashier' ORDER BY p.key`)).rows.map(x => x.key);
  ok('Cashier still holds settings.manage and did NOT gain shifts.force_close',
     () => assert.deepStrictEqual(cashierKeys, ['settings.manage']));
  await db.close();
}

// ── 3. Idempotent — a second run grants nothing extra ────────────────────────
console.log('\n3. idempotent — second run is a no-op');
{
  const db = await fresh();
  await db.exec(SQL);
  const before = (await db.query(`SELECT count(*)::int AS n FROM role_permissions`)).rows[0].n;
  await db.exec(SQL);
  const after = (await db.query(`SELECT count(*)::int AS n FROM role_permissions`)).rows[0].n;
  ok('row count unchanged on re-run', () => assert.strictEqual(before, after));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
