/**
 * terminal-write-guard.test.mjs — A159. A stolen till token (surface='desktop')
 * must not WRITE dashboard data (products, prices, users, settings). The till's
 * own writes are a short allowlist; every other desktop-surface write is denied.
 * Ships DRY-RUN (log-only) so a missed allowlist entry cannot break sync; enforce
 * is a TERMINAL_WRITE_ENFORCE=true flip.
 *
 * The guard lives in middleware/auth.ts, whose module import needs Supabase env,
 * so the pure decision is modelled here (cf. node-verify-pin.test.mjs) AND the
 * real allowlist + dry-run default are asserted from source.
 *
 * MUTATION CHECK: drop /api/orders from the allowlist below and the "till order
 * push is allowed" case flips to denied — the exact way this guard would break
 * sales sync if the allowlist were wrong.
 *
 *   node tests/terminal-write-guard.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── Mirror of middleware/auth.ts::terminalWriteDenied ─────────────────────────
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOW = [
  /^\/api\/orders(\/|$|\?)/,
  /^\/api\/sync\/push(\/|$|\?)/,
  /^\/api\/branch-prices\/sync(\/|$|\?)/,
  /^\/api\/auth\//,
  /^\/api\/tech\//,
];
const denied = (surface, method, p) => {
  if (surface !== 'desktop') return false;
  if (!WRITE_METHODS.has(method)) return false;
  return !ALLOW.some((re) => re.test((p || '').split('?')[0]));
};

// ── Dashboard writes from a till token are denied ─────────────────────────────
for (const [m, p] of [['POST','/api/products'],['PATCH','/api/products/123'],['POST','/api/categories'],
                      ['PATCH','/api/staff/9'],['DELETE','/api/branches/2'],['POST','/api/business/settings'],
                      ['PATCH','/api/discounts/1'],['POST','/api/variants']]) {
  ok(`desktop ${m} ${p} is DENIED`, () => assert.equal(denied('desktop', m, p), true));
}

// ── The till's own writes are allowed ─────────────────────────────────────────
ok('till order push is allowed', () => assert.equal(denied('desktop','POST','/api/orders'), false));
ok('till sync push is allowed',  () => assert.equal(denied('desktop','POST','/api/sync/push'), false));
ok('till price sync is allowed', () => assert.equal(denied('desktop','POST','/api/branch-prices/sync'), false));
ok('till verify-pin is allowed', () => assert.equal(denied('desktop','POST','/api/auth/verify-pin'), false));
ok('till tech audit is allowed', () => assert.equal(denied('desktop','POST','/api/tech/audit'), false));

// ── Reads and web-surface are never gated ─────────────────────────────────────
ok('desktop GET /api/products is allowed (read)', () => assert.equal(denied('desktop','GET','/api/products'), false));
ok('web POST /api/products is allowed (dashboard)', () => assert.equal(denied('web','POST','/api/products'), false));
ok('null-surface POST is allowed', () => assert.equal(denied(null,'POST','/api/products'), false));

// ── Source assertions against the REAL guard ──────────────────────────────────
const AUTH = fs.readFileSync(path.join(root, 'apps/server/src/middleware/auth.ts'), 'utf8');
ok('guard is wired into requireAuth', () => {
  assert.ok(/terminalWriteBlocked\(req, res\)/.test(AUTH), 'terminalWriteBlocked is not called in requireAuth');
});
ok('dry-run is the default (enforce is opt-in via env)', () => {
  assert.ok(/TERMINAL_WRITE_ENFORCE\b/.test(AUTH), 'no TERMINAL_WRITE_ENFORCE flag');
  assert.ok(/process\.env\.TERMINAL_WRITE_ENFORCE/.test(AUTH), 'enforce is not env-gated (would default to enforcing)');
});
ok('the real allowlist covers the till write set', () => {
  const src = AUTH.replace(/\\/g, '');   // unescape regex slashes: \/api\/orders -> /api/orders
  for (const frag of ['/api/orders', '/api/sync/push', '/api/branch-prices/sync', '/api/auth/', '/api/tech/']) {
    assert.ok(src.includes(frag), `allowlist missing ${frag} — a till write would be denied`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'A159 terminal write guard');
