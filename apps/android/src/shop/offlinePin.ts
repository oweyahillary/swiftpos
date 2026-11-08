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
  return { session, held: { staffId: who.id, branchId: till.branchId, pin } };
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
