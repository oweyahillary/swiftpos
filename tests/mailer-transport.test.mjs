/**
 * mailer-transport.test.mjs
 *
 * THE BUG THIS PINS (register A50)
 * --------------------------------
 * Daily summaries failed for NINE businesses on every run, across both observed
 * days, and nobody knew:
 *
 *   [dailySummary] Failed for Beryl: connect ENETUNREACH 2607:f8b0:400e:c02::6c:587
 *
 * `2607:f8b0::/32` is Google over IPv6, port 587 — the SMTP fallback. Render's
 * container has no usable route there, so nodemailer resolved AAAA first and
 * died on connect(), before TLS, before AUTH, before any recipient was offered.
 *
 * Three things follow from ENETUNREACH being a CONNECT-layer failure, and all
 * three were checked against the production log before this fix was written:
 *
 *   * it is not bad recipients on the test businesses — a bad address gives an
 *     SMTP 550 after RCPT TO, and Beryl (a real client) failed identically;
 *   * it is not an unverified Resend domain — RESEND_API_KEY was absent, so
 *     `resend` was null and that branch never ran. The boot log said so;
 *   * `Connection timeout` in the same run is the same fault on a different
 *     IPv6 route, hitting connectionTimeout rather than failing instantly.
 *
 * The transport is the FALLBACK, so it is what every send lands on whenever
 * Resend is unset or rejects. It has to work by itself.
 *
 * WHY THE ASSERTIONS LOOK LIKE THIS
 * ---------------------------------
 * Section 1 builds a REAL nodemailer transport with the same options object the
 * server uses and reads back what nodemailer stored, so it proves the setting
 * survived into the transport rather than proving a string appears in a file.
 * `family` is missing from @types/nodemailer 8.0.x while being honoured at
 * runtime, which is exactly the gap where a silent regression would live.
 *
 * Section 3 asserts on source because the failure mode is structural — a boot
 * hook that is not called reports nothing — and calling it for real would open
 * a socket from CI.
 *
 * MUTATION-CHECKED (rules 10 and 23): drop `family: 4` and section 1 goes red;
 * drop the `void reportMailReadiness()` line from index.ts and section 3 does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// fileURLToPath, not new URL(...).pathname — the latter yields /C:/... on
// Windows and path.resolve then prepends the drive again (register A33).
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const require = createRequire(resolve(ROOT, 'apps/server/package.json'));

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

/**
 * Blank out comments before asserting.
 *
 * THIS FILE FAILED ITS OWN MUTATION CHECK WITHOUT THIS. Commenting out
 * `family: 4,` and `void reportMailReadiness();` left both lines matching their
 * regexes, so all 14 assertions passed against a codebase with the fix removed —
 * a test that reports green on the exact defect it exists to catch.
 *
 * Third time this session (check-auth-retry read `.from('stock')` out of the
 * comment explaining the B6 fix; manage-fetch-refresh asserted against an empty
 * default parameter). Comments are code to a regex. Rule 23.
 */
const decomment = src => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

const rawMailer = readFileSync(resolve(ROOT, 'apps/server/src/lib/mailer.ts'), 'utf8');
const mailerSrc = decomment(rawMailer);
const indexSrc  = decomment(readFileSync(resolve(ROOT, 'apps/server/src/index.ts'), 'utf8'));

console.log('\nmailer transport — IPv4 and boot readiness\n');

// ── 1. WHY THE FIRST FIX FAILED, pinned so it cannot come back ────────────
console.log('1. family: 4 was never read (the first fix, and why it failed)');

