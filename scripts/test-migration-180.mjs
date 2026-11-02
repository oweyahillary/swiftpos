/**
 * test-migration-180.mjs — A599 (owner, 2026-10-27/28): Attendance (premium) — the devices, the people on them (an
 * attendance-only person is never a users row), the device's user list, the device actions, clock_events extended with
 * device punches and corrections (staff_id nullable, the dedupe index), and attendance.view / edit / devices. Idempotent.
 * Run for real against the WHOLE schema (every migration before 180 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the unique dedupe index dropped → "a device punch sent twice" fails; the source CHECK
 * dropped → "a PIN row needs its staff, a correction its reason" fails; the schema_migrations guard on the grants dropped
 * → "a right the owner took away is not given back on a re-run" fails.
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
const THIS = '180_attendance.sql';
for (const f of files.filter((f) => num(f) < 180)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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



console.log('\nMigration 180 (attendance: devices, people, device users, actions, clock_events device punches, rights) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), A2 = id(0xb), BR = id(0xb1), BR2 = id(0xb2), U = id(0xc1);
await put('businesses', { id: A, name: 'Sample Cafe', type: 'restaurant' });
await put('businesses', { id: A2, name: 'Other', type: 'retail' });
await put('branches', { id: BR, business_id: A, name: 'Westlands' });
await put('branches', { id: BR2, business_id: A2, name: 'Theirs' });
await put('users', { id: U, business_id: A, name: 'Akinyi', email: 'a@example.com' });
const OLD = id(0xe1);
await put('clock_events', { id: OLD, business_id: A, staff_id: U, branch_id: BR, event_type: 'in' });
const role = async (n, name, isDefault, biz = A) => { await put('roles', { id: id(n), business_id: biz, name, is_default: isDefault }); return id(n); };
const R_OWNER = await role(0xf1, 'Owner', true), R_MGR = await role(0xf2, 'Manager', true), R_GM = await role(0xf3, 'General Manager', true),
  R_CASH = await role(0xf4, 'Cashier', true), R_FAKE = await role(0xf5, 'Manager', false, A2);   // a role the owner made, merely named Manager
const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
const keysOf = async (r) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 AND p.key LIKE 'attendance.%' ORDER BY p.key`, [r])).map((x) => x.key);

await ok('180 runs, and again (idempotent), recording itself once', async () => {
  await db.exec(sanitize(sql)); await db.exec(sanitize(sql));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '180_attendance'`)).n, 1);
});
await ok('an existing PIN clock event is untouched: source pin, its staff kept', async () => {
  const r = await one(`SELECT source, staff_id, event_type, person_id, voided_at FROM public.clock_events WHERE id = $1`, [OLD]);
  assert.deepEqual([r.source, r.staff_id, r.event_type, r.person_id, r.voided_at], ['pin', U, 'in', null, null]);
});
await ok('the rights: owner roles all three; the BUILT-IN Manager and General Manager view + edit; a Cashier and a custom "Manager" none', async () => {
  assert.deepEqual(await keysOf(R_OWNER), ['attendance.devices', 'attendance.edit', 'attendance.view']);
  assert.deepEqual(await keysOf(R_MGR), ['attendance.edit', 'attendance.view']);
  assert.deepEqual(await keysOf(R_GM), ['attendance.edit', 'attendance.view']);
  assert.deepEqual(await keysOf(R_CASH), []); assert.deepEqual(await keysOf(R_FAKE), []);
  const p = await one(`SELECT label, module FROM public.permissions WHERE key = 'attendance.devices'`);
  assert.deepEqual([p.label, p.module], ['Attendance devices', 'staff']);
});
await ok('a right the owner took away is not given back on a re-run', async () => {
  await db.query(`DELETE FROM public.role_permissions WHERE role_id = $1 AND permission_id = (SELECT id FROM public.permissions WHERE key = 'attendance.edit')`, [R_MGR]);
  await db.exec(sanitize(sql));
  assert.deepEqual(await keysOf(R_MGR), ['attendance.view']);
});
const DEV = id(0xd1), P1 = id(0x91);
await ok('a device and an attendance-only person (no users row); the number unique per business — another business may use it', async () => {
  await db.query(`INSERT INTO public.attendance_devices (id, business_id, branch_id, name, ip, serial) VALUES ($1, $2, $3, 'Front door', '192.168.1.201', 'K90-1')`, [DEV, A, BR]);
  await db.query(`INSERT INTO public.attendance_people (id, business_id, branch_id, name, attendance_no) VALUES ($1, $2, $3, 'Mama Njeri', 7)`, [P1, A, BR]);
  await assert.rejects(db.query(`INSERT INTO public.attendance_people (business_id, branch_id, name, attendance_no) VALUES ($1, $2, 'Twin', 7)`, [A, BR]));
  await db.query(`INSERT INTO public.attendance_people (business_id, branch_id, name, attendance_no) VALUES ($1, $2, 'Theirs', 7)`, [A2, BR2]);
  for (const bad of [0, 1000000000]) await assert.rejects(db.query(`INSERT INTO public.attendance_people (business_id, name, attendance_no) VALUES ($1, 'X', $2)`, [A, bad]), undefined, String(bad));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.users WHERE name = 'Mama Njeri'`)).n, 0);
  await assert.rejects(db.query(`INSERT INTO public.attendance_devices (business_id, branch_id, name, ip, port) VALUES ($1, $2, 'X', '1.2.3.4', 70000)`, [A, BR]));
});
await ok('a device punch without staff (attendance-only, or a number nobody has) is stored; sent twice it is stored once', async () => {
  const ins = `INSERT INTO public.clock_events (business_id, branch_id, event_type, recorded_at, source, device_id, device_serial, device_user_id, attendance_no, person_id)
    VALUES ($1, $2, 'punch', '2026-10-20T05:00:00Z', 'device', $3, 'K90-1', $4, $5, $6) ON CONFLICT (business_id, device_serial, device_user_id, recorded_at) DO NOTHING RETURNING id`;
  assert.equal((await q(ins, [A, BR, DEV, '7', 7, P1])).length, 1);
  assert.equal((await q(ins, [A, BR, DEV, '7', 7, P1])).length, 0, 'the second is a duplicate');
  assert.equal((await q(ins, [A, BR, DEV, '12', 12, null])).length, 1, 'unmatched: kept with its number');
  await assert.rejects(db.query(`INSERT INTO public.clock_events (business_id, branch_id, event_type, recorded_at, source, device_serial, device_user_id) VALUES ($1, $2, 'punch', '2026-10-20T05:00:00Z', 'device', 'K90-1', '7')`, [A, BR]), undefined, 'the plain insert of the same punch');
});
await ok('a PIN row needs its staff, a correction its reason; a void its reason; event types in / out / punch only', async () => {
  await assert.rejects(db.query(`INSERT INTO public.clock_events (business_id, event_type) VALUES ($1, 'in')`, [A]), undefined, 'pin without staff');
  await assert.rejects(db.query(`INSERT INTO public.clock_events (business_id, event_type, source, person_id) VALUES ($1, 'punch', 'correction', $2)`, [A, P1]), undefined, 'no reason');
  await assert.rejects(db.query(`INSERT INTO public.clock_events (business_id, event_type, source, person_id, reason) VALUES ($1, 'punch', 'correction', $2, '  ')`, [A, P1]), undefined, 'blank reason');
  await db.query(`INSERT INTO public.clock_events (business_id, event_type, source, person_id, reason) VALUES ($1, 'punch', 'correction', $2, 'Device was off')`, [A, P1]);
  await assert.rejects(db.query(`INSERT INTO public.clock_events (business_id, staff_id, event_type) VALUES ($1, $2, 'lunch')`, [A, U]));
  await assert.rejects(db.query(`UPDATE public.clock_events SET voided_at = now() WHERE id = $1`, [OLD]), undefined, 'a void without a reason');
  await db.query(`UPDATE public.clock_events SET voided_at = now(), void_reason = 'Wrong day' WHERE id = $1`, [OLD]);
});
await ok('device users and actions: one row per device user; actions write_user / delete_user only, pending at first', async () => {
  await db.query(`INSERT INTO public.attendance_device_users (business_id, device_id, device_user_id, name) VALUES ($1, $2, '12', 'John')`, [A, DEV]);
  await assert.rejects(db.query(`INSERT INTO public.attendance_device_users (business_id, device_id, device_user_id, name) VALUES ($1, $2, '12', 'Again')`, [A, DEV]));
  await db.query(`INSERT INTO public.attendance_device_actions (business_id, branch_id, device_id, action, attendance_no, name) VALUES ($1, $2, $3, 'write_user', 7, 'Mama Njeri')`, [A, BR, DEV]);
  await assert.rejects(db.query(`INSERT INTO public.attendance_device_actions (business_id, branch_id, device_id, action, attendance_no) VALUES ($1, $2, $3, 'enroll_finger', 7)`, [A, BR, DEV]));
  assert.equal((await one(`SELECT status FROM public.attendance_device_actions LIMIT 1`)).status, 'pending');
  assert.equal((await one(`SELECT overwrite FROM public.attendance_device_actions LIMIT 1`)).overwrite, false, 'an automatic write never overwrites a stranger');
});
await ok('RLS on for the four new tables (service role only)', async () => {
  const rows = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('attendance_devices', 'attendance_people', 'attendance_device_users', 'attendance_device_actions') ORDER BY relname`);
  assert.equal(rows.length, 4); assert.ok(rows.every((r) => r.relrowsecurity), JSON.stringify(rows));
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
