/**
 * test-migration-75.mjs — the permission registry, against real Postgres.
 *
 * WHAT THIS PINS (register A57, A46, A58)
 * ---------------------------------------
 * requirePermission fails CLOSED (rbac.ts:20) and role_permissions.permission_id
 * is a foreign key to permissions.id (00_baseline.sql:5212). So a key with no
 * permissions row can never be granted, and its routes are owner-only with
 * nothing saying so. Migration 75 registers every key the cloud enforces.
 *
 * It must also be a NO-OP where production is already seeded, because nobody
 * knows which of these rows the live database holds. Section 3 runs the whole
 * migration TWICE and against a pre-seeded table, which is the only way to find
 * out — reading `ON CONFLICT` and believing it is how migration 74 shipped a
 * 42P16 that only execution found (register A30).
 *
 * Run:  node scripts/test-migration-75.mjs
 *
 * Lives in scripts/ beside test-migrations-41-42, 47, 48, 50, 51, 52 and 73-74,
 * and is picked up by run-migration-tests.mjs's glob rather than by enumeration.
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
  console.error(
    '\n@electric-sql/pglite is not installed — this suite cannot run.\n' +
    '  npm i --no-save @electric-sql/pglite\n');
  process.exit(1);
}

// fileURLToPath, not new URL(...).pathname — the latter yields /C:/... on
// Windows and path.resolve then prepends the drive again (register A33).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/75_permission_registry.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

/** The subset of the real schema this migration touches. */
async function fresh() {
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
    INSERT INTO roles (name) VALUES ('Manager'), ('Cashier'), ('Supervisor');
  `);
  return db;
}

const keysIn = r => r.rows.map(x => x.key).sort();

console.log('\nmigration 75 — permission registry\n');

// ── 1. A57: the six enforced-but-unregistered keys ─────────────────────────
console.log('1. A57 — keys the cloud enforces are now grantable');
{
  const db = await fresh();
  await db.exec(SQL);
  const A57 = ['expenses.manage', 'expenses.view', 'orders.void',
               'products.manage', 'settings.manage', 'staff.manage'];
  const got = keysIn(await db.query(
    `SELECT key FROM permissions WHERE key = ANY($1)`, [A57]));
  ok('all six A57 keys exist', () => assert.deepStrictEqual(got, [...A57].sort()));

  // The point of registering them: role_permissions can now reference them.
  // Without a row the FK rejects the insert, which is the whole finding.
  const r = await db.query(`SELECT id FROM roles WHERE name = 'Manager'`);
  const p = await db.query(`SELECT id FROM permissions WHERE key = 'products.manage'`);
  await db.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)`,
                 [r.rows[0].id, p.rows[0].id]);
  const cnt = await db.query(
    `SELECT count(*)::int AS n FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id WHERE p.key = 'products.manage'`);
  ok('the grant sticks (FK satisfied)', () => assert.strictEqual(cnt.rows[0].n, 1));
  await db.close();
}

// ── 2. A46 and A58 ─────────────────────────────────────────────────────────
console.log('\n2. A46 split keys and A58 nav keys');
{
  const db = await fresh();
  await db.exec(SQL);

  const A46 = ['devices.approve', 'etims.manage', 'receipt.manage',
               'shifts.force_close', 'stations.manage', 'tables.manage'];
  const got46 = keysIn(await db.query(`SELECT key FROM permissions WHERE key = ANY($1)`, [A46]));
  ok('all six A46 narrow keys registered', () => assert.deepStrictEqual(got46, [...A46].sort()));

  // A46's keys must be GRANTED TO NOBODY. They are additive alternatives, and
  // auto-granting one would hand out eTIMS registration or till revocation as a
  // side effect of a migration — the opposite of the finding's whole point.
  const granted46 = await db.query(
    `SELECT count(*)::int AS n FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id WHERE p.key = ANY($1)`, [A46]);
  ok('A46 keys are granted to NO role', () => assert.strictEqual(granted46.rows[0].n, 0));

  // A58: these two ARE granted, and that is the one behaviour change.
  const mgr = await db.query(
    `SELECT p.key, r.name FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     JOIN roles r ON r.id = rp.role_id
     WHERE p.key IN ('orders.view_all','inventory.view') ORDER BY p.key, r.name`);
  ok('A58 keys granted to Manager and Supervisor',
     () => assert.deepStrictEqual(
       mgr.rows.map(r => `${r.key}/${r.name}`),
       ['inventory.view/Manager', 'inventory.view/Supervisor',
        'orders.view_all/Manager', 'orders.view_all/Supervisor']));

  ok('and NOT to Cashier',
     () => assert.ok(!mgr.rows.some(r => r.name === 'Cashier')));
  await db.close();
}

// ── 3. Idempotence — the claim that lets this run on an unknown database ───
console.log('\n3. safe to run twice, and safe on an already-seeded table');
{
  const db = await fresh();
  await db.exec(SQL);
  const first = (await db.query(`SELECT count(*)::int AS n FROM permissions`)).rows[0].n;
  const firstGrants = (await db.query(`SELECT count(*)::int AS n FROM role_permissions`)).rows[0].n;

  await db.exec(SQL);   // second run — must change nothing
  const second = (await db.query(`SELECT count(*)::int AS n FROM permissions`)).rows[0].n;
  const secondGrants = (await db.query(`SELECT count(*)::int AS n FROM role_permissions`)).rows[0].n;

  ok('re-running adds no duplicate permissions', () => assert.strictEqual(second, first));
  ok('re-running adds no duplicate grants', () => assert.strictEqual(secondGrants, firstGrants));

  const mig = await db.query(`SELECT count(*)::int AS n FROM schema_migrations
                              WHERE version = '75_permission_registry'`);
  ok('one ledger row, not two', () => assert.strictEqual(mig.rows[0].n, 1));
  await db.close();
}
{
  // The production case: the keys already exist, with THEIR OWN labels. The
  // migration must not overwrite them and must not fail.
  const db = await fresh();
  await db.exec(`INSERT INTO permissions (key,label,module) VALUES
    ('products.manage','Existing production label','products'),
    ('settings.manage','Existing production label','settings');`);
  await db.exec(SQL);
  const lbl = await db.query(
    `SELECT label FROM permissions WHERE key='products.manage'`);
  ok('a pre-existing row keeps its own label (DO NOTHING, not DO UPDATE)',
     () => assert.strictEqual(lbl.rows[0].label, 'Existing production label'));
  const dupe = await db.query(
    `SELECT count(*)::int AS n FROM permissions WHERE key='products.manage'`);
  ok('and is not duplicated', () => assert.strictEqual(dupe.rows[0].n, 1));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
