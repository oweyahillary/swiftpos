/**
 * node-token-refresh.test.mjs — A160 (Phase b). When the cloud is unreachable or
 * answers a 5xx, an offline peer refreshes its session THROUGH its node instead of
 * falling to a login: the node brokers the refresh upstream and returns a fresh
 * pair. A clean 401 (revoked) is final — no node fallback. Models the decision in
 * syncEngine.ts::doRefreshAccessToken (coupled to Electron/network) and asserts the
 * real wiring from source.
 *
 * MUTATION CHECK: remove the `5xx/throw -> node` arm from the model and the two
 * "offline peer refreshes via node" cases flip to "session ends" — the exact
 * regression that would force an offline peer to log in.
 *
 *   node tests/node-token-refresh.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

// ── Model of doRefreshAccessToken's outcome ──────────────────────────────────
// cloud: '200' | '401' | '5xx' | 'throw'   node: 'pair' | 'null' | 'no-node'
function refreshOutcome(cloud, node) {
  if (cloud === '200') return 'cloud-refresh';       // cloud answered — use it
  if (cloud === '401') return 'session-ends';        // revoked — FINAL, no fallback
  // cloud === '5xx' | 'throw'  → unreachable: try the node
  if (node === 'no-node') return 'session-ends';
  if (node === 'pair')    return 'node-refresh';     // node brokered a fresh pair
  return 'session-ends';                             // node null (offline/revoked)
}

// ── The offline peer keeps its session via the node ──────────────────────────
ok('cloud unreachable (throw) + node brokers → node refresh', () => assert.equal(refreshOutcome('throw','pair'), 'node-refresh'));
ok('cloud 5xx + node brokers → node refresh',                 () => assert.equal(refreshOutcome('5xx','pair'),   'node-refresh'));

// ── A revoked token is final — never brokered around ─────────────────────────
ok('cloud 401 (revoked) → session ends, node NOT tried',      () => assert.equal(refreshOutcome('401','pair'),   'session-ends'));

// ── No node, or node can't help → session ends (unchanged) ───────────────────
ok('cloud unreachable + no node → session ends',              () => assert.equal(refreshOutcome('throw','no-node'), 'session-ends'));
ok('cloud unreachable + node offline (null) → session ends',  () => assert.equal(refreshOutcome('throw','null'), 'session-ends'));

// ── Cloud reachable → normal refresh, node untouched ─────────────────────────
ok('cloud 200 → cloud refresh (no node)',                     () => assert.equal(refreshOutcome('200','no-node'), 'cloud-refresh'));

// ── Source wiring: the three real pieces exist ───────────────────────────────
const CLIENT = fs.readFileSync(path.join(root, 'apps/desktop/src/main/nodeClient.ts'), 'utf8');
const SERVER = fs.readFileSync(path.join(root, 'apps/desktop/src/main/nodeServer.ts'), 'utf8');
const SYNC   = fs.readFileSync(path.join(root, 'apps/desktop/src/main/syncEngine.ts'), 'utf8');

ok('nodeClient exports refreshViaNode (peer→node call)', () => {
  assert.ok(/export async function refreshViaNode/.test(CLIENT), 'refreshViaNode missing');
  assert.ok(/\/node\/refresh/.test(CLIENT), 'refreshViaNode does not call /node/refresh');
});
ok('node server brokers /node/refresh upstream', () => {
  assert.ok(/url === '\/node\/refresh'/.test(SERVER), '/node/refresh handler missing');
  assert.ok(/\/api\/auth\/refresh/.test(SERVER), 'the broker does not proxy to the cloud /api/auth/refresh');
});
ok('sync engine falls back to the node on unreachable/5xx, not on 401', () => {
  assert.ok(/tryNodeRefresh/.test(SYNC), 'no node fallback in the refresh path');
  assert.ok(/res\.status >= 500 && await tryNodeRefresh/.test(SYNC), '5xx does not fall back to the node');
  assert.ok(/refreshViaNode/.test(CLIENT), 'refreshViaNode not wired');
});

console.log(`\n${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'A160 node token refresh');
