/**
 * appUpdate.ts — the ZapTill Android app's update feed, per business and surface (docs/ANDROID-APP-DESIGN.md, Stage 0).
 *
 * The desktop's A348, for a new surface: the app asks which version its business is approved for and downloads only
 * that APK, through the cloud. Nothing is approved by default (migration 189: NULL = hold).
 *
 *   GET /api/app-update/android/status?surface=android-till|mobile
 *       → AndroidUpdateStatus (@zaptill/core/androidApp): the approved version (null = held), the newest release, and —
 *         when the approved version's APK and SHA-256 can be handed out — the offer the app downloads and verifies.
 *       Signed in: the business and the surface come from the session (a POS's own session → 'android-till'; a person's
 *       → 'mobile'); the query cannot widen them. Signed out (Stage 0: the app has no sign-in yet): nothing is approved,
 *       the newest release is named — the app shows "Up to date as far as ZapTill knows" and proves the cloud answers.
 *   GET /api/app-update/android/v/:version/apk   (signed in)
 *       → 302 to the APK's short-lived link, only for the version approved for this business and surface; else 403.
 *         The app checks the SHA-256 from /status before it hands the file to Android's installer.
 */
import { downloadPathFor, isAndroidSurface, isAppVersion, type AndroidSurface, type AndroidUpdateStatus } from '@zaptill/core/androidApp';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { sessionIfSent } from '../middleware/sessionIfSent';
import { sendError } from '../lib/sendError';
import { assetDownloadUrl } from '../lib/desktopReleases';
import { approvableRelease, latestAndroidVersion, listAndroidReleasesOrStale, type AndroidRelease } from '../lib/androidReleases';
import { readAndroidApprovals } from '../lib/androidApproval';

const router = safeRouter();


/** The surface a session stands for: a POS's own session sells (Shop POS); a person's session is the owner mode. */
export function surfaceOfSession(req: { isTill?: boolean }): AndroidSurface {
  return req.isTill ? 'android-till' : 'mobile';
}

async function releasesOrWarning(): Promise<{ releases: AndroidRelease[]; warning: string | null }> {
  try { return await listAndroidReleasesOrStale(); }
  catch (e: any) { return { releases: [], warning: `Could not read the Android releases: ${e?.message ?? e}` }; }
}

router.get('/android/status', sessionIfSent, async (req, res) => {
  const signedIn = !!req.businessId;
  const surface = signedIn ? surfaceOfSession(req) : req.query.surface;
  if (!isAndroidSurface(surface)) {
    res.status(400).json({ error: "surface must be 'android-till' or 'mobile'", code: 'BAD_SURFACE' });
    return;
  }
  let approvedVersion: string | null = null;
  let approvalWarning: string | null = null;
  if (signedIn) {
    const { approvals, missing, error } = await readAndroidApprovals(req.businessId);
    if (error) { sendError(res, error); return; }
    approvedVersion = approvals[surface];
    if (missing) approvalWarning = 'Android approvals are not set up on this cloud yet (migration 189).';
  }
  const { releases, warning } = await releasesOrWarning();
  const rel = approvedVersion ? approvableRelease(releases, approvedVersion) : null;
  const body: AndroidUpdateStatus = {
    surface, signedIn, approvedVersion, held: approvedVersion === null,
    latestVersion: latestAndroidVersion(releases),
    offer: rel && rel.apk && rel.sha256
      ? { version: rel.version, fileName: rel.apk.name, sha256: rel.sha256, size: rel.size, downloadPath: downloadPathFor(rel.version) }
      : null,
    warning: approvalWarning ?? warning,
  };
  res.set('Cache-Control', 'no-store');
  res.json(body);
});

router.get('/android/v/:version/apk', requireAuth, async (req, res) => {
  const want = String(req.params.version);
  const surface = surfaceOfSession(req);
  const { approvals, error } = await readAndroidApprovals(req.businessId);
  if (error) { sendError(res, error); return; }
  if (!isAppVersion(want) || approvals[surface] !== want) {
    res.status(403).json({ error: 'This version is not approved for your business.', code: 'ANDROID_VERSION_NOT_APPROVED' });
    return;
  }
  let releases: AndroidRelease[];
  try { releases = (await listAndroidReleasesOrStale()).releases; }
  catch (e: any) { res.status(502).json({ error: `Update source unavailable: ${e?.message ?? e}` }); return; }
  const rel = approvableRelease(releases, want);
  if (!rel || !rel.apk) { res.status(404).json({ error: `ZapTill for Android ${want} is not available.`, code: 'ANDROID_RELEASE_MISSING' }); return; }
  let url: string;
  try { url = await assetDownloadUrl(rel.apk); }
  catch (e: any) { res.status(502).json({ error: `Update source unavailable: ${e?.message ?? e}` }); return; }
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url);
});

export default router;
