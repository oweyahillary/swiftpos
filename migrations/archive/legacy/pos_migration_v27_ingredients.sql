-- =============================================================================
-- SwiftPOS  —  Ingredients & Supply Stock System
-- =============================================================================
-- Run this in your Supabase SQL Editor.
-- This migration:
--   1. Creates the ingredients table (things you buy from suppliers)
--   2. Creates ingredient_stock_movements (audit trail)
--   3. Creates recipes (Option B foundation — schema only, not used in UI yet)
--   4. Drops and recreates purchase_order_items with ingredient_id instead of product_id
--   5. Drops and recreates grn_items with ingredient_id instead of product_id
-- =============================================================================

-- ─── 1. INGREDIENTS ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ingredients (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name              VARCHAR(255) NOT NULL,
  category          VARCHAR(100),
  unit              VARCHAR(50)  NOT NULL DEFAULT 'pieces',
  unit_cost         NUMERIC(12,2),
  current_stock     NUMERIC(12,2) NOT NULL DEFAULT 0,
  reorder_level     NUMERIC(12,2) NOT NULL DEFAULT 0,
  status            VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingredients_business  ON ingredients(business_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_category  ON ingredients(business_id, category);

-- ─── 2. INGREDIENT STOCK MOVEMENTS ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ingredient_stock_movements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ingredient_id   UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  movement_type   VARCHAR(30) NOT NULL CHECK (movement_type IN ('restock', 'adjustment', 'wastage', 'opening')),
  quantity_change NUMERIC(12,2) NOT NULL,
  quantity_after  NUMERIC(12,2) NOT NULL,
  notes           TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingr_movements_ingredient ON ingredient_stock_movements(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_ingr_movements_business   ON ingredient_stock_movements(business_id);

-- ─── 3. RECIPES (Option B foundation — not wired to UI yet) ──────────────────

CREATE TABLE IF NOT EXISTS recipes (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id           UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id        UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  quantity_per_serving NUMERIC(12,4) NOT NULL,
  unit                 VARCHAR(50),
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, ingredient_id)
);

CREATE INDEX IF NOT EXISTS idx_recipes_product    ON recipes(product_id);
CREATE INDEX IF NOT EXISTS idx_recipes_ingredient ON recipes(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_recipes_business   ON recipes(business_id);

-- ─── 4. REBUILD PURCHASE ORDER ITEMS with ingredient_id ──────────────────────
-- WARNING: deletes existing PO item data. Safe during testing.

DROP TABLE IF EXISTS grn_items CASCADE;
DROP TABLE IF EXISTS purchase_order_items CASCADE;

CREATE TABLE purchase_order_items (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  purchase_order_id  UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  ingredient_id      UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity_ordered   NUMERIC(12,2) NOT NULL,
  unit_cost          NUMERIC(12,2) NOT NULL DEFAULT 0,
  quantity_received  NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_po_items_po         ON purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_po_items_ingredient ON purchase_order_items(ingredient_id);

-- ─── 5. REBUILD GRN ITEMS with ingredient_id ─────────────────────────────────

CREATE TABLE grn_items (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  grn_id             UUID NOT NULL REFERENCES goods_received_notes(id) ON DELETE CASCADE,
  ingredient_id      UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity_received  NUMERIC(12,2) NOT NULL,
  unit_cost          NUMERIC(12,2),
  notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_grn_items_grn        ON grn_items(grn_id);
CREATE INDEX IF NOT EXISTS idx_grn_items_ingredient ON grn_items(ingredient_id);

-- ─── 6. RLS POLICIES ─────────────────────────────────────────────────────────

ALTER TABLE ingredients                ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredient_stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes                    ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_all ON ingredients
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY owner_all ON ingredient_stock_movements
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY owner_all ON recipes
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- ─── 7. PERMISSIONS ──────────────────────────────────────────────────────────

INSERT INTO permissions (key, label, module) VALUES
  ('ingredients.view',   'View ingredients',   'Stock'),
  ('ingredients.manage', 'Manage ingredients', 'Stock')
ON CONFLICT (key) DO NOTHING;
