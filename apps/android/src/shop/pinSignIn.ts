/**
 * pinSignIn.ts — a person signs in at the Shop POS with their PIN (Till stage 1, online; the offline PIN check is Till
 * stage 2). docs/ANDROID-APP-DESIGN.md §4.4: POST /api/auth/verify-pin WITH the POS's own session (A415) — the cloud
 * answers with that person's session (a PIN sign-in on a POS: A159 bounds what it may write) and their permissions.
 * Owners and managers use their PIN here too, as at a desktop POS (§2).
 */
import { CloudError, cloudPost } from '../cloud/client';
import { cashierSessionFrom, pinRefusal } from './rules';
import { tillToken, type PosSession } from './tillSession';

interface VerifyPinAnswer {
  accessToken?: string; token?: string; refreshToken?: string;
  staff: { id: string; name: string; role?: string | null };
  permissions?: Record<string, boolean>;
}

export class PinRefused extends Error {}

/** The web POS screens' session for the person whose PIN this is. Throws PinRefused with words for the screen. */
export async function signInWithPin(pin: string, appVersion: string) {
  const { token, till } = await tillToken();
  try {
    const r = await cloudPost<VerifyPinAnswer>('/auth/verify-pin', {
      pin, branch_id: till.branchId, device_id: till.deviceId, device_name: till.posName, device_role: 'till', app_version: appVersion,
    }, token, { 'x-device-id': till.deviceId });
    return cashierSessionFrom(r, till);
  } catch (e) {
    if (e instanceof CloudError) throw new PinRefused(pinRefusal(e.status, e.code, e.message));
    throw e;
  }
}

/**
 * Till stage 2: verify a HELD offline PIN when the connection returns, as the raw answer upgradeDecision reads (never
 * throwing) — the same /auth/verify-pin call as a live sign-in, with the POS's own token. A refusal is the body/status the
 * upgrade needs to tell "a PIN changed on the web" (reject) from "the cloud was busy" (retry).
 */
export async function verifyPinRaw(pin: string, till: PosSession, token: string, appVersion: string): Promise<{ status: number; body: VerifyPinAnswer | { error?: string } | null }> {
  try {
    const body = await cloudPost<VerifyPinAnswer>('/auth/verify-pin', {
      pin, branch_id: till.branchId, device_id: till.deviceId, device_name: till.posName, device_role: 'till', app_version: appVersion,
    }, token, { 'x-device-id': till.deviceId });
    return { status: 200, body };
  } catch (e) {
    if (e instanceof CloudError) return { status: e.status, body: { error: e.message } };
    return { status: 0, body: null };   // no answer / transport failure → the upgrade retries, the session carries on
  }
}
