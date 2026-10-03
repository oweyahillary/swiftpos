/**
 * test-migration-117.mjs — 0.6.35 (A384): admin_users.phone + businesses.support_admin_id (a shop's own tech) — PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: drop admin_users_phone_format → "a number we cannot dial is refused" fails; drop ON DELETE
 * SET NULL → "removing a team member frees their clients" fails.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/117_support_tech.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('\nMigration 117 (a shop\'s own tech) — PGlite\n');
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.admin_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, name text NOT NULL);
  CREATE TABLE public.businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
  INSERT INTO public.admin_users (email, name) VALUES ('brian@x', 'Brian');
  INSERT INTO public.businesses (name) VALUES ('African Fries'), ('Pizza Place');
`);
await db.exec(SQL);
const TECH = (await db.query(`SELECT id FROM public.admin_users LIMIT 1`)).rows[0].id;

await ok('every existing team member has no number; every client has no tech (SwiftPOS support)', async () => {
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM public.admin_users WHERE phone IS NULL`)).rows[0].n, 1);
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM public.businesses WHERE support_admin_id IS NULL`)).rows[0].n, 2);
});
await ok('a tech\'s number is stored', async () => {
  await db.exec(`UPDATE public.admin_users SET phone = '0712345678'`);
  await db.exec(`UPDATE public.admin_users SET phone = '0112345678'`);
});
await ok('a number we cannot dial is refused', async () => {
  for (const bad of ['+254712345678', '071234567', '0812345678', '0712 345 678']) {
    const e = await threw(() => db.exec(`UPDATE public.admin_users SET phone = '${bad}'`));
    assert.ok(e && /admin_users_phone_format/.test(e.message), `${bad}: ${e?.message}`);
  }
});
await ok('a tech is allocated to a client; one tech may look after many', async () => {
  await db.exec(`UPDATE public.businesses SET support_admin_id = '${TECH}'`);
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM public.businesses WHERE support_admin_id = '${TECH}'`)).rows[0].n, 2);
});
await ok('a client cannot point at someone who is not on the team', async () => {
  const e = await threw(() => db.exec(`UPDATE public.businesses SET support_admin_id = gen_random_uuid()`));
  assert.ok(e && /foreign key|violates/i.test(e.message), e?.message);
});
await ok('removing a team member frees their clients (back to SwiftPOS support)', async () => {
  await db.exec(`DELETE FROM public.admin_users WHERE id = '${TECH}'`);
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM public.businesses WHERE support_admin_id IS NULL`)).rows[0].n, 2);
});
await ok('re-running is harmless (idempotent) and recorded once', async () => {
  await db.exec(SQL);
  const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '117_support_tech'`);
  assert.strictEqual(r.rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
