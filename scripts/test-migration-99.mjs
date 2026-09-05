/**
 * test-migration-99.mjs — the permission-catalogue repair, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A211, docs/permission-model.md)
 * ------------------------------------------------------
 * Migration 99 repairs a catalogue that a dump-seeded DB left missing the 7 keys
 * first registered by 09/24/27. It must:
 *   - REGISTER all 7 keys (idempotent: a no-op where they already exist);
 *   - GRANT them per tier, EXACTLY like lib/defaultRolePermissions.ts:
 *       admin/owner                       -> all 7
 *       manager/supervisor/branch_manager -> the 4 NOT on MANAGER_DENY
 *                                            (customers.view/manage, inventory.receive, reports.view)
 *       cashier                           -> customers.view, customers.manage
 *   - use the A61-SAFE normalised name form, so "Branch Manager" (with a space)
 *     is NOT silently missed (the bug 24/27 shipped);
 *   - grant NOTHING to a custom role ("Waiter");
 *   - be idempotent — re-running adds no duplicate rows (role_permissions has no
 *     unique (role_id,permission_id) constraint in the real schema, so this proves
 *     the NOT EXISTS guard, not a constraint).
 *
 * Proven by RUNNING it, not by reading the SQL (register A30/A62): ON CONFLICT and
 * NOT EXISTS pass or fail only under execution.
 *
 * Run:  node scripts/test-migration-99.mjs
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/99_permission_catalogue_repair.sql'), 'utf8');

const MISSING7 = [
  'customers.view', 'customers.manage', 'inventory.receive',
  'inventory.adjust', 'ingredients.manage', 'reports.view', 'reports.financial',
];
const MANAGER_GETS  = ['customers.view', 'customers.manage', 'inventory.receive', 'reports.view'];
const MANAGER_DENIED = ['inventory.adjust', 'ingredients.manage', 'reports.financial'];
const CASHIER_GETS   = ['customers.view', 'customers.manage'];

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

/**
 * The subset of the real schema this migration touches. role_permissions has NO
 * unique (role_id,permission_id) constraint here — deliberately, matching the
 * real DB (00_baseline) — so idempotency must come from the migration's own
 * NOT EXISTS guard, and the test can actually catch a regression that drops it.
 */
