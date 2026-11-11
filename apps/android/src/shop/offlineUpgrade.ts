/**
 * offlineUpgrade.ts — Till stage 2: the PIN of an OFFLINE sign-in is HELD (secrets.ts 'pos.heldPin') and verified with the
 * cloud the moment the connection returns, exactly as the desktop does (A345, apps/desktop/src/main/offlineSession.ts).
 * The held PIN never leaves the Keystore and is never re-entered: on reconnect the provisional session becomes a real
 * cloud session, or — a PIN changed or disabled on the web — the person is signed out here, once reconnected.
 *
 * The pure decisions live in shop/offlinePin.ts (beginOfflineSignIn, upgradeDecision), tested without a device; this is
 * the thin wiring over the Keystore and the cloud call.
 */
import { readSecret, saveSecret, removeSecret } from '../device/secrets';
import { readTill, tillToken } from './tillSession';
import { verifyPinRaw } from './pinSignIn';
import { type HeldPin, type UpgradeOutcome, upgradeDecision } from './offlinePin';

export async function holdPin(held: HeldPin): Promise<void> { await saveSecret('pos.heldPin', JSON.stringify(held)); }

export async function readHeldPin(): Promise<HeldPin | null> {
  const raw = await readSecret('pos.heldPin');
  if (!raw) return null;
  try { return JSON.parse(raw) as HeldPin; } catch { return null; }
}

export async function clearHeldPin(): Promise<void> { await removeSecret('pos.heldPin'); }

/**
 * Turn a held offline sign-in into a real cloud session, now the POS is back online. Returns null when there is nothing to
 * upgrade (an online sign-in left no held PIN, or it was already upgraded). The held PIN is cleared on 'upgraded' and
 * 'rejected'; a 'retry' keeps it (no answer / the cloud was busy) to try again on the next reconnect.
 */
export async function attemptUpgrade(appVersion: string): Promise<UpgradeOutcome | null> {
  const held = await readHeldPin();
  if (!held) return null;
  const till = await readTill();
  if (!till) { await clearHeldPin(); return null; }     // the POS was reset — nothing to upgrade
  const { token } = await tillToken();
  const answer = await verifyPinRaw(held.pin, till, token, appVersion);
  const outcome = upgradeDecision(held, till, answer);
  if (outcome.state === 'upgraded' || outcome.state === 'rejected') await clearHeldPin();
  return outcome;
}
