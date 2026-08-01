-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 49 — Stock transfer control (audit H11)
--
-- POST /api/stock/transfers had no permission gate, no branch-access check, and
-- wrote status:'received' at creation while applying both the stock-out and the
-- stock-in immediately. The four-state machine the schema already declares —
-- pending / in_transit / received / cancelled — was never used. PATCH
-- /transfers/:id/status accepted any transition from any state, from anyone,
-- and reversed nothing on 'cancelled'.
--
-- So: one person holding a POS PIN could move any quantity between any two
-- branches instantly and self-approved; then cancel the transfer, leaving the
-- stock moved and the record saying it was cancelled. That is the standard way
-- to cover a shrinkage hole before a stock count, and it left no trace.
--
-- ── WHAT THIS MIGRATION ADDS ────────────────────────────────────────────────
-- Only attribution columns and one permission key. The rules themselves live in
-- routes/stock.ts, because they are transition rules rather than shapes and the
-- database cannot see who is asking.
--
--   despatched_by / despatched_at   who sent it, and when stock left the source
--   received_by   / received_at     who confirmed arrival, and when it landed
--   cancelled_by  / cancelled_at    who cancelled, and when
--   cancel_reason                   why — a cancellation with no reason is the
--                                   thing you most want to read about later
--
-- Nullable with no defaults, because a transfer that has not been despatched
-- genuinely has no despatcher, and 'unknown' would be a worse answer than NULL.
--
-- ── SEPARATION OF DUTY IS ENFORCED IN THE ROUTE, NOT HERE ───────────────────
-- A CHECK cannot express "received_by must differ from despatched_by" usefully,
-- because on a two-person shop floor there are legitimate exceptions and a hard
-- database constraint would simply stop the shop transferring stock at 6am. The
-- route requires a different user by default and records it plainly when the
-- same person does both, which is auditable rather than obstructive.
--
-- Purely additive. Existing rows keep status 'received' with NULL attribution,
-- which is honest: nobody recorded who despatched or received them.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.stock_transfers
  ADD COLUMN IF NOT EXISTS despatched_by  uuid,
  ADD COLUMN IF NOT EXISTS despatched_at  timestamptz,
  ADD COLUMN IF NOT EXISTS received_by    uuid,
  ADD COLUMN IF NOT EXISTS received_at    timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by   uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at   timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason  text;

COMMENT ON COLUMN public.stock_transfers.despatched_at IS
  'When stock left the source branch. Stock-out is applied at this point, not at creation.';
COMMENT ON COLUMN public.stock_transfers.received_at IS
  'When stock was confirmed at the destination. Stock-in is applied at this point.';
COMMENT ON COLUMN public.stock_transfers.cancel_reason IS
  'Required by the API when cancelling. A cancellation with no reason is the one you most want to read later.';

CREATE INDEX IF NOT EXISTS stock_transfers_status_idx
  ON public.stock_transfers (business_id, status);

-- ─── Permission key ─────────────────────────────────────────────────────────
-- Moving stock between branches is a different act from adjusting it within one,
-- so it gets its own key rather than reusing inventory.adjust. Granted to
-- manager and supervisor by default: transfers are routine shop-floor work, and
-- a permission nobody holds gets granted to everybody within a week.
-- The separation-of-duty rule in the route is what makes that safe.

INSERT INTO permissions (key, label, module, description) VALUES
  ('inventory.transfer', 'Transfer stock between branches', 'inventory',
     'Create, despatch, receive and cancel inter-branch stock transfers')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
CROSS JOIN permissions p
WHERE  p.key = 'inventory.transfer'
  AND  lower(r.name) IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

INSERT INTO public.schema_migrations (version, notes)
VALUES ('49_stock_transfer_control',
        'Audit H11. Attribution columns for despatch/receipt/cancellation on stock_transfers, plus the inventory.transfer permission granted to manager and supervisor. Transition rules and stock reversal are enforced in routes/stock.ts.')
ON CONFLICT (version) DO NOTHING;
