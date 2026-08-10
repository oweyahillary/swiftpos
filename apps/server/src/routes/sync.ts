import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { normaliseDeviceRole, isNodeRole } from '../lib/deviceRegistry';
import { confirmServingRole } from '../lib/deviceRole';

import { REQUIRED_DESKTOP_SCHEMA, HARD_MIN_DESKTOP_SCHEMA } from '../lib/desktopSchema';

const router = safeRouter();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/push
// Idempotent upsert (BY ID) of records created OFFLINE on a desktop terminal:
// business_days, shifts, float_transactions, expenses.
//
// ARM ORDER IS LOAD-BEARING — parents before children:
//     business_days  →  shifts  →  floats / expenses      (orders push separately)
// `shifts.business_day_id` references `business_days.id` (migration 41), so a
// shift upserted before its day fails 23503 and, because a non-23505 error
// returns straight away, the day it needed never gets inserted. See the note on
// the trading-days arm before moving anything.
//
// The client generates the UUIDs, so:
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
// Desktop schema expectations live in lib/desktopSchema.ts — shared with
// /api/devices/fleet so the warning and the screen can never disagree.

router.post('/push', async (req, res) => {
  const businessId = req.businessId;
  const shifts   = Array.isArray(req.body?.shifts)   ? req.body.shifts   : [];
  const floats   = Array.isArray(req.body?.floats)   ? req.body.floats   : [];
  const expenses = Array.isArray(req.body?.expenses) ? req.body.expenses : [];
  const businessDays = Array.isArray(req.body?.business_days) ? req.body.business_days : [];

  // 0 = a build predating the header. Treated as ancient rather than trusted.
  const clientSchema = Number(req.header('X-Schema-Version') ?? 0) || 0;
  if (clientSchema && clientSchema < HARD_MIN_DESKTOP_SCHEMA) {
    res.status(426).json({
      error: `This till is running schema ${clientSchema}; this server needs at least ` +
             `${HARD_MIN_DESKTOP_SCHEMA}. Install the current SwiftPOS build on this terminal.`,
      code: 'desktop_upgrade_required',
    });
    return;
  }
  // Fleet telemetry, fire-and-forget.
  //
  // Deliberately NOT awaited and deliberately swallowing its own errors: this is
  // a diagnostic, and a till must never fail to push a day's sales because a
  // statistics column is missing or a telemetry write timed out. If migration 43
  // has not been applied this simply does nothing.
  // A duplicated header arrives JOINED WITH A COMMA. The till sent both
  // 'x-device-id' and 'X-Device-Id' — HTTP names are case-insensitive, so fetch
  // emitted the pair — and the naive `.slice(0, 64)` then chopped the joined
  // value mid-uuid. Observed in production 2026-08-09:
  //
  //   [fleet] no user_devices row for device
  //     24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e
  //
  // `WHERE device_id = ?` can never match that. Fixed on the till, but every
  // till is updated by hand (D3) and one is always behind, so the server takes
  // the first value rather than trusting the client to send one. Slicing AFTER
  // the split, so a legitimate id is never truncated by a duplicate's length.
  const deviceId = String(req.header('X-Device-Id') ?? '').split(',')[0].trim().slice(0, 64);
  if (deviceId) {
    void supabase
      .from('user_devices')
      .update({
        last_sync_at: new Date().toISOString(),
        ...(clientSchema ? { schema_version: clientSchema } : {}),
      })
      .eq('device_id', deviceId)
      .select('id')
      .then(({ data, error }) => {
        if (error) {
          console.warn('[fleet] telemetry not recorded — is migration 43 applied?', error.message);
          return;
        }
        // D14. This used to be silent, and it was the common case: an UPDATE
        // that matches NO ROWS is not an error, so a till with no user_devices
        // row threw its telemetry away and said nothing. The only message that
        // ever appeared blamed migration 43 — which is applied — so the one
        // clue pointed away from the cause, and every diagnosis needed somebody
        // physically at the machine.
        //
        // Registration is now unconditional for desktop (lib/deviceRegistry.ts),
        // so this should not fire. If it does, the till is syncing without ever
        // having signed in through /desktop-login or /verify-pin, which is worth
        // knowing on its own.
        if (!data || data.length === 0) {
          console.warn(
            `[fleet] no user_devices row for device ${deviceId} — telemetry discarded. ` +
            `Migration 43 is not the problem; the terminal has never registered.`,
          );
        }
      });

    // Migration 73 — the reported role, refreshed here as well as at sign-in,
    // because a machine is repurposed BETWEEN sign-ins: a till promoted to node
    // keeps trading on the same staff session, and the server would otherwise
    // carry a stale role until somebody signed out.
    //
    // A SEPARATE statement on purpose. Folding these columns into the update
    // above would couple all fleet telemetry to migration 73: if 73 is not
    // applied the whole statement fails, and `last_sync_at` and
    // `schema_version` are lost along with the role. That is not hypothetical —
    // migrations 68 and 72 are absent from this repository and only 20 of 66
    // migrations record themselves in `schema_migrations` (register A4), so a
    // migration being missing is the normal case here, not the exception.
    //
    // Only written when actually reported, so an older build sending no header
    // does not blank a known role.
    const reportedRole = normaliseDeviceRole(req.header('X-Device-Role'));
    if (reportedRole) {
      void supabase
        .from('user_devices')
        .update({ device_role: reportedRole, role_reported_at: new Date().toISOString() })
        .eq('device_id', deviceId)
        .then(({ error }) => {
          if (error) {
            console.warn(
              `[fleet] device role not recorded for ${deviceId} — is migration 73 applied? ` +
              `Sync telemetry is unaffected.`,
              error.message,
            );
            return;
          }

          // Migration 74 — the claim is recorded; now decide whether to believe
          // it. Only for SERVING roles: a plain till has nothing to confirm.
          //
          // Runs here rather than at sign-in because branch_id is bound on sync
          // (migration 52 binds on first sighting), and a serving role is
          // meaningless without a branch — the uniqueness guarantee is per
          // branch. Confirming before binding would race that.
          //
          // Also fire-and-forget: confirmation withholds CREDENTIALS when it
          // fails, never trade. A machine refused here keeps selling, keeps
          // syncing and keeps serving its own tills over the LAN.
          if (!isNodeRole(reportedRole)) return;
          void confirmServingRole(req.businessId as string, deviceId, reportedRole)
            .then((verdict) => {
              if (!verdict.confirmed && verdict.code === 'conflict') {
                console.warn(
                  `[deviceRole] branch server conflict — ${deviceId} refused; held by ${verdict.heldBy}. ` +
                  `If the previous machine is genuinely gone, authorise a handover.`,
                );
              }
            });
        });
    }
  }

  const schemaStatus = clientSchema < REQUIRED_DESKTOP_SCHEMA
    ? {
        behind: true,
        client: clientSchema,
        required: REQUIRED_DESKTOP_SCHEMA,
        message: `This till is on schema ${clientSchema || 'unknown'}; current is ` +
                 `${REQUIRED_DESKTOP_SCHEMA}. It is still syncing, but install the ` +
                 `latest build when you can.`,
      }
    : { behind: false, client: clientSchema, required: REQUIRED_DESKTOP_SCHEMA };

  const upserted = { shifts: 0, floats: 0, expenses: 0, businessDays: 0 };
  // Rows the database refused for a reason no retry can fix. Returned to the
  // client so it can flag them for a human rather than looping on them.
  // `table` names which table the id belongs to. Without it the client has only
  // an id and a code, and syncEngine applied every rejection to `shifts` —
  // a duplicate_open_day carries a business_days id, so that UPDATE matched
  // nothing and the day was never marked. Older builds simply ignore the field.
  const rejected: { id: string; code: string; table: string; error: string }[] = [];

  try {
    // ── Trading days (parent of shifts — upsert FIRST) ───────────────────────
    // Originated by the till, like shifts. Without this arm a day closed on the
    // terminal never leaves it, so the cloud shows every trading day as open
    // forever and no dashboard report can ever see a reconciled one.
    //
    // Unlike shifts, the close IS trusted from the client here. That is a
    // deliberate difference: a shift's expected_cash cannot be computed
    // server-side at push time because its orders usually have not arrived yet
    // (see the shifts note below), whereas a day's figures are the manager's own
    // physical count plus a sum over shifts the till already holds. There is no
    // server-side alternative to trust — the count only exists at the terminal.
    //
    // ── WHY THIS ARM RUNS FIRST (moved 31 Jul 2026) ─────────────────────────
    // Migration 41 added
    //     shifts.business_day_id REFERENCES business_days(id)
    // which made `shifts` a CHILD of this table. This arm nonetheless ran LAST,
    // after shifts/floats/expenses, so every shift carrying a business_day_id
    // whose day had not yet reached the cloud failed shifts_business_day_id_fkey
    // (23503) — and because any non-23505 error returns immediately, the handler
    // never reached this arm to insert the parent it was missing.
    //
    // That is a closed loop, not a transient failure: the till retried the
    // identical payload every 60s indefinitely, its orders failed
    // orders_shift_id_fkey behind the shift that never landed, and the terminal
    // showed a permanent "N failed" that no retry could clear. Observed live on
    // 31 Jul 2026, business_day_id 0d3f3fe2, ~13 minutes of identical 500s.
    //
    // Parents before children. Do not reorder these arms without checking the FK
    // graph in migrations/41_business_days_and_shift_attribution.sql.
    const syncedDayIds = new Set<string>();
    if (businessDays.length) {
      const ids = businessDays.map((d: any) => d.id);
      const { data: existing } = await supabase
        .from('business_days').select('id, business_id').in('id', ids);
      if ((existing ?? []).some((r: any) => r.business_id !== businessId)) {
        res.status(409).json({ error: 'business_day id belongs to another business' });
        return;
      }

      const rows = businessDays.map((d: any) => ({
        id:            d.id,
        business_id:   businessId,                 // forced from token
        branch_id:     d.branch_id,
        device_id:     d.device_id ?? null,
        terminal_code: d.terminal_code ?? null,
        business_date: d.business_date,
        opened_at:     d.opened_at,
        opened_by:     d.opened_by ?? null,
        closed_at:     d.closed_at ?? null,
        closed_by:     d.closed_by ?? null,
        status:        d.status === 'closed' ? 'closed' : 'open',
        // NULL, never 0. A zero variance asserts somebody counted and it
        // balanced; an unclosed day has had no count at all.
        counted_cash:  d.counted_cash ?? null,
        expected_cash: d.expected_cash ?? null,
        cash_variance: d.cash_variance ?? null,
        notes:         d.notes ?? null,
        updated_at:    new Date().toISOString(),
      }));

      // Per-row, for the same reason as shifts: business_days_one_open_per_till
      // can reject a row, and a batch call would take the whole push down with it.
      const results = await Promise.all(
        rows.map(async row => {
          const { error } = await supabase.from('business_days').upsert(row, { onConflict: 'id' });
          return { id: row.id, error };
        }),
      );
      for (const r of results) {
        if (!r.error) { upserted.businessDays++; syncedDayIds.add(r.id); continue; }
        if ((r.error as { code?: string }).code === '23505') {
          rejected.push({
            id: r.id,
            code: 'duplicate_open_day',
            table: 'business_days',
            error: 'This till already has an open trading day. It must be closed before this one can sync.',
          });
          continue;
        }
        sendError(res, r.error);
        return;
      }
    }

    // ── Shifts ───────────────────────────────────────────────────────────────
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

      // ── The parent trading day must exist, or the upsert fails 23503 ────────
      // With the days arm running first, the parent is normally already in
      // `syncedDayIds`. It can still legitimately be absent: a day refused above
      // as duplicate_open_day never landed, and its shifts would then fail the FK
      // and — under the old ordering — 500 the whole push, taking floats,
      // expenses and every other row in the payload down with them.
      //
      // Report them per id instead. `rejected` is the correct bucket and a silent
      // skip is not: syncEngine marks every shift NOT in `rejected` as synced, so
      // a skipped shift would be recorded as delivered and never retried — the
      // drawer would simply disappear from the cloud with nothing reporting it.
      const candidates = shifts.filter((s: any) => !alreadyClosed.has(s.id));
      const neededDayIds: string[] = Array.from(new Set<string>(
        candidates
          .map((s: any) => (typeof s.business_day_id === 'string' ? s.business_day_id : ''))
          .filter((id: string) => id.length > 0),
      ));
      const lookupDayIds = neededDayIds.filter(id => !syncedDayIds.has(id));
      if (lookupDayIds.length) {
        const { data: presentDays } = await supabase
          .from('business_days')
          .select('id')
          .in('id', lookupDayIds)
          .eq('business_id', businessId);
        for (const d of (presentDays ?? []) as { id: string }[]) syncedDayIds.add(d.id);
      }
      const orphanedDayIds = new Set(neededDayIds.filter(id => !syncedDayIds.has(id)));

      const rows = candidates
        .filter((s: any) => {
          if (s.business_day_id && orphanedDayIds.has(s.business_day_id)) {
            rejected.push({
              id: s.id,
              code: 'missing_business_day',
              table: 'shifts',
              error: 'This shift\'s trading day is not on the server — the day was refused ' +
                     'or has not synced yet. Resolve the trading day first.',
            });
            return false;
          }
          return true;
        })
        .map((s: any) => ({
          id:            s.id,
          business_id:   businessId,                 // forced from token, not the client
          branch_id:     s.branch_id,
          cashier_id:    s.cashier_id,
          opened_at:     s.opened_at,
          status:        'open',                      // never trust a client-reported close
          opening_float: Number(s.opening_float) || 0,

          // Attribution. Safe to take from the client because these are facts
          // about the TERMINAL, not about money: which till, which trading day,
          // which physical drawer, who authorised the opening count. None of them
          // can misstate cash, which is why the status/close fields above are
          // still refused while these are trusted.
          //
          // Without them the cloud could not tell one drawer from another —
          // business_days keys its one-open-per-till index on device_id, so three
          // tills reporting NULL collapse to a single key.
          business_day_id: s.business_day_id ?? null,
          business_date:   s.business_date ?? null,
          device_id:       s.device_id ?? null,
          terminal_code:   s.terminal_code ?? null,
          drawer_label:    s.drawer_label ?? null,
          opened_by:       s.opened_by ?? null,

          updated_at:    new Date().toISOString(),
        }));
      if (rows.length) {
        // Per-row, not one batch upsert.
        //
        // A batch call fails entirely if ANY row is rejected — and it would take
        // floats and expenses down with it, because this handler returns on the
        // first error. syncEngine then retries the same payload forever, so a
        // single bad shift stops a till syncing anything at all.
        //
        // The rejection that matters is 23505 from shifts_one_open_per_cashier
        // (migration 42): a cashier already holds an open drawer elsewhere. That
        // is not a transport failure and retrying will never clear it — it needs
        // a manager to close the other shift. So it is reported back per id and
        // the client marks that shift for attention instead of looping.
        //
        // The fast path is preserved: rows are upserted concurrently, so this is
        // one round trip's worth of latency, not one per shift.
        const results = await Promise.all(
          rows.map(async row => {
            const { error } = await supabase.from('shifts').upsert(row, { onConflict: 'id' });
            return { id: row.id, error };
          }),
        );

        for (const r of results) {
          if (!r.error) { upserted.shifts++; continue; }

          if ((r.error as { code?: string }).code === '23505') {
            rejected.push({
              id: r.id,
              code: 'duplicate_open_shift',
              table: 'shifts',
              error: 'This cashier already has an open shift. It must be closed before this one can sync.',
            });
            continue;
          }

          // Anything else is a genuine failure worth surfacing and retrying.
          sendError(res, r.error);
          return;
        }
      }
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

    // `rejected` is deliberately part of a 200, not an error status. These rows
    // were understood and refused on their merits; the push itself succeeded and
    // everything else in it landed. Returning 4xx would make the client retry
    // the whole payload, which is the behaviour this change exists to remove.
    res.json({ ok: true, upserted, rejected, schema: schemaStatus });
  } catch (err: any) {
    sendError(res, err, { message: 'sync push failed' });
  }
});

export default router;
