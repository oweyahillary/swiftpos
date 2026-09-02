/**
 * device-token.test.mjs — A164, SCOPE-node-authority Phase 1 (cloud device-grant).
 *
 * Proves the pure device-grant helpers: the per-device secret hash/verify, the
 * grantable-status gate (how a revoked/pending terminal is refused), and the
 * token-claims builder. The security-load-bearing assert is that the grant token
 * is isOwner:false — that is the ONLY mode the A159 write-guard bounds, so a bug
 * that minted isOwner:true would silently hand a till the owner's unguarded
 * surface. Constant-time verify and the uniform-failure gate are money/security,
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
const { generateDeviceSecret, hashDeviceSecret, verifyDeviceSecret, isDeviceGrantable, buildDeviceTokenPayload } =
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

// ── Token claims — the security-load-bearing shape ──
const claims = buildDeviceTokenPayload({
  userId: 'owner-1', businessId: 'B1', branchId: 'BR9', permissionsVersion: 4, sessionId: 'sess-1',
});
ok('token is isOwner:FALSE (branch-locks + blocks web-only surface + forces per-request revalidation)', claims.isOwner === false);
ok('token surface is desktop', claims.surface === 'desktop');
ok('token is branch-bound (isOwner:false is branch-locked by rbac)', claims.branchId === 'BR9');
ok('token carries owner principal + business', claims.userId === 'owner-1' && claims.businessId === 'B1');
ok('token keeps [*] keys (rbac passes; the write-guard is the bound)', Array.isArray(claims.permissionKeys) && claims.permissionKeys[0] === '*');
ok('token carries permissionsVersion + sessionId', claims.permissionsVersion === 4 && claims.sessionId === 'sess-1');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
