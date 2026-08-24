/**
 * auth-surface.test.mjs — the token's `surface` decides four things, and it was
 * wrong for months.
 *
 * WHAT HAPPENED
 * -------------
 * `/desktop-login` minted `surface: 'web'`. The header of routes/auth.ts has
 * said `surface='desktop'` since the route was written. The comment and the code
 * disagreed and nothing compared them.
 *
 * Because `/verify-pin` issues `surface: req.surface ?? 'web'`, the wrong value
 * propagated from the owner token into every staff token minted from it. On
 * every till that signed in through that route:
 *
 *   1. `offlineAuth` is gated on `surface === 'desktop'`, so the PIN hash was
 *      never returned and `staff_pin_cache` stayed EMPTY. **The entire offline
 *      sign-in feature (register D16, shipped 2026-08-08 with 16 passing tests)
 *      has never worked in the field.** Confirmed on Beryl's till 2026-08-10:
 *      two PINs entered ONLINE, then `select count(*) from staff_pin_cache` = 0.
 *   2. Desktop terminal registration (D14) never ran — `user_devices` was empty
 *      for all ten businesses, which kept migration 52's branch binding and all
 *      fleet telemetry inert.
 *   3. The `desktop_licensed` gate never fired for those tills.
 *   4. `requireWebSurface` let a till reach web-portal-only routes.
 *
 * Nothing caught it because `/pos-login` derives surface from the request body
 * and CAN be 'desktop' — so the fixtures, and the BRANCH_NOT_LICENSED errors
 * seen in the field, both looked right. Two login routes, two answers.
 *
 * WHY THIS IS A SOURCE-TEXT TEST
 * ------------------------------
 * The bug was a single word in a literal. There is no behaviour to model that
 * would not itself hard-code the same word — a unit test asserting
 * `payload.surface === 'desktop'` against a stub proves the stub. So this reads
 * the shipped source and asserts what it actually says, the same approach
 * `test-office-role.mjs` uses for the promotion lever.
 *
 * MUTATION CHECK (rule 10): change `surface: 'desktop'` back to `'web'` in
 * /desktop-login and section 1 fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const AUTH = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/auth.ts'), 'utf8');
const POS  = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/pos.ts'), 'utf8');
const MW   = fs.readFileSync(path.join(ROOT, 'apps/server/src/middleware/auth.ts'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
};

/** The body of one route handler, from `router.post('<name>'` to the next one. */
function routeBody(src, name) {
  const start = src.indexOf(`router.post('${name}'`);
  assert.notEqual(start, -1, `route ${name} not found`);
  const next = src.indexOf('\nrouter.', start + 10);
  return src.slice(start, next === -1 ? src.length : next);
}

/** What `surface:` a route assigns in its token payload. */
function mintedSurface(src, name) {
  const body = routeBody(src, name);
  const m = body.match(/^\s*surface:\s*(.+?),\s*$/m);
  return m ? m[1].trim() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. /enrol/redeem mints a DESKTOP surface (the sole desktop entry — A158)');

ok('it does not mint web — this is the bug that hid four features', () => {
  const s = mintedSurface(AUTH, '/enrol/redeem');
  assert.notEqual(s, "'web'",
    "surface: 'web' on the desktop entry disables offlineAuth, device registration, " +
    'the desktop licence gate and requireWebSurface, all silently');
});

ok('it mints desktop', () => {
  assert.equal(mintedSurface(AUTH, '/enrol/redeem'), "'desktop'");
});

ok('owner login on a till is retired (A158): /desktop-login mints no surface', () => {
  // The credential path was removed so the owner password never touches a till.
  // The route is tombstoned (410), so it assigns no token surface at all.
  assert.equal(mintedSurface(AUTH, '/desktop-login'), null,
    '/desktop-login still mints a session surface — the owner-login path was not fully retired');
});

ok('the file header and the code agree', () => {
  // The header documents the desktop entry's surface; whichever is changed next,
  // they must move together.
  const header = AUTH.slice(0, AUTH.indexOf('*/'));
  const claimed = /enrol\/redeem[^\n]*surface='(\w+)'/.exec(header);
  assert.ok(claimed, 'the header no longer documents the desktop entry\'s surface');
  assert.equal(`'${claimed[1]}'`, mintedSurface(AUTH, '/enrol/redeem'),
    'the header and the payload disagree — that is exactly how this bug survived');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. The value propagates, so a wrong one is not contained');

ok('/verify-pin inherits the caller surface rather than hard-coding one', () => {
  const s = mintedSurface(AUTH, '/verify-pin');
  assert.match(s, /req\.surface/,
    'a staff token must carry the surface of the session that authorised it');
});

ok('/pos-login mints the server-derived surface, not the raw client claim (A37)', () => {
  const s = mintedSurface(AUTH, '/pos-login');
  assert.equal(s, 'effectiveSurface',
    'pos-login must mint effectiveSurface — the web-access-gated value — not callerSurface');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. The four things that depend on it are still wired');

ok('offlineAuth is gated on the desktop surface (D16)', () => {
  assert.match(AUTH, /offlineAuth:\s*req\.surface === 'desktop'/,
    'if this gate moves, staff_pin_cache silently stops filling again');
});

ok('desktop terminal registration is gated on it (D14)', () => {
  const body = routeBody(AUTH, '/verify-pin');
  assert.match(body, /req\.surface === 'desktop'/);
  assert.match(body, /registerDesktopTerminal\(/);
});

ok('the desktop licence gate is gated on it', () => {
  // D11 rewrote the gate to resolve the operating branch (boundBranch ?? mainBranch)
  // as opBranch, so match the surface key + a desktop_licensed check rather than
  // the old `branch && !branch.desktop_licensed` exact shape.
  assert.match(POS, /req\.surface === 'desktop' &&[^\n]*desktop_licensed/);
});

ok('requireWebSurface still exempts owners', () => {
  // Owners must keep web access from a till, or the owner loses the manager
  // screens the moment surface is corrected.
  assert.match(MW, /req\.isOwner \|\| req\.surface !== 'desktop'/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. A37 CLOSED: the surface is server-derived from web access, not client-supplied');

ok('pos-login honours surface:web only when the business holds web access (A37)', () => {
  // The exempting surface is now earned, not asserted: effectiveSurface is 'web'
  // ONLY when callerSurface==='web' AND the business's web access permits login.
  assert.match(AUTH, /effectiveSurface[^\n]*=\s*[\s\S]{0,120}callerSurface === 'web' && [\w.]*[Ww]ebAccess\.canLogin/,
    'effectiveSurface must gate the web claim on getWebAccess(...).canLogin');
});

ok('the licence gate keys off effectiveSurface, not the raw claim (A37)', () => {
  assert.match(AUTH, /effectiveSurface !== 'web' && !allowed\.desktop_licensed/,
    'a till claiming web without web access must still hit the desktop licence gate');
  assert.doesNotMatch(AUTH, /callerSurface !== 'web' && !allowed\.desktop_licensed/,
    'the old client-supplied gate must be gone');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
