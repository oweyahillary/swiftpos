-- Migration 194 — Per-branch menu: a product can be off some branches' menus (A625)
--
-- Owner, 2026-11-23: "some items are sold in branch A but not in branch B … each branch can have its own menu item."
-- (docs/tasks/A625-per-branch-menu.md)
--
-- An EXCLUSION table: a row means "this product is HIDDEN at this branch". NO rows for a product ⇒ it is on every
-- branch's menu, exactly as today — so this migration changes nothing for existing data (no backfill). A product
-- limited to one branch of four is three rows. The POS pull for a branch drops the products hidden there, next to the
-- existing stock-gate (A563); POST /orders refuses a line for a product hidden at the ordering branch.
--
-- A change bumps the catalogue sync version (migration 150's bump_sync_version), so every POS pulls it on the next
-- check — the same way a branch's premium (migration 182) and a flag flip reach the tills.
--
-- Additive, idempotent, reversible: DROP TABLE public.product_branches_hidden.

CREATE TABLE IF NOT EXISTS public.product_branches_hidden (
  product_id   uuid          NOT NULL REFERENCES public.products(id)   ON DELETE CASCADE,
  branch_id    uuid          NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  business_id  uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  created_by   text          NULL CHECK (created_by IS NULL OR char_length(created_by) <= 200),
  PRIMARY KEY (product_id, branch_id)
);
COMMENT ON TABLE public.product_branches_hidden IS
  'A625: a product hidden at a branch (off that branch''s menu). No row = on every branch, as before. The POS pull drops these for the branch; POST /orders refuses them.';
CREATE INDEX IF NOT EXISTS product_branches_hidden_branch_idx   ON public.product_branches_hidden (branch_id);
CREATE INDEX IF NOT EXISTS product_branches_hidden_business_idx ON public.product_branches_hidden (business_id);

-- A625: a change moves the business's catalogue version (migration 150's trigger), so its POS sees it on the next check,
-- as a branch's premium (migration 182) and a feature-flag change do.
DO $a625$
BEGIN
  IF to_regprocedure('public.bump_sync_version(text)') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_product_branches_hidden_catalogue ON public.product_branches_hidden;
    CREATE TRIGGER trg_product_branches_hidden_catalogue AFTER INSERT OR UPDATE OR DELETE ON public.product_branches_hidden
      FOR EACH ROW EXECUTE FUNCTION public.bump_sync_version('catalogue');
  END IF;
END $a625$;

-- RLS on: the business's owner may read its own (its menu); writes go through the server (service role).
ALTER TABLE public.product_branches_hidden ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_branches_hidden_owner_reads ON public.product_branches_hidden;
CREATE POLICY product_branches_hidden_owner_reads ON public.product_branches_hidden FOR SELECT
  USING (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()));

DO $$ BEGIN
  REVOKE ALL ON public.product_branches_hidden FROM anon;
EXCEPTION WHEN others THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('194_product_branches_hidden', 'A625: per-branch menu — product_branches_hidden (a product off a branch''s menu); exclusion table, no rows = everywhere as before')
ON CONFLICT (version) DO NOTHING;
