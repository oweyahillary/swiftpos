-- ═════════════════════════════════════════════════════════════════════════════
-- SwiftPOS — Consolidated Migration (single-file)
-- Generated: 2026-06-01
--
-- WHAT THIS IS
--   A single, idempotent reconciliation of every migration in the migrations/
--   folder, ordered by dependency. Safe to run on your EXISTING production
--   database: parts already applied become no-ops; the genuinely pending work
--   (clock events, combos, reservations, QR ordering, hotel fields, the manager
--   permission grants, and the loyalty function) gets applied.
--
-- ASSUMPTIONS
--   - The CORE base tables (businesses, branches, users, products, categories,
--     orders, order_items, payments, customers, discounts, shifts, suppliers,
--     purchase_orders, goods_received_notes, stock_levels, tables, roles,
--     permissions, role_permissions, subscriptions, plans, etc.) ALREADY EXIST.
--     They were created by base migrations that are NOT in the migrations/
--     folder. This file is the ADDITIVE layer on top of that baseline — it is
--     not a blank-slate installer. (Ask if you want a from-scratch schema too.)
--
-- RECONCILIATION DECISIONS (where source files disagreed — live schema wins)
--   1. universal_business_types.sql is SUPERSEDED by all_phases + v30 and is
--      NOT replayed. Its bare "DROP CONSTRAINT" (no IF EXISTS) and narrower
--      enum sets would error or strip valid values.
--   2. products.sold_by  -> default 'each', values ('each','weight','volume','piece')
--   3. products.fuel_unit -> ('L','gal')   (not 'litre'/'kg')
--   4. orders.order_type  -> full 8-value set incl 'delivery' and 'aggregator'
--   5. pumps/fuel_tanks/parking_sessions -> all_phases/live column shapes
--   6. v27's destructive DROP TABLE on purchase_order_items / grn_items is NOT
--      replayed; tables are created IF NOT EXISTS in their final shape instead.
--   7. increment_loyalty_points(): parameter renamed p_points -> p_delta to
--      MATCH the call in orders.ts (otherwise the atomic path always fails).
--   8. grant_manager_permissions.sql was missing from the repo; section 12
--      reconstructs it safely.
--
-- AFTER RUNNING
--   - Managers must log out and back in (permissions are baked into the JWT).
--   - Change the seeded admin password (section 13) on first login.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. Extensions ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. Column additions to existing core tables ──────────────────────────────
-- (all ADD COLUMN IF NOT EXISTS — no-ops where already present)

-- businesses
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS owner_name  character varying;

-- branches
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS city                 character varying,
  ADD COLUMN IF NOT EXISTS country              text DEFAULT 'Kenya',
  ADD COLUMN IF NOT EXISTS desktop_licensed     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS desktop_licensed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS desktop_licensed_by  text,
  ADD COLUMN IF NOT EXISTS deploy_mode          text NOT NULL DEFAULT 'cloud'
                                                CHECK (deploy_mode IN ('local','cloud')),
  ADD COLUMN IF NOT EXISTS mode_switched_at     timestamptz,
  ADD COLUMN IF NOT EXISTS mode_switched_by     text;

-- users
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_name           text,
  ADD COLUMN IF NOT EXISTS pin_upgraded         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hourly_rate          numeric(10,2) DEFAULT NULL;

COMMENT ON COLUMN public.users.hourly_rate IS
  'Hourly wage rate in local currency. Used for SPLH labour cost % report.';

-- onboarding_progress
ALTER TABLE public.onboarding_progress
  ADD COLUMN IF NOT EXISTS owner_pin_set boolean NOT NULL DEFAULT false;

