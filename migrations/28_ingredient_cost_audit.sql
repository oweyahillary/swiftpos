-- =============================================================================
-- SwiftPOS — Ingredient cost audit trail + PO soft-delete (audit H13)
-- =============================================================================
-- H13: PATCH /ingredients/:id let any authenticated user rewrite unit_cost —
-- the quantity door (POST /:id/adjust) is permission-gated AND logged to
-- ingredient_stock_movements; the valuation door was open and silent. Gating
-- the endpoint (see stock.ts) closes the door; this adds the log, mirroring
-- the pattern ingredient_stock_movements already established for quantities.
--
-- Also: DELETE /purchase-orders/:id was a real DELETE (draft POs only, but
-- still destroys the record). Converted to soft-delete in stock.ts; this adds
-- the column. Additive/nullable, so no assumption is made about the rest of
-- the purchase_orders schema (it isn't defined anywhere in this migration set
-- — created earlier, outside what's in this repo).
-- =============================================================================

CREATE TABLE IF NOT EXISTS ingredient_cost_history (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  old_unit_cost NUMERIC(12,2),
  new_unit_cost NUMERIC(12,2),
  changed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingr_cost_history_ingredient ON ingredient_cost_history(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_ingr_cost_history_business   ON ingredient_cost_history(business_id);

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
