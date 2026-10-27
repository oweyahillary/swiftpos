/**
 * test-migration-175.mjs — A594 (owner, 2026-10-26: "we need to turn off that option for cashiers by default unless
 * allowed"; then "we need to break those permissions further"): cash in / cash out / expenses as three rights —
 * shifts.cash_movements relabelled Record cash in, shifts.cash_out and expenses.record registered with the catalogue's
 * words — and every existing role carried over once: an approver keeps all three; a business that ever set A453's switch
 * (a stored feature_flags row, on or off) keeps all three; every other selling role loses cash in (the new default); the
 * owner roles get the new keys; a person's own override of cash in is copied to the two new keys. Run for real against
 * the WHOLE schema (every migration before 175 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the approver condition dropped from the DELETE → "a Manager keeps all three" fails; the
 * feature_flags condition dropped → "a business that set the switch keeps it" fails; step 1 after step 2 → "…gets cash
 * out and expenses" fails for that business; the guard removed → "an owner's later re-tick stays" fails; a label changed
 * in the SQL → "the catalogue's exact words" fails; step 4 removed → "a person's own override" fails.
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
const THIS = '175_cash_movement_rights.sql';
for (const f of files.filter((f) => num(f) < 175)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 175 (cash in / cash out / expenses as three rights) — PGlite, every migration\n');
const CAT = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);   // A never touched the switch; B's admin set it (stored row, off = cashiers allowed)
await put('businesses', { id: A, name: 'Sample Shop', type: 'retail' });
await put('businesses', { id: B, name: 'Sample Cafe', type: 'cafe' });
await db.query(`INSERT INTO public.feature_flags (business_id, key, enabled) VALUES ($1, 'cashier_no_money_out', false)`, [B]);
const R = { aCash: id(0xa1), aMgr: id(0xa2), aWaiter: id(0xa3), aOwner: id(0xa4), aGm: id(0xa5), aBooks: id(0xa6), bCash: id(0xb1), bOwner: id(0xb2) };
for (const [rid, biz, name] of [[R.aCash, A, 'Cashier'], [R.aMgr, A, 'Manager'], [R.aWaiter, A, 'Waiter'], [R.aOwner, A, 'Owner'],
  [R.aGm, A, 'General Manager'], [R.aBooks, A, 'Accountant'], [R.bCash, B, 'Cashier'], [R.bOwner, B, 'admin']]) await put('roles', { id: rid, business_id: biz, name });
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
await grant(R.aCash, ['orders.create', 'sales.discount', 'shifts.cash_movements']);
await grant(R.aMgr, ['orders.create', 'shifts.confirm', 'shifts.cash_movements']);
await grant(R.aWaiter, ['orders.create', 'shifts.cash_movements']);
await grant(R.aGm, ['orders.create', 'shifts.confirm', 'shifts.cash_movements']);
await grant(R.aBooks, ['reports.sales']);
await grant(R.bCash, ['orders.create', 'shifts.cash_movements']);
const JOE = id(0xa9), ANN = id(0xa8);
await put('users', { id: JOE, business_id: A, name: 'Joe', role_id: R.aCash, status: 'active' });
await put('users', { id: ANN, business_id: A, name: 'Ann', role_id: R.aMgr, status: 'active' });
const override = (uid, key, granted) => db.query(`INSERT INTO public.user_permissions (user_id, permission_id, granted) SELECT $1, id, $3 FROM public.permissions WHERE key = $2`, [uid, key, granted]);
await override(JOE, 'shifts.cash_movements', true);    // the owner gave Joe cash in, in Staff
await override(ANN, 'shifts.cash_movements', false);   // …and took it from Ann
const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const overrides = async (uid) => Object.fromEntries((await q(`SELECT p.key, up.granted FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id WHERE up.user_id = $1`, [uid])).map((r) => [r.key, r.granted]));
const MONEY = ['expenses.record', 'shifts.cash_movements', 'shifts.cash_out'];
const money = async (rid) => (await keysOf(rid)).filter((k) => MONEY.includes(k));
const before = { books: await keysOf(R.aBooks) };

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('175 runs', async () => { await db.exec(sanitize(sql)); });
await ok('the catalogue\'s exact words: Record cash in (relabelled), Record cash out / pay-outs, Record expenses', async () => {
  for (const key of MONEY) {
    const p = CAT.PERMISSIONS.find((x) => x.key === key);
    const r = await one(`SELECT label, module, description FROM public.permissions WHERE key = $1`, [key]);
    assert.ok(p && r, key);
    assert.equal(r.label, p.label, key); assert.equal(r.module, p.group, key); assert.equal(r.description, p.description, key);
  }
});
await ok('a business that never touched the switch: its Cashier and Waiter lose cash in and get neither new right (the new default)', async () => {
  assert.deepEqual(await money(R.aCash), []);
  assert.deepEqual(await money(R.aWaiter), []);
  assert.ok((await keysOf(R.aCash)).includes('orders.create') && (await keysOf(R.aCash)).includes('sales.discount'), 'nothing else touched');
});
await ok('a Manager and a General Manager (approve drawers) keep cash in and get cash out and expenses', async () => {
  assert.deepEqual(await money(R.aMgr), MONEY);
  assert.deepEqual(await money(R.aGm), MONEY);
});
await ok('a business that set the switch keeps it — its Cashier holds all three (nothing changes there)', async () => {
  assert.deepEqual(await money(R.bCash), MONEY);
});
await ok('the owner roles (Owner, admin) get the new rights; a role without cash in is untouched', async () => {
  for (const r of [R.aOwner, R.bOwner]) for (const k of ['shifts.cash_out', 'expenses.record']) assert.ok((await keysOf(r)).includes(k), k);
  assert.deepEqual(await keysOf(R.aBooks), before.books);
});
await ok('a person\'s own override (Staff) is the owner\'s explicit choice: kept, and copied to the two new rights', async () => {
  assert.deepEqual(await overrides(JOE), { 'shifts.cash_movements': true, 'shifts.cash_out': true, 'expenses.record': true });
  assert.deepEqual(await overrides(ANN), { 'shifts.cash_movements': false, 'shifts.cash_out': false, 'expenses.record': false });
  // Joe, worked out as the cloud does (role, then his overrides): cash in although his role lost it.
  const held = CAT.expandMap({ ...Object.fromEntries((await keysOf(R.aCash)).map((k) => [k, true])), ...(await overrides(JOE)), [CAT.MAP_MARKER]: true });
  assert.ok(held.has('shifts.cash_movements') && held.has('shifts.cash_out'));
});
await ok('175 runs twice, records itself once, and an owner\'s later re-tick stays', async () => {
  await grant(R.aCash, ['shifts.cash_movements']);
  await db.exec(sanitize(sql));
  assert.deepEqual(await money(R.aCash), ['shifts.cash_movements']);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '175_cash_movement_rights'`)).n, 1);
});
await ok('the catalogue agrees: new Cashiers hold none of the three; Manager, Supervisor and General Manager all three', async () => {
  const role = (n) => CAT.BUILT_IN_ROLES.find((r) => r.name === n).keys;
  for (const k of MONEY) {
    assert.ok(!role('Cashier').includes(k), `Cashier: ${k}`);
    for (const n of ['Manager', 'Supervisor', 'General Manager']) assert.ok(role(n).includes(k), `${n}: ${k}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
