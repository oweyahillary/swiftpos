-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20 — Per-branch pricing
--
-- Prices are PER BRANCH (see BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6). Modelled the
-- way stock already is: a separate branch-scoped table keyed (branch_id, product_id),
-- NOT a column on products.
--
--   • products.base_price  STAYS as the default/template — used when a branch has
--     no branch_prices row, and what a new branch is seeded from.
--   • branch_prices.price  is this branch's override of that default.
--   • Effective price the till charges = COALESCE(branch_prices.price, products.base_price),
--     resolved per branch at pull time (server) / edit time (manager PC).
--
-- updated_at + updated_by + version carry the metadata the two-way price sync needs
-- (BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §5): server-anchored newest-wins, with the
-- conflict grain being exactly one (branch_id, product_id) row.
--
-- Backwards-compatible: no rows are created here, so every product keeps using its
-- base_price until a branch price is explicitly set. Nothing changes for current data.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.branch_prices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id   uuid NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES public.products(id)   ON DELETE CASCADE,
  price       numeric(10,2) NOT NULL CHECK (price >= 0),

  -- Sync / conflict metadata (§5). updated_by records WHICH side last wrote this
  -- row so a collision (same row edited on both PC and cloud since last sync) is
  -- detectable; version is a monotonic counter bumped on every write.
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT 'cloud' CHECK (updated_by IN ('cloud', 'pc')),
  version     integer NOT NULL DEFAULT 1,

  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One price per product per branch. This unique key is also the conflict grain.
CREATE UNIQUE INDEX IF NOT EXISTS branch_prices_branch_product_idx
  ON public.branch_prices (branch_id, product_id);

-- Fast "all prices for this branch" lookup (the pull path) and tenant scoping.
CREATE INDEX IF NOT EXISTS branch_prices_branch_idx   ON public.branch_prices (branch_id);
CREATE INDEX IF NOT EXISTS branch_prices_business_idx ON public.branch_prices (business_id);

COMMENT ON TABLE public.branch_prices IS
  'Per-branch price override for a product. Effective price = COALESCE(branch_prices.price, products.base_price). Keyed (branch_id, product_id); that key is also the two-way-sync conflict grain.';
COMMENT ON COLUMN public.branch_prices.updated_by IS
  'Which side last wrote this row: cloud (head office) or pc (branch manager). Used to detect a both-sides collision during two-way price sync.';
COMMENT ON COLUMN public.branch_prices.version IS
  'Monotonic write counter, bumped on every update. Tiebreaker / change-detection for delta sync.';
