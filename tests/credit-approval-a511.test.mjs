// A511 — a sale on account (credit) by someone without customers.credit needs a manager's PIN.
// Owner, 2026-10-16: "the manager has to approve credit gate that behind a managers pin its not a cashiers right".
//
//   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/credit-approval-a511.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= 'test-only-secret-test-only-secret';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const { mayApprove } = require(path.join(ROOT, 'apps/server/dist/lib/approver.js'));
const row = (keys, role = 'Manager') => ({ id: 'u', roles: { name: role, role_permissions: keys.map((k) => ({ permissions: { key: k } })) }, user_permissions: [] });

console.log('\nA511 — a sale on account is approved by a manager\n');
ok('who holds customers.credit may approve a credit sale; who does not, may not', () => {
  assert.equal(mayApprove(row(['customers.credit']), null, 'credit'), true);
  assert.equal(mayApprove(row(['sales.void', 'sales.refund']), null, 'credit'), false);
  assert.equal(mayApprove(row([], 'Admin'), null, 'credit'), true);   // the owner's role
});
ok('a void approver is not a credit approver (each action its own key)', () => {
  assert.equal(mayApprove(row(['customers.credit']), null, 'void'), false);
});
const o = read('apps/server/src/routes/orders.ts');
ok('both sale paths (POST / and /:id/pay) ask for the approval before the credit is written', () => {
  const calls = o.match(/const ca = await creditApproval\(req, req\.body, [^)]+\);/g) ?? [];
  assert.equal(calls.length, 2, calls.join(' | '));
  assert.match(o, /if \(req\.isOwner \|\| can\(req, 'customers\.credit'\)\) return/);
  assert.match(o, /approverByPin\(req, [\s\S]{0,120}pin, 'credit', branchId\)/);
  assert.match(o, /code:\s+'CREDIT_APPROVAL_REQUIRED'/);
});
ok('the approver is written on the customer\'s ledger line', () => {
  assert.match(o, /p_notes:\s+creditNote \? `Credit sale\$\{creditNote\}` : null/);
  assert.match(o, /p_notes:\s+`Credit sale \$\{order\.order_number\}\$\{payCreditNote\}`/);
});
const pm = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
ok('the web POS asks for the manager\'s PIN and sends the same sale again with it', () => {
  assert.match(pm, /code === 'CREDIT_APPROVAL_REQUIRED'\) \{ setNeedCreditPin\(true\)/);
  assert.match(pm, /data-testid="credit-approval"/);
  assert.equal((pm.match(/\.\.\.creditPinField\(\),\s+\/\/ A511/g) ?? []).length, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
