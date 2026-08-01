-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 50 — orders.sync_status and idempotency_key (audit H14)
--
-- Two faults that only combine into a real one.
--
-- 1. sync_status was written 'pending' in every order-creation path and NOTHING
--    anywhere advanced it. routes/tech.ts builds its sync diagnostics by
--    counting pending / synced / failed, so the support panel reported 100%
--    pending and 0 synced on every install from day one — a number nobody can
--    act on, which gets ignored within a week.
--
-- 2. The LOCAL -> CLOUD mode switch (tech.ts) selects orders WHERE
--    sync_status = 'pending' and hands them to the desktop to push. Since
--    nothing ever left 'pending', that is the branch's ENTIRE order history,
--    every time.
--
--    On its own that would be merely wasteful, because the push is guarded by
--    ON CONFLICT on (business_id, idempotency_key). But that index is PARTIAL:
--
--        WHERE idempotency_key IS NOT NULL
--
--    and NULLs are distinct in Postgres. POST /orders wrote NULL whenever the
--    client omitted a key, and POST /orders/:id/open — the order-first, dine-in
--    path — never set one at all. So every dine-in order was unprotected, and a
--    single mode switch would duplicate all of them and double that branch's
--    reported revenue.
--
-- ── WHY 'synced' IS THE RIGHT VALUE FOR EXISTING ROWS ───────────────────────
-- These rows are IN the cloud database. Whatever sync_status was meant to track,
-- a row that is physically present here has arrived. Leaving them 'pending'
-- keeps the diagnostic broken and keeps the replay armed. Anything genuinely
-- unsynced lives in the till's own SQLite sync_queue, which this does not touch.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Backfill keys BEFORE adding the default and NOT NULL, or the constraint fails
-- on the existing NULLs. The default is added so the column can be NOT NULL
-- without breaking an insert that omits it — the RUNBOOK's standing rule about
-- never adding a NOT NULL column with no default to a table the till pushes.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Give every existing order a key ─────────────────────────────────────
-- The row's own id: already unique, already stable, and if the desktop ever
-- replays one of these the key it presents will match and conflict correctly.
UPDATE public.orders
   SET idempotency_key = id::text
 WHERE idempotency_key IS NULL;

-- ─── 2. Make NULL impossible from here on ───────────────────────────────────
ALTER TABLE public.orders
  ALTER COLUMN idempotency_key SET DEFAULT gen_random_uuid()::text;

ALTER TABLE public.orders
  ALTER COLUMN idempotency_key SET NOT NULL;

COMMENT ON COLUMN public.orders.idempotency_key IS
  'Never null. The unique index on (business_id, idempotency_key) is partial on IS NOT NULL, so a null key is protected by nothing and duplicates freely on replay. Generated server-side when the client omits one.';

-- ─── 3. Retire the permanent-pending state ──────────────────────────────────
UPDATE public.orders
   SET sync_status = 'synced'
 WHERE sync_status = 'pending'
    OR sync_status IS NULL;

-- ─── 4. Report ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  total    integer;
  pending  integer;
  nulls    integer;
BEGIN
  SELECT count(*) INTO total   FROM public.orders;
  SELECT count(*) INTO pending FROM public.orders WHERE sync_status = 'pending';
  SELECT count(*) INTO nulls   FROM public.orders WHERE idempotency_key IS NULL;

  RAISE NOTICE 'migration 50: % orders; % still pending; % without an idempotency key.',
    total, pending, nulls;

  IF nulls > 0 THEN
    RAISE EXCEPTION 'migration 50: % order(s) still have a null idempotency_key — the backfill did not take.', nulls;
  END IF;
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('50_order_sync_status_and_idempotency',
        'Audit H14. Backfilled idempotency_key from id for existing rows, then made it NOT NULL with a gen_random_uuid() default; moved cloud-resident orders off the permanent sync_status=pending that made the tech panel useless and armed the LOCAL->CLOUD switch to replay every order at a branch.')
ON CONFLICT (version) DO NOTHING;
