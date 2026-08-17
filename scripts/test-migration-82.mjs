/**
 * test-migration-82.mjs — the manager deny-list reconcile, against real Postgres.
 *
 * WHAT THIS PINS (register A64)
 * -----------------------------
 * The owner chose the strict manager policy. Migration 82 revokes the three
 * keys migration 59 over-granted — inventory.adjust, ingredients.manage,
 * reports.financial — from the manager role set, and must:
 *   - remove exactly those three from manager / supervisor / branch_manager,
 *     including a space-typed "Branch Manager" (A61);
 *   - leave every OTHER manager grant intact (inventory.view, inventory.receive,
 *     reports.view — the receive-and-see policy the owner kept);
 *   - touch neither owner/admin (who hold these legitimately) nor cashier;
 *   - be idempotent.
 *
 * Proven by RUNNING it (A30/A62). Picked up by run-migration-tests.mjs's glob.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { console.error('\n@electric-sql/pglite is not installed — npm i --no-save @electric-sql/pglite\n'); process.exit(1); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/82_manager_deny_reconcile.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); } };

const ALL_KEYS = [
  'inventory.view', 'inventory.receive', 'inventory.adjust',
  'ingredients.manage', 'reports.view', 'reports.financial', 'settings.manage',
];

/** Fixture: the migration-59 over-grant state — managers hold EVERYTHING here,
 *  including the three keys that should be owner-only; owner holds them too. */
async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
    CREATE TABLE permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(100) NOT NULL,
      CONSTRAINT permissions_key_key UNIQUE (key));
    CREATE TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid, name varchar(100) NOT NULL);
    CREATE TABLE role_permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      CONSTRAINT rp_uniq UNIQUE (role_id, permission_id));
    CREATE TABLE schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  `);
  await db.query(`INSERT INTO businesses (name) VALUES ('Acme')`);
  for (const k of ALL_KEYS) await db.query(`INSERT INTO permissions (key) VALUES ($1)`, [k]);
  const biz = (await db.query(`SELECT id FROM businesses LIMIT 1`)).rows[0].id;
  // "Branch Manager" with a space is the A61 case; Cashier and Owner are controls.
  for (const nm of ['Manager', 'Supervisor', 'Branch Manager', 'Cashier', 'Owner'])
    await db.query(`INSERT INTO roles (business_id, name) VALUES ($1,$2)`, [biz, nm]);

  // Managers hold ALL keys (the 59 over-grant). Owner holds the three too.
  // Cashier holds only the two "kept" keys.
  await db.exec(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
    WHERE lower(replace(r.name,' ','_')) IN ('manager','supervisor','branch_manager','owner');
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN ('inventory.view','inventory.receive')
    WHERE r.name='Cashier';
  `);
  return db;
}

const keysOf = async (db, roleName) => (await db.query(
  `SELECT p.key FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
   JOIN permissions p ON p.id=rp.permission_id WHERE r.name=$1 ORDER BY p.key`, [roleName])).rows.map(x => x.key);

console.log('\nmigration 82 — manager deny-list reconcile (A64)\n');

console.log('1. revokes the three owner-only keys from every manager-type role');
{
  const db = await fresh();
  await db.exec(SQL);
  for (const role of ['Manager', 'Supervisor', 'Branch Manager']) {
    const keys = await keysOf(db, role);
    ok(`${role}: lost adjust/manage/financial`, () =>
      assert.ok(!keys.includes('inventory.adjust') && !keys.includes('ingredients.manage') && !keys.includes('reports.financial')));
    ok(`${role}: KEPT receive + view + branch reports`, () =>
      assert.ok(keys.includes('inventory.view') && keys.includes('inventory.receive') && keys.includes('reports.view')));
  }
  const rec = await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='82_manager_deny_reconcile'`);
  ok('records itself in schema_migrations', () => assert.strictEqual(rec.rows[0].n, 1));
  await db.close();
}

console.log('\n2. leaves owner and cashier untouched');
{
  const db = await fresh();
  await db.exec(SQL);
  const owner = await keysOf(db, 'Owner');
  ok('Owner keeps all three owner-only keys', () =>
    assert.ok(['inventory.adjust', 'ingredients.manage', 'reports.financial'].every(k => owner.includes(k))));
  const cashier = await keysOf(db, 'Cashier');
  ok('Cashier is unchanged (never had the three)', () =>
    assert.deepStrictEqual(cashier, ['inventory.receive', 'inventory.view']));
  await db.close();
}

console.log('\n3. idempotent — a second run removes nothing more');
{
  const db = await fresh();
  await db.exec(SQL);
  const before = (await db.query(`SELECT count(*)::int AS n FROM role_permissions`)).rows[0].n;
  await db.exec(SQL);
  const after = (await db.query(`SELECT count(*)::int AS n FROM role_permissions`)).rows[0].n;
  ok('second run is a no-op', () => assert.strictEqual(before, after));
  await db.close();
}

console.log(`\n${failed === 0
  ? `migration 82: all ${passed} checks passed — managers receive & see, but no longer adjust/manage/financial.`
  : `migration 82: ${failed} FAILED (${passed} passed)`}`);
process.exit(failed === 0 ? 0 : 1);
