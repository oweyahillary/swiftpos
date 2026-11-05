/**
 * secrets.ts — the app's secrets, encrypted with keys held in the Android Keystore.
 *
 * Backed by @aparajita/capacitor-secure-storage (docs/ANDROID-APP-DESIGN.md "Stage 0 — built" says why): each value is
 * encrypted with AES-256-GCM under a key that lives in the AndroidKeyStore and never leaves it; only the ciphertext is
 * stored, in the app's private preferences (and the app opts out of Android backups, AndroidManifest.xml). The honest
 * limit (§4.4, pinch point 8): it defeats a copied database, a stolen backup and a pulled flash chip — not code running as
 * the app on an unlocked, rooted device.
 *
 * Stage 0 stores nothing yet; Owner stage A keeps the refresh token here, Till stage 1 the POS's own session and device
 * secret (A407). Names are listed here, so Reset app and a reader of the code see every secret the app can hold.
 */
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export type SecretName = 'session.refresh' | 'device.secret';

export async function readSecret(name: SecretName): Promise<string | null> { return SecureStorage.getItem(name); }

export async function saveSecret(name: SecretName, value: string): Promise<void> { await SecureStorage.setItem(name, value); }

/** Every secret this app stored (Reset app). */
export async function clearSecrets(): Promise<void> { await SecureStorage.clear(); }
