/**
 * reports-export-auth.test.mjs — A143 (exports 401'd, no auth on download) +
 * A200 (test-email leaked internal hosting diagnostics to the UI).
 *
 * A143: every report export used window.open(API_URL/...) which sends NO
 * Authorization header cross-origin, so every download returned
 * {"error":"Missing or malformed Authorization header"}. Fixed by fetching the
 * file WITH the auth header (api.downloadFile) and saving the blob.
 *
 * A200: POST /api/notifications/test-email returned result.error verbatim — the
 * mailer's diagnostic (SMTP ports, Render plan, "CHECK THE LIVE INSTANCE TYPE").
 * Fixed to log server-side + return a generic message.
 *
 * Source-level, mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiTs   = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/api.ts'), 'utf8');
const reports = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/ReportsPage.tsx'), 'utf8');
const notif   = fs.readFileSync(path.join(root, 'apps/server/src/routes/notifications.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

// ── A143 ──
ok('api: downloadFile fetches WITH the auth header', () => {
  assert.match(apiTs, /export async function downloadFile/, 'downloadFile helper must exist');
  assert.match(apiTs, /const authHeader = await getAuthHeader\(\);[\s\S]*?fetch\(`\$\{BASE_URL\}\$\{path\}`,[\s\S]*?\.\.\.authHeader/,
    'downloadFile must attach the auth header to the fetch');
});

ok('reports: NO export goes through an unauthenticated window.open', () => {
  const leaks = reports.match(/window\.open\(`\$\{API_URL\}\/api\/reports\/export/g) || [];
  assert.strictEqual(leaks.length, 0,
    `found ${leaks.length} window.open export call(s) — every export must use downloadFile`);
});

ok('reports: exports use the authed downloadFile helper', () => {
  const uses = reports.match(/downloadFile\(`\/api\/reports\/export\//g) || [];
  assert.ok(uses.length >= 4, `expected all 4 exports (sales/hourly/products + hub) on downloadFile; found ${uses.length}`);
});

// ── A200 ──
ok('test-email: does NOT return the raw mailer diagnostic to the client', () => {
  assert.doesNotMatch(notif, /error:\s*result\.error/,
    'the route must not forward result.error (the internal SMTP/Render diagnostic) to the UI');
});

ok('test-email: logs the diagnostic server-side + returns a generic message', () => {
  assert.match(notif, /console\.error\('\[test-email\] delivery failed:'/,
    'the full diagnostic must be logged server-side');
  assert.match(notif, /error: 'Test email could not be sent/,
    'the client must get a clean, generic message');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
