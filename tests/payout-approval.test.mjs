/**
 * payout-approval.test.mjs — 0.6.37 (A388): a manager approves a cash-out (pay out) and an expense on the spot.
 *
 * Owner, 2026-10-03: "Manager approve cashout and expense" — "Manager PIN on the spot". Source assertions on the cloud
 * (Express + Supabase: the web POS's routes, the till's push, migration 118) and the web (React). The till is run for
 * real in apps/desktop/test/payout-approval.test.mjs; the migration in scripts/test-migration-118.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: POST /:id/float asking approval for a pay in too, or not for a pay out → its pin fails;
 * POST /:id/expense not asking → its pin fails; the push refusing a row for a bad approver id → "never refuses" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

await ok('the rule: a PIN is checked like a shift confirmation; a manager signed in approves as themselves; else refused', () => {
  const a = read('apps/server/src/lib/payoutApproval.ts');
  assert.match(a, /if \(pin\) \{\s*const who = await confirmerByPin\(req\.businessId!, pin,/);
  assert.match(a, /: \{ ok: false, status: 403, error: PIN_NOT_RECOGNISED, code: 'INVALID_CONFIRMER_PIN' \}/);
  assert.match(a, /if \(callerMayConfirm\(req\) && req\.userId\) \{/);
  assert.match(a, /return \{ ok: false, status: 403, error: APPROVAL_REQUIRED, code: 'PAYOUT_APPROVAL_REQUIRED' \};/);
});

await ok('web POS: a pay out needs a manager (a pay in does not); every expense does; the approver is stored', () => {
  const s = read('apps/server/src/routes/shifts.ts');
  assert.match(s, /if \(type === 'float_out'\) \{\s*const a = await payoutApprover\(req\);\s*if \(a\.ok === false\) \{ res\.status\(a\.status\)/);
  assert.match(s, /approved_by: approver\?\.id \?\? null,/);
  assert.match(s, /const approval = await payoutApprover\(req\);\s*if \(approval\.ok === false\)/);
  assert.match(s, /approved_by:\s+approval\.approver\.id,/);
});

await ok('the till\'s push carries the approver — and a bad approver id is dropped, never a reason to refuse the row', () => {
  const y = read('apps/server/src/routes/sync.ts');
  assert.equal((y.match(/approved_by:\s+isUuid\((f|e)\.approved_by\) \? String\(\1\.approved_by\) : null,/g) ?? []).length, 2);
  assert.equal((y.match(/approved_by_name: +typeof (f|e)\.approved_by_name === 'string' \? \1\.approved_by_name\.slice\(0, 100\) : null,/g) ?? []).length, 2);
});

await ok('migration 118: nullable, no foreign key, recorded', () => {
  const m = read('migrations/118_payout_approval.sql');
  assert.match(m, /ALTER TABLE public\.float_transactions\s+ADD COLUMN IF NOT EXISTS approved_by\s+uuid,\s+ADD COLUMN IF NOT EXISTS approved_by_name text;/);
  assert.match(m, /ALTER TABLE public\.expenses\s+ADD COLUMN IF NOT EXISTS approved_by\s+uuid,\s+ADD COLUMN IF NOT EXISTS approved_by_name text;/);
  assert.doesNotMatch(m, /REFERENCES/);
  assert.match(m, /'118_payout_approval'/);
});

await ok('the web POS asks for the PIN (pay out, expense) unless a manager is signed in', () => {
  const w = read('apps/dashboard/src/pages/pos/ShiftModal.tsx');
  assert.match(w, /const needPin = floatType === 'float_out' && !signedInManager;/);
  assert.match(w, /\.\.\.\(needPin \? \{ pin: approvePin\.trim\(\) \} : \{\}\),/);
  assert.match(w, /\.\.\.\(!signedInManager \? \{ pin: approvePin\.trim\(\) \} : \{\}\),/);
  assert.match(w, /data-testid="payout-pin"/);
  assert.match(w, /data-testid="expense-pin"/);
});

await ok('the till asks for the PIN, and its Z-report and the dashboard show who approved', () => {
  const p = read('apps/desktop/src/renderer/pages/ShiftPanel.tsx');
  assert.match(p, /posApi\.shift\.canConfirm\(\)\.then\(setIsManager\)/);
  assert.match(p, /data-testid="payout-pin"/);
  assert.match(p, /pin: expPin\.trim\(\) \|\| undefined,/);
  assert.match(read('apps/desktop/src/renderer/components/ZReportView.tsx'), /PAY-OUTS \(\{report\.payoutLines!\.length\}\)/);
  assert.match(read('apps/desktop/src/renderer/lib/printShiftReport.ts'), /payoutLines: \(report\.payoutLines \?\? \[\]\)\.map/);
  assert.match(read('shared/printing/src/shiftReport.ts'), /d\.line\(`PAY-OUTS \(\$\{r\.payoutLines\.length\}\)`, \{ bold: true \}\);/);
  assert.match(read('apps/server/src/routes/expenses.ts'), /approved_by_name: e\.approved_by_name \?\? null,/);
  assert.match(read('apps/dashboard/src/pages/expenses/ExpensesPage.tsx'), /approved \{e\.approved_by_name\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
