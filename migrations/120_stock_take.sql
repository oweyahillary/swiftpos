-- Migration 120 — A394: stock take (2026-10-04)
--
-- Owner, 2026-10-04: "We are missing a stock take module". Answers: "Yes the count should be blind, I would recommend
-- freeze but we leave that as a feature which the owner will decide".
--
-- public.stock_takes — one count at one branch: counting → review → posted (or cancelled). At most ONE open count per
--   branch (counting or review), so "what is being counted here" always has one answer. `freeze_sales` is copied from
--   the owner's setting (business_settings 'stock_count_freeze') when the count starts.
-- public.stock_take_lines — one item (a stocked product or an ingredient) in a count. The person counting types
--   counted_qty and never sees expected_qty: the cloud records what the system held AT THAT MOMENT (blind count).
--   expected_final / variance / posted_delta are written when the count is posted — expected_final also takes in till
--   sales made before the item was counted that only reached the cloud afterwards.
-- public.ingredient_stock_movements.reference_type / reference_id — like stock_movements already has: which order or
--   which stock take moved the ingredient. Lets a count find a till's late sales of an ingredient, and lets anyone see
--   which count changed a figure.
-- permission inventory.count — count stock. Granted here to the manager role set; posting a count stays with
--   inventory.adjust (owner-only by default: only the owner silently changes a number).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.stock_takes (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id         uuid        NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  ref               text        NOT NULL,
  status            text        NOT NULL DEFAULT 'counting',
  scope             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  freeze_sales      boolean     NOT NULL DEFAULT false,
  note              text,
  started_by        uuid,
  started_by_name   text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at      timestamptz,
  submitted_by_name text,
  posted_at         timestamptz,
  posted_by         uuid,
  posted_by_name    text,
  cancelled_at      timestamptz,
  cancelled_by_name text,
  summary           jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_takes_status_check CHECK (status IN ('counting', 'review', 'posted', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_takes_one_open_per_branch
  ON public.stock_takes (branch_id) WHERE status IN ('counting', 'review');
CREATE INDEX IF NOT EXISTS stock_takes_business ON public.stock_takes (business_id, started_at DESC);
ALTER TABLE public.stock_takes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.stock_take_lines (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_take_id    uuid          NOT NULL REFERENCES public.stock_takes(id) ON DELETE CASCADE,
  business_id      uuid          NOT NULL,
  item_kind        text          NOT NULL,
  product_id       uuid          REFERENCES public.products(id)    ON DELETE CASCADE,
  ingredient_id    uuid          REFERENCES public.ingredients(id) ON DELETE CASCADE,
  name             text          NOT NULL,
  unit             text,
  category         text,
  by_piece         boolean       NOT NULL DEFAULT false,
  unit_cost        numeric(12,2),
  counted_qty      numeric(12,2),
  expected_qty     numeric(12,2),
  counted_at       timestamptz,
  counted_by       uuid,
  counted_by_name  text,
  previous_count   numeric(12,2),
  recount          boolean       NOT NULL DEFAULT false,
  late_sales       numeric(12,2),
  expected_final   numeric(12,2),
  variance         numeric(12,2),
  variance_value   numeric(14,2),
  posted_delta     numeric(12,2),
  posted_at        timestamptz,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT stock_take_lines_kind_check CHECK (
    (item_kind = 'product'    AND product_id    IS NOT NULL AND ingredient_id IS NULL) OR
    (item_kind = 'ingredient' AND ingredient_id IS NOT NULL AND product_id    IS NULL)),
  CONSTRAINT stock_take_lines_counted_check CHECK (counted_qty IS NULL OR counted_qty >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_take_lines_one_product
  ON public.stock_take_lines (stock_take_id, product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_take_lines_one_ingredient
  ON public.stock_take_lines (stock_take_id, ingredient_id) WHERE ingredient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_take_lines_take ON public.stock_take_lines (stock_take_id);
ALTER TABLE public.stock_take_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ingredient_stock_movements
  ADD COLUMN IF NOT EXISTS reference_type text,
  ADD COLUMN IF NOT EXISTS reference_id   uuid;

INSERT INTO public.permissions (key, label, module, description)
VALUES ('inventory.count', 'Count stock', 'inventory', 'Take part in a stock count (blind: never sees the expected figure)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key = 'inventory.count'
  -- Same normalised name match as 75 section 3, 76, 78, 83.
  AND  lower(replace(r.name, ' ', '_'))
         IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

COMMENT ON TABLE public.stock_takes IS
  '120 (A394): a stock count at one branch — counting, review, posted or cancelled; one open count per branch.';
COMMENT ON TABLE public.stock_take_lines IS
  '120 (A394): one item in a stock count. expected_qty is what the system held when the item was counted; never shown to the person counting.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('120_stock_take', 'A394: stock take — stock_takes, stock_take_lines, ingredient_stock_movements.reference_*, permission inventory.count')
ON CONFLICT (version) DO NOTHING;
