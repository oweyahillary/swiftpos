-- =============================================================================
-- SwiftPOS — Per-branch ingredient stock (Phase 1: schema + backfill + RPC)
-- =============================================================================
-- Run this AFTER pos_migration_v28_recipes.sql.
--
-- Goal: move ingredient stock from a single business-level column
-- (ingredients.current_stock) to a per-branch table, mirroring how product
-- stock already works (stock_levels keyed by product_id + branch_id).
--
-- This migration is NON-BREAKING: it ADDS the new table/column/RPC and backfills
-- data. It does NOT drop ingredients.current_stock yet (that's Phase 6, once the
-- app no longer reads it). Old code keeps working until each phase lands.
--
-- Sections:
--   1. ingredient_stock_levels           (new per-branch stock table)
--   2. ingredient_stock_movements        (add branch_id for per-branch audit)
--   3. Backfill                          (seed rows from existing current_stock)
--   4. adjust_ingredient_stock()         (atomic RPC — safe under concurrency)
-- =============================================================================

-- ─── 1. PER-BRANCH INGREDIENT STOCK ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingredient_stock_levels (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id    UUID NOT NULL REFERENCES businesses(id)  ON DELETE CASCADE,
  ingredient_id  UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  branch_id      UUID NOT NULL REFERENCES branches(id)    ON DELETE CASCADE,
  current_stock  NUMERIC(12,2) NOT NULL DEFAULT 0,
  reorder_level  NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- one stock row per ingredient per branch
  CONSTRAINT uq_ingredient_branch UNIQUE (ingredient_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_ing_stock_branch
  ON ingredient_stock_levels(branch_id);
CREATE INDEX IF NOT EXISTS idx_ing_stock_business
  ON ingredient_stock_levels(business_id);
CREATE INDEX IF NOT EXISTS idx_ing_stock_ingredient
  ON ingredient_stock_levels(ingredient_id);

-- ─── 2. MOVEMENTS: ADD BRANCH CONTEXT ───────────────────────────────────────
-- Movements were business-level only. Every movement now records which branch
-- it happened in (receipt, adjustment, wastage, opening, sale).
ALTER TABLE ingredient_stock_movements
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ingr_movements_branch
  ON ingredient_stock_movements(branch_id);

-- ─── 3. BACKFILL EXISTING STOCK INTO A BRANCH ───────────────────────────────
-- Existing ingredients.current_stock is business-level; it has to land in one
-- branch. DEFAULT RULE: the earliest-created branch per business ("primary").
--
-- ⚠ VERIFY before running in production:
--   - Confirms branches has a created_at column (used to pick the primary).
--   - If any business runs MULTIPLE branches with real stock already, this rule
--     dumps all of it into the primary branch. Adjust the CTE to your policy
--     (e.g. split, or assign to a named main branch) if that's not what you want.
WITH primary_branch AS (
  SELECT DISTINCT ON (business_id) business_id, id AS branch_id
  FROM branches
  ORDER BY business_id, created_at ASC
)
INSERT INTO ingredient_stock_levels
      (business_id, ingredient_id, branch_id, current_stock, reorder_level)
SELECT i.business_id, i.id, pb.branch_id, i.current_stock, i.reorder_level
FROM   ingredients i
JOIN   primary_branch pb ON pb.business_id = i.business_id
ON CONFLICT (ingredient_id, branch_id) DO NOTHING;

-- Record the backfill as an 'opening' movement so the audit trail is complete.
WITH primary_branch AS (
  SELECT DISTINCT ON (business_id) business_id, id AS branch_id
  FROM branches
  ORDER BY business_id, created_at ASC
)
INSERT INTO ingredient_stock_movements
      (business_id, ingredient_id, branch_id, movement_type,
       quantity_change, quantity_after, notes)
SELECT i.business_id, i.id, pb.branch_id, 'opening',
       i.current_stock, i.current_stock, 'Per-branch migration backfill'
FROM   ingredients i
JOIN   primary_branch pb ON pb.business_id = i.business_id
WHERE  i.current_stock <> 0;

-- ─── 4. ATOMIC STOCK ADJUSTMENT RPC ─────────────────────────────────────────
-- Single source of truth for changing ingredient stock. Does the read + write
-- in ONE statement inside the DB, so concurrent sales/receipts can't clobber
-- each other (fixes the read-modify-write race in the old app-side logic).
--
-- p_delta: negative to deduct (sale/wastage), positive to add (receipt).
-- Upserts the (ingredient, branch) row if it doesn't exist yet.
-- Returns the new current_stock. Does NOT block on negative (business rule:
-- never fail a sale for stock) — callers decide whether to warn.
CREATE OR REPLACE FUNCTION adjust_ingredient_stock(
  p_ingredient_id UUID,
  p_branch_id     UUID,
  p_business_id   UUID,
  p_delta         NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
  v_new NUMERIC;
BEGIN
  INSERT INTO ingredient_stock_levels
        (business_id, ingredient_id, branch_id, current_stock)
  VALUES (p_business_id, p_ingredient_id, p_branch_id, p_delta)
  ON CONFLICT (ingredient_id, branch_id) DO UPDATE
    SET current_stock = ingredient_stock_levels.current_stock + p_delta,
        updated_at    = NOW()
  RETURNING current_stock INTO v_new;

  RETURN v_new;
END;
$$;

-- =============================================================================
-- After this runs, the new structures exist and are populated, but the app is
-- still reading the old column. Phases 2-5 migrate the code onto this table;
-- Phase 6 drops ingredients.current_stock.
-- =============================================================================
