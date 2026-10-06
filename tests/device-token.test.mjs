/**
 * device-token.test.mjs — A164, SCOPE-node-authority Phase 1 (cloud device-grant).
 *
 * Proves the pure device-grant helpers: the per-device secret hash/verify, the
 * grantable-status gate (how a revoked/pending terminal is refused), and the
 * token-claims builder. A415: the till's token names the till, the business and
 * the branch — and no person (userId null): nothing ties it to the owner. It is
 * isOwner:false, so rbac branch-locks it and requireWebSurface keeps it off
 * web-only features. Constant-time verify and the uniform-failure gate are money/security,
 * so they are mutation-checked.
 *
 * Imports the real built server dist (no DB). Skips if the server isn't built.
 *   node tests/device-token.test.mjs
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

const dist = path.resolve('apps/server/dist/lib/deviceGrant.js');
if (!existsSync(dist)) {
  console.log('SKIP  apps/server/dist/lib/deviceGrant.js not built — build the server first.');
  process.exit(0);
}
const { generateDeviceSecret, hashDeviceSecret, verifyDeviceSecret, isDeviceGrantable, buildDeviceTokenPayload,
  isTillPayload, isOwnerEraTillPayload, tillBlockReason, tillBranch } =
  await import(pathToFileURL(dist).href);

// ── Secret generation + hashing ──
const s1 = generateDeviceSecret();
const s2 = generateDeviceSecret();
ok('generated secret is versioned + high-entropy', typeof s1 === 'string' && s1.startsWith('dg1.') && s1.length > 40);
ok('two secrets differ', s1 !== s2);
ok('hash is 64-hex sha256', /^[0-9a-f]{64}$/.test(hashDeviceSecret(s1)));
ok('hash is deterministic', hashDeviceSecret(s1) === hashDeviceSecret(s1));

// ── Verify: only the right secret against its own hash ──
const h1 = hashDeviceSecret(s1);
ok('verify: correct secret → true', verifyDeviceSecret(s1, h1) === true);
ok('verify: wrong secret → false', verifyDeviceSecret(s2, h1) === false);
ok('verify: empty secret → false', verifyDeviceSecret('', h1) === false);
ok('verify: null hash (device predates grant) → false', verifyDeviceSecret(s1, null) === false);
ok('verify: garbage hash → false', verifyDeviceSecret(s1, 'nope') === false);

// ── Grantable-status gate — how a lost/decommissioned terminal is cut off ──
ok('status approved → grantable', isDeviceGrantable('approved') === true);
ok('status active → grantable', isDeviceGrantable('active') === true);
ok('status pending → refused', isDeviceGrantable('pending') === false);
ok('status rejected → refused', isDeviceGrantable('rejected') === false);
ok('status revoked (future) → refused', isDeviceGrantable('revoked') === false);
ok('status null → refused', isDeviceGrantable(null) === false);

// ── A415: the till's own session — the till, the business, the branch, NO person ──
const claims = buildDeviceTokenPayload({ deviceId: 'dev-T1', businessId: 'B1', branchId: 'BR9', sessionId: 'sess-1' });
ok('A415: no person in it — userId is null (never the owner)', claims.userId === null);
ok('A415: it names the till', claims.till === true && claims.deviceId === 'dev-T1');
ok('token is isOwner:FALSE (branch-locks + blocks web-only surface)', claims.isOwner === false);
ok('token surface is desktop', claims.surface === 'desktop');
ok('token is branch-bound (isOwner:false is branch-locked by rbac)', claims.branchId === 'BR9' && claims.businessId === 'B1');
ok('token keeps [*] keys (rbac passes; the write-guard is the bound)', Array.isArray(claims.permissionKeys) && claims.permissionKeys[0] === '*');
ok('no person\'s permissions version is tied to it', claims.permissionsVersion === 0 && claims.sessionId === 'sess-1');
ok('isTillPayload: the till\'s own token only', isTillPayload(claims) === true
  && isTillPayload({ userId: 'u', surface: 'desktop' }) === false && isTillPayload({ till: true, deviceId: '' }) === false);
ok('a pre-A415 till session (the owner on the till) is recognised — to be replaced, never accepted',
  isOwnerEraTillPayload({ userId: 'owner-1', isOwner: true, surface: 'desktop' }) === true
  && isOwnerEraTillPayload({ userId: 'staff', surface: 'desktop', pinSignIn: true }) === false
  && isOwnerEraTillPayload({ userId: 'owner-1', surface: 'web' }) === false
  && isOwnerEraTillPayload(claims) === false);
ok('a till may use its session only while it is on the business: approved and not retired',
  tillBlockReason({ status: 'approved', retired_at: null }) === null && tillBlockReason(null) === 'unknown'
  && tillBlockReason({ status: 'rejected' }) === 'blocked' && tillBlockReason({ status: 'approved', retired_at: '2026-10-06T00:00:00Z' }) === 'retired');
ok('the branch: the code\'s, else the bound one, else the reported one',
  tillBranch('BR-code', 'BR-bound', 'BR-rep') === 'BR-code' && tillBranch(null, 'BR-bound', 'BR-rep') === 'BR-bound'
  && tillBranch(null, null, 'BR-rep') === 'BR-rep' && tillBranch(null, null, null) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
