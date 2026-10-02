/**
 * desktopUpdate.ts — A348 (2026-09-28): the tills' update feed, per business.
 *
 * Owner: "hold by default, per business, build 0.6.16". A till (0.6.16+) asks GET /status which version its business
 * is approved for (businesses.desktop_approved_version; null = hold). Only when that is newer than what it runs does it
 * point electron-updater's generic feed at /v/<approved>/ — which serves latest.yml, the installer and its blockmap for
 * EXACTLY that version, and only to a business approved for it. Each file is a redirect to GitHub (signed, short-lived
 * when GITHUB_RELEASES_TOKEN is set; the updater drops the till's Authorization header on the cross-host hop), so the
 * installer never streams through the cloud and the token never reaches a till. lib/desktopReleases.ts has the rules.
 */
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { assetDownloadUrl, assetFor, isVersion, listDesktopReleasesOrStale } from '../lib/desktopReleases';

const router = safeRouter();
router.use(requireAuth);

async function approvedVersion(businessId: string): Promise<{ version: string | null; error: any }> {
  const { data, error } = await supabase
    .from('businesses')
    .select('desktop_approved_version')
    .eq('id', businessId)
    .maybeSingle();
  const v = (data as any)?.desktop_approved_version ?? null;
  return { version: isVersion(v) ? v : null, error };
}

// What may this business's tills update to? null = hold (stay on the version they run).
router.get('/status', async (req, res) => {
  const { version, error } = await approvedVersion(req.businessId);
  if (error) { sendError(res, error); return; }
  res.set('Cache-Control', 'no-store');
  res.json({ approvedVersion: version, held: version === null });
});

// The generic feed for ONE version: /v/0.6.16/latest.yml, /v/0.6.16/SwiftPOS-0.6.16-x64.exe (+ .blockmap); from 0.6.32
// the one installer for 64-bit and 32-bit Windows, /v/0.6.32/SwiftPOS-0.6.32.exe.
router.get('/v/:version/:file', async (req, res) => {
  const want = String(req.params.version);
  const file = String(req.params.file);
  const { version, error } = await approvedVersion(req.businessId);
  if (error) { sendError(res, error); return; }
  if (!isVersion(want) || version !== want) {
    res.status(403).json({ error: 'This version is not approved for your business.', code: 'DESKTOP_VERSION_NOT_APPROVED' });
    return;
  }
  let releases;
  // A356: a GitHub refusal falls back to the last good list — an approved update keeps flowing through a hiccup.
  try { releases = (await listDesktopReleasesOrStale()).releases; }
  catch (e: any) { res.status(502).json({ error: `Update source unavailable: ${e?.message ?? e}` }); return; }
  const rel = releases.find((r) => r.version === want);
  if (!rel || !rel.complete) {
    res.status(404).json({ error: `Version ${want} is not available (${rel ? `missing ${rel.missing.join(', ')}` : 'no release'}).` });
    return;
  }
  const asset = assetFor(rel, file);
  if (!asset) { res.status(404).json({ error: 'No such file in this release.' }); return; }
  let url: string;
  try { url = await assetDownloadUrl(asset); }
  catch (e: any) { res.status(502).json({ error: `Update source unavailable: ${e?.message ?? e}` }); return; }
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url);
});

export default router;
