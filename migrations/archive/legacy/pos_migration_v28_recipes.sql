-- =============================================================================
-- SwiftPOS — Recipe Builder migration patch
-- =============================================================================
-- Run this AFTER pos_migration_v27_ingredients.sql
--
-- Adds 'sale' as a valid movement_type for ingredient_stock_movements
-- so that POS sales can deduct ingredient stock via recipes.
-- =============================================================================

-- Widen the check constraint to include 'sale'
ALTER TABLE ingredient_stock_movements
  DROP CONSTRAINT IF EXISTS ingredient_stock_movements_movement_type_check;

ALTER TABLE ingredient_stock_movements
  ADD CONSTRAINT ingredient_stock_movements_movement_type_check
  CHECK (movement_type IN ('restock', 'adjustment', 'wastage', 'opening', 'sale'));

-- Index to make per-order lookups fast
CREATE INDEX IF NOT EXISTS idx_recipes_business_product
  ON recipes(business_id, product_id);
