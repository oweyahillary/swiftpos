-- 192_user_devices_server_bind.sql
-- Branch-server bind: an owner kill-switch (disabled) + away-from-branch-server telemetry.
--
-- WHY
--   A tablet enrols to a BRANCH (tillSession.joinWithCode; the bind is branch-level,
--   not business-wide) and, when that branch runs a server, its sales consolidate
--   THROUGH that server on the LAN (branchGateway.ts). But that routing is a
--   preference, not a lock: if the server is not reachable the tablet silently falls
--   back to its own cloud and keeps selling. So a tablet carried to another, unpaid
--   branch "just works" there — the implementation fee for that branch is escaped,
--   and nothing in the cloud can see it, because the tablet still reports ITS OWN
--   branch_id (checkDeviceBranch / deviceBinding.ts therefore passes — that check is
--   about a CLAIMED branch, this is about PHYSICAL location).
--
--   This migration backs two things that turn that silent fallback into something
--   the owner sees and can act on:
--     1. away_* — the tablet reports, on a cadence, whether its own branch server is
--        on the LAN ('home'), absent ('away_no_server'), or a foreign server is seen
--        instead ('away_foreign'). Telemetry only; the tablet keeps selling.
--     2. disabled_at / disabled_by — the owner's reversible kill-switch. When set,
--        tillBlockReason returns 'disabled' and every request from that tablet is
--        refused (403 DEVICE_DISABLED); clearing it brings the tablet straight back.
--
-- WHY SEPARATE COLUMNS (not a new `status` value) — same reasoning as 97_user_devices_retire:
--   status is an ACCESS state (pending/approved/rejected) the approve/reject/revoke
--   guards branch on, and retired_at is "the machine is gone, keep its history".
--   A kill-switch is neither: it is a live, approved device the owner has paused.
--   A nullable disabled_at (+ who) is additive, reversible (enable = set NULL), and
--   leaves every existing path (isDeviceGrantable, the retire filter, the fleet
--   not-syncing count) untouched. Schema-qualified per A62.
--
-- Additive + nullable + idempotent (ADD COLUMN IF NOT EXISTS), no backfill: every
-- existing device has NULLs — not disabled, no away-state known — and stays live.
-- Reversible:
--   ALTER TABLE public.user_devices
--     DROP COLUMN disabled_at, DROP COLUMN disabled_by,
--     DROP COLUMN away_state, DROP COLUMN away_since,
--     DROP COLUMN away_last_at, DROP COLUMN away_seen;
--   DELETE FROM public.schema_migrations WHERE version = '192_user_devices_server_bind';

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS disabled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_by  uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS away_state   text,
  ADD COLUMN IF NOT EXISTS away_since   timestamptz,
  ADD COLUMN IF NOT EXISTS away_last_at timestamptz,
  ADD COLUMN IF NOT EXISTS away_seen    jsonb;

COMMENT ON COLUMN public.user_devices.disabled_at IS
  'Branch-server bind: when an owner paused (kill-switched) this tablet. NULL = live. A disabled device is refused every request (tillBlockReason = disabled, 403 DEVICE_DISABLED); clearing it restores the device without re-enrolment. Distinct from retired_at (decommission) and status (access).';
COMMENT ON COLUMN public.user_devices.away_state IS
  'Branch-server bind: the tablet''s last self-report of its branch server on the LAN — home | away_no_server | away_foreign. NULL = never reported / not bound to a server. Telemetry only; the tablet keeps selling regardless.';
COMMENT ON COLUMN public.user_devices.away_since IS
  'Branch-server bind: when away_state last became non-home (cleared when it returns home). The "operating away since" the owner sees.';
COMMENT ON COLUMN public.user_devices.away_last_at IS
  'Branch-server bind: when the tablet last reported its presence (any state). Staleness of away_state.';
COMMENT ON COLUMN public.user_devices.away_seen IS
  'Branch-server bind: what the tablet last saw on the LAN when away — { business, server } names from the beacon — so the cloud can say where it likely is. NULL when home or never away.';

-- Owner-facing lookups scan the live fleet for the few disabled or away tablets.
-- Partial indexes keep those scans off the full device table (most devices are
-- NULL on both). Mirrors the retire migration's partial-index choice.
CREATE INDEX IF NOT EXISTS user_devices_disabled_idx
  ON public.user_devices (business_id)
  WHERE disabled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_devices_away_idx
  ON public.user_devices (business_id)
  WHERE away_state IS NOT NULL AND away_state <> 'home';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('192_user_devices_server_bind',
        'Branch-server bind. Adds user_devices.disabled_at + disabled_by (reversible owner kill-switch → tillBlockReason disabled / 403 DEVICE_DISABLED) and away_state/away_since/away_last_at/away_seen (tablet reports whether its branch server is on the LAN; telemetry only, keeps selling). All nullable, additive, idempotent, no backfill. Wiring (tillBlockReason, /pos/server-presence, /devices/:id/disable+enable, fleet fields, FleetPage badge+toggle, Android serverPresence + AwayNotice + sell-gate) ships AFTER this is applied and schema-index.json is refreshed from live.')
ON CONFLICT (version) DO NOTHING;
