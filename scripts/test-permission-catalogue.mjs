/**
 * test-permission-catalogue.mjs — A213, against real Postgres (PGlite).
 *
 * Proves the boot self-heal's registration logic: given a live catalogue that a
 * bootstrap left INCOMPLETE, registering the canonical PERMISSION_CATALOGUE with
 * ON CONFLICT (key) DO NOTHING fills every gap, adds no duplicates, and is
 * idempotent. Uses the same keys the real code ships (parsed from the source), so
 * it also guards that the two newly-caught keys (orders.create, invoice.create)
 * are in the canonical list.
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
const catSrc = fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/permissionCatalogue.ts'), 'utf8');
const catBlock = /PERMISSION_CATALOGUE[\s\S]*?\n\];/.exec(catSrc)[0];
const CAT_KEYS = [...catBlock.matchAll(/key:\s*'([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]);

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

const count = async (db) => Number((await db.query('SELECT count(*)::int n FROM public.permissions')).rows[0].n);
const keys  = async (db) => (await db.query('SELECT key FROM public.permissions')).rows.map(r => r.key);
// mirrors ensurePermissionsRegistered: INSERT ... ON CONFLICT (key) DO NOTHING
const register = async (db) => {
  for (const k of CAT_KEYS) {
    await db.query(
      "INSERT INTO public.permissions (key, label, module, description) VALUES ($1,$1,'x','') ON CONFLICT (key) DO NOTHING",
      [k]);
  }
};

console.log('\nA213 permission-catalogue self-heal — PGlite\n');
await (async () => {
  assert.ok(CAT_KEYS.length >= 20, 'catalogue should have the full key set');
  ok('canonical list includes the two newly-caught keys', () => {
    assert.ok(CAT_KEYS.includes('orders.create'), 'orders.create must be catalogued');
    assert.ok(CAT_KEYS.includes('invoice.create'), 'invoice.create must be catalogued');
  });

  const db = new PGlite();
  await db.exec(`CREATE TABLE public.permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key varchar(100) NOT NULL, label varchar(255), module varchar(100), description text,
    CONSTRAINT permissions_key_key UNIQUE (key));`);

  // Simulate a consolidated-dump bootstrap that left three keys out.
  const MISSING = ['products.view', 'orders.create', 'invoice.create'];
  for (const k of CAT_KEYS.filter(k => !MISSING.includes(k))) {
    await db.query("INSERT INTO public.permissions (key, label, module) VALUES ($1,$1,'x')", [k]);
  }
  const before = await count(db);
  ok('starts with an incomplete catalogue (3 keys missing)', () => assert.strictEqual(before, CAT_KEYS.length - 3));

  // Boot self-heal
  await register(db);
  const healed = await keys(db);
  ok('every canonical key is now registered', () => {
    for (const k of CAT_KEYS) assert.ok(healed.includes(k), `${k} should be registered after heal`);
  });
  ok('the three missing keys were healed', () => {
    for (const k of MISSING) assert.ok(healed.includes(k), `${k} should have healed`);
  });
  const afterN = await count(db);
  ok('count equals catalogue size', () => assert.strictEqual(afterN, CAT_KEYS.length));

  // Idempotent
  await register(db);
  const twiceN = await count(db);
  ok('re-running the heal adds nothing (idempotent)', () => assert.strictEqual(twiceN, CAT_KEYS.length));

  console.log(`\n${fail ? 'FAILURES' : 'all green'}  (${pass} passed, ${fail} failed)\n`);
  process.exit(fail ? 1 : 0);
})();
