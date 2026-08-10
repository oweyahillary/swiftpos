/**
 * device-token-refresh.test.mjs — A51, the sawtooth.
 *
 * THE BUG THIS PINS
 * -----------------
 * Beryl's till log was 90 lines and every one was the same pair, exactly twenty
 * minutes apart, all day:
 *
 *     [sync] catalogue pull failed: HTTP 401 Unauthorized
 *     [sync] recovered after: catalogue pull failed: HTTP 401 Unauthorized
 *
 * Deterministic, not intermittent. syncAll() runs every 10 minutes
 * (index.ts:226); the access token lives 15 minutes (auth.ts:51); refresh was
 * purely reactive. After a refresh at T the pull at T+10 succeeded and the pull
 * at T+20 could not — 20 > 15. Every other pull 401'd BY CONSTRUCTION.
 *
 * Section 1 below is the arithmetic itself: it simulates the timeline and
 * asserts the old cadence produced a failure every 20 minutes and the new one
 * produces none. That is the finding, executable — not a restatement of it.
 *
 * WHY THE SCOPE ASSERTIONS MATTER MORE THAN THE FIX
 * -------------------------------------------------
 * The catalogue pull uses authHeaders() → _accessToken. pushAuthHeaders()
 * prefers _staffToken. A GENERIC proactive refresh would have refreshed the
 * staff token too — and a staff token expiring on an IDLE till is exactly the
 * condition A47 was reported under. Refreshing it early would make A47's field
 * test pass whether or not manageFetch was fixed, exactly as a 3-minute
 * auto-lock would.
 *
 * So section 3 asserts the fix does NOT touch the staff token. If someone later
 * "improves" this by refreshing both, that assertion is what stops it.
 *
 * MUTATION-CHECKED (rules 10 and 23): remove the refreshDeviceTokenIfExpiring()
 * call from syncAll and sections 1 and 2 go red; widen it to refresh the staff
 * token and section 3 goes red on its own.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// fileURLToPath, not new URL(...).pathname — the latter yields /C:/... on
// Windows and path.resolve then prepends the drive again (register A33).
const here = dirname(fileURLToPath(import.meta.url));
const SYNC = resolve(here, '../src/main/syncEngine.ts');

/**
 * Blank comments and string literals before asserting on source.
 *
 * Three checks this session passed against the defect they existed to catch
 * because they matched their own explanatory prose: check-auth-retry read
 * `.from('stock')` out of the comment describing the B6 fix, and
 * mailer-transport matched `family: 4` inside an ERROR MESSAGE. Comments and
 * strings are code to a regex.
 */
