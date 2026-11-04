/**
 * test-migration-176.mjs — A595 (owner, 2026-10-26: "implement the changes and break down any right that you feel is too
 * big and exposes data — some can be broken down to view and edit etc."): 36 narrower rights registered with the
 * catalogue's exact words, and every existing grant carried over once so NOBODY gains or loses anything — every role
 * holding a parent gets its parts (shared/permissions.ts SPLITS), every person's own override of a parent is carried to
 * its parts (given or taken), credit limits go to exactly the built-in Manager / General Manager roles (the A585 / A587
 * role-name rule it replaces), the owner roles get every new key. Run for real against the WHOLE schema (every migration
 * before 176 replayed into PGlite).
 *
 * The property that matters is checked for every person of the fixture: what they hold AFTER 176 (stored grants read as
 * they are — a part not held stays not held) equals what they held BEFORE (a parent bringing its parts, as the cloud reads
 * it until 176 is recorded).
 *
 * MUTATIONS TO CONFIRM BITE: step 2 removed (overrides skipped) → "a person's override of a parent" and "every person
 * holds the same" fail; step 2's role fallback dropped (held := up.granted only) → "a part with two parents" fails; the
 * is_default condition dropped from step 3 → "a custom role merely named Manager" fails; a label changed in the SQL → "the
 * catalogue's exact words" fails; the guard removed → "an owner's later untick stays" fails; a pair dropped from the
 * VALUES → "every role holding a parent holds all its parts" fails.
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
const THIS = '176_permission_splits.sql';
for (const f of files.filter((f) => num(f) < 176)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 176 (the permission splits: parts of the broad rights, carried over) — PGlite, every migration\n');
const CAT = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const PARTS = [...new Set(Object.values(CAT.SPLITS).flat())];
const NEW = [...PARTS, 'customers.credit_limit'];
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);
await put('businesses', { id: A, name: 'Sample Shop', type: 'retail' });
await put('businesses', { id: B, name: 'Sample Cafe', type: 'cafe' });
const R = {
  cashier: id(0xa1), mgr: id(0xa2), gm: id(0xa3), customMgr: id(0xa4), store: id(0xa5), ops: id(0xa6), owner: id(0xa7),
  books: id(0xa8), petrol: id(0xa9), renamedMgr: id(0xaa), bAdmin: id(0xb1), bMgr: id(0xb2),
};
const ROLES = [
  [R.cashier, A, 'Cashier', true, ['orders.create', 'sales.discount', 'customers.view', 'customers.edit', 'parking.manage', 'fuel.manage', 'staff.view']],
  [R.mgr, A, 'Manager', true, ['orders.create', 'customers.view', 'customers.edit', 'customers.credit', 'staff.view', 'staff.edit',
    'shifts.confirm', 'inventory.receive', 'devices.approve', 'expenses.manage', 'reports.sales', 'reports.voids', 'sales.discount']],
  [R.gm, A, 'General  manager', true, CAT.PERMISSION_KEYS.filter((k) => !NEW.includes(k))],   // case and spaces aside
  [R.customMgr, B, 'Manager', false, ['customers.credit', 'staff.edit']],                      // a custom role merely named Manager
  [R.store, A, 'Storekeeper', true, ['inventory.receive', 'menu.costs', 'inventory.view']],
  [R.ops, A, 'Operations_Manager', true, ['inventory.adjust', 'menu.edit', 'changes.approve', 'settings.business', 'settings.integrations', 'payables.manage']],
  [R.owner, A, 'Owner', false, CAT.PERMISSION_KEYS.filter((k) => !NEW.includes(k))],
  [R.books, A, 'Accountant', true, ['reports.overview']],
  [R.petrol, A, 'Fuel attendant', true, ['orders.create', 'fuel.manage']],
  [R.renamedMgr, A, 'Branch boss', true, ['customers.credit']],                                  // built in, renamed away
  [R.bAdmin, B, 'admin', false, ['orders.create']],
  [R.bMgr, B, ' MANAGER ', true, ['orders.create']],
];
for (const [rid, biz, name, isDefault] of ROLES) await put('roles', { id: rid, business_id: biz, name, is_default: isDefault });
const grant = (rid, keys) => db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions
  WHERE key = ANY($2) ON CONFLICT DO NOTHING`, [rid, keys]);
for (const [rid, , , , keys] of ROLES) await grant(rid, keys);

const U = { joe: id(0xc1), ann: id(0xc2), kim: id(0xc3), lee: id(0xc4), may: id(0xc5), pat: id(0xc6), sam: id(0xc7) };
await put('users', { id: U.joe, business_id: A, name: 'Joe', role_id: R.cashier, status: 'active' });
await put('users', { id: U.ann, business_id: A, name: 'Ann', role_id: R.mgr, status: 'active' });
await put('users', { id: U.kim, business_id: A, name: 'Kim', role_id: R.ops, status: 'active' });
await put('users', { id: U.lee, business_id: A, name: 'Lee', role_id: R.store, status: 'active' });
await put('users', { id: U.may, business_id: A, name: 'May', role_id: R.cashier, status: 'active' });
await put('users', { id: U.pat, business_id: A, name: 'Pat', role_id: R.cashier, status: 'active' });   // a partner (web access)
await put('users', { id: U.sam, business_id: A, name: 'Sam', role_id: R.books, status: 'active' });
const override = (uid, key, granted) => db.query(`INSERT INTO public.user_permissions (user_id, permission_id, granted) SELECT $1, id, $3 FROM public.permissions WHERE key = $2`, [uid, key, granted]);
await override(U.joe, 'customers.view', false);     // the owner took the customer list from Joe
await override(U.joe, 'menu.edit', true);           // …and gave him the menu
await override(U.ann, 'shifts.confirm', false);     // Ann may not approve
await override(U.ann, 'staff.edit', false);
await override(U.kim, 'inventory.receive', false);  // Kim: receiving taken away, but her role adjusts stock (reorder levels)
await override(U.lee, 'inventory.adjust', true);    // Lee: adjusting given on top of receiving
await override(U.may, 'staff.edit', true);          // May may edit staff
await override(U.may, 'fuel.manage', false);
await override(U.sam, 'reports.sales', true);
await db.query(`INSERT INTO public.business_settings (business_id, key, value) VALUES ($1, 'web_partners', $2::jsonb)`,
  [A, JSON.stringify({ [U.pat]: { auth_user_id: id(0xf1), status: 'active', granted_at: '2026-10-21T10:00:00Z', granted_by: null } })]);

const keysOf = async (rid) => (await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = $1 ORDER BY p.key`, [rid])).map((x) => x.key);
const overrides = async (uid) => Object.fromEntries((await q(`SELECT p.key, up.granted FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id WHERE up.user_id = $1`, [uid])).map((r) => [r.key, r.granted]));
const users = async () => q(`SELECT id, role_id FROM public.users WHERE business_id = $1`, [A]);
/** What a person holds as the cloud reads it (role grants, then their overrides — lib/effectiveKeys.ts). */
const heldBy = async (u, partsBefore) => {
  const map = {};
  for (const k of await keysOf(u.role_id)) map[k] = true;
  Object.assign(map, await overrides(u.id));
  return [...CAT.expandMap(map, false, partsBefore)].sort();
};
const beforeRoles = Object.fromEntries(await Promise.all(Object.entries(R).map(async ([n, rid]) => [n, await keysOf(rid)])));
// Before 176 the built-in Manager / General Manager set credit limits by their role's NAME (A585 / A587) — the key now.
const LIMIT_ROLES = [R.mgr, R.gm, R.bMgr];
const beforeHeld = Object.fromEntries(await Promise.all((await users()).map(async (u) => [u.id,
  [...(await heldBy(u, true)), ...(LIMIT_ROLES.includes(u.role_id) ? ['customers.credit_limit'] : [])].sort()])));
