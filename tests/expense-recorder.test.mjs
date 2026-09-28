/**
 * expense-recorder.test.mjs — two expense fixes, 2026-09-28.
 *
 *   A360: a cashier could not pick an expense type at the till (owner, backlog S2: "cashier cannot select expense
 *         type") — GET /api/expenses/categories needed `expenses.view`, which cashiers do not hold.
 *   A361: "expense should also capture who recorded it" — expenses.recorded_by, stamped by the cloud, never edited.
 *
 *   node tests/expense-recorder.test.mjs
 *
 * Pins the cloud routes (apps/server/src/routes/expenses.ts, sync.ts), the till's stamp and the web column; migration
 * 109 itself runs against real Postgres in scripts/test-migration-109.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: a permission back on GET /categories → "any signed-in account reads the types" fails;
 * `recorded_by: req.body…` in POST → "stamped from the signed-in account" fails; the sync fallback dropped → "sync
 * stamps the till's staff" fails; the bare `users ( name )` embed back → "names from explicit foreign keys" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const exp = read('apps/server/src/routes/expenses.ts');
const code = exp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ── A360 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('A360: any signed-in account of the business reads the types (no key: a cashier holds none of the expense keys)', () => {
  assert.match(code, /router\.get\('\/categories', async \(req, res\) => \{/);
  assert.match(code, /router\.use\(requireAuth\);/, 'still signed-in only');
  const get = code.slice(code.indexOf("router.get('/categories'"), code.indexOf("router.post('/categories'"));
  assert.match(get, /\.eq\('business_id', req\.businessId\)/, 'still this business only');
});
ok('A360: adding, renaming and deleting a type stay expenses.manage', () => {
  assert.match(code, /router\.post\('\/categories', requirePermission\('expenses\.manage'\)/);
  assert.match(code, /router\.patch\('\/categories\/:id', requirePermission\('expenses\.manage'\)/);
  assert.match(code, /router\.delete\('\/categories\/:id', requirePermission\('expenses\.manage'\)/);
});
ok('A360: the till asks this route with the signed-in staff\'s own token', () => {
  const h = read('apps/desktop/src/main/ipcHandlers.ts');
  assert.match(h, /const token = staffRow\?\.token \?\? ownerRow\?\.token;/);
  assert.match(h, /fetch\(`\$\{cfg\.server_url\}\/api\/expenses\/categories`, \{\s+headers: \{ Authorization: `Bearer \$\{token\}` \},/);
});

// ── A361 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('A361: a web expense is stamped from the signed-in account, never from the form', () => {
  assert.match(code, /const recordedBy = await recorderId\(req\);/);
  assert.match(code, /recorded_by: recordedBy,/);
  assert.ok(!/recorded_by[^\n]*req\.body/.test(code) && !/\brecorded_by\b[^\n]*=\s*req\.body/.test(code));
  const post = code.slice(code.indexOf("router.post('/',"), code.indexOf("router.patch('/:id'"));
  assert.ok(!/recorded_by,\s*$/m.test(post.slice(0, post.indexOf('} = req.body'))), 'not destructured from the body');
});
ok('A361: an owner without a users row records NULL, never a broken foreign key; staff always themselves', () => {
  assert.match(code, /if \(!req\.isOwner\) return req\.userId;/);
  assert.match(code, /\.eq\('id', req\.userId\)\.eq\('business_id', req\.businessId\)\.maybeSingle\(\);/);
});
ok('A361: nobody edits the recorder afterwards (PATCH never names it)', () => {
  const patch = code.slice(code.indexOf("router.patch('/:id'"), code.indexOf("router.delete('/:id'"));
  assert.ok(!/recorded_by/.test(patch));
});
ok('A361: names come from explicit foreign keys (two links to users now — a bare users() embed is ambiguous)', () => {
  assert.ok(!/\busers \( name \)/.test(code), 'no bare users ( name ) embed left');
  assert.equal((code.match(/payer:users!expenses_paid_by_fkey \( name \),\s+recorded_by, recorder:users!expenses_recorded_by_fkey \( name \)/g) || []).length, 2);
  assert.match(code, /recorded_by_name: e\.recorder\?\.name \?\? null,/);
  assert.match(code, /paid_by_name: e\.payer\?\.name \?\? null,/);
});
ok('A361: a till\'s expense is stamped on sync with the till\'s signed-in staff', () => {
  assert.match(read('apps/server/src/routes/sync.ts'), /recorded_by:\s+e\.recorded_by \?\? e\.paid_by \?\? null,/);
  // …which is who the till puts in paid_by (the Shift panel offers no pick)
  assert.match(read('apps/desktop/src/main/ipcHandlers.ts'), /paid_by \?\? staff\.staff_id \?\? null,/);
  const sp = read('apps/desktop/src/renderer/pages/ShiftPanel.tsx');
  const call = sp.slice(sp.indexOf('await posApi.expense.create({'), sp.indexOf('});', sp.indexOf('await posApi.expense.create({')));
  assert.ok(!/paid_by/.test(call), 'the till never sends a picked paid_by');
});
ok('A361: the web Expenses list shows "Recorded By" next to "Paid By"', () => {
  const pg = read('apps/dashboard/src/pages/expenses/ExpensesPage.tsx');
  assert.match(pg, />Paid By<\/th>\s+<th[^>]*>Recorded By<\/th>/);
  assert.match(pg, /\{e\.recorded_by_name \?\? '—'\}/);
  assert.match(pg, /<td colSpan=\{6\}/, 'the total row spans the extra column');
});
ok('A361: the schema index knows the column (schema-audit checks the routes against it)', () => {
  assert.equal(JSON.parse(read('scripts/schema-index.json')).expenses.recorded_by, '"uuid"');
  assert.match(read('migrations/109_expense_recorded_by.sql'), /ADD COLUMN IF NOT EXISTS recorded_by uuid;/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
