/**
 * androidApp.ts — the ZapTill Android app's shared rules (docs/ANDROID-APP-DESIGN.md, Stage 0).
 *
 * One APK, two modes chosen at first launch (§2): "Shop POS" (a shop tablet that sells — the cloud's surface
 * 'android-till') and "Owner / manager phone" (a person's own phone — the surface 'mobile'). Each surface's version is
 * approved per business by ZapTill in the admin portal, like the desktop (A348): nothing is approved by default, so a
 * new release reaches nobody until it is approved for that client.
 *
 * Used by the cloud (routes/appUpdate.ts, routes/adminAndroid.ts), the admin portal (AndroidAppCard) and the app itself
 * (apps/android/src), so the three agree on the names, the release layout and when an update may install.
 */

/** The cloud's names for the app's two modes. */
export const ANDROID_SURFACES = ['android-till', 'mobile'] as const;
export type AndroidSurface = (typeof ANDROID_SURFACES)[number];

/** What a person reads for each surface (never "till": the product says POS). */
export const ANDROID_SURFACE_LABELS: Record<AndroidSurface, string> = {
  'android-till': 'Shop POS',
  mobile: 'Owner / manager phone',
};

export function isAndroidSurface(v: unknown): v is AndroidSurface {
  return typeof v === 'string' && (ANDROID_SURFACES as readonly string[]).includes(v);
}

// ── Versions ───────────────────────────────────────────────────────────────────────────────────────────────────────

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/** Plain x.y.z only — what the approval columns' CHECK allows (migration 189). */
export function isAppVersion(v: unknown): v is string { return typeof v === 'string' && VERSION_RE.test(v); }

/** -1 / 0 / 1, numerically per part ("0.1.10" is newer than "0.1.9"). Callers validate with isAppVersion first. */
export function compareAppVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

// ── Releases (GitHub Releases today; the planned VPS later — docs/ANDROID-APP-DESIGN.md "Stage 0 — built") ──────────

/** An Android release is tagged android-v<x.y.z>, so it never mixes with the desktop's v<x.y.z> tags. */
export const ANDROID_TAG_PREFIX = 'android-v';

export function androidReleaseTag(version: string): string { return `${ANDROID_TAG_PREFIX}${version}`; }

/** The version of an android-v<x.y.z> tag, or null for any other tag (a desktop release, a typo). */
export function versionOfAndroidTag(tag: unknown): string | null {
  const t = String(tag ?? '');
  if (!t.startsWith(ANDROID_TAG_PREFIX)) return null;
  const v = t.slice(ANDROID_TAG_PREFIX.length);
  return isAppVersion(v) ? v : null;
}

/** The APK's file name in a release. */
export function apkFileName(version: string): string { return `ZapTill-${version}.apk`; }

/**
 * A SHA-256 as 64 lowercase hex characters, from GitHub's asset digest ("sha256:<hex>") or a bare hex string; null for
 * anything else. The app refuses an APK whose bytes do not hash to exactly this.
 */
export function normaliseSha256(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

// ── The cloud's answer to "which version may this device run?" ─────────────────────────────────────────────────────

/** The approved version's file, when the cloud can hand it out. */
export interface AndroidUpdateOffer {
  version: string;
  fileName: string;
  sha256: string;
  size: number | null;
  /** Relative to the cloud's /api — the app downloads it with its own session (a redirect to the file's short-lived link). */
  downloadPath: string;
}

/** GET /api/app-update/android/status */
export interface AndroidUpdateStatus {
  surface: AndroidSurface;
  /** Whether the cloud knew the business (a signed-in device). Signed out: nothing is approved, the latest is named. */
  signedIn: boolean;
  /** The version approved for this business and surface; null = held (the default). */
  approvedVersion: string | null;
  held: boolean;
  /** The newest complete release, for information ("1.2.0 is out; ask ZapTill to approve it"). */
  latestVersion: string | null;
  /** Present when the approved version's APK and its SHA-256 can be handed out. */
  offer: AndroidUpdateOffer | null;
  /** Why the releases could not be read, when they could not. */
  warning?: string | null;
}

export function downloadPathFor(version: string): string { return `/app-update/android/v/${version}/apk`; }

// ── When may the app update itself? ────────────────────────────────────────────────────────────────────────────────

export type UpdateVerdict =
  | { kind: 'held' }                                   // nothing approved for this business (or signed out)
  | { kind: 'current' }                                // already on (or past) the approved version
  | { kind: 'not-ready'; version: string }             // approved, but its APK cannot be handed out yet
  | { kind: 'wait-for-shift'; version: string }        // Shop POS: approved and ready, but a shift is open
  | { kind: 'ready'; offer: AndroidUpdateOffer };      // download, verify, hand to Android's installer

/**
 * The one rule for the in-app updater (§1.4): update only to the approved version, never past it and never "down" to it;
 * a Shop POS only between shifts (never mid-service); an owner's phone whenever the owner taps Update.
 */
export function updateVerdict(input: { current: string; status: AndroidUpdateStatus; shiftOpen: boolean }): UpdateVerdict {
  const { current, status, shiftOpen } = input;
  const approved = status.approvedVersion;
  if (!approved || !isAppVersion(approved)) return { kind: 'held' };
  if (isAppVersion(current) && compareAppVersions(current, approved) >= 0) return { kind: 'current' };
  const offer = status.offer;
  if (!offer || offer.version !== approved || !normaliseSha256(offer.sha256)) return { kind: 'not-ready', version: approved };
  if (status.surface === 'android-till' && shiftOpen) return { kind: 'wait-for-shift', version: approved };
  return { kind: 'ready', offer };
}

// ── Error and crash reports (POST /api/app-errors) ─────────────────────────────────────────────────────────────────

export const APP_ERROR_KINDS = ['crash', 'error'] as const;
export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

/** What the app sends; the cloud trims every field again (lib/appErrors.ts). */
export interface AppErrorReport {
  surface: AndroidSurface;
  kind: AppErrorKind;
  appVersion: string;
  message: string;
  stack?: string;
  /** "Android 14 (API 34), Samsung SM-T220" — no serial numbers, no names. */
  device?: string;
}

export const APP_ERROR_LIMITS = { message: 500, stack: 4000, device: 120 } as const;
