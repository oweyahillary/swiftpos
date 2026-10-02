/**
 * owner-permissions-wildcard.test.mjs — A202 (owner dashboard hid owner-only features).
 *
 * The server treats the owner as all-access: requirePermission() bypasses on
 * req.isOwner, and migration 24 deliberately does NOT explicitly grant owner-only
 * permissions (ingredients.manage, inventory.adjust) to the owner role — "owners
 * are never role-gated (auth grants them a wildcard)". The dashboard, however, used
 * to resolve the owner's rights from the owner role's EXPLICIT role_permissions, so
 * can('ingredients.manage') returned false and the "+ Add Ingredient" button (and
 * inventory-adjust, etc.) were hidden from the owner despite the server allowing
 * them. Fix: the dashboard mirrors the server wildcard.
 *
 * Source-level; mutation-checkable. Pins BOTH sides of the contract so they can't drift.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx  = fs.readFileSync(path.join(root, 'apps/dashboard/src/context/PermissionsContext.tsx'), 'utf8');
const rbac = fs.readFileSync(path.join(root, 'apps/server/src/middleware/rbac.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('server: requirePermission bypasses on the owner (the wildcard the client must mirror)', () => {
  assert.match(rbac, /req\.isOwner \|\| keys\.includes\('\*'\) \|\| keys\.includes\(permission\)/,
    'the server owner-bypass is the contract the client mirrors');
});

ok('client: the owner dashboard grants the wildcard, not a filtered explicit set', () => {
  assert.match(ctx, /setPermissionKeys\(new Set\(\['\*'\]\)\);/,
    'the owner load path must set the wildcard');
  // The old bug: filtering permissionKeys to the owner role's explicit grants.
  assert.doesNotMatch(ctx, /\.filter\(p => ownerPermIds\.has\(p\.id\)\)/,
    'must NOT filter permissionKeys to the owner role\'s explicit role_permissions (that hid owner-only features)');
});

ok('client: can() still honours the wildcard', () => {
  assert.match(ctx, /if \(permissionKeys\.has\('\*'\)\) return true;/,
    'can() must short-circuit true on the wildcard');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