const beforeOverrides = Object.fromEntries(await Promise.all(Object.entries(U).map(async ([n, uid]) => [n, await overrides(uid)])));

const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('176 runs', async () => { await db.exec(sanitize(sql)); });
await ok('the catalogue\'s exact words for all 36 new rights (35 parts + customers.credit_limit)', async () => {
  assert.equal(NEW.length, 36);
  for (const key of NEW) {
    const p = CAT.PERMISSIONS.find((x) => x.key === key);
    const r = await one(`SELECT label, module, description FROM public.permissions WHERE key = $1`, [key]);
    assert.ok(p && r, key);
    assert.equal(r.label, p.label, key); assert.equal(r.module, p.group, key); assert.equal(r.description, p.description, key);
  }
});
await ok('the parents keep their frozen words (134) — the new meaning is display-time (businessTerms.ts permissionWords)', async () => {
  for (const parent of Object.keys(CAT.SPLITS)) {
    const p = CAT.PERMISSIONS.find((x) => x.key === parent);
    const r = await one(`SELECT label FROM public.permissions WHERE key = $1`, [parent]);
    assert.equal(r.label, p.label, parent);
  }
});
await ok('every role holding a parent holds all its parts — and nothing else is added or taken away', async () => {
  for (const [n, rid] of Object.entries(R)) {
    const name = ROLES.find((x) => x[0] === rid)[2];
    if (/^(owner|admin)$/i.test(name.trim())) continue;
    const want = new Set(CAT.withParts(beforeRoles[n]));
    if (['mgr', 'gm', 'bMgr'].includes(n)) want.add('customers.credit_limit');
    assert.deepEqual(await keysOf(rid), [...want].sort(), n);
  }
});
await ok('a part with two parents: receiving OR adjusting stock brings reorder levels; seeing OR editing staff brings their contacts', async () => {
  assert.ok((await keysOf(R.store)).includes('inventory.reorder'));
  assert.ok((await keysOf(R.ops)).includes('inventory.reorder'));
  assert.ok((await keysOf(R.cashier)).includes('staff.contacts'), 'staff.view');
  assert.ok((await keysOf(R.customMgr)).includes('staff.contacts'), 'staff.edit');
});
await ok('credit limits: exactly the built-in Manager and General Manager roles (case, spaces, underscores aside) — not a custom role named Manager, not a renamed one, not a partner', async () => {
  const holds = async (rid) => (await keysOf(rid)).includes('customers.credit_limit');
  assert.equal(await holds(R.mgr), true, 'built-in Manager');
  assert.equal(await holds(R.gm), true, 'built-in General  manager');
  assert.equal(await holds(R.bMgr), true, 'built-in " MANAGER "');
  assert.equal(await holds(R.customMgr), false, 'custom "Manager" (is_default false)');
  assert.equal(await holds(R.renamedMgr), false, 'built in but renamed away');
  assert.equal(await holds(R.store), false);
  assert.equal(await holds(R.cashier), false, 'Pat is a partner on the Cashier role: the A587 partner rule stays in the code (D4)');
  assert.equal((await overrides(U.pat))['customers.credit_limit'], undefined, 'no override for a partner');
});
await ok('the owner roles (Owner, admin) get every new key', async () => {
  for (const r of [R.owner, R.bAdmin]) { const k = await keysOf(r); for (const x of NEW) assert.ok(k.includes(x), x); }
});
await ok('a person\'s override of a parent is carried to its parts — given or taken, the same value', async () => {
  const joe = await overrides(U.joe);
  assert.equal(joe['customers.contacts'], false); assert.equal(joe['customers.history'], false);
  assert.equal(joe['menu.delete'], true); assert.equal(joe['menu.bulk'], true);
  const ann = await overrides(U.ann);
  assert.equal(ann['shifts.approve_payout'], false); assert.equal(ann['sales.approve_kitchen_void'], false);
  for (const k of ['staff.pins', 'staff.access', 'staff.pay']) assert.equal(ann[k], false, k);
  // staff.contacts has two parents — Ann's role still lets her SEE staff (staff.view), so she kept their contacts.
  assert.equal(ann['staff.contacts'], true, 'seen through staff.view');
  const may = await overrides(U.may);
  for (const k of ['staff.pins', 'staff.access', 'staff.pay', 'staff.contacts']) assert.equal(may[k], true, k);
  assert.equal(may['fuel.deliveries'], false); assert.equal(may['fuel.setup'], false);
  assert.equal((await overrides(U.sam))['reports.analytics'], true);
});
await ok('a part with two parents takes what the person had through EITHER: Kim (receiving taken, role adjusts) keeps reorder; Lee (adjusting given) gets the count review', async () => {
  const kim = await overrides(U.kim);
  assert.equal(kim['inventory.reorder'], true, 'through her role\'s inventory.adjust');
  assert.equal(kim['suppliers.manage'], false); assert.equal(kim['inventory.order'], false);
  const lee = await overrides(U.lee);
  assert.equal(lee['inventory.count_review'], true); assert.equal(lee['inventory.reorder'], true);
});
await ok('an override of a key that was not split is untouched; nobody without an override gets one', async () => {
  for (const [n, uid] of Object.entries(U)) {
    const now = await overrides(uid);
    for (const [k, v] of Object.entries(beforeOverrides[n])) assert.equal(now[k], v, `${n}: ${k}`);
    for (const k of Object.keys(now)) if (!(k in beforeOverrides[n])) assert.ok(PARTS.includes(k), `${n}: ${k}`);
  }
  assert.deepEqual(await overrides(U.pat), {});
});
await ok('THE PROPERTY: every person holds exactly the same after 176 (parts read as stored) as before (a parent bringing its parts)', async () => {
  for (const u of await users()) { const a = await heldBy(u, false), b = beforeHeld[u.id]; assert.deepEqual(a, b, `${u.id}: after-only ${a.filter((k) => !b.includes(k))} before-only ${b.filter((k) => !a.includes(k))}`); }
});
await ok('nothing is taken away: no grant and no override row was deleted', async () => {
  for (const [n, rid] of Object.entries(R)) for (const k of beforeRoles[n]) assert.ok((await keysOf(rid)).includes(k), `${n}: ${k}`);
});
await ok('176 runs twice, records itself once, and an owner\'s later untick stays', async () => {
  await db.query(`DELETE FROM public.role_permissions rp USING public.permissions p WHERE rp.permission_id = p.id AND rp.role_id = $1 AND p.key = 'customers.contacts'`, [R.cashier]);
  await db.exec(sanitize(sql));
  assert.ok(!(await keysOf(R.cashier)).includes('customers.contacts'));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '176_permission_splits'`)).n, 1);
});
await ok('the catalogue agrees: SPLITS names only catalogue keys, every part has a parent, no part is a parent, no cycle', async () => {
  for (const [p, cs] of Object.entries(CAT.SPLITS)) {
    assert.ok(CAT.isPermissionKey(p), p);
    for (const c of cs) { assert.ok(CAT.isPermissionKey(c), c); assert.ok(!CAT.SPLITS[c], `${c} is a part and a parent`); }
  }
  assert.ok(sql.includes(`IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '176_permission_splits')`));
  const values = sql.slice(sql.indexOf('INSERT INTO a595_parts'), sql.indexOf(';', sql.indexOf('INSERT INTO a595_parts')));
  let pairs = 0;
  for (const [p, cs] of Object.entries(CAT.SPLITS)) for (const c of cs) { pairs++; assert.ok(values.includes(`('${p}', '${c}')`), `pair ${p} → ${c} missing from 176 — regenerate it`); }
  assert.equal((values.match(/\('[a-z_]+\.[a-z_]+', '[a-z_]+\.[a-z_]+'\)/g) ?? []).length, pairs, 'no pair beyond SPLITS');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
