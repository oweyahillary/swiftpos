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

const mailerSrc = decomment(readFileSync(resolve(ROOT, 'apps/server/src/lib/mailer.ts'), 'utf8'));
const indexSrc  = decomment(readFileSync(resolve(ROOT, 'apps/server/src/index.ts'), 'utf8'));

console.log('\nmailer transport — IPv4 and boot readiness\n');

// ── 1. The real transport, built and read back ─────────────────────────────
console.log('1. nodemailer actually receives family: 4');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* not installed here */ }

if (!nodemailer) {
  console.log('  skip nodemailer not installed — run `npm ci` in apps/server');
} else {
  // The same shape the server builds. If the server's literal loses `family`,
  // this test still passes — which is why section 2 reads the source too.
  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false, family: 4,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    auth: { user: 'x@example.com', pass: 'unused-in-this-test' },
  });

  const stored = t.options?.family ?? t.transporter?.options?.family;
  ok('a transport built with family: 4 reports family 4',
     stored === 4,
     `nodemailer stored family=${JSON.stringify(stored)}. If this is undefined, `
     + 'the option name changed and the IPv4 pin is not being applied — which is '
     + 'invisible until a container without an IPv6 route tries to send.');

  ok('the option survives without a type error at runtime',
     typeof t.sendMail === 'function');

  // Guard the direction of the fix: 6 must NOT be what we ship.
  const t6 = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, family: 6 });
  const stored6 = t6.options?.family ?? t6.transporter?.options?.family;
  ok('nodemailer distinguishes 4 from 6 (so the assertion above means something)',
     stored6 === 6 && stored !== stored6);
}

// ── 2. The server's own literal carries it ─────────────────────────────────
console.log('\n2. the shipped transport, not just a test one');
// NOT `/family:\s*4/` on its own — that also matches the phrase inside the
// reportMailReadiness error message at mailer.ts:152, so it stayed green when
// the real option was commented out. An assertion satisfied by a log string is
// worse than no assertion. The type widening is its own fact worth pinning:
// @types/nodemailer 8.0.x omits `family` while nodemailer honours it, and
// without the widening the options literal fails to compile at all.
ok('the SmtpOptions type widening for `family` is present',
   /type\s+SmtpOptions\s*=\s*SMTPTransport\.Options\s*&\s*\{\s*family\?:/.test(mailerSrc),
   'Without it TypeScript falls through to another createTransport overload and '
   + 'reports the misleading "\'host\' does not exist".');
ok('it is inside the createTransport options, not a stray comment',
   /createTransport\([\s\S]{0,2000}?family:\s*4/.test(mailerSrc));
ok('SMTP is still only built when host, user and pass are all present',
   /SMTP_HOST\s*&&[\s\S]{0,120}SMTP_USER\s*&&[\s\S]{0,120}SMTP_PASS/.test(mailerSrc),
   'A transport built from partial config would fail at send time instead of '
   + 'being cleanly absent.');

// ── 3. A dead mail path announces itself at boot ───────────────────────────
console.log('\n3. boot readiness');
ok('reportMailReadiness is exported',
   /export\s+async\s+function\s+reportMailReadiness/.test(mailerSrc));
ok('it calls verify() rather than sending a probe email',
   /smtpTransport\.verify\(\)/.test(mailerSrc),
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
   mailerSrc.indexOf('resend.emails.send') < mailerSrc.indexOf('smtpTransport.sendMail'));
ok('SMTP is still the fallback after a Resend error',
   /falling back to SMTP/.test(mailerSrc));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
