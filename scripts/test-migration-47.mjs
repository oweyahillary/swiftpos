/**
 * Runs migration 47 against real PostgreSQL (PGlite) on a minimal fixture of the
 * tables it touches, and asserts the outcome — RLS on, owner_all present, the
 * policy actually scoping rows, and the migration being safely re-runnable.
 */
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const MIGRATION = '/home/claude/out4/migrations/47_rls_stations_and_variant_group_products.sql';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const db = new PGlite();

// ── Fixture: only what migration 47 references ──────────────────────────────
await db.exec(`
  CREATE TABLE public.businesses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid,
    name text
  );
  CREATE TABLE public.categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL,
    name text
  );
  CREATE TABLE public.products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL,
    name text
  );
  CREATE TABLE public.variant_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid
  );
  CREATE TABLE public.schema_migrations (
    version text PRIMARY KEY,
    notes text,
    applied_at timestamptz NOT NULL DEFAULT now()
  );

  -- The three tables as migrations 44 and 45 create them.
  CREATE TABLE public.branch_prices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    price numeric(10,2) NOT NULL
  );
  CREATE TABLE public.print_stations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL,
    branch_id uuid,
    name text NOT NULL,
    kind text NOT NULL DEFAULT 'kitchen',
    sort_order integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.category_stations (
    category_id uuid NOT NULL,
    station_id uuid NOT NULL REFERENCES public.print_stations(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (category_id, station_id)
  );
  CREATE TABLE public.variant_group_products (
    variant_group_id uuid NOT NULL REFERENCES public.variant_groups(id) ON DELETE CASCADE,
    product_id uuid NOT NULL,
    combo_item_id uuid,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (variant_group_id, product_id)
  );

  -- auth.uid() does not exist outside Supabase; stub it so the policies parse
  -- and evaluate exactly as written.
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
`);

// Two tenants, so the policy has something to actually separate.
const mine   = (await db.query(`INSERT INTO businesses (owner_id, name) VALUES (gen_random_uuid(), 'Mine')   RETURNING id, owner_id`)).rows[0];
const theirs = (await db.query(`INSERT INTO businesses (owner_id, name) VALUES (gen_random_uuid(), 'Theirs') RETURNING id, owner_id`)).rows[0];

for (const b of [mine, theirs]) {
  await db.query(`INSERT INTO categories (id, business_id, name) VALUES (gen_random_uuid(), $1, 'Cat')`, [b.id]);
  await db.query(`INSERT INTO products   (id, business_id, name) VALUES (gen_random_uuid(), $1, 'Prod')`, [b.id]);
  await db.query(`INSERT INTO print_stations (business_id, name) VALUES ($1, 'Grill')`, [b.id]);
  await db.query(`INSERT INTO branch_prices (business_id, branch_id, product_id, price) VALUES ($1, gen_random_uuid(), gen_random_uuid(), 100)`, [b.id]);
}

const link = async (b) => {
  const cat = (await db.query(`SELECT id FROM categories WHERE business_id=$1`, [b.id])).rows[0];
  const st  = (await db.query(`SELECT id FROM print_stations WHERE business_id=$1`, [b.id])).rows[0];
  const pr  = (await db.query(`SELECT id FROM products WHERE business_id=$1`, [b.id])).rows[0];
  const vg  = (await db.query(`INSERT INTO variant_groups (product_id) VALUES ($1) RETURNING id`, [pr.id])).rows[0];
  await db.query(`INSERT INTO category_stations (category_id, station_id) VALUES ($1,$2)`, [cat.id, st.id]);
  await db.query(`INSERT INTO variant_group_products (variant_group_id, product_id) VALUES ($1,$2)`, [vg.id, pr.id]);
};
await link(mine);
await link(theirs);

// ── Before ──────────────────────────────────────────────────────────────────
const rls = async (t) => (await db.query(
  `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=$1`, [t])).rows[0].relrowsecurity;

console.log('\nbefore migration 47');
for (const t of ['print_stations', 'branch_prices', 'category_stations', 'variant_group_products']) {
  ok(`${t} has NO rls (reproduces the gap)`, (await rls(t)) === false);
}

// ── Run it ──────────────────────────────────────────────────────────────────
console.log('\nrunning migration 47');
await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
console.log('  (executed without error)');

console.log('\nafter migration 47');
for (const t of ['print_stations', 'branch_prices', 'category_stations', 'variant_group_products']) {
  ok(`${t} rls enabled`, (await rls(t)) === true);
  const p = (await db.query(
    `SELECT count(*)::int n FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname='owner_all'`, [t])).rows[0].n;
  ok(`${t} has owner_all`, p === 1, `found ${p}`);
}

const recorded = (await db.query(
  `SELECT count(*)::int n FROM schema_migrations WHERE version='47_rls_stations_and_variant_group_products'`)).rows[0].n;
ok('recorded in schema_migrations', recorded === 1);

// ── The policy must actually separate tenants ───────────────────────────────
// Policies are bypassed for superusers/table owners, so test as a plain role.
console.log('\npolicy behaviour (as a non-owner role, RLS enforced)');
await db.exec(`
  CREATE ROLE app NOLOGIN;
  GRANT USAGE ON SCHEMA public, auth TO app;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO app;
  GRANT EXECUTE ON FUNCTION auth.uid() TO app;
`);

const asOwner = async (uid, sql) => {
  await db.exec(`SET ROLE app; SELECT set_config('test.uid', '${uid}', false);`);
  const r = await db.query(sql);
  await db.exec(`RESET ROLE;`);
  return r.rows[0].n;
};

for (const [t, label] of [['print_stations','print_stations'], ['branch_prices','branch_prices'], ['category_stations','category_stations'], ['variant_group_products','variant_group_products']]) {
  const seen  = await asOwner(mine.owner_id,   `SELECT count(*)::int n FROM ${t}`);
  ok(`${label}: owner sees only their own row`, seen === 1, `saw ${seen} of 2`);
}

const anon = await (async () => {
  await db.exec(`SET ROLE app; SELECT set_config('test.uid', '', false);`);
  const r = await db.query(`SELECT count(*)::int n FROM print_stations`);
  await db.exec(`RESET ROLE;`);
  return r.rows[0].n;
})();
ok('anon (no auth.uid) sees nothing', anon === 0, `saw ${anon}`);

// ── Re-runnable ─────────────────────────────────────────────────────────────
console.log('\nidempotency');
let rerun = true;
try { await db.exec(fs.readFileSync(MIGRATION, 'utf8')); } catch (e) { rerun = false; console.log('   ', e.message); }
ok('re-running migration 47 is safe', rerun);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
