/**
 * desktopVersionApproval.ts — which ZapTill version a business's tills may install (A348), checked in ONE place.
 *
 * The admin portal set it (PATCH /api/admin/clients/:id/desktop-version); A490 moves it to the owner
 * (PUT /api/controls/updates, `settings.updates`). Both validate a version exactly the same way: x.y.z, a release the
 * cloud can serve, complete (latest.yml and the installer) — approving a version the tills cannot download would leave
 * them failing every check. null holds the tills where they are.
 */
import { isVersion, listDesktopReleasesOrStale } from './desktopReleases';

export type VersionCheck = { ok: true; version: string | null } | { ok: false; status: number; error: string };

export async function checkApprovableVersion(raw: unknown): Promise<VersionCheck> {
  const version = raw === null || raw === undefined || raw === '' ? null : raw;
  if (version !== null && !isVersion(version)) {
    return { ok: false, status: 400, error: 'version must be x.y.z (e.g. 0.6.16) or null to hold' };
  }
  if (version === null) return { ok: true, version: null };
  let rel;
  try { rel = (await listDesktopReleasesOrStale({ fresh: true })).releases.find((r) => r.version === version); }
  catch (e: any) { return { ok: false, status: 502, error: `Could not read the releases from GitHub: ${e?.message ?? e}` }; }
  if (!rel) return { ok: false, status: 400, error: `There is no release ${version}.` };
  if (!rel.complete) return { ok: false, status: 400, error: `Release ${version} is missing ${rel.missing.join(', ')} — rebuild it first.` };
  return { ok: true, version: version as string };
}
