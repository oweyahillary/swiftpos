/**
 * test-migration-79.mjs — the stations.manage grant, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A59, docs/permission-model.md)
 * ------------------------------------------------------
 * Migration 79 grants `stations.manage` — registered by 75, granted to no role,
 * enforced on no route — to the manager roles, so the till Printers tab can gate
 * on it instead of a role test. It must:
 *   - be ADDITIVE (only grant; revoke nothing);
 *   - be self-contained (register the key if a DB somehow lacks it), so the grant
 *     is never a silent no-op;
 *   - match the SAME normalised role-name set as 75/76 (space -> underscore), so a
 *     business that typed "Branch Manager" with a space is not silently missed
 *     (register A61 — the exact bug that shipped in 24/49/75);
 *   - be idempotent, and never duplicate an existing grant.
 *
 * Proven by RUNNING it, not by reading the SQL (register A30/A62): the DO block,
 * ON CONFLICT and NOT EXISTS all pass or fail only under execution.
 *
 * Run:  node scripts/test-migration-79.mjs
 * Picked up by run-migration-tests.mjs's glob rather than by enumeration.
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/79_stations_manage_grant.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

/** The subset of the real schema this migration touches. */
async function fresh({ preRegister = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key varchar(100) NOT NULL,
      label varchar(255) NOT NULL,
      module varchar(100) NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT now(),
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
      version text PRIMARY KEY,
      notes text,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    -- "Branch Manager" with a space is the A61 case; Cashier/Waiter must be missed.
    INSERT INTO roles (name) VALUES
      ('Manager'), ('Supervisor'), ('Branch Manager'), ('Admin'), ('Owner'),
      ('Cashier'), ('Waiter');
  `);
  if (preRegister) {
    await db.exec(`INSERT INTO permissions (key, label, module, description)
      VALUES ('stations.manage', 'Manage print stations', 'settings', 'pre-seeded');`);
  }
  return db;
}

const grantedRoles = async (db) => (await db.query(
  `SELECT r.name FROM role_permissions rp
   JOIN permissions p ON p.id = rp.permission_id AND p.key = 'stations.manage'
   JOIN roles r ON r.id = rp.role_id ORDER BY r.name`)).rows.map(x => x.name);

console.log('\nmigration 79 — stations.manage grant\n');

// ── 1. Self-contained: registers then grants on a DB that never had the key ──
console.log('1. self-registers, then grants the manager roles');
{
  const db = await fresh({ preRegister: false });
  await db.exec(SQL);

  const reg = await db.query(`SELECT count(*)::int AS n FROM permissions WHERE key='stations.manage'`);
  ok('stations.manage registered exactly once', () => assert.strictEqual(reg.rows[0].n, 1));

  const roles = await grantedRoles(db);
  ok('granted to Admin, Branch Manager, Manager, Owner, Supervisor (space name matched)',
     () => assert.deepStrictEqual(roles, ['Admin', 'Branch Manager', 'Manager', 'Owner', 'Supervisor']));
  ok('NOT granted to Cashier or Waiter',
     () => assert.ok(!roles.includes('Cashier') && !roles.includes('Waiter')));

  const rec = await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='79_stations_manage_grant'`);
  ok('records itself in schema_migrations', () => assert.strictEqual(rec.rows[0].n, 1));
  await db.close();
}

// ── 2. Production shape: key already registered by 75, no duplicate row ──────
console.log('\n2. pre-registered — no duplicate permission row');
{
  const db = await fresh({ preRegister: true });
  await db.exec(SQL);
  const reg = await db.query(`SELECT count(*)::int AS n FROM permissions WHERE key='stations.manage'`);
  ok('still exactly one stations.manage row', () => assert.strictEqual(reg.rows[0].n, 1));
  const roles = await grantedRoles(db);
  ok('five manager roles granted', () => assert.strictEqual(roles.length, 5));
  await db.close();
}

// ── 3. Idempotent: a second run grants nothing extra ────────────────────────
console.log('\n3. idempotent — second run is a no-op');
{
  const db = await fresh();
  await db.exec(SQL);
  const after1 = (await grantedRoles(db)).length;
  await db.exec(SQL);
  const after2 = await db.query(
    `SELECT count(*)::int AS n FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id AND p.key='stations.manage'`);
  ok('grant count unchanged on re-run', () => assert.strictEqual(after2.rows[0].n, after1));
  await db.close();
}

// ── 4. Respects a pre-existing grant (partial prior state) ──────────────────
console.log('\n4. does not duplicate an existing grant');
{
  const db = await fresh({ preRegister: true });
  await db.exec(`INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name='Manager' AND p.key='stations.manage';`);
  await db.exec(SQL);
  const mgr = await db.query(
    `SELECT count(*)::int AS n FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id AND p.key='stations.manage'
     JOIN roles r ON r.id = rp.role_id AND r.name='Manager'`);
  ok('Manager still has exactly one stations.manage grant', () => assert.strictEqual(mgr.rows[0].n, 1));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
