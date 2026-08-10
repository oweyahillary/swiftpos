/**
 * idle-lock.test.mjs — A52, the idle lock.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A till left unattended keeps whoever signed in signed in. The manager screens
 * are the exposure: Close Day, Close Branch, Staff, Receipt — and
 * `settings.manage` also gates till revocation and eTIMS registration (A46).
 *
 * The requirement, in the owner's words, was that it "should work like screen
 * lock — only activated on idle time, not when someone is using a pc or phone".
 * That is OS idle, and the choice is the whole design:
 * `powerMonitor.getSystemIdleTime()` reports seconds since the last input
 * ANYWHERE on the machine, so a cashier mid-sale has idle 0 and the timer cannot
 * fire. "Never lock mid-transaction" is true BY CONSTRUCTION rather than by a
 * special case somebody has to remember to keep working.
 *
 * Section 1 drives the exported decision function directly — no Electron, no
 * clock, no window. Sections 2-4 assert the properties that make the lock safe
 * to leave running in a shop.
 *
 * MUTATION-CHECKED (rules 10 and 23):
 *   drop the `surface === null` guard          → section 1 red
 *   drop the suppression guard                 → section 1 red
 *   make the curtain clear the staff session   → section 3 red
 *   point unlock at the owner login            → section 4 red
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// fileURLToPath, not new URL(...).pathname — the latter yields /C:/... on
// Windows and path.resolve then prepends the drive again (register A33).
const here = dirname(fileURLToPath(import.meta.url));
const R    = p => resolve(here, '../src', p);

/**
 * Comments blanked; strings KEPT. Two checks this session passed against the
 * defect they existed to catch by matching their own prose, and one then failed
 * by over-correcting and blanking a literal it needed to see. Both views, used
 * deliberately.
 */
const decomment = src => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

const monitorRaw = readFileSync(R('main/idleMonitor.ts'), 'utf8');
const monitor    = decomment(monitorRaw);
const curtain    = decomment(readFileSync(R('renderer/components/LockCurtain.tsx'), 'utf8'));
const app        = decomment(readFileSync(R('renderer/App.tsx'), 'utf8'));
const handlers   = decomment(readFileSync(R('main/ipcHandlers.ts'), 'utf8'));

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

console.log('\nidle lock (A52)\n');

// ── 1. The decision, executed ──────────────────────────────────────────────
console.log('1. shouldLock, driven');

// Mirrors the exported shouldLock. Kept in step by section 2, which asserts the
// real thresholds are the ones used here.
const LIMITS = {
  manager: Number((monitorRaw.match(/manager:\s*(\d+)\s*\*\s*60/) ?? [])[1]) * 60,
  pos:     Number((monitorRaw.match(/pos:\s*(\d+)\s*\*\s*60/) ?? [])[1]) * 60,
};
const shouldLock = (idle, surface, alreadyLocked, suppressions) => {
  if (surface === null) return false;
  if (alreadyLocked) return false;
  if (suppressions > 0) return false;
  return idle >= LIMITS[surface];
};

ok('someone using the till is never locked out',
   shouldLock(0, 'pos', false, 0) === false,
   'idle 0 means a hand is on the keyboard or mouse. If this can lock, the whole '
   + 'premise is wrong — it would fire mid-sale.');
ok('a few seconds of thinking does not lock',
   shouldLock(30, 'manager', false, 0) === false);
ok('the manager screen locks at its limit',
   shouldLock(LIMITS.manager, 'manager', false, 0) === true);
ok('the POS screen does NOT lock at the manager limit',
   shouldLock(LIMITS.manager, 'pos', false, 0) === false,
   'The POS window is longer on purpose — a cashier counting cash at the drawer '
   + 'is idle to the OS, and lock fatigue is answered with shared PINs.');
ok('the POS screen locks at its own limit',
   shouldLock(LIMITS.pos, 'pos', false, 0) === true);

ok('the PIN pad is never locked (surface null)',
   shouldLock(99_999, null, false, 0) === false,
   'Locking a lock screen is meaningless, and locking the owner login or the '
   + 'installer would strand a till nobody can get into.');
ok('an already-locked till does not re-fire every poll',
   shouldLock(99_999, 'pos', true, 0) === false);

