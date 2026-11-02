/**
 * web-signin-hygiene.test.mjs — three small web fixes, owner 2026-10-09:
 *   A419 — no "Server address…" on the admin portal's sign-in (it stays on Account, once signed in);
 *   A420 — no version on the client's web in production (the dev web, the admin portal and the console keep it);
 *   A423 — Add staff no longer fills in the owner's saved email and password (browser autofill).
 *
 * Pins on the source (React is not run here).
 *
 * MUTATIONS TO CONFIRM BITE: the "Server address…" button put back on LoginPage → A419 fails; ReleaseBadge without the
 * isProdDeployment() guard → A420 fails; isProdDeployment treating an absent VITE_APP_ENV as dev → its pin fails; one
 * staff PIN without autoComplete="new-password" → A423 fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const admin = read('apps/admin/src/AdminPortal.tsx');
const login = admin.slice(admin.indexOf('function LoginPage('), admin.indexOf('\n}\n', admin.indexOf('function LoginPage(')));
const account = admin.slice(admin.indexOf('function AccountPage('));

ok('A419: the admin sign-in has no server address', () => {
  assert.ok(login.length > 0, 'LoginPage not found');
  assert.doesNotMatch(login, /setShowApi|setApiUrl|saveApi|Save server address/);
});
ok('A419: Account still sets the server address', () => {
  assert.match(account, /setApiUrl\(apiInput\); saveApi\(apiInput\);/);
});

ok('A420: production is anything but dev, an absent setting included', () => {
  assert.match(read('apps/dashboard/src/lib/appFlavor.ts'),
    /export function isProdDeployment\(\): boolean \{\s*return \(import\.meta\.env\.VITE_APP_ENV \?\? 'prod'\)\.toLowerCase\(\) !== 'dev';/);
});
ok('A420: the version badge shows nothing in production', () => {
  assert.match(read('apps/dashboard/src/components/ReleaseBadge.tsx'),
    /export default function ReleaseBadge\(props[^\n]*\) \{\s*if \(isProdDeployment\(\)\) return null;/);
});

ok('A423: every email on the staff form is autoComplete="off"', () => {
  const s = read('apps/dashboard/src/pages/settings/StaffTab.tsx');
  const emails = s.match(/<input type="email"[\s\S]*?\/>/g) ?? [];
  // A608: one e-mail field when adding (the PIN / invite tabs are gone — the role decides), one when editing.
  assert.equal(emails.length, 2, `expected 2 email inputs, found ${emails.length}`);
  for (const e of emails) assert.match(e, /autoComplete="off"/);
});
ok('A423: every PIN on the staff form is autoComplete="new-password"', () => {
  const s = read('apps/dashboard/src/pages/settings/StaffTab.tsx');
  const pins = s.match(/<input\s+type="password"[\s\S]*?\/>/g) ?? [];
  assert.equal(pins.length, 2, `expected 2 PIN inputs, found ${pins.length}`);
  for (const p of pins) assert.match(p, /autoComplete="new-password"/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
