/**
 * routes/controls.ts — A490: the business options the OWNER sets (they were the admin portal's).
 *
 * Owner, 2026-10-14: "you can move some of the features in admin section as permission for the owner to set". Mounted at
 * /api/controls (docs/PERMISSIONS-A490.md "Owner controls"):
 *
 *   GET  /api/controls            { pos?, loyalty?, payments? } — each section only with its key
 *   PUT  /api/controls/pos/:key   { enabled }            settings.pos — delivery_fee, pay_later_tabs, pay_before_kitchen, login_codes,
 *                                                        approval_pin (A594; login_codes and approval_pin: the owner only), rooms
 *   PUT  /api/controls/loyalty    { enabled?, earn_rate? } settings.pos
 *   PUT  /api/controls/stock-zero { mode }               settings.pos — A563: when an item's stock reaches zero
 *                                                        ('sell' | 'sold_out' | 'hide'; two feature_flags, lib/stockGate.ts)
 *   PUT  /api/controls/updates    refused (403 ADMIN_SETS) — A493: ZapTill approves a client's till updates, never the client
 *
 * Business-wide payment methods are written by POST /api/business/settings (payment_methods_enabled, settings.payments);
 * read here. Where each value lives is unchanged — the POS switches and loyalty_enabled are feature_flags rows (what the
 * tills and pos/init read), the earn rate a business setting, the approved version businesses.desktop_approved_version —
 * only WHO sets them moved. The admin portal refuses these (PATCH /api/admin/clients/:id/features/:key → OWNER_SETS).
 *
 * Audit: there is no business-level audit table (admin_audit_log is ZapTill's admins'); each change is logged as one
 * structured line ([controls] …) with who, what, before and after.
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, can } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { businessPosFeatures } from '../lib/posFeatureFlags';
import { isOwnerRoleName } from '../lib/ownerRole';
import { PHONE_POS_SETTING_KEY, readPhonePosMap, phonePosFor, asPhonePosMap, type PhonePosMap } from '../lib/phonePosRoles';
import { PAYMENT_METHODS_ENABLED_KEY, enabledFromSetting } from '@zaptill/core/paymentCatalogue';
import { STOCK_ZERO_KEYS, STANDARD_POS_FEATURES } from '@zaptill/core/posFeatures';   // A563; A604
import { isOutOfStockMode, outOfStockMode, outOfStockFlags } from '@zaptill/core/stockGate';   // A563

/** The POS options the owner sets (settings.pos). */
// A594 (owner, 2026-10-26: "some items can be permissions … I like your proposal"): + approval_pin (A562 — was the admin
// portal's), the owner's alone like login_codes.
// Owner, 2026-11-04: + rooms (Charge to room only for a business with rooms).
// Owner, 2026-11-22: + web_pos — show/hide the online (web) POS for the whole business (the "Open POS" menu item on the web
// dashboard and the owner phone). Default ON; the DESKTOP POS is a separate app and is never affected. Owner-controlled.
export const OWNER_POS_KEYS = ['delivery_fee', 'pay_later_tabs', 'pay_before_kitchen', 'login_codes', 'approval_pin', 'rooms', 'web_pos'] as const;
/** The options only the real owner (signed in as themselves) changes — account security, who approves with what, and
 *  whether the business offers the online (web) POS at all. */
export const OWNER_ONLY_POS_KEYS = ['login_codes', 'approval_pin', 'web_pos'] as const;
/** The cashier switches A490 retired — now permissions per role (sales.history_all, sales.reprint; A594: cash in / cash out /
 *  expenses as shifts.cash_movements, shifts.cash_out, expenses.record). */
export const RETIRED_SWITCHES = ['cashier_own_history', 'cashier_no_money_out', 'cashier_no_reprint'] as const;

/** A493 (owner, 2026-10-15): "update approval should live under admin some clients my not want to pay for updates so they
 *  rather not have the ability to do the update them" — the admin portal approves or holds a client's till version. */
export const ADMIN_SETS_UPDATES = 'ZapTill approves which version your points of sale install — contact ZapTill support.';

