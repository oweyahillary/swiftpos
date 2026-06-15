-- SwiftPOS: Combo meals / set meals / bundle products
-- A combo is a product that bundles multiple other products at a fixed price.
-- combo_items defines what's included; the combo product itself lives in products table.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_combo     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS combo_price  numeric(10, 2);

CREATE TABLE IF NOT EXISTS public.combo_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_id    uuid        NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  product_id  uuid        NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity    integer     NOT NULL DEFAULT 1,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (combo_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_combo_items_combo ON public.combo_items (combo_id);
