/**
 * analytics-pg.mjs — A549: the whole schema in PGlite (every migration replayed, as the test-migration-* scripts) and ONE
 * seeded trading scenario for Analytics v1. Shared by scripts/test-migration-158.mjs (the SQL on its own) and
 * tests/analytics-a549.test.mjs (the routes over HTTP, their supabase.rpc answered by these functions for real).
 *
 * Not a test file itself: imported by the tests that need it.
 *
 *   const pg = await openSchema({ through: 158 });   // every migration up to and including 158
 *   const S = await seedAnalytics(pg);              // ids and the expected figures
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
