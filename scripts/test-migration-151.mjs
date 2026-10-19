/**
 * test-migration-151.mjs — A531: sync_changes (one entry per changed row, written by triggers), run for real against the
 * WHOLE schema (every migration before 151 replayed into PGlite, 150 included).
 *
 * Owner, 2026-10-19: "if I change fries from 100 to 150 the trigger should only send the affected product and price, not
 * the whole menu … if Eugene's PIN changes only Eugene's change gets synced, not all 150 staff."
 *
 *   - 151 runs twice, recorded once; RLS on both tables, no policy; the columns match scripts/schema-index.json; the
 *     functions are not callable by anon / authenticated.
 *   - every synced table writes ITS entry: the logical table, the row, the topic, the branch, upsert or delete (a part — an
 *     option, a combo line, a grant — is an upsert of what it belongs to; a delete of a product / person / table is a
 *     delete) — and sync_versions still moves exactly as 150 made it (catalogue / staff).
 *   - fries 100 → 150: ONE entry (products, fries); Eugene's PIN: ONE entry (staff, Eugene); a person merely active
 *     (last_active_at) writes nothing; an update that changes nothing writes nothing.
 *   - settings by key: public.sync_setting_topic agrees with shared/syncTopics.ts settingTopic on every key below;
 *     bookkeeping keys write nothing; a businesses update writes only the topics of the columns that moved.
 *   - one transaction: the same row written once.
 *   - sync_changes_since: after `since`, the branch's and every-branch entries only (not another branch's, not another
 *     business's), the last 120 s again, the limit. sync_changes_heads: one read, every business.
 *   - prune_sync_changes: old entries go, the floor keeps the highest removed.
 *   - a trigger that cannot write never fails the write.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-19):
 *   - the users ignore-list removed (any update logs)                   → "last_active_at writes nothing" fails
 *   - the coalescing flag removed                                       → "one transaction: the same row once" fails
 *   - sync_setting_topic money rule without strpos(tax)                 → "TS and SQL agree" fails
 *   - the branch filter in sync_changes_since removed                   → "not another branch's" fails
 *   - the 120 s window removed                                          → "the last 120 s again" fails
 *   - the EXCEPTION handler re-raising (RAISE instead of RAISE WARNING)  → "never fails the write" fails
 *   - the businesses column check replaced by all three topics          → "only the topics that moved" fails
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const { settingTopic, CHANGE_TABLES } = await import(pathToFileURL(path.join(ROOT, 'shared/syncTopics.ts')).href);
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
const THIS = '151_sync_changes.sql';
for (const f of files.filter((f) => num(f) < 151)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
const maxSeq = async () => Number((await one(`SELECT COALESCE(max(seq), 0) AS m FROM public.sync_changes`)).m);
/** The entries written since `from` (seq > from), oldest first. */
const since = async (from) => (await q(`SELECT seq, business_id, branch_id, topic, table_name, row_id, op FROM public.sync_changes WHERE seq > $1 ORDER BY seq`, [from]))
  .map((r) => ({ ...r, seq: Number(r.seq) }));
const brief = (rows) => rows.map((r) => `${r.table_name}:${r.row_id}:${r.topic}:${r.op}${r.branch_id ? `@${r.branch_id.slice(-2)}` : ''}`);
const ver = async (biz, topic = 'catalogue') => Number((await one(`SELECT version FROM public.sync_versions WHERE business_id = $1 AND topic = $2`, [biz, topic]))?.version ?? -1);

