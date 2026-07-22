-- =============================================================================
-- SwiftPOS — Variant stock impact + takeaway packaging (Track C, Phase 1: schema)
-- =============================================================================
-- Run this AFTER 24_inventory_permissions.sql.
--
-- Goal: let a variant option carry a STOCK CONSEQUENCE (it currently carries only
-- price_adjustment), and let a product declare the packaging it consumes on a
-- takeaway order. Covers three product requests with one mechanism:
--
--   #2 Drinks (flavour/size tracked in stock)
--        Each bottled flavour+size is its OWN stock-tracked product (sellable
--        per item). An umbrella "Soda"/"Water" button carries a size/flavour
--        variant whose options LINK to those real products (distinct-SKU mode),
--        so one tap → pick size → the correct SKU's stock moves — and selling
--        the bottle directly off the shelf deducts the same stock.
--
--   #3 Fries-type (size changes how much stock moves)
--        A size option carries a stock_factor (Medium = 1, Large = 1.5) that
--        multiplies whatever the product already deducts — its finished-good
--        counter OR its recipe ingredients — so it works for BOTH kinds of item.
--
--   #4 Takeaway packaging (boxes / baskets as deductable consumables)
--        Packaging items are ingredients flagged is_packaging = true, so they
--        get per-branch stock, cost, reorder levels and the atomic
--        adjust_ingredient_stock() RPC for free. A product maps to its takeaway
--        packaging via product_packaging; a takeaway order deducts it.
--        Cost is captured ONCE when packaging is purchased (existing expense /
--        purchase flow); consumption here is not a second expense.
--
-- This migration is NON-BREAKING: every new column defaults to current behaviour
-- (stock_factor = 1, no linked product, no packaging). Deduction logic that reads
-- these columns lands in Phase 2 (order-deduction) — until then nothing changes.
--
-- Sections:
--   1. variant_options — stock impact columns (scale mode + linked-SKU mode)
--   2. ingredients     — is_packaging flag
--   3. product_packaging — per-product takeaway packaging mapping
-- =============================================================================


-- ─── 1. VARIANT OPTION STOCK IMPACT ─────────────────────────────────────────
-- Two independent, composable modes per option:
--
--   • SCALE MODE — stock_factor (default 1).
--     Multiplies the PARENT product's normal deduction. On an order line, the
--     effective factor is the product of every selected option's stock_factor
--     (all default 1, so a no-op unless configured). Applies to both the
--     product's finished-good counter and its recipe-ingredient deductions.
--     Use for: Fries Small/Medium/Large, "double patty", etc.
--
--   • LINKED-SKU MODE — linked_product_id + deduct_qty.
--     When linked_product_id IS NOT NULL, selling this option deducts
--     (deduct_qty × line quantity) from the LINKED product's stock instead of
--     the umbrella product. Use for: bottled Coke 350ml / 1L / 2L, Fanta, water
--     — each a real, separately-stocked, individually-sellable product.
--
-- Precedence (implemented in Phase 2): an option with linked_product_id set
-- deducts the linked SKU; options without it contribute their stock_factor to
-- the parent product's deduction. A single line may do both (e.g. a linked
-- drink option + a scaled size option) — the effects compose.
ALTER TABLE variant_options
  ADD COLUMN IF NOT EXISTS stock_factor      NUMERIC(10,3) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS linked_product_id UUID          NULL REFERENCES products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deduct_qty        NUMERIC(10,3) NOT NULL DEFAULT 1;

-- Guardrails: a factor must be positive; a linked deduction must be positive.
ALTER TABLE variant_options
  DROP CONSTRAINT IF EXISTS chk_variant_stock_factor;
ALTER TABLE variant_options
  ADD  CONSTRAINT chk_variant_stock_factor CHECK (stock_factor > 0);

ALTER TABLE variant_options
  DROP CONSTRAINT IF EXISTS chk_variant_deduct_qty;
ALTER TABLE variant_options
  ADD  CONSTRAINT chk_variant_deduct_qty CHECK (deduct_qty > 0);

CREATE INDEX IF NOT EXISTS idx_variant_options_linked_product
  ON variant_options(linked_product_id)
  WHERE linked_product_id IS NOT NULL;


-- ─── 2. PACKAGING ITEMS (as flagged ingredients) ────────────────────────────
-- Packaging (boxes, baskets, bags, cups, lids) is a consumable with stock and a
-- cost, but is never sold. Modelling it as an ingredient reuses everything that
-- already exists: per-branch stock (ingredient_stock_levels), atomic deduction
-- (adjust_ingredient_stock), movement audit, cost (unit_cost) and reorder level.
-- The flag just lets the UI/reports separate "packaging" from recipe ingredients.
ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS is_packaging BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ingredients_packaging
  ON ingredients(business_id)
  WHERE is_packaging = true;


-- ─── 3. PRODUCT → TAKEAWAY PACKAGING MAPPING ────────────────────────────────
-- Which packaging a product consumes when sold as takeaway, and how much.
-- e.g. "Wings 6pc" → 1 × Small Box ; "Family Bucket" → 1 × Basket.
-- Phase 2 deducts these (quantity × line quantity) ONLY for order_type =
-- 'takeaway', via adjust_ingredient_stock() against the order's branch.
-- Dine-in orders never consume takeaway packaging.
CREATE TABLE IF NOT EXISTS product_packaging (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id    UUID          NOT NULL REFERENCES businesses(id)  ON DELETE CASCADE,
  product_id     UUID          NOT NULL REFERENCES products(id)    ON DELETE CASCADE,
  ingredient_id  UUID          NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,  -- the packaging item
  quantity       NUMERIC(10,3) NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- one mapping row per (product, packaging item)
  CONSTRAINT uq_product_packaging UNIQUE (product_id, ingredient_id),
  CONSTRAINT chk_product_packaging_qty CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_product_packaging_product
  ON product_packaging(product_id);
CREATE INDEX IF NOT EXISTS idx_product_packaging_business
  ON product_packaging(business_id);
CREATE INDEX IF NOT EXISTS idx_product_packaging_ingredient
  ON product_packaging(ingredient_id);


-- =============================================================================
-- After this runs the schema is ready but inert: variants still deduct exactly
-- as before (factor 1, no links), no product has packaging yet. Phase 2 wires
-- the order-deduction loop to read these columns; Phase 3 adds the dashboard UI.
-- =============================================================================
