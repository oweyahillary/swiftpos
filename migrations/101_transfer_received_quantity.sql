-- =============================================================================
-- 101_transfer_received_quantity.sql
--
-- A221 — record the quantity ACTUALLY received on a stock transfer, separately
-- from the quantity sent.
--
-- WHY
-- ---
-- Receiving a transfer previously booked the SENT quantity blind. A short
-- shipment (breakage / short pick / loss in transit) silently credited the
-- destination with stock that never arrived. The recipient must be able to key
-- what actually arrived — while the SENT quantity stays untouched as the
-- despatch record, so sent-vs-received is a visible audit trail (owner decision
-- 2026-09-05). A free-text receipt note explains any discrepancy.
--
-- WHAT (additive, idempotent, reversible)
-- ---------------------------------------
--   • stock_transfer_items.quantity_received  numeric(12,3)  (NULL until received)
--   • stock_transfers.receipt_note            text           (NULL unless noted)
--
-- `quantity` on stock_transfer_items is left exactly as-is — it remains the
-- immutable "sent" figure. No backfill: historical transfers keep NULL received
-- (they predate the feature; their stock was already booked at the sent amount).
--
-- ROLLBACK:
--   ALTER TABLE public.stock_transfer_items DROP COLUMN IF EXISTS quantity_received;
--   ALTER TABLE public.stock_transfers      DROP COLUMN IF EXISTS receipt_note;
--   DELETE FROM public.schema_migrations WHERE version = '101_transfer_received_quantity';
-- =============================================================================

ALTER TABLE public.stock_transfer_items
  ADD COLUMN IF NOT EXISTS quantity_received numeric(12,3);

ALTER TABLE public.stock_transfers
  ADD COLUMN IF NOT EXISTS receipt_note text;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('101_transfer_received_quantity',
        'A221 — stock_transfer_items.quantity_received + stock_transfers.receipt_note, so a transfer receipt books the actual arrived quantity while the sent quantity stays as the despatch audit trail. Additive/idempotent.')
ON CONFLICT (version) DO NOTHING;
