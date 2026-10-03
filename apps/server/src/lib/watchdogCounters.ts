/**
 * watchdogCounters.ts — A383: what the watchdog cannot read from the database, counted in this process.
 *
 * Server errors (5xx, for the "burst" alert), failed sign-ins and the till writes the write guard flags (A159) — for the
 * morning digest. In memory: a deploy or restart starts the counts again (the digest says "since" when). One Render
 * instance (render.yaml), so one process sees every request.
 */

const KEEP_MS = 60 * 60_000;
const MAX_ERRORS = 2000;

const errorTimes: number[] = [];
const errorPaths: string[] = [];
let since = new Date().toISOString();
let serverErrors = 0;
let failedSignIns = 0;
let writeGuard = 0;

/** A response went out with a 5xx. */
export function recordServerError(path: string, at = Date.now()): void {
  serverErrors++;
  errorTimes.push(at);
  errorPaths.push(path.split('?')[0]);
  const cut = at - KEEP_MS;
  while (errorTimes.length && (errorTimes[0] < cut || errorTimes.length > MAX_ERRORS)) { errorTimes.shift(); errorPaths.shift(); }
}

/** A sign-in (password or PIN) was refused. */
export function recordFailedSignIn(): void { failedSignIns++; }

/** The write guard flagged (dry-run) or blocked (enforced) a till's write. */
export function recordWriteGuard(): void { writeGuard++; }

/** The recent 5xx times and their newest paths (newest last) — for the burst rule. */
export function recentErrors(): { times: number[]; paths: string[] } {
  return { times: [...errorTimes], paths: errorPaths.slice(-5).reverse() };
}

/** The digest's counts since the last digest; `reset` starts the next period. */
export function digestCounters(reset = false): { writeGuard: number; failedSignIns: number; serverErrors: number; since: string } {
  const out = { writeGuard, failedSignIns, serverErrors, since };
  if (reset) { writeGuard = 0; failedSignIns = 0; serverErrors = 0; since = new Date().toISOString(); }
  return out;
}

/** Is this refused request a sign-in attempt? (401 on a sign-in route — wrong password or PIN.) */
export function isSignInFailure(method: string, path: string, status: number): boolean {
  if (status !== 401 || method !== 'POST') return false;
  const p = path.split('?')[0];
  return /^\/api\/(admin\/)?auth\/(login|pos-login|verify-pin)\/?$/.test(p) || /^\/api\/staff\/clock\/?$/.test(p);
}
