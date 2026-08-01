/**
 * Migration 48 (audit C4) against real PostgreSQL via PGlite.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node scripts/test-migration-48.mjs
 *
 * Same pattern as scripts/test-migrations-41-42.mjs. Touches no real database.
 */
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, '../migrations/48_retire_seeded_admin.sql');
const SEED = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/Lewm8mCWhBiQF7zO2';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fresh = async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.admin_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      name text,
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'agent',
      is_active boolean NOT NULL DEFAULT true,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY, notes text, applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  return db;
};
const sql = () => fs.readFileSync(MIGRATION, 'utf8');

// ── Case 1: the seeded admin is the only account ────────────────────────────
console.log('\ncase 1 — seeded admin present, and it is the only one');
{
  const db = await fresh();
  await db.query(`INSERT INTO admin_users (email,name,password_hash,role) VALUES ('admin@swiftpos.co.ke','SwiftPOS Admin',$1,'super_admin')`, [SEED]);
  await db.exec(sql());
  const row = (await db.query(`SELECT is_active, password_hash, role FROM admin_users WHERE email='admin@swiftpos.co.ke'`)).rows[0];
  ok('row still exists (not deleted)', !!row);
  ok('is_active = false', row.is_active === false);
  ok('hash scrambled', row.password_hash !== SEED, row.password_hash);
  ok('hash cannot match any password', row.password_hash === 'DISABLED-BY-MIGRATION-48-run-reset-admin');
  ok('role left alone (visible in audit)', row.role === 'super_admin');
  ok('recorded in schema_migrations',
     (await db.query(`SELECT count(*)::int n FROM schema_migrations WHERE version='48_retire_seeded_admin'`)).rows[0].n === 1);
}

// ── Case 2: a real admin exists alongside it ────────────────────────────────
console.log('\ncase 2 — a legitimate admin exists too');
{
  const db = await fresh();
  await db.query(`INSERT INTO admin_users (email,password_hash,role) VALUES ('admin@swiftpos.co.ke',$1,'super_admin')`, [SEED]);
  await db.query(`INSERT INTO admin_users (email,password_hash,role) VALUES ('real@shop.co.ke','$2b$12$somethingelseentirelyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx','super_admin')`);
  await db.exec(sql());
  const seeded = (await db.query(`SELECT is_active FROM admin_users WHERE email='admin@swiftpos.co.ke'`)).rows[0];
  const real   = (await db.query(`SELECT is_active, password_hash FROM admin_users WHERE email='real@shop.co.ke'`)).rows[0];
  ok('seeded account disabled', seeded.is_active === false);
  ok('legitimate account untouched', real.is_active === true && real.password_hash.startsWith('$2b$12$something'));
}

// ── Case 3: clean database ──────────────────────────────────────────────────
console.log('\ncase 3 — no seeded admin present');
{
  const db = await fresh();
  await db.query(`INSERT INTO admin_users (email,password_hash,role) VALUES ('real@shop.co.ke','$2b$12$fine','super_admin')`);
  let clean = true;
  try { await db.exec(sql()); } catch (e) { clean = false; console.log('   ', e.message); }
  ok('runs without error', clean);
  ok('nothing disabled', (await db.query(`SELECT count(*)::int n FROM admin_users WHERE is_active`)).rows[0].n === 1);
}

// ── Case 4: the constraint blocks re-insertion ──────────────────────────────
console.log('\ncase 4 — the seed cannot come back');
{
  const db = await fresh();
  await db.exec(sql());
  let rejected = false;
  try {
    await db.query(`INSERT INTO admin_users (email,password_hash,role) VALUES ('sneaky@x.com',$1,'super_admin')`, [SEED]);
  } catch (e) { rejected = /admin_users_no_seeded_hash/.test(e.message); }
  ok('re-inserting the seed hash is refused by the database', rejected);

  let updateRejected = false;
  await db.query(`INSERT INTO admin_users (email,password_hash,role) VALUES ('a@b.com','$2b$12$ok','agent')`);
  try {
    await db.query(`UPDATE admin_users SET password_hash=$1 WHERE email='a@b.com'`, [SEED]);
  } catch (e) { updateRejected = /admin_users_no_seeded_hash/.test(e.message); }
  ok('updating a row TO the seed hash is refused', updateRejected);
}

// ── Case 5: idempotent ──────────────────────────────────────────────────────
console.log('\ncase 5 — re-runnable');
{
  const db = await fresh();
  await db.query(`INSERT INTO admin_users (email,password_hash,role) VALUES ('admin@swiftpos.co.ke',$1,'super_admin')`, [SEED]);
  await db.exec(sql());
  let again = true;
  try { await db.exec(sql()); } catch (e) { again = false; console.log('   ', e.message); }
  ok('running migration 48 twice is safe', again);
}

// ── Case 6: no admin_users table at all ─────────────────────────────────────
console.log('\ncase 6 — database without the admin portal');
{
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());`);
  let survived = true;
  try { await db.exec(sql()); } catch (e) { survived = false; console.log('   ', e.message); }
  ok('degrades gracefully when admin_users does not exist', survived);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