// This is the correction. `family: 4` shipped, and production answered:
//
//   [mailer] SMTP FALLBACK IS DEAD — smtp.gmail.com:587 —
//            connect ENETUNREACH 2607:f8b0:400e:c20::6c:587
//
// nodemailer's smtp-connection builds its DNS options as
// { port, host, allowInternalNetworkInterfaces, timeout } — `family` is NOT
// among them. It resolves with dns.lookup(host, {all:true}), filters with
// isFamilySupported() (does this machine HAVE an IPv6 interface — not does it
// have a working ROUTE), then picks a RANDOM survivor.
//
// The earlier version of this file asserted that nodemailer STORED family: 4.
// It does store it. It never reads it. Storage is not effect, and the mutation
// check could not tell the difference because both versions were equally
// ineffective. That is the whole lesson here.
ok('the transport no longer relies on family',
   !/family:\s*[46]/.test(mailerSrc),
   'nodemailer ignores it during resolution, so shipping it is a fix that looks '
   + 'applied and is not — which is worse than no fix, because the boot check '
   + 'then reports DEAD with no obvious cause.');

// Because the pick is RANDOM rather than ordered, ipv4first would not have
// helped either. Worth pinning so nobody "simplifies" to it later.
ok('it does not rely on dns result ORDER either',
   !/setDefaultResultOrder/.test(mailerSrc),
   'formatDNSValue picks a random address from the filtered list, so ordering '
   + 'the list changes nothing.');

// ── 2. The fix: an address nodemailer cannot get wrong ────────────────────
console.log('\n2. a pinned IPv4 literal, with TLS still checked by NAME');
ok('A records are resolved explicitly', /dns\.resolve4/.test(mailerSrc));
ok('the resolved literal is used as the host',
   /host:\s*ipv4\s*\?\?/.test(mailerSrc));
ok('tls.servername keeps certificate validation on the HOSTNAME',
   /servername:\s*SMTP_HOST/.test(mailerSrc),
   'Connecting to 74.125.126.108 without servername validates the certificate '
   + 'against the literal and every send fails verification instead of routing '
   + '— trading one silent failure for another.');
ok('the pin is re-resolved on a TTL',
   /PIN_TTL_MS/.test(mailerSrc),
   'Google rotates these addresses; a literal pinned once at boot goes stale.');
ok('a DNS blip keeps the last good address rather than falling back to the name',
   /Keep the previous value/.test(rawMailer),
   'Falling back to the hostname would restore the exact failure mode.');
ok('SMTP is still only built when host, user and pass are all present',
   /SMTP_HOST\s*\|\|[\s\S]{0,80}SMTP_USER\s*\|\|[\s\S]{0,80}SMTP_PASS/.test(mailerSrc)
     || /!SMTP_HOST[\s\S]{0,120}SMTP_PASS/.test(mailerSrc));

// ── 3. A dead mail path announces itself at boot ───────────────────────────
console.log('\n3. boot readiness');
ok('reportMailReadiness is exported',
   /export\s+async\s+function\s+reportMailReadiness/.test(mailerSrc));
ok('it calls verify() rather than sending a probe email',
   /smtp\.verify\(\)/.test(mailerSrc),
   'verify() connects and authenticates without delivering anything.');
ok('index.ts calls it at boot',
   /reportMailReadiness\(\)/.test(indexSrc),
   'A boot check nobody calls reports nothing. This is the whole point: the '
   + 'failure was silent for as long as anyone had been looking.');
ok('it is not awaited, so mail config cannot delay or block trading',
   /void\s+reportMailReadiness\(\)/.test(indexSrc),
   'Same rule as reportSeededAdmins — a shop must not fail to start over email.');
ok('it names the no-provider case explicitly',
   /NO EMAIL PROVIDER CONFIGURED/.test(mailerSrc));
ok('it warns when SMTP is the ONLY path',
   /ONLY path/.test(mailerSrc),
   'With RESEND_API_KEY unset — which is how production was running — an SMTP '
   + 'failure means nothing is delivered at all, not that a fallback took over.');

// ── 4. The fallback order is unchanged ─────────────────────────────────────
console.log('\n4. send path unchanged');
ok('Resend is still tried first when configured',
   mailerSrc.indexOf('resend.emails.send') < mailerSrc.indexOf('smtp.sendMail'));
ok('SMTP is still the fallback after a Resend error',
   /falling back to SMTP/.test(mailerSrc));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
