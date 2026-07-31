-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 46 — Glovo as a payment method
--
-- payments_method_check admits only cash, mpesa, card and credit, so a Glovo
-- payment is rejected outright: the order fails to sync and sits in the queue
-- with a constraint violation nobody can read from the till.
--
-- ── WHY THIS IS A PAYMENT METHOD, NOT AN ORDER TYPE ─────────────────────────
-- Both are true and they are separate facts. A Glovo order is a DELIVERY (order
-- type) that is SETTLED BY GLOVO (payment method). The reference report from the
-- previous system printed "Type: Glovo" and lost the second half, which is why
-- its collection breakup could not tell aggregator money from cash.
--
-- ── THE PART THAT MATTERS FOR CASH ──────────────────────────────────────────
-- Glovo money NEVER reaches the drawer. Glovo collects from the customer and
-- settles later, so a Glovo sale must not raise expected cash any more than a
-- card sale does.
--
-- Nothing here needs changing for that: computeExpectedCash and the till's
-- computeZReport both filter on method = 'cash' specifically rather than
-- excluding a list. So a new method is correctly ignored by cash reconciliation
-- the moment it exists — the drawer is unaffected and no cashier is reported
-- short for a Glovo order.
--
-- That is worth stating because the opposite design — "everything except card
-- and mpesa is cash" — would have silently counted Glovo into the drawer and
-- produced a shortage equal to the day's Glovo takings.
--
-- Purely additive: it widens a CHECK. No existing row can become invalid.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_method_check
  CHECK ((method)::text = ANY (ARRAY[
    ('cash'::character varying)::text,
    ('mpesa'::character varying)::text,
    ('card'::character varying)::text,
    ('credit'::character varying)::text,
    -- Delivery aggregator. Settled to the business later, never in the drawer.
    ('glovo'::character varying)::text
  ]));

COMMENT ON COLUMN public.payments.method IS
  'cash | mpesa | card | credit | glovo. Only cash counts toward drawer reconciliation.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('46_payment_method_glovo',
        'payments_method_check widened to admit glovo. Additive; cash reconciliation is unaffected because it filters on method=cash specifically.')
ON CONFLICT (version) DO NOTHING;
