/**
 * desktopReleases.ts — A348 (2026-09-28): the desktop releases the cloud can hand to tills, read from GitHub Releases.
 *
 * Owner: "can i find a way of picking only one client to run the update not all the clients?" → "hold by default, per
 * business, build 0.6.16". From desktop 0.6.16 a till never polls GitHub itself: it asks the cloud for its business's
 * approved version (businesses.desktop_approved_version; NULL = hold) and downloads that one through the cloud, which
 * redirects to the file on GitHub. With GITHUB_RELEASES_TOKEN set (a read-only token, cloud-side only) the cloud also
 * reads a PRIVATE repository, so the source can go private without breaking updates. Tills never see the token.
 *
 * From 0.6.16 every build is published as a PRE-RELEASE (electron-builder.config.js): readable here with no token
 * (public repo) or a read-only one (private), and ignored by tills on 0.6.15 and older, which follow GitHub's latest
 * non-pre-release. Drafts are listed too when the token can see them (GitHub shows drafts only to push access).
 *
 * A release is COMPLETE when it carries what electron-updater needs: latest.yml and the installer (.exe); the .blockmap is
 * optional (differential downloads are off on 0.6.16+ tills). A350: electron-builder split v0.6.15 and v0.6.16 each into
 * two releases with the files divided between them — the copies of a version are merged into one here, and the release
 * workflow now creates the release first so it stops happening.
 */

export const DEFAULT_RELEASES_REPO = 'oweyahillary/swiftpos';

export interface GhAsset { id: number; name: string; url: string; browser_download_url: string; size?: number }
export interface GhRelease { id: number; tag_name: string; name?: string | null; draft: boolean; prerelease?: boolean; published_at?: string | null; created_at?: string | null; assets: GhAsset[] }

export interface DesktopRelease {
  version: string;
  draft: boolean;
  /** Published as a pre-release (every build from 0.6.16): tills on 0.6.15 and older never see it. */
  prerelease: boolean;
  complete: boolean;
  /** Which of the three files are missing (empty when complete). */
  missing: string[];
  releaseId: number;
  /** Every file of the version, merged across its copies (A350). */
  assets: GhAsset[];
  /** How many GitHub releases carry this version (1 normally; 2+ = a split, merged here). */
  copies: number;
  publishedAt: string | null;
}

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/** Plain x.y.z only (what the migration's CHECK allows). */
export function isVersion(v: unknown): v is string { return typeof v === 'string' && VERSION_RE.test(v); }

/** -1 / 0 / 1, numerically per part. Callers validate with isVersion first. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1; }
  return 0;
}

export function versionOfTag(tag: string): string | null {
  const v = String(tag ?? '').replace(/^v/, '');
  return isVersion(v) ? v : null;
}

/**
 * Which REQUIRED updater files a release is missing: latest.yml and the installer. A350: the .blockmap is not required —
 * it only serves differential downloads, which 0.6.16+ tills switch off (autoUpdate.ts), and v0.6.13/0.6.14 were
 * published without one; requiring it would refuse to approve a release a till can install perfectly well.
 */
export function missingFiles(assets: GhAsset[]): string[] {
  const names = assets.map((a) => a.name);
  const out: string[] = [];
  if (!names.includes('latest.yml')) out.push('latest.yml');
  if (!names.some((n) => /\.exe$/i.test(n))) out.push('installer (.exe)');
  return out;
}

/**
 * GitHub's release list → one entry per version, newest first.
 *
 * A350: where a version has SEVERAL releases (electron-builder's split — v0.6.15 and v0.6.16 each came out as two
 * releases with the files divided between them), they are one logical release: their files are MERGED, each file taken
 * from the preferred copy that has it (published before draft, then the newest). So a split never blocks an approval
 * and never makes a till fetch half a release. The draft / pre-release flags and the id are the preferred copy's.
 */
export function summariseReleases(releases: GhRelease[]): DesktopRelease[] {
  const groups = new Map<string, GhRelease[]>();
  for (const r of releases) {
    const version = versionOfTag(r.tag_name);
    if (!version) continue;
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version)!.push(r);
  }
  const out: DesktopRelease[] = [];
  for (const [version, copies] of groups) {
    copies.sort((a, b) => (Number(!!a.draft) - Number(!!b.draft)) || (b.id - a.id));   // preferred copy first
    const byName = new Map<string, GhAsset>();
    for (const c of copies) for (const a of c.assets ?? []) if (!byName.has(a.name)) byName.set(a.name, a);
    const assets = [...byName.values()];
    const missing = missingFiles(assets);
    const head = copies[0];
    out.push({
      version, draft: !!head.draft, prerelease: !!head.prerelease, complete: missing.length === 0, missing,
      releaseId: head.id, assets, publishedAt: head.published_at ?? null, copies: copies.length,
    });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The file a till may fetch for `version`: latest.yml, or an .exe / .blockmap of THAT release. null = not a file of the
 * release (the route answers 404). Names come from GitHub, so no path is ever built from the request.
 */
export function assetFor(rel: DesktopRelease, file: string): GhAsset | null {
  if (file !== 'latest.yml' && !/\.(exe|exe\.blockmap)$/i.test(file)) return null;
  return rel.assets.find((a) => a.name === file) ?? null;
}

// ── GitHub I/O (thin; the rules above are the tested part) ────────────────────────────────────────────────────────────

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; repo: string; releases: DesktopRelease[] } | null = null;

