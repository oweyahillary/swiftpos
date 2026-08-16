/**
 * refresh-grace.test.mjs — proves the refresh-token reuse decision tells a lost
 * rotation response (reissue) from a genuine replay (revoke session), so a
 * dropped packet no longer logs the owner out of the till (register A88 / D13).
 *
 *   node tests/refresh-grace.test.mjs
 *
 * Imports the real pure function from the built server dist (no DB, no side
 * effects). Skips cleanly if the server has not been built.
 */
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}`); }
};

const dist = path.resolve('apps/server/dist/lib/refreshGrace.js');
if (!existsSync(dist)) {
  console.log('SKIP  apps/server/dist/lib/refreshGrace.js not built — build the server first.');
  process.exit(0);
}
const { refreshGraceDecision } = await import(pathToFileURL(dist).href);

const now = new Date().toISOString();

// ── not revoked → normal rotation ────────────────────────────────────────────
ok('a live token is valid (normal rotation)',
   refreshGraceDecision({ revokedAt: null, successorExists: false, successorRevokedAt: null }) === 'valid');

// ── LOST RESPONSE → reissue ──────────────────────────────────────────────────
ok('revoked, successor still the live head → reissue (client never got the response)',
   refreshGraceDecision({ revokedAt: now, successorExists: true, successorRevokedAt: null }) === 'reissue');

// ── REPLAY: chain advanced (successor itself rotated) → revoke ────────────────
ok('revoked, successor ALSO revoked (chain moved on) → replay',
   refreshGraceDecision({ revokedAt: now, successorExists: true, successorRevokedAt: now }) === 'replay');

// ── REPLAY: no successor (logout revoke) → revoke ────────────────────────────
ok('revoked with NO successor (logout, not rotation) → replay',
   refreshGraceDecision({ revokedAt: now, successorExists: false, successorRevokedAt: null }) === 'replay');

// ── time independence: an old revoked token still reissues if the successor is
//    still the live head — survives a power cut where a time window would fail ─
ok('reissue does not depend on how long ago it was revoked',
   refreshGraceDecision({ revokedAt: '2020-01-01T00:00:00.000Z', successorExists: true, successorRevokedAt: null }) === 'reissue');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
