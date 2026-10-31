-- Migration 182 — The cloud billed per branch (A612)
--
-- Owner, 2026-10-30: "monthly subscription should be per branch for premium services or web — if a branch does not pay it
-- should not view its data and the owner should not see it too, it cuts across all users" · "if a branch has not paid it's
-- cut off completely, nothing syncs" · "even price change online should not sync". (docs/A612-per-branch-cloud.md)
--
-- What this adds (additive, idempotent; nothing existing changes meaning):
--
--   branch_cloud_plans   one row per branch on the cloud plan: its own period and amount (as cloud_plans), its own
--                        paid-until, the day its billing began (created_at) and A587's kept due date (billing_from), and
--                        web_off — "Disable" for this branch alone. The rules are A584 / A587's, unchanged, per branch
--                        (apps/server/src/lib/branchCloud.ts runs lib/cloudPlan.ts cloudStanding on each row): due day,
--                        7 unpaid days, then the branch is locked — its POS refused everything but sign-in, the technician
--                        and support logs (nothing up, nothing down), and nobody sees its data on the web.
--                        A branch WITHOUT a row follows its business, as before (cloud_plans + web_access_expires_at).
--
--   premium / package    A612 phase 4: the branch's premium features ('analytics', 'attendance', 'themes') and the Premium
--                        package (owner, 2026-10-30: KES 15,000 a branch a month covers the Cloud and every premium item).
--                        The business's own flags (feature_flags) stay ZapTill's master switch; a branch has a feature when
--                        the business has it AND the branch pays for it (premium, or the package).
--
--   invoices.branch_ids, invoices.lines, cloud_payments.branch_ids   A612 phase 3: ONE invoice per business (to the
--                        owner) for the branches due that day — which branches, and its items (Item / Qty / Unit price /
--                        Amount, owner, 2026-10-30); a payment records the branches it paid for. NULL: a business billed
--                        as one, as before.
--
--   The fill (decision 7: "each branch inherits"): every branch of a business on the plan (a cloud_plans row) gets a row with
--   the business's paid-until, period, amount, currency, billing_from and its plan's created_at — so nobody is locked or
--   billed differently by this migration. Branches of businesses with no plan get no row (they follow their business).
--
-- RLS on: the business's owner may read its own branches' rows (its billing); writes go through the server (service role).
-- Reversible: DROP TABLE public.branch_cloud_plans.

CREATE TABLE IF NOT EXISTS public.branch_cloud_plans (
  branch_id     uuid          PRIMARY KEY REFERENCES public.branches(id) ON DELETE CASCADE,
  business_id   uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  period        text          NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly', '3_months', '6_months', '12_months', 'custom')),
  amount        numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency      text          NOT NULL DEFAULT 'KES' CHECK (char_length(currency) BETWEEN 3 AND 10),
  custom_until  timestamptz   NULL,
  paid_until    timestamptz   NULL,
  billing_from  timestamptz   NULL,
  web_off       boolean       NOT NULL DEFAULT false,
  premium       text[]        NOT NULL DEFAULT '{}' CHECK (premium <@ ARRAY['analytics', 'attendance', 'themes']::text[]),
  package       boolean       NOT NULL DEFAULT false,
  notes         text          NULL CHECK (notes IS NULL OR char_length(notes) <= 500),
  updated_by    text          NULL CHECK (updated_by IS NULL OR char_length(updated_by) <= 200),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.branch_cloud_plans IS
  'A612: a branch''s cloud plan - period, amount, paid-until, billing start, web_off. Locked (past its 7 unpaid days, or web_off): its POS refused (nothing up, nothing down) and its data hidden from every user. A branch with no row follows its business (cloud_plans).';
CREATE INDEX IF NOT EXISTS branch_cloud_plans_business_idx ON public.branch_cloud_plans (business_id);

DROP TRIGGER IF EXISTS branch_cloud_plans_set_updated_at ON public.branch_cloud_plans;
CREATE TRIGGER branch_cloud_plans_set_updated_at BEFORE UPDATE ON public.branch_cloud_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The fill: each branch inherits its business's plan (created_at kept: the day billing began).
INSERT INTO public.branch_cloud_plans (branch_id, business_id, period, amount, currency, custom_until, paid_until, billing_from, created_at, updated_by)
SELECT br.id, br.business_id, p.period, p.amount, p.currency, p.custom_until, b.web_access_expires_at, p.billing_from, p.created_at, 'migration 182'
FROM public.branches br
JOIN public.cloud_plans p ON p.business_id = br.business_id
JOIN public.businesses b ON b.id = br.business_id
ON CONFLICT (branch_id) DO NOTHING;

-- A612 phase 3: which branches an invoice and a payment are for, and the invoice's items.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS branch_ids uuid[] NULL;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS lines jsonb NULL;
ALTER TABLE public.cloud_payments ADD COLUMN IF NOT EXISTS branch_ids uuid[] NULL;
COMMENT ON COLUMN public.invoices.branch_ids IS 'A612: the branches this cloud invoice bills (NULL: the business as one).';
COMMENT ON COLUMN public.invoices.lines IS 'A612: the invoice''s items [{description, detail, qty, unit_price, amount}] and branches [{branch_id, name, items}].';
COMMENT ON COLUMN public.cloud_payments.branch_ids IS 'A612: the branches this payment paid for (NULL: the business as one).';

-- A612 phase 4: a branch's premium (Themes on its POS) is part of what a POS pulls — a change moves the business's
-- catalogue version (migration 150's trigger), so its POS sees it on the next check, as a feature flag change does.
DO $a612$
BEGIN
  IF to_regprocedure('public.bump_sync_version(text)') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_sync_version_catalogue ON public.branch_cloud_plans;
    CREATE TRIGGER trg_sync_version_catalogue AFTER INSERT OR UPDATE OR DELETE ON public.branch_cloud_plans
      FOR EACH ROW EXECUTE FUNCTION public.bump_sync_version('catalogue');
  END IF;
END $a612$;

ALTER TABLE public.branch_cloud_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branch_cloud_plans_owner_reads ON public.branch_cloud_plans;
CREATE POLICY branch_cloud_plans_owner_reads ON public.branch_cloud_plans FOR SELECT
  USING (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()));

DO $$ BEGIN
  REVOKE ALL ON public.branch_cloud_plans FROM anon;
EXCEPTION WHEN others THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('182_branch_cloud_plans', 'A612: branch_cloud_plans (the cloud billed per branch; each branch inherits its business''s plan and paid-until)')
ON CONFLICT (version) DO NOTHING;
