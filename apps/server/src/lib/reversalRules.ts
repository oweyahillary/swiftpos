/**
 * reversalRules.ts — 0.6.30 (A336 stage 3): the owner's rules for voiding and refunding a sale, online and offline.
 *
 * Owner, 2026-10-01: "Void window yes let it remain 30 min but i thing we can add a feature for owner to either increase
 * or reduce the threshold but default is 30, we will set it to manager only not cashier … for offline we will let the
 * owner decide the refund method in the managers setting which methods are allow we need to add that to the web also.
 * scope leave it to till own sales but let it be a feature on the owners page also".
 *
 *   void_window_minutes        how long after a sale a manager may still VOID it (default 30). The owner voids at any
 *                              age. Cashiers never void or refund (the History button is managers' and the owner's).
 *   offline_refund_methods     the payment methods a till may refund while it cannot reach the cloud (default cash).
 *                              A refund hands back every leg in the tender it came in on; offline, every leg must be one
 *                              of these — M-Pesa or card money cannot be checked or sent back without the network.
 *   offline_reverse_web_sales  offline, a till reverses its OWN sales only; with this on, also the web sales it holds.
 *   delivery_free_allowed      0.6.33 — with the client's 'delivery_fee' switch, a delivery may go without a fee (free
 *                              delivery): the cashier still names the rider but may leave the fee empty. Off by default.
 *                              Owner, 2026-10-02: "can we add an option of free delivery where its not a must for the
 *                              cashier to key in delivery fee? but that can be turned on and of by the hotel owner".
 *
 * Set by the owner — on the web (Settings) and on the till (Manager → Settings, signed in as the owner). Stored in
 * business_settings; pos/init carries them to the till.
 *
 * ONE file: shared/reversalRules.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

export const DEFAULT_VOID_WINDOW_MINUTES = 30;
export const MIN_VOID_WINDOW_MINUTES = 1;
export const MAX_VOID_WINDOW_MINUTES = 1440;   // a day
export const DEFAULT_OFFLINE_REFUND_METHODS: readonly string[] = ['cash'];

export const REVERSAL_SETTING_KEYS = ['void_window_minutes', 'offline_refund_methods', 'offline_reverse_web_sales', 'delivery_free_allowed'] as const;
export type ReversalSettingKey = (typeof REVERSAL_SETTING_KEYS)[number];

export interface ReversalRules {
  voidWindowMinutes: number;
  offlineRefundMethods: string[];
  offlineReverseWebSales: boolean;
  freeDeliveryAllowed: boolean;   // 0.6.33
}

export function defaultReversalRules(): ReversalRules {
  return {
    voidWindowMinutes: DEFAULT_VOID_WINDOW_MINUTES,
    offlineRefundMethods: [...DEFAULT_OFFLINE_REFUND_METHODS],
    offlineReverseWebSales: false,
    freeDeliveryAllowed: false,
  };
}

export function isReversalSettingKey(key: unknown): key is ReversalSettingKey {
  return (REVERSAL_SETTING_KEYS as readonly string[]).includes(String(key));
}

/** A stored setting comes back as a number, a string, or JSON text of either — unwrap one layer of JSON text. */
function unwrap(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (!s) return s;
  try { return JSON.parse(s); } catch { return s; }
}

/** Whole minutes, MIN..MAX; null when it is not one. */
export function cleanVoidWindow(raw: unknown): number | null {
  let v = unwrap(raw);
  if (typeof v === 'string') v = unwrap(v);
  if (typeof v === 'string' && !/^\s*\d+\s*$/.test(v)) return null;
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || !Number.isInteger(n)) return null;
  return n >= MIN_VOID_WINDOW_MINUTES && n <= MAX_VOID_WINDOW_MINUTES ? n : null;
}

/** Method codes, lower-case, de-duplicated (cash, mpesa, card, credit, a custom tender's code). Null when not a list. */
export function cleanRefundMethods(raw: unknown): string[] | null {
  let v = unwrap(raw);
  if (typeof v === 'string') v = unwrap(v);
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const m of v) {
    const c = String(m ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(c)) return null;
    if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, 20);
}

