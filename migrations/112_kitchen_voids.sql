-- Migration 112 — 0.6.28: kitchen voids (2026-10-01)
--
-- Owner, 2026-10-01: "when a cashier clicks send to kitchen thats an order already even when the customer has not paid
-- yet … they can click send to kitchen then cancel … the customer pays they pocket the money and the kitchen staff
-- proceed to prepare the meal". Decided: once sent, every item ends PAID or as a recorded KITCHEN VOID. A void prints a
-- VOID ticket in the kitchen and is on the Z-report; with the client's 'kitchen_void_approval' switch (feature_flags,
-- admin portal) a manager approves every one and a shift cannot end while a sent order is unpaid.
--
-- public.kitchen_voids — one row per line taken back after it was sent: what, how many, what it would have sold for,
-- why (shared/kitchenLines.ts KITCHEN_VOID_REASONS), whether the kitchen had already made it, who rang it and who
-- approved it. The till writes its own (kitchen_voids, local schema 60) and pushes them through /api/sync/push; the web
-- POS writes its own through POST /api/orders/:id/kitchen-void. Names are stored with the row so a report reads the
-- same after a staff member is renamed or removed.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.kitchen_voids (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL,
  branch_id        uuid,
  shift_id         uuid,
  order_number     text NOT NULL,
  order_id         uuid REFERENCES public.orders(id) ON DELETE SET NULL,   -- the web's open order; a till's is unpaid (none)
  product_id       uuid,
  product_name     text NOT NULL,
  quantity         numeric(12,3) NOT NULL,
  unit_price       numeric(12,2) NOT NULL DEFAULT 0,
  amount           numeric(12,2) NOT NULL DEFAULT 0,
  reason           text NOT NULL,
  note             text,
  cooked           boolean NOT NULL DEFAULT false,
  cashier_id       uuid,
  cashier_name     text,
  approved_by      uuid,
  approved_by_name text,
  device_id        text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.kitchen_voids DROP CONSTRAINT IF EXISTS kitchen_voids_quantity_pos;
ALTER TABLE public.kitchen_voids ADD CONSTRAINT kitchen_voids_quantity_pos CHECK (quantity > 0);
ALTER TABLE public.kitchen_voids DROP CONSTRAINT IF EXISTS kitchen_voids_amount_nonneg;
ALTER TABLE public.kitchen_voids ADD CONSTRAINT kitchen_voids_amount_nonneg CHECK (amount >= 0 AND unit_price >= 0);
-- The reasons the till and the web offer (shared/kitchenLines.ts). A new reason is a deliberate edit here and in
-- scripts/push-domain-producers.json (check-push-domain-parity).
ALTER TABLE public.kitchen_voids DROP CONSTRAINT IF EXISTS kitchen_voids_reason_check;
ALTER TABLE public.kitchen_voids ADD CONSTRAINT kitchen_voids_reason_check
  CHECK (reason IN ('wrong_item', 'wrong_quantity', 'changed_mind', 'out_of_stock', 'kitchen_mistake'));
ALTER TABLE public.kitchen_voids DROP CONSTRAINT IF EXISTS kitchen_voids_note_len;
ALTER TABLE public.kitchen_voids ADD CONSTRAINT kitchen_voids_note_len CHECK (note IS NULL OR char_length(note) <= 200);

CREATE INDEX IF NOT EXISTS kitchen_voids_shift_idx    ON public.kitchen_voids (shift_id);
CREATE INDEX IF NOT EXISTS kitchen_voids_business_idx ON public.kitchen_voids (business_id, branch_id, created_at);

COMMENT ON TABLE public.kitchen_voids IS
  '112: items taken back after they were sent to the kitchen — reason, made or not, cashier, approving manager.';

-- RLS — same shape as day_close_instructions (migration 102). All real access is the server on the service_role (which
-- bypasses RLS); this owner_all policy is defense-in-depth for any direct PostgREST access.
ALTER TABLE public.kitchen_voids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_all ON public.kitchen_voids;
CREATE POLICY owner_all ON public.kitchen_voids FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
);

INSERT INTO public.schema_migrations (version, notes)
VALUES ('112_kitchen_voids', '0.6.28: kitchen_voids — sent items taken back (reason, made or not, who approved); till push + web route')
ON CONFLICT (version) DO NOTHING;
