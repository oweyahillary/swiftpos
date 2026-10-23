/**
 * analytics-pg.mjs — A549: the whole schema in PGlite (every migration replayed, as the test-migration-* scripts) and ONE
 * seeded trading scenario for Analytics v1. Shared by scripts/test-migration-158.mjs (the SQL on its own) and
 * tests/analytics-a549.test.mjs (the routes over HTTP, their supabase.rpc answered by these functions for real).
 *
 * Not a test file itself: imported by the tests that need it.
 *
 *   const pg = await openSchema({ through: 158 });   // every migration up to and including 158
 *   const S = await seedAnalytics(pg);              // ids and the expected figures
 *   const X = await seedA561(pg, S);                 // A561: stock use, customers, costs (after seedAnalytics)
 *   const rows = await pg.rpc('analytics_sales_heatmap', { p_business: S.A, p_branch: null, p_from, p_to });
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const MIG = path.join(ROOT, 'migrations');
const num = (f) => +f.split('_')[0];
const BS = String.fromCharCode(92);
export const sanitize = (sql) => sql.split('\n').filter((l) => { const t = l.trim(); return !(t.startsWith(BS) || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
export const migrationFile = (n) => fs.readdirSync(MIG).find((f) => f.endsWith('.sql') && num(f) === n);
export const migrationSql = (n) => sanitize(fs.readFileSync(path.join(MIG, migrationFile(n)), 'utf8'));

export async function openSchema({ through }) {
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql') && Number.isFinite(num(f))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
  await db.exec('SET search_path TO public, extensions, auth;');
  for (const f of files.filter((f) => num(f) <= through)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

  const q = async (s, p = []) => (await db.query(s, p)).rows;
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
  /** supabase.rpc's shape: named arguments, { data, error } — numerics as numbers, as PostgREST sends them. */
  const rpc = async (name, args) => {
    const keys = Object.keys(args ?? {});
    try {
      const { rows, fields } = await db.query(`SELECT * FROM public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, keys.map((k) => args[k]));
      const numeric = new Set(fields.filter((f) => f.dataTypeID === 1700 || f.dataTypeID === 20).map((f) => f.name));
      const dates = new Set(fields.filter((f) => f.dataTypeID === 1082).map((f) => f.name));
      const out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k,
        v === null ? null : numeric.has(k) ? Number(v) : dates.has(k) && v instanceof Date ? isoDate(v) : v instanceof Date ? v.toISOString() : v])));
      return { data: out, error: null };
    } catch (e) { return { data: null, error: { message: e.message, code: e.code ?? 'XX000' } }; }
  };
  return { db, q, put, rpc };
}

/** A PGlite `date` comes back as a Date at LOCAL midnight; PostgREST sends 'YYYY-MM-DD'. */
function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const uid = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

/**
 * The scenario (business A, branches W(estlands) and K(ilimani); business B elsewhere). Dates are UTC instants; East Africa
 * Time is UTC+3. The period is 2026-10-01 .. 2026-10-21 (business dates), as of 2026-10-21 09:00Z.
 */
export async function seedAnalytics(pg) {
  const { put } = pg;
  const A = uid(0xa), B = uid(0xb), W = uid(0xa1), K = uid(0xa2), BB = uid(0xb1);
  await put('businesses', { id: A, name: 'Test Grill', type: 'restaurant' });
  await put('businesses', { id: B, name: 'Other', type: 'restaurant' });
  await put('branches', { id: W, business_id: A, name: 'Westlands' });
  await put('branches', { id: K, business_id: A, name: 'Kilimani' });
  await put('branches', { id: BB, business_id: B, name: 'Theirs' });
  // cashiers: Cate and Dan voids rarely; Vic voids a lot (6 voided of 12 rung); Eve and Fay ring plain sales.
  const CATE = uid(0xc1), DAN = uid(0xc2), VIC = uid(0xc3), EVE = uid(0xc4), FAY = uid(0xc5), MGR = uid(0xc6);
  for (const [id, name] of [[CATE, 'Cate'], [DAN, 'Dan'], [VIC, 'Vic'], [EVE, 'Eve'], [FAY, 'Fay'], [MGR, 'Max']]) {
    await put('users', { id, business_id: A, name, email: `${name.toLowerCase()}@test` });
  }
  const ING = (await put('ingredients', { business_id: A, name: 'Wing', unit: 'pc', unit_cost: 20 })).id;
  const BURGER = uid(0xd1), WINGS = uid(0xd2), SODA = uid(0xd3), COMBO = uid(0xd4), CHIPS = uid(0xd5), TEA = uid(0xd6), SALAD = uid(0xd7), THEIRS = uid(0xd9);
  await put('products', { id: BURGER, business_id: A, name: 'Burger', base_price: 200, cost_price: 100 });
  await put('products', { id: WINGS, business_id: A, name: 'Chicken wings', base_price: 100, cost_price: 0 });   // recipe: 2 x 20
  await put('products', { id: SODA, business_id: A, name: 'Soda', base_price: 50 });                              // no cost at all
  await put('products', { id: COMBO, business_id: A, name: 'Family combo', base_price: 400, is_combo: true });    // items: 100 + 2 x 40
  await put('products', { id: CHIPS, business_id: A, name: 'Chips', base_price: 150, cost_price: 30 });
  await put('products', { id: TEA, business_id: A, name: 'Tea', base_price: 80, cost_price: 60 });
  await put('products', { id: SALAD, business_id: A, name: 'Salad', base_price: 100, cost_price: 90 });
  await put('products', { id: THEIRS, business_id: B, name: 'Burger', base_price: 200, cost_price: 1 });
  await put('recipes', { business_id: A, product_id: WINGS, ingredient_id: ING, quantity_per_serving: 2, unit: 'pc' });
  await put('combo_items', { combo_id: COMBO, product_id: BURGER, quantity: 1 });
  await put('combo_items', { combo_id: COMBO, product_id: WINGS, quantity: 2 });

  let n = 0;
  const order = async (o, items = []) => {
    n += 1;
    const row = await put('orders', { business_id: A, branch_id: W, order_number: `ORD-${n}`, status: 'completed', subtotal: o.total ?? 0, discount_amount: 0, ...o });
    for (const [pid, name, qty, sub] of items) await put('order_items', { order_id: row.id, product_id: pid, product_name: name, quantity: qty, unit_price: sub / qty, subtotal: sub });
    return row.id;
  };
  // ── menu (Westlands, Mon 2026-10-19 12:00Z = 15:00 EAT) ──
  const MON15 = '2026-10-19T12:00:00Z';
  await order({ cashier_id: CATE, total: 2000, created_at: MON15 }, [[WINGS, 'Chicken wings', 20, 2000]]);        // 20 wings @100 → margin 60
  await order({ cashier_id: CATE, total: 1600, created_at: MON15 }, [[BURGER, 'Burger', 8, 1600]]);              // 8 burgers @200 → margin 100
  await order({ cashier_id: DAN, total: 800, created_at: MON15 }, [[COMBO, 'Family combo', 2, 800]]);             // 2 combos @400 → cost 180, margin 220
  await order({ cashier_id: DAN, total: 300, created_at: MON15 }, [[CHIPS, 'Chips', 2, 300]]);                    // 2 chips @150 → margin 120
  await order({ cashier_id: DAN, total: 400, created_at: MON15 }, [[TEA, 'Tea', 5, 400]]);                        // 5 teas @80 → margin 20
  await order({ cashier_id: DAN, total: 150, created_at: MON15 }, [[SODA, 'Soda', 3, 150]]);                      // no cost
  await order({ cashier_id: DAN, total: 100, created_at: MON15 }, [[SALAD, 'Salad', 1, 100]]);                    // 1 salad @100 → margin 10
  // excluded from the menu: a voided order, Kilimani (when Westlands is asked), business B, outside the period
  await order({ cashier_id: VIC, total: 9999, status: 'voided', created_at: MON15 }, [[BURGER, 'Burger', 50, 9999]]);
  await order({ branch_id: K, cashier_id: EVE, total: 200, created_at: MON15 }, [[BURGER, 'Burger', 1, 200]]);
  await order({ business_id: B, branch_id: BB, total: 200, created_at: MON15 }, [[THEIRS, 'Burger', 1, 200]]);
  await order({ cashier_id: CATE, total: 200, created_at: '2026-09-01T12:00:00Z' }, [[BURGER, 'Burger', 1, 200]]);
  // ── the heatmap's time zone: Tue 2026-10-20 22:30Z is WEDNESDAY 01:30 in Nairobi (business date Tue with a 02:00 cut-off) ──
  await order({ cashier_id: EVE, total: 500, created_at: '2026-10-20T22:30:00Z' });
  // ── money leaks (Westlands): Vic rings 12, 6 of them voided (rate 0.5); the others ring plain sales ──
  for (let i = 0; i < 6; i++) await order({ cashier_id: VIC, total: 100, created_at: '2026-10-15T08:00:00Z' });
  for (let i = 0; i < 5; i++) await order({ cashier_id: VIC, total: 100, status: 'voided', created_at: '2026-10-15T08:00:00Z' });
  // (the voided burger order above is Vic's 6th void and 12th order)
  for (let i = 0; i < 10; i++) await order({ cashier_id: EVE, total: 100, created_at: '2026-10-16T08:00:00Z' });
  await order({ cashier_id: EVE, total: 100, status: 'voided', created_at: '2026-10-16T08:00:00Z' });
  for (let i = 0; i < 9; i++) await order({ cashier_id: FAY, total: 100, created_at: '2026-10-16T08:00:00Z' });
  await order({ cashier_id: FAY, total: 100, status: 'voided', created_at: '2026-10-16T08:00:00Z' });
  // discounts and a refund (Cate), a kitchen void (Dan), wastage (Max), a short drawer (Dan) and a short day close
  await order({ cashier_id: CATE, total: 900, discount_amount: 100, created_at: '2026-10-17T08:00:00Z' });
  await order({ cashier_id: CATE, total: 500, refunded_amount: 250, refunded_at: '2026-10-18T08:00:00Z', created_at: '2026-10-10T08:00:00Z' });
  await put('kitchen_voids', { business_id: A, branch_id: W, product_name: 'Burger', quantity: 1, unit_price: 200, amount: 200, reason: 'changed_mind', cashier_id: DAN, created_at: '2026-10-17T09:00:00Z' });
  await put('wastage_entries', { business_id: A, branch_id: W, ref: 'W-1', item_kind: 'product', name: 'Burger', quantity: 2, unit_cost: 100, value: 200, reason: 'spoiled', recorded_by: MGR, created_at: '2026-10-17T10:00:00Z' });
  await put('wastage_entries', { business_id: A, branch_id: W, ref: 'W-2', item_kind: 'product', name: 'Burger', quantity: 1, unit_cost: 100, value: 100, reason: 'spoiled', recorded_by: MGR, created_at: '2026-10-17T10:00:00Z', voided_at: '2026-10-17T11:00:00Z' });
  await put('shifts', { business_id: A, branch_id: W, cashier_id: DAN, opened_at: '2026-10-17T05:00:00Z', closed_at: '2026-10-17T15:00:00Z', status: 'closed', cash_variance: -300 });
  await put('business_days', { business_id: A, branch_id: W, business_date: '2026-10-17', status: 'closed', cash_variance: -450 });
  await put('business_days', { business_id: A, branch_id: K, business_date: '2026-10-17', status: 'closed', cash_variance: 50 });

  // ── credit (as of 2026-10-21 09:00Z) ──
  const AS_OF = '2026-10-21T09:00:00Z';
  const daysAgo = (d) => new Date(Date.parse(AS_OF) - d * 86_400_000).toISOString();
  const C1 = (await put('customers', { business_id: A, name: 'Acme Ltd', phone: '0700', credit_limit: 5000, credit_balance: 700 })).id;
  const C2 = (await put('customers', { business_id: A, name: 'Old Account', credit_limit: 5000, credit_balance: 1000 })).id;
  const C3 = (await put('customers', { business_id: A, name: 'Paid Up', credit_limit: 5000, credit_balance: 0 })).id;
  const CB = (await put('customers', { business_id: B, name: 'Theirs', credit_limit: 5000, credit_balance: 900 })).id;
  const line = (cust, biz, branch, amount, at, type) => put('customer_credit_transactions', { business_id: biz, customer_id: cust, branch_id: branch, type, amount, balance_after: 0, created_at: at });
  // Acme: 500 (100 days ago, W) + 300 (45 days, W) − 400 paid (10 days) + 300 (5 days, Kilimani) = 700 owed.
  // FIFO: the 400 paid clears the oldest first → open: 300 (5 d, K) + 300 (45 d, W) + 100 of the 500 (100 d, W).
  await line(C1, A, W, 500, daysAgo(100), 'charge');
  await line(C1, A, W, 300, daysAgo(45), 'charge');
  await line(C1, A, W, -400, daysAgo(10), 'payment');
  await line(C1, A, K, 300, daysAgo(5), 'charge');
  // Old Account: balance 1000, the ledger holds a 600 sale 10 days ago only → 400 is older than the ledger (unaged, 90+).
  await line(C2, A, W, 600, daysAgo(10), 'charge');
  await line(CB, B, BB, 900, daysAgo(200), 'charge');
  // a disputed sale on Paid Up (balance 0) and one awaiting on Acme (not counted)
  const D1 = await order({ cashier_id: CATE, total: 350, customer_id: C3, created_at: daysAgo(3) });
  const D2 = await order({ cashier_id: CATE, total: 120, customer_id: C1, created_at: daysAgo(3) });
  await put('credit_confirmations', { order_id: D1, business_id: A, branch_id: W, customer_id: C3, amount: 350, state: 'disputed', decided_at: AS_OF, dispute_reason: 'Not ours' });
  await put('credit_confirmations', { order_id: D2, business_id: A, branch_id: W, customer_id: C1, amount: 120, state: 'awaiting' });

  return {
    A, B, W, K, BB, CATE, DAN, VIC, EVE, FAY, MGR, BURGER, WINGS, SODA, COMBO, CHIPS, TEA, SALAD, C1, C2, C3, CB, AS_OF,
    FROM: '2026-10-01', TO: '2026-10-21',
    // the period as businessRangeEAT gives it (cut-off 0)
    START: '2026-09-30T21:00:00.000Z', END: '2026-10-21T20:59:59.999Z',
  };
}

/**
 * A561 — stock use, customers and costs on top of seedAnalytics (call it after). The previous period is 10–30 September
 * (PREV_START). Expected figures are in the comments; the tests assert them.
 *   Stock (Westlands unless said): Tusker lager tracks stock — 21 sales of 10 in the period (210), a paid order voided
 *   (+6 back), 4 written off (and 9 more whose wastage was voided): used 208, about 9.9 a day; 20 on hand at Westlands
 *   (Kilimani 500, and 50 sold there) → about 2 days left. 100 sold in September. Eggs by the piece: 12 pieces sold,
 *   a void's +1 (in units) not netted, 30 pieces on hand. The Wing ingredient: 40 used through recipes, 10 wasted (20%),
 *   100 on hand. Not listed: Chicken wings (sold through a recipe), Soda (no stock tracking), business B.
 *   Customers: Wanjiku came every 5 days from 25 July to 23 September (a regular gone quiet); Brian is new (5 and 12
 *   October); Acme came in September and in October (returning); Paid Up only in October.
 *   Costs: Cooking oil 0.4 → 0.5 a ml in the period (a delivery on 1 September at 0.4, an edit on 10 October to 0.5);
 *   Chips masala (100 ml oil + a 20 potato) sold 30 at 100; Fries has its own cost (never a recipe row); Ghost is active
 *   with no cost and did not sell; Old menu item is inactive.
 */
export async function seedA561(pg, S) {
  const { put, q } = pg;
  const PREV_START = '2026-09-09T21:00:00.000Z';
  const TUSKER = (await put('products', { business_id: S.A, name: 'Tusker lager', base_price: 300, cost_price: 190, track_stock: true, unit_label: 'bottles' })).id;
  const EGGS = (await put('products', { business_id: S.A, name: 'Eggs', base_price: 20, cost_price: 12, track_stock: true, sold_by: 'piece' })).id;
  const THEIRS = (await put('products', { business_id: S.B, name: 'Their beer', base_price: 300, track_stock: true })).id;
  await q('UPDATE public.products SET track_stock = true WHERE id = $1', [S.WINGS]);   // a recipe item: never listed
  await q('UPDATE public.products SET track_stock = false WHERE id = $1', [S.SODA]);
  const mv = (product_id, branch_id, movement_type, quantity_change, created_at, notes = 'Order X') =>
    put('stock_movements', { product_id, branch_id, movement_type, quantity_change, quantity_after: 0, created_at, notes, reference_type: movement_type === 'sale' ? 'order' : null });
  for (let d = 1; d <= 21; d++) await mv(TUSKER, S.W, 'sale', -10, `2026-10-${String(d).padStart(2, '0')}T10:00:00Z`);
  await mv(TUSKER, S.W, 'correction', 6, '2026-10-12T10:00:00Z', 'Void of Order ORD-9: wrong table');
  await mv(TUSKER, S.W, 'correction', 5, '2026-10-12T10:00:00Z', 'Stock count');                 // not a sale's return
  await mv(TUSKER, S.W, 'sale', -100, '2026-09-20T10:00:00Z');                                    // the previous period
  await mv(TUSKER, S.W, 'sale', -999, '2026-08-01T10:00:00Z');                                    // before both
  await mv(TUSKER, S.K, 'sale', -50, '2026-10-05T10:00:00Z');
  await mv(EGGS, S.W, 'sale', -12, '2026-10-05T10:00:00Z');
  await mv(EGGS, S.W, 'correction', 1, '2026-10-06T10:00:00Z', 'Void of Order ORD-10: x');       // units, not pieces: not netted
  await mv(S.WINGS, S.W, 'sale', -20, '2026-10-05T10:00:00Z');
  await mv(S.SODA, S.W, 'sale', -20, '2026-10-05T10:00:00Z');
  await mv(THEIRS, S.BB, 'sale', -20, '2026-10-05T10:00:00Z');
  await put('stock_levels', { product_id: TUSKER, branch_id: S.W, quantity: 20, qty_pieces: 0 });
  await put('stock_levels', { product_id: TUSKER, branch_id: S.K, quantity: 500, qty_pieces: 0 });
  await put('stock_levels', { product_id: EGGS, branch_id: S.W, quantity: 0, qty_pieces: 30 });
  await put('wastage_entries', { business_id: S.A, branch_id: S.W, ref: 'W-T1', item_kind: 'product', product_id: TUSKER, name: 'Tusker lager', quantity: 4, value: 760, reason: 'damaged', created_at: '2026-10-14T10:00:00Z' });
  await put('wastage_entries', { business_id: S.A, branch_id: S.W, ref: 'W-T2', item_kind: 'product', product_id: TUSKER, name: 'Tusker lager', quantity: 9, value: 1710, reason: 'damaged', created_at: '2026-10-14T10:00:00Z', voided_at: '2026-10-14T11:00:00Z' });
  const ING = (await q(`SELECT id FROM public.ingredients WHERE business_id = $1 AND name = 'Wing'`, [S.A]))[0].id;
  for (const [n, at] of [[-25, '2026-10-03T10:00:00Z'], [-15, '2026-10-09T10:00:00Z']]) {
    await put('ingredient_stock_movements', { business_id: S.A, ingredient_id: ING, branch_id: S.W, movement_type: 'sale', quantity_change: n, quantity_after: 0, created_at: at });
  }
  await put('ingredient_stock_movements', { business_id: S.A, ingredient_id: ING, branch_id: S.W, movement_type: 'adjustment', quantity_change: 300, quantity_after: 0, created_at: '2026-10-04T10:00:00Z' });
  await put('wastage_entries', { business_id: S.A, branch_id: S.W, ref: 'W-I1', item_kind: 'ingredient', ingredient_id: ING, name: 'Wing', quantity: 10, value: 200, reason: 'spoiled', created_at: '2026-10-15T10:00:00Z' });
  await put('ingredient_stock_levels', { business_id: S.A, ingredient_id: ING, branch_id: S.W, current_stock: 100, reorder_level: 0 });

  // ── customers ──
  let k = 0;
  const cust = async (name) => (await put('customers', { business_id: S.A, name, phone: `0711${String(++k).padStart(6, '0')}`, credit_limit: 0, credit_balance: 0 })).id;
  const WANJIKU = await cust('Wanjiku'), BRIAN = await cust('Brian');
  const visit = (customer_id, created_at, total = 1000, order_type = 'dine_in', branch_id = S.W) =>
    put('orders', { business_id: S.A, branch_id, order_number: `C-${++k}`, status: 'completed', subtotal: total, total, discount_amount: 0, customer_id, order_type, created_at, cashier_id: S.CATE });
  for (let t = Date.parse('2026-07-25T09:00:00Z'); t <= Date.parse('2026-09-23T09:00:00Z'); t += 5 * 86_400_000) await visit(WANJIKU, new Date(t).toISOString(), 800);
  await visit(BRIAN, '2026-10-05T09:00:00Z', 1500, 'takeaway');
  await visit(BRIAN, '2026-10-12T09:00:00Z', 1500, 'delivery');
  await visit(S.C1, '2026-09-15T09:00:00Z', 600);
  await visit(S.C1, '2026-10-16T09:00:00Z', 600);

  // ── costs ──
  const OIL = (await put('ingredients', { business_id: S.A, name: 'Cooking oil', unit: 'ml', unit_cost: 0.5 })).id;
  const POTATO = (await put('ingredients', { business_id: S.A, name: 'Potato', unit: 'pc', unit_cost: 20 })).id;
  const CHIPSM = (await put('products', { business_id: S.A, name: 'Chips masala', base_price: 100 })).id;
  const FRIES = (await put('products', { business_id: S.A, name: 'Fries', base_price: 100, cost_price: 30 })).id;
  await put('recipes', { business_id: S.A, product_id: CHIPSM, ingredient_id: OIL, quantity_per_serving: 100, unit: 'ml' });
  await put('recipes', { business_id: S.A, product_id: CHIPSM, ingredient_id: POTATO, quantity_per_serving: 1, unit: 'pc' });
  await put('recipes', { business_id: S.A, product_id: FRIES, ingredient_id: OIL, quantity_per_serving: 80, unit: 'ml' });
  const grn = await put('goods_received_notes', { business_id: S.A, branch_id: S.W, grn_number: 'GRN-1', received_date: '2026-09-01', received_by: S.MGR });
  await put('grn_items', { grn_id: grn.id, ingredient_id: OIL, quantity_received: 5000, unit_cost: 0.4 });
  await put('ingredient_cost_history', { business_id: S.A, ingredient_id: OIL, old_unit_cost: 0.4, new_unit_cost: 0.5, created_at: '2026-10-10T08:00:00Z' });
  const sale = await put('orders', { business_id: S.A, branch_id: S.W, order_number: 'CM-1', status: 'completed', subtotal: 3000, total: 3000, discount_amount: 0, order_type: 'dine_in', created_at: '2026-10-19T12:00:00Z', cashier_id: S.DAN });
  await put('order_items', { order_id: sale.id, product_id: CHIPSM, product_name: 'Chips masala', quantity: 30, unit_price: 100, subtotal: 3000 });
  await put('products', { business_id: S.A, name: 'Ghost', base_price: 500, status: 'active' });
  await put('products', { business_id: S.A, name: 'Old menu item', base_price: 500, status: 'inactive' });
  return { PREV_START, TUSKER, EGGS, ING, OIL, POTATO, CHIPSM, FRIES, WANJIKU, BRIAN };
}
