-- 178_branch_credit.sql — A595, owner decision D4 (2026-10-27): credit limits with branches.
--
-- The owner's ceiling (business setting credit_max_limit), the partners' switch (credit_partner_branches) and each branch's
-- "sells on account" switch (branch setting credit_enabled — absent = on, as before) are settings: no schema. This adds:
--   * customers.credit_limit_locked / _locked_by / _locked_at — the OWNER locked this customer's limit (only the owner
--     changes it, or its branch limits);
--   * customer_branch_credit_limits — what a customer may owe AT one branch (a partner's, or the owner's), who set it and
--     when. A sale on account at that branch is checked against it (what they owe there); without one, the business-wide
--     limit against everything owed (today's rule).
-- Idempotent. Nothing changes for any business until someone sets a ceiling, a lock, a branch switch or a branch limit.
--
-- To see beforehand (read-only): nothing exists yet; afterwards —
--   SELECT b.name, c.name, br.name, l.credit_limit, l.set_by_name, l.set_at FROM public.customer_branch_credit_limits l
--     JOIN public.customers c ON c.id = l.customer_id JOIN public.branches br ON br.id = l.branch_id
--     JOIN public.businesses b ON b.id = l.business_id ORDER BY 1, 2, 3;

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS credit_limit_locked boolean NOT NULL DEFAULT false;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS credit_limit_locked_by uuid NULL;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS credit_limit_locked_at timestamptz NULL;
COMMENT ON COLUMN public.customers.credit_limit_locked IS 'A595 D4: the owner locked this customer''s credit limit - only the owner changes it (and its branch limits).';

CREATE TABLE IF NOT EXISTS public.customer_branch_credit_limits (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  customer_id   uuid          NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  branch_id     uuid          NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  credit_limit  numeric(12,2) NOT NULL CHECK (credit_limit >= 0),
  set_by        uuid          NULL REFERENCES public.users(id) ON DELETE SET NULL,
  set_by_name   text          NULL CHECK (set_by_name IS NULL OR char_length(set_by_name) <= 120),
  set_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT customer_branch_credit_limits_one UNIQUE (customer_id, branch_id)
);
COMMENT ON TABLE public.customer_branch_credit_limits IS
  'A595 D4: what a customer may owe at one branch (set by the owner, or a partner at their own branch when the owner allows) - who and when.';
CREATE INDEX IF NOT EXISTS customer_branch_credit_limits_branch ON public.customer_branch_credit_limits (business_id, branch_id);

ALTER TABLE public.customer_branch_credit_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_branch_credit_limits_business_member ON public.customer_branch_credit_limits;
CREATE POLICY customer_branch_credit_limits_business_member ON public.customer_branch_credit_limits
  USING (business_id IN (SELECT u.business_id FROM public.users u WHERE u.id = auth.uid()));
DO $$ BEGIN
  REVOKE ALL ON public.customer_branch_credit_limits FROM anon;
  GRANT SELECT ON public.customer_branch_credit_limits TO authenticated;
  GRANT ALL ON public.customer_branch_credit_limits TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('178_branch_credit', 'A595 D4: locked credit limits and per-branch customer credit limits (the ceiling, partners'' switch and branch credit switch are settings).')
ON CONFLICT (version) DO NOTHING;
