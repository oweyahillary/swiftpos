/**
 * androidVersions.ts — the words of the admin portal's "ZapTill for Android" card (AndroidAppCard.tsx), kept apart from
 * the JSX so tests/android-stage0-admin.test.mjs runs them as they are.
 */
import { ANDROID_SURFACE_LABELS, compareAppVersions, isAppVersion, type AndroidSurface } from "@zaptill/core/androidApp";

export interface AndroidReleaseView {
  version: string; draft: boolean; prerelease: boolean; complete: boolean; missing: string[];
  sha256: string | null; size: number | null; published_at: string | null;
}

/** One surface's line: what its devices may run, and whether a newer release waits for approval. */
export function surfaceLine(surface: AndroidSurface, approved: string | null, latest: string | null): string {
  const who = ANDROID_SURFACE_LABELS[surface];
  if (!approved) {
    return latest
      ? `${who}: held — nothing approved; ${latest} is the newest release.`
      : `${who}: held — nothing approved, and no release yet.`;
  }
  const newer = latest && isAppVersion(latest) && compareAppVersions(latest, approved) > 0 ? ` ${latest} is out — not approved yet.` : "";
  return `${who}: approved ${approved}. Devices older than it update to it (a Shop POS between shifts).${newer}`;
}

/** The picker's label for a release: its version, and why it cannot be chosen when it cannot. */
export function releaseOption(r: AndroidReleaseView): string {
  const tag = r.draft ? " (draft)" : r.prerelease ? " (pre-release)" : "";
  return `${r.version}${tag}${r.complete && !r.draft ? "" : ` — ${r.draft ? "a draft" : `missing ${r.missing.join(", ")}`}`}`;
}

/** Only a complete, published release can be approved or downloaded. */
export const approvable = (r: AndroidReleaseView): boolean => r.complete && !r.draft;
