/**
 * test-migration-78.mjs — the receipt.manage grant, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A59, A45, docs/A59-till-permission-keys.md)
 * ------------------------------------------------------------------
 * Migration 75 REGISTERED receipt.manage but granted it to no role, so the
 * narrow allow-list A45 added to POST /business/settings was unreachable and the
 * till's re-pointed Receipt tab (has('receipt.manage') || has('settings.manage'))
 * would show for NO manager. Migration 78 grants the key to the manager role set.
 * It must:
 *   - grant to manager AND supervisor AND branch_manager (and admin/owner) — the
 *     working note's open question was whether all three manager-type roles get
 *     it, since only those three lack settings.manage and would otherwise lose
 *     the Receipt tab;
 *   - match the SAME normalised name set as 75/76 (space -> underscore), so
 *     "Branch Manager" typed with a space is not silently missed (A61);
 *   - be ADDITIVE — grant only, revoke nothing, touch no unrelated grant;
 *   - be idempotent.
 *
 * Unlike 79, migration 78 does NOT self-register the key — it assumes 75 did. So
 * the fixture pre-registers receipt.manage, which is the production shape.
 *
 * Proven by RUNNING it (A30/A62): NOT EXISTS and the normalised match pass or
 * fail only under execution. Picked up by run-migration-tests.mjs's glob.
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/78_receipt_manage_grant.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

/** The subset of the real schema this migration touches. receipt.manage is
 *  pre-registered because migration 75 registers it — 78 only grants. */
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
    -- 75 registered these two keys; 78 only touches receipt.manage.
    INSERT INTO permissions (key) VALUES ('receipt.manage'), ('orders.create');
    -- "Branch Manager" with a space is the A61 case; Cashier/Waiter must be missed.
    INSERT INTO roles (name) VALUES
      ('Manager'), ('Supervisor'), ('Branch Manager'), ('Admin'), ('Owner'),
      ('Cashier'), ('Waiter');
  `);
  return db;
}

const grantedRoles = async (db) => (await db.query(
  `SELECT r.name FROM role_permissions rp
   JOIN permissions p ON p.id = rp.permission_id AND p.key = 'receipt.manage'
   JOIN roles r ON r.id = rp.role_id ORDER BY r.name`)).rows.map(x => x.name);

console.log('\nmigration 78 — receipt.manage grant\n');

// ── 1. Grants the manager role set (the working note's open question) ────────
console.log('1. grants receipt.manage to the manager-level roles');
{
  const db = await fresh();
  await db.exec(SQL);

  const roles = await grantedRoles(db);
  ok('granted to Admin, Branch Manager, Manager, Owner, Supervisor (space name matched)',
     () => assert.deepStrictEqual(roles, ['Admin', 'Branch Manager', 'Manager', 'Owner', 'Supervisor']));
  // The specific question the working note flagged: the three roles that lack
  // settings.manage must each hold receipt.manage, or they lose the Receipt tab.
  ok('manager, supervisor AND branch_manager all granted (or they lose Receipt)',
     () => assert.ok(['Manager', 'Supervisor', 'Branch Manager'].every(r => roles.includes(r))));
  ok('NOT granted to Cashier or Waiter',
     () => assert.ok(!roles.includes('Cashier') && !roles.includes('Waiter')));

  const rec = await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='78_receipt_manage_grant'`);
  ok('records itself in schema_migrations', () => assert.strictEqual(rec.rows[0].n, 1));
  await db.close();
}

// ── 2. Additive — an unrelated existing grant is untouched ───────────────────
console.log('\n2. additive — grants only, revokes nothing');
{
  const db = await fresh();
  // Cashier already holds orders.create before 78 runs.
  await db.exec(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name='Cashier' AND p.key='orders.create';`);
  await db.exec(SQL);

  const cashierKeys = (await db.query(
    `SELECT p.key FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
     JOIN permissions p ON p.id=rp.permission_id WHERE r.name='Cashier' ORDER BY p.key`)).rows.map(x => x.key);
  ok("Cashier still holds orders.create and did NOT gain receipt.manage",
     () => assert.deepStrictEqual(cashierKeys, ['orders.create']));
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
  ok('second run adds no rows', () => assert.strictEqual(before, after));
  await db.close();
}

// ── 4. The key must be registered first (78 does not self-register) ──────────
console.log('\n4. depends on 75 having registered the key (no self-register)');
{
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(100) NOT NULL,
      label varchar(255) NOT NULL DEFAULT '', module varchar(100) NOT NULL DEFAULT '', CONSTRAINT pk UNIQUE(key));
    CREATE TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(100) NOT NULL);
    CREATE TABLE role_permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id uuid NOT NULL REFERENCES roles(id), permission_id uuid NOT NULL REFERENCES permissions(id),
      CONSTRAINT u UNIQUE(role_id, permission_id));
    CREATE TABLE schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
    INSERT INTO roles (name) VALUES ('Manager');`);  // receipt.manage NOT registered
  await db.exec(SQL);
  const roles = await grantedRoles(db);
  ok('with the key unregistered, 78 grants nothing (75 must run first)',
     () => assert.strictEqual(roles.length, 0));
  await db.close();
}

console.log(`\n${failed === 0
  ? `migration 78: all ${passed} checks passed — receipt.manage reaches the manager roles.`
  : `migration 78: ${failed} FAILED (${passed} passed)`}`);
process.exit(failed === 0 ? 0 : 1);
