/**
 * adminAndroid.ts — the admin portal's "ZapTill for Android" card on a client's Updates tab (docs/ANDROID-APP-DESIGN.md,
 * Stage 0). The desktop's A348 approval and A570 download, for the Android app's two surfaces.
 *
 *   GET   /api/admin/android/releases?client=<id>&fresh=1
 *         → { releases, warning, approvals }  every Android release the cloud can see (complete or why not), and — with
 *           a client — what each surface is approved for (null = held; approvalsMissing: migration 189 not run).
 *   PATCH /api/admin/android/clients/:id/version   { surface: 'android-till' | 'mobile', version: 'x.y.z' | null }
 *         → the client's approvals. Super admin only (A495: the approval is what a client pays for), audited
 *           (android_update.approve / android_update.hold). Only a complete, published release can be approved.
 *   POST  /api/admin/android/releases/:version/link  { client? }
 *         → { url, fileName, sha256, size }  the APK's short-lived download link (minutes) for installing a new device,
 *           and the SHA-256 to check it against. Audited (android.apk.download). An agent may take the newest release or
 *           a version approved for the client named; any other version is a super admin's (as A570's installer).
 *
 * Mounted at /admin/android before /admin (routes/index.ts).
 */
import { ANDROID_SURFACES, isAndroidSurface, isAppVersion } from '@zaptill/core/androidApp';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin, requireSuperAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { assetDownloadUrl } from '../lib/desktopReleases';
import { approvableRelease, latestAndroidVersion, listAndroidReleasesOrStale, type AndroidRelease } from '../lib/androidReleases';
import { APPROVAL_COLUMN, approvalsOf, readAndroidApprovals } from '../lib/androidApproval';

const router = safeRouter();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function audit(req: any, action: string, businessId: string | null, businessName: string | null, before: object | null, after: object): Promise<void> {
  const { error } = await supabase.from('admin_audit_log').insert({
    admin_id: req.adminId, admin_email: req.adminEmail, action, resource: 'android_app',
    business_id: businessId, business_name: businessName, before_data: before, after_data: after, reason: null,
    ip_address: req.ip ?? null,
  });
  if (error) console.warn(`[admin-android] audit ${action} not written: ${error.message}`);
}

/** What the portal shows for a release (no GitHub ids or links). */
const view = (r: AndroidRelease) => ({
  version: r.version, draft: r.draft, prerelease: r.prerelease, complete: r.complete, missing: r.missing,
  sha256: r.sha256, size: r.size, published_at: r.publishedAt,
});

router.get('/releases', requireAdmin, async (req, res) => {
  let releases: AndroidRelease[] = [];
  let warning: string | null = null;
  try { ({ releases, warning } = await listAndroidReleasesOrStale({ fresh: req.query.fresh === '1' })); }
  catch (e: any) { warning = `Could not read the Android releases: ${e?.message ?? e}`; }
  const client = String(req.query.client ?? '');
  let approvals = null, approvalsMissing = false;
  if (UUID.test(client)) {
    const read = await readAndroidApprovals(client);
    if (read.error) { sendError(res, read.error); return; }
    approvals = read.approvals; approvalsMissing = read.missing;
  }
  res.json({ releases: releases.map(view), latest: latestAndroidVersion(releases), warning, approvals, approvalsMissing });
});

router.patch('/clients/:id/version', requireAdmin, requireSuperAdmin, async (req, res) => {
  const id = String(req.params.id);
  const { surface, version: asked } = (req.body ?? {}) as { surface?: unknown; version?: unknown };
  if (!UUID.test(id)) { res.status(400).json({ error: 'Not a client id.' }); return; }
  if (!isAndroidSurface(surface)) { res.status(400).json({ error: `surface must be one of ${ANDROID_SURFACES.join(', ')}.` }); return; }
  if (asked !== null && !isAppVersion(asked)) { res.status(400).json({ error: 'version must be x.y.z, or null to hold.' }); return; }
  const version = asked === null ? null : String(asked);
  if (version !== null) {
    let releases: AndroidRelease[];
    try { releases = (await listAndroidReleasesOrStale()).releases; }
    catch (e: any) { res.status(502).json({ error: `Could not read the Android releases: ${e?.message ?? e}` }); return; }
    if (!approvableRelease(releases, version)) {
      res.status(409).json({ error: `ZapTill for Android ${version} cannot be approved: it is not a complete, published release (the APK and its SHA-256).` });
      return;
    }
  }
  const column = APPROVAL_COLUMN[surface];
  const { data: row } = await supabase.from('businesses').select(`name, ${column}`).eq('id', id).maybeSingle();
  if (!row) { res.status(404).json({ error: 'No such client.' }); return; }
  const name = (row as { name?: string }).name ?? null;
  const previous = (row as unknown as Record<string, unknown>)[column] ?? null;
  const { data, error } = await supabase.from('businesses').update({ [column]: version }).eq('id', id)
    .select(`id, name, ${Object.values(APPROVAL_COLUMN).join(', ')}`).single();
  if (error) { sendError(res, error); return; }
  await audit(req, version ? 'android_update.approve' : 'android_update.hold', id, name,
    { surface, version: previous }, { surface, version });
  res.json({ approvals: approvalsOf(data as unknown as Record<string, unknown>) });
});

router.post('/releases/:version/link', requireAdmin, async (req: any, res) => {
  const version = String(req.params.version);
  if (!isAppVersion(version)) { res.status(400).json({ error: 'Not a version.' }); return; }
  let releases: AndroidRelease[];
  try { releases = (await listAndroidReleasesOrStale()).releases; }
  catch (e: any) { res.status(502).json({ error: `Could not read the Android releases: ${e?.message ?? e}` }); return; }
  const rel = approvableRelease(releases, version);
  if (!rel || !rel.apk || !rel.sha256) { res.status(404).json({ error: `There is no complete ZapTill for Android ${version}.` }); return; }

  const clientId = typeof req.body?.client === 'string' && UUID.test(req.body.client) ? req.body.client : null;
  let client: { id: string; name: string | null } | null = null;
  let approvedForClient = false;
  if (clientId) {
    const { data } = await supabase.from('businesses').select(`id, name, ${Object.values(APPROVAL_COLUMN).join(', ')}`).eq('id', clientId).maybeSingle();
    if (data) {
      client = { id: clientId, name: (data as { name?: string }).name ?? null };
      approvedForClient = Object.values(approvalsOf(data as unknown as Record<string, unknown>)).includes(version);
    }
  }
  if (req.adminRole !== 'super_admin' && version !== latestAndroidVersion(releases) && !approvedForClient) {
    res.status(403).json({ error: 'Only a super admin can download a version other than the newest or one approved for this client.' });
    return;
  }
  let url: string;
  try { url = await assetDownloadUrl(rel.apk); }
  catch (e: any) { res.status(502).json({ error: `The download source did not answer: ${e?.message ?? e}` }); return; }
  await audit(req, 'android.apk.download', client?.id ?? null, client?.name ?? null, null,
    { version, file: rel.apk.name, sha256: rel.sha256, size: rel.size });
  res.set('Cache-Control', 'no-store');
  res.json({ url, fileName: rel.apk.name, sha256: rel.sha256, size: rel.size });
});

export default router;
