-- ─────────────────────────────────────────────────────────────────────────────
-- pos_migration_v30_pieces_and_reports.sql
--
-- 1. Products  — add 'piece' to sold_by enum, pieces_per_unit, unit_label
-- 2. Stock levels — add qty_pieces for piece-level tracking
-- 3. Categories   — add super_category (e.g. BURGER > Burger Combo)
-- 4. Orders       — add 'aggregator' order_type + aggregator_name column
-- 5. Indexes      — support hourly/daily report queries
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Products ───────────────────────────────────────────────────────────────

-- Extend sold_by check to include 'piece'
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_sold_by_check;

ALTER TABLE products
  ADD CONSTRAINT products_sold_by_check
    CHECK (sold_by IN ('each', 'weight', 'volume', 'piece'));

-- How many sellable pieces are in one received unit (e.g. 12 wings per batch)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pieces_per_unit  INTEGER       NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_label       TEXT          NOT NULL DEFAULT 'pc',
  -- Central-kitchen products flag (received as finished goods, not ingredients)
  ADD COLUMN IF NOT EXISTS source           TEXT          NOT NULL DEFAULT 'purchased'
    CHECK (source IN ('purchased', 'central_kitchen'));

-- ── 2. Stock levels ───────────────────────────────────────────────────────────

-- qty_pieces tracks individual pieces remaining after unpacking a batch.
-- For sold_by = 'each'  : qty_pieces is always 0 (unused).
-- For sold_by = 'piece' : qty_pieces is the live sellable piece count.
--                         Incremented by: GRN qty_received × pieces_per_unit
--                         Decremented by: each piece sold
ALTER TABLE stock_levels
  ADD COLUMN IF NOT EXISTS qty_pieces INTEGER NOT NULL DEFAULT 0;

-- ── 3. Categories ─────────────────────────────────────────────────────────────

-- Super-category is the grouping above category used in the Master Data report
-- e.g.  category = 'Burger Combo'  →  super_category = 'BURGER'
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS super_category TEXT;

-- ── 4. Orders — aggregator channel ───────────────────────────────────────────

-- Add 'aggregator' as an explicit order type (Bolt, UberEats, Jumia Food…)
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_order_type_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_order_type_check
    CHECK (order_type IN (
      'retail', 'dine_in', 'takeaway', 'delivery',
      'aggregator', 'parking_session', 'fuel_sale', 'other'
    ));

-- Which aggregator platform placed the order
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS aggregator_name TEXT;  -- e.g. 'bolt', 'ubereats', 'jumia'

-- ── 5. Performance indexes ────────────────────────────────────────────────────

-- Hourly sales report: scan orders by hour within a business+date range
CREATE INDEX IF NOT EXISTS idx_orders_business_created
  ON orders (business_id, created_at)
  WHERE status = 'completed';

-- Channel split: filter by order_type quickly
CREATE INDEX IF NOT EXISTS idx_orders_business_type
  ON orders (business_id, order_type, created_at)
  WHERE status = 'completed';

-- Void report: quickly pull voided orders
CREATE INDEX IF NOT EXISTS idx_orders_voided
  ON orders (business_id, created_at)
  WHERE status = 'voided';

-- Category sales report via order_items
CREATE INDEX IF NOT EXISTS idx_order_items_category
  ON order_items (order_id, category_name);

-- ── 6. Void reason on orders ──────────────────────────────────────────────────
-- Captures why a bill was voided (required for Voids & Exceptions report)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS void_reason TEXT;