/** Why the admin portal may not set this feature (A490), or null when it still may. */
export function ownerSetsFeature(key: string): string | null {
  if ((OWNER_POS_KEYS as readonly string[]).includes(key) || key === 'loyalty_enabled' || (STOCK_ZERO_KEYS as readonly string[]).includes(key)) {
    return 'The business owner sets this now (Settings › Business › POS options).';
  }
  if ((RETIRED_SWITCHES as readonly string[]).includes(key)) {
    return 'This is set per role now — the owner gives or takes the permission on Settings › Roles and permissions.';
  }
  return null;
}

/** A604: the STANDARD keys (lib/posFeatures.ts STANDARD_POS_FEATURES — blind shift close, cashier figures at confirm,
 *  manager approval of kitchen voids) are always on for every business; a stored value is ignored, so the admin portal's
 *  write is refused (409 ALWAYS_ON) rather than stored and shown as if it changed something. */
export const ALWAYS_ON_REFUSAL = 'This is always on for every business (blind shift close, cashier figures at confirm, manager approval of kitchen voids) — there is nothing to switch.';
export function alwaysOnFeature(key: string): string | null {
  return (STANDARD_POS_FEATURES as readonly string[]).includes(key) ? ALWAYS_ON_REFUSAL : null;
}

const router = safeRouter();
router.use(requireAuth);

