/**
 * updater.ts — the in-app updater (docs/ANDROID-APP-DESIGN.md §1.4): ask the cloud which version this business is
 * approved for, download only that APK, check its SHA-256, and hand it to Android's installer. Android always shows its
 * own "Update this app?" prompt, and refuses an APK not signed with ZapTill's key.
 *
 * When: the rule is updateVerdict (@zaptill/core/androidApp) — never past the approved version; a Shop POS only between
 * shifts (shiftIsOpen() below: Till stage 1 asks the cloud for this POS's drawer), an owner's phone whenever the owner
 * taps Update.
 */
import { updateVerdict, type AndroidUpdateOffer, type AndroidUpdateStatus, type UpdateVerdict } from '@zaptill/core/androidApp';
import { apiUrl, cloudGet } from '../cloud/client';
import { surfaceOf, type DeviceMode } from '../device/mode';
import { ApkUpdater } from '../native/plugins';
import { readTill, tillToken } from '../shop/tillSession';

/** A downloaded update is not needed once the app starts again (it installed, or the person cancelled): removed at every
 * start and on Reset app. */
export async function forgetDownloads(): Promise<void> {
  try { await ApkUpdater.clearDownloads(); } catch { /* not on Android (a browser preview) */ }
}

/**
 * Till stage 1: is this Shop POS's drawer open? Asked with the POS's own session (its drawer is keyed to its device id).
 * When it cannot be told (no connection), it counts as open — an update never risks a running shift.
 */
export async function shiftIsOpen(mode: DeviceMode): Promise<boolean> {
  if (mode !== 'shop-pos' || !(await readTill())) return false;
  try {
    const { token, till } = await tillToken();
    return !!(await cloudGet<unknown>(`/shifts/current?branch_id=${encodeURIComponent(till.branchId)}`, token, { 'x-device-id': till.deviceId }));
  } catch { return true; }
}

/** The session the cloud answers for: a joined Shop POS's own (Till stage 1); none yet for an owner's phone (Owner stage A). */
async function sessionToken(mode: DeviceMode): Promise<string | null> {
  if (mode !== 'shop-pos' || !(await readTill())) return null;
  try { return (await tillToken()).token; } catch { return null; }
}

export interface UpdateCheck { status: AndroidUpdateStatus; verdict: UpdateVerdict }

export async function checkForUpdate(mode: DeviceMode, currentVersion: string): Promise<UpdateCheck> {
  const surface = surfaceOf(mode);
  const status = await cloudGet<AndroidUpdateStatus>(`/app-update/android/status?surface=${surface}`, await sessionToken(mode));
  return { status, verdict: updateVerdict({ current: currentVersion, status, shiftOpen: await shiftIsOpen(mode) }) };
}

export type InstallStep = 'permission' | 'downloading' | 'installing';

/**
 * Download, verify and install the offer. Asks for "Install unknown apps" first when Android has not allowed it (the
 * person comes back and taps Update again). Throws with the reason when anything fails; nothing half-downloaded is kept.
 */
export async function installUpdate(mode: DeviceMode, offer: AndroidUpdateOffer, onStep: (s: InstallStep) => void): Promise<'installing' | 'needs-permission'> {
  if (!(await ApkUpdater.canInstall()).allowed) {
    onStep('permission');
    await ApkUpdater.openInstallSettings();
    return 'needs-permission';
  }
  onStep('downloading');
  const token = await sessionToken(mode);
  const { path } = await ApkUpdater.download({
    url: apiUrl(offer.downloadPath), sha256: offer.sha256, fileName: offer.fileName,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  onStep('installing');
  await ApkUpdater.install({ path });
  return 'installing';
}
