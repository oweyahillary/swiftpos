import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { POS_FEATURE_KEYS } from '@zaptill/core/posFeatures';

/**
 * Audit 2026-10-14: the feature switches a client may flip themselves. EVERY other key is set by ZapTill in the admin portal
 * (ADMIN_ONLY_FEATURE). This used to be a deny-list of the POS keys only, so a settings.manage holder could switch on the
 * paid features (web_hosting, themes, loyalty_enabled, ...) with one PUT. Today no client screen writes a flag here — eTIMS
 * has its own route (PUT /api/etims/config) — so the list is empty; add a key only for a switch that is free and the
 * client's own to make.
 */
export const CLIENT_SETTABLE_FLAGS: readonly string[] = [];

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

// PUT /api/flags/:key — enable or disable a flag (settings.business; A490: owners set POS options at /api/controls)
router.put('/:key', requireAuth, requirePermission('settings.business'), async (req, res) => {
  const { enabled } = req.body;

  // 0.6.27: the POS switches are set per client in the admin portal only (owner's decision) — never by the client.
  if ((POS_FEATURE_KEYS as readonly string[]).includes(req.params.key)) {
    res.status(403).json({ error: 'This setting is managed by ZapTill support.', code: 'ADMIN_ONLY_FEATURE' });
    return;
  }
  // Audit 2026-10-14: and so is every other key not on the allow-list (web_hosting, themes, ...).
  if (!CLIENT_SETTABLE_FLAGS.includes(req.params.key)) {
    res.status(403).json({ error: 'This setting is managed by ZapTill support.', code: 'ADMIN_ONLY_FEATURE' });
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
