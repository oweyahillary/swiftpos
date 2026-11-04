/**
 * test-migration-134.mjs — A490: the fine permission catalogue and the rewrite of every stored grant, run for real against
 * the WHOLE schema (every migration replayed into PGlite).
 *
 * Businesses are set up the way they are in production before 134 — roles holding the broad keys (reports.view,
 * orders.void, products.manage, settings.manage, …), people with overrides of broad keys, the two cashier switches on in
 * one business — then 134 runs. Every role's keys afterwards are compared with the SHARED catalogue's own expansion
 * (packages/core/src/permissions.ts, loaded as it is: Node 24 runs the TypeScript), so the migration and the cloud's runtime
 * expansion can never disagree about what a broad key stood for.
 *
 * MUTATIONS TO CONFIRM BITE: a mapping row removed from 134 → "every role keeps exactly what it had" fails; the
 * switch condition dropped → "a business that limited its cashiers keeps them limited" fails; the legacy DELETE removed →
 * "no broad key is stored any more" fails; the policy loop removed → "owners' sessions only read" fails; a key edited in
 * packages/core/src/permissions.ts without regenerating 134 → "134 registers exactly the catalogue" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const CAT = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
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
const THIS = '134_permission_catalogue.sql';
for (const f of files.filter((f) => num(f) < 134)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const permId = async (key) => {
  const r = await one(`SELECT id FROM public.permissions WHERE key = $1`, [key]);
  if (r) return r.id;
  await db.query(`INSERT INTO public.permissions (key, label, module) VALUES ($1, $1, 'x')`, [key]);
  return (await one(`SELECT id FROM public.permissions WHERE key = $1`, [key])).id;
};
const grant = async (role, keys) => { for (const k of keys) await db.query(`INSERT INTO public.role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [role, await permId(k)]); };
const override = async (user, key, granted) => db.query(`INSERT INTO public.user_permissions (user_id, permission_id, granted) VALUES ($1, $2, $3)`, [user, await permId(key), granted]);
const roleKeys = async (role) => new Set((await q(`SELECT p.key FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`, [role])).map((r) => r.key));
const userOverrides = async (user) => Object.fromEntries((await q(`SELECT p.key, up.granted FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id WHERE up.user_id = $1`, [user])).map((r) => [r.key, r.granted]));
const sorted = (s) => [...s].sort();

console.log('\nMigration 134 (the fine permission catalogue) — PGlite, every migration\n');

// ── Before 134 ────────────────────────────────────────────────────────────────────────────────────────────────────────
const A = id(0xa0), B = id(0xb0);
await put('businesses', { id: A, name: 'Pollo', type: 'restaurant' });
await put('businesses', { id: B, name: 'Kiosk', type: 'retail' });
// A limited its cashiers with both switches; B did not.
await put('feature_flags', { business_id: A, key: 'cashier_own_history', enabled: true });
await put('feature_flags', { business_id: A, key: 'cashier_no_money_out', enabled: true });
await put('feature_flags', { business_id: A, key: 'delivery_fee', enabled: true });

const ROLES = {
  aOwner:   { id: id(0xa1), biz: A, name: 'Owner',   keys: ['reports.view', 'reports.financial', 'settings.manage', 'orders.create'] },
  aManager: { id: id(0xa2), biz: A, name: 'Manager', keys: ['orders.create', 'reports.view', 'orders.void', 'products.manage', 'staff.manage', 'inventory.receive', 'customers.manage'] },
  aCashier: { id: id(0xa3), biz: A, name: 'Cashier', keys: ['orders.create', 'products.view', 'customers.manage', 'customers.view'] },
  aBooks:   { id: id(0xa4), biz: A, name: 'Bookkeeper', keys: ['reports.financial', 'expenses.manage'] },   // cannot sell
  bCashier: { id: id(0xb3), biz: B, name: 'Cashier', keys: ['orders.create', 'products.view'] },
  bSuper:   { id: id(0xb2), biz: B, name: 'Supervisor', keys: ['orders.create', 'settings.manage', 'shifts.manage'] },
  bFront:   { id: id(0xb4), biz: B, name: 'Front desk', keys: ['orders.create', 'receipt.manage'] },   // A492: set the receipt's M-Pesa line
};
for (const r of Object.values(ROLES)) { await put('roles', { id: r.id, business_id: r.biz, name: r.name }); await grant(r.id, r.keys); }
const MARY = id(0xe1), JOE = id(0xe2);
await put('users', { id: MARY, business_id: A, name: 'Mary', role_id: ROLES.aManager.id });
await put('users', { id: JOE, business_id: A, name: 'Joe', role_id: ROLES.aCashier.id });
await override(MARY, 'reports.view', false);          // Mary may not see the operational reports
await override(MARY, 'reports.sales', true);          // …but the sales report, by its own fine key (wins over the broad)
await override(JOE, 'settings.manage', true);         // Joe was given the settings

await db.exec(sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8')));
// A510: up to 138 — 139 deliberately corrects 134's "a role without orders.create cannot sell" (selling was never
// checked before A490); test-migration-139.mjs proves that. This test keeps proving 134 as written.
const AFTER_134 = (f) => num(f) > 134 && num(f) < 139;
for (const f of files.filter(AFTER_134)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

// A518: keys a migration after the ones replayed here registers (143: payables.view) — with the catalogue's exact words.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LATER_SQL = files.filter((f) => num(f) >= 139).map((f) => fs.readFileSync(path.join(MIG, f), 'utf8')).join('\n');
const registeredLater = (p) => new RegExp(`\\('${esc(p.key)}', '${esc(p.label)}', '${esc(p.group)}', '${esc(p.description)}'\\)`).test(LATER_SQL);
const LATER_KEYS = new Set(CAT.PERMISSIONS.filter(registeredLater).map((p) => p.key));
// What the roles must hold: the catalogue's own expansion, plus what had no check before (per the switches).
const confirms = (keys) => CAT.expandKeys(keys).has('shifts.confirm');
const expected = (r, switchesOn) => {
  const out = CAT.expandKeys(r.keys);
  const sells = out.has('orders.create');
  if (sells) out.add('sales.discount');
  for (const k of ['sales.history_all', 'shifts.cash_movements']) if (sells && (!switchesOn || confirms(r.keys))) out.add(k);
  for (const k of ['staff.view', 'reservations.manage', 'parking.manage', 'fuel.manage']) out.add(k);
  if (out.has('receipt.manage')) out.add('settings.mpesa');   // A492: who could set the receipt's payment line keeps it
  if (/^(owner|admin)$/i.test(r.name)) for (const k of CAT.PERMISSION_KEYS) if (!LATER_KEYS.has(k)) out.add(k);
  // A520: a key a later migration registers and grants (147 shifts.close_branch, which settings.manage now also stands
  // for) is not 134's to give — test-migration-147 proves who gets it.
  for (const k of LATER_KEYS) out.delete(k);
  out.delete('*');
  return out;
};

await ok('134 registers exactly the catalogue: every fine key with the catalogue\'s words (generated from packages/core/src/permissions.ts)', async () => {
  const rows = await q(`SELECT key, label, module, description FROM public.permissions WHERE module <> 'legacy'`);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  // A511: a later migration (beyond what this test replays) may reword a key — 140 sets customers.credit's description
  // to the catalogue's new words. Accepted only when that migration sets EXACTLY the catalogue's words for that key.
  const later = files.filter((f) => num(f) >= 139).map((f) => fs.readFileSync(path.join(MIG, f), 'utf8')).join('\n');
  const rewordedLater = (p) => new RegExp(`SET description = '${p.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s+WHERE key = '${p.key.replace('.', '\\.')}'`).test(later);
  // A520: 147 relabels shifts.close_day ("Close the day") — accepted only with EXACTLY the catalogue's label and words.
  const relabeledLater = (p) => new RegExp(`SET label = '${esc(p.label)}', description = '${esc(p.description)}'\\s+WHERE key = '${esc(p.key)}'`).test(later);
  for (const p of CAT.PERMISSIONS) {
    // A518: a key a later migration registers (143 payables.view) — accepted only when it registers it with EXACTLY the
    // catalogue's label, group and description.
    if (!byKey[p.key] && registeredLater(p)) continue;
    if (byKey[p.key] && relabeledLater(p)) continue;
    assert.ok(byKey[p.key], `missing ${p.key}`);
    assert.equal(byKey[p.key].label, p.label, p.key); assert.equal(byKey[p.key].module, p.group, p.key);
    if (!rewordedLater(p)) assert.equal(byKey[p.key].description, p.description, p.key);
  }
  const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
  for (const [legacy, fine] of Object.entries(CAT.LEGACY)) for (const f of fine) if (!LATER_KEYS.has(f)) assert.ok(sql.includes(`('${legacy}', '${f}')`), `mapping ${legacy} → ${f} missing from 134 — regenerate it`);
});
await ok('the broad keys stay registered, marked replaced (old ids still resolve)', async () => {
  for (const k of Object.keys(CAT.LEGACY)) {
    const r = await one(`SELECT module, label FROM public.permissions WHERE key = $1`, [k]);
    if (!r) continue;   // a broad key no database ever held (shifts.manage) need not exist
    assert.equal(r.module, 'legacy', k); assert.match(r.label, /\(replaced\)$/, k);
  }
});
await ok('every role keeps exactly what it had — the same fine keys the cloud expands its old grants into', async () => {
  for (const [name, r] of Object.entries(ROLES)) {
    assert.deepEqual(sorted(await roleKeys(r.id)), sorted(expected(r, r.biz === A)), name);
  }
});
await ok('no broad key is stored any more, as a grant or an override', async () => {
  const left = await one(`SELECT count(*)::int AS n FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id WHERE p.module = 'legacy'`);
  const leftU = await one(`SELECT count(*)::int AS n FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id WHERE p.module = 'legacy'`);
  assert.equal(left.n, 0); assert.equal(leftU.n, 0);
});
await ok('a business that limited its cashiers keeps them limited — now by role — and the switches are off', async () => {
  const c = await roleKeys(ROLES.aCashier.id);
  assert.ok(!c.has('sales.history_all') && !c.has('shifts.cash_movements') && c.has('sales.discount'));
  const m = await roleKeys(ROLES.aManager.id);
  assert.ok(m.has('sales.history_all') && m.has('shifts.cash_movements'), 'the manager confirms drawers (orders.void) — keeps both');
  const b = await roleKeys(ROLES.bCashier.id);
  assert.ok(b.has('sales.history_all') && b.has('shifts.cash_movements'), 'B never limited its cashiers');
  const flags = await q(`SELECT key, enabled, notes FROM public.feature_flags WHERE business_id = $1 ORDER BY key`, [A]);
  const f = Object.fromEntries(flags.map((x) => [x.key, x]));
  assert.equal(f.cashier_own_history.enabled, false); assert.equal(f.cashier_no_money_out.enabled, false);
  assert.match(f.cashier_own_history.notes, /A490/);
  assert.equal(f.delivery_fee.enabled, true, 'other switches untouched');
});
await ok('A492: who could set the receipt M-Pesa line (receipt.manage) may set the branch M-Pesa number', async () => {
  assert.ok((await roleKeys(ROLES.bFront.id)).has('settings.mpesa'));
  assert.ok(!(await roleKeys(ROLES.bCashier.id)).has('settings.mpesa'), 'a cashier never could');
});
await ok('a role that cannot sell gets no selling keys, but what every role had (staff list, reservations, parking, fuel)', async () => {
  const k = await roleKeys(ROLES.aBooks.id);
  assert.ok(!k.has('sales.discount') && !k.has('sales.history_all') && !k.has('orders.create'));
  for (const x of ['staff.view', 'reservations.manage', 'parking.manage', 'fuel.manage', 'reports.monthly_pack', 'reports.tax', 'expenses.manage']) assert.ok(k.has(x), x);
});
await ok('a person\'s override of a broad key becomes the same override of each fine key; their own fine override wins', async () => {
  const m = await userOverrides(MARY);
  for (const k of CAT.LEGACY['reports.view']) assert.equal(m[k], k === 'reports.sales', k);
  const j = await userOverrides(JOE);
  for (const k of CAT.LEGACY['settings.manage']) if (!LATER_KEYS.has(k)) assert.equal(j[k], true, k);   // A520: 147's key aside
  // What Mary holds, worked out as the cloud does (role, then her overrides): the sales report, no other report.
  const held = CAT.expandMap({ ...Object.fromEntries([...await roleKeys(ROLES.aManager.id)].map((k) => [k, true])), ...m }, false);
  assert.ok(held.has('reports.sales') && !held.has('reports.items') && !held.has('reports.voids'));
});
await ok('owners\' own database sessions may only read feature_flags and businesses', async () => {
  const pol = await q(`SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('businesses','feature_flags')`);
  assert.ok(pol.length >= 2);
  assert.deepEqual(pol.filter((p) => p.cmd !== 'SELECT'), [], JSON.stringify(pol));
  assert.ok(pol.some((p) => p.tablename === 'feature_flags' && p.policyname === 'owner_read'));
  assert.ok(pol.some((p) => p.tablename === 'businesses' && p.policyname === 'owner_read'));
});
await ok('134 runs twice without error and records itself once; a second run changes nothing', async () => {
  const before = {}; for (const [n, r] of Object.entries(ROLES)) before[n] = sorted(await roleKeys(r.id));
  // A rerun replays 134 and what came after it (135 retires settings.updates again), as the migration runner would.
  await db.exec(sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8')));
  for (const f of files.filter(AFTER_134)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));
  for (const [n, r] of Object.entries(ROLES)) assert.deepEqual(sorted(await roleKeys(r.id)), before[n], n);
  const r = await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '134_permission_catalogue'`);
  assert.equal(r.n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
