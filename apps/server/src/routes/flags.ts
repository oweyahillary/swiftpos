import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { POS_FEATURE_KEYS } from '../lib/posFeatures';

const router = safeRouter();

// GET /api/flags — returns all feature flags for this business as { key: boolean }
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('feature_flags')
    .select('key, enabled')
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }

  const flags: Record<string, boolean> = {};
  (data ?? []).forEach((f) => { flags[f.key] = f.enabled; });

  res.json(flags);
});

// PUT /api/flags/:key — enable or disable a flag (owner/settings.manage only)
router.put('/:key', requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const { enabled } = req.body;

  // 0.6.27: the POS switches are set per client in the admin portal only (owner's decision) — never by the client.
  if ((POS_FEATURE_KEYS as readonly string[]).includes(req.params.key)) {
    res.status(403).json({ error: 'This setting is managed by SwiftPOS support.', code: 'ADMIN_ONLY_FEATURE' });
    return;
  }

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }

  const { data, error } = await supabase
    .from('feature_flags')
    .upsert(
      {
        business_id: req.businessId,
        key: req.params.key,
        enabled,
        set_by: req.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'business_id,key' }
    )
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

export default router;
