/**
 * offline-auth-fallback.test.mjs — A152. A cloud/node that ANSWERS with a 5xx is
 * UNREACHABLE, so PIN sign-in must fall through to the local authority (node
 * roster / offline cache). A clean 4xx is a real rejection and must NOT fall
 * back. Models the decision in ipcHandlers.ts::auth:verifyPin + nodeClient.ts,
 * which are coupled to Electron/SQLite/bcrypt (so the pure decision is modelled
 * here, the same way node-verify-pin.test.mjs models verifyPinAtNode).
 *
 * MUTATION CHECK (rules 10, 23): the classifier below is `status >= 500`. Narrow
 * it back to the pre-A152 `status === 503` and the 502/500/504 cases flip from
 * "fallback" to "rejected" — the exact outage bug — and this file goes red on
 * those lines, naming them.
 *
 *   node tests/offline-auth-fallback.test.mjs
 */
import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

// ── The predicate under test — mirror of apps/desktop/src/main/authTransport.ts.
//    Keep in lockstep with isUnreachableStatus(); that file carries the same rule.
const isUnreachableStatus = (status) => status >= 500 && status <= 599;

// ── Model of the verify-pin authority chain (node → cloud → local). Returns the
//    branch taken, not a session, so the DECISION is what's asserted.
//    nodeResult: 'ok' | 'rejected' | 'transport' | 'no-node'
//    cloudStatus: HTTP status the cloud fetch resolved with, or 'throw' for a
//                 thrown transport error (DNS/refused/timeout).
function verifyPinDecision({ nodeResult = 'no-node', cloudStatus }) {
  // 1. node leg
  if (nodeResult === 'ok') return 'node-signin';
  if (nodeResult === 'rejected') return 'final-reject';   // node answered no
  // 'transport' | 'no-node' → fall through to cloud

  // 2. cloud leg
  if (cloudStatus === 'throw') return 'local-fallback';           // unreachable (thrown)
  if (isUnreachableStatus(cloudStatus)) return 'local-fallback';  // unreachable (5xx) — A152
  if (cloudStatus >= 400) return 'final-reject';                  // clean 4xx = final
  return 'cloud-signin';                                          // 2xx
}

// Node leg classification mirror (nodeClient.ts::verifyPinAtNodeClient).
function nodeLeg(status) {
  if (isUnreachableStatus(status)) return 'transport';   // 5xx → retry elsewhere
  if (status >= 400) return 'rejected';                  // 4xx = final answer
  return 'ok';
}

// ── The outage: cloud answers 5xx, a cached cashier must still sign in ─────────
ok('cloud 502 (Render edge up, app down) → local fallback', verifyPinDecision({ cloudStatus: 502 }) === 'local-fallback');
ok('cloud 503 → local fallback', verifyPinDecision({ cloudStatus: 503 }) === 'local-fallback');
ok('cloud 500 → local fallback', verifyPinDecision({ cloudStatus: 500 }) === 'local-fallback');
ok('cloud 504 gateway timeout → local fallback', verifyPinDecision({ cloudStatus: 504 }) === 'local-fallback');
ok('thrown transport error → local fallback', verifyPinDecision({ cloudStatus: 'throw' }) === 'local-fallback');

// ── A real rejection must stay final — a sacked cashier cannot unplug to win ───
ok('cloud 401 → FINAL reject (no fallback)', verifyPinDecision({ cloudStatus: 401 }) === 'final-reject');
ok('cloud 403 → FINAL reject', verifyPinDecision({ cloudStatus: 403 }) === 'final-reject');
ok('cloud 400 → FINAL reject', verifyPinDecision({ cloudStatus: 400 }) === 'final-reject');

// ── Happy path unchanged ──────────────────────────────────────────────────────
ok('cloud 200 → cloud sign-in', verifyPinDecision({ cloudStatus: 200 }) === 'cloud-signin');

// ── Node leg: 5xx is transport (falls to cloud), 4xx is final ─────────────────
ok('node 503 → transport (was the only 5xx handled before)', nodeLeg(503) === 'transport');
ok('node 502 → transport (A152: was wrongly read as rejection)', nodeLeg(502) === 'transport');
ok('node 500 → transport', nodeLeg(500) === 'transport');
ok('node 401 → rejected (final)', nodeLeg(401) === 'rejected');
ok('node 200 → ok', nodeLeg(200) === 'ok');
ok('node answers ok, never reaches cloud', verifyPinDecision({ nodeResult: 'ok', cloudStatus: 500 }) === 'node-signin');
ok('node rejects → final, never falls to cloud', verifyPinDecision({ nodeResult: 'rejected', cloudStatus: 200 }) === 'final-reject');
ok('node transport → falls to cloud, cloud 5xx → local', verifyPinDecision({ nodeResult: 'transport', cloudStatus: 503 }) === 'local-fallback');

// ── Contract sanity on the predicate itself ───────────────────────────────────
ok('predicate: 499 is NOT unreachable', isUnreachableStatus(499) === false);
ok('predicate: 500..599 all unreachable', [500,501,502,503,504,599].every(isUnreachableStatus));
ok('predicate: 600 is NOT unreachable', isUnreachableStatus(600) === false);

console.log(`\n${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'A152 offline-auth fallback decision');
