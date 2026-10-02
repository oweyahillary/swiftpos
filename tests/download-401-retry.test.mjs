/**
 * download-401-retry.test.mjs — A201 (export can 401 on the first click after refresh).
 *
 * api.request() refreshes the token and retries once on a 401; the A143 downloadFile
 * helper did a single fetch, so the first export click before the token hydrated
 * could 401 ("Missing or malformed Authorization header") and fail. Fix: downloadFile
 * mirrors request()'s 401 → refreshAccessToken() → retry-once path.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api  = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/api.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

// Isolate the downloadFile body so we assert on it specifically.
const dl = api.slice(api.indexOf('export async function downloadFile'),
                     api.indexOf('export const api'));

ok('downloadFile takes an isRetry guard (retry-once, not a loop)', () => {
  assert.match(dl, /export async function downloadFile\(path: string, filename: string, isRetry = false\)/,
    'downloadFile must have the isRetry parameter');
});

ok('downloadFile refreshes + retries once on a 401 with a stored token', () => {
  assert.match(dl, /res\.status === 401 && !isRetry/, 'must handle a 401 only when not already retrying');
  assert.match(dl, /await refreshAccessToken\(\);\s*return downloadFile\(path, filename, true\);/,
    'on 401 it must refresh then retry once (isRetry=true)');
});

ok('downloadFile signals session-expiry if refresh fails (no infinite retry / crash)', () => {
  assert.match(dl, /catch \{\s*signalSessionExpired\(\);/,
    'a failed refresh must sign out cleanly, not loop');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
