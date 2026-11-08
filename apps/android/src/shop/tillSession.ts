/**
 * tillSession.ts — the Shop POS's OWN sign-in (A415; Till stage 1, docs/ANDROID-APP-DESIGN.md §11): the tablet, its
 * business and its branch, and no person. Kept in the Keystore (device/secrets.ts 'pos.session', 'device.secret').
 *
 *   joinWithCode   the technician's enrolment code from the admin portal (A69) → POST /api/auth/enrol/redeem, naming the
 *                  surface 'android-till' and the role 'till' (a POS seat, Q2)
 *   tillToken      the session's access token, renewed a minute before it runs out (/api/auth/refresh, then /refresh/ack —
 *                  A477); a refused session signs back in with the device secret (/api/auth/device-token — A407)
 *
 * A person's PIN sign-in (shop/pinSignIn.ts) is asked WITH this session; a person's session never lives here.
 */
import { Preferences } from '@capacitor/preferences';
import { cloudGet, cloudPost, CloudError } from '../cloud/client';
import { readSecret, removeSecret, saveSecret } from '../device/secrets';
import { needsRenewal } from './rules';

/** What the tablet keeps about itself once joined. */
export interface PosSession {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  posName: string;
  businessId: string;
  businessName: string;
  businessType: string;
  currency: string;
  branchId: string;
  branchName: string;
}

const DEVICE_ID_KEY = 'zaptill.deviceId';

/** This tablet's device id: made once, kept until Reset app (not a secret — the cloud knows it as this POS). */
export async function deviceId(): Promise<string> {
  const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
  if (value) return value;
  const made = `android-${crypto.randomUUID()}`;
  await Preferences.set({ key: DEVICE_ID_KEY, value: made });
  return made;
}

export async function readTill(): Promise<PosSession | null> {
  const raw = await readSecret('pos.session');
  if (!raw) return null;
  try { return JSON.parse(raw) as PosSession; } catch { return null; }
}

async function saveTill(s: PosSession): Promise<void> { await saveSecret('pos.session', JSON.stringify(s)); }

/** The POS must be joined again by a technician (its session and its device secret were both refused). */
export class TillSignedOut extends Error {}

interface EnrolAnswer {
  accessToken: string; refreshToken: string; branchId: string | null; deviceSecret?: string;
  business: { id: string; name: string; currency?: string | null; type?: string | null };
}

/** The branch's name, for receipts and the screens — the POS's own session may read its branch. */
async function branchNameOf(token: string, id: string, branchId: string): Promise<string> {
  try {
    const rows = await cloudGet<Array<{ id: string; name: string }>>('/branches', token, { 'x-device-id': id });
    return (Array.isArray(rows) ? rows.find((b) => b.id === branchId)?.name : '') ?? '';
  } catch { return ''; }
}

/**
 * Join the business with the technician's enrolment code (directly, or the one a branch server fetched when someone
 * pressed Allow there — shop/branchServer.ts). Throws CloudError with the cloud's code on a refusal.
 */
export async function joinWithCode(a: { businessId: string; code: string; posName: string; appVersion: string }): Promise<PosSession> {
  const id = await deviceId();
  const r = await cloudPost<EnrolAnswer>('/auth/enrol/redeem', {
    business_id: a.businessId.trim(), code: a.code.trim().toUpperCase(), device_id: id,
    device_name: a.posName.trim(), device_role: 'till', surface: 'android-till', app_version: a.appVersion,
  });
  if (!r.branchId) throw new CloudError('That code is not for a branch. Issue a code for this branch in the admin portal.', 409, 'NO_BRANCH');
  if (r.deviceSecret) await saveSecret('device.secret', r.deviceSecret);
  const s: PosSession = {
    accessToken: r.accessToken, refreshToken: r.refreshToken, deviceId: id, posName: a.posName.trim(),
    businessId: r.business.id, businessName: r.business.name, businessType: r.business.type ?? 'retail',
    currency: r.business.currency ?? 'KES', branchId: r.branchId, branchName: await branchNameOf(r.accessToken, id, r.branchId),
  };
  await saveTill(s);
  return s;
}

interface RenewAnswer { accessToken: string; refreshToken?: string; deviceSecret?: string; ack?: boolean }

/** A477: the renewal, then its acknowledgement (the old token is revoked only once the new one is kept). */
async function renew(s: PosSession): Promise<PosSession> {
  const headers = { 'x-device-id': s.deviceId };
  try {
    const r = await cloudPost<RenewAnswer>('/auth/refresh', { refreshToken: s.refreshToken }, null, headers);
    const next = { ...s, accessToken: r.accessToken, refreshToken: r.refreshToken ?? s.refreshToken };
    await saveTill(next);
    if (r.deviceSecret) await saveSecret('device.secret', r.deviceSecret);
    if (r.ack && r.refreshToken) await cloudPost('/auth/refresh/ack', { refreshToken: r.refreshToken }, null, headers).catch(() => {});
    return next;
  } catch (e) {
    if (!(e instanceof CloudError) || e.status !== 401) throw e;   // no connection, or the cloud busy: keep the session
    return signBackIn(s);
  }
}

/** A407: the session was refused — the device secret signs the POS back in, or a technician must join it again. */
async function signBackIn(s: PosSession): Promise<PosSession> {
  const secret = await readSecret('device.secret');
  try {
    const r = await cloudPost<{ accessToken: string; refreshToken: string; branchId?: string | null }>('/auth/device-token', {
      business_id: s.businessId, device_id: s.deviceId, device_secret: secret ?? '', surface: 'android-till',
    }, null, { 'x-device-id': s.deviceId });
    const next = { ...s, accessToken: r.accessToken, refreshToken: r.refreshToken, branchId: r.branchId ?? s.branchId };
    await saveTill(next);
    return next;
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) throw new TillSignedOut('This POS is no longer joined to the business. A technician joins it again with a new enrolment code.');
    throw e;
  }
}

let renewing: Promise<PosSession> | null = null;

/** The POS's own access token, fresh. One renewal at a time (two would present the same refresh token twice — A506). */
export async function tillToken(): Promise<{ token: string; till: PosSession }> {
  const s = await readTill();
  if (!s) throw new TillSignedOut('This POS has not joined a business yet.');
  if (!needsRenewal(s.accessToken, Date.now())) return { token: s.accessToken, till: s };
  renewing ??= renew(s).finally(() => { renewing = null; });
  const next = await renewing;
  return { token: next.accessToken, till: next };
}

/** Forget the POS's sign-in (Reset app clears every secret anyway; this is for "join again"). */
export async function forgetTill(): Promise<void> {
  await removeSecret('pos.session');
  await removeSecret('device.secret');
}
