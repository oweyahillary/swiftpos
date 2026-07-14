-- ─────────────────────────────────────────────────────────────────────────────
-- SwiftPOS Admin Portal — Database Migration
-- Creates the admin_users table for internal SwiftPOS team accounts.
-- Completely separate from public.users (business staff).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_users (
  id              uuid        NOT NULL DEFAULT uuid_generate_v4(),
  email           text        NOT NULL,
  name            text        NOT NULL,
  password_hash   text        NOT NULL,
  role            text        NOT NULL DEFAULT 'agent'
                  CHECK (role IN ('super_admin', 'agent')),
  is_active       boolean     NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_users_pkey   PRIMARY KEY (id),
  CONSTRAINT admin_users_email  UNIQUE (email)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Admin audit log — separate from the per-business audit_log table.
-- Tracks every action taken by SwiftPOS team members in the admin portal.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id              uuid        NOT NULL DEFAULT uuid_generate_v4(),
  admin_id        uuid,                               -- FK → admin_users (nullable for system actions)
  admin_email     text,                               -- snapshot at event time
  action          text        NOT NULL,               -- e.g. 'business.suspend', 'feature.toggle'
  resource        text,                               -- 'business', 'subscription', 'invoice', etc.
  business_id     uuid,                               -- FK → businesses (nullable for non-business actions)
  business_name   text,                               -- snapshot at event time
  before_data     jsonb,
  after_data      jsonb,
  reason          text,
  ip_address      text,
  event_time      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id),
  CONSTRAINT admin_audit_log_admin_fkey FOREIGN KEY (admin_id) REFERENCES public.admin_users(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Support notes — lightweight internal notes per business client.
-- Not a full ticket system — just a running log per client.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_client_notes (
  id              uuid        NOT NULL DEFAULT uuid_generate_v4(),
  business_id     uuid        NOT NULL,
  admin_id        uuid        NOT NULL,
  admin_name      text        NOT NULL,
  body            text        NOT NULL,
  pinned          boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_client_notes_pkey         PRIMARY KEY (id),
  CONSTRAINT admin_client_notes_business_fk  FOREIGN KEY (business_id) REFERENCES public.businesses(id),
  CONSTRAINT admin_client_notes_admin_fk     FOREIGN KEY (admin_id)    REFERENCES public.admin_users(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: default super admin account.
-- Password hash below is a seed placeholder. Rotate immediately via the
-- reset-admin script with ADMIN_PASSWORD set; never rely on a shipped default.
-- CHANGE THIS ON FIRST LOGIN via Settings → Change Password.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.admin_users (email, name, password_hash, role)
VALUES (
  'admin@swiftpos.co.ke',
  'SwiftPOS Admin',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/Lewm8mCWhBiQF7zO2',
  'super_admin'
)
ON CONFLICT (email) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_business  ON public.admin_audit_log (business_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin     ON public.admin_audit_log (admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_time      ON public.admin_audit_log (event_time DESC);
CREATE INDEX IF NOT EXISTS idx_admin_client_notes_biz    ON public.admin_client_notes (business_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Branch desktop licence columns
-- Tracks which branches have a paid desktop licence.
-- Multiple devices in the same branch are all covered by one licence.
-- A new branch = a new one-off fee.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS desktop_licensed       boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS desktop_licensed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS desktop_licensed_by    text;       -- admin email snapshot

CREATE INDEX IF NOT EXISTS idx_branches_desktop_licensed
  ON public.branches (business_id, desktop_licensed);
