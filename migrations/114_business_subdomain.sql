-- Migration 114 — A378: a client's own sign-in address (2026-10-02)
--
-- Owner, 2026-10-02: "is there a way we can customize each client to use their subdomain eg africanfries … to log in we
-- can even add their logo on the sign in page". public.businesses.subdomain — the first label of the client's sign-in
-- address (africanfries → africanfries.<root domain>). Set by SwiftPOS in the admin portal. On that address the sign-in
-- pages show the client's logo and name, and only the client's own people can sign in. NULL = none (every business
-- before this; they keep signing in on the main address). The format rule lives in shared/tenantHost.ts; the CHECK below
-- is its database half (format only — the reserved names are refused by the cloud).
--
-- Additive and idempotent; no backfill.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS subdomain text;

ALTER TABLE public.businesses DROP CONSTRAINT IF EXISTS businesses_subdomain_format;
ALTER TABLE public.businesses ADD CONSTRAINT businesses_subdomain_format
  CHECK (subdomain IS NULL OR (subdomain ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' AND position('--' in subdomain) = 0));

-- One business per address. The format CHECK already forces lowercase, so a plain unique index is case-safe.
CREATE UNIQUE INDEX IF NOT EXISTS businesses_subdomain_key
  ON public.businesses (subdomain) WHERE subdomain IS NOT NULL;

COMMENT ON COLUMN public.businesses.subdomain IS
  'A378: the client''s sign-in address label (africanfries → africanfries.<root>); set in the admin portal. NULL = none. '
  'Sign-in on that address shows the client''s logo and admits only the client''s people (shared/tenantHost.ts).';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('114_business_subdomain', 'A378: businesses.subdomain — a client''s own sign-in address (logo, sign-in locked to that business)')
ON CONFLICT (version) DO NOTHING;