const decomment = src => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
  .replace(/`(?:[^`\\]|\\.)*`/g, m => m.replace(/[^\n]/g, ' '))
  .replace(/'(?:[^'\\\n]|\\.)*'/g, m => ' '.repeat(m.length));

const raw = readFileSync(SYNC, 'utf8');

/**
 * TWO views of the source, and the difference matters.
 *
 *   src        — comments AND string literals blanked. Use for assertions where
 *                a string could grant a false pass (the mailer test matched
 *                `family: 4` inside an error message and reported green against
 *                a codebase with the fix removed).
 *   srcNoStr   — comments blanked, strings KEPT. Use for assertions that must
 *                see a literal, e.g. that base64url is the decode passed to
 *                Buffer.from.
 *
 * Blanking strings everywhere hid 'base64url' from its own assertion on the
 * first run of this file — the over-correction from the previous lesson.
 */
const src      = decomment(raw);
const srcNoStr = raw
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

console.log('\ndevice token — proactive refresh (A51)\n');

// ── 1. The sawtooth, simulated ─────────────────────────────────────────────
console.log('1. the arithmetic that produced the log');

const TOKEN_LIFETIME = 15 * 60;
const PULL_EVERY     = 10 * 60;
// Read from the source, not hardcoded — otherwise the simulation keeps passing
// while the shipped constant drifts, which is the whole failure mode this file
// exists to prevent one level down.
const SKEW = Number((raw.match(/const REFRESH_SKEW_SECONDS = (\d+);/) ?? [])[1]);

/** Walk `hours` of ticks and count 401s under a given policy. */
function simulate({ proactive, hours = 12 }) {
  let issuedAt = 0, failures = 0;
  for (let t = 0; t <= hours * 3600; t += PULL_EVERY) {
    const remaining = (issuedAt + TOKEN_LIFETIME) - t;
    if (proactive && remaining <= SKEW) { issuedAt = t; continue; }  // refreshed ahead
    if (remaining <= 0) { failures++; issuedAt = t; }                // 401 then recover
  }
  return failures;
}

const before = simulate({ proactive: false });
const after  = simulate({ proactive: true });

ok('the OLD cadence fails repeatedly over a trading day',
   before > 0, `expected failures, got ${before}`);
ok('the old failures land every 20 minutes (2 pull ticks)',
   before === Math.floor((12 * 3600) / (2 * PULL_EVERY)),
   `${before} failures across 12h — a 10-minute pull against a 15-minute token `
   + 'fails every second tick, which is the 20-minute spacing in Beryl\'s log.');
ok('the NEW policy produces NO 401s at all',
   after === 0,
   `still ${after} failures — the token is being allowed to expire before the `
   + 'refresh, so the sawtooth is only shifted, not removed.');

ok('REFRESH_SKEW_SECONDS was found in the source', Number.isFinite(SKEW),
   'If this fails the constant was renamed and the simulation above is running '
   + 'on NaN — every comparison would be false and section 1 would pass by '
   + 'accident.');
// A margin of zero refreshes only once the token is already dead. That still
// avoids the 401 (the refresh runs before the pull), so it does not restore the
// sawtooth — but it leaves nothing for clock skew or a request in flight across
// the boundary, which is what the margin is actually for.
ok('the skew leaves a real margin, not zero',
   SKEW > 0 && SKEW < TOKEN_LIFETIME,
   `REFRESH_SKEW_SECONDS is ${SKEW}. Zero means the token is only refreshed once `
   + 'it has already expired — no room for clock drift between till and server.');

// ── 2. It is actually wired into syncAll ───────────────────────────────────
console.log('\n2. wired in, not merely defined');
ok('refreshDeviceTokenIfExpiring is defined',
   /async function refreshDeviceTokenIfExpiring/.test(src));
// Bounded to syncAll's OWN body. Slicing to EOF let the helper's definition
// three hundred lines below satisfy this, so it stayed green when the call was
// removed — caught by the mutation check, not by the green run.
const syncAllStart = src.indexOf('export async function syncAll');
const syncAllBody  = src.slice(syncAllStart, src.indexOf('\nexport ', syncAllStart + 10));
ok('syncAll calls it', /refreshDeviceTokenIfExpiring\(\)/.test(syncAllBody),
   'A helper nobody calls changes nothing — this is rule 17\'s pattern and the '
   + 'reason ESC/POS sat built and unconnected.');
ok('it runs BEFORE the catalogue pull',
   syncAllBody.indexOf('refreshDeviceTokenIfExpiring()') >= 0
     && syncAllBody.indexOf('refreshDeviceTokenIfExpiring()') < syncAllBody.indexOf('pullCatalogue()'),
   'Refreshing after the pull would leave the 401 exactly where it was.');
ok('the reactive 401 backstop is still present',
   /res\.status\s*===\s*401|!pulled\s*&&\s*_refreshToken/.test(src),
   'Proactive refresh is an optimisation, not a replacement. Clock skew, an '
   + 'unreadable exp, or a token rotated elsewhere must still be caught.');

// ── 3. SCOPE — this must never touch the staff token ───────────────────────
console.log('\n3. device token ONLY (this is the load-bearing one)');
const fnStart = src.indexOf('async function refreshDeviceTokenIfExpiring');
const fnBody  = src.slice(fnStart, src.indexOf('\n}', fnStart));
ok('it reads _accessToken', /_accessToken/.test(fnBody));
ok('it does NOT read _staffToken',
   !/_staffToken/.test(fnBody),
   'A staff token expiring on an IDLE till is the exact condition A47 was '
   + 'reported under. Refreshing it ahead of time makes A47\'s field test pass '
   + 'whether or not manageFetch is fixed — the same masking a 3-minute '
   + 'auto-lock would cause.');
ok('it does NOT call refreshStaffToken',
   !/refreshStaffToken/.test(fnBody));
ok('it calls refreshAccessToken', /refreshAccessToken/.test(fnBody));

// ── 4. exp decoding, and its failure mode ──────────────────────────────────
console.log('\n4. reading exp safely');
ok('secondsUntilExpiry exists', /function secondsUntilExpiry/.test(src));
ok('it decodes base64url', /base64url/.test(srcNoStr),
   'A JWT payload is base64URL, not base64. Plain base64 mangles - and _.');
ok('it is wrapped so an unreadable token cannot throw into the sync tick',
   /try\s*\{[\s\S]{0,400}?base64url[\s\S]{0,400}?catch/.test(srcNoStr));
ok('an unreadable exp falls through to the 401 path rather than refreshing blindly',
   /remaining === null\) return false/.test(src),
   'Refreshing on every tick when exp cannot be read would burn rotations — and '
   + 'each rotation is a chance for a replay that revokes every session.');

// Drive the null-safety directly.
const decode = jwt => {
  try {
    const p = jwt.split('.')[1];
    if (!p) return null;
    const { exp } = JSON.parse(Buffer.from(p, 'base64url').toString());
    return typeof exp === 'number' ? exp - Math.floor(Date.now() / 1000) : null;
  } catch { return null; }
};
const mk = secs => 'h.' + Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + secs })).toString('base64url') + '.s';

ok('a well-formed token reports roughly the right remaining time',
   Math.abs(decode(mk(600)) - 600) <= 2);
ok('garbage returns null rather than throwing', decode('not-a-jwt') === null);
ok('an empty string returns null', decode('') === null);
ok('a token with no exp claim returns null',
   decode('h.' + Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url') + '.s') === null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
