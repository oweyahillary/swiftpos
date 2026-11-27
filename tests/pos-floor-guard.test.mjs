// POS floor guard — every permission the TILL FACE gates a cashier's own button/action on must be a FLOOR key, or an
// explicitly-listed manager view. Otherwise an owner who grants that key to a cashier bounces them off the POS: isBackOffice
// (the shared "beyond the shop floor" flag) routes them to the manager portal, and the SAME flag also asks them for a web
// sign-in code and shows them the desktop sync notice. This class has bitten three times — A499 (customers.manage), A627
// (history rights) and the cash-out / confirm fix of 2026-11-27 — so pin the whole class here.
//
//   node --no-warnings tests/pos-floor-guard.test.mjs
//
// THE isBackOffice MATRIX — the decisions "beyond the shop floor" drives. They share FLOOR today, but routing and sign-in
// codes are NAMED SEAMS now (packages/core routesToManager / needsSignInCode) so one can diverge from the other:
//   1. routing        apps/dashboard/src/lib/posRouting.ts    resolveRoute → routesToManager() → the POS vs the manager portal
//   2. sign-in codes  apps/server/src/lib/loginOtp.ts         needsOtp     → needsSignInCode() → a web OTP code, or not
//   3. sync notice +  apps/desktop/src/renderer/lib/access.ts backOffice   → isBackOffice: the desktop CONSOLIDATES the sync
//      "← Manager" +  (same backOffice)                       notice, the "← Manager" button and PIN-screen routing + device.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

// The till-face surfaces: where a SELLING person's own buttons and actions live (the till header, the sell flow, the shift
// and expense dialogs, the Z-report) — on BOTH POS. Not the drawer's manager tabs (Reports / Stock / Orders), which a
// manager reaches from the dashboard and which legitimately gate manager-only keys.
const POS_FILES = [
  'apps/dashboard/src/pages/pos/CashierScreen.tsx',
  'apps/dashboard/src/pages/pos/ShiftModal.tsx',
  'apps/dashboard/src/pages/pos/PaymentModal.tsx',
  'apps/dashboard/src/pages/pos/ZReportModal.tsx',
  'apps/desktop/src/renderer/pages/ShiftPanel.tsx',
  'apps/desktop/src/renderer/pages/POSPage.tsx',
];

// Keys that DO gate a till-face element but are a manager view — reached by a manager (opened from the dashboard) or the
// owner, never a cashier's own action. A NEW back-office key in a till-face file must be classified here (a manager view)
// or added to a FLOOR set in packages/core/src/permissions.ts (a cashier action). The guard fails until one is chosen — on
// purpose: that is the decision that, missed, bounces a cashier off the till.
const BACK_OFFICE_UI = new Set([
  'reports.shifts',     // ZReportModal — expected cash and the difference at close (a reports right)
  'reports.costs',      // ZReportModal — the cost view on the Z-report
  'stations.manage',    // CashierScreen — set up the till's printers
  'menu.edit',          // CashierScreen / POSPage — quick menu edit, "show all menus" outside their hours
  'shifts.force_close', // POSPage — force-close a stuck drawer (manager recovery)
]);

// Extract the catalogue keys a file GATES on (hasPermission / can / has / held.has / hasAnyPermission). Only real catalogue
// keys count, so a stray string can never trip the guard; a missed call pattern only under-reports (safe) — never a false alarm.
const FINE = new Set(P.PERMISSIONS.map((p) => p.key));
function gatedKeys(src) {
  const out = new Set();
  const add = (k) => { if (FINE.has(k)) out.add(k); };
  for (const m of src.matchAll(/hasPermission\(\s*['"]([\w.]+)['"]/g)) add(m[1]);
  for (const m of src.matchAll(/\bcan\(\s*[^,]+?,\s*['"]([\w.]+)['"]/g)) add(m[1]);
  for (const m of src.matchAll(/\bhas\(\s*['"]([\w.]+)['"]/g)) add(m[1]);
  for (const m of src.matchAll(/held\.has\(\s*['"]([\w.]+)['"]/g)) add(m[1]);
  for (const m of src.matchAll(/hasAnyPermission\([^,]+,\s*\[([^\]]*)\]/g))
    for (const s of m[1].matchAll(/['"]([\w.]+)['"]/g)) add(s[1]);
  return out;
}

console.log('\nPOS floor guard\n');
for (const file of POS_FILES) {
  ok(`every permission the till face gates is FLOOR or a listed manager view — ${file}`, () => {
    const keys = gatedKeys(read(file));
    assert.ok(keys.size > 0, `no permission gates found in ${file} — did the extractor break, or the file move?`);
    const offenders = [...keys].filter((k) => P.isBackOffice([k]) && !BACK_OFFICE_UI.has(k));
    assert.deepEqual(offenders, [],
      `these keys gate a till-face element but are BACK OFFICE — a cashier granted one is bounced off the POS.\n` +
      `       Add each to a FLOOR set in packages/core (a cashier till action) OR to BACK_OFFICE_UI in this test (a manager view): ${offenders.join(', ')}`);
  });
}

// The floor EXCEPTIONS these fixes added (A490/A499/A627/2026-11-27): a cashier may hold one and still sells. Guard they
// stay real catalogue keys and on the floor — a revert that makes one back office would bounce the cashier again.
ok('the till-side floor exceptions are real catalogue keys and on the floor', () => {
  for (const k of [...P.POS_ACTION_KEYS, ...P.POS_DRAWER_KEYS, ...P.POS_HISTORY_KEYS]) {
    assert.ok(FINE.has(k), `${k} is not a catalogue key`);
    assert.equal(P.isBackOffice([k]), false, `${k} should be on the floor`);
  }
});

// The matrix is real and each surface reads its named seam (or the desktop's consolidated check). If a refactor repoints
// one, this reminds the author to reason about the matrix (routing vs sign-in codes vs sync) rather than change one silently.
ok('each decision reads its named seam — routing (routesToManager), sign-in codes (needsSignInCode), desktop (isBackOffice)', () => {
  assert.match(read('apps/dashboard/src/lib/posRouting.ts'), /routesToManager/);
  assert.match(read('apps/server/src/lib/loginOtp.ts'), /needsSignInCode/);
  assert.match(read('apps/desktop/src/renderer/lib/access.ts'), /isBackOffice/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
