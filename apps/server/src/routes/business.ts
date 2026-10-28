import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requireAnyPermission, requirePermission, can, assertBranchAccess } from '../middleware/rbac';
import { accentWriteError, themeOverrideError, footerWriteError, cleanFooter, normaliseHex,
  FOOTER_LINE_MAX, FOOTER_LINE_NARROW, FOOTER_MAX_LINES, FOOTER_MAX_CHARS } from '../lib/branchBranding';   // A544
import { BRANCH_BRANDING_COLUMNS, type BranchBrandingRow, servedBranchBranding } from '../lib/branchBrandingStore';   // A544, A547
import { effectiveThemeId } from '../lib/themeRules';   // A547
import { encryptSecret } from '../lib/crypto';
import { supabase } from '../lib/supabase';
import { themesEnabled, themeWriteError } from '../lib/themeAccess';
import { isReversalSettingKey, reversalSettingValue } from '../lib/reversalRules';
import { BUSINESS_DAY_CUTOFF_KEY, cutoffSettingValue } from '../lib/businessDay';   // 0.6.34
import { invalidateDayCutoff } from '../lib/dayCutoff';
import { CASHIER_HISTORY_METHODS_KEY, historyMethodsSettingValue } from '../lib/cashierHistory';   // 0.6.37 (A387)
import { PAYMENT_METHODS_ENABLED_KEY, enabledSettingValue } from '../lib/paymentCatalogue';   // A429
import { invalidateHistoryMethods } from '../lib/historyMethods';
import { getSupportContact } from '../lib/supportContact';   // 0.6.35 (A384)
import { STOCK_COUNT_FREEZE_KEY, freezeSetting } from '../lib/stockTakeRules';   // A394
import { cleanReportSchedule } from '../jobs/ownerAlertsDecision';   // A476
import { isOwnerAlertJobKey } from '../jobs/ownerAlerts';             // A476
import { LOSS_SETTINGS_KEY } from '../jobs/lossAlerts';               // A576
import { CREDIT_APPROVERS_KEY } from '../lib/creditApprovers';         // A585
import { PARTNER_SETTING_KEY } from '../lib/webPartners';             // A550
import { CLOUD_TRIAL_KEY, readTrial, trialPhase } from '../lib/cloudTrial';   // A569
import { cleanScaleSettings, SCALE_SETTINGS_KEY } from '../lib/scaleBarcode';   // A577

const router = safeRouter();

// ── A45: the narrow slice of settings a manager may write ───────────────────
// The free-text blocks printed above and below the receipt body — branch
// address, phone, KRA PIN, thank-you line. ReceiptTextTab writes exactly these
// two keys and nothing else (ipcHandlers.ts:1591-1592, two sequential POSTs),
// so this allow-list is the whole surface that tab needs.
//
// It is an ALLOW-LIST and it must stay one. POST /settings writes ANY key
// through one handler, including the ENCRYPTED_SETTING_KEYS M-Pesa credentials (and, until A514 retired it, the
// bcrypt-hashed supervisor_pin). A deny-list here would mean every
// setting added in future is writable by a manager until somebody remembers to
// add it — and the thing they would forget is whichever one is newest, which is
// also the one least likely to be noticed.
const RECEIPT_SETTING_KEYS = new Set(['receipt_header', 'receipt_footer', 'receipt_pay_label', 'receipt_pay_number']);   // A450: + how to pay

/** A490: the keys that write business settings — the route admits any of them, then narrows per setting. */
const SETTING_WRITE_KEYS = ['receipt.manage', 'settings.business', 'settings.payments', 'settings.pos', 'settings.integrations',
  'settings.reversals', 'inventory.count_freeze',   // A502
  'settings.sales_rules', 'settings.report_emails'];   // A595: parts of settings.business / settings.integrations
/**
 * A595 (docs/PERMISSIONS-AUDIT.md F20): the selling rules are their own part of settings.business (settings.sales_rules —
 * migration 176 gave it to every holder): continuous operation and what a cashier's History shows.
 */
const SALES_RULE_KEYS: ReadonlySet<string> = new Set(['continuous_operation', CASHIER_HISTORY_METHODS_KEY, 'cashier_sees_shift_sales', 'cashier_history_totals']);
const LOYALTY_SETTING_KEYS = new Set(['loyalty_enabled', 'loyalty_earn_rate']);

/**
 * A494: the business settings a settings.business holder may write — each one a known option of a settings screen
 * (restaurant, fuel, minimart, parking, kitchen, the business day, what a cashier's History shows, device
 * registration). An ALLOW-LIST: a key nobody listed — a future setting, a typo, or a credential — is the owner's, not
 * settings.business's (it was settings.business, so a manager given "business settings" could write any key at all).
 */
export const BUSINESS_SETTING_KEYS: ReadonlySet<string> = new Set([
  'require_device_registration', 'restaurant_order_mode',
  'enable_covers', 'enable_course_firing', 'auto_print_kot', 'enable_split_bill',
  'service_charge_pct', 'table_turnover_alert_mins', 'turnover_alert_minutes',
  'period_breakfast', 'period_lunch', 'period_dinner', 'period_allday',
  'fuel_show_litres_dispensed', 'fuel_require_attendant_name', 'fuel_auto_print_receipt', 'fuel_unit_display',
  'hold_requires_pin', 'minimart_catalogue_default', 'scanner_beep',   // A580: 'weight_unit' gone (read by nothing; per-item kg / g, A577)
  'default_parking_rate', 'parking_min_hours', 'parking_billing_mode',
  'parking_overstay_hours', 'parking_grace_minutes', 'parking_print_ticket', 'parking_receipt_plate',
  'continuous_operation', BUSINESS_DAY_CUTOFF_KEY, CASHIER_HISTORY_METHODS_KEY,
  'cashier_sees_shift_sales', 'cashier_history_totals', 'kitchen_exclusions', 'order_note_picks',
  SCALE_SETTINGS_KEY,   // A577: how the business's weighing scales print their labels
]);
/** Families of settings.business keys whose suffix is the tenant's own (a vehicle type, a delivery platform). */
const BUSINESS_SETTING_PREFIXES = ['parking_rate_', 'aggregator_commission_'];

