/**
 * kds-conn-state.test.mjs — A192 (KDS auth failure must never read as "all clear").
 *
 * The defect: /kds polled `GET /api/kitchen/tickets`; a 401 is not a thrown error,
 * so the old code set tickets = [] and showed the green "connected" dot + "All clear
 * — no pending tickets". A kitchen with an expired token looked healthy while orders
 * piled up unseen.
 *
 * Source-level (mirrors kds-token.test.mjs). Mutation-checkable: removing the 401/403
 * → 'auth' branch, the conn-driven dot, or the guard that stops [] overwriting the
 * board on a non-ok fetch each fails a specific assertion naming the file.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conn = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/kds/kdsConn.ts'), 'utf8');
const page = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/kds/KDSPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('classifier: a 2xx with a tickets array is the ONLY "ok"', () => {
  assert.match(conn, /if \(ok && isArray\) return 'ok'/,
    "a genuinely-reachable display requires res.ok AND a real array (a 200 with a junk body is not 'ok')");
});

ok('classifier: 401/403 map to "auth", never "ok"', () => {
  assert.match(conn, /status === 401 \|\| status === 403\) return 'auth'/,
    "a missing/expired token must classify as 'auth' (re-pair), the whole point of A192");
});

ok('classifier: everything else is "error", not an empty board', () => {
  assert.match(conn, /return 'error';\s*}/,
    "any other outcome (other non-2xx, malformed body, network) must be 'error', not silently empty");
});

ok('page: consumes the classifier and tracks a conn state', () => {
  assert.match(page, /classifyKdsFetch/, 'KDSPage must call the classifier');
  assert.match(page, /const \[conn, setConn\] = useState<KdsConn>/, 'KDSPage must hold a conn state');
  assert.match(page, /const state = classifyKdsFetch\(res\.ok, res\.status, isArr\);/,
    'conn must be derived from the real fetch outcome, not "the poll ran"');
});

ok('page: a non-ok fetch does NOT overwrite the board with []', () => {
  // The guard: on state !== 'ok' we return BEFORE setTickets — so a 401 can never
  // blank the board. Removing this return reintroduces the exact A192 bug.
  assert.match(page, /if \(state !== 'ok'\) \{[\s\S]*?return;\s*\}/,
    "on a non-ok fetch the handler must bail before setTickets(data)");
});

ok('page: the status dot is driven by conn (no hardcoded green)', () => {
  assert.match(page, /conn === 'ok' \? 'bg-green-500 animate-pulse'/,
    'the live dot must be conditional on conn === ok');
  assert.match(page, /conn === 'auth' \? 'bg-red-500'/,
    'an auth failure must show a red (not green) dot');
});

ok('page: a 401 renders a re-pair panel, never "All clear"', () => {
  assert.match(page, /conn === 'auth' \?/, 'the body must branch on the auth state');
  assert.match(page, /isn’t paired|isn't paired|Re-pair display/,
    'the auth state must tell the user to re-pair, not show an empty board');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
