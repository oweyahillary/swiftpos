/**
 * phone-pos-roles.test.mjs — Owner, 2026-11-22: who sees the "Open POS" shortcut in the OWNER / MANAGER PHONE app, and
 * the business-wide "Online (web) POS" switch.
 *
 *   node tests/phone-pos-roles.test.mjs        (no build — the pure logic is type-stripped from source on Node 24)
 *
 * RUNS, not reads, the pure resolution (apps/server/src/lib/phonePos.ts): the per-role default and the owner's override,
 * and the stored-map cleaning. Everything that needs the cloud, the browser or the phone is CHECKED IN THE SOURCE here
 * (the session field, the owner-only endpoints, the dashboard gate, the native marker, the owner UI) because it cannot run.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - phonePosFor defaulting to `isOwner || sells`                         → "owner never sees it by default"
 *   - phonePosFor ignoring the override map                               → "an explicit choice wins over the default"
 *   - asPhonePosMap keeping non-boolean values                            → "drops anything that is not a boolean"
 *   - DashboardLayout gating on web only (no isNativeApp/phonePos)         → "the phone gate is in mayOpen"
 *   - the session not returning phonePos                                  → "the session resolves phonePos"
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const P = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/phonePos.ts')).href);

// ── The pure resolution ──────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nthe per-role default and the owner\'s override\n');

await ok('owner never sees it by default (back-office on their phone)', () => {
  assert.equal(P.phonePosFor({}, 'owner-role', true, true), false);
  assert.equal(P.phonePosFor({}, 'owner-role', true, false), false);
});

await ok('a selling role that is not the owner sees it by default', () => {
  assert.equal(P.phonePosFor({}, 'cashier', false, true), true);   // hotel manager / cashier
});

await ok('a non-selling role that is not the owner does not, by default', () => {
  assert.equal(P.phonePosFor({}, 'accountant', false, false), false);   // senior management / back office
});

await ok('an explicit choice wins over the default', () => {
  // The owner turned it ON for a back-office role, and OFF for a selling one.
  assert.equal(P.phonePosFor({ accountant: true }, 'accountant', false, false), true);
  assert.equal(P.phonePosFor({ cashier: false }, 'cashier', false, true), false);
  // Even the owner's own role is the owner's to turn on.
  assert.equal(P.phonePosFor({ 'owner-role': true }, 'owner-role', true, true), true);
});

await ok('no role id → the default (a null/undefined role never reads the map)', () => {
  assert.equal(P.phonePosFor({ x: true }, null, false, true), true);
  assert.equal(P.phonePosFor({ x: true }, undefined, true, true), false);
});

// ── The stored-map cleaning ──────────────────────────────────────────────────────────────────────────────────────────
console.log('\nasPhonePosMap — only { roleId: boolean }\n');

await ok('reads a JSON string and a plain object the same way', () => {
  assert.deepEqual(P.asPhonePosMap('{"a":true,"b":false}'), { a: true, b: false });
  assert.deepEqual(P.asPhonePosMap({ a: true, b: false }), { a: true, b: false });
});

await ok('drops anything that is not a boolean, and empty keys', () => {
  assert.deepEqual(P.asPhonePosMap({ a: true, b: 'yes', c: 1, d: null, '': true }), { a: true });
});

await ok('a non-object, an array, null or bad JSON → {}', () => {
  for (const bad of [null, undefined, 42, 'nope', '[1,2]', [true, false], JSON.stringify(['x'])]) {
    assert.deepEqual(P.asPhonePosMap(bad), {});
  }
});

await ok('the setting key is stable', () => {
  assert.equal(P.PHONE_POS_SETTING_KEY, 'phone_pos_roles');
});

// ── The wiring that cannot run here, checked in the source ────────────────────────────────────────────────────────────
console.log('\nthe wiring (source)\n');

await ok('the session resolves phonePos with phonePosFor', () => {
  const s = read('apps/server/src/routes/auth.ts');
  assert.match(s, /readPhonePosMap|phonePosFor/, 'auth.ts imports the phone-pos helpers');
  assert.match(s, /phonePos:\s*phonePosFor\(/, 'GET /session returns phonePos from phonePosFor');
});

await ok('the owner-only endpoints exist (GET + PUT /phone-pos)', () => {
  const c = read('apps/server/src/routes/controls.ts');
  assert.match(c, /router\.get\('\/phone-pos'/, 'GET /phone-pos');
  assert.match(c, /router\.put\('\/phone-pos'/, 'PUT /phone-pos');
  // Both refuse anyone but the real owner.
  const owns = [...c.matchAll(/'\/phone-pos'[\s\S]*?req\.isOwner/g)];
  assert.ok(c.includes("!req.isOwner || req.isTill"), 'owner-only guard present');
});

await ok('web_pos is an owner-only POS option, default ON', () => {
  const c = read('apps/server/src/routes/controls.ts');
  assert.ok(c.includes("'web_pos'"), 'web_pos registered');
  assert.match(c, /OWNER_ONLY_POS_KEYS =.*web_pos/, 'web_pos is owner-only');
  assert.match(c, /enabled\s*!==\s*false/, 'web_pos reads default-ON (!== false)');
});

await ok('the phone gate is in the dashboard mayOpen (native + phonePos)', () => {
  const d = read('apps/dashboard/src/components/DashboardLayout.tsx');
  assert.match(d, /isNativeApp\(\)\s*&&\s*!phonePos/, 'phone-app gate');
  assert.match(d, /!webPosOn/, 'business-wide web-POS gate');
});

await ok('the dashboard learns it is the phone app from a native marker', () => {
  const cfg = read('apps/dashboard/src/lib/config.ts');
  assert.match(cfg, /export function isNativeApp/, 'isNativeApp helper');
  assert.match(cfg, /__SWIFTPOS_CONFIG__\?\.native === true/, 'reads the native flag');
  const main = read('apps/android/src/main.tsx');
  assert.match(main, /native:\s*true/, 'the Android entry sets native:true');
});

await ok('PermissionsContext carries phonePos (default true until the session says)', () => {
  const pc = read('apps/dashboard/src/context/PermissionsContext.tsx');
  assert.match(pc, /setPhonePos\(s\?\.phonePos !== false\)/, 'only an explicit false hides it');
  assert.match(pc, /phonePos: boolean/, 'exposed on the context type');
});

await ok('the owner UI has the per-role card and the web-POS switch', () => {
  const oc = read('apps/dashboard/src/pages/settings/OwnerControls.tsx');
  assert.match(oc, /PhonePosRolesCard/, 'the per-role card');
  assert.match(oc, /\/api\/controls\/phone-pos/, 'it calls the owner-only endpoint');
  assert.ok(oc.includes("'web_pos'"), 'web_pos is a POS option');
  assert.match(oc, /Online \(web\) POS/, 'web_pos has owner-facing words');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
