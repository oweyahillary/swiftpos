-- 137_kds_token_version.sql — A495: a kitchen-display (KDS) token can be revoked.
--
-- A KDS token is a 365-day, branch-scoped display token (routes/kitchen.ts). Nothing could take one back: a screen
-- stolen or a token copied kept reading (and advancing) the branch's tickets for a year. Each branch now carries a
-- version; a token names the version it was minted at and is refused once the branch has moved on. Minting a new token
-- bumps the version, so a new token revokes every older one for that branch.
--
-- Tokens minted before this migration name no version and are read as version 0 — they keep working until the owner
-- mints a new token for that branch (which moves it to 1).

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS kds_version integer NOT NULL DEFAULT 0;

-- Bump one branch's version and hand back the new one, in one statement (two owners minting at once each get their
-- own number; the later token wins).
CREATE OR REPLACE FUNCTION public.bump_kds_version(p_branch uuid, p_business uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.branches
     SET kds_version = kds_version + 1
   WHERE id = p_branch AND business_id = p_business
  RETURNING kds_version;
$$;

REVOKE ALL ON FUNCTION public.bump_kds_version(uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.bump_kds_version(uuid, uuid) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.bump_kds_version(uuid, uuid) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('137_kds_token_version', 'A495: branches.kds_version + bump_kds_version — a new kitchen-display token revokes the older ones for its branch.')
ON CONFLICT (version) DO NOTHING;
