/**
 * mode.ts — what this device is, chosen once at first launch (docs/ANDROID-APP-DESIGN.md §2).
 *
 *   shop-pos      a shop tablet at the counter that sells; the cloud's surface 'android-till'
 *   owner-phone   a person's own phone or tablet, for reports and quick tasks; the surface 'mobile'
 *
 * Fixed until Reset app: a person's sign-in never lives on a Shop POS, and a Shop POS's sign-in never belongs to a person
 * (A415). The mode is not a secret, so it is kept in the app's preferences; the secrets are in device/secrets.ts.
 */
import { Preferences } from '@capacitor/preferences';
import type { AndroidSurface } from '@zaptill/core/androidApp';

export type DeviceMode = 'shop-pos' | 'owner-phone';

const MODE_KEY = 'zaptill.mode';

export function isDeviceMode(v: unknown): v is DeviceMode { return v === 'shop-pos' || v === 'owner-phone'; }

export function surfaceOf(mode: DeviceMode): AndroidSurface { return mode === 'shop-pos' ? 'android-till' : 'mobile'; }

export async function readMode(): Promise<DeviceMode | null> {
  const { value } = await Preferences.get({ key: MODE_KEY });
  return isDeviceMode(value) ? value : null;
}

export async function saveMode(mode: DeviceMode): Promise<void> {
  await Preferences.set({ key: MODE_KEY, value: mode });
}

/** Every preference this app keeps (the mode and anything later stages add). */
export async function clearPreferences(): Promise<void> { await Preferences.clear(); }
