/**
 * desktop-update.test.mjs — A348 (2026-09-28): desktop updates are approved per business; held by default.
 *
 * Owner: "can i find a way of picking only one client to run the update not all the clients?" → "hold by default, per
 * business, build 0.6.16".
 *
 *   node tests/desktop-update.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the real release rules (lib/desktopReleases) and the COMPILED routes — /api/desktop-update (till tokens, the real
 * auth middleware) and the two admin routes (real requireAdmin) — over HTTP. The database is in memory; GitHub's API is a
 * fake answering the cloud's own fetch calls; JWT secrets are random per run.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - /v/… serves any version (no `version !== want` check)        → "a version the business is not approved for → 403" fails
 *   - summariseReleases back to one copy per version (no merge)       → "the real v0.6.16 split …" fails
 *   - assetDownloadUrl back to the public link without a token        → "…BY FILE ID (no token needed)" fails
 *   - assetFor accepts any file name                                → "a file that is not an updater file → 404" fails
 *   - the admin route accepts an incomplete release                 → "approving an incomplete release is refused" fails
 *   - summariseReleases skips pre-releases again                     → "a pre-release … is listed and servable" fails
 *   - a stored non-x.y.z value passed through as approved           → "a stored value that is not x.y.z … HELD" fails
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

if (!fs.existsSync(path.join(DIST, 'routes/desktopUpdate.js'))) {
  console.log('\nCannot load apps/server/dist/routes/desktopUpdate.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.GITHUB_RELEASES_TOKEN;
delete process.env.DESKTOP_RELEASES_REPO;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const L = require(path.join(DIST, 'lib/desktopReleases.js'));

// ── The database (in memory) ──
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const db = {
  businesses: [
    { id: A, name: 'B Foods', status: 'active', desktop_approved_version: null },
    { id: B, name: 'Other Client', status: 'active', desktop_approved_version: null },
  ],
  admin_audit_log: [],
};
supabase.from = (table) => {
  const f = []; let patch = null; let inserting = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, v]) => r[k] === v));
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    update(p) { patch = p; return q; },
    insert(r) { inserting = r; (db[table] ??= []).push(...(Array.isArray(r) ? r : [r])); return q; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
    single() {
      if (patch) rows().forEach((r) => Object.assign(r, patch));
      const r = rows()[0];
      return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none' } });
    },
    then(res, rej) { if (patch) rows().forEach((r) => Object.assign(r, patch)); return Promise.resolve({ data: inserting ?? rows(), error: null }).then(res, rej); },
  };
  return q;
};

// ── A fake GitHub (answers only the cloud's calls to api.github.com; everything else is real) ──
const realFetch = globalThis.fetch;
const gh = { releases: [], calls: [] };
const asset = (id, name) => ({ id, name, url: `https://api.github.com/repos/oweyahillary/swiftpos/releases/assets/${id}`, browser_download_url: `https://github.com/oweyahillary/swiftpos/releases/download/x/${name}` });
const fullRelease = (id, v, draft = false) => ({ id, tag_name: `v${v}`, draft, assets: [asset(id * 10 + 1, 'latest.yml'), asset(id * 10 + 2, `SwiftPOS-${v}-x64.exe`), asset(id * 10 + 3, `SwiftPOS-${v}-x64.exe.blockmap`)] });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.github.com/')) return realFetch(url, init);
  gh.calls.push({ url: u, auth: init.headers?.Authorization ?? null, accept: init.headers?.Accept });
  if (u.includes('/releases?')) return new Response(JSON.stringify(gh.releases), { status: 200, headers: { 'content-type': 'application/json' } });
  const m = u.match(/\/releases\/assets\/(\d+)$/);
  if (m) return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/signed/${m[1]}?X-Amz-Signature=abc` } });
  return new Response('{}', { status: 404 });
};

// ── The app: the real routers behind the real middleware ──
const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/desktop-update', require(path.join(DIST, 'routes/desktopUpdate.js')).default);
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const tillToken = (biz) => jwt.sign({ userId: 'u-owner', businessId: biz, branchId: null, isOwner: true, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET);
const adminToken = jwt.sign({ adminId: 'adm-1', email: 'ops@swiftpos.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const till = async (biz, p) => { const r = await realFetch(`${base}/api/desktop-update${p}`, { headers: { Authorization: `Bearer ${tillToken(biz)}` }, redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), body: r.status === 302 ? null : await r.json().catch(() => null) }; };
const admin = async (method, p, body) => { const r = await realFetch(`${base}/api/admin${p}`, { method, headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) }; };
const fresh = () => L.clearReleaseCache();

try {
  // ── 1. The rules ──
  await ok('versions compare by number (0.6.10 is newer than 0.6.9)', () => {
    assert.equal(L.compareVersions('0.6.10', '0.6.9'), 1);
    assert.equal(L.compareVersions('0.6.16', '0.6.16'), 0);
    assert.ok(L.isVersion('0.6.16') && !L.isVersion('v0.6.16') && !L.isVersion('0.6') && !L.isVersion('0.6.16-beta'));
  });
  await ok('a release is complete with latest.yml + the installer (the blockmap is optional — A350)', () => {
    assert.deepEqual(L.missingFiles(fullRelease(1, '0.6.16').assets), []);
    assert.deepEqual(L.missingFiles([asset(1, 'latest.yml'), asset(2, 'SwiftPOS-0.6.16-x64.exe')]), []);
    assert.deepEqual(L.missingFiles([asset(1, 'SwiftPOS-0.6.16-x64.exe')]), ['latest.yml']);
    assert.deepEqual(L.missingFiles([asset(1, 'latest.yml')]), ['installer (.exe)']);
  });
  await ok('the real v0.6.16 split (blockmap in one copy, latest.yml + installer in the other) is ONE complete release, whatever the order', () => {
    const a = { id: 398098724, tag_name: 'v0.6.16', prerelease: true, assets: [asset(9001, 'SwiftPOS-0.6.16-x64.exe.blockmap')] };
    const b = { id: 398098725, tag_name: 'v0.6.16', prerelease: true, assets: [asset(9002, 'latest.yml'), asset(9003, 'SwiftPOS-0.6.16-x64.exe')] };
    for (const list of [[a, b], [b, a]]) {
      const [r] = L.summariseReleases(list);
      assert.equal(r.complete, true); assert.equal(r.copies, 2);
      assert.deepEqual(r.assets.map((x) => [x.name, x.id]).sort(), [['SwiftPOS-0.6.16-x64.exe', 9003], ['SwiftPOS-0.6.16-x64.exe.blockmap', 9001], ['latest.yml', 9002]]);
    }
  });
  await ok('the same file in two copies: the published copy wins over a draft, then the newest', () => {
    const draft = { id: 50, tag_name: 'v0.6.17', draft: true, assets: [asset(501, 'latest.yml'), asset(502, 'SwiftPOS-0.6.17-x64.exe')] };
    const pub = { id: 40, tag_name: 'v0.6.17', draft: false, assets: [asset(401, 'latest.yml'), asset(402, 'SwiftPOS-0.6.17-x64.exe')] };
    const [r] = L.summariseReleases([draft, pub]);
    assert.equal(r.releaseId, 40); assert.equal(r.draft, false); assert.equal(L.assetFor(r, 'latest.yml').id, 401);
  });
  await ok('a pre-release (every build from 0.6.16) is listed and servable — tills on 0.6.15 and older never see one', () => {
    const [r] = L.summariseReleases([{ ...fullRelease(5, '0.6.17'), prerelease: true }]);
    assert.equal(r.version, '0.6.17'); assert.equal(r.prerelease, true); assert.equal(r.complete, true);
    const cfg = fs.readFileSync(path.join(ROOT, 'apps/desktop/electron-builder.config.js'), 'utf8');
    assert.match(cfg, /publish: dev \? null : \[\{ provider: 'github', owner: 'oweyahillary', repo: 'swiftpos', releaseType: 'prerelease' \}\]/);
  });
  await ok('the release workflow creates the release BEFORE the build uploads, then verifies one copy with latest.yml + installer (A350)', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const create = wf.indexOf('gh release create "$TAG"'), build = wf.indexOf('npx electron-builder --win nsis'), verify = wf.indexOf('releases exist for $TAG');
    assert.ok(create > 0 && build > create && verify > build, 'create → build → verify');
    assert.match(wf, /--prerelease/); assert.match(wf, /EP_GH_IGNORE_TIME: 'true'/);
    assert.match(wf, /\[ "\$COPIES" = "1" \]/);
  });
  await ok('a file that is not an updater file → no asset (the route answers 404)', () => {
    const [r] = L.summariseReleases([{ ...fullRelease(1, '0.6.16'), assets: [...fullRelease(1, '0.6.16').assets, asset(9, 'notes.txt')] }]);
    assert.equal(L.assetFor(r, 'notes.txt'), null);
    assert.equal(L.assetFor(r, '../latest.yml'), null);
    assert.equal(L.assetFor(r, 'latest.yml').name, 'latest.yml');
  });

  // ── 2. The till's feed ──
  gh.releases = [fullRelease(1, '0.6.16'), fullRelease(2, '0.6.15')]; fresh();
  await ok('a new business is HELD: status says so, and no file is handed out', async () => {
    const s = await till(A, '/status');
    assert.deepEqual(s.body, { approvedVersion: null, held: true });
    assert.equal((await till(A, '/v/0.6.16/latest.yml')).status, 403);
  });
  await ok('approved 0.6.16 → status names it; each file redirects to GitHub BY FILE ID (no token needed) — A350', async () => {
    db.businesses[0].desktop_approved_version = '0.6.16';
    assert.deepEqual((await till(A, '/status')).body, { approvedVersion: '0.6.16', held: false });
    gh.calls = [];
    for (const [f, id] of [['latest.yml', 11], ['SwiftPOS-0.6.16-x64.exe', 12], ['SwiftPOS-0.6.16-x64.exe.blockmap', 13]]) {
      const r = await till(A, `/v/0.6.16/${f}`);
      assert.equal(r.status, 302, f);
      assert.equal(r.location, `https://objects.githubusercontent.com/signed/${id}?X-Amz-Signature=abc`, r.location);
    }
    // never the ambiguous public /releases/download/<tag>/<file> link, and no token sent (none set)
    assert.ok(gh.calls.filter((c) => /\/releases\/assets\//.test(c.url)).every((c) => c.auth === null && c.accept === 'application/octet-stream'));
  });
  await ok('the real v0.6.16 split, served: each file from the copy that has it', async () => {
    const saved = gh.releases;
    gh.releases = [
      { id: 398098724, tag_name: 'v0.6.16', prerelease: true, assets: [asset(9001, 'SwiftPOS-0.6.16-x64.exe.blockmap')] },
      { id: 398098725, tag_name: 'v0.6.16', prerelease: true, assets: [asset(9002, 'latest.yml'), asset(9003, 'SwiftPOS-0.6.16-x64.exe')] },
    ]; fresh();
    assert.match((await till(A, '/v/0.6.16/latest.yml')).location, /signed\/9002\?/);
    assert.match((await till(A, '/v/0.6.16/SwiftPOS-0.6.16-x64.exe')).location, /signed\/9003\?/);
    assert.match((await till(A, '/v/0.6.16/SwiftPOS-0.6.16-x64.exe.blockmap')).location, /signed\/9001\?/);
    gh.releases = saved; fresh();
  });
  await ok('a version the business is not approved for → 403 (older or newer alike)', async () => {
    assert.equal((await till(A, '/v/0.6.15/latest.yml')).status, 403);
    gh.releases = [fullRelease(3, '0.6.17'), ...gh.releases]; fresh();
    assert.equal((await till(A, '/v/0.6.17/latest.yml')).status, 403);
  });
  await ok('a stored value that is not x.y.z (hand-edited) counts as HELD, never as approved', async () => {
    db.businesses[1].desktop_approved_version = '';
    assert.deepEqual((await till(B, '/status')).body, { approvedVersion: null, held: true });
    db.businesses[1].desktop_approved_version = 'latest';
    assert.deepEqual((await till(B, '/status')).body, { approvedVersion: null, held: true });
    db.businesses[1].desktop_approved_version = null;
  });
  await ok('approval is per business: the other client is still held', async () => {
    assert.deepEqual((await till(B, '/status')).body, { approvedVersion: null, held: true });
    assert.equal((await till(B, '/v/0.6.16/latest.yml')).status, 403);
  });
  await ok('a file that is not an updater file → 404', async () => {
    assert.equal((await till(A, '/v/0.6.16/other.exe')).status, 404);
    assert.equal((await till(A, '/v/0.6.16/notes.txt')).status, 404);
  });
  await ok('with GITHUB_RELEASES_TOKEN: the till gets a signed link; the token goes to GitHub only (drafts / private repo)', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'test-release-token-' + randomBytes(6).toString('hex'); fresh(); gh.calls = [];
    const r = await till(A, '/v/0.6.16/SwiftPOS-0.6.16-x64.exe');
    assert.equal(r.status, 302); assert.match(r.location, /^https:\/\/objects\.githubusercontent\.com\/signed\//);
    assert.ok(!r.location.includes(process.env.GITHUB_RELEASES_TOKEN));
    assert.ok(gh.calls.every((c) => c.auth === `Bearer ${process.env.GITHUB_RELEASES_TOKEN}`));
    assert.ok(gh.calls.some((c) => c.accept === 'application/octet-stream'));
    delete process.env.GITHUB_RELEASES_TOKEN; fresh();
  });
  await ok('the approved release is incomplete → 404 naming what is missing (never half-served)', async () => {
    gh.releases = [{ id: 7, tag_name: 'v0.6.16', draft: true, assets: [asset(71, 'SwiftPOS-0.6.16-x64.exe')] }]; fresh();
    const r = await till(A, '/v/0.6.16/latest.yml');
    assert.equal(r.status, 404); assert.match(r.body.error, /missing latest\.yml/);
  });
  await ok('GitHub cached: many till checks, one GitHub call', async () => {
    gh.releases = [fullRelease(1, '0.6.16')]; fresh(); gh.calls = [];
    for (let i = 0; i < 5; i++) await till(A, '/v/0.6.16/latest.yml');
    assert.equal(gh.calls.filter((c) => c.url.includes('/releases?')).length, 1);
  });

  // ── 3. The admin portal's routes ──
  gh.releases = [fullRelease(1, '0.6.16'), { id: 8, tag_name: 'v0.6.18', draft: true, assets: [asset(81, 'SwiftPOS-0.6.18-x64.exe')] }]; fresh();
  await ok('the admin list: every version, draft or not, with what is missing', async () => {
    const r = await admin('GET', '/desktop-releases?fresh=1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((x) => [x.version, x.complete, x.draft, x.copies]), [['0.6.18', false, true, 1], ['0.6.16', true, false, 1]]);
  });
  await ok('approve 0.6.16 for the other client → saved, audited', async () => {
    const r = await admin('PATCH', `/clients/${B}/desktop-version`, { version: '0.6.16' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db.businesses[1].desktop_approved_version, '0.6.16');
    const log = db.admin_audit_log.at(-1);
    assert.equal(log.action, 'desktop_update.approve'); assert.equal(log.business_id, B);
  });
  await ok('approving an incomplete release is refused', async () => {
    const r = await admin('PATCH', `/clients/${B}/desktop-version`, { version: '0.6.18' });
    assert.equal(r.status, 400); assert.match(r.body.error, /missing/);
    assert.equal(db.businesses[1].desktop_approved_version, '0.6.16');
  });
  await ok('a version with no release, or a malformed one, is refused', async () => {
    assert.equal((await admin('PATCH', `/clients/${B}/desktop-version`, { version: '0.9.0' })).status, 400);
    assert.equal((await admin('PATCH', `/clients/${B}/desktop-version`, { version: 'latest' })).status, 400);
  });
  await ok('Hold (null) → held again, audited as a hold', async () => {
    const r = await admin('PATCH', `/clients/${B}/desktop-version`, { version: null });
    assert.equal(r.status, 200);
    assert.equal(db.businesses[1].desktop_approved_version, null);
    assert.equal(db.admin_audit_log.at(-1).action, 'desktop_update.hold');
    assert.deepEqual((await till(B, '/status')).body, { approvedVersion: null, held: true });
  });
  await ok('a till token cannot use the admin routes', async () => {
    const r = await realFetch(`${base}/api/admin/clients/${B}/desktop-version`, { method: 'PATCH', headers: { Authorization: `Bearer ${tillToken(B)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '0.6.16' }) });
    assert.equal(r.status, 401);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
