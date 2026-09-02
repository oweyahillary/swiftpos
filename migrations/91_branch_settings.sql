-- Migration 91 — per-branch settings overrides (A139)
--
-- Franchise branches can override business-wide settings (receipt header/footer,
-- 24-hour operation) with their own value; absence of a row means "inherit the
-- business default". Resolution (branch override → business default) is done
-- server-side in GET /pos/init, so the branch-bound till receives the resolved
-- value and needs no change. Mirrors business_settings (key/value) and follows
-- the branch_prices precedent (business_id + branch_id, ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS public.branch_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id   uuid NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  key         text NOT NULL,
  value       text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- one override row per (branch, key) — the upsert target
  UNIQUE (branch_id, key)
);

CREATE INDEX IF NOT EXISTS branch_settings_branch_idx ON public.branch_settings USING btree (branch_id);

ALTER TABLE public.branch_settings ENABLE ROW LEVEL SECURITY;

-- Same scoping as business_settings.business_owner_settings: a member of the
-- business may see their rows. Writes go through the server (service_role, which
-- bypasses RLS); this is defense-in-depth for any direct PostgREST access.
CREATE POLICY branch_settings_business_member ON public.branch_settings
  USING (business_id IN ( SELECT users.business_id FROM public.users WHERE users.id = auth.uid() ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.branch_settings TO authenticated;
GRANT ALL ON public.branch_settings TO service_role;
