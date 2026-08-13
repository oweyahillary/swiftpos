import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import bcrypt from 'bcrypt';
import { requireAuth } from '../middleware/auth';
import { requireAnyPermission, hasFullSettingsAccess } from '../middleware/rbac';
import { encryptSecret } from '../lib/crypto';
import { supabase } from '../lib/supabase';

const router = safeRouter();

const BCRYPT_ROUNDS = 12;

// Settings whose values are secrets and must never be stored in clear text.
// When one of these keys is written we bcrypt-hash the value and persist it
// under "<key>_hash" instead. The plaintext key is never stored.
// ── A45: the narrow slice of settings a manager may write ───────────────────
// The free-text blocks printed above and below the receipt body — branch
// address, phone, KRA PIN, thank-you line. ReceiptTextTab writes exactly these
// two keys and nothing else (ipcHandlers.ts:1591-1592, two sequential POSTs),
// so this allow-list is the whole surface that tab needs.
//
// It is an ALLOW-LIST and it must stay one. POST /settings writes ANY key
// through one handler, including supervisor_pin (bcrypt-hashed below) and the
// ENCRYPTED_SETTING_KEYS M-Pesa credentials. A deny-list here would mean every
// setting added in future is writable by a manager until somebody remembers to
// add it — and the thing they would forget is whichever one is newest, which is
// also the one least likely to be noticed.
const RECEIPT_SETTING_KEYS = new Set(['receipt_header', 'receipt_footer']);

const HASHED_SETTING_KEYS = new Set(['supervisor_pin']);

// ── H9: settings encrypted at rest, never a hash (need to be readable back) ─
// consumer_secret and passkey are used directly as Daraja credentials — they
// have to round-trip to plaintext, unlike supervisor_pin, so bcrypt (one-way)
// doesn't apply. encryptSecret()/decryptSecret() (AES-256-GCM, lib/crypto.ts)
// is the same utility already used for the eTIMS cmc_key. mpesa_consumer_key
// and mpesa_shortcode are left plaintext deliberately — they're closer to a
// public identifier (shortcode is printed on the customer's receipt) than a
// secret, matching the audit's own scope.
const ENCRYPTED_SETTING_KEYS = new Set(['mpesa_consumer_secret', 'mpesa_passkey']);

// ── C2: default-deny read allowlist ─────────────────────────────────────────
// GET /settings used to mask only keys ending in "_hash" — everything else,
// including mpesa_consumer_secret / mpesa_passkey / mpesa_consumer_key /
// mpesa_shortcode, came back in clear text to any authenticated user (a
// waiter's 4-digit PIN was enough to read the merchant's M-Pesa credentials).
// Flipped to default-deny: only the keys a dashboard screen actually reads
// back are exposed here; a secret — or any future key nobody remembered to
// hide — is invisible by default instead of exposed by default.
// (M-Pesa credentials get proper encryption-at-rest under H9; this closes
// the read-path leak in the meantime and permanently either way.)
const READABLE_SETTING_KEYS = new Set([
  'require_device_registration', 'restaurant_order_mode',
  'enable_covers', 'enable_course_firing', 'auto_print_kot', 'enable_split_bill',
  'service_charge_pct', 'table_turnover_alert_mins', 'turnover_alert_minutes',
  'period_breakfast', 'period_lunch', 'period_dinner', 'period_allday',
  'fuel_show_litres_dispensed', 'fuel_require_attendant_name', 'fuel_auto_print_receipt', 'fuel_unit_display',
  'hold_requires_pin', 'minimart_catalogue_default', 'scanner_beep', 'weight_unit',
  'default_parking_rate', 'parking_min_hours', 'parking_billing_mode',
  'parking_overstay_hours', 'parking_grace_minutes', 'parking_print_ticket', 'parking_receipt_plate',
  'loyalty_enabled', 'loyalty_earn_rate',
  // Free-text blocks the owner controls, printed above and below the receipt
  // body — address, PIN, phone, thank-you line, social handles. Multi-line;
  // newlines are preserved and rendered as separate lines.
  'receipt_header', 'receipt_footer',
  // Names that must never reach a kitchen ticket — drinks, sauces, packaged
  // sides. A JSON array of strings, or one name per line. Owner-stated rather
  // than inferred from the item name: a keyword guess is wrong occasionally and
  // silently, and the cook is the one who finds out mid-service.
  'kitchen_exclusions',
]);
// Dynamic-suffix key families with no secret ever under them — the suffix is
// per-tenant data (a vehicle type, a delivery platform name), not something
// that can be pre-enumerated.
const READABLE_SETTING_PREFIXES = ['parking_rate_', 'aggregator_commission_'];

