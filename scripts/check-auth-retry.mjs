#!/usr/bin/env node
/**
 * check-auth-retry.mjs — every authenticated fetch builder must handle 401.
 *
 * ── THE BUG THIS EXISTS FOR (register A47) ──────────────────────────────────
 * `manageFetch` in apps/desktop/src/main/ipcHandlers.ts attaches a bearer token
 * to 35 manager-screen handlers — Menu, Staff, Prices, Combos, Receipt,
 * Printers — and had NO 401 branch at all. `ownerFetch`, forty lines earlier in
 * the same file, has had one since it was written.
 *
 * The staff ACCESS token lives 15 minutes; its refresh token lives 30 days. So
 * the first manager action after fifteen idle minutes returned 401, and the
 * screen said "This till was signed out. Ask a manager to sign in again." The
 * till was signed in throughout — the sync engine was refreshing on its own
 * token, which is why selling never broke and the fault looked intermittent.
 *
 * §L: two things that must agree, with nothing comparing them. This compares
 * them. It is the fourth such comparator, after check-table-usage,
 * check-client-parity and check-header-keys.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────
 * A function is IN SCOPE when its body both:
 *   1. attaches an Authorization bearer header, AND
 *   2. issues a fetch()
 * ...i.e. it makes a request that can expire. Such a function must mention 401.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CHECK ─────────────────────────────────────
 * Whether the retry is CORRECT — that it refreshes, re-reads the token, and
 * retries exactly once. That is asserted by
 * apps/desktop/test/manage-fetch-refresh.test.mjs, which can drive the decision.
 * A source scan proving "the number 401 appears" would be pretending to more
 * than it knows. This gate answers one question: did anyone think about expiry
 * here at all?
 *
 * ── EXEMPTIONS ──────────────────────────────────────────────────────────────
 * The refresh call itself must NOT retry on 401 — a 401 there is the answer,
 * and retrying it is how a rotating token gets presented twice, which the
 * server treats as theft and answers by revoking every session for that user.
 * Exemptions are listed in code below with a reason each, not in a data file:
 * there are two, and a JSON file of unverified prose is how A49 happened.
 *
 * MUTATION-CHECKED: remove the 401 branch from manageFetch and this exits 1
 * naming ipcHandlers.ts and the function.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

// fileURLToPath, not new URL(...).pathname — the latter yields /C:/... on
// Windows and path.resolve then prepends the drive again (register A33).
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SCAN = ['apps/desktop/src/main', 'apps/desktop/src/renderer/lib'];

/**
 * Functions that must NOT retry on 401, with the reason. Kept in code, beside
 * the check, because an exception is a claim about behaviour and A49 is what a
 * file of unchecked claims costs. Every reason here is checkable in one grep.
 *
 * NOTE on what is NOT here: `doRefreshAccessToken` and `doRefreshStaffToken`
 * are the refresh calls themselves and must never retry a 401 — presenting a
 * rotating token twice is what the server's replay detection treats as theft,
 * and it answers by revoking EVERY session for that user. They need no entry
 * because they are already OUT OF SCOPE: they post `refreshToken` in the body
 * and attach no `Authorization: Bearer` header, so the AUTH test below never
 * matches them. Listing them anyway would be an exemption that exempts nothing
 * — precisely the unverified-claim shape this file's header warns about.
 */
const EXEMPT = new Map([
  ['refreshTechConfig',
   'apps/desktop/src/main/techService.ts. ONE call site — ipcHandlers.ts:126, '
   + 'immediately after /desktop-login returns, passing `data.token`, which is '
   + 'seconds old. Fire-and-forget (`.catch(() => {})`) and already `if (!res.ok) '
   + 'return`. A 401 on a token that new is not expiry, and the only cost of '
   + 'failing is that the tech panel cannot be unlocked offline until the next '
   + 'login. Adding a refresh loop here would be machinery for a case that cannot '
   + 'arise (rule 12). VERIFY BY: grep -rn "refreshTechConfig" apps/desktop/src — '
   + 'if a second call site ever appears, or one that passes a stored token, this '
   + 'exemption is void and the function needs the ownerFetch treatment.'],
]);

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out;
}

/** Blank out comments so a `.from(` or a `401` in prose is never matched. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/**
 * Every named function in the file, with its brace-balanced body.
 *
 * The parameter list is walked FIRST. `ownerFetch(path: string, init:
 * RequestInit = {})` contains a `{}` default, and taking the next `{` after the
 * name latches onto that empty object — the balancer closes one character later
 * and returns "{}" as the whole body. The first version of the companion test
 * did exactly this and reported two vacuous passes.
 */
function functionsIn(src) {
  const out = [];
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?=\()/g;
  let m;
  while ((m = re.exec(src))) {
    let i = src.indexOf('(', m.index);
    let parens = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') parens++;
      else if (src[i] === ')') { parens--; if (parens === 0) { i++; break; } }
    }
    const open = src.indexOf('{', i);
    if (open === -1) continue;
    let depth = 0, end = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    out.push({
      name: m[1],
      body: src.slice(open, end + 1),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

const AUTH   = /Authorization\s*:\s*[`'"]\s*Bearer/i;
const FETCH  = /\bfetch\s*\(/;
const HAS401 = /\b401\b/;

const offenders = [];
const exempted  = [];
let scanned = 0, inScope = 0;

for (const dir of SCAN) {
  for (const file of walk(join(ROOT, dir))) {
    const src = stripComments(readFileSync(file, 'utf8'));
    scanned++;
    for (const fn of functionsIn(src)) {
      if (!AUTH.test(fn.body) || !FETCH.test(fn.body)) continue;
      inScope++;
      if (EXEMPT.has(fn.name)) { exempted.push(fn.name); continue; }
      if (!HAS401.test(fn.body)) {
        offenders.push({ file: relative(ROOT, file), fn: fn.name, line: fn.line });
      }
    }
  }
}

console.log(
  `check-auth-retry: ${scanned} file(s), ${inScope} authenticated fetch builder(s), `
  + `${exempted.length} exempt (${exempted.join(', ') || 'none'}).`);

if (offenders.length) {
  console.error('\nAUTHENTICATED FETCH WITH NO 401 HANDLING:\n');
  for (const o of offenders) {
    console.error(`  ${o.fn}()  —  ${o.file}:${o.line}`);
  }
  console.error(
    '\nA bearer token expires. A builder that does not handle 401 will report a\n'
    + 'signed-out till fifteen minutes after a perfectly good sign-in, while the\n'
    + '30-day refresh token sits unused. That is register A47, and it reached a\n'
    + 'client.\n\n'
    + 'Fix: on 401 refresh, re-read the token from the store, retry ONCE. Copy\n'
    + 'ownerFetch in apps/desktop/src/main/ipcHandlers.ts. If the function is a\n'
    + 'refresh call itself, add it to EXEMPT in this file WITH a reason.\n');
  process.exit(1);
}

console.log('\nOK — every authenticated fetch builder handles token expiry.');