async function fresh({ preRegisterAll = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key varchar(100) NOT NULL,
      label varchar(255) NOT NULL,
      module varchar(100) NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT permissions_key_key UNIQUE (key)
    );
    CREATE TABLE public.businesses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(255) NOT NULL
    );
    CREATE TABLE public.roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id uuid,
      name varchar(100) NOT NULL
    );
    CREATE TABLE public.role_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
      permission_id uuid NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE
      -- NB: no UNIQUE(role_id,permission_id) — matches the real schema.
    );
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY,
      notes text,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.businesses (name) VALUES ('B Fastfoods');
    -- "Branch Manager" with a space is the A61 case; Cashier is its own tier;
    -- Waiter is a custom role that must receive nothing.
    INSERT INTO public.roles (business_id, name)
    SELECT b.id, n FROM public.businesses b,
      (VALUES ('Manager'),('Supervisor'),('Branch Manager'),('Admin'),('Owner'),
              ('Cashier'),('Waiter')) AS x(n);
  `);
  if (preRegisterAll) {
    // Simulate a fully-migrated DB where the 7 keys already exist, to prove the
    // registration step is a safe no-op (ON CONFLICT) rather than a duplicate error.
    await db.exec(`
      INSERT INTO public.permissions (key, label, module) VALUES
        ('customers.view','x','Customers'), ('customers.manage','x','Customers'),
        ('inventory.receive','x','inventory'), ('inventory.adjust','x','inventory'),
        ('ingredients.manage','x','inventory'), ('reports.view','x','reports'),
        ('reports.financial','x','reports');
    `);
  }
  return db;
}

const keysFor = async (db, roleName) => {
  const r = await db.query(
    `SELECT p.key FROM public.role_permissions rp
     JOIN public.roles r ON r.id = rp.role_id
     JOIN public.permissions p ON p.id = rp.permission_id
     WHERE r.name = $1 ORDER BY p.key`, [roleName]);
  return r.rows.map(x => x.key);
};
const countRows = async (db, sql) => Number((await db.query(sql)).rows[0].n);

console.log('\nMigration 99 (permission catalogue repair) — PGlite\n');

await (async () => {
  // ── registration ──────────────────────────────────────────────────────────
  {
    const db = await fresh();
    await db.exec(SQL);
    const reg = (await db.query(
      `SELECT key FROM public.permissions WHERE key = ANY($1) ORDER BY key`, [MISSING7])).rows.map(x => x.key);
    ok('registers all 7 previously-missing keys',
       () => assert.deepStrictEqual(reg, [...MISSING7].sort()));
  }

  // ── grants per tier ─────────────────────────────────────────────────────────
  {
    const db = await fresh();
    await db.exec(SQL);

    for (const role of ['Manager', 'Supervisor', 'Branch Manager']) {
      const keys = await keysFor(db, role);
      ok(`${role}: gets exactly the 4 non-deny keys`,
         () => assert.deepStrictEqual(keys, [...MANAGER_GETS].sort()));
      ok(`${role}: is NOT granted any owner-only key`,
         () => assert.ok(MANAGER_DENIED.every(k => !keys.includes(k)),
              `unexpected owner-only grant: ${keys.filter(k => MANAGER_DENIED.includes(k))}`));
    }

    const cashier = await keysFor(db, 'Cashier');
    ok('Cashier: gets exactly customers.view + customers.manage',
       () => assert.deepStrictEqual(cashier, [...CASHIER_GETS].sort()));

    const admin = await keysFor(db, 'Admin');
    const owner = await keysFor(db, 'Owner');
    ok('Admin: gets all 7', () => assert.deepStrictEqual(admin, [...MISSING7].sort()));
    ok('Owner: gets all 7', () => assert.deepStrictEqual(owner, [...MISSING7].sort()));

    const waiter = await keysFor(db, 'Waiter');
    ok('Waiter (custom role): granted nothing', () => assert.deepStrictEqual(waiter, []));
  }

  // ── idempotency (proves the NOT EXISTS guard, no unique constraint present) ──
  {
    const db = await fresh();
    await db.exec(SQL);
    const after1 = await countRows(db, 'SELECT count(*)::int AS n FROM public.role_permissions');
    await db.exec(SQL);
    const after2 = await countRows(db, 'SELECT count(*)::int AS n FROM public.role_permissions');
    ok('re-running adds no duplicate grants', () => assert.strictEqual(after1, after2));
    const perms = await countRows(db, 'SELECT count(*)::int AS n FROM public.permissions');
    ok('re-running registers no duplicate keys', () => assert.strictEqual(perms, 7));
  }

  // ── safe on an already-migrated DB (keys pre-exist) ─────────────────────────
  {
    const db = await fresh({ preRegisterAll: true });
    await db.exec(SQL);   // must not throw on the duplicate keys
    const perms = await countRows(db, 'SELECT count(*)::int AS n FROM public.permissions');
    ok('ON CONFLICT: no duplicate keys when catalogue already has them',
       () => assert.strictEqual(perms, 7));
    const mgr = await keysFor(db, 'Manager');
    ok('still grants the manager tier when keys pre-existed',
       () => assert.deepStrictEqual(mgr, [...MANAGER_GETS].sort()));
  }

  // ── ledger ──────────────────────────────────────────────────────────────────
  {
    const db = await fresh();
    await db.exec(SQL);
    const n = await countRows(db,
      `SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '99_permission_catalogue_repair'`);
    ok('records itself in schema_migrations', () => assert.strictEqual(n, 1));
  }

  console.log(`\n${failed === 0 ? 'all green' : 'FAILURES'}  (${passed} passed, ${failed} failed)\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