/**
 * A494: the owner's alone — every M-Pesa credential and setting
 * (where the business's money goes and the keys that move it) — whatever else a person holds.
 * A502 (owner, 2026-10-15: "yes owner but should be a right a user can be assigned"): the void / refund rules and the
 * stock-count freeze are no longer owner-only — each is its own permission (settings.reversals, inventory.count_freeze)
 * that no role starts with, so they stay the owner's until the owner gives them to someone.
 */
export function ownerOnlySetting(k: string): boolean {
  return ENCRYPTED_SETTING_KEYS.has(k) || k.startsWith('mpesa_');
}

/**
 * A514 (owner, 2026-10-16, on the business-wide supervisor PIN: "Retire it completely"): only people's own PINs approve
 * now — their sign-in PIN, or the approval PIN an owner or a manager gives them in Staff. The cloud never accepts a write
 * of the business PIN again (supervisor_pin, its hash key, or any spelling of either), from anyone — the owner included.
 * The hash already stored is left as it is; nothing reads it.
 */
export function isRetiredSupervisorPinKey(k: string): boolean {
  return /^supervisor_pin/i.test(String(k ?? '').trim());
}
export const SUPERVISOR_PIN_RETIRED = {
  error: 'The business supervisor PIN is retired. Each approver uses their own PIN - their sign-in PIN approves; the owner or a manager can set a separate approval PIN in Staff.',
  code:  'SUPERVISOR_PIN_RETIRED',
} as const;

/**
 * A595 (owner, 2026-10-27, decision D3: "report emails — owner and partners can set them; managers cannot"): who may read
 * and set the Report Scheduler (who receives the automatic e-mails) — the owner, a partner (web dashboard access,
 * lib/webPartners.ts), or someone the owner gave settings.report_emails in Staff. Migration 177 takes the key off every
 * role (a manager's role no longer opens it); a person's own grant is kept.
 */
export function mayReportEmails(req: import('express').Request): boolean {
  if (req.isTill) return false;
  return req.isOwner === true || req.webPartner === true || can(req, 'settings.report_emails');
}
const REPORT_EMAILS_REFUSED = { error: 'Only the owner or a partner chooses who receives the report e-mails.', code: 'REPORT_EMAILS_OWNER', detail: 'Missing permission: settings.report_emails' } as const;

/** A490: the one key that may write this business setting — null when it is the OWNER's alone (A494). */
export function settingPermission(key: string): string | null {
  if (ownerOnlySetting(key)) return null;
  if (isReversalSettingKey(key)) return 'settings.reversals';          // A502
  if (key === STOCK_COUNT_FREEZE_KEY) return 'inventory.count_freeze';  // A502
  if (RECEIPT_SETTING_KEYS.has(key)) return 'receipt.manage';
  if (key === PAYMENT_METHODS_ENABLED_KEY) return 'settings.payments';
  if (LOYALTY_SETTING_KEYS.has(key)) return 'settings.pos';
  // A595 (F3): scheduled report e-mails send the business's figures to any address — their own part of
  // settings.integrations (settings.report_emails).
  if (key === 'report_schedule') return 'settings.report_emails';
  if (SALES_RULE_KEYS.has(key)) return 'settings.sales_rules';   // A595 (F20)
  if (BUSINESS_SETTING_KEYS.has(key) || BUSINESS_SETTING_PREFIXES.some((p) => key.startsWith(p))) return 'settings.business';
  return null;   // A494: unknown — the owner's (default-deny, as GET /settings is)
}