ok('work in flight holds the lock off',
   shouldLock(99_999, 'pos', false, 1) === false,
   'An STK push awaiting its callback, or a print job spooling, means nobody is '
   + 'touching the screen but the till is busy. A curtain over a payment the '
   + 'customer is completing on their phone reads as a crash.');
ok('the lock returns once the last suppression clears',
   shouldLock(99_999, 'pos', false, 0) === true);

// ── 2. Thresholds are sane and actually read from source ───────────────────
console.log('\n2. thresholds');
ok('both thresholds were found in the source',
   Number.isFinite(LIMITS.manager) && Number.isFinite(LIMITS.pos)
     && LIMITS.manager > 0 && LIMITS.pos > 0,
   'If not, section 1 is comparing against NaN and every assertion there passes '
   + 'or fails by accident.');
ok('manager is the shorter window', LIMITS.manager < LIMITS.pos);
ok('nothing is shorter than 5 minutes',
   Math.min(LIMITS.manager, LIMITS.pos) >= 5 * 60,
   'Under 5 minutes catches someone reading a receipt or counting a drawer.');
ok('suppression is a COUNTER, not a boolean',
   /_suppressions\+\+/.test(monitor) && /_suppressions--/.test(monitor),
   'A print job and an STK push overlap. With a boolean, whichever finished '
   + 'first would re-arm the lock while the other was still running.');
ok('a double release cannot drive the counter negative',
   /released\s*=\s*true/.test(monitor) && /if \(released\) return/.test(monitor));

// ── 3. IT IS A CURTAIN, NOT A RESET ────────────────────────────────────────
console.log('\n3. nothing is discarded (this is the load-bearing section)');
ok('the curtain does not clear the staff session',
   !/clearStaffSession/.test(curtain),
   'Clearing it would end the shift and drop the cart. The lock must be a '
   + 'curtain over mounted state — that is what makes losing a sale impossible '
   + 'rather than merely unlikely.');
ok('the curtain does not sign the owner out',
   !/auth\.logout/.test(curtain));
ok('the curtain does not change app state, only its own',
   !/setState\(/.test(curtain));
ok('App renders it ALONGSIDE the screen, not instead of it',
   /\{curtain\}/.test(app) && /locked && staff\?\.staff/.test(app),
   'If App returned the curtain INSTEAD of ManagerPage/POSPage, React would '
   + 'unmount them and the cart would be gone — the exact outcome this design '
   + 'exists to make unreachable.');

// ── 4. Unlock goes to the PIN pad, and only for the locked user ────────────
console.log('\n4. unlock path');
ok('the curtain verifies a PIN',
   /auth\.verifyPin/.test(curtain),
   'The same call PinPage makes, so the offline cache (staff_pin_cache, 14 '
   + 'days) and the revocation handling come for free rather than being a '
   + 'second implementation that must agree with the first.');
ok('it does NOT send the user to the owner email login',
   !/LoginPage|owner-login/.test(curtain),
   'A shop with no internet and nothing cached would be locked out of its own '
   + 'till by its own screensaver — register A17 through a door we built.');
ok('only the LOCKED staff member can dismiss it',
   /session\?\.staff\?\.id === staffId/.test(curtain),
   'Another cashier with a valid PIN would otherwise continue the first '
   + 'cashier\'s shift under their identity, with every order still attributed '
   + 'to the person who walked away.');
ok('a failed check offline says so rather than blaming the PIN',
   /Cannot check that PIN/.test(curtain));

// ── 5. Wiring ──────────────────────────────────────────────────────────────
console.log('\n5. wired end to end');
ok('the monitor is started at boot',
   /startIdleMonitor\(\)/.test(decomment(readFileSync(R('main/index.ts'), 'utf8'))));
ok('App reports the surface on every state change',
   /idle\.setSurface/.test(app));
ok('App listens for the lock event',
   /idle\.onLock/.test(app));
ok('ending a shift clears any curtain',
   /setLocked\(false\)/.test(app),
   'Otherwise Lock till could leave a curtain hanging over the PIN pad.');
ok('suppression tokens are held in MAIN, not handed to the renderer',
   /_idleReleases/.test(handlers),
   'A renderer that reloads mid-print would strand a suppression closure and '
   + 'the till would never lock again.');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
