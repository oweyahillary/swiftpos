/**
 * release.ts — the ZapTill release number, the same on the till, the cloud, the dashboard / web POS and the admin portal.
 *
 * Owner, 2026-10-01: "can we add versioning on the website also so that i can tell which one i am running?" Every surface
 * shows "v<RELEASE> · <commit>" — the release says WHICH update, the commit says which build of it was deployed. The
 * dashboard also asks the cloud for its own and says so when the two differ (one was deployed, the other not yet).
 *
 * RELEASE moves with apps/desktop/package.json's version in the same commit (tests/release-version.test.mjs fails
 * otherwise). ONE file: shared/release.ts, copied to the cloud, the dashboard and the admin portal (check-shared-sync).
 */

export const RELEASE = '1.0.1';

/** "v0.6.28 · 47a86c9" — the commit when the host told the build it (Vercel / Render); "v0.6.28" alone otherwise. */
export function releaseLabel(release: string | null | undefined, commit?: string | null): string {
  const r = String(release ?? '').trim();
  const c = String(commit ?? '').trim().slice(0, 7);
  const head = r ? `v${r}` : 'version unknown';
  return c && c !== 'dev' ? `${head} · ${c}` : head;
}

/** Are the website and the cloud on different releases? Unknown on either side → not said. */
export function releasesDiffer(web: string | null | undefined, cloud: string | null | undefined): boolean {
  const a = String(web ?? '').trim(), b = String(cloud ?? '').trim();
  return !!a && !!b && a !== b;
}
