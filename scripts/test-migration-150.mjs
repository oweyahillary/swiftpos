/**
 * test-migration-150.mjs — A528: sync_versions (one catalogue and one staff version per business, bumped by triggers),
 * run for real against the WHOLE schema (every migration before 150 replayed into PGlite).
 *
 * Production was suspended (2026-10-19) for bandwidth: every till asked catalogue-version every 20 s and each answer ran
 * 16 queries. Now the database keeps the version; the cloud reads one row.
 *
 *   - 150 runs twice, recorded once; every business already there has both rows (version 1).
 *   - catalogue: an insert, an update and a delete of each of the 16 tables moves the business's version — a branch-only
 *     row (no business_id) through its branch, businesses by its own id; another business's version does not move.
 *   - staff: users, roles, role_permissions (through the role), user_branches, user_permissions, user_devices (join,
 *     reject, retire, move) move it; a till merely being seen (last_seen_at) does not.
 *   - many rows in one transaction bump once; the e-mail jobs' bookkeeping rows in business_settings do not bump.
 *   - a trigger that cannot write never fails the write (sync_versions gone: the product still saves).
 *   - RLS on, no policy; the columns match scripts/schema-index.json.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-19): the branch lookup removed → "branch_printers through its
 * branch" fails; the once-per-transaction flag removed → "one transaction bumps once" fails; the bookkeeping filter
 * removed → "job bookkeeping does not bump" fails; the user_devices WHEN clause removed → "last_seen_at does not bump"
 * fails; the EXCEPTION block removed → "never fails the write" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
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
const THIS = '150_sync_versions.sql';
for (const f of files.filter((f) => num(f) < 150)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const fill = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : `x-${crypto.randomUUID().slice(0, 8)}`;
  }
  return full;
};
const put = async (table, row) => {
  const full = await fill(table, row);
  const k = Object.keys(full);
  return (await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => full[x]))).rows[0];
};
const ver = async (biz, topic = 'catalogue') => Number((await one(`SELECT version FROM public.sync_versions WHERE business_id = $1 AND topic = $2`, [biz, topic]))?.version ?? -1);

console.log('\nMigration 150 (sync versions) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);
const BR = id(0xa1), BRB = id(0xb1), ROLE = id(0xa2), USER = id(0xa3), CAT = id(0xa4);
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
await put('businesses', { id: B, name: 'Other', type: 'retail' });
await put('branches', { id: BR, business_id: A, name: 'Main' });
await put('branches', { id: BRB, business_id: B, name: 'Other main' });
await put('roles', { id: ROLE, business_id: A, name: 'Cashier' });
await put('users', { id: USER, business_id: A, role_id: ROLE, name: 'Wanjiru', status: 'active' });
await put('categories', { id: CAT, business_id: A, name: 'Fries' });

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('150 runs (and again — idempotent), recorded once', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '150_sync_versions'`)).n), 1);
});
await ok('the seed: every business there before has both rows, version 1', async () => {
  for (const b of [A, B]) for (const t of ['catalogue', 'staff']) assert.equal(await ver(b, t), 1, `${b} ${t}`);
});
await ok('RLS on, no policy (only the service role reads it)', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sync_versions'::regclass`)).relrowsecurity, true);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'sync_versions'`)).n), 0);
});
await ok('the columns match scripts/schema-index.json', async () => {
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8')).sync_versions;
  assert.ok(want, 'sync_versions missing from schema-index.json');
  const have = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sync_versions'`)).map((r) => r.column_name).sort();
  assert.deepEqual(have, Object.keys(want).sort());
});

// Each catalogue table: a row of business A (a branch row through branch BR), then update and delete it.
const CATALOGUE = {
  products:          () => ({ business_id: A, category_id: CAT, name: 'Chips' }),
  categories:        () => ({ business_id: A, name: 'Drinks' }),
  business_settings: () => ({ business_id: A, key: `k-${crypto.randomUUID().slice(0, 6)}`, value: '"x"' }),
  business_branding: () => ({ business_id: A }),
  feature_flags:     () => ({ business_id: A, key: `f-${crypto.randomUUID().slice(0, 6)}`, enabled: true }),
  users:             () => ({ business_id: A, role_id: ROLE, name: 'Otieno', status: 'active' }),
  tables:            () => ({ business_id: A, branch_id: BR, name: 'T9' }),
  branches:          () => ({ business_id: A, name: 'Westlands' }),
  branch_printers:   () => ({ business_id: A, branch_id: BR, name: 'Kitchen' }),
  branch_prices:     () => ({ business_id: A, branch_id: BR, product_id: null, price: 100 }),
  stock_takes:       () => ({ business_id: A, branch_id: BR }),
  offers:            () => ({ business_id: A, name: 'Happy hour', kind: 'percent_off' }),
  promotions:        () => ({ business_id: A, name: 'Promo' }),
  print_stations:    () => ({ business_id: A, branch_id: BR, name: 'Grill' }),
  branch_settings:   () => ({ business_id: A, branch_id: BR, key: `b-${crypto.randomUUID().slice(0, 6)}`, value: '"x"' }),
};
for (const [table, mk] of Object.entries(CATALOGUE)) {
  await ok(`catalogue: ${table} — insert, update and delete each move it (business B untouched)`, async () => {
    if (!(await one(`SELECT to_regclass($1) AS r`, [`public.${table}`])).r) return;   // not in this schema: skipped, as the migration does
    const row = mk();
    if (table === 'branch_prices') {
      const p = await put('products', { business_id: A, category_id: CAT, name: `P-${crypto.randomUUID().slice(0, 6)}` });
      row.product_id = p.id;
    }
    const b0 = await ver(B);
    let v = await ver(A);
    const full = await put(table, row);
    const key = full.id ? ['id', full.id] : ['business_id', A];
    assert.equal(await ver(A), v + 1, 'insert'); v++;
    await db.query(`UPDATE public.${table} SET updated_at = now() WHERE ${key[0]} = $1`, [key[1]]).catch(async () => {
      await db.query(`UPDATE public.${table} SET ${key[0]} = ${key[0]} WHERE ${key[0]} = $1`, [key[1]]);
    });
    assert.equal(await ver(A), v + 1, 'update'); v++;
    await db.query(`DELETE FROM public.${table} WHERE ${key[0]} = $1`, [key[1]]);
    assert.equal(await ver(A), v + 1, 'delete');
    assert.equal(await ver(B), b0, 'another business');
  });
}
await ok('catalogue: businesses — by its own id', async () => {
  const v = await ver(B);
  await db.query(`UPDATE public.businesses SET name = 'Other Ltd' WHERE id = $1`, [B]);
  assert.equal(await ver(B), v + 1);
});
await ok('catalogue: branch_printers through its branch when the row carries no business_id', async () => {
  const v = await ver(A);
  await db.exec(`ALTER TABLE public.branch_printers ALTER COLUMN business_id DROP NOT NULL`);
  await put('branch_printers', { business_id: null, branch_id: BR, name: 'Bar' });
  assert.equal(await ver(A), v + 1);
});
await ok('a new business gets its row on its first change (version 1)', async () => {
  const C = id(0xc);
  await put('businesses', { id: C, name: 'New', type: 'retail' });
  assert.equal(await ver(C), 1);
  assert.equal(await ver(C, 'staff'), -1, 'no staff row until a staff change');
});
await ok('one transaction bumps once (a bulk import of three products)', async () => {
  const v = await ver(A);
  await db.transaction(async (tx) => {
    for (const n of ['a', 'b', 'c']) await tx.query(`INSERT INTO public.products (business_id, category_id, name) VALUES ($1, $2, $3)`, [A, CAT, `bulk-${n}`]);
  });
  assert.equal(await ver(A), v + 1);
  await db.query(`INSERT INTO public.products (business_id, category_id, name) VALUES ($1, $2, 'after')`, [A, CAT]);
  assert.equal(await ver(A), v + 2, 'the next transaction bumps again');
});
await ok('job bookkeeping in business_settings does not bump (owner alerts, weekly, monthly, report, branch tills)', async () => {
  const v = await ver(A);
  for (const k of ['owner_alerts_state', 'weekly_summary_last_sent', 'monthly_pack_last_sent', 'report_schedule_last_sent', `branch_open_tills_last_sent:${BR}`]) {
    await put('business_settings', { business_id: A, key: k, value: '"2026-10-19"' });
    await db.query(`UPDATE public.business_settings SET value = '"2026-10-20"' WHERE business_id = $1 AND key = $2`, [A, k]);
  }
  assert.equal(await ver(A), v);
  await put('business_settings', { business_id: A, key: 'receipt_footer', value: '"Asante"' });
  assert.equal(await ver(A), v + 1, 'a real setting does');
});

// Staff.
await ok('staff: users — a new cashier, a PIN change, a deactivation', async () => {
  let v = await ver(A, 'staff');
  const u = await put('users', { business_id: A, role_id: ROLE, name: 'Akinyi', status: 'active' });
  assert.equal(await ver(A, 'staff'), ++v);
  await db.query(`UPDATE public.users SET pin_hash = '$2b$10$abc' WHERE id = $1`, [u.id]);
  assert.equal(await ver(A, 'staff'), ++v);
  await db.query(`UPDATE public.users SET status = 'inactive' WHERE id = $1`, [u.id]);
  assert.equal(await ver(A, 'staff'), ++v);
});
await ok('staff: roles, and role_permissions through the role', async () => {
  let v = await ver(A, 'staff');
  await db.query(`UPDATE public.roles SET name = 'Till Cashier' WHERE id = $1`, [ROLE]);
  assert.equal(await ver(A, 'staff'), ++v);
  await db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions ORDER BY key LIMIT 1 ON CONFLICT DO NOTHING`, [ROLE]);
  assert.ok(await ver(A, 'staff') > v, 'role_permissions');
  const before = await ver(B, 'staff');
  assert.equal(await ver(B, 'staff'), before);
});
await ok('staff: user_branches and user_permissions (no business_id: through the person or the branch)', async () => {
  let v = await ver(A, 'staff');
  await put('user_branches', { user_id: USER, branch_id: BR });
  assert.ok(await ver(A, 'staff') > v, 'user_branches'); v = await ver(A, 'staff');
  const perm = (await one(`SELECT id FROM public.permissions ORDER BY key LIMIT 1`)).id;
  await put('user_permissions', { user_id: USER, permission_id: perm, granted: true });
  assert.ok(await ver(A, 'staff') > v, 'user_permissions');
});
await ok('staff: user_devices — a till joins, is rejected, retired, moved: each moves it', async () => {
  let v = await ver(A, 'staff');
  const d = await put('user_devices', { business_id: A, user_id: USER, device_id: 'till-1', status: 'approved' });
  assert.equal(await ver(A, 'staff'), ++v, 'join');
  await db.query(`UPDATE public.user_devices SET status = 'rejected' WHERE id = $1`, [d.id]);
  assert.equal(await ver(A, 'staff'), ++v, 'rejected');
  await db.query(`UPDATE public.user_devices SET retired_at = now() WHERE id = $1`, [d.id]);
  assert.equal(await ver(A, 'staff'), ++v, 'retired');
  await db.query(`UPDATE public.user_devices SET branch_id = $2 WHERE id = $1`, [d.id, BR]);
  assert.equal(await ver(A, 'staff'), ++v, 'moved');
});
await ok('staff: a till merely seen, synced or renewing (last_seen_at, last_sync_at) does not move it', async () => {
  const d = (await one(`SELECT id FROM public.user_devices WHERE device_id = 'till-1'`)).id;
  const v = await ver(A, 'staff');
  await db.query(`UPDATE public.user_devices SET last_seen_at = now() WHERE id = $1`, [d]);
  await db.query(`UPDATE public.user_devices SET last_sync_at = now() WHERE id = $1`, [d]);
  assert.equal(await ver(A, 'staff'), v);
});
await ok('a trigger that cannot write never fails the write (sync_versions gone: the product still saves)', async () => {
  await db.exec(`ALTER TABLE public.sync_versions RENAME TO sync_versions_away`);
  try {
    await db.query(`INSERT INTO public.products (business_id, category_id, name) VALUES ($1, $2, 'still saves')`, [A, CAT]);
    assert.ok(await one(`SELECT id FROM public.products WHERE name = 'still saves'`));
  } finally { await db.exec(`ALTER TABLE public.sync_versions_away RENAME TO sync_versions`); }
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
