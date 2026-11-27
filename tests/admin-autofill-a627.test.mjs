/**
 * admin-autofill-a627.test.mjs — A627 P0-1: the admin portal's "new account" forms must not let Chrome autofill the
 * signed-in admin's OWN saved email/password.
 *
 * The Add Team Member form, the New-client owner email + temporary password, and the Change-password form rendered bare
 * type="email"/type="password" inputs with a generic name and no autocomplete, so the browser offered the current admin's
 * saved credentials. The fix copies the login form's discipline: a distinct name/id and the right autocomplete token
 * (off / new-password), so the browser treats them as fresh fields. This is a source pin — the admin app is not built here.
 *
 *   node --no-warnings tests/admin-autofill-a627.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'apps/admin/src/AdminPortal.tsx'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.message).split('\n').slice(0, 3).join('\n      ')}`); } };

ok('the login form still declares username / current-password (the discipline being copied)', () => {
  assert.match(src, /autoComplete="username"/);
  assert.match(src, /autoComplete="current-password"/);
});

ok('Add Team Member: a distinct name/id and autocomplete (email off, password new-password) — never the admin\'s own', () => {
  assert.match(src, /\["Email","email","email","off","tm-new-email"\]/);
  assert.match(src, /\["Password","password","password","new-password","tm-new-password"\]/);
  assert.match(src, /name=\{nm\} id=\{nm\} autoComplete=\{ac\}/);
});

ok('New-client owner email: a distinct name/id and autoComplete off (not type=email alone)', () => {
  assert.match(src, /name="newClientOwnerEmail" id="newClientOwnerEmail" autoComplete="off"/);
});

ok('New-client temporary password: a distinct name/id and autoComplete new-password', () => {
  assert.match(src, /name="newClientOwnerTempPassword" id="newClientOwnerTempPassword" autoComplete="new-password"/);
});

ok('Change password: current-password for the current field, new-password for the new/confirm fields, distinct name/id', () => {
  assert.match(src, /"Current password", current, setCurrent, "current-password", "cp-current"/);
  assert.match(src, /"New password \(8\+ characters\)", newPw, setNewPw, "new-password", "cp-new"/);
  assert.match(src, /"Confirm new password", confirm, setConfirm, "new-password", "cp-confirm"/);
  assert.match(src, /type="password" name=\{nm\} id=\{nm\} autoComplete=\{ac\}/);
});

ok('no bare new-account credential inputs remain (type without a name/autoComplete) in those forms', () => {
  // The Add Team Member and Change-password maps must thread name/id/autoComplete, not render a bare input.
  assert.doesNotMatch(src, /<input style=\{S\.input\} type=\{t\} value=\{form\[k\]\} required/);
  assert.doesNotMatch(src, /<input style=\{S\.input\} type="password" value=\{v\} required onChange/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