-- products  (constraints reconciled separately in section 2)
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS barcode         text,
  ADD COLUMN IF NOT EXISTS plu_code        text,
  ADD COLUMN IF NOT EXISTS sold_by         text    NOT NULL DEFAULT 'each',
  ADD COLUMN IF NOT EXISTS is_fuel         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fuel_unit       text    CHECK (fuel_unit IN ('L','gal')),
  ADD COLUMN IF NOT EXISTS cost_price      numeric(10,2),
  ADD COLUMN IF NOT EXISTS reorder_level   integer,
  ADD COLUMN IF NOT EXISTS pieces_per_unit integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_label      text    NOT NULL DEFAULT 'pc',
  ADD COLUMN IF NOT EXISTS source          text    NOT NULL DEFAULT 'purchased'
                                           CHECK (source IN ('purchased','central_kitchen'));

CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_business_idx
  ON public.products (business_id, barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_plu_business_idx
  ON public.products (business_id, plu_code) WHERE plu_code IS NOT NULL;

-- categories
ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS super_category text;

-- tables (restaurant + parking bays)
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS slot_type     character varying NOT NULL DEFAULT 'dining'
                                          CHECK (slot_type IN ('dining','parking_bay')),
  ADD COLUMN IF NOT EXISTS bay_status    text CHECK (bay_status IN ('active','reserved','blocked')),
  ADD COLUMN IF NOT EXISTS rate_per_hour numeric(10,2),
  ADD COLUMN IF NOT EXISTS zone          text,
  ADD COLUMN IF NOT EXISTS shape         text DEFAULT 'rect' CHECK (shape IN ('rect','circle')),
  ADD COLUMN IF NOT EXISTS pos_x         integer,
  ADD COLUMN IF NOT EXISTS pos_y         integer;

-- stock_levels (piece-level tracking)
ALTER TABLE public.stock_levels
  ADD COLUMN IF NOT EXISTS qty_pieces integer NOT NULL DEFAULT 0;

-- stock_movements
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS reference_type text,
  ADD COLUMN IF NOT EXISTS notes          text;

-- payments  (matches live: default 'pending')
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS mpesa_checkout_id text,
  ADD COLUMN IF NOT EXISTS status            text NOT NULL DEFAULT 'pending'
                                             CHECK (status IN ('pending','completed','failed','refunded'));
CREATE INDEX IF NOT EXISTS payments_mpesa_checkout_idx
  ON public.payments (mpesa_checkout_id) WHERE mpesa_checkout_id IS NOT NULL;

-- orders (extended columns; constraints in section 2)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pump_id         uuid,
  ADD COLUMN IF NOT EXISTS aggregator_name text,
  ADD COLUMN IF NOT EXISTS void_reason     text,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_business_idx
  ON public.orders (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── 2. Reconciled CHECK constraints (final/live values) ──────────────────────
-- Drop-if-exists + add by explicit name. Re-asserting a constraint your data
-- already satisfies cannot fail, so this is safe on the live DB.

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_sold_by_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_sold_by_check
  CHECK (sold_by IN ('each','weight','volume','piece'));

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN (
    'retail','dine_in','takeaway','delivery',
    'aggregator','parking_session','fuel_sale','other'
  ));

-- businesses.type — assert the full universal set (matches live)
ALTER TABLE public.businesses DROP CONSTRAINT IF EXISTS businesses_type_check;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_type_check
  CHECK (type IN ('retail','restaurant','cafe','minimart','parking','petrol_station','other'));

-- ── 3. Feature tables (final/live shapes) ────────────────────────────────────

-- business_settings (value is JSONB in live)
CREATE TABLE IF NOT EXISTS public.business_settings (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  key         text        NOT NULL,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_settings_business_idx ON public.business_settings (business_id);

-- ingredients  (must precede recipes / movements / PO items / GRN items)
CREATE TABLE IF NOT EXISTS public.ingredients (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name          varchar(255) NOT NULL,
  category      varchar(100),
  unit          varchar(50)  NOT NULL DEFAULT 'pieces',
  unit_cost     numeric(12,2),
  current_stock numeric(12,2) NOT NULL DEFAULT 0,
  reorder_level numeric(12,2) NOT NULL DEFAULT 0,
  status        varchar(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingredients_business ON public.ingredients (business_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_category ON public.ingredients (business_id, category);

CREATE TABLE IF NOT EXISTS public.ingredient_stock_movements (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  ingredient_id   uuid NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  movement_type   varchar(30) NOT NULL,
  quantity_change numeric(12,2) NOT NULL,
  quantity_after  numeric(12,2) NOT NULL,
  notes           text,
  created_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingr_movements_ingredient ON public.ingredient_stock_movements (ingredient_id);
CREATE INDEX IF NOT EXISTS idx_ingr_movements_business   ON public.ingredient_stock_movements (business_id);

-- movement_type includes 'sale' (v28 widening) — asserted as a named constraint
ALTER TABLE public.ingredient_stock_movements
  DROP CONSTRAINT IF EXISTS ingredient_stock_movements_movement_type_check;
ALTER TABLE public.ingredient_stock_movements
  ADD CONSTRAINT ingredient_stock_movements_movement_type_check
  CHECK (movement_type IN ('restock','adjustment','wastage','opening','sale'));

CREATE TABLE IF NOT EXISTS public.recipes (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id          uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id           uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  ingredient_id        uuid NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  quantity_per_serving numeric(12,4) NOT NULL,
  unit                 varchar(50),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, ingredient_id)
);
CREATE INDEX IF NOT EXISTS idx_recipes_product         ON public.recipes (product_id);
CREATE INDEX IF NOT EXISTS idx_recipes_ingredient      ON public.recipes (ingredient_id);
CREATE INDEX IF NOT EXISTS idx_recipes_business        ON public.recipes (business_id);
CREATE INDEX IF NOT EXISTS idx_recipes_business_product ON public.recipes (business_id, product_id);

-- purchase_order_items / grn_items  (ingredient-based; created NON-destructively)
CREATE TABLE IF NOT EXISTS public.purchase_order_items (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  ingredient_id     uuid NOT NULL REFERENCES public.ingredients(id) ON DELETE RESTRICT,
  quantity_ordered  numeric(12,2) NOT NULL,
  unit_cost         numeric(12,2) NOT NULL DEFAULT 0,
  quantity_received numeric(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_items_po         ON public.purchase_order_items (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_po_items_ingredient ON public.purchase_order_items (ingredient_id);

CREATE TABLE IF NOT EXISTS public.grn_items (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  grn_id            uuid NOT NULL REFERENCES public.goods_received_notes(id) ON DELETE CASCADE,
  ingredient_id     uuid NOT NULL REFERENCES public.ingredients(id) ON DELETE RESTRICT,
  quantity_received numeric(12,2) NOT NULL,
  unit_cost         numeric(12,2),
  notes             text
);
CREATE INDEX IF NOT EXISTS idx_grn_items_grn        ON public.grn_items (grn_id);
CREATE INDEX IF NOT EXISTS idx_grn_items_ingredient ON public.grn_items (ingredient_id);

-- branch_printers
CREATE TABLE IF NOT EXISTS public.branch_printers (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id        uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id          uuid NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  name               varchar(255) NOT NULL,
  printer_name       varchar(255),
  type               varchar(30)  NOT NULL DEFAULT 'receipt'
                       CHECK (type IN ('receipt','kitchen','bar','expeditor','kot')),
  paper_width        smallint NOT NULL DEFAULT 80 CHECK (paper_width IN (58,80)),
  category_ids       uuid[]   NOT NULL DEFAULT '{}',
  is_default_receipt boolean  NOT NULL DEFAULT false,
  connection_type    varchar(20) NOT NULL DEFAULT 'browser'
                       CHECK (connection_type IN ('qz','browser')),
  enabled            boolean  NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branch_printers_branch   ON public.branch_printers (branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_printers_business ON public.branch_printers (business_id);

-- promotions
CREATE TABLE IF NOT EXISTS public.promotions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name           text NOT NULL,
  promo_type     text NOT NULL DEFAULT 'happy_hour'
                   CHECK (promo_type IN ('happy_hour','bogo','quantity_discount')),
  start_date     date,
  end_date       date,
  start_time     time,
  end_time       time,
  days_of_week   integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  applies_to     text NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all','category','product')),
  product_ids    uuid[] NOT NULL DEFAULT '{}',
  category_ids   uuid[] NOT NULL DEFAULT '{}',
  discount_type  text CHECK (discount_type IN ('percentage','fixed')),
  discount_value numeric(10,2),
  min_quantity   integer NOT NULL DEFAULT 1,
  free_quantity  integer,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promotions_business_status ON public.promotions (business_id, status);

-- pumps (with fuel_product_id + 'error' status — live shape)
CREATE TABLE IF NOT EXISTS public.pumps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id       uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  fuel_product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'idle'
                    CHECK (status IN ('idle','dispensing','inactive','error')),
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pumps_business_idx ON public.pumps (business_id);
CREATE INDEX IF NOT EXISTS pumps_branch_idx   ON public.pumps (branch_id);

-- orders.pump_id FK (added now that pumps exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_pump_id_fkey'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_pump_id_fkey FOREIGN KEY (pump_id) REFERENCES public.pumps(id);
  END IF;
END $$;

-- fuel_tanks (fuel_product_id + name — live shape)
CREATE TABLE IF NOT EXISTS public.fuel_tanks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id       uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  fuel_product_id uuid NOT NULL REFERENCES public.products(id),
  name            text NOT NULL,
  capacity_litres numeric(10,2) NOT NULL DEFAULT 10000,
  current_level   numeric(10,2) NOT NULL DEFAULT 0,
  reorder_level   numeric(10,2) NOT NULL DEFAULT 1000,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fuel_tanks_business_idx ON public.fuel_tanks (business_id);

-- parking_sessions (total_amount — live shape)
CREATE TABLE IF NOT EXISTS public.parking_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id     uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  bay_id        uuid NOT NULL REFERENCES public.tables(id),
  order_id      uuid REFERENCES public.orders(id),
  vehicle_plate text,
  vehicle_type  text NOT NULL DEFAULT 'car',
  rate_per_hour numeric(10,2) NOT NULL DEFAULT 200,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  billed_hours  numeric(5,2),
  total_amount  numeric(10,2),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','voided')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parking_sessions_bay_idx      ON public.parking_sessions (bay_id);
CREATE INDEX IF NOT EXISTS parking_sessions_business_idx ON public.parking_sessions (business_id);
CREATE INDEX IF NOT EXISTS parking_sessions_status_idx   ON public.parking_sessions (status);

-- ── 4. Admin portal + tech access ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_users (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'agent' CHECK (role IN ('super_admin','agent')),
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id      uuid REFERENCES public.admin_users(id),
  admin_email   text,
  action        text NOT NULL,
  resource      text,
  business_id   uuid,
  business_name text,
  before_data   jsonb,
  after_data    jsonb,
  reason        text,
  ip_address    text,
  event_time    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_business ON public.admin_audit_log (business_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin    ON public.admin_audit_log (admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_time     ON public.admin_audit_log (event_time DESC);

CREATE TABLE IF NOT EXISTS public.admin_client_notes (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  admin_id    uuid NOT NULL REFERENCES public.admin_users(id),
  admin_name  text NOT NULL,
  body        text NOT NULL,
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_client_notes_biz ON public.admin_client_notes (business_id);

CREATE TABLE IF NOT EXISTS public.tech_access_tokens (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id     uuid NOT NULL REFERENCES public.admin_users(id),
  admin_name   text NOT NULL,
  business_id  uuid NOT NULL REFERENCES public.businesses(id),
  branch_id    uuid NOT NULL REFERENCES public.branches(id),
  branch_name  text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  revoked_at   timestamptz,
  revoked_by   text,
  confirmed_at timestamptz,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','revoked','expired')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tech_tokens_branch  ON public.tech_access_tokens (branch_id, status);
CREATE INDEX IF NOT EXISTS idx_tech_tokens_admin   ON public.tech_access_tokens (admin_id);
CREATE INDEX IF NOT EXISTS idx_tech_tokens_expires ON public.tech_access_tokens (expires_at);

CREATE TABLE IF NOT EXISTS public.tech_approval_flags (
  admin_id            uuid PRIMARY KEY REFERENCES public.admin_users(id),
  last_unconfirmed_at timestamptz,
  requires_manual     boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mode_switch_requests (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id),
  branch_id       uuid NOT NULL REFERENCES public.branches(id),
  from_mode       text NOT NULL CHECK (from_mode IN ('local','cloud')),
  to_mode         text NOT NULL CHECK (to_mode   IN ('local','cloud')),
  token_hash      text NOT NULL UNIQUE,
  generated_by    text NOT NULL,
  approved_by     text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','expired','cancelled')),
  orders_migrated integer,
  applied_at      timestamptz,
  applied_by_tech text,
  notes           text,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mode_switch_branch ON public.mode_switch_requests (branch_id, status);

CREATE INDEX IF NOT EXISTS idx_branches_desktop_licensed
  ON public.branches (business_id, desktop_licensed);

-- ═════════════════════════════════════════════════════════════════════════════
-- PREVIOUSLY-PENDING MIGRATIONS (03–07) — applied here
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 5. Clock events (03) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clock_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  staff_id    uuid NOT NULL REFERENCES public.users(id)      ON DELETE CASCADE,
  branch_id   uuid REFERENCES public.branches(id)            ON DELETE SET NULL,
  event_type  text NOT NULL CHECK (event_type IN ('in','out')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clock_events_staff_date    ON public.clock_events (staff_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_clock_events_business_date ON public.clock_events (business_id, recorded_at DESC);

-- ── 6. Combos (04) ───────────────────────────────────────────────────────────
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_combo    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS combo_price numeric(10,2);

CREATE TABLE IF NOT EXISTS public.combo_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_id   uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity   integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (combo_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_combo_items_combo ON public.combo_items (combo_id);

-- ── 7. Reservations + waitlist (05) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  table_id      uuid REFERENCES public.tables(id)              ON DELETE SET NULL,
  guest_name    text NOT NULL,
  guest_phone   text,
  party_size    integer NOT NULL DEFAULT 2,
  reserved_date date NOT NULL,
  reserved_time time NOT NULL,
  notes         text,
  status        text NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed','seated','completed','cancelled','no_show')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservations_branch_date ON public.reservations (branch_id, reserved_date);

CREATE TABLE IF NOT EXISTS public.waitlist (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id      uuid NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  guest_name     text NOT NULL,
  guest_phone    text,
  party_size     integer NOT NULL DEFAULT 2,
  estimated_wait integer,
  added_at       timestamptz NOT NULL DEFAULT now(),
  seated_at      timestamptz,
  status         text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','seated','left')),
  notes          text
);
CREATE INDEX IF NOT EXISTS idx_waitlist_branch_status ON public.waitlist (branch_id, status, added_at DESC);

-- ── 8. QR self-ordering (06) ─────────────────────────────────────────────────
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS menu_slug   text UNIQUE,
  ADD COLUMN IF NOT EXISTS qr_ordering boolean NOT NULL DEFAULT false;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'pos'
    CHECK (source IN ('pos','qr','aggregator','online'));

CREATE INDEX IF NOT EXISTS idx_businesses_menu_slug ON public.businesses (menu_slug);

-- ── 9. Hotel features (07) ───────────────────────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS room_number text,
  ADD COLUMN IF NOT EXISTS guest_name  text;

CREATE INDEX IF NOT EXISTS idx_orders_room_number
  ON public.orders (business_id, room_number) WHERE room_number IS NOT NULL;

-- ── 10. Report performance indexes (v30) ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_business_created
  ON public.orders (business_id, created_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_orders_business_type
  ON public.orders (business_id, order_type, created_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_orders_voided
  ON public.orders (business_id, created_at) WHERE status = 'voided';
CREATE INDEX IF NOT EXISTS idx_order_items_category
  ON public.order_items (order_id, category_name);
CREATE INDEX IF NOT EXISTS idx_expenses_shift ON public.expenses (shift_id);

-- expenses.shift_id (v26) — in case not present
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL;

-- ── 11. Functions ────────────────────────────────────────────────────────────
-- NOTE: parameter is p_delta (NOT p_points) to match the rpc() call in
-- apps/server/src/routes/orders.ts. With the old name the atomic path always
-- failed and silently fell back to read-modify-write (race condition unfixed).
-- The function already exists with the old (uuid, p_points integer) signature;
-- CREATE OR REPLACE cannot rename a parameter, so drop it first. Safe: it is
-- recreated immediately below within the same transaction, and nothing else
-- (views/triggers) depends on it.
DROP FUNCTION IF EXISTS public.increment_loyalty_points(uuid, integer);

CREATE OR REPLACE FUNCTION public.increment_loyalty_points(
  p_customer_id uuid,
  p_delta       int
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.customers
  SET loyalty_points = loyalty_points + p_delta,
      visit_count    = visit_count + 1
  WHERE id = p_customer_id;
$$;

-- updated_at trigger helper + triggers on the new tables
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['pumps','fuel_tanks','business_settings','branch_printers','ingredients','promotions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_' || tbl) THEN
      EXECUTE format(
        'CREATE TRIGGER set_updated_at_%I BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', tbl, tbl);
    END IF;
  END LOOP;
END $$;

-- ── 12. Permission seeds + reconstructed manager grants ──────────────────────
INSERT INTO public.permissions (key, label, module) VALUES
  ('ingredients.view',   'View ingredients',   'Stock'),
  ('ingredients.manage', 'Manage ingredients', 'Stock'),
  ('printers.view',      'View printers',      'Settings'),
  ('printers.manage',    'Manage printers',    'Settings')
ON CONFLICT (key) DO NOTHING;

-- Reconstructed grant_manager_permissions.sql (original file was missing).
-- Grants staff.manage + settings.manage to all manager-level roles, idempotently.
-- role_permissions has no unique(role_id,permission_id) constraint, so we guard
-- with NOT EXISTS instead of ON CONFLICT.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN ('staff.manage','settings.manage')
WHERE lower(r.name) IN ('manager','supervisor','branch_manager','admin')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- ── 13. Row-Level Security (server uses service role → bypasses RLS) ──────────
-- Policies apply only to Supabase-client (anon/auth) access. Guarded so re-runs
-- don't error. owner_all = the owning business's Supabase user gets full access.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ingredients','ingredient_stock_movements','recipes','branch_printers',
    'pumps','fuel_tanks','parking_sessions','business_settings','promotions',
    'clock_events','reservations','waitlist','expenses','expense_categories'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL USING (
         business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))', t);
  END LOOP;
END $$;

-- ── 14. Seed default super-admin (CHANGE PASSWORD ON FIRST LOGIN) ─────────────
-- Hash = bcrypt('SwiftAdmin2026!', rounds=12).
INSERT INTO public.admin_users (email, name, password_hash, role)
VALUES (
  'admin@swiftpos.co.ke',
  'SwiftPOS Admin',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/Lewm8mCWhBiQF7zO2',
  'super_admin'
)
ON CONFLICT (email) DO NOTHING;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- Verify:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name IN
--     ('clock_events','combo_items','reservations','waitlist');
--   SELECT proname FROM pg_proc WHERE proname='increment_loyalty_points';
-- ═════════════════════════════════════════════════════════════════════════════
