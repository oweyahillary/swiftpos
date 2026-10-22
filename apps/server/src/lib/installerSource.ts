/**
 * installerSource.ts — A570 (2026-10-22): where the cloud fetches a ZapTill installer from, for the admin portal's
 * "Download ZapTill" (routes/adminInstaller.ts streams it to the admin; the browser never sees the source or a token).
 *
 * Owner: "yes this is something i have wanted since in future we will get a vps which will hold our apps and move away
 * from github and make the repo private".
 *
 * TWO SOURCES, ONE ORDER
 *   1. DESKTOP_DOWNLOAD_BASE_URL — our own server or object storage (the planned VPS). When set it WINS. Layout:
 *        {base}/ZapTill-{version}.exe      the installer (required)
 *        {base}/latest-{version}.yml       that release's latest.yml (optional; gives the SHA-512 shown to technicians)
 *   2. GitHub Releases (DESKTOP_RELEASES_REPO, default oweyahillary/swiftpos) read with GITHUB_RELEASES_TOKEN — a
 *      read-only token, so it keeps working when the repository goes PRIVATE: a private release asset needs an
 *      authenticated API request (GET the asset's API url with Accept: application/octet-stream), which answers with a
 *      short-lived signed link; that link is fetched WITHOUT the token (it is another host).
 *   Neither set → 503 INSTALLER_SOURCE_NOT_CONFIGURED, naming both. Anonymous GitHub is deliberately not a source: it
 *   stops the day the repository goes private, and anonymous calls from Render's shared addresses hit GitHub's rate
 *   limit (A356) — a download that works today and silently breaks later is worse than a clear message now.
 *
 * Streams only: the body is handed on as a stream, never read into memory (installers are 100+ MB).
 *
 * NEXT STEP, NOT BUILT HERE (see A570 in the register): the tills' own updates (electron-updater, routes/desktopUpdate.ts)
 * still redirect to GitHub. When the repository goes private they keep working only through GITHUB_RELEASES_TOKEN on the
 * cloud; when the files move to the VPS, /api/desktop-update/v/:version/:file should resolve through THIS module too.
 */
import type { DesktopRelease, GhAsset } from './desktopReleases';
import { DEFAULT_RELEASES_REPO, isVersion, listDesktopReleasesOrStale } from './desktopReleases';

export type InstallerSource =
  | { kind: 'vps'; base: string }
  | { kind: 'github'; repo: string; token: string }
  | { kind: 'none' };

export const NOT_CONFIGURED_MESSAGE =
  'Installer downloads are not set up on this server. Set DESKTOP_DOWNLOAD_BASE_URL (our own download server) or ' +
  'GITHUB_RELEASES_TOKEN (GitHub releases — works when the repository is private) on the cloud.';

type Env = Record<string, string | undefined>;

