/**
 * test-migration-100.mjs — register + grant products.view, against real Postgres (PGlite).
 *
 * Pins A220: products.view (gated by the manager Menu tab, registered by no migration)
 * is registered and granted to admin/owner, the manager tier, and cashier — A61-safe,
 * idempotent. Proven by running the SQL, not reading it.
 *
 * Run: node scripts/test-migration-100.mjs  (picked up by run-migration-tests.mjs)
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/100_register_products_view.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(100) NOT NULL,
      label varchar(255) NOT NULL, module varchar(100) NOT NULL, description text,
      created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT permissions_key_key UNIQUE (key));
    CREATE TABLE public.roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid, name varchar(100) NOT NULL);
    CREATE TABLE public.role_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
      permission_id uuid NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE);
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO public.roles (name) VALUES
      ('Manager'),('Supervisor'),('Branch Manager'),('Admin'),('Owner'),('Cashier'),('Waiter');
  `);
  return db;
}
const has = async (db, role) => {
  const r = await db.query(
    `SELECT 1 FROM public.role_permissions rp
     JOIN public.roles r ON r.id = rp.role_id
     JOIN public.permissions p ON p.id = rp.permission_id
     WHERE r.name = $1 AND p.key = 'products.view'`, [role]);
  return r.rows.length > 0;
};

console.log('\nMigration 100 (register products.view) — PGlite\n');
await (async () => {
  const db = await fresh();
  await db.exec(SQL);

  const reg = (await db.query(`SELECT 1 FROM public.permissions WHERE key='products.view'`)).rows.length;
  ok('products.view registered', () => assert.strictEqual(reg, 1));

  for (const role of ['Manager', 'Supervisor', 'Branch Manager', 'Admin', 'Owner', 'Cashier']) {
    const granted = await has(db, role);
    ok(`${role} is granted products.view`, () => assert.ok(granted, `${role} should hold products.view`));
  }
  const waiterHas = await has(db, 'Waiter');
  ok('Waiter (custom role) is NOT granted', () => assert.ok(!waiterHas));

  // idempotent
  const n1 = Number((await db.query('SELECT count(*)::int n FROM public.role_permissions')).rows[0].n);
  await db.exec(SQL);
  const n2 = Number((await db.query('SELECT count(*)::int n FROM public.role_permissions')).rows[0].n);
  ok('re-running adds no duplicate grants', () => assert.strictEqual(n1, n2));

  const ledger = (await db.query(`SELECT 1 FROM public.schema_migrations WHERE version='100_register_products_view'`)).rows.length;
  ok('records itself in schema_migrations', () => assert.strictEqual(ledger, 1));

  console.log(`\n${fail ? 'FAILURES' : 'all green'}  (${pass} passed, ${fail} failed)\n`);
  process.exit(fail ? 1 : 0);
})();
