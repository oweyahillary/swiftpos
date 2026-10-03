/**
 * release-version.test.mjs — 0.6.28: every surface says which release it runs (owner, 2026-10-01: "can we add versioning
 * on the website also so that i can tell which one i am running?").
 *
 * The release number lives in shared/release.ts (copied to the cloud, the dashboard and the admin portal) and MUST equal
 * the till's version (apps/desktop/package.json) — the release is one number. Runs the BUILT cloud route.
 *
 *   node tests/release-version.test.mjs          (build apps/server first — this runs its dist/)
 *
 * MUTATIONS TO CONFIRM BITE: RELEASE left behind on a desktop bump → "the release is the till's version" fails; the route
 * without requireAuth → "anonymous callers are not told" fails; the commit not read from Render → "…and the commit
 * Render built" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

if (!fs.existsSync(path.join(DIST, 'routes/version.js'))) {
  console.log('\nCannot load apps/server/dist/routes/version.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.RENDER_GIT_COMMIT = '47a86c9adbede633e6d99817be3b5daf8bde9fea';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const R = require(path.join(DIST, 'lib/release.js'));

try {
  await ok('the release is the till\'s version (one number for the till, the cloud and the websites)', () => {
    assert.equal(R.RELEASE, JSON.parse(read('apps/desktop/package.json')).version);
  });
  await ok('the label: "v0.6.28 · 47a86c9"; no commit (or a local build) → the release alone', () => {
    assert.equal(R.releaseLabel('0.6.28', '47a86c9adbede'), 'v0.6.28 · 47a86c9');
    assert.equal(R.releaseLabel('0.6.28', 'dev'), 'v0.6.28');
    assert.equal(R.releaseLabel('0.6.28', null), 'v0.6.28');
  });
  await ok('the website and the cloud differ only when both are known and not equal', () => {
    assert.equal(R.releasesDiffer('0.6.28', '0.6.27'), true);
    assert.equal(R.releasesDiffer('0.6.28', '0.6.28'), false);
    assert.equal(R.releasesDiffer('0.6.28', null), false);
  });

  const express = require('express'); const jwt = require('jsonwebtoken');
  const app = express();
  const V = require(path.join(DIST, 'routes/version.js'));
  app.use('/api/admin/version', V.adminVersionRouter);
  app.use('/api/version', V.default);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const get = async (p, token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const user = jwt.sign({ userId: 'u', businessId: 'b', branchId: 'br', isOwner: true, permissionKeys: ['*'], permissionsVersion: 0,
      sessionId: 's', surface: 'web' }, process.env.JWT_SECRET);
    const admin = jwt.sign({ adminId: 'a', email: 'a@x', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
    await ok('anonymous callers are not told (as /health in production)', async () => {
      assert.equal((await get('/api/version')).status, 401);
      assert.equal((await get('/api/admin/version')).status, 401);
    });
    await ok('signed in: the cloud\'s release and the commit Render built', async () => {
      const r = await get('/api/version', user);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.release, R.RELEASE); assert.equal(r.body.commit, '47a86c9');
    });
    await ok('the admin portal asks with its own token', async () => {
      const r = await get('/api/admin/version', admin);
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.release, R.RELEASE);
    });
  } finally { server.close(); }

  await ok('the routes are mounted (admin/version before /admin)', () => {
    const idx = read('apps/server/src/routes/index.ts');
    assert.match(idx, /router\.use\('\/version',\s+versionRoutes\);/);
    assert.ok(idx.indexOf("router.use('/admin/version'") < idx.indexOf("router.use('/admin',"));
  });
  await ok('the dashboard, the web POS, the login page and the admin portal show it', () => {
    assert.match(read('apps/dashboard/src/components/DashboardLayout.tsx'), /<ReleaseBadge getCloud=\{\(\) => api\.get\('\/api\/version'\)\} \/>/);
    assert.match(read('apps/dashboard/src/pages/pos/POSDrawer.tsx'), /<ReleaseBadge getCloud=\{\(\) => posApi\.get\('\/api\/version'\)\} \/>/);
    assert.match(read('apps/dashboard/src/pages/LoginPage.tsx'), /ZapTill \{releaseLabel\(RELEASE, __WEB_BUILD_SHA__\)\}/);
    assert.match(read('apps/admin/src/AdminPortal.tsx'), /req\("GET", "\/version", undefined\)/);
    assert.match(read('apps/admin/vite.config.ts'), /__WEB_BUILD_SHA__: JSON\.stringify\(\(process\.env\.VERCEL_GIT_COMMIT_SHA/);
  });
} catch (e) { fail++; console.log(`FAIL  harness\n      ${e.stack}`); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
