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
  // 0.6.28 (owner, 2026-10-01: a sent order cancelled after the customer paid in cash — "the cashier pockets the money").
  {
    key: 'kitchen_void_approval',
    label: 'Kitchen voids need a manager',
    description: 'Once items are sent to the kitchen, removing or reducing them needs a manager (signed in, or their PIN) and a reason. A shift cannot end while a sent order is unpaid.',
  },
  {
    key: 'pay_before_kitchen',
    label: 'Pay before kitchen',
    description: 'Takeaway, delivery and counter orders go to the kitchen only when paid (Send to kitchen is not offered). Dine-in tables still send first and pay at the end.',
  },
] as const;

/**
 * 0.6.29 — were switches in 0.6.27, now STANDARD for every client (owner, 2026-10-01: "cashiers should never see this only
 * the manager should be able to"; the manager's confirm table always shows the cashier's figures). Always on; the admin
 * portal no longer lists them, and a stored `feature_flags` row for either is ignored.
 *   blind_shift_close             — a cashier never sees sales, per-method totals or expected cash (a manager sees all);
 *   confirm_shows_cashier_figures — at confirm the manager sees the cashier's figure per method, keys in their own, and
 *                                   gives a reason where they differ.
 */
export const STANDARD_POS_FEATURES = ['blind_shift_close', 'confirm_shows_cashier_figures'] as const;

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