export function releasesRepo(): string { return process.env.DESKTOP_RELEASES_REPO || DEFAULT_RELEASES_REPO; }
function token(): string | null { return process.env.GITHUB_RELEASES_TOKEN || null; }
function ghHeaders(accept = 'application/vnd.github+json'): Record<string, string> {
  const h: Record<string, string> = { Accept: accept, 'User-Agent': 'swiftpos-cloud', 'X-GitHub-Api-Version': '2022-11-28' };
  const t = token();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/**
 * A356 (2026-09-28): what a GitHub refusal MEANS, in words the owner can act on. The admin portal showed "GitHub
 * releases: HTTP 403" on 2026-09-28 — anonymous calls from Render's shared addresses had used up GitHub's 60-an-hour
 * allowance; the fix was GITHUB_RELEASES_TOKEN, which nothing on screen said.
 */
export function describeGitHubFailure(status: number, rateRemaining: string | null, bodyMessage: string, hasToken: boolean): string {
  const rateLimited = status === 429 || (status === 403 && (rateRemaining === '0' || /rate limit/i.test(bodyMessage)));
  if (rateLimited) {
    return hasToken
      ? 'GitHub rate limit reached, even with GITHUB_RELEASES_TOKEN — try again in a few minutes.'
      : 'GitHub rate limit reached — set GITHUB_RELEASES_TOKEN on the cloud (a read-only token, 5,000 requests an hour).';
  }
  if (status === 401) return 'GitHub refused GITHUB_RELEASES_TOKEN (expired or revoked?) — replace it on the cloud.';
  if (status === 403) return `GitHub refused the request (HTTP 403${bodyMessage ? `: ${bodyMessage}` : ''}).`;
  if (status === 404) return 'GitHub cannot see the releases — check DESKTOP_RELEASES_REPO and the token\'s repository access.';
  return `GitHub releases: HTTP ${status}`;
}

/** Every desktop release (drafts too when a token is set). Cached 5 min so a fleet of tills costs GitHub one call. */
export async function listDesktopReleases(opts: { fresh?: boolean } = {}): Promise<DesktopRelease[]> {
  const repo = releasesRepo();
  if (!opts.fresh && cache && cache.repo === repo && Date.now() - cache.at < CACHE_MS) return cache.releases;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, { headers: ghHeaders() });
  if (!res.ok) {
    let bodyMessage = '';
    try { bodyMessage = String(((await res.json()) as any)?.message ?? ''); } catch { /* not JSON */ }
    throw new Error(describeGitHubFailure(res.status, res.headers.get('x-ratelimit-remaining'), bodyMessage, !!token()));
  }
  const releases = summariseReleases((await res.json()) as GhRelease[]);
  cache = { at: Date.now(), repo, releases };
  return releases;
}

/**
 * A356: the list, or — when GitHub refuses — the LAST list read successfully, with a warning saying so. Approving a
 * version seen minutes ago is safe (the till still fetches the files by their GitHub id); a portal that goes blank
 * because GitHub hiccuped is not. Throws only when there has never been a good read.
 */
export async function listDesktopReleasesOrStale(opts: { fresh?: boolean } = {}): Promise<{ releases: DesktopRelease[]; warning: string | null }> {
  try {
    return { releases: await listDesktopReleases(opts), warning: null };
  } catch (e: any) {
    const repo = releasesRepo();
    if (cache && cache.repo === repo) {
      const mins = Math.max(1, Math.round((Date.now() - cache.at) / 60000));
      return { releases: cache.releases, warning: `${e?.message ?? e} Showing the list read ${mins} minute${mins === 1 ? '' : 's'} ago.` };
    }
    throw e;
  }
}

export function clearReleaseCache(): void { cache = null; }

/**
 * Where the till should download `asset` from: GitHub's API asset URL, which answers with a short-lived signed link.
 * A350: ALWAYS this, token or not. The public `/releases/download/<tag>/<file>` link is ambiguous when a tag has two
 * releases — for v0.6.16 it resolved to the copy without latest.yml and answered Not Found (verified); the API URL names
 * the file by its id. With a token (private repo, higher rate limit) it is sent here and never leaves the cloud.
 */
export async function assetDownloadUrl(asset: GhAsset): Promise<string> {
  const res = await fetch(asset.url, { headers: ghHeaders('application/octet-stream'), redirect: 'manual' });
  const loc = res.headers.get('location');
  if ((res.status === 301 || res.status === 302 || res.status === 307) && loc) return loc;
  throw new Error(`GitHub asset ${asset.name}: HTTP ${res.status}`);
}
