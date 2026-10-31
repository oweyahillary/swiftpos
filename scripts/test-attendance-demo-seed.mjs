/**
 * test-attendance-demo-seed.mjs — the DEV attendance demo (scripts/dev-seed/attendance-demo.sql) runs against the WHOLE
 * schema (every migration replayed into PGlite), adds what it says, adds nothing twice, and its cleanup removes exactly it.
 * Owner, 2026-10-31: "generate dummy data on attendance, we test how the report will look".
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const num = (f) => +f.split('_')[0];
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql') && Number.isFinite(num(f))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
const BS = String.fromCharCode(92);
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith(BS) || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
const THIS = 'x';
for (const f of files.filter((f) => num(f) < 9999)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const put = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : 'x';
  }
  const k = Object.keys(full);
  await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => full[x]));
};


const A = '00000000-0000-0000-0000-00000000000a', BR = '00000000-0000-0000-0000-00000000000b';
await put('businesses', { id: A, name: 'Demo Shop', type: 'restaurant' });
await put('branches', { id: BR, business_id: A, name: 'Main', is_main: true });
for (const [i, n] of [[1, 'Jane'], [2, 'Peter']]) await put('users', { id: `00000000-0000-0000-0000-00000000010${i}`, business_id: A, name: n, status: 'active' });
const seed = sanitize(fs.readFileSync(path.join(ROOT, 'scripts/dev-seed/attendance-demo.sql'), 'utf8')).replace("'CHANGE ME — the test business name'", "'Demo Shop'");
const clean = sanitize(fs.readFileSync(path.join(ROOT, 'scripts/dev-seed/attendance-demo-cleanup.sql'), 'utf8')).replace("'CHANGE ME — the test business name'", "'Demo Shop'");
await ok('seed runs', async () => { await db.exec(seed); });
const c = async () => ({ people: (await one(`SELECT count(*)::int n FROM attendance_people`)).n, punches: (await one(`SELECT count(*)::int n FROM clock_events`)).n,
  unmatched: (await one(`SELECT count(*)::int n FROM clock_events WHERE person_id IS NULL`)).n, devs: (await one(`SELECT count(*)::int n FROM attendance_devices`)).n,
  flag: (await one(`SELECT count(*)::int n FROM feature_flags WHERE key='attendance' AND enabled`)).n });
const first = await c(); console.log(JSON.stringify(first));
await ok('seed again adds nothing', async () => { await db.exec(seed); assert.deepEqual(await c(), first); });
await ok('cleanup removes it all', async () => { await db.exec(clean); assert.deepEqual(await c(), { people: 0, punches: 0, unmatched: 0, devs: 0, flag: 0 }); });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
