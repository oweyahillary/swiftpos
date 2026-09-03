-- 97_user_devices_retire.sql
-- A184 Tier 3 — retire / archive a dead terminal.
--
-- The Terminals screen counts decommissioned tills in its "N not syncing" banner
-- and lists reinstalled ghosts as if live. There was no way to retire a dead row:
-- DELETE /api/devices/:id REVOKES access (a security action that removes the row)
-- — the wrong semantic for "this machine is gone; stop alarming, keep its history."
--
-- A nullable retired_at (+ who) rather than a new `status` value: status is an
-- ACCESS state (pending/approved/rejected) and the approve/reject/revoke guards
-- branch on it — overloading it with 'retired' would risk those paths. A separate
-- column is additive, reversible (un-retire = set NULL), and keeps the audit trail.
-- The fleet query filters `retired_at IS NULL`; a retired till drops out of the
-- health view AND the not-syncing count, but its orders/shifts/history are
-- untouched (nothing else references this column). Schema-qualified per A62.
--
-- Additive + nullable + idempotent (ADD COLUMN IF NOT EXISTS), no backfill: every
-- existing device simply has NULL and stays live until an owner retires it.

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by uuid REFERENCES public.users(id);

COMMENT ON COLUMN public.user_devices.retired_at IS
  'A184: when an owner retired this terminal. NULL = live. Retired rows drop out of the fleet health view and the not-syncing banner but keep all their history.';

-- Fast path for the fleet query's `WHERE business_id = $1 AND retired_at IS NULL`.
CREATE INDEX IF NOT EXISTS user_devices_business_live_idx
  ON public.user_devices (business_id)
  WHERE retired_at IS NULL;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('97_user_devices_retire',
        'A184 Tier 3. Adds user_devices.retired_at + retired_by (both nullable) so an owner can retire a dead terminal: it leaves the fleet health view and the not-syncing banner while keeping its history. Additive, idempotent, no backfill. Wiring (fleet retired_at filter, PATCH /:id/retire + /:id/unretire, FleetPage action) ships AFTER this is applied and schema-index.json is refreshed from live.')
ON CONFLICT (version) DO NOTHING;
