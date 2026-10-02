/**
 * desktopVersions.ts — A356 (2026-09-28): the admin portal's version list, short.
 *
 * Owner's screenshot (v0.6.17): the Desktop updates picker listed every build back to 0.5.48 — a long list to misclick
 * in. Approving an old version can never downgrade a till (the till refuses anything not newer), so this is about
 * picking the right one quickly: the newest few, plus the version the client is approved for if it is older, and
 * "Show all versions" for the rest.
 *
 * Pure, so the test runs it. Input is the cloud's list, newest first.
 */
export const RECENT_VERSIONS = 5;

export function visibleVersions<T extends { version: string }>(
  releases: T[], approved: string | null | undefined, showAll: boolean, recent = RECENT_VERSIONS,
): T[] {
  if (showAll || releases.length <= recent) return releases;
  const head = releases.slice(0, recent);
  const keep = approved ? releases.find((r) => r.version === approved) : undefined;
  return keep && !head.includes(keep) ? [...head, keep] : head;
}
