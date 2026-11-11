/**
 * offlinePin.ts — Till stage 2 (docs/ANDROID-APP-DESIGN.md §4.4, §5 Till stage 2): a person signs in at the Shop POS
 * while it is OFFLINE, and the sign-in is confirmed with the cloud the moment the connection returns.
 *
 * The model is the desktop's (A345, apps/desktop/src/main/offlineSession.ts), which the one-POS rule says to reuse:
 *   • While online, the tablet caches the branch's staff ROSTER (id, name, role, permissions, and the bcrypt pin_hash as
 *     the "Keystore verifier") in secure storage.
 *   • Offline, the person PICKS their name and enters their PIN. A provisional cashier session is granted and the PIN is
 *     HELD (never written beyond secure storage). Sales they ring are facts — they replay like any other (shop/replay).
 *   • When the connection returns, the held PIN is replayed to POST /api/auth/verify-pin, exactly as an online sign-in:
 *       upgraded → the provisional session becomes a real cloud session (no second PIN entry);
 *       rejected → a PIN changed or disabled on the web is refused HERE, once reconnected (the Stage 2 hardware test).
 *
 * `verifyLocally` is a seam: with no extra dependency it returns 'deferred' (the gate is the reconnect upgrade, as the
 * desktop does when it has no cloud). Adding bcryptjs lets it check the cached pin_hash to also gate a PIN offline — a
 * supervised follow-up (the Android app uses npm ci, so a dependency needs a lockfile update). Pure decisions are split
 * out (beginOfflineSignIn, upgradeDecision) so they are tested without a device.
 */
import { cashierSessionFrom } from './rules';

export interface RosterStaff {
  id: string;
  name: string;
  role: string | null;
  permissions: Record<string, boolean>;
  /** The bcrypt pin_hash the POS staff pull returns — the "Keystore verifier" for a later offline check. */
  pinHash?: string | null;
}

export type CashierSession = ReturnType<typeof cashierSessionFrom>;

/** The PIN held until the connection returns (never leaves secure storage; upgraded, never re-entered). */
export interface HeldPin { staffId: string; branchId: string; pin: string }

/** A local PIN check against the cached verifier. Default: deferred (no dependency) — the reconnect upgrade is the gate. */
export type VerifyLocally = (pinHash: string | null | undefined, pin: string) => 'ok' | 'no' | 'deferred';
export const deferVerify: VerifyLocally = () => 'deferred';

export class OfflinePinRefused extends Error {}

/** The provisional (offline) session's refresh-token chain id. It is NOT a real token — it tags the one session that a
 *  reconnect upgrade may take, so the upgrade (dispatched as the web POS's 'swiftpos:pos-token' event, matched on this
 *  chain id) can never land on a different person who has signed in since (ShopPos.tsx). */
export const OFFLINE_PENDING = 'offline-pending';

type Till = { branchId: string; branchName: string; businessType: string; currency: string };

/**
 * Begin an offline sign-in (PURE). The person named `staffId` from the cached roster and typed `pin`. Returns the
 * provisional session (no token) and the PIN to hold. Throws OfflinePinRefused when the person is not in the cached
 * roster, or when a local verifier is supplied and says no.
 */
export function beginOfflineSignIn(
  roster: readonly RosterStaff[], till: Till, staffId: string, pin: string, verify: VerifyLocally = deferVerify,
): { session: CashierSession; held: HeldPin } {
  const who = roster.find((s) => s.id === staffId);
  if (!who) throw new OfflinePinRefused('This person is not on this POS yet. Sign in once while online, then they can sign in offline.');
  if (verify(who.pinHash, pin) === 'no') throw new OfflinePinRefused('That PIN is not right.');
  const session = cashierSessionFrom({ staff: { id: who.id, name: who.name, role: who.role }, permissions: who.permissions }, till);
  // Tag the provisional session's chain (refreshToken) so ONLY it takes the reconnect upgrade — never another person who
  // has signed in since. It is not a usable token (there are no 401s offline; the upgrade replaces it with a real pair).
  return { session: { ...session, refreshToken: OFFLINE_PENDING }, held: { staffId: who.id, branchId: till.branchId, pin } };
}

/** What a reconnect verify answer means for a held offline sign-in (PURE), mirroring the desktop's upgrade (A345). */
export type UpgradeOutcome =
  | { state: 'upgraded'; session: CashierSession }
  | { state: 'rejected'; reason: string }     // a PIN changed / disabled on the web — sign the person out, a manager re-signs
  | { state: 'retry' };                        // no answer / cloud busy — the offline session carries on; try again

export function upgradeDecision(
  held: HeldPin, till: Till,
  r: { status: number; body: { staff?: { id: string; name: string; role?: string | null }; permissions?: Record<string, boolean>; accessToken?: string; token?: string; refreshToken?: string; error?: string } | null },
): UpgradeOutcome {
  if (r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500) return { state: 'retry' };
  if (r.status >= 200 && r.status < 300 && r.body?.staff && (r.body.accessToken || r.body.token)) {
    if (r.body.staff.id !== held.staffId) return { state: 'rejected', reason: 'The cloud named a different person for that PIN. Please sign in again.' };
    return { state: 'upgraded', session: cashierSessionFrom(r.body as { staff: { id: string; name: string; role?: string | null } }, till) };
  }
  return { state: 'rejected', reason: r.body?.error || 'That PIN was refused when the POS reconnected. Please sign in again.' };
}

/**
 * The branch-staff rows the cloud sends (GET /api/pos/branch-staff — apps/server routes/pos.ts) mapped to the roster this
 * POS caches. PURE. Keeps only a usable row (an id, a name, and a bcrypt pin_hash the server already filtered to), so an
 * offline sign-in is never offered for a person who could not be upgraded on reconnect.
 */
export function rosterFromWire(rows: unknown): RosterStaff[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const o = (r && typeof r === 'object') ? r as Record<string, unknown> : {};
    const id = typeof o.staff_id === 'string' ? o.staff_id : '';
    const name = typeof o.name === 'string' ? o.name : '';
    if (!id || !name) return [];
    const permissions = (o.permissions && typeof o.permissions === 'object') ? o.permissions as Record<string, boolean> : {};
    const role = typeof o.role_name === 'string' ? o.role_name : null;
    const pinHash = typeof o.pin_hash === 'string' ? o.pin_hash : null;
    return [{ id, name, role, permissions, pinHash }];
  });
}

// ── the roster cache (secure storage) ────────────────────────────────────────────────────────────────────────────────

const rosterKey = (branchId: string) => `zaptill.roster.${branchId}`;

/** Cache the branch's roster while online, for an offline sign-in. Pulled from the POS staff list (id, name, role,
 *  permissions, pin_hash). Kept in Preferences keyed by branch; cleared by Reset app. */
export async function cacheRoster(branchId: string, staff: readonly RosterStaff[]): Promise<void> {
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: rosterKey(branchId), value: JSON.stringify(staff) });
}

export async function readRoster(branchId: string): Promise<RosterStaff[]> {
  const { Preferences } = await import('@capacitor/preferences');
  const { value } = await Preferences.get({ key: rosterKey(branchId) });
  if (!value) return [];
  try { return JSON.parse(value) as RosterStaff[]; } catch { return []; }
}
