-- Migration 191 — mpesa_queried_at: the STK Push Query recovery guard (ask Safaricom the real outcome of a pending prompt)
--
-- A lost or late STK callback used to leave a customer who PAID marked unpaid: GET /api/mpesa/status assumes "failed" after
-- 70 s (STK_TIMEOUT_MS). Now, before that, the server asks Safaricom directly (Daraja STK Push Query — lib/stkQuery.ts) and
-- settles on the real result. mpesa_queried_at records when it last asked, so an ATOMIC conditional update lets exactly one
-- poll query per ~20 s (Daraja rate-limits the query) — never on every 3 s poll.
--
--   payments.mpesa_queried_at            a web order's STK prompt
--   mpesa_stk_requests.mpesa_queried_at  a desktop POS's STK prompt (A607, migration 181)
--
-- Additive: no existing row changes (NULL = never queried). Run this BEFORE the server deploy so the recovery query has its
-- column; either order is safe anyway — without the column the fire-and-forget query errors and is caught (logged), and the
-- unchanged 70 s fallback still concludes the prompt, so nothing regresses.
-- Reversible: ALTER TABLE public.payments DROP COLUMN mpesa_queried_at;
--             ALTER TABLE public.mpesa_stk_requests DROP COLUMN mpesa_queried_at;
--             DELETE FROM public.schema_migrations WHERE version = '191_mpesa_queried_at'.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS mpesa_queried_at timestamptz;

ALTER TABLE public.mpesa_stk_requests
  ADD COLUMN IF NOT EXISTS mpesa_queried_at timestamptz;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('191_mpesa_queried_at', 'STK Push Query recovery: mpesa_queried_at on payments + mpesa_stk_requests — one query per ~20s, so a lost callback no longer marks a paid prompt failed')
ON CONFLICT (version) DO NOTHING;
