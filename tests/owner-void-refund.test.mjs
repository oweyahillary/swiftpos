/**
 * owner-void-refund.test.mjs — A187 Phase 2a.
 *
 * An owner voiding/refunding from the dashboard self-authorises: no supervisor
 * PIN. The permission was gated on `orders.void` conditioned on ONE thing —
 * there must still be an audit trail. So this guards two properties of
 * routes/orders.ts, per handler:
 *   1. the owner path skips the supervisor-PIN authoriser, and
 *   2. it still records WHO did it + WHY (voided_by/refunded_by = req.userId,
 *      a reason, and authorized_by = the same owner) — the audit trail.
 * And that the NON-owner (cashier/till) path still requires the override PIN.
 *
 * Source-level (mirrors terminal-write-guard.test.mjs): asserts the shape of the
 * shipped handler, so removing the bypass OR the audit fields fails the test.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(
  path.join(root, 'apps/server/src/routes/orders.ts'), 'utf8',
);

// Slice each handler body so assertions can't cross-match between void/refund.
function handlerBody(marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `handler not found: ${marker}`);
  // up to the next router.post, or 4k chars, whichever first
  const rest = src.slice(start + marker.length);
  const nextRoute = rest.indexOf('router.post(');
  return rest.slice(0, nextRoute === -1 ? 4000 : nextRoute);
}

const voidBody   = handlerBody("router.post('/:id/void'");
const refundBody = handlerBody("router.post('/:id/refund'");

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

// ── VOID ──────────────────────────────────────────────────────────────────────
ok('void: owner self-authorises (skips PIN)', () => {
  assert.match(voidBody, /isPaid\s*&&\s*req\.isOwner/,
    'expected an isPaid && req.isOwner branch that bypasses the supervisor PIN');
  assert.match(voidBody, /req\.isOwner[\s\S]*?authorizedBy\s*=\s*req\.userId/,
    'owner branch must set authorizedBy = req.userId (self-authorised)');
});
ok('void: audit trail recorded (who + why)', () => {
  assert.match(voidBody, /voided_by:\s*req\.userId/, 'must record voided_by = req.userId');
  assert.match(voidBody, /void_reason:\s*reason/,    'must record the void_reason');
  assert.match(voidBody, /A reason is required to void/, 'reason must be required');
});
ok('void: cashier/till path still requires the override PIN', () => {
  assert.match(voidBody, /else if \(isPaid\)/, 'non-owner paid path must remain');
  assert.match(voidBody, /verifyOverrideAuthorizer/, 'non-owner path must still verify the override authoriser');
});

ok('void: owner voids at any age; staff stay window-limited', () => {
  // owners bypass the 30-min window; non-owners still hit VOID_WINDOW_EXPIRED
  assert.match(voidBody, /orderAge > VOID_WINDOW_MINUTES && !req\.isOwner/,
    'window check must exempt owners (orderAge > window && !req.isOwner)');
  assert.match(voidBody, /VOID_WINDOW_EXPIRED/, 'the window rejection must still exist for non-owners');
});

// ── REFUND ────────────────────────────────────────────────────────────────────
ok('refund: owner self-authorises (skips PIN)', () => {
  assert.match(refundBody, /if \(req\.isOwner\)[\s\S]*?authorizedBy\s*=\s*req\.userId/,
    'owner branch must set authorizedBy = req.userId (self-authorised)');
});
ok('refund: audit trail recorded (who + why)', () => {
  assert.match(refundBody, /refunded_by:\s*req\.userId/, 'must record refunded_by = req.userId');
  assert.match(refundBody, /refund_reason:\s*String\(reason\)\.trim\(\)/, 'must record the refund_reason');
  assert.match(refundBody, /refund_authorized_by:\s*authorizedBy/, 'must record refund_authorized_by');
  assert.match(refundBody, /A reason is required to refund/, 'reason must be required');
});
ok('refund: cashier/till path still requires the override PIN', () => {
  assert.match(refundBody, /else\s*\{[\s\S]*?verifyOverrideAuthorizer/,
    'non-owner path must still verify the override authoriser');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
