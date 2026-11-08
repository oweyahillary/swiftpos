/**
 * pinSignIn.ts — a person signs in at the Shop POS with their PIN (Till stage 1, online; the offline PIN check is Till
 * stage 2). docs/ANDROID-APP-DESIGN.md §4.4: POST /api/auth/verify-pin WITH the POS's own session (A415) — the cloud
 * answers with that person's session (a PIN sign-in on a POS: A159 bounds what it may write) and their permissions.
 * Owners and managers use their PIN here too, as at a desktop POS (§2).
 */
import { CloudError, cloudPost } from '../cloud/client';
import { cashierSessionFrom, pinRefusal } from './rules';
import { tillToken } from './tillSession';

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
