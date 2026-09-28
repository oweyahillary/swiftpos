/**
 * test-migration-108.mjs — A348: businesses.desktop_approved_version (per-business approval of desktop updates; NULL =
 * hold). Against real Postgres (PGlite). Every assertion is awaited (the A305 lesson).
 *
 * MUTATION TO CONFIRM BITE: drop the CHECK → "a value that is not x.y.z is refused" fails; give the column a DEFAULT
 * version → "every existing business starts HELD" fails.
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
const SQL108 = fs.readFileSync(path.join(ROOT, 'migrations/108_desktop_approved_version.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('\nMigration 108 (desktop_approved_version) — PGlite\n');
await (async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
    CREATE TABLE public.businesses (id uuid PRIMARY KEY, name text NOT NULL, status text DEFAULT 'active');
    INSERT INTO public.businesses (id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'B Foods'),
                                                   ('22222222-2222-4222-8222-222222222222', 'Other Client');
  `);
  await db.exec(SQL108);

  await ok('every existing business starts HELD (NULL)', async () => {
    const r = await db.query(`SELECT count(*)::int AS n FROM public.businesses WHERE desktop_approved_version IS NULL`);
    assert.strictEqual(r.rows[0].n, 2);
  });
  await ok('a new business is HELD too (no default version)', async () => {
    await db.exec(`INSERT INTO public.businesses (id, name) VALUES ('33333333-3333-4333-8333-333333333333', 'New')`);
    const r = await db.query(`SELECT desktop_approved_version AS v FROM public.businesses WHERE name='New'`);
    assert.strictEqual(r.rows[0].v, null);
  });
  await ok('an x.y.z version is accepted, and set back to NULL (hold)', async () => {
    await db.exec(`UPDATE public.businesses SET desktop_approved_version='0.6.16' WHERE name='B Foods'`);
    await db.exec(`UPDATE public.businesses SET desktop_approved_version=NULL WHERE name='B Foods'`);
  });
  await ok('a value that is not x.y.z is refused', async () => {
    for (const bad of ['v0.6.16', 'latest', '0.6', '', '0.6.16-beta']) {
      const e = await threw(() => db.exec(`UPDATE public.businesses SET desktop_approved_version='${bad}' WHERE name='B Foods'`));
      assert.ok(e && /desktop_approved_version_format/.test(e.message), `${bad}: ${e?.message}`);
    }
  });
  await ok('idempotent: running 108 again changes nothing, one migration row', async () => {
    await db.exec(`UPDATE public.businesses SET desktop_approved_version='0.6.16' WHERE name='B Foods'`);
    await db.exec(SQL108);
    const r = await db.query(`SELECT desktop_approved_version AS v FROM public.businesses WHERE name='B Foods'`);
    assert.strictEqual(r.rows[0].v, '0.6.16');
    const m = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='108_desktop_approved_version'`);
    assert.strictEqual(m.rows[0].n, 1);
  });
  await db.close();
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
