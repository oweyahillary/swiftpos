-- 98_drop_ingredients_current_stock.sql
-- A12 Phase 6 — the drop migration 23 deferred.
--
-- Migration 23 moved ingredient stock to the per-branch `ingredient_stock_levels`
-- and said in its own header that it "does NOT drop ingredients.current_stock yet
-- (that's Phase 6)". Phase 6 never came. Since then `ingredients.current_stock`
-- has had NO writer — a frozen snapshot the Recipes drawer wrongly showed as
-- "0 in red". `recipes.ts` and `stock.ts` now serve the LIVE per-branch value
-- from `ingredient_stock_levels`, and a repo-wide sweep confirms ZERO readers and
-- ZERO writers of `ingredients.current_stock` remain.
--
-- Dropping it (a) removes the dead-column trap for good, and (b) turns the
-- existing `schema-audit` gate into the "column-level comparator" the A12 entry
-- asked for — any future code that reads `ingredients.current_stock` will fail the
-- gate because the column no longer exists in the live schema.
--
-- Safe + idempotent: nothing references the column. Live stock is untouched (it
-- lives in `ingredient_stock_levels`, which this migration does not touch).
-- After applying on prod, refresh `scripts/schema-index.json` from live.

ALTER TABLE public.ingredients DROP COLUMN IF EXISTS current_stock;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('98_drop_ingredients_current_stock',
        'A12 Phase 6. Drops the dead ingredients.current_stock (no writer since migration 23; stock lives per-branch in ingredient_stock_levels). No reader/writer remains; schema-audit now guards against future reads.')
ON CONFLICT (version) DO NOTHING;
