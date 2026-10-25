/**
 * zreport-print-live.test.mjs — A434 (owner, 2026-10-10):
 *   · "the close and print Z report button only closes but never prints" — a manager's close now prints the Z-report;
 *     a cashier's close is blind (no figures, no paper) and its button says only "Close shift";
 *   · "if there are two shifts running will the manager see two z reports side by side, and if more" — Shift report,
 *     with nothing picked, shows every running shift at the branch side by side (wrapping), each with its own Print.
 *
 *   node test/zreport-print-live.test.mjs
 *
 * Pinned on the source (React is not run here).
 * MUTATIONS TO CONFIRM BITE: the print after close removed → "a manager's close prints" fails; the blind label dropped →
 * its pin fails; the live grid only for this till → "every running shift" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const sp = read('src/renderer/pages/ShiftPanel.tsx');
const close = sp.slice(sp.indexOf('const handleClose = async'), sp.indexOf("const [printMsg, setPrintMsg]"));
ok("a manager's close prints the Z-report (after it is saved; a failure says so)",
  /setFinalReport\(r\);\s*onShiftChange\(null\);[\s\S]*?printShiftReport\(r\)\.then\(\(p\) => \{ if \(!p\.ok\) setPrintMsg\(/.test(close));
// A454 (owner, 2026-10-12): the cashier's close now prints THEIR copy — their count, no reconciliation — then signs out.
ok("a cashier's close is blind: their own copy prints (no figures of the system's), the button does not promise a Z-report",
  /if \(\(r as any\)\?\.blind && onSignOut\) \{\s*const declared = [^\n]*\n\s*const p = await printShiftReport\(r, \{ cashierCopy: \{ declared \} \}\)/.test(close)
  && sp.includes("{busy ? 'Closing…' : blind ? 'Close shift' : 'Close shift & print Z-report'}"));

const mp = read('src/renderer/pages/ManagerPage.tsx');
ok('every running shift at the branch — this till\'s from its records, another\'s from the cloud',
  /const open = \(branch \?\? \[\]\)\.filter\(x => x\.status === 'open'\);/.test(mp)
  && /open\.filter\(x => !x\.this_till\)\.map\(x =>\s*posApi\.manager\.remoteZReport\(x\.id\)/.test(mp));
ok('side by side, wrapping for more, each with its own Print',
  /<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start" data-testid="live-zreports">/.test(mp)
  && /onClick=\{\(\) => void handlePrint\(l\.report\)\}/.test(mp));
ok('the picker says so', mp.includes('<option value="">Running shifts — every POS (live)</option>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
