/**
 * staleBuild.ts — A610 (owner, 2026-10-29: "the error on the screenshot it always appears, what causes it" — "random
 * pages"). Every page is its own chunk (App.tsx lazy()). A tab opened before a deploy still asks for the OLD chunk names;
 * vercel.json rewrites every missing path to /index.html, so the browser gets HTML where it wanted a script, refuses it
 * (nosniff) and the lazy page throws — the ErrorBoundary's "Something went wrong" on whichever page was opened next.
 * The cure is a fresh load of the new build: done once by itself, never in a loop (a real outage must still show).
 */

const KEY = 'zaptill.staleReloadAt';
/** A second stale-chunk failure within this long after our own reload is not a stale tab — show the error. */
const AGAIN_MS = 60_000;

/** A failed lazy page / preload: the browsers' own words for a module that could not be fetched or was not a script. PURE. */
export function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  const text = `${typeof e?.name === 'string' ? e.name : ''} ${typeof e?.message === 'string' ? e.message : String(err ?? '')}`;
  return /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|is not a valid JavaScript MIME type/i.test(text);
}

/** Reload the page for the new build, unless we already did so in the last minute. True = a reload is under way. */
export function reloadForNewBuild(now: number = Date.now()): boolean {
  let last = 0;
  // Storage blocked: we could not tell our own reload from the next one, so never reload by ourselves (no loop).
  try { last = Number(sessionStorage.getItem(KEY) ?? 0) || 0; sessionStorage.setItem(KEY, String(now)); } catch { return false; }
  if (last && now - last < AGAIN_MS) return false;
  window.location.reload();
  return true;
}
