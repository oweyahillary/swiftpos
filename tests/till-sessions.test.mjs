/**
 * till-sessions.test.mjs — A407: a till's sign-in is never lost by accident, and ZapTill is emailed when one is.
 *
 * Owner, 2026-10-05 (Pollo Fried Chicken, a till on the PIN screen with "Please sign in again."): "how do we prevent
 * this from ever happening" — "if a till is rejected when it comes online after a long offline period i should get an
 * email". lib/tillSessions.ts and the watchdog rule run for real (compiled); the routes are pinned; the build check runs.
 *
 * MUTATIONS TO CONFIRM BITE: ownerActionMayRevoke allowing a 'device' session → "never the till's own" fails;
 * verify-pin revoking when the PIN user is the till's principal → its pin and check-till-sessions fail; tillsSignedOut
 * ignoring session_lost_at → "a till that could not sign back in is critical" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/tillSessions.js'))) { console.log('\nBuild the server first: cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const S = require(path.join(DIST, 'lib/tillSessions.js'));
const W = require(path.join(DIST, 'lib/watchdogRules.js'));

await ok('what a session is: the till itself, a person on a till (PIN), a browser', () => {
  assert.equal(S.sessionKind({ surface: 'desktop' }), 'device');
  assert.equal(S.sessionKind({ surface: 'desktop', pinSignIn: true }), 'pin');
  assert.equal(S.sessionKind({ surface: 'web' }), 'web');
  assert.equal(S.sessionKind(undefined), 'web');
});
await ok('an owner action never revokes the till\'s own session (marked, or naming an enrolled device); the asking browser stays', () => {
  const tills = new Set(['dev-T1']);
  assert.equal(S.ownerActionMayRevoke({ session_kind: 'device', device_hint: 'x' }, tills), false);
  assert.equal(S.ownerActionMayRevoke({ session_kind: null, device_hint: 'dev-T1' }, tills), false, 'a row from before migration 125');
  assert.equal(S.ownerActionMayRevoke({ session_kind: 'web', device_hint: 'Mozilla/5.0', session_id: 's9' }, tills, 's9'), false);
  assert.equal(S.ownerActionMayRevoke({ session_kind: 'web', device_hint: 'Mozilla/5.0', session_id: 's1' }, tills, 's9'), true);
  assert.equal(S.ownerActionMayRevoke({ session_kind: 'pin', device_hint: 'dev-T1' }, tills), false, 'a PIN session on a till is the till\'s business');
});
await ok('a till that could not sign back in is CRITICAL (emailed) — a blocked or retired one is not', () => {
  const now = new Date('2026-10-05T16:00:00Z');
  const a = W.tillsSignedOut([
    { id: 'd1', business_id: 'b1', terminal_code: 'T1', status: 'approved', session_lost_at: '2026-10-05T15:30:00Z', session_lost_reason: 'Its sign-in was refused and it holds no device secret' },
    { id: 'd2', business_id: 'b1', terminal_code: 'T2', status: 'approved', session_lost_at: null },
    { id: 'd3', business_id: 'b1', terminal_code: 'T3', status: 'rejected', session_lost_at: '2026-10-05T15:30:00Z' },
  ], now, { b1: 'Pollo Fried Chicken' });
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'critical'); assert.equal(a[0].key, 'till_signed_out:d1');
  assert.match(a[0].title, /^Pollo Fried Chicken: T1 is signed out and could not sign back in$/);
  assert.match(a[0].detail, /Since 30 min ago — Its sign-in was refused and it holds no device secret\..*Issue an enrolment code/);
});
await ok('the cloud: sessions say what they are; a renewal hands a till its device secret; the device grant records a lost till', () => {
  const a = read('apps/server/src/routes/auth.ts');
  assert.match(a, /\.insert\(\{ \.\.\.row, session_kind: sessionKind\(payload as \{ surface\?: string; pinSignIn\?: boolean \}\) \}\)/);
  // A415: the till renewing is identified by its own session (tillDevice), not a header.
  assert.match(a, /if \(tillDevice\) \{\s*try \{\s*if \(!tillDevice\.device_secret_hash\) \{/);
  assert.match(a, /res\.json\(\{ accessToken, refreshToken: newRefreshToken, token: accessToken, \.\.\.\(deviceSecret \? \{ deviceSecret \} : \{\}\) \}\);/);
  assert.match(a, /if \(!secret\) \{\s*await markTillSessionLost\(businessId, deviceId, 'Its sign-in was refused and it holds no device secret'\);/);
  assert.match(a, /if \(dev && !blocked\) await markTillSessionLost\(/);
  assert.match(a, /await clearTillSessionLost\(businessId, deviceId\);   \/\/ A407: back/);
  assert.match(a, /await clearTillSessionLost\(businessId, deviceId\);   \/\/ A407: joined again/);
});
await ok('the owner\'s own PIN on a till no longer signs the till out; "log out everywhere" and password changes skip tills', () => {
  const a = read('apps/server/src/routes/auth.ts');
  // A415: the till's own session names no person, so a PIN sign-in's revoke (by that person's id) never reaches it.
  assert.match(a, /\/\/ till-safe: by this person's id only — a till's own session has no person \(A415\)\s*if \(devKeyV\) \{\s*await supabase\s*\.from\('refresh_tokens'\)\s*\.update\(\{ revoked_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\('user_id', matchedUser\.id\)/);
  assert.match(a, /if \(payload\?\.userId\) await revokeBrowserSessions\(\[payload\.userId\]/);
  assert.match(read('apps/server/src/lib/passwordReset.ts'), /await revokeBrowserSessions\(userIds, bizIds, keepSession\);/);
});
await ok('the watchdog reads it (and emails critical); migration 125 adds the columns', () => {
  const j = read('apps/server/src/jobs/watchdog.ts');
  assert.match(j, /await step\('tills signed out', async \(\) => \{[\s\S]{0,400}\.not\('session_lost_at', 'is', null\);[\s\S]{0,120}return tillsSignedOut\(/);
  const m = read('migrations/125_till_sessions.sql');
  assert.match(m, /ADD COLUMN IF NOT EXISTS session_kind text;/);
  assert.match(m, /ADD COLUMN IF NOT EXISTS session_lost_at\s+timestamptz,/);
});
await ok('the build check passes — and is wired into CI by its name (scripts/check-*.mjs)', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-till-sessions.mjs')], { encoding: 'utf8' });
  assert.match(out, /OK — no revoke can sign out a till by accident\./);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
