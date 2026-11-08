/**
 * test-migration-177.mjs — A595, the owner's decisions on the default rights (2026-10-27): D1 no (cashiers and waiters keep
 * customers' contacts and history; they add customers; customers get a KRA PIN), D2 (Change cost prices off the built-in
 * Auditor and Storekeeper), D3 (webhooks and report e-mails off every role but the owner's), D5 (fuel deliveries and set-up off
 * the built-in Cashier and Fuel attendant), D6 (typed discounts off the built-in Cashier). Run for real against the WHOLE
 * schema (every migration before 177 replayed into PGlite, 176 included).
 *
 * MUTATIONS TO CONFIRM BITE: the is_default condition dropped from D6 → "a custom Cashier role keeps theirs" fails; D3's owner
 * exception dropped → "the owner's" fails; a block's guard removed → "an owner's later re-tick stays" fails; the KRA CHECK
 * dropped → "anything else refused" fails; deleting from user_permissions too → "a person's own grant is kept" fails.
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
const THIS = '177_permission_default_changes.sql';
for (const f of files.filter((f) => num(f) < 177)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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


console.log('\nMigration 177 (the owner\'s decisions on the default rights, 2026-10-27) — PGlite, every migration\n');
const CAT = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);
await put('businesses', { id: A, name: 'Sample Shop', type: 'petrol_station' });
await put('businesses', { id: B, name: 'Sample Cafe', type: 'cafe' });
const R = { cash: id(0xa1), waiter: id(0xb3), aud: id(0xa2), store: id(0xa3), gm: id(0xa4), fuel: id(0xa5), owner: id(0xa6),
  myCash: id(0xb1), bCash: id(0xb2), bStore: id(0xb4), lookout: id(0xb5) };
const ROLES = [
  [R.cash, A, 'Cashier', true, ['orders.create', 'sales.discount', 'sales.discount_preset', 'customers.view', 'customers.contacts', 'customers.history', 'fuel.manage', 'fuel.deliveries', 'fuel.setup']],
  [R.aud, A, 'Auditor', true, ['reports.sales', 'menu.costs', 'menu.costs_edit']],
  [R.store, A, ' STOREKEEPER ', true, ['inventory.receive', 'menu.costs', 'menu.costs_edit']],
  [R.gm, A, 'General Manager', true, ['settings.integrations', 'settings.webhooks', 'settings.report_emails', 'menu.costs_edit', 'sales.discount']],
  [R.fuel, A, 'Fuel attendant', true, ['orders.create', 'fuel.manage', 'fuel.deliveries', 'fuel.setup']],
  [R.owner, A, 'Owner', false, ['settings.webhooks', 'settings.report_emails']],
  [R.myCash, B, 'Cashier', false, ['orders.create', 'sales.discount', 'fuel.deliveries']],   // the owner's own role named Cashier
  [R.bCash, B, 'cashier', true, ['orders.create', 'customers.view']],
  [R.waiter, B, 'Waiter', true, ['orders.create', 'sales.discount', 'customers.view']],
  [R.bStore, B, 'Storekeeper', true, ['inventory.receive', 'menu.costs']],
  [R.lookout, B, 'Day lookout', false, ['reports.overview']],   // a custom role that used Overview for the sales report
];
// Unique (business, name) is case-sensitive: B has both 'Cashier' (custom) and 'cashier' (built in).
for (const [rid, biz, name, isDefault] of ROLES) await put('roles', { id: rid, business_id: biz, name, is_default: isDefault });
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
for (const [rid, , , , keys] of ROLES) await grant(rid, keys);
const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const JOY = id(0xc1), MO = id(0xc2);
await put('users', { id: JOY, business_id: A, name: 'Joy', role_id: R.cash, status: 'active' });
await put('users', { id: MO, business_id: A, name: 'Mo', role_id: R.cash, status: 'active' });
const override = (uid, key, granted) => db.query(`INSERT INTO public.user_permissions (user_id, permission_id, granted) SELECT $1, id, $3 FROM public.permissions WHERE key = $2`, [uid, key, granted]);
await override(JOY, 'sales.discount', true);     // the owner let Joy type discounts
await override(JOY, 'fuel.deliveries', true);    // …and record deliveries
await override(MO, 'customers.history', false);  // and took Mo's customer history away
const overridesOf = async (uid) => Object.fromEntries((await q(`SELECT p.key, up.granted FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id WHERE up.user_id = $1`, [uid])).map((r) => [r.key, r.granted]));
await put('customers', { id: id(0xd1), business_id: A, name: 'Mary', phone: '0712345678' });
const before = Object.fromEntries(await Promise.all(Object.entries(R).map(async ([n, rid]) => [n, await keysOf(rid)])));
const without = (n, ...ks) => before[n].filter((k) => !ks.includes(k));

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('177 runs', async () => { await db.exec(sanitize(sql)); });
await ok('D1 (no): the built-in Cashier and Waiter keep customers\' contacts and history, and add customers (customers.edit)', async () => {
  for (const r of [R.cash, R.bCash, R.waiter]) assert.ok((await keysOf(r)).includes('customers.edit'), r);
  for (const k of ['customers.contacts', 'customers.history']) assert.ok((await keysOf(R.cash)).includes(k), k);
  assert.ok(!(await keysOf(R.myCash)).includes('customers.edit'), 'the owner\'s own role named Cashier is left alone');
});
await ok('D1: customers have a KRA PIN — a letter, 9 digits, a letter, or none; anything else refused by the database', async () => {
  await db.query(`UPDATE public.customers SET kra_pin = 'A123456789Z' WHERE name = 'Mary'`);
  await db.query(`UPDATE public.customers SET kra_pin = NULL WHERE name = 'Mary'`);
  await assert.rejects(db.query(`UPDATE public.customers SET kra_pin = 'a12345' WHERE name = 'Mary'`));
  await assert.rejects(db.query(`UPDATE public.customers SET kra_pin = 'A123456789z' WHERE name = 'Mary'`));
});
await ok('D2: Change cost prices off the built-in Auditor and Storekeeper (any spelling); seeing costs stays; the GM keeps it', async () => {
  assert.deepEqual(await keysOf(R.aud), without('aud', 'menu.costs_edit'));
  assert.deepEqual(await keysOf(R.store), without('store', 'menu.costs_edit'));
  assert.ok((await keysOf(R.store)).includes('menu.costs'));
  assert.ok((await keysOf(R.gm)).includes('menu.costs_edit'));
});
await ok('D3: webhooks and report e-mails off every role but the owner\'s (the General Manager too)', async () => {
  assert.deepEqual(await keysOf(R.gm), without('gm', 'settings.webhooks', 'settings.report_emails'));
  assert.deepEqual(await keysOf(R.owner), before.owner);
});
await ok('D5: fuel deliveries and pump set-up off the built-in Cashier and Fuel attendant; pumps on / off stays', async () => {
  for (const [n, r] of [['fuel', R.fuel]]) assert.deepEqual(await keysOf(r), without(n, 'fuel.deliveries', 'fuel.setup'));
  const c = await keysOf(R.cash);
  assert.ok(c.includes('fuel.manage') && !c.includes('fuel.deliveries') && !c.includes('fuel.setup'));
  assert.ok((await keysOf(R.myCash)).includes('fuel.deliveries'), 'a custom role is the owner\'s');
});
await ok('D6: typed discounts off the built-in Cashier; set-up discounts stay; the Waiter and a custom Cashier role keep theirs', async () => {
  const c = await keysOf(R.cash);
  assert.ok(!c.includes('sales.discount') && c.includes('sales.discount_preset'));
  assert.ok((await keysOf(R.waiter)).includes('sales.discount'));
  assert.ok((await keysOf(R.myCash)).includes('sales.discount'));
});
await ok('D8: a role that held Overview alone gets the Sales and Item reports (Overview is now today\'s page); others untouched', async () => {
  assert.deepEqual(await keysOf(R.lookout), ['reports.items', 'reports.overview', 'reports.sales']);
  assert.ok(!(await keysOf(R.aud)).includes('reports.items'), 'no Overview: nothing given');
});
await ok('a person\'s own grant of a removed key is kept (the owner chose that person); their other overrides untouched', async () => {
  assert.deepEqual(await overridesOf(JOY), { 'sales.discount': true, 'fuel.deliveries': true });
  assert.deepEqual(await overridesOf(MO), { 'customers.history': false });
  const map = { ...Object.fromEntries((await keysOf(R.cash)).map((k) => [k, true])), ...(await overridesOf(JOY)), [CAT.MAP_MARKER]: true };
  const held = CAT.expandMap(map);
  assert.ok(held.has('sales.discount') && held.has('fuel.deliveries'), 'Joy still types discounts and records deliveries');
});
await ok('177 runs twice, records each decision once, and an owner\'s later re-tick stays', async () => {
  await grant(R.cash, ['sales.discount']);
  await db.exec(sanitize(sql));
  assert.ok((await keysOf(R.cash)).includes('sales.discount'));
  for (const v of ['177_d8_overview', '177_d1_customers_add', '177_d2_costs_edit', '177_d3_data_out', '177_d5_fuel', '177_d6_typed_discount', '177_permission_default_changes'])
    assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = $1`, [v])).n, 1, v);
});
await ok('the catalogue agrees for new businesses: Cashier without typed discounts but with contacts, history and adding customers; Waiter with all; GM without webhooks / report e-mails', async () => {
  const role = (n) => new Set(CAT.BUILT_IN_ROLES.find((r) => r.name === n).keys);
  assert.ok(!role('Cashier').has('sales.discount') && role('Cashier').has('sales.discount_preset'));
  for (const k of ['customers.contacts', 'customers.history', 'customers.edit']) { assert.ok(role('Cashier').has(k), k); assert.ok(role('Waiter').has(k), k); }
  assert.ok(role('Waiter').has('sales.discount') && role('Supervisor').has('sales.discount'));
  assert.ok(!role('General Manager').has('settings.webhooks') && !role('General Manager').has('settings.report_emails'));
  assert.ok(!role('Auditor').has('menu.costs_edit') && !role('Storekeeper').has('menu.costs_edit'));
  for (const n of ['Cashier', 'Fuel attendant']) assert.ok(!role(n).has('fuel.deliveries') && !role(n).has('fuel.setup'), n);
  // D9 (new businesses only): the Manager without write-offs, own rights, pay, retiring POS devices, expense edits, the
  // monthly pack's entries and the M-Pesa number.
  for (const k of ['customers.credit_adjust', 'staff.access', 'staff.pay', 'devices.retire', 'expenses.edit', 'expenses.monthly', 'settings.mpesa'])
    assert.ok(!role('Manager').has(k), 'Manager ' + k);
  assert.ok(role('Manager').has('customers.credit_limit') && role('Manager').has('customers.credit_payment'));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
