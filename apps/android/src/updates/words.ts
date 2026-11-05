/**
 * words.ts — what the app says about updates. Pure (tests/android-stage0-app.test.mjs runs it as it is). "POS", never
 * "till" (A586).
 */
import type { AndroidUpdateStatus, UpdateVerdict } from '@zaptill/core/androidApp';

export function updateSummary(verdict: UpdateVerdict, status: AndroidUpdateStatus): string {
  switch (verdict.kind) {
    case 'held':
      if (!status.signedIn) {
        return status.latestVersion
          ? `ZapTill answered. Updates start once this device is joined to your business (newest release: ${status.latestVersion}).`
          : 'ZapTill answered. Updates start once this device is joined to your business.';
      }
      return 'Up to date. ZapTill approves each update for your business before it reaches this device.';
    case 'current':
      return 'Up to date.';
    case 'not-ready':
      return `Version ${verdict.version} is approved, but its file is not ready yet. Try again later.`;
    case 'wait-for-shift':
      return `Version ${verdict.version} is ready. It installs after the shift is closed — never during service.`;
    case 'ready':
      return `Version ${verdict.offer.version} is ready to install.`;
  }
}

/** "12.3 MB", or nothing when the size is not known. */
export function sizeLabel(bytes: number | null): string {
  return bytes ? `${(bytes / 1_048_576).toFixed(1)} MB` : '';
}