/** Which source the cloud uses now. The VPS URL wins; GitHub needs its token; otherwise none. */
export function installerSource(env: Env = process.env): InstallerSource {
  const base = String(env.DESKTOP_DOWNLOAD_BASE_URL ?? '').trim();
  if (base) {
    if (/^https?:\/\//i.test(base)) return { kind: 'vps', base: base.replace(/\/+$/, '') };
    console.warn('[installer] DESKTOP_DOWNLOAD_BASE_URL is not an http(s) URL — ignored');
  }
  const token = String(env.GITHUB_RELEASES_TOKEN ?? '').trim();
  if (token) return { kind: 'github', repo: String(env.DESKTOP_RELEASES_REPO ?? '').trim() || DEFAULT_RELEASES_REPO, token };
  return { kind: 'none' };
}

/** The installer's file name for a version (release.yml: ZapTill-<version>.exe since 0.6.36). */
export function installerFileName(version: string): string { return `ZapTill-${version}.exe`; }

export function vpsInstallerUrl(base: string, version: string): string { return `${base}/${installerFileName(version)}`; }
export function vpsLatestYmlUrl(base: string, version: string): string { return `${base}/latest-${version}.yml`; }

/** The release's installer: ZapTill-<version>.exe, or (older names) its one .exe. */
export function installerAsset(rel: DesktopRelease): GhAsset | null {
  const want = installerFileName(rel.version);
  return rel.assets.find((a) => a.name === want)
    ?? rel.assets.find((a) => /\.exe$/i.test(a.name)) ?? null;
}

/** Releases an admin may download: complete (latest.yml + installer) and not drafts, newest first. */
export function downloadableVersions(releases: DesktopRelease[]): string[] {
  return releases.filter((r) => r.complete && !r.draft).map((r) => r.version);
}

/** The newest downloadable version, or null. */
export function latestVersion(releases: DesktopRelease[]): string | null { return downloadableVersions(releases)[0] ?? null; }

/** latest.yml text → the installer's size and SHA-512 (hex, as PowerShell's Get-FileHash prints it). */
export function parseLatestYml(text: string, fileName?: string): { sha512Hex: string | null; size: number | null; version: string | null } {
  const version = /^version:\s*['"]?([0-9.]+)['"]?\s*$/m.exec(text)?.[1] ?? null;
  // Prefer the files: entry for the installer; else the top-level sha512 (electron-builder writes both).
  let sha: string | null = null, size: number | null = null;
  const blocks = text.split(/\n\s*-\s+url:\s*/).slice(1);
  for (const b of blocks) {
    const url = b.split('\n')[0].trim().replace(/^['"]|['"]$/g, '');
    if (fileName && url !== fileName) continue;
    sha = /sha512:\s*(\S+)/.exec(b)?.[1] ?? null;
    const s = /size:\s*(\d+)/.exec(b)?.[1];
    size = s ? Number(s) : null;
    break;
  }
  if (!sha) sha = /^sha512:\s*(\S+)/m.exec(text)?.[1] ?? null;
  let sha512Hex: string | null = null;
  if (sha) { try { sha512Hex = Buffer.from(sha, 'base64').toString('hex'); } catch { sha512Hex = null; } }
  return { sha512Hex: sha512Hex && sha512Hex.length === 128 ? sha512Hex : null, size, version };
}

function ghHeaders(token: string, accept: string): Record<string, string> {
  return { Accept: accept, Authorization: `Bearer ${token}`, 'User-Agent': 'swiftpos-cloud', 'X-GitHub-Api-Version': '2022-11-28' };
}

export type Opened =
  | { ok: true; body: ReadableStream<Uint8Array>; size: number | null; fileName: string; source: 'vps' | 'github' }
  | { ok: false; status: 404 | 502 | 503; code: string; error: string };

const notFound = (version: string): Opened => ({ ok: false, status: 404, code: 'INSTALLER_NOT_FOUND', error: `There is no ZapTill ${version} installer.` });
const lengthOf = (r: Response): number | null => {
  const n = Number(r.headers.get('content-length'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A GitHub asset's bytes, as a response with a streaming body: the authenticated API request (octet-stream), then the
 * signed link it redirects to, fetched without the token. A 200 straight away (GitHub may answer so) is used as it is.
 */
async function githubAsset(asset: GhAsset, token: string, fetchImpl: typeof fetch): Promise<Response> {
  const first = await fetchImpl(asset.url, { headers: ghHeaders(token, 'application/octet-stream'), redirect: 'manual' });
  const loc = first.headers.get('location');
  if ([301, 302, 303, 307, 308].includes(first.status) && loc) {
    try { await first.body?.cancel(); } catch { /* nothing to drop */ }
    return fetchImpl(loc, { redirect: 'follow' });
  }
  return first;
}

export interface OpenOpts {
  env?: Env;
  fetchImpl?: typeof fetch;
  /** The release list (GitHub); defaults to lib/desktopReleases' cached list. */
  releases?: () => Promise<DesktopRelease[]>;
}

const defaultReleases = async () => (await listDesktopReleasesOrStale()).releases;

/** Open the installer of `version` for streaming. Never reads the body. */
export async function openInstaller(version: string, opts: OpenOpts = {}): Promise<Opened> {
  if (!isVersion(version)) return notFound(String(version));
  const src = installerSource(opts.env);
  const f = opts.fetchImpl ?? fetch;
  if (src.kind === 'none') return { ok: false, status: 503, code: 'INSTALLER_SOURCE_NOT_CONFIGURED', error: NOT_CONFIGURED_MESSAGE };

  if (src.kind === 'vps') {
    let r: Response;
    try { r = await f(vpsInstallerUrl(src.base, version), { redirect: 'follow' }); }
    catch (e: any) { return { ok: false, status: 502, code: 'INSTALLER_SOURCE_UNAVAILABLE', error: `The download server did not answer: ${e?.message ?? e}` }; }
    if (r.status === 404) { try { await r.body?.cancel(); } catch { /* */ } return notFound(version); }
    if (!r.ok || !r.body) return { ok: false, status: 502, code: 'INSTALLER_SOURCE_UNAVAILABLE', error: `The download server answered HTTP ${r.status}.` };
    return { ok: true, body: r.body, size: lengthOf(r), fileName: installerFileName(version), source: 'vps' };
  }

  let releases: DesktopRelease[];
  try { releases = await (opts.releases ?? defaultReleases)(); }
  catch (e: any) { return { ok: false, status: 502, code: 'INSTALLER_SOURCE_UNAVAILABLE', error: `Could not read the releases from GitHub: ${e?.message ?? e}` }; }
  const rel = releases.find((r) => r.version === version && !r.draft);
  const asset = rel ? installerAsset(rel) : null;
  if (!rel || !asset) return notFound(version);
  let r: Response;
  try { r = await githubAsset(asset, src.token, f); }
  catch (e: any) { return { ok: false, status: 502, code: 'INSTALLER_SOURCE_UNAVAILABLE', error: `GitHub did not answer: ${e?.message ?? e}` }; }
  if (r.status === 404) { try { await r.body?.cancel(); } catch { /* */ } return notFound(version); }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, status: 502, code: 'INSTALLER_SOURCE_UNAVAILABLE', error: `GitHub refused GITHUB_RELEASES_TOKEN (HTTP ${r.status}) — replace it on the cloud.` };
  }
  if (!r.ok || !r.body) return { ok: false, status: 502, code: 'INSTALLER_SOURCE_UNAVAILABLE', error: `GitHub answered HTTP ${r.status}.` };
  return { ok: true, body: r.body, size: lengthOf(r) ?? asset.size ?? null, fileName: asset.name, source: 'github' };
}

export interface InstallerInfo {
  version: string; fileName: string; source: 'vps' | 'github';
  size: number | null;
  /** From GitHub's own record of the file (asset digest), when it has one. */
  sha256: string | null;
  /** From the release's latest.yml (electron-builder writes SHA-512). Hex. */
  sha512: string | null;
}

/** What the admin sees beside the button: the file's name, size and checksums when the source provides them. */
export async function installerInfo(version: string, opts: OpenOpts = {}): Promise<{ ok: true; info: InstallerInfo } | Exclude<Opened, { ok: true }>> {
  if (!isVersion(version)) return notFound(String(version)) as Exclude<Opened, { ok: true }>;
  const src = installerSource(opts.env);
  const f = opts.fetchImpl ?? fetch;
  if (src.kind === 'none') return { ok: false, status: 503, code: 'INSTALLER_SOURCE_NOT_CONFIGURED', error: NOT_CONFIGURED_MESSAGE };
  const fileName = installerFileName(version);

  if (src.kind === 'vps') {
    let size: number | null = null, sha512: string | null = null;
    try {
      const h = await f(vpsInstallerUrl(src.base, version), { method: 'HEAD', redirect: 'follow' });
      if (h.status === 404) return notFound(version) as Exclude<Opened, { ok: true }>;
      size = lengthOf(h);
    } catch { /* size unknown */ }
    try {
      const y = await f(vpsLatestYmlUrl(src.base, version), { redirect: 'follow' });
      if (y.ok) { const p = parseLatestYml(await y.text(), fileName); sha512 = p.sha512Hex; size = size ?? p.size; }
    } catch { /* no checksum */ }
    return { ok: true, info: { version, fileName, source: 'vps', size, sha256: null, sha512 } };
  }

  let releases: DesktopRelease[];
  try { releases = await (opts.releases ?? defaultReleases)(); }
  catch (e: any) { return { ok: false, status: 502, code: 'INSTALLER_SOURCE_UNAVAILABLE', error: `Could not read the releases from GitHub: ${e?.message ?? e}` }; }
  const rel = releases.find((r) => r.version === version && !r.draft);
  const asset = rel ? installerAsset(rel) : null;
  if (!rel || !asset) return notFound(version) as Exclude<Opened, { ok: true }>;
  const digest = typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null;
  let sha512: string | null = null;
  const yml = rel.assets.find((a) => a.name === 'latest.yml');
  if (yml) {
    try {
      const r = await githubAsset(yml, src.token, f);
      if (r.ok) sha512 = parseLatestYml(await r.text(), asset.name).sha512Hex;
    } catch { /* no checksum */ }
  }
  return { ok: true, info: { version, fileName: asset.name, source: 'github', size: asset.size ?? null, sha256: digest, sha512 } };
}
