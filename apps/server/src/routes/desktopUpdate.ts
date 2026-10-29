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
import { cleanUpdateState } from '../lib/updateState';   // A534
import { standingFor } from '../lib/cloudPlan';            // A601

const router = safeRouter();
router.use(requireAuth);

/**
 * A601 (owner, 2026-10-28: "desktop updates are cut too — an update becomes a paid support extra"): from the desktop-only
 * cut-off (DESKTOP_ONLY_CUTOFF_AT), a desktop-only business is offered no version unless ZapTill releases updates to it —
 * the admin-only desktop_updates flag (admin portal › Features); the version itself is still the admin's per-business
 * approval below. bySupport: the POS says "Updates for this business are released by ZapTill support". A failed standing
 * read holds nothing back (as every cloud-plan gate).
 */
async function approvedVersion(businessId: string): Promise<{ version: string | null; error: any; bySupport: boolean }> {
  const { data, error } = await supabase
    .from('businesses')
    .select('desktop_approved_version')
    .eq('id', businessId)
    .maybeSingle();
  const v = (data as any)?.desktop_approved_version ?? null;
  const held = (await standingFor(businessId).catch(() => null))?.desktopOnly?.updatesHeld === true;
  return { version: !held && isVersion(v) ? v : null, error, bySupport: held };
}

// What may this business's tills update to? null = hold (stay on the version they run).
router.get('/status', async (req, res) => {
  const { version, error, bySupport } = await approvedVersion(req.businessId);
  if (error) { sendError(res, error); return; }
  res.set('Cache-Control', 'no-store');
  // A534: reportsState — this cloud takes a till's update state (POST /state below); a till sends none without it.
  // A601: bySupport — held because the business is desktop only (a POS before A601 reads a plain hold).
  res.json({ approvedVersion: version, held: version === null, reportsState: true, ...(bySupport ? { bySupport: true } : {}) });
});

// A534 (owner, 2026-10-20: "add all of them since effort is small"): a till's update state — downloading, downloaded and
// waiting to be closed, failed and why — for the admin portal's Desktop updates card ("why isn't this till updating?").
// A till's OWN session only, for itself (its id from its sign-in, never a header); its own business's row only. No
// permission key (lib/tillScope.ts: nothing a till's sign-in would be refused). Stored on user_devices (migration 154);
// before 154 the cloud answers 501 and the till rests its reports for 6 hours. Read only by the admin portal.
let stateColumnWarned = false;
router.post('/state', async (req, res) => {
  if (!req.isTill || !req.deviceId) { res.status(403).json({ error: "Only a POS's own session reports its update state.", code: 'TILL_ONLY' }); return; }
  const clean = cleanUpdateState(req.body);
  if (!clean) { res.status(400).json({ error: 'not an update state', code: 'INVALID' }); return; }
  const { error } = await supabase
    .from('user_devices')
    .update({ update_state: clean, update_state_at: new Date().toISOString() })
    .eq('business_id', req.businessId)
    .eq('device_id', req.deviceId);
  if (error) {
    if ((error as { code?: string }).code === '42703' || /update_state/.test(String(error.message ?? ''))) {
      if (!stateColumnWarned) { stateColumnWarned = true; console.warn('[desktop-update] update state not stored — is migration 154 applied?', error.message); }
      res.status(501).json({ error: 'not stored yet (migration 154)', code: 'NOT_READY' });
      return;
    }
    sendError(res, error); return;
  }
  res.status(204).end();
});

// The generic feed for ONE version: /v/0.6.16/latest.yml, /v/0.6.16/SwiftPOS-0.6.16-x64.exe (+ .blockmap); from 0.6.32
// the one installer for 64-bit and 32-bit Windows, /v/0.6.32/SwiftPOS-0.6.32.exe.
router.get('/v/:version/:file', async (req, res) => {
  const want = String(req.params.version);
  const file = String(req.params.file);
  const { version, error, bySupport } = await approvedVersion(req.businessId);
  if (error) { sendError(res, error); return; }
  if (bySupport) {
    res.status(403).json({ error: 'Updates for this business are released by ZapTill support.', code: 'DESKTOP_UPDATES_BY_SUPPORT' });
    return;
  }
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
