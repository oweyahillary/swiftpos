-- =============================================================================
-- SwiftPOS — Variant option can deduct an INGREDIENT (Track C, Phase 1b)
-- =============================================================================
-- Run this AFTER 25_variant_stock_and_packaging.sql.
--
-- 25 let a variant option link to a PRODUCT (linked_product_id) — perfect for
-- bottled drinks, which are their own stock-tracked products. But some sized
-- upgrades consume a raw INGREDIENT, not a product:
--
--     Combo "Large chips" (+70) → deduct extra frozen fries (kg)
--
-- Scaling the whole combo recipe with stock_factor would over-deduct the OTHER
-- ingredients (e.g. chicken). So a variant option needs to target one specific
-- ingredient. This adds that, mirroring linked_product_id and reusing deduct_qty.
--
-- Precedence (implemented in the order-deduction loop):
--   • linked_product_id set    → deduct that product's stock  (bottled drink SKU)
--   • linked_ingredient_id set → deduct that ingredient's stock (extra fries)
--   • neither set              → stock_factor scales the parent product deduction
-- An option links to AT MOST ONE target — enforced by the CHECK below.
--
-- NON-BREAKING: new column is nullable; existing rows/behaviour unchanged.
-- =============================================================================

ALTER TABLE variant_options
  ADD COLUMN IF NOT EXISTS linked_ingredient_id UUID NULL
    REFERENCES ingredients(id) ON DELETE SET NULL;

-- An option may link to a product OR an ingredient, never both.
ALTER TABLE variant_options
  DROP CONSTRAINT IF EXISTS chk_variant_single_link;
ALTER TABLE variant_options
  ADD  CONSTRAINT chk_variant_single_link
    CHECK (linked_product_id IS NULL OR linked_ingredient_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_variant_options_linked_ingredient
  ON variant_options(linked_ingredient_id)
  WHERE linked_ingredient_id IS NOT NULL;

-- =============================================================================
-- After this runs, a variant option can carry exactly one of: a scale factor,
-- a linked product, or a linked ingredient. The deduction engine (Phase 2,
-- extended alongside this migration) reads all three. UI to set them is Phase 3.
-- =============================================================================
