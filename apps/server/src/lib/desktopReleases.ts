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
 * A release is COMPLETE when it carries the three files electron-updater needs: latest.yml, the installer (.exe) and its
 * .blockmap. electron-builder has been seen to create a tag's draft twice with the files split between them (v0.6.15,
 * 2026-09-27); the complete copy is served and an incomplete one is reported, never half-served.
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
  assets: GhAsset[];
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

/** Which of the three updater files a release is missing. */
export function missingFiles(assets: GhAsset[]): string[] {
  const names = assets.map((a) => a.name);
  const out: string[] = [];
  if (!names.includes('latest.yml')) out.push('latest.yml');
  const exe = names.filter((n) => /\.exe$/i.test(n));
  if (exe.length === 0) out.push('installer (.exe)');
  if (!exe.some((e) => names.includes(`${e}.blockmap`))) out.push('.blockmap');
  return out;
}

/**
 * GitHub's release list → one entry per version, newest first. Where a version has several releases (the split-draft
 * case), the complete one wins; among equals, a published one, then the newest.
 */
export function summariseReleases(releases: GhRelease[]): DesktopRelease[] {
  const byVersion = new Map<string, DesktopRelease>();
  for (const r of releases) {
    const version = versionOfTag(r.tag_name);
    if (!version) continue;
    const missing = missingFiles(r.assets ?? []);
    const cand: DesktopRelease = {
      version, draft: !!r.draft, prerelease: !!r.prerelease, complete: missing.length === 0, missing, releaseId: r.id, assets: r.assets ?? [],
      publishedAt: r.published_at ?? null,
    };
    const prev = byVersion.get(version);
    const better = !prev
      || (cand.complete && !prev.complete)
      || (cand.complete === prev.complete && !cand.draft && prev.draft)
      || (cand.complete === prev.complete && cand.draft === prev.draft && cand.releaseId > prev.releaseId);
    if (better) byVersion.set(version, cand);
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
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

/** Every desktop release (drafts too when a token is set). Cached 5 min so a fleet of tills costs GitHub one call. */
export async function listDesktopReleases(opts: { fresh?: boolean } = {}): Promise<DesktopRelease[]> {
  const repo = releasesRepo();
  if (!opts.fresh && cache && cache.repo === repo && Date.now() - cache.at < CACHE_MS) return cache.releases;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const releases = summariseReleases((await res.json()) as GhRelease[]);
  cache = { at: Date.now(), repo, releases };
  return releases;
}

export function clearReleaseCache(): void { cache = null; }

/**
 * Where the till should download `asset` from. With a token: GitHub's API asset URL answers with a short-lived signed
 * link (works for drafts and a private repo) — returned here, the token never leaves the cloud. Without one: the public
 * download link (published releases of a public repo only).
 */
export async function assetDownloadUrl(asset: GhAsset): Promise<string> {
  if (!token()) return asset.browser_download_url;
  const res = await fetch(asset.url, { headers: ghHeaders('application/octet-stream'), redirect: 'manual' });
  const loc = res.headers.get('location');
  if ((res.status === 301 || res.status === 302 || res.status === 307) && loc) return loc;
  throw new Error(`GitHub asset ${asset.name}: HTTP ${res.status}`);
}
