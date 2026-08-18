-- =============================================================================
-- 89_payment_method_free_text.sql
--
-- Make the cloud `payments.method` domain match the custom-payment-method design
-- that shipped in A95 (register A128, fixes the reported "bills paid with a custom
-- method don't sync" defect).
--
-- ROOT CAUSE. A95 (migration 86) added per-business custom tenders whose generated
-- `code` (Coop Card -> `coop_card`, Airtel Money -> `airtel_money`, a house account,
-- …) is written straight to `payments.method`. Migration 86's own header states
-- that method is "a free string on the order, never an FK, so nothing breaks either
-- way" — and migration 07 makes the same "free text, no constraint to change" claim
-- for `room_charge`. Both are HALF TRUE: method is not an FK, but it IS
-- CHECK-constrained. `payments_method_check` (baseline `00_baseline.sql`, last
-- widened by `46_payment_method_glovo.sql`) admits ONLY the fixed set
-- cash | mpesa | card | credit | glovo. And the column is `character varying(20)`,
-- while a custom `code` is `varchar(40)`.
--
-- So the atomic order insert (`create_order_atomic`, migration 69) does
-- `INSERT INTO public.payments (... method ...) VALUES (leg->>'method' ...)`, and
-- for any custom-method sale that INSERT fails: 23514 (check violation) for an
-- unknown code, or 22001 (value too long) for a code over 20 chars. The RPC aborts,
-- POST /api/orders returns an error, and the till's sync engine parks the order in
-- `sync_queue` (5 retries -> `failed`). The sale is safe on the till and shows as
-- complete to the cashier; it just never reaches the cloud or dashboard — silent,
-- because the till's LOCAL `payments.method` is plain TEXT with no check. The two
-- schemas disagreed and nothing compared them.
--
-- THE FIX (per the A95 design decision that method is free text):
--   1. Widen `payments.method` to varchar(40) so a full-length custom code fits
--      (matches `payment_methods.code varchar(40)`).
--   2. Drop the fixed-value `payments_method_check`.
--   3. Replace it with a FORMAT check, not a value list — method must match
--      `^[a-z0-9_]{1,40}$`, exactly the shape `toCode()` produces. This is not
--      loosening the gate to admit one value (rule 20): it swaps a wrong-shaped
--      gate (an enum, where the real domain is per-business and dynamic) for a
--      right-shaped one that still rejects empty strings, whitespace, mixed case,
--      and over-length junk. Built-ins (cash/mpesa/card/credit/glovo), room_charge,
--      and every custom code all satisfy it; existing rows are a subset of the old
--      five and validate cleanly, so ADD CONSTRAINT does not fail on live data.
--
-- Cash reconciliation is unaffected: every drawer query filters on method = 'cash'
-- specifically, so widening the domain cannot change a count (same reasoning as
-- migration 46).
--
-- AFTER PROD-MIGRATE: the already-parked sales drain themselves. Each till's
-- `retryFailedOrders()` ("⟳ N failed" button) re-pushes the queued payloads, and
-- because push carries `X-Idempotency-Key: order_id` the resend inserts once and
-- dedups — no duplicates, no data entry.
--
-- Verified against real Postgres (PGlite) before ship: pre-migration coop_card and
-- room_charge -> 23514, a 24-char code -> 22001; post-migration all accepted while
-- '', 'Bad Method', and a 41-char value still rejected. See MANIFEST-2026-08-18-a.md.
--
-- Idempotent: column retype is a no-op if already varchar(40); the constraint swap
-- is guarded by pg_constraint. Reversible (see REVERT), though reverting re-breaks
-- custom-method sync.
--
-- REVERT:
--   ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_format_check;
--   ALTER TABLE public.payments ADD CONSTRAINT payments_method_check
--     CHECK ((method)::text = ANY (ARRAY['cash','mpesa','card','credit','glovo']));
--   -- (column stays varchar(40); narrowing back to (20) would fail on longer codes.)
--
-- public.-qualified for search_path safety (A62).
-- =============================================================================

-- 1. Widen to fit a full custom code (payment_methods.code is varchar(40)).
ALTER TABLE public.payments
  ALTER COLUMN method TYPE varchar(40);

-- 2. Retire the fixed-value check.
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_method_check;

-- 3. Add a format check in its place (guarded so re-running is a no-op).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_method_format_check'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_method_format_check
      CHECK (method ~ '^[a-z0-9_]{1,40}$');
  END IF;
END $$;

COMMENT ON COLUMN public.payments.method IS
  'Payment tender code. Built-ins: cash | mpesa | card | credit | glovo | room_charge. '
  'Plus any per-business custom method code from payment_methods.code (A95). '
  'Format-checked ^[a-z0-9_]{1,40}$, not a fixed list (A128). Only cash counts '
  'toward drawer reconciliation.';
