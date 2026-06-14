import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import bcrypt from 'bcrypt';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();

const BCRYPT_ROUNDS = 12;

// Settings whose values are secrets and must never be stored in clear text.
// When one of these keys is written we bcrypt-hash the value and persist it
// under "<key>_hash" instead. The plaintext key is never stored.
const HASHED_SETTING_KEYS = new Set(['supervisor_pin']);

// GET /api/business
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', req.businessId)
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// GET /api/business/settings
// Returns all key/value settings for this business.
router.get('/settings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('business_settings')
    .select('key, value')
    .eq('business_id', req.businessId)
    .order('key');

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Unwrap jsonb value to plain string for the dashboard.
  // Never expose secret hashes (e.g. supervisor_pin_hash) — a 4-digit PIN
  // behind bcrypt is brute-forceable offline, so the hash is sensitive.
  const flat = (data ?? []).map((row: any) => ({
    key:   row.key,
    value: row.key.endsWith('_hash')
      ? '****'
      : (typeof row.value === 'string' ? row.value : JSON.stringify(row.value)),
  }));

  res.json(flat);
});

// POST /api/business/settings
// Upserts a single key/value pair for this business.
// Body: { key: string, value: string }
router.post('/settings', requireAuth, async (req, res) => {
  const { key, value } = req.body;

  if (!key || value === undefined) {
    res.status(400).json({ error: 'key and value are required' });
    return;
  }

  // ── Secret settings: hash, never store plaintext ──────────────────────────
  // e.g. "supervisor_pin" is written as "supervisor_pin_hash" (bcrypt). The
  // void flow verifies against this hash. We also clear any legacy plaintext
  // row left over from before this change.
  if (HASHED_SETTING_KEYS.has(key)) {
    const raw = String(typeof value === 'string' ? value : JSON.stringify(value)).trim();
    if (!/^\d{4,6}$/.test(raw)) {
      res.status(400).json({ error: 'PIN must be 4–6 digits' });
      return;
    }
    const hash = await bcrypt.hash(raw, BCRYPT_ROUNDS);
    const hashKey = `${key}_hash`;
    const hashJson = JSON.stringify(hash);

    const { data: existingHash } = await supabase
      .from('business_settings')
      .select('id')
      .eq('business_id', req.businessId)
      .eq('key', hashKey)
      .maybeSingle();

    if (existingHash) {
      const { error } = await supabase
        .from('business_settings')
        .update({ value: hashJson, updated_at: new Date().toISOString() })
        .eq('id', existingHash.id);
      if (error) { res.status(500).json({ error: error.message }); return; }
    } else {
      const { error } = await supabase
        .from('business_settings')
        .insert({ business_id: req.businessId, key: hashKey, value: hashJson });
      if (error) { res.status(500).json({ error: error.message }); return; }
    }

    // Remove any legacy plaintext row for this key.
    await supabase
      .from('business_settings')
      .delete()
      .eq('business_id', req.businessId)
      .eq('key', key);

    res.json({ key: hashKey, value: '****' });
    return;
  }

  const jsonValue = typeof value === 'string' ? value : JSON.stringify(value);

  // Check if a row already exists for this business + key
  const { data: existing } = await supabase
    .from('business_settings')
    .select('id')
    .eq('business_id', req.businessId)
    .eq('key', key)
    .maybeSingle();

  if (existing) {
    // Update in place
    const { error } = await supabase
      .from('business_settings')
      .update({ value: jsonValue, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) { res.status(500).json({ error: error.message }); return; }
  } else {
    // Insert new
    const { error } = await supabase
      .from('business_settings')
      .insert({ business_id: req.businessId, key, value: jsonValue });

    if (error) { res.status(500).json({ error: error.message }); return; }
  }

  res.json({ key, value: jsonValue });
});

export default router;