export function cleanOnOff(raw: unknown): boolean | null {
  let v = unwrap(raw);
  if (typeof v === 'string') v = unwrap(v);
  if (v === true || v === 1 || v === 'true' || v === '1') return true;
  if (v === false || v === 0 || v === 'false' || v === '0') return false;
  return null;
}

/**
 * What to store for one of these keys (JSON text), or null when the value is not acceptable. The cloud writes only
 * this, so a bad value never reaches the till.
 */
export function reversalSettingValue(key: string, raw: unknown): string | null {
  if (key === 'void_window_minutes') { const n = cleanVoidWindow(raw); return n === null ? null : JSON.stringify(n); }
  if (key === 'offline_refund_methods') { const m = cleanRefundMethods(raw); return m === null ? null : JSON.stringify(m); }
  if (key === 'offline_reverse_web_sales' || key === 'delivery_free_allowed') { const b = cleanOnOff(raw); return b === null ? null : JSON.stringify(b); }
  return null;
}

/** The rules from stored settings — an object keyed by setting, or rows of {key, value}. Anything missing or bad → default. */
export function parseReversalRules(
  src: Record<string, unknown> | Array<{ key: string; value: unknown }> | null | undefined,
): ReversalRules {
  const get = (k: ReversalSettingKey): unknown => {
    if (Array.isArray(src)) return src.find((r) => r?.key === k)?.value;
    return src ? (src as Record<string, unknown>)[k] : undefined;
  };
  const d = defaultReversalRules();
  return {
    voidWindowMinutes: cleanVoidWindow(get('void_window_minutes')) ?? d.voidWindowMinutes,
    offlineRefundMethods: cleanRefundMethods(get('offline_refund_methods')) ?? d.offlineRefundMethods,
    offlineReverseWebSales: cleanOnOff(get('offline_reverse_web_sales')) ?? d.offlineReverseWebSales,
    freeDeliveryAllowed: cleanOnOff(get('delivery_free_allowed')) ?? d.freeDeliveryAllowed,
  };
}

/** The same rules from pos/init's `reversalRules` (already the parsed shape) — anything bad → default. */
export function rulesFromWire(raw: unknown): ReversalRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return parseReversalRules({
    void_window_minutes: r.voidWindowMinutes,
    offline_refund_methods: r.offlineRefundMethods,
    offline_reverse_web_sales: r.offlineReverseWebSales,
    delivery_free_allowed: r.freeDeliveryAllowed,
  });
}

/** May this sale still be VOIDED? The owner: always. Anyone else: within the window (minutes since the sale). */
export function voidWindowOpen(ageMinutes: number, rules: Pick<ReversalRules, 'voidWindowMinutes'>, isOwner: boolean): boolean {
  return isOwner || Number(ageMinutes) <= rules.voidWindowMinutes;
}

/** Minutes between the sale and `atMs` (the approval time), whole, never negative. */
export function minutesBetween(saleIso: string, atMs: number): number {
  const t = new Date(saleIso).getTime();
  return Number.isFinite(t) && Number.isFinite(atMs) ? Math.max(0, Math.floor((atMs - t) / 60000)) : 0;
}

/**
 * An offline refund hands back every leg in its own tender — refused when any leg is a method the owner has not
 * allowed offline. Returns the methods not allowed (empty = allowed).
 */
export function offlineRefundBlockedMethods(
  legs: Array<{ method?: string | null }>, rules: Pick<ReversalRules, 'offlineRefundMethods'>,
): string[] {
  const allowed = new Set(rules.offlineRefundMethods.map((m) => m.toLowerCase()));
  const out: string[] = [];
  for (const l of legs ?? []) {
    const m = String(l?.method ?? '').trim().toLowerCase() || 'cash';
    if (!allowed.has(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Offline, may this till reverse this sale? Its own sales always; a web sale only with 'offline_reverse_web_sales'. */
export function offlineScopeAllows(origin: string | null | undefined, rules: Pick<ReversalRules, 'offlineReverseWebSales'>): boolean {
  return origin !== 'web' || rules.offlineReverseWebSales;
}

/** "30 minutes", "1 hour", "1 hour 30 minutes" — for the window's messages. */
export function windowLabel(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const hs = h ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const ms = m ? `${m} minute${m === 1 ? '' : 's'}` : '';
  return [hs, ms].filter(Boolean).join(' ') || '0 minutes';
}
