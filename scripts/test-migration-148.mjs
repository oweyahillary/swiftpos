/**
 * test-migration-148.mjs — A522: nothing waits on a till that is switched off. Every migration replayed into PGlite.
 *
 * Owner, 2026-10-17: "check if anything will break or fail to respond because a till has not responded … even Pollo
 * restaurant had the same issue when deleting the menu". Pollo's exact case: one open shift and two open trading days that
 * began in the test window, on tills that never synced since — the clear was refused, and ending the window later never
 * helps. purge_test_window / purge_test_menu_window take p_close_open: ticked, they are cleared with the rest; the old
 * names keep their 8 arguments and call them unticked (no overload — re-running 122 / 123 / 132 stays safe).
 *
 * MUTATIONS TO CONFIRM BITE: the idle-shift NOT EXISTS on sales after the window removed → "a shift … with a sale AFTER it
 * is still refused" fails; the wrappers passing true → "Pollo unticked: refused" fails; purge_test_menu_window not passing
 * p_close_open on → "purge_test_menu_window takes the tick" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort((a, b) => (+a.split('_')[0]) - (+b.split('_')[0]) || a.localeCompare(b));
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
for (const f of files) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));   // every migration, in order — a failure fails the test

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const count = async (t, w = 'true', p = []) => Number((await one(`SELECT count(*)::int AS n FROM public.${t} WHERE ${w}`, p)).n);

// A row with what the table demands (NOT NULL, no default) filled in, then the given values.
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

console.log('\nMigration 148 (nothing waits on a till that is off) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const B = id(0xb1), OTHER = id(0xb2), BR = id(0xa1), OBR = id(0xa2), U = id(0xe1), U2 = id(0xe2);
const FROM = '2026-10-01T08:00:00Z', TO = '2026-10-02T18:00:00Z';
await put('businesses', { id: B, name: 'Pollo', type: 'restaurant' });
await put('businesses', { id: OTHER, name: 'Someone Else', type: 'restaurant' });
await put('branches', { id: BR, business_id: B, name: 'Westlands' });
await put('branches', { id: OBR, business_id: OTHER, name: 'Other' });
await put('users', { id: U, business_id: B, name: 'Mary' });
await put('users', { id: U2, business_id: B, name: 'Joe' });

// Pollo's exact case: tills switched off (never synced since) left one shift and two trading days open in the window.
const DAY1 = id(0xd1), DAY2 = id(0xd2), SHIFT = id(0xc1), CLOSED_SHIFT = id(0xc2);
await put('business_days', { id: DAY1, business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', business_date: '2026-10-01', opened_at: '2026-10-01T09:00:00Z', status: 'open' });
await put('business_days', { id: DAY2, business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: 'T2', business_date: '2026-10-02', opened_at: '2026-10-02T09:00:00Z', status: 'open' });
await put('shifts', { id: SHIFT, business_id: B, branch_id: BR, cashier_id: U, opened_at: '2026-10-01T09:05:00Z', status: 'open', opening_float: 0, business_day_id: DAY1, device_id: 'dev-T1' });
await put('shifts', { id: CLOSED_SHIFT, business_id: B, branch_id: BR, cashier_id: U2, opened_at: '2026-10-02T09:05:00Z', closed_at: '2026-10-02T12:00:00Z', status: 'closed', opening_float: 0, business_day_id: DAY2 });
await put('orders', { id: id(0xa5), business_id: B, branch_id: BR, order_number: 'T1-0001', total: 120, created_at: '2026-10-01T12:00:00Z', shift_id: SHIFT });
await put('orders', { id: id(0xa8), business_id: OTHER, branch_id: OBR, order_number: 'X-0001', total: 120, created_at: '2026-10-01T12:00:00Z' });
const fnCount = async (fn) => Number((await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1`, [fn])).n);
const nargs = async (fn) => Number((await one(`SELECT pronargs AS n FROM pg_proc WHERE proname = $1`, [fn])).n);

await ok('the columns for the till own count after a web close exist (nullable)', async () => {
  const cols = await q(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shifts' AND column_name IN ('till_counted_cash','till_counted_at','till_confirmed_methods')`);
  assert.equal(cols.length, 3);
  assert.ok(cols.every((c) => c.is_nullable === 'YES'));
});
await ok('the old names keep their 8 arguments (no overload); the _window ones take the tick', async () => {
  for (const fn of ['purge_test_data', 'purge_test_menu', 'purge_test_window', 'purge_test_menu_window']) assert.equal(await fnCount(fn), 1, fn);
  assert.equal(await nargs('purge_test_data'), 8); assert.equal(await nargs('purge_test_menu'), 8);
  assert.equal(await nargs('purge_test_window'), 9); assert.equal(await nargs('purge_test_menu_window'), 9);
});
await ok('Pollo unticked: refused — the problems name the shift and the two days open on tills that are off, and the tick', async () => {
  const r = (await one(`SELECT public.purge_test_data($1, $2, $3, 'undo', false, true) AS r`, [B, FROM, TO])).r;
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /^1 shift\(s\) that began in the window are still open on a till that is switched off .* tick Also clear/.test(p)), JSON.stringify(r.problems));
  assert.ok(r.problems.some((p) => /^2 trading day\(s\) that began in the window are still open on a till that is switched off/.test(p)), JSON.stringify(r.problems));
  assert.ok(!r.problems.some((p) => /still open or closed after it/.test(p)), 'the idle ones are not counted twice: ' + JSON.stringify(r.problems));
  assert.equal(r.counts.open_on_tills, 3);
  assert.equal(r.counts.open_shifts, 1); assert.equal(r.counts.open_days, 2);
});
await ok('the tick unset on purge_test_window is the same refusal', async () => {
  const r = (await one(`SELECT public.purge_test_window($1, $2, $3, 'undo', false, true, 'x', 'y', false) AS r`, [B, FROM, TO])).r;
  assert.equal(r.ok, false);
});
await ok('ticked, the preview is clear (and a preview changes nothing)', async () => {
  const r = (await one(`SELECT public.purge_test_window(p_business => $1, p_from => $2, p_to => $3, p_dry_run => true, p_close_open => true) AS r`, [B, FROM, TO])).r;
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.counts.close_open, true);
  assert.equal(await count('shifts', 'business_id = $1', [B]), 2);
});
await ok('a shift open in the window with a sale AFTER it is still refused, ticked or not', async () => {
  const LIVE = id(0xc3);
  await put('users', { id: id(0xe3), business_id: B, name: 'Ann' });
  await put('shifts', { id: LIVE, business_id: B, branch_id: BR, cashier_id: id(0xe3), opened_at: '2026-10-02T10:00:00Z', status: 'open', opening_float: 0 });
  await put('orders', { id: id(0xa9), business_id: B, branch_id: BR, order_number: 'T3-0001', total: 50, created_at: '2026-10-03T09:00:00Z', shift_id: LIVE });
  const r = (await one(`SELECT public.purge_test_window(p_business => $1, p_from => $2, p_to => $3, p_dry_run => true, p_close_open => true) AS r`, [B, FROM, TO])).r;
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /^1 shift\(s\) that began in the window are still open or closed after it/.test(p)), JSON.stringify(r.problems));
  await db.query(`DELETE FROM public.orders WHERE id = $1`, [id(0xa9)]);
  await db.query(`DELETE FROM public.shifts WHERE id = $1`, [LIVE]);
});
await ok('ticked, the clear removes the open shift and both open days with the rest — another business untouched', async () => {
  const r = (await one(`SELECT public.purge_test_window(p_business => $1, p_from => $2, p_to => $3, p_dry_run => false, p_done_by => 'admin', p_reason => 'go-live', p_close_open => true) AS r`, [B, FROM, TO])).r;
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(await count('shifts', 'business_id = $1', [B]), 0);
  assert.equal(await count('business_days', 'business_id = $1', [B]), 0);
  assert.equal(await count('orders', 'business_id = $1', [B]), 0);
  assert.equal(await count('orders', 'business_id = $1', [OTHER]), 1);
  assert.equal(await count('test_data_purges', 'business_id = $1', [B]), 1);
});
await ok('purge_test_menu refuses unticked; purge_test_menu_window takes the tick (named, as the admin route calls it)', async () => {
  await put('business_days', { id: id(0xd3), business_id: B, branch_id: BR, device_id: 'dev-T1', business_date: '2026-10-01', opened_at: '2026-10-01T09:00:00Z', status: 'open' });
  const off = (await one(`SELECT public.purge_test_menu(p_business => $1, p_from => $2, p_to => $3, p_dry_run => true) AS r`, [B, FROM, TO])).r;
  assert.equal(off.ok, false);
  const on = (await one(`SELECT public.purge_test_menu_window(p_business => $1, p_from => $2, p_to => $3, p_dry_run => false, p_close_open => true) AS r`, [B, FROM, TO])).r;
  assert.equal(on.ok, true, JSON.stringify(on.problems));
  assert.equal(await count('business_days', 'business_id = $1', [B]), 0);
});
await ok('re-running 148 — and 122 / 123 / 132 after it — leaves one of each function, all callable', async () => {
  for (const f of ['148_offline_tills.sql', '122_test_data_purge.sql', '123_wastage.sql', '132_test_data_menu.sql']) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));
  for (const fn of ['purge_test_data', 'purge_test_menu', 'purge_test_window', 'purge_test_menu_window']) assert.equal(await fnCount(fn), 1, fn);
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '148_offline_tills'`)).n), 1);
  assert.equal(typeof (await one(`SELECT public.purge_test_data($1, $2, $3) AS r`, [B, FROM, TO])).r.ok, 'boolean');
  assert.equal((await one(`SELECT public.purge_test_window($1, $2, $3, p_close_open => true) AS r`, [B, FROM, TO])).r.ok, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
