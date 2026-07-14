import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, assertBranchAccess, branchScope } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { registerBranch } from '../lib/etims';
import { processPending } from '../lib/etims/queue';

const router = safeRouter();
router.use(requireAuth);

// GET /api/etims/config?branch_id=  — current eTIMS config + enabled flag
router.get('/config', requirePermission('settings.manage'), async (req, res) => {
  const branchId = branchScope(req) || req.branchId;
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { data: config } = await supabase
    .from('etims_branch_config')
    .select('branch_id, environment, mode, bhf_id, device_serial, sdc_id, status, registered_at')
    .eq('branch_id', branchId).maybeSingle();

  const { data: flag } = await supabase
    .from('feature_flags').select('enabled')
    .eq('business_id', req.businessId).eq('key', 'etims_enabled').maybeSingle();

  const { data: biz } = await supabase
    .from('businesses').select('tax_pin, etims_onboarded').eq('id', req.businessId).single();

  // cmc_key is intentionally never returned.
  res.json({ enabled: !!flag?.enabled, taxPin: biz?.tax_pin ?? null, onboarded: !!biz?.etims_onboarded, config: config ?? null });
});

// PUT /api/etims/config — upsert per-branch config + per-business enabled flag.
// Body: { branch_id, enabled?, environment?, mode?, bhf_id?, device_serial? }
router.put('/config', requirePermission('settings.manage'), async (req, res) => {
  const { branch_id, enabled, environment, mode, bhf_id, device_serial } = req.body;
  if (!branch_id) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branch_id)) { res.status(403).json({ error: 'Forbidden' }); return; }

  if (environment && !['sandbox', 'production'].includes(environment)) {
    res.status(400).json({ error: "environment must be 'sandbox' or 'production'" }); return;
  }
  if (mode && !['vscu', 'oscu'].includes(mode)) {
    res.status(400).json({ error: "mode must be 'vscu' or 'oscu'" }); return;
  }

  // Per-business enabled flag (feature_flags has no unique constraint → guard).
  if (enabled !== undefined) {
    const { data: existing } = await supabase
      .from('feature_flags').select('id')
      .eq('business_id', req.businessId).eq('key', 'etims_enabled').maybeSingle();
    if (existing) {
      await supabase.from('feature_flags').update({ enabled: !!enabled, updated_at: new Date().toISOString() }).eq('id', existing.id);
    } else {
      await supabase.from('feature_flags').insert({ business_id: req.businessId, key: 'etims_enabled', enabled: !!enabled });
    }
  }

  // Per-branch config upsert (no transmission here — registration is separate).
  const { data: cfg } = await supabase
    .from('etims_branch_config').select('id').eq('branch_id', branch_id).maybeSingle();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (environment   !== undefined) patch.environment   = environment;
  if (mode          !== undefined) patch.mode          = mode;
  if (bhf_id        !== undefined) patch.bhf_id        = bhf_id;
  if (device_serial !== undefined) patch.device_serial = device_serial;

  if (cfg) {
    await supabase.from('etims_branch_config').update(patch).eq('id', cfg.id);
  } else {
    await supabase.from('etims_branch_config').insert({
      business_id: req.businessId, branch_id, ...patch,
    });
  }

  res.json({ ok: true });
});

// GET /api/etims/order/:orderId — fiscal record for one order (for the receipt).
// Returns the signed sale row if present; 204 if none yet.
router.get('/order/:orderId', async (req, res) => {
  const { data: order } = await supabase
    .from('orders').select('business_id').eq('id', req.params.orderId).single();
  if (!order || order.business_id !== req.businessId) { res.status(404).json({ error: 'Not found' }); return; }

  const { data } = await supabase
    .from('etims_invoices')
    .select('status, kra_receipt_no, kra_internal_data, kra_signature, qr_payload')
    .eq('order_id', req.params.orderId).eq('invoice_type', 'sale')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  if (!data || data.status !== 'signed') { res.status(204).send(); return; }
  res.json({
    receiptNo: data.kra_receipt_no, internalData: data.kra_internal_data,
    signature: data.kra_signature, qrPayload: data.qr_payload,
  });
});

// GET /api/etims/status?branch_id=  — fiscalisation health for a branch
// Counts by status so the dashboard can surface pending/failed invoices.
router.get('/status', async (req, res) => {
  const branchId = branchScope(req) || req.branchId;
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { data: config } = await supabase
    .from('etims_branch_config').select('status, environment, mode, registered_at')
    .eq('branch_id', branchId).maybeSingle();

  const { data: rows } = await supabase
    .from('etims_invoices').select('status')
    .eq('branch_id', branchId);

  const counts: Record<string, number> = {};
  (rows ?? []).forEach((r: any) => { counts[r.status] = (counts[r.status] ?? 0) + 1; });

  res.json({ config: config ?? null, counts });
});

// GET /api/etims/invoices?branch_id=&status=  — list fiscalisation records
router.get('/invoices', requirePermission('reports.view'), async (req, res) => {
  const branchId = branchScope(req) || req.branchId;
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  let q = supabase
    .from('etims_invoices')
    .select('id, order_id, invoice_type, status, invoice_no, kra_receipt_no, error, created_at, signed_at')
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (req.query.status) q = q.eq('status', req.query.status as string);

  const { data, error } = await q;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// POST /api/etims/branches/:branchId/register — one-time control unit registration
router.post('/branches/:branchId/register', requirePermission('settings.manage'), async (req, res) => {
  const { branchId } = req.params;
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  // Ensure a config row exists (created with sandbox defaults if missing).
  const { data: existing } = await supabase
    .from('etims_branch_config').select('id').eq('branch_id', branchId).maybeSingle();
  if (!existing) {
    await supabase.from('etims_branch_config').insert({
      business_id: req.businessId, branch_id: branchId,
      bhf_id: req.body?.bhf_id ?? null, device_serial: req.body?.device_serial ?? null,
    });
  }

  const result = await registerBranch(branchId);
  if (!result.ok) { res.status(502).json(result); return; }
  res.json(result);
});

// POST /api/etims/retry — reprocess pending/failed fiscalisations (owner-triggered)
router.post('/retry', requirePermission('settings.manage'), async (_req, res) => {
  const result = await processPending();
  res.json(result);
});

export default router;
