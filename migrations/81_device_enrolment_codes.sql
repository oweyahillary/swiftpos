-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 81 — device enrolment codes (register D4, advances D1)
--
-- A till provisions itself today by an OWNER signing in on the device. That is
-- the D1 dead end: the owner's credentials belong to a person, not a terminal,
-- and an owner with two businesses cannot pick which one the till serves. The
-- fix (D4): the business is identified by its id, and a single-use enrolment
-- CODE — issued by the owner in the portal, shown once — authorises the device.
-- The till redeems the code; the server burns it and mints a device-scoped
-- session. Same shape as tech_access_tokens and mode_switch_requests already
-- use for one-time, server-verified secrets.
--
-- This migration adds ONLY the table. The issue/redeem endpoints and the desktop
-- InstallPage change are described in docs/DEVICE-ENROLMENT-D4.md and are the
-- outstanding, owner-verified part of D4 — a token-minting path is not shipped
-- into the tree until it can be tested against a real server (register ethos:
-- an honest gap beats a plausible reconstruction).
--
-- Conventions: fully public.-qualified (A62); IF NOT EXISTS so it is re-runnable;
-- RLS enabled in the same migration so check-rls-coverage passes (the server uses
-- the service_role key, which bypasses RLS — no policy is needed, and anon /
-- authenticated correctly get deny-all on an operational table); schema_migrations
-- row appended; schema-index.json updated in the same change so verify-db-schema
-- does not then report the table as unknown.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.device_enrolment_codes (
  id                 uuid        NOT NULL DEFAULT uuid_generate_v4(),
  business_id        uuid        NOT NULL,                 -- which business the till will serve
  branch_id          uuid,                                 -- optional: bind the till to a branch at enrol time
  code_hash          text        NOT NULL UNIQUE,          -- SHA-256 of the raw code; the raw code is shown ONCE and never stored
  created_by         uuid        NOT NULL,                 -- public.users id of the owner who issued it
  expires_at         timestamptz NOT NULL,                 -- short-lived; a code not redeemed in time is dead
  redeemed_at        timestamptz,                          -- set when burned — single use
  redeemed_device_id text,                                 -- which device consumed it (audit; not a credential)
  status             text        NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','redeemed','expired','revoked')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_enrolment_codes_pkey      PRIMARY KEY (id),
  CONSTRAINT device_enrolment_codes_biz_fk    FOREIGN KEY (business_id) REFERENCES public.businesses(id),
  CONSTRAINT device_enrolment_codes_branch_fk FOREIGN KEY (branch_id)   REFERENCES public.branches(id),
  CONSTRAINT device_enrolment_codes_owner_fk  FOREIGN KEY (created_by)  REFERENCES public.users(id)
);

-- Service role bypasses RLS; enabling it denies anon/authenticated by default,
-- which is correct — enrolment codes are handled entirely server-side.
ALTER TABLE public.device_enrolment_codes ENABLE ROW LEVEL SECURITY;

-- Redeem looks a code up by its hash; the portal lists a business's live codes.
CREATE INDEX IF NOT EXISTS idx_enrol_codes_business ON public.device_enrolment_codes (business_id, status);
CREATE INDEX IF NOT EXISTS idx_enrol_codes_expires  ON public.device_enrolment_codes (expires_at);

INSERT INTO public.schema_migrations (version, notes)
VALUES ('81_device_enrolment_codes',
        'D4. Single-use, business-scoped, expiring device enrolment codes: the owner issues one in the portal (raw shown once, code_hash stored), a till redeems it, the server burns it (redeemed_at / status=redeemed) and mints a device session — no owner login on the terminal. RLS enabled (service_role bypasses). Table only; endpoints + desktop pending, see docs/DEVICE-ENROLMENT-D4.md.')
ON CONFLICT (version) DO NOTHING;
