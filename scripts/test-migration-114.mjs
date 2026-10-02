/**
 * test-migration-114.mjs — A378: businesses.subdomain (a client's own sign-in address) — PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: drop the CHECK → "a malformed address is refused" fails; drop the unique index → "two
 * businesses cannot share an address" fails; make the column NOT NULL → "every existing business has none" fails.
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
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/114_business_subdomain.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('\nMigration 114 (businesses.subdomain) — PGlite\n');
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.businesses (id serial PRIMARY KEY, name text NOT NULL);
  INSERT INTO public.businesses (name) VALUES ('African Fries'), ('Pizza Place');
`);
await db.exec(SQL);

await ok('every existing business has none (NULL)', async () => {
  const r = await db.query(`SELECT count(*)::int AS n FROM public.businesses WHERE subdomain IS NULL`);
  assert.strictEqual(r.rows[0].n, 2);
});
await ok('an address is stored', async () => {
  await db.exec(`UPDATE public.businesses SET subdomain = 'africanfries' WHERE name = 'African Fries'`);
  const r = await db.query(`SELECT subdomain FROM public.businesses WHERE name = 'African Fries'`);
  assert.strictEqual(r.rows[0].subdomain, 'africanfries');
});
await ok('two businesses cannot share an address', async () => {
  const e = await threw(() => db.exec(`UPDATE public.businesses SET subdomain = 'africanfries' WHERE name = 'Pizza Place'`));
  assert.ok(e && /businesses_subdomain_key|duplicate|unique/i.test(e.message), e?.message);
});
await ok('a malformed address is refused (capitals, dots, edge hyphens, double hyphen, too short)', async () => {
  for (const bad of ['African', 'a.b', '-pizza', 'pizza-', 'piz--za', 'ab']) {
    const e = await threw(() => db.exec(`UPDATE public.businesses SET subdomain = '${bad}' WHERE name = 'Pizza Place'`));
    assert.ok(e && /businesses_subdomain_format/.test(e.message), `${bad}: ${e?.message}`);
  }
});
await ok('many businesses may have none', async () => {
  await db.exec(`INSERT INTO public.businesses (name) VALUES ('Third'), ('Fourth')`);
  const r = await db.query(`SELECT count(*)::int AS n FROM public.businesses WHERE subdomain IS NULL`);
  assert.strictEqual(r.rows[0].n, 3);
});
await ok('re-running is harmless (idempotent) and recorded once', async () => {
  await db.exec(SQL);
  const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '114_business_subdomain'`);
  assert.strictEqual(r.rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
