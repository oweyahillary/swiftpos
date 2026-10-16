-- =============================================================================
-- 136_branch_status_bump_pv.sql — A494: a person's sessions notice when their BRANCHES or their STATUS change
--
-- Migration 13 bumps users.permissions_version when a person's role, their role's grants or their own overrides change,
-- and requireAuth refuses a token whose version is out of date (401 PERMISSIONS_CHANGED → the client renews, and the
-- renewal re-reads who they are). Two changes did not bump it:
--   - user_branches rows added or removed (moved to another branch, or every branch taken away) — a token kept its
--     old branch for the life of its refresh chain;
--   - users.status (deactivated / reactivated) — caught only by the status check, never by the version.
-- Now both bump it. Idempotent (CREATE OR REPLACE; DROP TRIGGER IF EXISTS).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.bump_permissions_version_for_branches()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE public.users SET permissions_version = COALESCE(permissions_version, 1) + 1 WHERE id = NEW.user_id;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    IF TG_OP = 'DELETE' OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
      UPDATE public.users SET permissions_version = COALESCE(permissions_version, 1) + 1 WHERE id = OLD.user_id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_pv_user_branches ON public.user_branches;
CREATE TRIGGER trg_bump_pv_user_branches
  AFTER INSERT OR UPDATE OR DELETE ON public.user_branches
  FOR EACH ROW EXECUTE FUNCTION public.bump_permissions_version_for_branches();

CREATE OR REPLACE FUNCTION public.bump_permissions_version_on_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.permissions_version := COALESCE(NEW.permissions_version, 1) + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_pv_on_status_change ON public.users;
CREATE TRIGGER trg_bump_pv_on_status_change
  BEFORE UPDATE OF status ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.bump_permissions_version_on_status_change();

INSERT INTO public.schema_migrations (version, notes)
VALUES ('136_branch_status_bump_pv',
        'A494: users.permissions_version is bumped when a person''s user_branches rows change and when their status changes, so their tokens renew (and are re-read) at once.')
ON CONFLICT (version) DO NOTHING;
