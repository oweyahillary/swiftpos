import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/push
// Idempotent upsert (BY ID) of records created OFFLINE on a desktop terminal:
// shifts, float_transactions, expenses. The client generates the UUIDs, so:
//   • orders.shift_id / float.shift_id / expense.shift_id resolve once the parent
//     shift is here (the client pushes shifts before its orders);
//   • a re-push after a lost response UPDATES in place instead of duplicating.
//
// Tenant safety: `business_id` is forced from the caller's token on every row
// that carries it, and we refuse to upsert onto an id that already belongs to a
// DIFFERENT business (a client must not be able to overwrite another tenant's
// row by guessing its id). Floats (no business_id column) are validated through
// their parent shift's ownership.
//
// Note: desktop tooling does not create expenses yet; that arm is here for
// forward-compatibility and is a no-op until a till-side expense flow exists.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/push', async (req, res) => {
  const businessId = req.businessId;
  const shifts   = Array.isArray(req.body?.shifts)   ? req.body.shifts   : [];
  const floats   = Array.isArray(req.body?.floats)   ? req.body.floats   : [];
  const expenses = Array.isArray(req.body?.expenses) ? req.body.expenses : [];

  const upserted = { shifts: 0, floats: 0, expenses: 0 };

  try {
    // ── Shifts (parent — upsert FIRST so child FKs resolve) ──────────────────
    // Audit C6: this endpoint used to trust the client's expected_cash /
    // cash_variance / status='closed' outright — an offline till could report
    // any numbers it liked with no server check. It can't safely compute the
    // real figures here either: shifts push BEFORE their orders (see file
    // header), so this shift's cash payments usually don't exist server-side
    // yet. So this endpoint now only ever writes OPEN-shift fields. The actual
    // close — and the server-computed expected_cash/cash_variance — happens
    // through the existing POST /:id/close (same formula the online till
    // already uses), called by the sync engine once this shift's orders have
    // synced. See syncEngine.ts's reconcileClosedShifts().
    if (shifts.length) {
      const ids = shifts.map((s: any) => s.id);
      const { data: existing } = await supabase
        .from('shifts').select('id, business_id, status').in('id', ids);
      if ((existing ?? []).some(r => r.business_id !== businessId)) {
        res.status(409).json({ error: 'shift id belongs to another business' });
        return;
      }

      // A shift the server already closed (via /:id/close) must never be
      // reopened by a stale/retried push — just leave it alone.
      const alreadyClosed = new Set((existing ?? []).filter(r => r.status === 'closed').map(r => r.id));

      const rows = shifts
        .filter((s: any) => !alreadyClosed.has(s.id))
        .map((s: any) => ({
          id:            s.id,
          business_id:   businessId,                 // forced from token, not the client
          branch_id:     s.branch_id,
          cashier_id:    s.cashier_id,
          opened_at:     s.opened_at,
          status:        'open',                      // never trust a client-reported close
          opening_float: Number(s.opening_float) || 0,
          updated_at:    new Date().toISOString(),
        }));
      if (rows.length) {
        const { error } = await supabase.from('shifts').upsert(rows, { onConflict: 'id' });
        if (error) { sendError(res, error); return; }
      }
      upserted.shifts = shifts.length; // report all as received, incl. already-closed ones
    }

    // ── Float movements — must reference a shift owned by this business, and
    //    must not overwrite a float that currently belongs to another business.
    if (floats.length) {
      const incomingShiftIds = [...new Set(floats.map((f: any) => f.shift_id))];
      const { data: ownedShifts } = await supabase
        .from('shifts').select('id').eq('business_id', businessId).in('id', incomingShiftIds);
      const ownedShiftSet = new Set((ownedShifts ?? []).map(s => s.id));

      const floatIds = floats.map((f: any) => f.id);
      const { data: existingFloats } = await supabase
        .from('float_transactions')
        .select('id, shifts!inner(business_id)')
        .in('id', floatIds);
      if ((existingFloats ?? []).some((r: any) => r.shifts?.business_id !== businessId)) {
        res.status(409).json({ error: 'float id belongs to another business' });
        return;
      }

      const rows = floats
        .filter((f: any) => ownedShiftSet.has(f.shift_id))
        .map((f: any) => ({
          id:         f.id,
          shift_id:   f.shift_id,
          branch_id:  f.branch_id,
          cashier_id: f.cashier_id,
          type:       f.type,
          amount:     Number(f.amount),
          reason:     f.reason ?? null,
          created_at: f.created_at,
        }));
      if (rows.length) {
        const { error } = await supabase.from('float_transactions').upsert(rows, { onConflict: 'id' });
        if (error) { sendError(res, error); return; }
      }
      upserted.floats = rows.length;
    }

    // ── Expenses (business-scoped) ───────────────────────────────────────────
    if (expenses.length) {
      const ids = expenses.map((e: any) => e.id);
      const { data: existing } = await supabase
        .from('expenses').select('id, business_id').in('id', ids);
      if ((existing ?? []).some(r => r.business_id !== businessId)) {
        res.status(409).json({ error: 'expense id belongs to another business' });
        return;
      }

      const rows = expenses.map((e: any) => ({
        id:                  e.id,
        business_id:         businessId,           // forced from token
        branch_id:           e.branch_id,
        expense_category_id: e.expense_category_id ?? null,
        description:         e.description,
        amount:              Number(e.amount),
        paid_by:             e.paid_by ?? null,
        expense_date:        e.expense_date,
        shift_id:            e.shift_id ?? null,
      }));
      const { error } = await supabase.from('expenses').upsert(rows, { onConflict: 'id' });
      if (error) { sendError(res, error); return; }
      upserted.expenses = rows.length;
    }

    res.json({ ok: true, upserted });
  } catch (err: any) {
    sendError(res, err, { message: 'sync push failed' });
  }
});

export default router;
