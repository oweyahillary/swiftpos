// A529 — every answer from the cloud carries X-ZapTill-Server, so a till can tell the cloud's answer from another server's
// page (a suspended Render service, a Cloudflare page, a captive portal) and treat the latter as no connection.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/server-signature-a529.test.mjs
//
// RUNS the COMPILED server itself (apps/server/dist/index.js — the whole middleware chain as deployed) in a child process,
// from an empty directory (so no .env is read), with a database address that cannot answer (127.0.0.1:9) and no mail
// keys. Over HTTP:
//   a route (/api/health), /health (its database down: 503), an unknown route (404), a thrown error (a malformed JSON
//   body: the error handler's 500), a refused CORS origin (403), and the sign-in limiter's 429 — each carries the header.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-19):
//   - index.ts without app.use(signAnswers)                     → every case fails
//   - app.use(signAnswers) moved below the limiters / the routes → the 429 (and the CORS 403) fail
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'apps/server/dist/index.js');
if (!fs.existsSync(ENTRY)) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a529-'));   // no .env here
const env = {
  PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TZ: 'UTC',
  PORT: String(port), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:5173',
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'test-only',
  JWT_SECRET: randomBytes(24).toString('hex'), ADMIN_JWT_SECRET: randomBytes(24).toString('hex'),
  SUPABASE_JWT_SECRET: randomBytes(24).toString('hex'),
};
const child = spawn(process.execPath, ['--no-warnings', ENTRY], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const base = `http://127.0.0.1:${port}`;
try {
  // Wait for it to listen.
  const until = Date.now() + 90_000;   // a cold start loads every router (~12 s on a slow disk)
  for (;;) {
    try { await fetch(`${base}/api/health`); break; }
    catch { if (Date.now() > until || child.exitCode !== null) throw new Error(`the server did not start:\n${out.slice(-2000)}`); await new Promise((r) => setTimeout(r, 200)); }
  }
  const SIG = 'x-zaptill-server';

  await ok('a route (/api/health): 200, signed', async () => {
    const r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200); assert.equal(r.headers.get(SIG), '1');
  });
  await ok('/health with its database down: 503, signed (a till reads it as A152 unreachable — the cloud\'s own 5xx)', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 503); assert.equal(r.headers.get(SIG), '1');
  });
  await ok('an unknown route: 404, signed (it is still our server answering)', async () => {
    const r = await fetch(`${base}/api/no-such-route-a529`);
    assert.equal(r.status, 404); assert.equal(r.headers.get(SIG), '1');
    const r2 = await fetch(`${base}/not-the-api`);
    assert.equal(r2.status, 404); assert.equal(r2.headers.get(SIG), '1');
  });
  await ok('a thrown error (a malformed JSON body → the error handler): 500, signed', async () => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":' });
    assert.equal(r.status, 500); assert.equal(r.headers.get(SIG), '1');
    assert.deepEqual(await r.json(), { error: 'Internal server error' });
  });
  await ok('a refused CORS origin: 403, signed', async () => {
    const r = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403); assert.equal(r.headers.get(SIG), '1');
  });
  await ok('the sign-in limiter: after 30 refused sign-ins the 31st is 429, signed', async () => {
    let last = null;
    for (let i = 0; i < 31; i++) {
      last = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `nobody${i}@example.com`, password: 'wrong-password-a529' }) });   // a fresh account each: the route's own per-account lock never answers first
      if (last.status !== 429) await last.arrayBuffer();
      else break;
    }
    assert.equal(last.status, 429, `the limiter never answered (last ${last.status})`);
    assert.equal((await last.json()).error, 'Too many attempts — please try again in 15 minutes', 'the sign-in limiter\'s own answer');
    assert.equal(last.headers.get(SIG), '1');
  });
} catch (e) {
  fail++; console.log(`FAIL  setup\n      ${e.message}`);
} finally {
  child.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
