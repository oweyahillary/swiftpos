-- Migration 126 — A413: stock batches and expiry dates; A414: wastage recorded on a till (2026-10-06)
--
-- Owner, 2026-10-06: "Recording wastage on the till itself" + "Batch and expiry-date tracking for stock — we can do
-- this 2, they are almost similar". Decided: batches for products AND ingredients; how much is left in each batch is
-- WORKED OUT oldest-expiry-first from the branch's stock level (sales, tills and offline sync do not change); wastage
-- on a till is saved on the till and sent later.
--
-- public.stock_batches — one delivery of one item at one branch: how much came in, when, its expiry date and the
--   supplier's batch / lot number (optional). Written when stock is received (product restock, goods-received note) or
--   entered for stock already on the shelf. It never holds a running balance: what is left in each batch is the
--   branch's current stock laid over the batches newest-first (lib/batches.ts) — the oldest-expiry stock is taken to
--   have gone first. A batch no longer wanted on the list (entered by mistake) is closed (closed_at), never deleted.
-- public.wastage_entries.client_id — the till's own id for a write-off it saved while offline: sent again after a lost
--   answer, it is recognised and not recorded twice.
-- public.wastage_entries.batch_id — the batch an expired write-off came from (optional, for the record).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.stock_batches (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid          NOT NULL REFERENCES public.businesses(id)  ON DELETE CASCADE,
  branch_id          uuid          NOT NULL REFERENCES public.branches(id)    ON DELETE CASCADE,
  item_kind          text          NOT NULL,
  product_id         uuid          REFERENCES public.products(id)    ON DELETE CASCADE,
  ingredient_id      uuid          REFERENCES public.ingredients(id) ON DELETE CASCADE,
  batch_no           text,
  expiry_date        date,
  quantity_received  numeric(14,3) NOT NULL,
  received_at        timestamptz   NOT NULL DEFAULT now(),
  source             text          NOT NULL DEFAULT 'manual',
  source_ref         text,
  created_by         uuid,
  created_by_name    text,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  closed_by_name     text,
  CONSTRAINT stock_batches_kind_check     CHECK (item_kind IN ('product', 'ingredient')),
  CONSTRAINT stock_batches_item_check     CHECK ((item_kind = 'product' AND product_id IS NOT NULL AND ingredient_id IS NULL)
                                              OR (item_kind = 'ingredient' AND ingredient_id IS NOT NULL AND product_id IS NULL)),
  CONSTRAINT stock_batches_quantity_check CHECK (quantity_received > 0),
  CONSTRAINT stock_batches_source_check   CHECK (source IN ('restock', 'grn', 'manual', 'transfer'))
);
CREATE INDEX IF NOT EXISTS stock_batches_branch_expiry ON public.stock_batches (branch_id, expiry_date);
CREATE INDEX IF NOT EXISTS stock_batches_product       ON public.stock_batches (product_id, branch_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_batches_ingredient    ON public.stock_batches (ingredient_id, branch_id) WHERE ingredient_id IS NOT NULL;
ALTER TABLE public.stock_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.wastage_entries ADD COLUMN IF NOT EXISTS client_id uuid;
ALTER TABLE public.wastage_entries ADD COLUMN IF NOT EXISTS batch_id  uuid REFERENCES public.stock_batches(id) ON DELETE SET NULL;
-- One recording (several items) shares one client_id, so this is a lookup, not a unique key: the route checks for the
-- client_id before writing, and the till sends one recording at a time (single-flight).
CREATE INDEX IF NOT EXISTS wastage_entries_client ON public.wastage_entries (business_id, client_id) WHERE client_id IS NOT NULL;