function audit(req: any, what: string, before: unknown, after: unknown): void {
  console.log(`[controls] business ${req.businessId} — ${what} by ${req.isOwner ? 'the owner' : 'user'} ${req.userId ?? '?'}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
}

async function setFlag(businessId: string, key: string, enabled: boolean): Promise<{ message?: string } | null> {
  const { error } = await supabase.from('feature_flags').upsert({
    business_id: businessId, key, enabled, set_by: 'owner', updated_at: new Date().toISOString(),
  }, { onConflict: 'business_id,key' });
  return error ?? null;
}

async function readSetting(businessId: string, key: string): Promise<unknown> {
  const { data } = await supabase.from('business_settings').select('value').eq('business_id', businessId).eq('key', key).maybeSingle();
  return (data as { value?: unknown } | null)?.value ?? null;
}

/** Write one business setting (text value), the established select-then-update-or-insert way (routes/business.ts). */
async function writeSetting(businessId: string, key: string, value: string): Promise<{ message?: string } | null> {
  const { data: existing } = await supabase.from('business_settings').select('id').eq('business_id', businessId).eq('key', key).maybeSingle();
  const { error } = existing
    ? await supabase.from('business_settings').update({ value, updated_at: new Date().toISOString() }).eq('id', (existing as { id: string }).id)
    : await supabase.from('business_settings').insert({ business_id: businessId, key, value });
  return error ?? null;
}

// web_pos: does this business offer the online (web) POS at all? Default ON — only an explicit off hides it. It is NOT a
// shared POS_FEATURE (it never reaches the till rules, and the DESKTOP POS is a separate app it never touches), so it is
// read straight from feature_flags here rather than through businessPosFeatures, which only returns POS_FEATURE_KEYS.
async function webPosEnabled(businessId: string | undefined): Promise<boolean> {
  if (!businessId) return true;
  const { data } = await supabase.from('feature_flags').select('enabled').eq('business_id', businessId).eq('key', 'web_pos').maybeSingle();
  return (data as { enabled?: boolean } | null)?.enabled !== false;
}

// GET /api/controls — what this person may see of the owner's options.
router.get('/', async (req, res) => {
  const out: Record<string, unknown> = {};
  const pos = can(req, 'settings.pos'), payments = can(req, 'settings.payments');
  try {
    if (pos) {
      const f = await businessPosFeatures(req.businessId) as unknown as Record<string, boolean>;
      const posOut = Object.fromEntries(OWNER_POS_KEYS.map((k) => [k, f[k] === true])) as Record<string, boolean>;
      out.stock = { when_zero: outOfStockMode(f) };   // A563
      const [{ data: loy }, rate, webPos] = await Promise.all([
        supabase.from('feature_flags').select('enabled').eq('business_id', req.businessId).eq('key', 'loyalty_enabled').maybeSingle(),
        readSetting(req.businessId, 'loyalty_earn_rate'),
        webPosEnabled(req.businessId),
      ]);
      // web_pos is default-ON, so it is read straight from feature_flags (webPosEnabled), not the === true above.
      posOut.web_pos = webPos;
      out.pos = posOut;
      const n = Number(rate);
      out.loyalty = { enabled: (loy as { enabled?: boolean } | null)?.enabled === true, earn_rate: Number.isFinite(n) && n > 0 ? n : 1 };
    }
    if (payments) out.payments = { enabled: enabledFromSetting(await readSetting(req.businessId, PAYMENT_METHODS_ENABLED_KEY)) };
  } catch (e) { sendError(res, e as Error); return; }
  res.json(out);
});

// PUT /api/controls/pos/:key { enabled } — one of the owner's POS options (OWNER_POS_KEYS).
router.put('/pos/:key', requirePermission('settings.pos'), async (req, res) => {
  const key = String(req.params.key);
  if (!(OWNER_POS_KEYS as readonly string[]).includes(key)) {
    res.status(400).json({ error: `Not a POS option: ${key}`, code: 'UNKNOWN_OPTION' }); return;
  }
  // A494: sign-in codes (a one-time code by e-mail for back-office sign-in) are an account-security switch — the real
  // owner's alone, signed in as themselves: a settings.pos holder could switch off the code that guards their own and
  // everyone's back-office sign-in, and a till's own token is not a person.
  // A594: the separate approval PIN (A562) likewise — it decides how every manager's approval is given.
  if ((OWNER_ONLY_POS_KEYS as readonly string[]).includes(key) && (!req.isOwner || req.isTill)) {
    const ownerOnly = key === 'login_codes' ? 'Only the owner can change sign-in codes.'
      : key === 'web_pos' ? 'Only the owner can turn the online (web) POS on or off.'
      : 'Only the owner can change the approval PIN option.';
    res.status(403).json({ error: ownerOnly, code: 'OWNER_ONLY' }); return;
  }
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled (true or false) is required' }); return; }
  // web_pos is default-ON and not a businessPosFeatures key, so its before-value is read straight from feature_flags.
  const before = key === 'web_pos'
    ? await webPosEnabled(req.businessId)
    : ((await businessPosFeatures(req.businessId)) as unknown as Record<string, boolean>)[key] === true;
  const err = await setFlag(req.businessId, key, enabled);
  if (err) { sendError(res, err as Error); return; }
  audit(req, `pos.${key}`, before, enabled);
  res.json({ key, enabled });
});

// PUT /api/controls/loyalty { enabled?, earn_rate? }
router.put('/loyalty', requirePermission('settings.pos'), async (req, res) => {
  const { enabled, earn_rate } = req.body ?? {};
  if (enabled === undefined && earn_rate === undefined) { res.status(400).json({ error: 'enabled or earn_rate is required' }); return; }
  if (enabled !== undefined && typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be true or false' }); return; }
  let rate: number | undefined;
  if (earn_rate !== undefined) {
    rate = Number(earn_rate);
    if (earn_rate === null || earn_rate === '' || !Number.isFinite(rate) || rate <= 0 || rate > 1000) {
      res.status(400).json({ error: 'earn_rate must be a number above 0 (at most 1000)' }); return;
    }
    rate = Math.round(rate * 10000) / 10000;
  }
  if (enabled !== undefined) {
    const err = await setFlag(req.businessId, 'loyalty_enabled', enabled);
    if (err) { sendError(res, err as Error); return; }
    audit(req, 'loyalty.enabled', null, enabled);
  }
  if (rate !== undefined) {
    const before = await readSetting(req.businessId, 'loyalty_earn_rate');
    const { data: existing } = await supabase.from('business_settings').select('id')
      .eq('business_id', req.businessId).eq('key', 'loyalty_earn_rate').maybeSingle();
    const { error } = existing
      ? await supabase.from('business_settings').update({ value: String(rate), updated_at: new Date().toISOString() }).eq('id', (existing as any).id)
      : await supabase.from('business_settings').insert({ business_id: req.businessId, key: 'loyalty_earn_rate', value: String(rate) });
    if (error) { sendError(res, error); return; }
    audit(req, 'loyalty.earn_rate', before, rate);
  }
  res.json({ ...(enabled !== undefined ? { enabled } : {}), ...(rate !== undefined ? { earn_rate: rate } : {}) });
});

// PUT /api/controls/stock-zero { mode } — A563 (owner, 2026-10-22: "add a feature where an owner can enable not to prevent
// items with zero stock from appearing in the inventory or if they do they cannot be sold"). One choice, two switches
// (feature_flags stock_zero_sold_out / stock_zero_hide) — they reach the tills and the web POS as every POS switch does.
router.put('/stock-zero', requirePermission('settings.pos'), async (req, res) => {
  const mode = req.body?.mode;
  if (!isOutOfStockMode(mode)) { res.status(400).json({ error: "mode must be 'sell', 'sold_out' or 'hide'", code: 'BAD_MODE' }); return; }
  const before = outOfStockMode((await businessPosFeatures(req.businessId)) as unknown as Record<string, unknown>);
  for (const [key, enabled] of Object.entries(outOfStockFlags(mode))) {
    const err = await setFlag(req.businessId, key, enabled);
    if (err) { sendError(res, err as Error); return; }
  }
  audit(req, 'pos.stock_zero', before, mode);
  res.json({ mode });
});

// ── Who sees "Open POS" in the OWNER / MANAGER PHONE app ── Owner, 2026-11-22 ──────────────────────────────────────────
// "on the mobile app remove pos on the menu on the owner and other senior management, only the hotel manager and cashier
//  should have that option" — a per-role switch (lib/phonePosRoles.ts). Owner-only: it decides the owner's own and senior
// management's visibility. Presentational only — the POS still enforces orders.create, and the browser dashboard and the
// desktop POS are never touched. Each role's resolved value = the owner's explicit choice, else the default (a selling
// role that is not the owner shows it; the owner and back-office roles do not).
router.get('/phone-pos', requirePermission('settings.pos'), async (req, res) => {
  if (!req.isOwner || req.isTill) { res.status(403).json({ error: 'Only the owner sets who sees the online POS on the phone.', code: 'OWNER_ONLY' }); return; }
  try {
    const [{ data: roleRows }, map] = await Promise.all([
      supabase.from('roles').select('id, name, role_permissions ( permissions ( key ) )').eq('business_id', req.businessId),
      readPhonePosMap(req.businessId),
    ]);
    const roles = ((roleRows ?? []) as Array<{ id: string; name: string | null; role_permissions?: Array<{ permissions?: { key?: string } | null }> }>)
      .map((r) => {
        const owner = isOwnerRoleName(r.name);
        const keys = new Set((r.role_permissions ?? []).map((rp) => rp.permissions?.key).filter(Boolean) as string[]);
        const sells = owner || keys.has('orders.create');
        return { id: r.id, name: r.name ?? '', is_owner_role: owner, sells, enabled: phonePosFor(map, r.id, owner, sells) };
      })
      .sort((a, b) => (a.is_owner_role === b.is_owner_role ? a.name.localeCompare(b.name) : a.is_owner_role ? -1 : 1));
    res.json({ roles });
  } catch (e) { sendError(res, e as Error); return; }
});

// PUT /api/controls/phone-pos { map: { [roleId]: boolean } } — owner-only. Explicit per-role overrides; a role left out
// uses the default. Stale or foreign role ids are dropped.
router.put('/phone-pos', requirePermission('settings.pos'), async (req, res) => {
  if (!req.isOwner || req.isTill) { res.status(403).json({ error: 'Only the owner sets who sees the online POS on the phone.', code: 'OWNER_ONLY' }); return; }
  const raw = req.body?.map;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { res.status(400).json({ error: 'map ({ roleId: true/false }) is required' }); return; }
  const wanted: PhonePosMap = asPhonePosMap(raw);
  const { data: roleRows } = await supabase.from('roles').select('id').eq('business_id', req.businessId);
  const valid = new Set(((roleRows ?? []) as Array<{ id: string }>).map((r) => r.id));
  const clean: PhonePosMap = {};
  for (const [k, v] of Object.entries(wanted)) if (valid.has(k)) clean[k] = v;
  const before = await readPhonePosMap(req.businessId);
  const err = await writeSetting(req.businessId, PHONE_POS_SETTING_KEY, JSON.stringify(clean));
  if (err) { sendError(res, err as Error); return; }
  audit(req, 'pos.phone_pos_roles', before, clean);
  res.json({ map: clean });
});

// PUT /api/controls/updates — A493: refused. ZapTill (the admin portal) approves or holds a client's till version; a
// client that has not paid for updates must not be able to take one. Kept as a named refusal so an older dashboard that
// still offers the button gets a clear answer, not a 404.
router.put('/updates', (_req, res) => {
  res.status(403).json({ error: ADMIN_SETS_UPDATES, code: 'ADMIN_SETS' });
});

export default router;