// ── H9: settings encrypted at rest, never a hash (need to be readable back) ─
// consumer_secret and passkey are used directly as Daraja credentials — they
// have to round-trip to plaintext, unlike a PIN, so bcrypt (one-way)
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
  'hold_requires_pin', 'minimart_catalogue_default', 'scanner_beep',   // A580: 'weight_unit' gone (read by nothing; per-item kg / g, A577)
  'default_parking_rate', 'parking_min_hours', 'parking_billing_mode',
  'parking_overstay_hours', 'parking_grace_minutes', 'parking_print_ticket', 'parking_receipt_plate',
  'loyalty_enabled', 'loyalty_earn_rate',
  // Free-text blocks the owner controls, printed above and below the receipt
  // body — address, PIN, phone, thank-you line, social handles. Multi-line;
  // newlines are preserved and rendered as separate lines.
  'receipt_header', 'receipt_footer',
  // A450: how a customer pays by M-Pesa, printed under the payments: a label ("Buy Goods", "Paybill", "Till No.") and the number.
  'receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account',
  // 24-hour operation: a business that never closes overnight (A104).
  'continuous_operation',
  // 0.6.34: when the business day ends ("HH:MM", 00:00–06:00) — a bar trading past midnight (lib/businessDay.ts).
  'business_day_cutoff',
  // 0.6.37 (A387): the payment methods a cashier's History shows (a JSON list; [] = every method).
  'cashier_history_methods',
  // A429: the payment methods switched on (a JSON list of catalogue codes; absent = the defaults).
  'payment_methods_enabled',
  // A416: a cashier closing a shift sees their sales ("true"); off by default (lib/cashierShiftSales.ts).
  'cashier_sees_shift_sales',
  // A418: a cashier's History shows the total of what is filtered ("true"); only while cashier_sees_shift_sales is on.
  'cashier_history_totals',
  // A394: is an item being counted frozen (not sold until counted)? The owner's choice — "true" / "false".
  'stock_count_freeze',
  // Names that must never reach a kitchen ticket — drinks, sauces, packaged
  // sides. A JSON array of strings, or one name per line. Owner-stated rather
  // than inferred from the item name: a keyword guess is wrong occasionally and
  // silently, and the cook is the one who finds out mid-service.
  'kitchen_exclusions',
  // A367: the owner's quick picks for order notes ("No salt", "Extra cheese") — a JSON array of strings.
  'order_note_picks',
  // A577: the scale label layout (shared/scaleBarcode.ts) — the settings screen shows and tests it.
  SCALE_SETTINGS_KEY,
  // 0.6.30 (A336 stage 3): the owner's void window and offline void/refund rules (lib/reversalRules.ts).
  'void_window_minutes', 'offline_refund_methods', 'offline_reverse_web_sales', 'delivery_free_allowed',
  // A505: saved (a REVERSAL_SETTING_KEYS key) but never read back — the Voids, refunds & delivery screen showed the
  // free-delivery amount empty after a reload, and saving the screen again could clear it.
  'delivery_free_over',
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

// PATCH /api/business — owner-editable business profile (A134).
// The business record is otherwise admin-only; an owner with settings access may
// edit their own profile here. Guardrails: the whitelist below is the ONLY set of
// fields this route will touch (owner login email, owner_id, type, status, plan
// dates etc. stay admin-controlled); currency is locked once any sale exists,
// because historical amounts are denominated in it; `email` here is the business
// CONTACT email, not a login credential.
router.patch('/', requireAuth, requireAnyPermission('settings.business', 'settings.tax'), async (req, res) => {
  const EDITABLE = ['name', 'address', 'phone', 'email', 'tax_pin', 'vat_rate', 'ctl_rate', 'currency', 'logo_url'] as const;
  const updates: Record<string, unknown> = {};
  for (const k of EDITABLE) if (k in req.body) updates[k] = req.body[k];
  // A595 (docs/PERMISSIONS-AUDIT.md F20): the VAT and levy rates are their own part of settings.business (settings.tax —
  // migration 176 gave it to every holder); the rest of the profile stays settings.business.
  const TAX_FIELDS = ['vat_rate', 'ctl_rate'];
  const wantsTax = Object.keys(updates).some((k) => TAX_FIELDS.includes(k));
  const wantsProfile = Object.keys(updates).some((k) => !TAX_FIELDS.includes(k));
  if (wantsTax && !can(req, 'settings.tax')) { res.status(403).json({ error: 'Forbidden', detail: 'Missing permission: settings.tax' }); return; }
  if (wantsProfile && !can(req, 'settings.business')) { res.status(403).json({ error: 'Forbidden', detail: 'Missing permission: settings.business' }); return; }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No editable fields provided' });
    return;
  }
  if ('name' in updates && !String(updates.name ?? '').trim()) {
    res.status(400).json({ error: 'Business name is required' });
    return;
  }
  if ('vat_rate' in updates) {
    const v = Number(updates.vat_rate);
    if (Number.isNaN(v) || v < 0 || v > 100) {
      res.status(400).json({ error: 'VAT rate must be between 0 and 100' });
      return;
    }
    updates.vat_rate = v;
  }
  if ('ctl_rate' in updates) {
    const v = Number(updates.ctl_rate);
    if (Number.isNaN(v) || v < 0 || v > 100) {
      res.status(400).json({ error: 'CTL rate must be between 0 and 100' });
      return;
    }
    updates.ctl_rate = v;   // A277: Catering/Tourism Levy — same net as VAT; drives the receipt CTL line
  }
  if ('currency' in updates) {
    const { data: current } = await supabase
      .from('businesses').select('currency').eq('id', req.businessId).single();
    if (current && updates.currency !== current.currency) {
      const { count } = await supabase
        .from('orders').select('id', { count: 'exact', head: true }).eq('business_id', req.businessId);
      if ((count ?? 0) > 0) {
        res.status(400).json({ error: 'Currency cannot be changed once you have recorded sales' });
        return;
      }
    }
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('businesses').update(updates).eq('id', req.businessId).select().single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

// GET /api/business/support — 0.6.35 (A384): who this shop calls — its tech (admin portal), or null (SwiftPOS support).
// Any signed-in member: the web's Help page shows it. A575: and the business type (a shop's Help page leaves out the
// kitchen-ticket step; shared/helpTopics.ts helpTopicsFor).
router.get('/support', requireAuth, async (req, res) => {
  const [support, { data: biz }] = await Promise.all([
    getSupportContact(req.businessId),
    supabase.from('businesses').select('type').eq('id', req.businessId).maybeSingle(),
  ]);
  res.json({ support, businessType: (biz as { type?: string | null } | null)?.type ?? null });
});

// GET /api/business/cloud-trial — A569: the owner's cloud trial, for the dashboard's quiet notice in its last 7 days
// (components/CloudTrialNotice.tsx). The owner only — a partner or a cashier gets { trial: null } (the notice is not
// theirs). { trial: { ends_at, phase } | null }; phase is lib/cloudTrial.ts trialPhase.
router.get('/cloud-trial', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.isOwner || req.isTill || req.webPartner === true) { res.json({ trial: null }); return; }
  let trial;
  try { trial = await readTrial(req.businessId); }
  catch (e) { sendError(res, e); return; }
  // A584 (owner: "no warning for web"): the paid plan has no notice on the dashboard — the client gets the invoice by
  // email on the due day, nothing counts down. `plan` stays in the answer, always null, for dashboards built for A581.
  res.json({ trial: trial ? { ends_at: trial.ends_at, phase: trialPhase(trial) } : null, plan: null });
});

