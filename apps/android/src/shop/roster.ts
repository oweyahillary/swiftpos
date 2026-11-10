/**
 * roster.ts — Till stage 2 cold-start, the sign-in half: keep the branch's staff ROSTER fresh while online, so a person
 * can sign in at the Shop POS from a cold boot with no connection (shop/offlinePin.ts holds the pure model and the cache).
 *
 * The cloud's GET /api/pos/branch-staff (apps/server routes/pos.ts — the list every POS keeps, A446) returns each active
 * person at this branch with their effective permissions and their bcrypt pin_hash (the "Keystore verifier"). We pull it
 * with the POS's own token and cache it keyed by branch. Best-effort: a miss just means the roster is refreshed the next
 * time the POS is online, and an offline sign-in is offered only for people already cached.
 */
import { cloudGet } from '../cloud/client';
import { tillToken } from './tillSession';
import { cacheRoster, rosterFromWire } from './offlinePin';

interface BranchStaffAnswer { branch_id?: string; version?: string; unchanged?: boolean; staff?: unknown }

/** Pull the branch roster with the POS's own token and cache it for an offline sign-in. Never throws. */
export async function refreshRoster(): Promise<void> {
  try {
    const { token, till } = await tillToken();
    const ans = await cloudGet<BranchStaffAnswer>('/pos/branch-staff', token, { 'x-device-id': till.deviceId });
    if (!ans || ans.unchanged || !Array.isArray(ans.staff)) return;   // nothing new, or nothing to cache
    await cacheRoster(till.branchId, rosterFromWire(ans.staff));
  } catch { /* best-effort: the roster is refreshed the next time the POS is online */ }
}
