/**
 * posFeatures.ts — 0.6.27: switches a client's POS behaviour on or off, per client, from the admin portal.
 *
 * Owner, 2026-09-30 (a prospect's requests): "we can find a way of turning this features on and off per clients requests
 * rather than killing some of them totally". Decided: the admin portal switches them (the client cannot); every switch is
 * OFF unless set, so an existing client sees no change. Stored as `feature_flags` rows (business_id, key, enabled); the
 * till and the web POS receive them with pos/init (`posFeatures`), and a branch node relays them to its peers.
 *
 * ONE file: shared/posFeatures.ts, copied to the till, the web, the cloud and the admin portal (scripts/check-shared-sync.mjs).
 */

export const POS_FEATURES = [
  {
    key: 'delivery_fee',
    label: 'Delivery fee and rider',
    description: 'Delivery orders need the rider’s name and a delivery fee. The customer pays the fee on top of the bill (not sales); the rider is paid it in cash from the drawer, recorded automatically.',
  },
  {
    key: 'cashier_own_history',
    label: 'Cashiers see only their own sales',
    description: 'In History a cashier sees only the sales they rang. Managers see all.',
  },
  {
    key: 'cashier_no_reprint',
    label: 'No reprint for cashiers',
    // 0.6.37 (owner, 2026-10-03: "never reprints a receipt"): now always so — the switch no longer changes anything.
    description: 'Always on since 0.6.37: cashiers never reprint a receipt from History. Managers can.',
  },
  // A461 (owner, 2026-10-13: "some of their clients can eat today and pay later, that meal remains on hold till it's paid …
  // so the cashier should be able to close with the held items, but let it be a switch turned off by default").
  {
    key: 'pay_later_tabs',
    label: 'Eat now, pay later',
    description: 'A cashier may end a shift while orders sent to the kitchen are still unpaid — a customer who pays a day or more later. The order stays on hold, listed, until it is charged. Off: a shift cannot end while a sent order is unpaid.',
  },
  {
    key: 'pay_before_kitchen',
    label: 'Pay before kitchen',
    description: 'Takeaway, delivery and counter orders go to the kitchen only when paid (Send to kitchen is not offered). Dine-in tables still send first and pay at the end.',
  },
  // A398 (owner, 2026-10-05: "on the otp right now it locks everyone some are not using real email can we add as a
  // feature i can turn on and off in the admin panel"). Off unless the admin portal turns it on, like every switch here.
  // The admin portal's own admins always enter a code; a till never does (enrolment and PIN).
  {
    key: 'login_codes',
    label: 'Sign-in codes (OTP)',
    description: 'The owner (dashboard) and managers (web POS) enter a 6-digit code after their password — emailed, or from an authenticator app. Turn on only when everyone it applies to has a real email address or an authenticator app.',
  },
  // A453 (owner, 2026-10-12: "can we remove record expense and cash movement from cashier, is it a right they are given
  // or we add it as a feature"). Until now every cashier could record them (a manager approving with a PIN, 0.6.37).
  {
    key: 'cashier_no_money_out',
    label: 'Only managers record expenses and cash in / out',
    description: 'Cashiers no longer record an expense, a pay-in or a pay-out on the till or the web POS — not even with a manager’s PIN. A manager signed in records them (the till’s shift screen and Manager › Expenses, the web POS). The delivery rider’s automatic pay-out still happens.',
  },
] as const;

/**
 * 0.6.29 — were switches in 0.6.27, now STANDARD for every client (owner, 2026-10-01: "cashiers should never see this only
 * the manager should be able to"; the manager's confirm table always shows the cashier's figures). Always on; the admin
 * portal no longer lists them, and a stored `feature_flags` row for either is ignored.
 *   blind_shift_close             — a cashier never sees sales, per-method totals or expected cash (a manager sees all);
 *   confirm_shows_cashier_figures — at confirm the manager sees the cashier's figure per method, keys in their own, and
 *                                   gives a reason where they differ.
 *   kitchen_void_approval         — A461 (owner, 2026-10-13: cashiers voided items sent to the kitchen without a manager —
 *                                   the switch was off; "always on for everyone"): removing or reducing anything already
 *                                   sent to the kitchen needs a manager (signed in, or their PIN) and a reason; a shift
 *                                   cannot end while a sent order is unpaid — unless the client has 'pay_later_tabs' (eat
 *                                   now, pay later). Was a switch since 0.6.28 (a sent order cancelled after the customer
 *                                   paid in cash — "the cashier pockets the money").
 */
export const STANDARD_POS_FEATURES = ['blind_shift_close', 'confirm_shows_cashier_figures', 'kitchen_void_approval'] as const;

export type PosFeatureKey = (typeof POS_FEATURES)[number]['key'] | (typeof STANDARD_POS_FEATURES)[number];
export type PosFeatures = Record<PosFeatureKey, boolean>;

/** The keys the admin portal switches (the standard ones are not among them). */
export const POS_FEATURE_KEYS: readonly PosFeatureKey[] = POS_FEATURES.map((f) => f.key);

/** Every switch off — what a client has until the admin portal turns one on. The standard ones are always on. */
export function noPosFeatures(): PosFeatures {
  return Object.fromEntries([
    ...POS_FEATURE_KEYS.map((k) => [k, false]),
    ...STANDARD_POS_FEATURES.map((k) => [k, true]),
  ]) as PosFeatures;
}

/** A453: shown where a cashier would have recorded an expense or cash in / out. */
export const MONEY_MOVEMENT_MANAGER_ONLY = 'Expenses and cash in / out are recorded by a manager — ask a manager to sign in.';

/**
 * A453: may the person at the POS record an expense, a pay-in or a pay-out? A manager signed in always may; anyone else
 * only while 'cashier_no_money_out' is off (then, as before, a pay-out or an expense still needs a manager's PIN).
 */
export function mayRecordMoneyMovement(features: Pick<PosFeatures, 'cashier_no_money_out'>, signedInManager: boolean): boolean {
  return signedInManager || !features.cashier_no_money_out;
}

/**
 * The switches from whatever carried them: `feature_flags` rows ([{ key, enabled }]), an object ({ key: true }), or its
 * JSON text. Only a real `true` turns a switch on; unknown keys are dropped; anything unreadable is all off.
 */
export function parsePosFeatures(raw: unknown): PosFeatures {
  const out = noPosFeatures();
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return out; } }
  if (Array.isArray(v)) {
    for (const r of v) {
      const k = (r as { key?: unknown })?.key;
      if (typeof k === 'string' && (POS_FEATURE_KEYS as readonly string[]).includes(k)) {
        out[k as PosFeatureKey] = (r as { enabled?: unknown }).enabled === true;
      }
    }
    return out;
  }
  if (v && typeof v === 'object') {
    for (const k of POS_FEATURE_KEYS) out[k] = (v as Record<string, unknown>)[k] === true;
  }
  return out;
}
