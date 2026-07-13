-- ─────────────────────────────────────────────────────────────────────────────
-- SwiftPOS — All-Phases Migration
-- Run in Supabase SQL editor after existing migrations.
-- Safe to re-run — uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Products: extended fields (barcode, PLU, sold_by, is_fuel) ─────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS barcode       TEXT,
  ADD COLUMN IF NOT EXISTS plu_code      TEXT,
  ADD COLUMN IF NOT EXISTS sold_by       TEXT    NOT NULL DEFAULT 'each'
                                         CHECK (sold_by IN ('each', 'weight', 'volume')),
  ADD COLUMN IF NOT EXISTS is_fuel       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fuel_unit     TEXT    CHECK (fuel_unit IN ('L', 'gal')),
  ADD COLUMN IF NOT EXISTS cost_price    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS reorder_level INTEGER;

-- Unique barcode per business (nulls are excluded from unique constraint)
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_business_idx
  ON products (business_id, barcode) WHERE barcode IS NOT NULL;

-- Unique PLU per business
CREATE UNIQUE INDEX IF NOT EXISTS products_plu_business_idx
  ON products (business_id, plu_code) WHERE plu_code IS NOT NULL;

-- ── 2. Payments: M-Pesa checkout tracking ─────────────────────────────────────
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS mpesa_checkout_id TEXT,
  ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'completed'
                                             CHECK (status IN ('pending', 'completed', 'failed', 'refunded'));

CREATE INDEX IF NOT EXISTS payments_mpesa_checkout_idx ON payments (mpesa_checkout_id)
  WHERE mpesa_checkout_id IS NOT NULL;

-- ── 3. Pumps table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pumps (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id         UUID        REFERENCES branches(id) ON DELETE SET NULL,
  fuel_product_id   UUID        REFERENCES products(id) ON DELETE SET NULL,
  name              TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'idle'
                                CHECK (status IN ('idle', 'dispensing', 'inactive', 'error')),
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pumps_business_idx ON pumps (business_id);
CREATE INDEX IF NOT EXISTS pumps_branch_idx   ON pumps (branch_id);

-- ── 4. Fuel tanks (wet stock) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuel_tanks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id        UUID        REFERENCES branches(id) ON DELETE SET NULL,
  fuel_product_id  UUID        NOT NULL REFERENCES products(id),
  name             TEXT        NOT NULL,
  capacity_litres  NUMERIC(10,2) NOT NULL DEFAULT 10000,
  current_level    NUMERIC(10,2) NOT NULL DEFAULT 0,
  reorder_level    NUMERIC(10,2) NOT NULL DEFAULT 1000,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fuel_tanks_business_idx ON fuel_tanks (business_id);

-- ── 5. Parking sessions table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parking_sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id       UUID        REFERENCES branches(id) ON DELETE SET NULL,
  bay_id          UUID        NOT NULL REFERENCES tables(id),
  order_id        UUID        REFERENCES orders(id),
  vehicle_plate   TEXT,
  vehicle_type    TEXT        NOT NULL DEFAULT 'car',
  rate_per_hour   NUMERIC(10,2) NOT NULL DEFAULT 200,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  billed_hours    NUMERIC(5,2),
  total_amount    NUMERIC(10,2),
  status          TEXT        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'completed', 'voided')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS parking_sessions_bay_idx      ON parking_sessions (bay_id);
CREATE INDEX IF NOT EXISTS parking_sessions_business_idx ON parking_sessions (business_id);
CREATE INDEX IF NOT EXISTS parking_sessions_status_idx   ON parking_sessions (status);

-- ── 6. Extend tables: parking bay fields ─────────────────────────────────────
ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS bay_status   TEXT CHECK (bay_status IN ('active', 'reserved', 'blocked')),
  ADD COLUMN IF NOT EXISTS rate_per_hour NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS zone         TEXT,
  ADD COLUMN IF NOT EXISTS shape        TEXT DEFAULT 'rect' CHECK (shape IN ('rect', 'circle')),
  ADD COLUMN IF NOT EXISTS pos_x        INTEGER,
  ADD COLUMN IF NOT EXISTS pos_y        INTEGER;

-- ── 7. Business settings: ensure table exists ─────────────────────────────────
CREATE TABLE IF NOT EXISTS business_settings (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT        NOT NULL,
  value       TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, key)
);

CREATE INDEX IF NOT EXISTS business_settings_business_idx ON business_settings (business_id);

-- ── 8. Users: bcrypt PIN flag & must_change_password ─────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS owner_name           TEXT,
  ADD COLUMN IF NOT EXISTS pin_upgraded         BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 9. Branches: city/country ─────────────────────────────────────────────────
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS city    TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'Kenya';

-- ── 10. Orders: extended order types ─────────────────────────────────────────
-- Allow parking_session and fuel_sale as order types
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_order_type_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('retail', 'dine_in', 'takeaway', 'delivery', 'parking_session', 'fuel_sale', 'other'));

-- ── 11. Stock movements: delivery type ────────────────────────────────────────
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS reference_type TEXT,
  ADD COLUMN IF NOT EXISTS notes         TEXT;

-- ── 12. Updated_at triggers (apply to new tables) ────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['pumps', 'fuel_tanks', 'business_settings'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'set_updated_at_' || tbl
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER set_updated_at_%I
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
        tbl, tbl
      );
    END IF;
  END LOOP;
END;
$$;

-- ── 13. RLS policies for new tables ──────────────────────────────────────────
ALTER TABLE pumps            ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_tanks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE parking_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_settings ENABLE ROW LEVEL SECURITY;

-- Service-role bypasses RLS — our server uses the service key, so no policies needed
-- for server-side queries. Add user-facing policies if you add Supabase client queries.

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Verify with:
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'products';
--   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
