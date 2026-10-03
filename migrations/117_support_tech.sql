-- Migration 117 — 0.6.35 (A384): a shop's own tech — whose number its Help shows (2026-10-03)
--
-- Owner, 2026-10-03: "add the number 0717675635 or 0782972023. Also add the feature in admin where i can allocate a tech
-- to a shop and the number appears instead of a fixed number".
--
-- public.admin_users.phone — a SwiftPOS team member's number ("07XXXXXXXX"/"01XXXXXXXX"), shown to the shops they look
--   after. NULL = none.
-- public.businesses.support_admin_id — the team member (tech) allocated to the client. NULL = none → the till's and the
--   web's Help show SwiftPOS support's numbers (shared/support.ts). A tech removed from the team frees the client.
--
-- Additive and idempotent.

ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS phone text;

DO $$ BEGIN
  ALTER TABLE public.admin_users
    ADD CONSTRAINT admin_users_phone_format CHECK (phone IS NULL OR phone ~ '^0[17][0-9]{8}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.admin_users.phone IS
  '117: the team member''s phone (07XXXXXXXX / 01XXXXXXXX) — shown on the Help of the clients they are allocated to.';

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS support_admin_id uuid REFERENCES public.admin_users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.businesses.support_admin_id IS
  '117: the SwiftPOS tech allocated to this client — their name and phone appear on the till''s and the web''s Help. NULL = SwiftPOS support.';

CREATE INDEX IF NOT EXISTS businesses_support_admin
  ON public.businesses (support_admin_id) WHERE support_admin_id IS NOT NULL;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('117_support_tech', '0.6.35: admin_users.phone + businesses.support_admin_id — a shop''s own tech on its Help')
ON CONFLICT (version) DO NOTHING;