// GET /api/business/branding
// The client branding row (accent + logo) for this business, or null when unset (A303).
// Any authenticated member may read it — the till reads it via /pos/init; this is the portal's read.
router.get('/branding', requireAuth, async (req, res) => {
  const [{ data, error }, enabled] = await Promise.all([
    supabase
      .from('business_branding')
      .select('accent_hex, logo_png, logo_receipt, receipt_logo_enabled, theme_id, updated_at')
      .eq('business_id', req.businessId)
      .maybeSingle(),
    themesEnabled(req.businessId),   // A325: the web shows the theme picker only when the business has themes
  ]);
  if (error) { sendError(res, error); return; }
  // Shape kept for existing callers: the row (or null) — plus themes_enabled, which is not a column.
  res.json(data ? { ...data, themes_enabled: enabled } : (enabled ? { themes_enabled: true } : null));
});

// PUT /api/business/branding
// Upsert the client branding row (A303). Gated like other business settings. Validation
// mirrors the desktop guard (brandingGuard) at the persist boundary — never trust the client
// (the SVG-upload research: a direct request skips any browser check): accent must be a hex
// colour; a logo must be a PNG/JPEG base64 data-URI under 250 KB; SVG is rejected until the
// sanitiser slice. Omitted field = leave as-is; explicit null = clear.
router.put('/branding', requireAuth, requireAnyPermission('receipt.manage', 'settings.business'), async (req, res) => {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
  const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const RASTER = /^data:image\/(?:png|jpeg);base64,/i;
  const MAX_LOGO_BYTES = 250 * 1024;

  const row: Record<string, unknown> = { business_id: req.businessId, updated_at: new Date().toISOString() };

  if (has('accent_hex')) {
    const a = req.body.accent_hex;
    if (a !== null) {
      if (typeof a !== 'string' || !HEX.test(a.trim())) {
        res.status(400).json({ error: 'accent_hex must be a #RGB or #RRGGBB hex colour' });
        return;
      }
      row.accent_hex = a.trim().toLowerCase();
    } else { row.accent_hex = null; }
  }

  if (has('logo_png')) {
    const l = req.body.logo_png;
    if (l !== null) {
      if (typeof l !== 'string') { res.status(400).json({ error: 'logo_png must be a data-URI string' }); return; }
      if (/^data:image\/svg\+xml/i.test(l)) {
        res.status(400).json({ error: 'SVG logos are not accepted yet — upload a PNG or JPEG' });
        return;
      }
      if (!RASTER.test(l)) { res.status(400).json({ error: 'logo_png must be a data:image/png or data:image/jpeg base64 data-URI' }); return; }
      const b64 = l.slice(l.indexOf(',') + 1);
      const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
      const bytes = Math.floor((b64.length * 3) / 4) - pad;
      if (bytes > MAX_LOGO_BYTES) { res.status(400).json({ error: `logo is ${(bytes / 1024).toFixed(0)} KB; the cap is 250 KB` }); return; }
      row.logo_png = l;
    } else { row.logo_png = null; }
  }

  // A311: the receipt raster. Shape-checked here (mirrors shared/printing raster.ts's decoder — the
  // cloud (apps/server) does not depend on that package, same precedent as the HEX/RASTER regexes
  // above mirroring brandingGuard): prefix, integer dims, width within an 80 mm head, and the
  // base64 payload EXACTLY ceil(w/8)*h bytes. A wrong length is what desyncs a printer's parser.
  if (has('logo_receipt')) {
    const v = req.body.logo_receipt;
    if (v !== null) {
      const m = typeof v === 'string' ? /^mono1:(\d+):(\d+):([A-Za-z0-9+/]+={0,2})$/.exec(v) : null;
      const w = m ? Number(m[1]) : 0, h = m ? Number(m[2]) : 0;
      const bytes = m ? Buffer.from(m[3], 'base64').length : -1;
      if (!m || w < 1 || w > 576 || h < 1 || h > 1024 || bytes !== Math.ceil(w / 8) * h) {
        res.status(400).json({ error: 'logo_receipt must be a mono1:<w>:<h>:<base64> raster with ceil(w/8)*h bytes, w<=576' });
        return;
      }
      row.logo_receipt = v;
    } else { row.logo_receipt = null; }
  }
  if (has('receipt_logo_enabled')) {
    if (typeof req.body.receipt_logo_enabled !== 'boolean') {
      res.status(400).json({ error: 'receipt_logo_enabled must be true or false' });
      return;
    }
    row.receipt_logo_enabled = req.body.receipt_logo_enabled;
  }
  if (has('theme_id')) {
    // A325: a curated id (shared/themes.ts) or null; choosing one needs the business's 'themes' flag.
    const err = themeWriteError(req.body.theme_id, await themesEnabled(req.businessId));
    if (err) { res.status(400).json({ error: err }); return; }
    row.theme_id = req.body.theme_id;
  }

  const { data, error } = await supabase
    .from('business_branding')
    .upsert(row, { onConflict: 'business_id' })
    .select('accent_hex, logo_png, logo_receipt, receipt_logo_enabled, theme_id, updated_at')
    .single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

// ── A544: per-branch branding ─────────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-21: "phase 2 branding — we need to do it before value add" … "yes start" (per-branch branding;
// docs/SCOPE-A295-branding.md §14–15). A branch may override the business's action theme, brand colour and receipt
// footer — each on its own (NULL = the business's). The till and the web POS resolve branch → business → ZapTill default
// (lib/branchBranding.ts). Who: the owner, any branch; a manager with the Branding tab's permission (receipt.manage or
// settings.business), their own branch only (assertBranchAccess, as the branch settings routes); a till's own session
// never. Premium: the business's `themes` flag (A325) — off, the web hides the section, a write is refused, a stored
// override is kept but never served. Validated as the business level is: a curated theme, a brand colour seen on the
// dark till (3:1), a plain-text footer whose lines fit the paper. Every change in the business's audit log.
const BRANCH_BRANDING_FIELDS = ['theme_id', 'accent_hex', 'receipt_footer'] as const;

/** A branch of THIS business (never another tenant's — 404 either way). */
async function businessBranch(businessId: string | undefined, branchId: string): Promise<{ id: string; name: string } | null> {
  if (!businessId || !branchId) return null;
  const { data } = await supabase.from('branches').select('id, name').eq('id', branchId).eq('business_id', businessId).maybeSingle();
  return (data as { id: string; name: string } | null) ?? null;
}

/** The branch-branding gate a write passes before anything is read: a person (never a till's own session). */
function branchBrandingCaller(req: any, res: any): boolean {
  if (req.isTill) { res.status(403).json({ error: 'Branch branding is changed by a person on the web, not by a POS.' }); return false; }
  return true;
}

async function auditBranchBranding(req: any, action: string, branchId: string, before: unknown, after: unknown): Promise<void> {
  try {
    const { data: me } = req.userId ? await supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : { data: null };
    const { error } = await supabase.from('audit_log').insert({
      business_id: req.businessId, branch_id: branchId, user_id: req.userId ?? null, user_name: (me as any)?.name ?? null,
      action, table_name: 'branch_branding', record_id: branchId, before_data: before ?? null, after_data: after ?? null,
    });
    if (error) console.error('[branding] branch branding audit not written:', error.message);
  } catch (e) { console.error('[branding] branch branding audit not written:', (e as Error)?.message ?? e); }
}

// GET /api/business/branding/branches — the branches the caller may brand (owner: every one; a manager: their own) and
// each one's override (null fields = the business's), with whether the business has themes.
router.get('/branding/branches', requireAuth, requireAnyPermission('receipt.manage', 'settings.business'), async (req, res) => {
  if (!branchBrandingCaller(req, res)) return;
  const [{ data: branches, error }, enabled] = await Promise.all([
    supabase.from('branches').select('id, name, is_main').eq('business_id', req.businessId).order('name'),
    themesEnabled(req.businessId),
  ]);
  if (error) { sendError(res, error); return; }
  const mine = ((branches ?? []) as Array<{ id: string; name: string; is_main?: boolean }>).filter((b) => assertBranchAccess(req, b.id));
  let rows: BranchBrandingRow[] = [];
  if (mine.length) {
    const r = await supabase.from('branch_branding').select(BRANCH_BRANDING_COLUMNS).in('branch_id', mine.map((b) => b.id));
    if (r.error) { res.status(503).json({ error: 'Branch branding is not available yet on this server.', code: 'BRANCH_BRANDING_UNAVAILABLE' }); return; }
    rows = (r.data ?? []) as BranchBrandingRow[];
  }
  const byBranch = new Map(rows.map((r) => [r.branch_id, r]));
  res.json({
    themes_enabled: enabled,
    limits: { line_max: FOOTER_LINE_MAX, line_narrow: FOOTER_LINE_NARROW, max_lines: FOOTER_MAX_LINES, max_chars: FOOTER_MAX_CHARS },
    branches: mine.map((b) => {
      const r = byBranch.get(b.id);
      return { branch_id: b.id, name: b.name, is_main: b.is_main === true, theme_id: r?.theme_id ?? null, accent_hex: r?.accent_hex ?? null,
        receipt_footer: r?.receipt_footer ?? null, updated_at: r?.updated_at ?? null };
    }),
  });
});

// GET /api/business/branding/branches/:branchId/served — A547 (A544's "not done" (a)): what pos/init serves a till of
// THIS branch — the business's effective theme (null = themes off) and the branch's override, or null — so the web's
// reprint of an old receipt resolves the branch's footer with the till's rule (lib/branchBranding.ts) instead of
// printing the business footer. Any signed-in member who may see the branch (a cashier their own, the owner every one);
// another business's branch 404. Read only; nothing is served with themes off (servedBranchBranding).
router.get('/branding/branches/:branchId/served', requireAuth, async (req, res) => {
  const branch = await businessBranch(req.businessId, req.params.branchId);
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (!assertBranchAccess(req, branch.id)) { res.status(403).json({ error: 'You can see your own branch only.' }); return; }
  const [enabled, { data: biz }] = await Promise.all([
    themesEnabled(req.businessId),
    supabase.from('business_branding').select('theme_id').eq('business_id', req.businessId).maybeSingle(),
  ]);
  res.json({
    themeId: effectiveThemeId(enabled, (biz as { theme_id?: unknown } | null)?.theme_id),
    branchBranding: await servedBranchBranding(branch.id, enabled),
  });
});

// PATCH /api/business/branding/branches/:branchId — set this branch's override. Omitted field = leave as-is; null = use the
// business's. A row left with nothing in it is removed.
router.patch('/branding/branches/:branchId', requireAuth, requireAnyPermission('receipt.manage', 'settings.business'), async (req, res) => {
  if (!branchBrandingCaller(req, res)) return;
  const branch = await businessBranch(req.businessId, req.params.branchId);
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (!assertBranchAccess(req, branch.id)) { res.status(403).json({ error: 'You can change the branding of your own branch only.' }); return; }
  if (!(await themesEnabled(req.businessId))) {
    res.status(403).json({ error: 'Per-branch branding is part of Themes — ask ZapTill to turn it on.', code: 'THEMES_OFF' }); return;
  }
  const body = req.body ?? {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (!BRANCH_BRANDING_FIELDS.some(has)) { res.status(400).json({ error: 'Send theme_id, accent_hex or receipt_footer.' }); return; }
  const patch: Record<string, string | null> = {};
  if (has('theme_id')) {
    const err = themeOverrideError(body.theme_id);
    if (err) { res.status(400).json({ error: err, field: 'theme_id' }); return; }
    patch.theme_id = body.theme_id;
  }
  if (has('accent_hex')) {
    const err = accentWriteError(body.accent_hex);
    if (err) { res.status(400).json({ error: err, field: 'accent_hex' }); return; }
    patch.accent_hex = body.accent_hex === null ? null : normaliseHex(body.accent_hex);
  }
  if (has('receipt_footer')) {
    const err = footerWriteError(body.receipt_footer);
    if (err) { res.status(400).json({ error: err, field: 'receipt_footer' }); return; }
    patch.receipt_footer = cleanFooter(body.receipt_footer);
  }
  const { data: before, error: rErr } = await supabase.from('branch_branding').select(BRANCH_BRANDING_COLUMNS).eq('branch_id', branch.id).maybeSingle();
  if (rErr) { res.status(503).json({ error: 'Branch branding is not available yet on this server.', code: 'BRANCH_BRANDING_UNAVAILABLE' }); return; }
  const next = { theme_id: (before as any)?.theme_id ?? null, accent_hex: (before as any)?.accent_hex ?? null,
    receipt_footer: (before as any)?.receipt_footer ?? null, ...patch };
  if (next.theme_id === null && next.accent_hex === null && next.receipt_footer === null) {
    if (before) {
      const { error } = await supabase.from('branch_branding').delete().eq('branch_id', branch.id);
      if (error) { sendError(res, error); return; }
      await auditBranchBranding(req, 'branch_branding.clear', branch.id, before, null);
    }
    res.json({ branch_id: branch.id, theme_id: null, accent_hex: null, receipt_footer: null, updated_at: null });
    return;
  }
  const { data, error } = await supabase.from('branch_branding')
    .upsert({ branch_id: branch.id, ...next, updated_at: new Date().toISOString() }, { onConflict: 'branch_id' })
    .select(BRANCH_BRANDING_COLUMNS).single();
  if (error) { sendError(res, error); return; }
  await auditBranchBranding(req, 'branch_branding.update', branch.id, before ?? null, data);
  res.json(data);
});

// DELETE /api/business/branding/branches/:branchId — clear this branch's override (it follows the business again).
// Allowed with themes off too: taking an override away is never premium.
router.delete('/branding/branches/:branchId', requireAuth, requireAnyPermission('receipt.manage', 'settings.business'), async (req, res) => {
  if (!branchBrandingCaller(req, res)) return;
  const branch = await businessBranch(req.businessId, req.params.branchId);
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (!assertBranchAccess(req, branch.id)) { res.status(403).json({ error: 'You can change the branding of your own branch only.' }); return; }
  const { data: before, error: rErr } = await supabase.from('branch_branding').select(BRANCH_BRANDING_COLUMNS).eq('branch_id', branch.id).maybeSingle();
  if (rErr) { res.status(503).json({ error: 'Branch branding is not available yet on this server.', code: 'BRANCH_BRANDING_UNAVAILABLE' }); return; }
  if (before) {
    const { error } = await supabase.from('branch_branding').delete().eq('branch_id', branch.id);
    if (error) { sendError(res, error); return; }
    await auditBranchBranding(req, 'branch_branding.clear', branch.id, before, null);
  }
  res.json({ branch_id: branch.id, cleared: true });
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
// A595 (docs/PERMISSIONS-AUDIT.md F3): who the reports go to (e-mail addresses) — read by whoever may change it
// (settings.report_emails), no longer by every signed-in session.
router.get('/settings/report-schedule', requireAuth, (req, res, next) => { if (mayReportEmails(req)) next(); else res.status(403).json(REPORT_EMAILS_REFUSED); }, async (req, res) => {
  const DEFAULT = { enabled: false, send_time: '21:00', recipients: [] as string[] };

  const { data, error } = await supabase
    .from('business_settings')
    .select('value')
    .eq('business_id', req.businessId)
    .eq('key', 'report_schedule')
    .maybeSingle();

  if (error) { sendError(res, error); return; }
  // A476: every switch and amount, defaults filled in (what the job will actually do).
  if (!data) { res.json(cleanReportSchedule(DEFAULT)); return; }

  // POST /settings stores the JSON string the client sent; tolerate a column
  // that hands back already-parsed JSON too, and never let a malformed row throw.
  let parsed: any = DEFAULT;
  try {
    parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
  } catch { parsed = DEFAULT; }

  res.json(cleanReportSchedule({ ...DEFAULT, ...(parsed && typeof parsed === 'object' ? parsed : {}) }) ?? DEFAULT);
});

// POST /api/business/settings
// Upserts a single key/value pair for this business.
// Body: { key: string, value: string }
// A595 (D3): the report schedule is the owner's and the partners' (mayReportEmails) — let a partner in for that key alone.
const settingsWriteGate = requireAnyPermission(...SETTING_WRITE_KEYS);
router.post('/settings', requireAuth, (req, res, next) => {
  if (String(req.body?.key ?? '') === 'report_schedule') { if (mayReportEmails(req)) next(); else res.status(403).json(REPORT_EMAILS_REFUSED); return; }
  settingsWriteGate(req, res, next);
}, async (req, res) => {
  const { key, value } = req.body;

  if (!key || value === undefined) {
    res.status(400).json({ error: 'key and value are required' });
    return;
  }
  // A514: the business-wide supervisor PIN is retired — refused for everyone, before any other check or write.
  if (isRetiredSupervisorPinKey(String(key))) {
    res.status(410).json({ ...SUPERVISOR_PIN_RETIRED });
    return;
  }
  // A492: the M-Pesa number is per branch, set on the branch's till by its manager — not business-wide.
  if (['receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account'].includes(String(key))) {
    res.status(400).json({ error: 'Each branch sets its own M-Pesa number on its POS: Manager › Settings › M-Pesa.', code: 'MPESA_ON_TILL' });
    return;
  }

  // ── A45: per-key authorisation, BEFORE any write ───────────────────────────
  // The route gate above admits anyone holding EITHER key, because Express
  // middleware runs before the body is inspected and cannot know which setting
  // is being written. So the narrowing happens here, and it happens FIRST —
  // ahead of the encrypted branch, because otherwise a caller holding only
  // receipt.manage would reach the code path that writes an M-Pesa credential.
  //
  // Fails closed: settings.manage (or owner / wildcard) writes anything, and
  // everyone else writes only what is explicitly allowed.
  // A490: each setting names its own key (settingPermission) — the receipt text receipt.manage, the payment methods
  // settings.payments, loyalty settings.pos, the report schedule settings.integrations, everything else
  // settings.business. The void/refund rules and the stock-count freeze stay the owner's (below).
  const needed = settingPermission(String(key));
  if (String(key) === 'report_schedule') {
    // A595 (D3): checked at the gate above (mayReportEmails).
  } else if (needed === null) {
    // A494: the owner's own settings — the real owner, signed in as themselves (not a till's own sign-in).
    if (!req.isOwner || req.isTill) {
      res.status(403).json({ error: 'Only the owner can change that setting.', code: 'OWNER_ONLY', detail: `"${key}" is the owner's` });
      return;
    }
  } else if (!can(req, needed)) {
    res.status(403).json({
      error: 'Forbidden',
      // Name the key they tried, not the permission they lack: the caller with
      // receipt.manage is a manager who has just been told "no" on a screen
      // that offered them the field. A45 is what the vaguer message cost.
      detail: can(req, 'receipt.manage')
        ? `receipt.manage may only write the receipt text (header, footer, how to pay), not "${key}"`
        : `Missing permission: ${needed}`,
    });
    return;
  }

  // ── A476: the owner's email schedule — only the known keys, each cleaned (amounts in range, real addresses) ──
  // Who may write it is unchanged: settings.manage / owner (checked above). The alert job's own bookkeeping keys are
  // never written from here.
  // A550: web dashboard access is given and taken only through Staff (routes/staff.ts /:id/web-access), which also links
  // and unlinks the sign-in account and ends sessions — never written here.
  // A569: the cloud trial record (once per client, ever) is ZapTill's too.
  // A576: the loss-prevention alerts' settings are the owner's, written only through PUT /api/loss-alerts/settings (cleaned).
  if (isOwnerAlertJobKey(String(key)) || String(key) === PARTNER_SETTING_KEY || String(key) === CLOUD_TRIAL_KEY || String(key) === LOSS_SETTINGS_KEY
      || String(key) === CREDIT_APPROVERS_KEY) {   // A585: written only through PUT /api/credit/approvers (the owner, cleaned)
    res.status(403).json({ error: 'That setting is kept by ZapTill itself.', code: 'READ_ONLY_KEY' });
    return;
  }
  if (key === 'report_schedule') {
    const clean = cleanReportSchedule(value);
    if (!clean) {
      res.status(400).json({ error: 'The report schedule must be an object.', code: 'INVALID_VALUE' });
      return;
    }
    const stored = JSON.stringify(clean);
    const { data: existingRs } = await supabase
      .from('business_settings').select('id').eq('business_id', req.businessId).eq('key', key).maybeSingle();
    const { error: rsErr } = existingRs
      ? await supabase.from('business_settings').update({ value: stored, updated_at: new Date().toISOString() }).eq('id', existingRs.id)
      : await supabase.from('business_settings').insert({ business_id: req.businessId, key, value: stored });
    if (rsErr) { sendError(res, rsErr); return; }
    res.json({ key, value: stored });
    return;
  }

  // ── 0.6.30 (A336 stage 3): the void/refund rules are the OWNER's ───────────
  // "for offline we will let the owner decide" — a manager holding settings.manage may not widen their own void
  // window or the methods they may refund offline. Only a value lib/reversalRules.ts accepts is stored.
  // ── A394: freezing items during a stock count — "we leave that as a feature which the owner will decide" ──
  // A502: who may is decided above — inventory.count_freeze (settingPermission), the owner's until given to someone.
  if (key === STOCK_COUNT_FREEZE_KEY) {
    const clean = freezeSetting(value) ? 'true' : 'false';
    const { data: existingFz } = await supabase
      .from('business_settings').select('id').eq('business_id', req.businessId).eq('key', key).maybeSingle();
    const { error: fzErr } = existingFz
      ? await supabase.from('business_settings').update({ value: clean, updated_at: new Date().toISOString() }).eq('id', existingFz.id)
      : await supabase.from('business_settings').insert({ business_id: req.businessId, key, value: clean });
    if (fzErr) { sendError(res, fzErr); return; }
    res.json({ key, value: clean });
    return;
  }

  // A502: who may is decided above — settings.reversals (settingPermission), the owner's until given to someone.
  if (isReversalSettingKey(key)) {
    const clean = reversalSettingValue(key, value);
    if (clean === null) {
      res.status(400).json({ error: `That is not a valid value for ${key}.`, code: 'INVALID_VALUE' });
      return;
    }
    const { data: existingRule } = await supabase
      .from('business_settings').select('id').eq('business_id', req.businessId).eq('key', key).maybeSingle();
    const { error: ruleErr } = existingRule
      ? await supabase.from('business_settings').update({ value: clean, updated_at: new Date().toISOString() }).eq('id', existingRule.id)
      : await supabase.from('business_settings').insert({ business_id: req.businessId, key, value: clean });
    if (ruleErr) { sendError(res, ruleErr); return; }
    res.json({ key, value: clean });
    return;
  }

  // ── 0.6.34: the business day's end — only a valid time is stored, as "HH:MM" ──
  if (key === BUSINESS_DAY_CUTOFF_KEY) {
    const clean = cutoffSettingValue(value);
    if (clean === null) {
      res.status(400).json({ error: 'The business day may end from 00:00 to 06:00 (HH:MM).', code: 'INVALID_VALUE' });
      return;
    }
    const { data: existingCut } = await supabase
      .from('business_settings').select('id').eq('business_id', req.businessId).eq('key', key).maybeSingle();
    const { error: cutErr } = existingCut
      ? await supabase.from('business_settings').update({ value: clean, updated_at: new Date().toISOString() }).eq('id', existingCut.id)
      : await supabase.from('business_settings').insert({ business_id: req.businessId, key, value: clean });
    if (cutErr) { sendError(res, cutErr); return; }
    invalidateDayCutoff(req.businessId);
    res.json({ key, value: clean });
    return;
  }

  // ── A429: the payment methods switched on — only catalogue codes; stored as a JSON list in catalogue order ──
  if (key === PAYMENT_METHODS_ENABLED_KEY) {
    const clean = enabledSettingValue(value);
    if (clean === null) {
      res.status(400).json({ error: 'Choose payment methods from the list.', code: 'INVALID_VALUE' });
      return;
    }
    const { data: existingPm } = await supabase
      .from('business_settings').select('id').eq('business_id', req.businessId).eq('key', key).maybeSingle();
    const { error: pmErr } = existingPm
      ? await supabase.from('business_settings').update({ value: clean, updated_at: new Date().toISOString() }).eq('id', existingPm.id)
      : await supabase.from('business_settings').insert({ business_id: req.businessId, key, value: clean });
    if (pmErr) { sendError(res, pmErr); return; }
    res.json({ key, value: clean });
    return;
  }

  // ── 0.6.37 (A387): the methods a cashier's History shows — a manager's choice (settings.manage, checked above) ──
  if (key === CASHIER_HISTORY_METHODS_KEY) {
    const clean = historyMethodsSettingValue(value);
    if (clean === null) {
      res.status(400).json({ error: 'Choose payment methods from the list.', code: 'INVALID_VALUE' });
      return;
    }
    const { data: existingHm } = await supabase
      .from('business_settings').select('id').eq('business_id', req.businessId).eq('key', key).maybeSingle();
    const { error: hmErr } = existingHm
      ? await supabase.from('business_settings').update({ value: clean, updated_at: new Date().toISOString() }).eq('id', existingHm.id)
      : await supabase.from('business_settings').insert({ business_id: req.businessId, key, value: clean });
    if (hmErr) { sendError(res, hmErr); return; }
    invalidateHistoryMethods(req.businessId);
    res.json({ key, value: clean });
    return;
  }

  // ── A577: the scale label layout — only a layout that adds up to an EAN-13 is stored, as clean JSON ──
  if (key === SCALE_SETTINGS_KEY) {
    const c = cleanScaleSettings(value);
    if ('error' in c) {
      res.status(400).json({ error: c.error, code: 'INVALID_VALUE' });
      return;
    }
    const clean = JSON.stringify(c.settings);
    const { data: existingSc } = await supabase
      .from('business_settings').select('id').eq('business_id', req.businessId).eq('key', key).maybeSingle();
    const { error: scErr } = existingSc
      ? await supabase.from('business_settings').update({ value: clean, updated_at: new Date().toISOString() }).eq('id', existingSc.id)
      : await supabase.from('business_settings').insert({ business_id: req.businessId, key, value: clean });
    if (scErr) { sendError(res, scErr); return; }
    res.json({ key, value: clean });
    return;
  }

  // A514: the hashed-setting branch (supervisor_pin → supervisor_pin_hash) is gone with the business supervisor PIN —
  // refused above, before anything is written.

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
