// day-close.ts — A275: cloud relay for REMOTE day close (Option i).
// ─────────────────────────────────────────────────────────────────────────────
// The faithful remote form of branchClose.ts: a manager who is off-site queues a
// close_day instruction here; the till pulls it on its normal cloud sync, runs
// executeCloseDay() LOCALLY (computing its own expected cash + variance), and
// acks. The till stays the cash authority — the cloud never does cash arithmetic
// and never writes a business_days close directly (closes flow up, never down).
//
// Two audiences:
//   • Manager (requireAnyPermission shifts.force_close | settings.manage):
//       POST /instruct   — queue a close for a till (one live per till per day)
//       GET  /overview   — open trading days + latest instruction, for the screen
//   • Till (requireAuth + X-Device-Id, same as /api/sync):
//       GET  /pending    — collect this till's pending instructions (marks delivered)
//       POST /ack        — record this till's verdict, retiring the instruction

import { requireAnyPermission } from '../middleware/rbac';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

const MANAGER = requireAnyPermission('shifts.force_close', 'settings.manage');

// Same normalisation as sync.ts / terminalKey.ts — a duplicated header arrives
// comma-joined, and device_id is the hard key.
function deviceIdOf(req: any): string {
  return String(req.header('X-Device-Id') ?? '').split(',')[0].trim().slice(0, 64);
}

// ── Manager: queue a close for one till ──────────────────────────────────────
// Body: { device_id, business_date, counted_cash, notes?, closed_by_name? }
router.post('/instruct', MANAGER, async (req: any, res) => {
  const deviceId     = String(req.body?.device_id ?? '').trim();
  const businessDate = String(req.body?.business_date ?? '').trim();
  const countedCash  = Number(req.body?.counted_cash);
  const notes        = typeof req.body?.notes === 'string' ? req.body.notes.trim() : undefined;
  const closedByName = typeof req.body?.closed_by_name === 'string' ? req.body.closed_by_name.trim() : null;
  const branchId     = req.body?.branch_id ?? null;

  if (!deviceId)                 { res.status(400).json({ error: 'device_id is required' }); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) { res.status(400).json({ error: 'business_date must be YYYY-MM-DD' }); return; }
  if (!Number.isFinite(countedCash) || countedCash < 0) { res.status(400).json({ error: 'counted_cash must be 0 or more' }); return; }

  // The payload the till will hand straight to executeCloseDay(). business_date
  // is included so the till REFUSES a date mismatch rather than closing the
  // wrong day (branchClose.ts).
  const payload = {
    business_date: businessDate,
    counted_cash:  countedCash,
    notes,
    closed_by_staff_id: req.userId ?? null,
    closed_by_name:     closedByName,
  };

  // Replace any still-pending close for this till+day rather than stacking them
  // (mirrors createCloseInstruction). Then insert the new one.
  const del = await supabase
    .from('day_close_instructions')
    .delete()
    .eq('business_id', req.businessId)
    .eq('device_id', deviceId)
    .eq('business_date', businessDate)
    .eq('status', 'pending');
  if (del.error) { sendError(res, del.error); return; }

  const { data, error } = await supabase
    .from('day_close_instructions')
    .insert({
      business_id:   req.businessId,
      branch_id:     branchId,
      device_id:     deviceId,
      business_date: businessDate,
      payload,
      status:        'pending',
      created_by:    req.userId ?? null,
    })
    .select('id, device_id, business_date, status, created_at')
    .single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

// ── Till: collect this device's pending instructions ─────────────────────────
router.get('/pending', async (req: any, res) => {
  const deviceId = deviceIdOf(req);
  if (!deviceId) { res.json([]); return; }

  const { data, error } = await supabase
    .from('day_close_instructions')
    .select('id, payload')
    .eq('business_id', req.businessId)
    .eq('device_id', deviceId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { sendError(res, error); return; }

  const rows = data ?? [];
  if (rows.length) {
    // Visibility for the manager screen; status stays 'pending' until an ack.
    const ids = rows.map((r: any) => r.id);
    await supabase
      .from('day_close_instructions')
      .update({ delivered_at: new Date().toISOString() })
      .in('id', ids)
      .is('delivered_at', null);
  }
  res.json(rows.map((r: any) => ({ id: r.id, kind: 'close_day', payload: r.payload })));
});

// ── Till: record a verdict, retiring the instruction ─────────────────────────
// Body: { instruction_id, ok, error?, summary? }
router.post('/ack', async (req: any, res) => {
  const deviceId      = deviceIdOf(req);
  const instructionId = String(req.body?.instruction_id ?? '').trim();
  const ok            = req.body?.ok === true;
  if (!deviceId)      { res.status(400).json({ error: 'device identity required' }); return; }
  if (!instructionId) { res.status(400).json({ error: 'instruction_id is required' }); return; }

  const ack = { ok, error: req.body?.error ?? null, summary: req.body?.summary ?? null };
  const { data, error } = await supabase
    .from('day_close_instructions')
    .update({ status: ok ? 'acked' : 'failed', ack, acked_at: new Date().toISOString() })
    .eq('id', instructionId)
    .eq('business_id', req.businessId)
    .eq('device_id', deviceId)          // a till can only ack its OWN instruction
    .eq('status', 'pending')
    .select('id, status')
    .maybeSingle();
  if (error) { sendError(res, error); return; }
  res.json(data ?? { id: instructionId, status: ok ? 'acked' : 'failed' });
});

// ── Manager: the screen — open trading days + latest instruction per till ────
router.get('/overview', MANAGER, async (req: any, res) => {
  const branchId = String(req.query.branch_id ?? '').trim();

  let daysQ = supabase
    .from('business_days')
    .select('device_id, business_date, branch_id, status, opened_at')
    .eq('business_id', req.businessId)
    .eq('status', 'open');
  if (branchId) daysQ = daysQ.eq('branch_id', branchId);
  const { data: days, error: daysErr } = await daysQ;
  if (daysErr) { sendError(res, daysErr); return; }

  const deviceIds = [...new Set((days ?? []).map((d: any) => d.device_id).filter(Boolean))];

  // Device labels (best-effort).
  const labelByDevice: Record<string, string> = {};
  if (deviceIds.length) {
    const { data: devs } = await supabase
      .from('user_devices')
      .select('device_id, device_label, terminal_code')
      .eq('business_id', req.businessId)
      .in('device_id', deviceIds);
    (devs ?? []).forEach((d: any) => {
      labelByDevice[d.device_id] = d.terminal_code
        ? `${d.terminal_code}${d.device_label ? ` — ${d.device_label}` : ''}`
        : (d.device_label ?? d.device_id);
    });
  }

  // Latest instruction per device (any status), so the screen shows progress.
  const latestByDevice: Record<string, any> = {};
  if (deviceIds.length) {
    const { data: ins } = await supabase
      .from('day_close_instructions')
      .select('id, device_id, business_date, status, created_at, delivered_at, acked_at, ack')
      .eq('business_id', req.businessId)
      .in('device_id', deviceIds)
      .order('created_at', { ascending: false });
    for (const row of ins ?? []) {
      if (!latestByDevice[row.device_id]) latestByDevice[row.device_id] = row;
    }
  }

  const tills = (days ?? []).map((d: any) => ({
    device_id:     d.device_id,
    label:         labelByDevice[d.device_id] ?? d.device_id,
    business_date: d.business_date,
    opened_at:     d.opened_at,
    instruction:   latestByDevice[d.device_id] ?? null,
  }));
  res.json({ branch_id: branchId || null, tills });
});

export default router;
