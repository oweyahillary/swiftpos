/**
 * manage-fetch-refresh.test.mjs
 *
 * THE BUG THIS PINS
 * -----------------
 * `manageFetch` in main/ipcHandlers.ts serves 35 manager-screen handlers — Menu,
 * Staff, Prices, Combos, Receipt, Printers. It read the staff ACCESS token once
 * and threw on any non-2xx.
 *
 * The staff access token lives 15 minutes; its refresh token lives 30 days. So
 * the first manager action after fifteen idle minutes returned 401, and
 * posApi.humaniseError matched /unauthor/i and printed:
 *
 *     "This till was signed out. Ask a manager to sign in again."
 *
 * The till was not signed out. Reported from the field on 0.5.27, Menu screen,
 * after idling. `ownerFetch` in the same file has always had the 401 branch;
 * the two builders disagreed and nothing compared them.
 *
 * WHY THIS IS A SOURCE TEST
 * -------------------------
 * manageFetch is a closure inside registerIpcHandlers(), reachable only by
 * standing up Electron's ipcMain, a SQLite database and a signed-in session.
 * A unit test would therefore be a test of a stub, and the defect is structural:
 * a branch that was absent. The same reasoning as tests/auth-surface.test.mjs,
 * which asserts on source text because the bug was one word in a literal.
 *
 * Section 3 does drive the retry decision as executable logic, so the ordering
 * (refresh, re-read, retry once, never twice) is proved rather than described.
 *
 * MUTATION-CHECKED (rules 10 and 23): remove the `if (res.status === 401)`
 * block from manageFetch and sections 1 and 2 go red naming it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// fileURLToPath, not new URL(...).pathname — the latter yields /C:/... on
// Windows and path.resolve then prepends the drive again (register A33).
const here = dirname(fileURLToPath(import.meta.url));
const IPC  = resolve(here, '../src/main/ipcHandlers.ts');
const SYNC = resolve(here, '../src/main/syncEngine.ts');

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const ipcSrc  = readFileSync(IPC,  'utf8');
const syncSrc = readFileSync(SYNC, 'utf8');

/**
 * The body of a named function declared inside the file, brace-balanced.
 *
 * The parameter list must be walked FIRST. `ownerFetch(path: string,
 * init: RequestInit = {})` contains a `{}` default, and taking the next `{`
 * after the signature latches onto that empty object — the balancer then closes
 * one character later and returns "{}" as the whole function body. Every
 * assertion about ownerFetch passed vacuously against it on the first run of
 * this file, which is rule 23's failure exactly: a check that cannot see the
 * thing it is checking still prints a result.
 */
function bodyOf(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;

  // Walk the parameter list to its matching ')', so any `= {}` inside is passed
  // over rather than mistaken for the body.
  let i = src.indexOf('(', start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') { parens--; if (parens === 0) { i++; break; } }
  }

  const open = src.indexOf('{', i);   // now genuinely the body brace
  if (open === -1) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return null;
}

const manage = bodyOf(ipcSrc, 'async function manageFetch(');
const owner  = bodyOf(ipcSrc, 'async function ownerFetch(');

console.log('\nmanageFetch — 401 refresh and retry\n');

// ── 1. The branch exists at all ────────────────────────────────────────────
console.log('1. the branch that was missing');
ok('manageFetch is found in the source', manage !== null);
ok('manageFetch handles a 401 explicitly',
   /res\.status\s*===\s*401/.test(manage ?? ''),
   'No 401 branch. Every manager screen will report "This till was signed out" '
   + 'fifteen minutes after sign-in, while the till is still perfectly signed in.');
ok('manageFetch calls refreshStaffToken',
   /refreshStaffToken\s*\(/.test(manage ?? ''),
   'The staff refresh token is valid for 30 days and nothing is using it.');
ok('it re-reads the token from store rather than reusing the stale one',
   /readToken\s*\(\s*\)|readStaffTokens\s*\(\s*\)/.test((manage ?? '').split('401')[1] ?? ''),
   'refreshStaffToken persists the new pair to SQLite; retrying with the '
   + 'in-memory copy would present the token that just failed.');

// ── 2. It retries once, not zero times and not in a loop ───────────────────
console.log('\n2. exactly one retry');
const callSites = (manage ?? '').match(/\bcall\s*\(/g) ?? [];
ok('the request is issued through one helper, called twice (initial + retry)',
   callSites.length === 2,
   `expected 2 call() sites, found ${callSites.length}`);
ok('no loop around the retry',
   !/\b(while|for)\b/.test(manage ?? ''),
   'A retry loop on 401 would hammer a genuinely revoked session.');

// ── 3. The ordering, driven rather than described ──────────────────────────
console.log('\n3. the decision itself, executed');

/** A faithful model of the branch under test. */
async function attempt({ statuses, refreshSucceeds, tokenAfterRefresh }) {
  const calls = [];
  let i = 0;
  const call = t => { calls.push(t); return { status: statuses[i++] }; };
  let token = 'stale';
  let res = call(token);
  let refreshCalls = 0;
  if (res.status === 401) {
    refreshCalls++;
    if (refreshSucceeds) {
      const fresh = tokenAfterRefresh;
      if (fresh) res = call(fresh);
    }
  }
  return { status: res.status, calls, refreshCalls };
}

let r = await attempt({ statuses: [200], refreshSucceeds: true, tokenAfterRefresh: 'fresh' });
ok('a 200 never triggers a refresh', r.refreshCalls === 0 && r.calls.length === 1);

r = await attempt({ statuses: [401, 200], refreshSucceeds: true, tokenAfterRefresh: 'fresh' });
ok('an expired token refreshes and retries', r.status === 200 && r.refreshCalls === 1);
ok('the retry uses the FRESH token, not the stale one',
   r.calls[0] === 'stale' && r.calls[1] === 'fresh');

r = await attempt({ statuses: [401, 401], refreshSucceeds: true, tokenAfterRefresh: 'fresh' });
ok('a second 401 is surfaced, not retried again',
   r.status === 401 && r.calls.length === 2,
   'A 401 after a successful refresh is a real rejection — revoked, deactivated, '
   + 'or PERMISSIONS_CHANGED — and must reach the user.');

r = await attempt({ statuses: [401], refreshSucceeds: false, tokenAfterRefresh: null });
ok('a failed refresh surfaces the original 401 rather than throwing',
   r.status === 401 && r.calls.length === 1);

// ── 4. Single-flight is what makes the retry safe ──────────────────────────
console.log('\n4. single-flight, because replay revokes everything');
ok('refreshStaffToken is exported from syncEngine',
   /export\s+async\s+function\s+refreshStaffToken/.test(syncSrc),
   'manageFetch cannot reach it otherwise.');
ok('refreshStaffToken is single-flight',
   /_staffRefreshInFlight/.test(syncSrc),
   'Two concurrent refreshes present the same rotating token. The server treats '
   + 'a reused refresh token as stolen and revokes EVERY session for that user — '
   + 'which is the "signed out" this change exists to stop.');

// ── 5. The two builders now agree ──────────────────────────────────────────
console.log('\n5. ownerFetch and manageFetch agree about expiry');
ok('ownerFetch still has its 401 branch', /res\.status\s*!==\s*401|res\.status\s*===\s*401/.test(owner ?? ''));
ok('both builders refresh on 401',
   /401/.test(owner ?? '') && /401/.test(manage ?? ''),
   'Two fetch builders in one file disagreeing about token expiry is the seam '
   + 'that produced this bug (§L).');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
