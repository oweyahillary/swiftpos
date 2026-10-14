/**
 * web-shift-close.test.mjs — A462: a manager (and the owner) confirm and close shifts on the web, gracefully; a closed
 * drawer cascades to the web POS.
 *
 * Owner, 2026-10-13: "how can a manager confirm and close a shift on web"; "yes and make sure when an owner force closes a
 * till it cascades to all tills both desktop and web"; "the owner should be able to confirm cash on the web when the
 * manager is not around … and close shift gracefully without force closing".
 *
 * Pins the shipped web screens (React is not run) and the cloud's refusal of a web sale into a closed drawer.
 *
 *   node tests/web-shift-close.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: the orders guard letting a web sale in → "a web sale into a closed drawer is refused" fails;
 * the web POS not re-checking its shift → "the web POS learns within 20 s" fails; ShiftConfirmations ignoring
 * view.expected → "the expected figure and the difference as typed" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}  ${d}`); } };

const conf = read('apps/dashboard/src/components/ShiftConfirmations.tsx');
const close = read('apps/dashboard/src/components/CountedCloseModal.tsx');
const mgr = read('apps/dashboard/src/pages/manager/ManagerShiftTab.tsx');
const own = read('apps/dashboard/src/pages/OpenShiftsPage.tsx');
const pos = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
const orders = read('apps/server/src/routes/orders.ts');

console.log('\nConfirming on the web\n');
ok('the manager\'s Shifts tab confirms shifts (their own sign-in), as the owner\'s Open drawers page does',
  /<ShiftConfirmations key=\{confirmKey\} client=\{posApi as any\} currency=\{currency\} \/>/.test(mgr) && /<ShiftConfirmations key=\{confirmKey\} currency=\{currency\} \/>/.test(own));   // A471: the owner's page passes the business currency
ok('the expected figure beside each count and the difference as typed (the cloud sends them to a manager / the owner)',
  /const showExpected = !!view\.expected;/.test(conf) && /data-testid=\{`expected-\$\{m\}`\}/.test(conf) && /data-testid=\{`variance-\$\{m\}`\}/.test(conf));
ok('…read through whichever sign-in the page holds (the web POS manager, or the owner)',
  /client\.get<[\s\S]{0,200}\/confirm-view`\)/.test(conf) && /client\.post\(`\/api\/shifts\/\$\{target\.id\}\/confirm`/.test(conf));

console.log('\nClosing gracefully — with a count, not forced\n');
ok('"Close with count" on the manager\'s Shifts tab and the owner\'s Open drawers page', /data-testid=\{`count-close-\$\{s\.id\}`\}/.test(mgr) && /data-testid=\{`count-close-\$\{s\.id\}`\}/.test(own));
ok('it counts each method beside what the shift expects, and closes counted (POST /close with the count, the other methods, a note)',
  /client\.get<any>\(`\/api\/shifts\/\$\{shift\.id\}\/zreport`\)/.test(close)
  && /client\.post\(`\/api\/shifts\/\$\{shift\.id\}\/close`, \{ closing_float: cash, declared_methods: others, notes:/.test(close));
ok('…a cash difference needs a note (the cloud\'s own rule, asked before sending)', /if \(cashOff && !note\.trim\(\)\)/.test(close));
ok('force-close stays — for a drawer nobody can count', /force-close/.test(mgr) && /Force close/.test(own));

console.log('\nA closed drawer cascades to the web POS\n');
ok('the web POS learns within 20 s that its drawer was closed elsewhere, and asks for a new shift',
  /`\/api\/shifts\/state\?ids=\$\{encodeURIComponent\(id\)\}`/.test(pos) && /setInterval\(\(\) => \{ void check\(\); \}, 20_000\)/.test(pos)
  && /setCurrentShift\(null\);\s*setClosedElsewhere\(/.test(pos) && /data-testid="shift-closed-elsewhere"/.test(pos));
ok('…not when the cashier closed it themselves', /if \(st\.closed_by && st\.closed_by === session\?\.staffId\) return;/.test(pos));
ok('a web sale into a closed drawer is refused (SHIFT_CLOSED); a till\'s never is (it may have been rung offline)',
  /if \(\(drawer as \{ status\?: string \}\)\.status !== 'open' && !req\.isTill && req\.surface !== 'desktop'\) \{\s*res\.status\(409\)\.json\(\{ code: 'SHIFT_CLOSED'/.test(orders));
ok('the till already closes a drawer closed on the cloud within 20 s (A401 pullShiftCloses)',
  /export async function pullShiftCloses\(\)/.test(read('apps/desktop/src/main/syncEngine.ts')));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
