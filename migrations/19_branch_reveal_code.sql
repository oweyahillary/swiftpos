-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 19 — Per-branch tech reveal code
--
-- The "doorknock" a technician keys in (after long-pressing the logo on the POS)
-- to reveal the tech-token prompt. Per branch, set/regenerated from the admin
-- portal, delivered to a device at activation and checked locally/offline. It
-- only reveals the prompt — the signed, branch-scoped token is the real gate —
-- so it is a low-value secret (8 alphanumeric chars, distinct from staff PINs).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS tech_reveal_code text;

-- Backfill existing branches with a random 8-char code (ambiguous chars removed).
-- New branches get one assigned by the server on creation.
UPDATE public.branches
SET tech_reveal_code = (
  SELECT string_agg(
    substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 30)::int, 1), ''
  )
  FROM generate_series(1, 8)
)
WHERE tech_reveal_code IS NULL;

COMMENT ON COLUMN public.branches.tech_reveal_code IS
  'Reveal code (doorknock) that surfaces the tech-token prompt on the desktop POS for this branch. Low-value: it only reveals the prompt; the signed token is the gate.';

-- ── Tech action audit trail ─────────────────────────────────────────────────
-- who (tech) / where (branch + device) / what (action) / when. The desktop
-- queues entries offline and flushes them when it can reach the server.
CREATE TABLE IF NOT EXISTS public.tech_audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tech_id      text,
  tech_name    text,
  business_id  uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  branch_id    uuid REFERENCES public.branches(id)   ON DELETE SET NULL,
  device_id    text,
  action       text NOT NULL,
  detail       jsonb,
  token_hash   text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tech_audit_branch  ON public.tech_audit_log (branch_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tech_audit_business ON public.tech_audit_log (business_id, occurred_at DESC);