console.log('\nMigration 151 (sync changes) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const A = id(0xa), B = id(0xb);
const BR = id(0xa1), BR2 = id(0xa5), BRB = id(0xb1), ROLE = id(0xa2), EUGENE = id(0xa3), CAT = id(0xa4);
await put('businesses', { id: A, name: 'KRUNCH & CO', type: 'restaurant' });
await put('businesses', { id: B, name: 'Other', type: 'retail' });
await put('branches', { id: BR, business_id: A, name: 'Main' });
await put('branches', { id: BR2, business_id: A, name: 'Westlands' });
await put('branches', { id: BRB, business_id: B, name: 'Other main' });
await put('roles', { id: ROLE, business_id: A, name: 'Cashier' });
await put('users', { id: EUGENE, business_id: A, role_id: ROLE, name: 'Eugene', status: 'active', pin_hash: '$2b$10$old' });
await put('categories', { id: CAT, business_id: A, name: 'Fries' });
const FRIES = (await put('products', { business_id: A, category_id: CAT, name: 'Fries', base_price: 100 })).id;

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('151 runs (and again — idempotent), recorded once; nothing written by the migration itself', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '151_sync_changes'`)).n), 1);
  assert.equal(await maxSeq(), 0);
  assert.equal(Number((await one(`SELECT floor_seq FROM public.sync_change_floor WHERE id = 1`)).floor_seq), 0);
});
await ok('RLS on both tables, no policy; the functions are not callable by anon or authenticated', async () => {
  for (const t of ['sync_changes', 'sync_change_floor']) {
    assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`])).relrowsecurity, true, t);
    assert.equal(Number((await one(`SELECT count(*) AS n FROM pg_policies WHERE tablename = $1`, [t])).n), 0, t);
  }
  for (const f of ['public.sync_changes_since(uuid, bigint, uuid, integer)', 'public.sync_changes_heads(bigint)', 'public.prune_sync_changes(integer)']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS x`, [role, f])).x, false, `${role} ${f}`);
    }
    assert.equal((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [f])).x, true, `service_role ${f}`);
  }
});
await ok('the columns match scripts/schema-index.json', async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  for (const t of ['sync_changes', 'sync_change_floor']) {
    assert.ok(idx[t], `${t} missing from schema-index.json`);
    const have = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t])).map((r) => r.column_name).sort();
    assert.deepEqual(have, Object.keys(idx[t]).sort());
  }
});

await ok('fries 100 → 150: ONE entry — products:fries (menu, upsert); and the catalogue version still moves (150)', async () => {
  const s = await maxSeq(); const v = await ver(A);
  await db.query(`UPDATE public.products SET base_price = 150 WHERE id = $1`, [FRIES]);
  assert.deepEqual(brief(await since(s)), [`products:${FRIES}:menu:upsert`]);
  assert.equal(await ver(A), v + 1);
});
await ok('Eugene\'s PIN: ONE entry — staff:eugene (staff); the staff version still moves (150)', async () => {
  const s = await maxSeq(); const v = await ver(A, 'staff');
  await db.query(`UPDATE public.users SET pin_hash = '$2b$10$new' WHERE id = $1`, [EUGENE]);
  assert.deepEqual(brief(await since(s)), [`staff:${EUGENE}:staff:upsert`]);
  assert.equal(await ver(A, 'staff'), v + 1);
});
await ok('a person merely active (last_active_at) and an update that changes nothing write nothing', async () => {
  const s = await maxSeq();
  await db.query(`UPDATE public.users SET last_active_at = now() WHERE id = $1`, [EUGENE]);
  await db.query(`UPDATE public.categories SET name = name WHERE id = $1`, [CAT]);
  assert.deepEqual(await since(s), []);
});
await ok('a product deleted: a delete; a category, a table, a person deleted: deletes', async () => {
  const p = await put('products', { business_id: A, category_id: CAT, name: 'Old' });
  const t = await put('tables', { business_id: A, branch_id: BR, name: 'T9' });
  const u = await put('users', { business_id: A, role_id: ROLE, name: 'Gone', status: 'active' });
  const c = await put('categories', { business_id: A, name: 'Gone' });
  const s = await maxSeq();
  await db.query(`DELETE FROM public.products WHERE id = $1`, [p.id]);
  await db.query(`DELETE FROM public.tables WHERE id = $1`, [t.id]);
  await db.query(`DELETE FROM public.users WHERE id = $1`, [u.id]);
  await db.query(`DELETE FROM public.categories WHERE id = $1`, [c.id]);
  assert.deepEqual(brief(await since(s)), [`products:${p.id}:menu:delete`, `tables:${t.id}:setup:delete@a1`, `staff:${u.id}:staff:delete`, `categories:${c.id}:menu:delete`]);
});

// Each part: what it belongs to, an upsert (even when the part itself is deleted).
await ok('the parts of a product: variants, add-ons, combo lines, a branch price — the product, upsert (at its branch for a price)', async () => {
  const combo = (await put('products', { business_id: A, category_id: CAT, name: 'Meal', is_combo: true })).id;
  let s = await maxSeq();
  const vg = await put('variant_groups', { product_id: FRIES, name: 'Size' });
  const vo = await put('variant_options', { variant_group_id: vg.id, name: 'Large', price_adjustment: 50 });
  const mg = await put('modifier_groups', { product_id: FRIES, name: 'Sauce' });
  await put('modifier_options', { modifier_group_id: mg.id, name: 'Chilli', price: 0 });
  await db.query(`DELETE FROM public.variant_options WHERE id = $1`, [vo.id]);
  assert.deepEqual([...new Set(brief(await since(s)))], [`product_choices:${FRIES}:menu:upsert`]);
  s = await maxSeq();
  await put('combo_items', { combo_id: combo, product_id: FRIES, quantity: 1 });
  await put('branch_prices', { business_id: A, branch_id: BR2, product_id: FRIES, price: 140 });
  assert.deepEqual(brief(await since(s)), [`products:${combo}:menu:upsert`, `products:${FRIES}:menu:upsert@a5`]);
});
await ok('offers, promotions, stock counts (the branch), categories: menu', async () => {
  const s = await maxSeq();
  const o = await put('offers', { business_id: A, name: 'Happy hour', kind: 'percent_off' });
  const p = await put('promotions', { business_id: A, name: 'Promo' });
  await put('stock_takes', { business_id: A, branch_id: BR });
  assert.deepEqual(brief(await since(s)), [`offers:${o.id}:menu:upsert`, `promotions:${p.id}:menu:upsert`, `stock_count:${BR}:menu:upsert@a1`]);
});
await ok('staff: a branch given, a grant, a role renamed and a role grant — the person or the role', async () => {
  const s = await maxSeq();
  await put('user_branches', { user_id: EUGENE, branch_id: BR });
  const perm = (await one(`SELECT id FROM public.permissions ORDER BY key LIMIT 1`)).id;
  await put('user_permissions', { user_id: EUGENE, permission_id: perm, granted: true });
  await db.query(`UPDATE public.roles SET name = 'Till Cashier' WHERE id = $1`, [ROLE]);
  await db.query(`INSERT INTO public.role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ROLE, perm]);
  // four statements, four transactions: each writes its own entry (the cloud serves each row once — lib/syncChanges.ts)
  assert.deepEqual([...new Set(brief(await since(s)))], [`staff:${EUGENE}:staff:upsert`, `roles:${ROLE}:staff:upsert`]);
});
await ok('look and setup: branding, print stations (with their categories), tables, pumps, branches', async () => {
  const s = await maxSeq();
  await put('business_branding', { business_id: A });
  const st = await put('print_stations', { business_id: A, branch_id: BR, name: 'Grill' });
  await put('category_stations', { business_id: A, category_id: CAT, station_id: st.id });
  const t = await put('tables', { business_id: A, branch_id: BR2, name: 'T1' });
  await db.query(`UPDATE public.branches SET name = 'Main Street' WHERE id = $1`, [BR]);
  const got = [...new Set(brief(await since(s)))];
  assert.deepEqual(got.filter((x) => !x.startsWith('pumps')), ['branding:branding:look:upsert', 'print_stations:*:setup:upsert', `tables:${t.id}:setup:upsert@a5`, 'config:setup:setup:upsert']);
  if ((await one(`SELECT to_regclass('public.pumps') AS r`)).r) {
    const s2 = await maxSeq();
    const pu = await put('pumps', { business_id: A, branch_id: BR, name: 'P1' });
    assert.deepEqual(brief(await since(s2)), [`pumps:${pu.id}:setup:upsert@a1`]);
  }
});
await ok('money: payment methods, POS switches; the themes switch is the look (branding); a payment method moves the catalogue version', async () => {
  const s = await maxSeq(); const v = await ver(A);
  await put('payment_methods', { business_id: A, name: 'Voucher', code: 'voucher' });
  await put('feature_flags', { business_id: A, key: 'receipt_compact', enabled: true });
  await put('feature_flags', { business_id: A, key: 'themes', enabled: true });
  assert.deepEqual([...new Set(brief(await since(s)))], ['config:money:money:upsert', 'branding:branding:look:upsert']);
  assert.ok(await ver(A) > v, 'tills before 1.0.20 learn of a payment method within 20 s');
});
await ok('a businesses update writes only the topics of the columns that moved (name → look, VAT → money, type → setup)', async () => {
  let s = await maxSeq();
  await db.query(`UPDATE public.businesses SET name = 'KRUNCH Ltd' WHERE id = $1`, [A]);
  assert.deepEqual(brief(await since(s)), ['config:look:look:upsert']);
  s = await maxSeq();
  await db.query(`UPDATE public.businesses SET vat_rate = 8 WHERE id = $1`, [A]);
  assert.deepEqual(brief(await since(s)), ['config:money:money:upsert']);
  s = await maxSeq();
  await db.query(`UPDATE public.businesses SET type = 'retail' WHERE id = $1`, [A]);
  assert.deepEqual(brief(await since(s)), ['config:setup:setup:upsert']);
  s = await maxSeq();
  await db.query(`UPDATE public.businesses SET desktop_approved_version = '1.0.20' WHERE id = $1`, [A]);
  assert.deepEqual(brief(await since(s)), [], 'a column no till reads');
});

