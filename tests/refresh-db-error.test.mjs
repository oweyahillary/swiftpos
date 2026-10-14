/**
 * refresh-db-error.test.mjs — cloud audit 2026-10-14 (P2-18): POST /api/auth/refresh answers a DATABASE failure 503, never
 * as a verdict on the token.
 *
 * Before: a failed read of the refresh token answered 401 TOKEN_UNKNOWN (the till dropped its sign-in), and a failed read
 * of the token's successor was judged as if there were none — a replay (the whole session revoked) or a stale copy. Now
 * both answer 503 DB_UNAVAILABLE: the client keeps its token and asks again. An unknown token is still 401 TOKEN_UNKNOWN.
 *
 * RUNS the COMPILED auth router over HTTP; the database is in memory (tests/lib-memdb.mjs).
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/refresh-db-error.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - validateRefreshToken back to `if (error || !dbRow)` → TOKEN_UNKNOWN  → "a failed token read is 503" fails
 *   - the successor read's error ignored                                   → "a failed successor read is 503 … not revoked" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/auth.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);

const B = '11111111-1111-4111-8111-111111111111', U = 'cccccccc-0000-4000-8000-000000000001';
const jwt = require('jsonwebtoken');
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const refresh = async (token) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/refresh`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const jti = crypto.randomUUID();
const token = jwt.sign({ userId: U, businessId: B, sessionId: 'sess-1', surface: 'web', tokenType: 'refresh', jti }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1d' });
const jtiHash = crypto.createHash('sha256').update(jti).digest('hex');
const reset = () => {
  mem.fail = () => null;
  mem.db = {
    refresh_tokens: [
      { id: 'rt-1', jti: jtiHash, user_id: U, business_id: B, session_id: 'sess-1', revoked_at: null, acked_at: '2026-10-14T08:00:00Z', replaced_by: 'rt-2', expires_at: '2099-01-01T00:00:00Z', session_kind: 'web' },
      { id: 'rt-2', jti: 'other', user_id: U, business_id: B, session_id: 'sess-1', revoked_at: null, acked_at: '2026-10-14T09:00:00Z', replaced_by: null, expires_at: '2099-01-01T00:00:00Z', session_kind: 'web' },
    ],
    users: [{ id: U, business_id: B, name: 'Jane', status: 'active' }],
  };
};

try {
  reset();
  mem.fail = (t, op) => (t === 'refresh_tokens' && op === 'select' ? { message: 'fetch failed' } : null);
  await ok('a failed read of the refresh token is 503 DB_UNAVAILABLE — not 401 TOKEN_UNKNOWN', async () => {
    const r = await refresh(token);
    assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'DB_UNAVAILABLE');
  });
  reset();
  mem.fail = (t, op, filters) => (t === 'refresh_tokens' && op === 'select' && filters.id === 'rt-2' ? { message: 'connection reset' } : null);
  await ok('a failed read of its successor is 503 — not judged a replay: the session is not revoked', async () => {
    const r = await refresh(token);
    assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'DB_UNAVAILABLE');
    assert.ok(mem.db.refresh_tokens.every((x) => x.revoked_at === null), JSON.stringify(mem.db.refresh_tokens.map((x) => x.revoked_at)));
  });
  reset();
  mem.db.refresh_tokens = [];
  await ok('a token the database does not have is still 401 TOKEN_UNKNOWN', async () => {
    const r = await refresh(token);
    assert.equal(r.status, 401, JSON.stringify(r.body)); assert.equal(r.body.code, 'TOKEN_UNKNOWN');
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
