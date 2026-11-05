/**
 * updater.ts — the in-app updater (docs/ANDROID-APP-DESIGN.md §1.4): ask the cloud which version this business is
 * approved for, download only that APK, check its SHA-256, and hand it to Android's installer. Android always shows its
 * own "Update this app?" prompt, and refuses an APK not signed with ZapTill's key.
 *
 * When: the rule is updateVerdict (@zaptill/core/androidApp) — never past the approved version; a Shop POS only between
 * shifts (shiftIsOpen() below is Stage 0's hook: there are no shifts yet), an owner's phone whenever the owner taps
 * Update.
 */
import { updateVerdict, type AndroidUpdateOffer, type AndroidUpdateStatus, type UpdateVerdict } from '@zaptill/core/androidApp';
import { apiUrl, cloudGet } from '../cloud/client';
import { surfaceOf, type DeviceMode } from '../device/mode';
import { ApkUpdater } from '../native/plugins';

/** A downloaded update is not needed once the app starts again (it installed, or the person cancelled): removed at every
 * start and on Reset app. */
export async function forgetDownloads(): Promise<void> {
  try { await ApkUpdater.clearDownloads(); } catch { /* not on Android (a browser preview) */ }
}

/** Till stage 1 answers this from the POS's drawer; Stage 0 has no shifts. */
export async function shiftIsOpen(): Promise<boolean> { return false; }

/** Stage 0 has no sign-in; Owner stage A and Till stage 1 return the session here (device/secrets.ts). */
async function sessionToken(): Promise<string | null> { return null; }

export interface UpdateCheck { status: AndroidUpdateStatus; verdict: UpdateVerdict }

export async function checkForUpdate(mode: DeviceMode, currentVersion: string): Promise<UpdateCheck> {
  const surface = surfaceOf(mode);
  const status = await cloudGet<AndroidUpdateStatus>(`/app-update/android/status?surface=${surface}`, await sessionToken());
  return { status, verdict: updateVerdict({ current: currentVersion, status, shiftOpen: await shiftIsOpen() }) };
}

export type InstallStep = 'permission' | 'downloading' | 'installing';

/**
 * Download, verify and install the offer. Asks for "Install unknown apps" first when Android has not allowed it (the
 * person comes back and taps Update again). Throws with the reason when anything fails; nothing half-downloaded is kept.
 */
export async function installUpdate(offer: AndroidUpdateOffer, onStep: (s: InstallStep) => void): Promise<'installing' | 'needs-permission'> {
  if (!(await ApkUpdater.canInstall()).allowed) {
    onStep('permission');
    await ApkUpdater.openInstallSettings();
    return 'needs-permission';
  }
  onStep('downloading');
  const token = await sessionToken();
  const { path } = await ApkUpdater.download({
    url: apiUrl(offer.downloadPath), sha256: offer.sha256, fileName: offer.fileName,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  onStep('installing');
  await ApkUpdater.install({ path });
  return 'installing';
}
