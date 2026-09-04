/**
 * transfer-receive-hang.test.mjs — A203 ("Mark received" hangs; stock strands at source).
 *
 * A single user despatching AND receiving a transfer trips the server's
 * separation-of-duty guard (409 same_user_receipt). The frontend answered that
 * with a NATIVE window.confirm(), which blocks the page (and can't be driven by
 * tests/automation) — so "Mark received" appeared to hang, receipt never
 * completed, and stock sat debited at source / uncredited at destination.
 * Separately, the status route had no try/catch, so any throw in the stock RPCs
 * would escape as an unhandled async rejection and hang the request in Express 4.
 *
 * Fixes: (1) an in-app modal replaces window.confirm; (2) the route is wrapped so
 * a failure returns 500 instead of hanging.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page   = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/StockTransfersPage.tsx'), 'utf8');
const server = fs.readFileSync(path.join(root, 'apps/server/src/routes/stock.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('client: the same-user override no longer uses a blocking native confirm', () => {
  // No window.confirm on the same_user_receipt path (it blocked the page/automation).
  const sameUserBlock = page.slice(
    page.indexOf("same_user_receipt"),
    page.indexOf("same_user_receipt") + 260,
  );
  assert.doesNotMatch(sameUserBlock, /window\.confirm/,
    'the same-user path must open the in-app modal, not window.confirm');
  assert.match(page, /setSameUserPrompt\(\{/,
    'the 409 must open the in-app confirmation modal');
});

ok('client: same-user is detected PROACTIVELY, before any server call', () => {
  // Mark received routes through markReceived, which opens the modal directly when
  // the current user despatched it — so the allowSameUser=false 409 (and any dialog
  // that could gate it) is never reached. This is the bulletproof part of the fix.
  assert.match(page, /const markReceived = \(t: Transfer\) => \{/, 'a markReceived handler must exist');
  assert.match(page, /t\.despatched_by && user\?\.id && t\.despatched_by === user\.id/,
    'markReceived must compare the transfer despatcher to the current user');
  assert.match(page, /onClick=\{\(\) => markReceived\(t\)\}/,
    'the Mark received button must call markReceived, not advance() directly');
});

ok('client: the modal can complete the override (advance with allow_same_user)', () => {
  assert.match(page, /void advance\(p\.t, p\.status, true\)/,
    'the modal Proceed button must retry advance() with the same-user override');
});

ok('server: the transfer status route is wrapped so it cannot hang on a throw', () => {
  const handler = server.slice(
    server.indexOf("router.patch('/transfers/:id/status'"),
    server.indexOf("export default router;"),
  );
  assert.match(handler, /try \{/, 'the handler must open a try');
  assert.match(handler, /catch \(err\) \{\s*sendError\(res, err as Error\);/,
    'a failure must return an error response, never an unhandled async rejection');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