function isReadableSettingKey(key: string): boolean {
  return READABLE_SETTING_KEYS.has(key) || READABLE_SETTING_PREFIXES.some(p => key.startsWith(p));
}

// GET /api/business
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', req.businessId)
    .single();

  if (error) {
    sendError(res, error);
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

  if (error) { sendError(res, error); return; }

  // Default-deny (audit C2): only allowlisted keys are ever returned; a
  // secret, a hash, or anything not on the list is simply omitted.
  const flat = (data ?? [])
    .filter((row: any) => isReadableSettingKey(row.key))
    .map((row: any) => ({
      key:   row.key,
      value: typeof row.value === 'string' ? row.value : JSON.stringify(row.value),
    }));

  res.json(flat);
});

// GET /api/business/settings/report-schedule
// The daily-report scheduler config, stored as one JSON blob under the
// `report_schedule` key by POST /settings below. It needs its OWN read route
// because the generic GET /settings is default-deny (audit C2) and this key is
// not on that allow-list. Without this route the dashboard's read
// (`api.get('/api/business/settings/report-schedule')`) hits nothing, its
// `.catch(() => {})` swallows the 404, and the toggle silently reverts to the
// default — "saved" on screen, off on reload (register A54).
router.get('/settings/report-schedule', requireAuth, async (req, res) => {
  const DEFAULT = { enabled: false, send_time: '21:00', recipients: [] as string[] };

  const { data, error } = await supabase
    .from('business_settings')
    .select('value')
    .eq('business_id', req.businessId)
    .eq('key', 'report_schedule')
    .maybeSingle();

  if (error) { sendError(res, error); return; }
  if (!data) { res.json(DEFAULT); return; }

  // POST /settings stores the JSON string the client sent; tolerate a column
  // that hands back already-parsed JSON too, and never let a malformed row throw.
  let parsed: any = DEFAULT;
  try {
    parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
  } catch { parsed = DEFAULT; }

  res.json({ ...DEFAULT, ...(parsed && typeof parsed === 'object' ? parsed : {}) });
});

// POST /api/business/settings
// Upserts a single key/value pair for this business.
// Body: { key: string, value: string }
router.post('/settings', requireAuth, requireAnyPermission('receipt.manage', 'settings.manage'), async (req, res) => {
  const { key, value } = req.body;

  if (!key || value === undefined) {
    res.status(400).json({ error: 'key and value are required' });
    return;
  }

  // ── A45: per-key authorisation, BEFORE any write ───────────────────────────
  // The route gate above admits anyone holding EITHER key, because Express
  // middleware runs before the body is inspected and cannot know which setting
  // is being written. So the narrowing happens here, and it happens FIRST —
  // ahead of the bcrypt branch and ahead of the encrypted branch, because
  // otherwise a caller holding only receipt.manage would reach the code path
  // that writes supervisor_pin_hash or an M-Pesa credential.
  //
  // Fails closed: settings.manage (or owner / wildcard) writes anything, and
  // everyone else writes only what is explicitly allowed.
  if (!hasFullSettingsAccess(req) && !RECEIPT_SETTING_KEYS.has(key)) {
    res.status(403).json({
      error: 'Forbidden',
      // Name the key they tried, not the permission they lack: the caller with
      // receipt.manage is a manager who has just been told "no" on a screen
      // that offered them the field. A45 is what the vaguer message cost.
      detail: `receipt.manage may only write receipt_header and receipt_footer, not "${key}"`,
    });
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
      if (error) { sendError(res, error); return; }
    } else {
      const { error } = await supabase
        .from('business_settings')
        .insert({ business_id: req.businessId, key: hashKey, value: hashJson });
      if (error) { sendError(res, error); return; }
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
  const storedValue = ENCRYPTED_SETTING_KEYS.has(key) ? encryptSecret(jsonValue) : jsonValue;

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
      .update({ value: storedValue, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) { sendError(res, error); return; }
  } else {
    // Insert new
    const { error } = await supabase
      .from('business_settings')
      .insert({ business_id: req.businessId, key, value: storedValue });

    if (error) { sendError(res, error); return; }
  }

  // Never echo a secret back in the write response, encrypted or not.
  res.json({ key, value: ENCRYPTED_SETTING_KEYS.has(key) ? '****' : jsonValue });
});

export default router;
