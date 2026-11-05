/**
 * androidReleases.ts — the ZapTill Android app's releases the cloud can hand out (docs/ANDROID-APP-DESIGN.md, Stage 0).
 *
 * Like the desktop (A348, lib/desktopReleases.ts): the app never reads GitHub itself. It asks the cloud which version its
 * business is approved for (routes/appUpdate.ts) and downloads that one APK through the cloud, which redirects to the
 * file's short-lived link — so GITHUB_RELEASES_TOKEN never leaves the cloud and the repository can be private.
 *
 * LAYOUT (.github/workflows/android.yml publishes it once the owner adds the release step):
 *   tag      android-v<x.y.z>          (never mixes with the desktop's v<x.y.z>)
 *   asset    ZapTill-<x.y.z>.apk       signed with ZapTill's release key
 * The SHA-256 is GitHub's own record of the asset (its `digest`, "sha256:<hex>"), so the hash the app checks comes from
 * GitHub, not from a file anyone could replace next to the APK. A release without an APK or without a digest is
 * INCOMPLETE: listed in the admin portal, never approvable, never handed out.
 */
import { androidReleaseTag, apkFileName, compareAppVersions, normaliseSha256, versionOfAndroidTag } from '@zaptill/core/androidApp';
import { fetchGitHubReleases, releasesRepo, type GhAsset, type GhRelease } from './desktopReleases';

export interface AndroidRelease {
  version: string;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  complete: boolean;
  /** What stops it being complete, in words (empty when complete). */
  missing: string[];
  /** The APK, when the release has one. */
  apk: GhAsset | null;
  sha256: string | null;
  size: number | null;
  publishedAt: string | null;
}

/** Which repository holds the Android releases: ANDROID_RELEASES_REPO, else the desktop's (one repository today). */
export function androidReleasesRepo(env: Record<string, string | undefined> = process.env): string {
  return String(env.ANDROID_RELEASES_REPO ?? '').trim() || releasesRepo();
}

/**
 * GitHub's release list → one entry per Android version, newest first. Desktop tags and anything else are ignored. When
 * a version has several releases, the published one is preferred over a draft, then the newest (as the desktop's A350).
 */
export function summariseAndroidReleases(releases: GhRelease[]): AndroidRelease[] {
  const byVersion = new Map<string, GhRelease>();
  for (const r of releases) {
    const v = versionOfAndroidTag(r.tag_name);
    if (!v) continue;
    const held = byVersion.get(v);
    const better = !held || (Number(!!r.draft) - Number(!!held.draft) || held.id - r.id) < 0;
    if (better) byVersion.set(v, r);
  }
  const out: AndroidRelease[] = [];
  for (const [version, r] of byVersion) {
    const apk = (r.assets ?? []).find((a) => a.name === apkFileName(version)) ?? null;
    const sha256 = apk ? normaliseSha256(apk.digest) : null;
    const missing: string[] = [];
    if (!apk) missing.push(apkFileName(version));
    else if (!sha256) missing.push('its SHA-256 (GitHub recorded no digest for the APK)');
    out.push({
      version, tag: androidReleaseTag(version), draft: !!r.draft, prerelease: !!r.prerelease,
      complete: missing.length === 0, missing, apk, sha256, size: apk?.size ?? null,
      publishedAt: r.published_at ?? null,
    });
  }
  return out.sort((a, b) => compareAppVersions(b.version, a.version));
}

/** The newest release an app may be given: complete and not a draft. */
export function latestAndroidVersion(releases: AndroidRelease[]): string | null {
  return releases.find((r) => r.complete && !r.draft)?.version ?? null;
}

/** The release a business may be approved for / handed: complete and not a draft. null = not approvable. */
export function approvableRelease(releases: AndroidRelease[], version: string): AndroidRelease | null {
  return releases.find((r) => r.version === version && r.complete && !r.draft) ?? null;
}

// ── GitHub I/O (thin; the rules above are the tested part) ────────────────────────────────────────────────────────────

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; repo: string; releases: AndroidRelease[] } | null = null;

export function clearAndroidReleaseCache(): void { cache = null; }

/**
 * The Android releases, cached 5 minutes (a fleet of devices costs GitHub one call). When GitHub refuses, the last good
 * list with a warning saying so (as the desktop's A356); throws only when there has never been a good read.
 */
export async function listAndroidReleasesOrStale(opts: { fresh?: boolean } = {}): Promise<{ releases: AndroidRelease[]; warning: string | null }> {
  const repo = androidReleasesRepo();
  if (!opts.fresh && cache && cache.repo === repo && Date.now() - cache.at < CACHE_MS) return { releases: cache.releases, warning: null };
  try {
    // 100: the desktop's pre-releases share the repository, so the Android tags are looked for in a wider window.
    const releases = summariseAndroidReleases(await fetchGitHubReleases(repo, 100));
    cache = { at: Date.now(), repo, releases };
    return { releases, warning: null };
  } catch (e: any) {
    if (cache && cache.repo === repo) {
      const mins = Math.max(1, Math.round((Date.now() - cache.at) / 60000));
      return { releases: cache.releases, warning: `${e?.message ?? e} Showing the list read ${mins} minute${mins === 1 ? '' : 's'} ago.` };
    }
    throw e;
  }
}
