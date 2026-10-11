/**
 * lock-keypad-osk.test.mjs — A417 (first part): the Windows touch keyboard does not open over the lock screen's keypad.
 *
 *   node test/lock-keypad-osk.test.mjs
 *
 * The owner's screenshot (2026-10-09): "Till locked" on a touch PC, the Windows keyboard over the bottom half, hiding
 * ZapTill's own PIN keypad. The lock screen focuses a hidden input so a physical keypad works; Windows took that focus
 * for typing. inputMode="none" keeps the on-screen keyboard shut and the physical keypad still types. Pinned on source.
 *
 * MUTATIONS TO CONFIRM BITE: inputMode back to "numeric" → "the hidden PIN input asks for no keyboard" fails; the PIN
 * screen given a focused <input> for the PIN → "the PIN screen has no PIN input to focus" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const lock = read('src/renderer/components/LockCurtain.tsx');
const input = lock.slice(lock.indexOf('id="lock-pin-input"'), lock.indexOf('/>', lock.indexOf('id="lock-pin-input"')));
ok('the hidden PIN input asks for no keyboard', /inputMode="none"/.test(input) && !/inputMode="numeric"/.test(input));
ok('it is still focused for a physical keypad', /document\.getElementById\('lock-pin-input'\);\s*el\?\.focus\(\);/.test(lock));
// The PIN screen reads keys from the window, with no input to focus — keep it that way (the tech fields are text, on purpose).
const pin = read('src/renderer/pages/PinPage.tsx');
ok('the PIN screen has no PIN input to focus', /window\.addEventListener\('keydown', onKey\)/.test(pin)
  && !/value=\{pin\}/.test(pin));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