// Settings by key: the SQL and the TypeScript agree.
const KEYS = ['receipt_header', 'receipt_footer', 'receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account', 'mpesa_shortcode',
  'mpesa_passkey', 'payment_methods_enabled', 'void_window_minutes', 'offline_refund_methods', 'offline_reverse_web_sales',
  'delivery_free_allowed', 'delivery_free_over', 'delivery_fee', 'loyalty_enabled', 'loyalty_earn_rate', 'continuous_operation',
  'business_day_cutoff', 'cashier_history_methods', 'cashier_sees_shift_sales', 'cashier_history_totals', 'service_charge_pct',
  'kitchen_exclusions', 'order_note_picks', 'stock_count_freeze', 'restaurant_order_mode', 'scanner_beep', 'report_schedule',
  'owner_alerts_state', 'weekly_summary_last_sent', 'monthly_pack_last_sent', 'report_schedule_last_sent',
  `branch_open_tills_last_sent:${BR}`, 'tax_mode', 'vat_inclusive', 'ctl_mode', 'business_phone', 'contact_email',
  'thank_you_message', 'aggregator_commission_glovo', 'parking_rate_car', 'require_device_registration', 'etims_enabled'];
await ok('settings: public.sync_setting_topic agrees with shared/syncTopics.ts settingTopic on every key', async () => {
  for (const k of KEYS) {
    const sqlTopic = (await one(`SELECT public.sync_setting_topic($1) AS t`, [k])).t;
    assert.equal(sqlTopic, settingTopic(k), k);
  }
  assert.equal(settingTopic('receipt_header'), 'look'); assert.equal(settingTopic('receipt_pay_number'), 'money');
  assert.equal(settingTopic('kitchen_exclusions'), 'setup'); assert.equal(settingTopic('owner_alerts_state'), null);
});
await ok('settings write config:<topic> (a branch setting at its branch); the freeze is the stock count; bookkeeping nothing', async () => {
  let s = await maxSeq();
  await put('business_settings', { business_id: A, key: 'receipt_footer', value: '"Asante"' });
  await put('business_settings', { business_id: A, key: 'void_window_minutes', value: '10' });
  await put('business_settings', { business_id: A, key: 'kitchen_exclusions', value: '[]' });
  await put('business_settings', { business_id: A, key: 'stock_count_freeze', value: '"true"' });
  await put('branch_settings', { business_id: A, branch_id: BR2, key: 'receipt_pay_number', value: '"123"' });
  assert.deepEqual(brief(await since(s)), ['config:look:look:upsert', 'config:money:money:upsert', 'config:setup:setup:upsert',
    'stock_count:*:menu:upsert', 'config:money:money:upsert@a5']);
  s = await maxSeq();
  for (const k of ['owner_alerts_state', 'weekly_summary_last_sent', 'monthly_pack_last_sent', 'report_schedule_last_sent', `branch_open_tills_last_sent:${BR}`]) {
    await put('business_settings', { business_id: A, key: k, value: '"2026-10-19"' });
  }
  assert.deepEqual(await since(s), []);
});
await ok('CHANGE_TABLES (shared/syncTopics.ts) names every table the triggers sit on', async () => {
  const want = new Set(Object.values(CHANGE_TABLES).flatMap((t) => t.from));
  const have = new Set((await q(`SELECT DISTINCT event_object_table AS t FROM information_schema.triggers WHERE trigger_name = 'trg_log_sync_change'`)).map((r) => r.t));
  for (const t of have) assert.ok(want.has(t), `${t} has the trigger but is not in CHANGE_TABLES`);
  for (const t of want) if ((await one(`SELECT to_regclass($1) AS r`, [`public.${t}`])).r) assert.ok(have.has(t), `${t} is in CHANGE_TABLES but has no trigger`);
});
await ok('one transaction: the same row once (a price saved three times; a bulk import of three products: three entries)', async () => {
  const s = await maxSeq();
  await db.transaction(async (tx) => {
    for (const p of [110, 120, 130]) await tx.query(`UPDATE public.products SET base_price = $2 WHERE id = $1`, [FRIES, p]);
    for (const n of ['a', 'b', 'c']) await tx.query(`INSERT INTO public.products (business_id, category_id, name) VALUES ($1, $2, $3)`, [A, CAT, `bulk-${n}`]);
  });
  const got = await since(s);
  assert.equal(got.length, 4, brief(got).join(' '));
  assert.equal(got.filter((r) => r.row_id === FRIES).length, 1);
});
await ok('another business: its own entries only', async () => {
  const s = await maxSeq();
  await put('categories', { business_id: B, name: 'Theirs' });
  const got = await since(s);
  assert.equal(got.length, 1); assert.equal(got[0].business_id, B);
});

