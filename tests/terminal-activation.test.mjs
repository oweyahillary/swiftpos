/**
 * terminal-activation.test.mjs — A158. Owner email/password login on a till was
 * retired so the owner's reusable dashboard credentials are never typed or stored
 * on shared hardware. A terminal is provisioned ONLY by a one-time enrolment code.
 *
 * This is a source-level guard across every layer (the Electron UI cannot run on
 * the bench). MUTATION CHECK: re-add owner-login at ANY layer — the App state, the
 * IPC handler, the preload bridge, the posApi binding, or un-tombstone the server
 * route — and the matching assertion below goes red and names the layer.
 *
 *   node tests/terminal-activation.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

const APP     = read('apps/desktop/src/renderer/App.tsx');
const PRELOAD = read('apps/desktop/src/main/preload.ts');
const IPC     = read('apps/desktop/src/main/ipcHandlers.ts');
const POSAPI  = read('apps/desktop/src/renderer/lib/posApi.ts');
const AUTH    = read('apps/server/src/routes/auth.ts');

// ── Renderer: no owner-login state, no LoginPage, enrol is the fallback ────────
ok('App.tsx has no owner-login state', () => {
  assert.ok(!/'owner-login'/.test(APP), "App.tsx still references the 'owner-login' state");
});
ok('App.tsx does not import LoginPage', () => {
  assert.ok(!/LoginPage/.test(APP.replace(/\/\/.*$/gm, '')), 'App.tsx still imports/uses LoginPage');
});
ok('LoginPage.tsx is deleted', () => {
  assert.ok(!fs.existsSync(path.join(root, 'apps/desktop/src/renderer/pages/LoginPage.tsx')),
    'LoginPage.tsx still exists — the owner email/password screen was not removed');
});
ok('a session-less till falls back to enrol, not login', () => {
  assert.ok(/setState\('enrol'\)/.test(APP), "App.tsx no longer routes a session-less till to 'enrol'");
  assert.ok(fs.existsSync(path.join(root, 'apps/desktop/src/renderer/pages/EnrolPage.tsx')),
    'EnrolPage.tsx is missing');
});

// ── IPC + preload + posApi: the owner-login channel is gone everywhere ─────────
ok('no auth:login IPC handler in the main process', () => {
  assert.ok(!/ipcMain\.handle\('auth:login'/.test(IPC), "ipcHandlers.ts still handles 'auth:login'");
});
ok('no login bridge in preload', () => {
  assert.ok(!/invoke\('auth:login'\)|invoke\('auth:login',/.test(PRELOAD), "preload.ts still bridges 'auth:login'");
  assert.ok(/invoke\('auth:enrolDevice'/.test(PRELOAD), 'preload.ts lost the enrolment bridge');
});
ok('no login binding in posApi', () => {
  assert.ok(!/\blogin:\s*\(email/.test(POSAPI), 'posApi.ts still exposes auth.login(email, password)');
  assert.ok(/redeemEnrolment:/.test(POSAPI), 'posApi.ts lost redeemEnrolment');
});

// ── Server: /desktop-login is a retired tombstone; enrol is the desktop entry ──
ok('/desktop-login accepts no credentials (tombstoned 410)', () => {
  const body = AUTH.slice(AUTH.indexOf("router.post('/desktop-login'"));
  const end  = body.indexOf('\nrouter.', 10);
  const route = body.slice(0, end === -1 ? undefined : end);
  assert.ok(/410/.test(route), '/desktop-login does not return 410');
  assert.ok(!/signInWithPassword/.test(route), '/desktop-login still calls signInWithPassword — credentials still accepted on a till');
});
ok('web dashboard /login is untouched', () => {
  const body = AUTH.slice(AUTH.indexOf("router.post('/login'"));
  assert.ok(/signInWithPassword/.test(body.slice(0, 2000)), '/login (web dashboard) lost its password auth');
});
ok('/enrol/redeem remains the one-time-code activation', () => {
  assert.ok(/router\.post\('\/enrol\/redeem'/.test(AUTH), '/enrol/redeem route is missing');
});

console.log(`\n${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'A158 terminal-activation guard');
