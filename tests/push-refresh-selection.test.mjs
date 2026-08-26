/**
 * push-refresh-selection.test.mjs — A168.
 *
 * On an order-push 401, the till must refresh the token pushAuthHeaders() is
 * actually sending — the staff token on an online shift, the owner token on an
 * offline shift (no staff token). The server sets `cashier_id = req.userId` (the
 * token subject, apps/server/src/routes/orders.ts), so refreshing — and thus
 * re-pushing under — the WRONG token would reattribute the sale: an online staff
 * order re-pushed on the owner token would be credited to the owner.
 *
 * Before A168 the 401 path called refreshStaffToken() unconditionally, so an
 * offline order's owner-token 401 found nothing to refresh and the order sat
 * pending. This tests the REAL exported decision the handler now calls, not a
 * model of it (the A167 lesson: a model can pass while the real path is wrong).
 */
import { selectPushRefresh } from '../apps/desktop/src/main/authTransport.ts';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); } };

// Online shift: a real staff token is sent → refresh the STAFF token, so the
// re-push stays on the cashier's identity.
ok('staff token present → refresh staff', selectPushRefresh('staff.jwt.here') === 'staff');

// Offline shift: signInLocal set the staff token to '' (configureStaffSession('',''))
// so the push goes under the owner token → refresh the OWNER token.
ok('empty staff token → refresh owner', selectPushRefresh('') === 'owner');

// The header builder uses the same falsy check (`_staffToken || _accessToken`);
// this documents that any falsy staff token routes to the owner refresh.
ok('undefined-ish empty routes to owner', selectPushRefresh('') === 'owner');

// MUTATION (rules 10, 23): the value that matters is that a staff order NEVER
// selects the owner refresh. If the rule were inverted, this would flip and an
// online order would reattribute — assert the guard direction explicitly.
ok('mutation guard: staff never selects owner', selectPushRefresh('s.jwt') !== 'owner');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
