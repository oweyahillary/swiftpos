-- ─────────────────────────────────────────────────────────────────────────────
-- SwiftPOS — Universal Business Types Migration
-- Adds support for: minimart, parking, petrol_station
-- Safe to run on existing data — all changes are additive.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Expand businesses.type constraint ─────────────────────────────────────

ALTER TABLE public.businesses
  DROP CONSTRAINT businesses_type_check;

ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_type_check
  CHECK (type = ANY (ARRAY[
    'retail'::character varying,
    'restaurant'::character varying,
    'cafe'::character varying,
    'minimart'::character varying,
    'parking'::character varying,
    'petrol_station'::character varying,
    'other'::character varying
  ]));

-- ── 2. Expand orders.order_type constraint ───────────────────────────────────

ALTER TABLE public.orders
  DROP CONSTRAINT orders_order_type_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_order_type_check
  CHECK (order_type = ANY (ARRAY[
    'dine_in'::character varying,
    'takeaway'::character varying,
    'retail'::character varying,
    'parking_session'::character varying,
    'fuel_sale'::character varying
  ]));

-- ── 3. Minimart / retail — barcode & unit-of-sale on products ────────────────

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS barcode character varying UNIQUE,
  ADD COLUMN IF NOT EXISTS sold_by character varying NOT NULL DEFAULT 'unit'
    CHECK (sold_by IN ('unit', 'weight', 'volume'));

-- ── 4. Parking — slot type on existing tables table ──────────────────────────
-- Reuses public.tables (same shape: name, capacity, sort_order, status).
-- dining = restaurant table, parking_bay = parking slot.

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS slot_type character varying NOT NULL DEFAULT 'dining'
    CHECK (slot_type IN ('dining', 'parking_bay'));

-- Parking sessions track time-based billing per bay.

CREATE TABLE IF NOT EXISTS public.parking_sessions (
  id            uuid          NOT NULL DEFAULT uuid_generate_v4(),
  business_id   uuid          NOT NULL,
  branch_id     uuid          NOT NULL,
  order_id      uuid,                        -- set when session is checked out & paid
  bay_id        uuid          NOT NULL,      -- FK → tables (slot_type = 'parking_bay')
  vehicle_plate character varying,
  vehicle_type  character varying            DEFAULT 'car'
                              CHECK (vehicle_type IN ('car', 'truck', 'motorbike', 'other')),
  rate_per_hour numeric       NOT NULL DEFAULT 0,
  started_at    timestamptz   NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  billed_hours  numeric,
  billed_amount numeric,
  status        character varying NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'completed', 'voided')),
  cashier_id    uuid,
  notes         text,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT parking_sessions_pkey              PRIMARY KEY (id),
  CONSTRAINT parking_sessions_business_id_fkey  FOREIGN KEY (business_id) REFERENCES public.businesses(id),
  CONSTRAINT parking_sessions_branch_id_fkey    FOREIGN KEY (branch_id)   REFERENCES public.branches(id),
  CONSTRAINT parking_sessions_order_id_fkey     FOREIGN KEY (order_id)    REFERENCES public.orders(id),
  CONSTRAINT parking_sessions_bay_id_fkey       FOREIGN KEY (bay_id)      REFERENCES public.tables(id),
  CONSTRAINT parking_sessions_cashier_id_fkey   FOREIGN KEY (cashier_id)  REFERENCES public.users(id)
);

-- ── 5. Petrol station — pumps, fuel flags on products, tanks ─────────────────

-- Fuel grade flag on products.
-- Fuel products are regular products (e.g. "Petrol", "Diesel") with is_fuel = true.
-- base_price = price per litre/kg. sold_by = 'volume' or 'weight'.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_fuel   boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fuel_unit character varying DEFAULT 'litre'
    CHECK (fuel_unit IN ('litre', 'kg'));

-- Pumps (similar concept to tables/bays for restaurants/parking).

CREATE TABLE IF NOT EXISTS public.pumps (
  id          uuid          NOT NULL DEFAULT uuid_generate_v4(),
  business_id uuid          NOT NULL,
  branch_id   uuid          NOT NULL,
  name        character varying NOT NULL,   -- e.g. "Pump 1", "Pump 2"
  sort_order  integer       NOT NULL DEFAULT 0,
  status      character varying NOT NULL DEFAULT 'idle'
              CHECK (status IN ('idle', 'dispensing', 'inactive')),
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT pumps_pkey              PRIMARY KEY (id),
  CONSTRAINT pumps_business_id_fkey  FOREIGN KEY (business_id) REFERENCES public.businesses(id),
  CONSTRAINT pumps_branch_id_fkey    FOREIGN KEY (branch_id)   REFERENCES public.branches(id)
);

-- Wet stock — fuel tank levels per branch per fuel product.

CREATE TABLE IF NOT EXISTS public.fuel_tanks (
  id               uuid          NOT NULL DEFAULT uuid_generate_v4(),
  business_id      uuid          NOT NULL,
  branch_id        uuid          NOT NULL,
  product_id       uuid          NOT NULL,   -- FK → products (is_fuel = true)
  tank_name        character varying NOT NULL, -- e.g. "Tank A – Petrol"
  capacity_litres  numeric       NOT NULL DEFAULT 0,
  current_level    numeric       NOT NULL DEFAULT 0,
  reorder_level    numeric       NOT NULL DEFAULT 500,
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT fuel_tanks_pkey              PRIMARY KEY (id),
  CONSTRAINT fuel_tanks_business_id_fkey  FOREIGN KEY (business_id) REFERENCES public.businesses(id),
  CONSTRAINT fuel_tanks_branch_id_fkey    FOREIGN KEY (branch_id)   REFERENCES public.branches(id),
  CONSTRAINT fuel_tanks_product_id_fkey   FOREIGN KEY (product_id)  REFERENCES public.products(id)
);

-- Link an order to a specific pump (for petrol sales).

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pump_id uuid REFERENCES public.pumps(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Done. New types active: minimart, parking, petrol_station
-- New tables: parking_sessions, pumps, fuel_tanks
-- New columns: products.barcode, products.sold_by, products.is_fuel,
--              products.fuel_unit, tables.slot_type, orders.pump_id
-- ─────────────────────────────────────────────────────────────────────────────
