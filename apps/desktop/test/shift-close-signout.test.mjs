/**
 * shift-close-signout.test.mjs — A421: a shift closed on the till signs the person out to the PIN screen; the next
 * cashier is never handed "Opening float" under the name of the one who just closed.
 *
 *   node test/shift-close-signout.test.mjs
 *
 * Pins the screens (React is not run here): ShiftPanel signs out at once on a cashier's (blind) close and on leaving a
 * manager's closed panel; POSPage passes the sign-out through and keeps "Opening float" off the shift panel; App signs
 * out with a notice the PIN screen shows until the next sign-in.
 *
 * MUTATIONS TO CONFIRM BITE: drop the blind early sign-out in handleClose → "a cashier's close signs out at once" fails;
 * Done back to onClose → "leaving a closed shift signs out" fails; `!showShift` dropped from the OpenDrawerModal gate →
 * its pin fails; handleEndShift taking any argument as the notice → "a click is not a notice" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const panel = read('src/renderer/pages/ShiftPanel.tsx');
const pos   = read('src/renderer/pages/POSPage.tsx');
const app   = read('src/renderer/App.tsx');
const pin   = read('src/renderer/pages/PinPage.tsx');

ok("a cashier's close signs out at once (before the closed panel is shown)",
  /const r = await posApi\.shift\.close\(counted[^\n]*\);\s*\/\/[^\n]*\n\s*if \(\(r as any\)\?\.blind && onSignOut\) \{ onSignOut\('[^']+'\); return; \}\s*setFinalReport\(r\);/.test(panel));
ok('leaving a closed shift signs out (Done and ✕)',
  /const leave = finalReport && onSignOut \? \(\) => onSignOut\('[^']+'\) : onClose;/.test(panel)
  && /<button onClick=\{leave\}[^>]*>✕<\/button>/.test(panel)
  && /<button onClick=\{leave\}[^>]*>\{onSignOut \? 'Done — sign out' : 'Done'\}<\/button>/.test(panel));
ok('a manager can still confirm the closed shift now', /data-testid="confirm-now"/.test(panel));
ok('POSPage hands the sign-out to the shift panel', /onSignOut=\{onShiftClosed\}/.test(pos));
ok('"Opening float" never shows over the shift panel', /\{needsShift && !needsManager && !showShift && \(\s*<OpenDrawerModal/.test(pos));
ok('App signs out on a closed shift', /onShiftClosed=\{handleEndShift\}/.test(app));
ok('a click is not a notice', /setPinNotice\(typeof notice === 'string' \? notice : null\)/.test(app));
ok('the notice goes at the next sign-in', /const handleStaffLogin = \(s: StaffSession\) => \{\s*setPinNotice\(null\);/.test(app));
ok('the PIN screen shows the notice', /notice=\{pinNotice\}/.test(app) && /\{notice && !error && pin\.length === 0 && \(\s*<p data-testid="pin-notice"/.test(pin));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
