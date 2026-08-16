-- =============================================================================
-- 84_refresh_token_replaced_by.sql
--
-- Adds `replaced_by` to refresh_tokens for chain-based refresh-token reuse
-- detection (register A88 / D13).
--
-- The D13 crash window: /refresh revokes the consumed token before the till
-- persists the new one; a lost response left the till holding a revoked token,
-- and the old reuse check then revoked EVERY session "for security" — a dropped
-- packet logged the owner out. `replaced_by` links a consumed token to its
-- replacement so the server can tell a LOST RESPONSE (successor still the live
-- head → reissue) from a genuine REPLAY (successor already rotated, or no
-- successor → revoke session). Time-independent, so it survives a power cut.
--
-- Additive and idempotent: a nullable column, no backfill. Existing rows have
-- replaced_by = NULL, which reads as "revoked by logout / no rotation successor"
-- → the pre-migration behaviour (treat as replay) for any token already revoked.
--
-- REVERT:  ALTER TABLE public.refresh_tokens DROP COLUMN IF EXISTS replaced_by;
--
-- public.-qualified for search_path safety (A62).
-- =============================================================================

ALTER TABLE public.refresh_tokens
  ADD COLUMN IF NOT EXISTS replaced_by uuid;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('84_refresh_token_replaced_by',
        'A88 / D13. Adds refresh_tokens.replaced_by (nullable uuid) so /refresh can link a consumed token to its replacement and distinguish a lost rotation response (reissue) from a genuine replay (revoke session), replacing the blanket all-sessions revoke that logged owners out of the till on a dropped packet. Additive, idempotent (ADD COLUMN IF NOT EXISTS), no backfill.')
ON CONFLICT (version) DO NOTHING;