// The reads.
const rpcSince = async (biz, from, branch, limit = 500) => (await q(`SELECT * FROM public.sync_changes_since($1, $2, $3, $4)`, [biz, from, branch, limit]))
  .map((r) => ({ ...r, seq: Number(r.seq) }));
await ok('sync_changes_since: after `since` — this branch and every branch, not another branch\'s, not another business\'s', async () => {
  await db.exec(`UPDATE public.sync_changes SET changed_at = now() - interval '1 hour'`);   // out of the 120 s window
  const s = await maxSeq();
  const p = await put('products', { business_id: A, category_id: CAT, name: 'Wings' });
  await put('branch_prices', { business_id: A, branch_id: BR2, product_id: p.id, price: 300 });
  await put('categories', { business_id: B, name: 'Not mine' });
  await db.exec(`UPDATE public.sync_changes SET changed_at = now() - interval '1 hour'`);
  const atMain = await rpcSince(A, s, BR);
  assert.deepEqual(atMain.map((r) => `${r.table_name}:${r.row_id}`), [`products:${p.id}`]);
  const atWest = await rpcSince(A, s, BR2);
  assert.equal(atWest.length, 2);
  assert.ok(atWest.every((r) => r.seq > s));
});
await ok('sync_changes_since: the last 120 s again (an entry numbered before `since` but committed after it), and the limit', async () => {
  const s0 = await maxSeq();
  await put('categories', { business_id: A, name: 'Late' });              // recent: inside the window
  const s = await maxSeq();
  const again = await rpcSince(A, s, BR);
  assert.ok(again.some((r) => r.seq === s), 'the recent entry comes again after `since` passed it');
  assert.ok(again.every((r) => r.seq > s0));
  for (let i = 0; i < 5; i++) await put('categories', { business_id: A, name: `L${i}` });
  assert.equal((await rpcSince(A, s, BR, 3)).length, 3);
});
await ok('sync_changes_heads: one read for every business — the newest entry, how many, the topics', async () => {
  await db.exec(`UPDATE public.sync_changes SET changed_at = now() - interval '1 hour'`);
  const s = await maxSeq();
  await put('categories', { business_id: A, name: 'H1' });
  await put('users', { business_id: A, role_id: ROLE, name: 'Akinyi', status: 'active' });
  await put('categories', { business_id: B, name: 'H2' });
  const heads = await q(`SELECT * FROM public.sync_changes_heads($1) ORDER BY business_id`, [s]);
  assert.equal(heads.length, 2);
  const a = heads.find((h) => h.business_id === A);
  assert.equal(Number(a.n), 2); assert.deepEqual([...a.topics].sort(), ['menu', 'staff']);
  assert.equal(Number(a.max_seq), (await maxSeq()) - 1);
});
await ok('prune_sync_changes: entries older than the days kept go; the floor is the highest removed', async () => {
  const before = await maxSeq();
  await db.exec(`UPDATE public.sync_changes SET changed_at = now() - interval '40 days' WHERE seq <= ${before - 2}`);
  const n = Number((await one(`SELECT public.prune_sync_changes(30) AS n`)).n);
  assert.ok(n > 0);
  assert.equal(Number((await one(`SELECT floor_seq FROM public.sync_change_floor WHERE id = 1`)).floor_seq), before - 2);
  assert.equal(Number((await one(`SELECT min(seq) AS m FROM public.sync_changes`)).m), before - 1);
  assert.equal(Number((await one(`SELECT public.prune_sync_changes(30) AS n`)).n), 0, 'nothing more to prune');
});
await ok('a trigger that cannot write never fails the write (sync_changes gone: the product still saves)', async () => {
  await db.exec(`ALTER TABLE public.sync_changes RENAME TO sync_changes_away`);
  try {
    await db.query(`INSERT INTO public.products (business_id, category_id, name) VALUES ($1, $2, 'still saves')`, [A, CAT]);
    assert.ok(await one(`SELECT id FROM public.products WHERE name = 'still saves'`));
  } finally { await db.exec(`ALTER TABLE public.sync_changes_away RENAME TO sync_changes`); }
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
