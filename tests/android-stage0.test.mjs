/**
 * android-stage0.test.mjs — the ZapTill Android app, Stage 0 (docs/ANDROID-APP-DESIGN.md, "Stage 0 — built"): the
 * app's update feed approved per business and surface like the desktop (A348), the admin portal's approval and download
 * link, and crash reports into the admin portal's alerts.
 *
 *   node tests/android-stage0.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the shared rules (packages/core/src/androidApp.ts), the release rules (lib/androidReleases) and the COMPILED
 * routes — /api/app-update (the real auth middleware: a POS's own session, an owner's session, no session),
 * /api/admin/android (real requireAdmin / requireSuperAdmin) and /api/app-errors — over HTTP. The database is in memory;
 * GitHub's API is a fake answering the cloud's own fetch calls; JWT secrets are random per run.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - /status trusts ?surface= for a signed-in device (no surfaceOfSession)    → "the query cannot widen the surface" fails
 *   - /v/…/apk serves any version (no approvals[surface] !== want check)      → "a version not approved → 403" fails
 *   - a release without GitHub's digest counts as complete                     → "no SHA-256 → incomplete" fails
 *   - updateVerdict lets a Shop POS update with a shift open                   → "a Shop POS waits for the shift" fails
 *   - the admin PATCH without requireSuperAdmin                                 → "an agent cannot approve" fails
 *   - ErrorGate always notifies                                                 → "the same crash rings once" fails
 *   - cleanErrorReport without the redactor                                     → "a token in a report is removed" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/appUpdate.js'))) {
  console.log('\nCannot load apps/server/dist/routes/appUpdate.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.GITHUB_RELEASES_TOKEN;
delete process.env.DESKTOP_RELEASES_REPO;
delete process.env.ANDROID_RELEASES_REPO;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const R = require(path.join(DIST, 'lib/androidReleases.js'));
const E = require(path.join(DIST, 'lib/appErrors.js'));
const P = require(path.join(DIST, 'lib/adminAlertPolicy.js'));
const C = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/androidApp.ts')).href);

// ── The database (in memory) ──
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const OWNER_B = '33333333-3333-4333-8333-333333333333';
const db = {
  businesses: [
    { id: A, name: 'B Foods', status: 'active', owner_id: null, android_till_approved_version: null, mobile_approved_version: null },
    { id: B, name: 'Other Client', status: 'active', owner_id: OWNER_B, android_till_approved_version: null, mobile_approved_version: null },
  ],
  admin_audit_log: [],
  admin_notifications: [],
  admin_users: [{ id: 'adm-1', email: 'ops@zaptill.test', role: 'super_admin', is_active: true },
                { id: 'adm-2', email: 'agent@zaptill.test', role: 'agent', is_active: true }],
  user_devices: [{ business_id: A, device_id: 'dev-A', status: 'approved', retired_at: null }],
};
let columnsMissing = false;   // migration 189 not run: the select of an approval column fails like Postgres' 42703
supabase.from = (table) => {
  const f = []; let patch = null; let inserting = null; let cols = '';
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, v]) => r[k] === v));
  const missing = () => columnsMissing && table === 'businesses' && /approved_version/.test(cols)
    ? { code: '42703', message: 'column businesses.android_till_approved_version does not exist' } : null;
  const q = {
    select(c) { cols = String(c ?? ''); return q; }, order() { return q; }, limit() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    update(p) { patch = p; return q; },
    insert(r) { inserting = r; (db[table] ??= []).push(...(Array.isArray(r) ? r : [r])); return q; },
    maybeSingle() { const m = missing(); return Promise.resolve(m ? { data: null, error: m } : { data: rows()[0] ?? null, error: null }); },
    single() {
      if (patch) rows().forEach((r) => Object.assign(r, patch));
      const r = rows()[0];
      return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none' } });
    },
    then(res, rej) { if (patch) rows().forEach((r) => Object.assign(r, patch)); return Promise.resolve({ data: inserting ?? rows(), error: null }).then(res, rej); },
  };
  return q;
};

// ── A fake GitHub (answers only the cloud's calls to api.github.com) ──
const realFetch = globalThis.fetch;
const gh = { releases: [], calls: [] };
const HASH = (c) => c.repeat(64);
const asset = (id, name, digest) => ({ id, name, size: 12_345_678, digest, url: `https://api.github.com/repos/oweyahillary/swiftpos/releases/assets/${id}`, browser_download_url: `https://github.com/x/${name}` });
const androidRelease = (id, v, { draft = false, digest = `sha256:${HASH('a')}`, apk = true } = {}) =>
  ({ id, tag_name: `android-v${v}`, draft, prerelease: true, published_at: '2026-11-04T10:00:00Z', assets: apk ? [asset(id * 10 + 1, `ZapTill-${v}.apk`, digest)] : [] });
const desktopRelease = (id, v) => ({ id, tag_name: `v${v}`, draft: false, assets: [asset(id * 10 + 1, 'latest.yml'), asset(id * 10 + 2, `ZapTill-${v}.exe`)] });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.github.com/')) return realFetch(url, init);
  gh.calls.push({ url: u, accept: init.headers?.Accept });
  if (u.includes('/releases?')) return new Response(JSON.stringify(gh.releases), { status: 200, headers: { 'content-type': 'application/json' } });
  const m = u.match(/\/releases\/assets\/(\d+)$/);
  if (m) return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/signed/${m[1]}?X-Amz-Signature=abc` } });
  return new Response('{}', { status: 404 });
};

// ── The app: the real routers behind the real middleware ──
const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/app-update', require(path.join(DIST, 'routes/appUpdate.js')).default);
app.use('/api/app-errors', require(path.join(DIST, 'routes/appErrors.js')).default);
app.use('/api/admin/android', require(path.join(DIST, 'routes/adminAndroid.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
// A415: a POS's own session (no person; the surface an Android Shop POS session will carry from Till stage 1). And the owner of B, signed in with the password (a person: the 'mobile' surface).
const tillToken = jwt.sign({ userId: null, deviceId: 'dev-A', till: true, businessId: A, branchId: null, isOwner: false, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'android-till' }, process.env.JWT_SECRET);
const ownerToken = jwt.sign({ userId: OWNER_B, businessId: B, isOwner: true, ownerLogin: true, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's2' }, process.env.JWT_SECRET);
const adminToken = (id, role, email) => jwt.sign({ adminId: id, email, role }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const SUPER = adminToken('adm-1', 'super_admin', 'ops@zaptill.test'), AGENT = adminToken('adm-2', 'agent', 'agent@zaptill.test');
const call = async (method, p, { token = null, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${base}/api${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), body: r.status === 302 ? null : await r.json().catch(() => null) };
};
const fresh = () => R.clearAndroidReleaseCache();

try {
  // ── 1. The shared rules (the app, the cloud and the portal use the same ones) ──
  await ok('tags: android-v<x.y.z> only — a desktop tag is never an Android release', () => {
    assert.equal(C.versionOfAndroidTag('android-v0.1.0'), '0.1.0');
    assert.equal(C.versionOfAndroidTag('v0.1.0'), null);
    assert.equal(C.versionOfAndroidTag('android-v0.1'), null);
    assert.equal(C.androidReleaseTag('1.2.3'), 'android-v1.2.3');
    assert.equal(C.apkFileName('1.2.3'), 'ZapTill-1.2.3.apk');
    assert.equal(C.compareAppVersions('0.1.10', '0.1.9'), 1);
  });
  await ok('a SHA-256 is 64 hex characters, from GitHub\'s "sha256:" digest or bare; anything else is none', () => {
    assert.equal(C.normaliseSha256(`sha256:${HASH('A')}`), HASH('a'));
    assert.equal(C.normaliseSha256(HASH('b')), HASH('b'));
    assert.equal(C.normaliseSha256('sha512:abc'), null);
    assert.equal(C.normaliseSha256(null), null);
  });
  const status = (over = {}) => ({ surface: 'android-till', signedIn: true, approvedVersion: '0.2.0', held: false, latestVersion: '0.2.0',
    offer: { version: '0.2.0', fileName: 'ZapTill-0.2.0.apk', sha256: HASH('c'), size: 1, downloadPath: '/app-update/android/v/0.2.0/apk' }, ...over });
  await ok('the updater\'s rule: held, current, not ready, ready', () => {
    assert.equal(C.updateVerdict({ current: '0.1.0', status: status({ approvedVersion: null, held: true }), shiftOpen: false }).kind, 'held');
    assert.equal(C.updateVerdict({ current: '0.2.0', status: status(), shiftOpen: false }).kind, 'current');
    assert.equal(C.updateVerdict({ current: '0.3.0', status: status(), shiftOpen: false }).kind, 'current', 'never "down" to the approved version');
    assert.equal(C.updateVerdict({ current: '0.1.0', status: status({ offer: null }), shiftOpen: false }).kind, 'not-ready');
    assert.equal(C.updateVerdict({ current: '0.1.0', status: status({ offer: { ...status().offer, sha256: 'nope' } }), shiftOpen: false }).kind, 'not-ready');
    assert.equal(C.updateVerdict({ current: '0.1.0', status: status(), shiftOpen: false }).kind, 'ready');
  });
  await ok('a Shop POS waits for the shift to close; an owner\'s phone updates whenever the owner taps Update', () => {
    assert.deepEqual(C.updateVerdict({ current: '0.1.0', status: status(), shiftOpen: true }), { kind: 'wait-for-shift', version: '0.2.0' });
    assert.equal(C.updateVerdict({ current: '0.1.0', status: status({ surface: 'mobile' }), shiftOpen: true }).kind, 'ready');
  });

  // ── 2. The releases ──
  await ok('releases: desktop tags ignored; newest first; complete = the APK and GitHub\'s SHA-256', () => {
    const list = R.summariseAndroidReleases([desktopRelease(1, '1.0.24'), androidRelease(2, '0.1.0'), androidRelease(3, '0.2.0')]);
    assert.deepEqual(list.map((r) => [r.version, r.complete]), [['0.2.0', true], ['0.1.0', true]]);
    assert.equal(list[0].sha256, HASH('a'));
  });
  await ok('no SHA-256 (GitHub recorded no digest) or no APK → incomplete, never approvable', () => {
    const [noHash] = R.summariseAndroidReleases([androidRelease(4, '0.3.0', { digest: null })]);
    assert.equal(noHash.complete, false); assert.match(noHash.missing.join(), /SHA-256/);
    const [noApk] = R.summariseAndroidReleases([androidRelease(5, '0.3.0', { apk: false })]);
    assert.equal(noApk.complete, false); assert.deepEqual(noApk.missing, ['ZapTill-0.3.0.apk']);
    assert.equal(R.approvableRelease([noHash], '0.3.0'), null);
  });
  await ok('two releases of one version: the published one wins over a draft; a draft alone is never approvable', () => {
    const [r] = R.summariseAndroidReleases([androidRelease(9, '0.4.0', { draft: true, digest: `sha256:${HASH('d')}` }), androidRelease(8, '0.4.0')]);
    assert.equal(r.draft, false); assert.equal(r.sha256, HASH('a'));
    const drafts = R.summariseAndroidReleases([androidRelease(9, '0.4.0', { draft: true })]);
    assert.equal(R.approvableRelease(drafts, '0.4.0'), null);
    assert.equal(R.latestAndroidVersion(drafts), null);
  });

  // ── 3. The app's feed ──
  gh.releases = [androidRelease(3, '0.2.0'), androidRelease(2, '0.1.0'), desktopRelease(1, '1.0.24')]; fresh();
  await ok('signed out: nothing approved, the newest release named, no offer; the surface is required', async () => {
    const s = await call('GET', '/app-update/android/status?surface=android-till');
    assert.equal(s.status, 200);
    assert.deepEqual({ ...s.body, warning: undefined }, { surface: 'android-till', signedIn: false, approvedVersion: null, held: true, latestVersion: '0.2.0', offer: null, warning: undefined });
    assert.equal((await call('GET', '/app-update/android/status')).status, 400);
    assert.equal((await call('GET', '/app-update/android/status?surface=desktop')).status, 400);
  });
  await ok('a bad token is refused (never treated as signed out)', async () => {
    assert.equal((await call('GET', '/app-update/android/status?surface=mobile', { token: 'not-a-token' })).status, 401);
  });
  await ok('a new business is HELD on both surfaces: no offer, no file', async () => {
    const s = await call('GET', '/app-update/android/status', { token: tillToken });
    assert.equal(s.body.surface, 'android-till'); assert.equal(s.body.held, true); assert.equal(s.body.offer, null);
    assert.equal((await call('GET', '/app-update/android/v/0.2.0/apk', { token: tillToken })).status, 403);
  });
  await ok('approved for the Shop POS → the offer carries the SHA-256 and the download path; the file redirects to GitHub', async () => {
    db.businesses[0].android_till_approved_version = '0.1.0';
    const s = await call('GET', '/app-update/android/status', { token: tillToken });
    assert.deepEqual(s.body.offer, { version: '0.1.0', fileName: 'ZapTill-0.1.0.apk', sha256: HASH('a'), size: 12_345_678, downloadPath: '/app-update/android/v/0.1.0/apk' });
    const r = await call('GET', '/app-update/android/v/0.1.0/apk', { token: tillToken });
    assert.equal(r.status, 302); assert.equal(r.location, 'https://objects.githubusercontent.com/signed/21?X-Amz-Signature=abc');
  });
  await ok('a version not approved → 403 (newer and older alike)', async () => {
    assert.equal((await call('GET', '/app-update/android/v/0.2.0/apk', { token: tillToken })).status, 403);
    assert.equal((await call('GET', '/app-update/android/v/0.0.9/apk', { token: tillToken })).status, 403);
  });
  await ok('the query cannot widen the surface: a person\'s session is the owner\'s phone (mobile), whatever it asks', async () => {
    db.businesses[1].android_till_approved_version = '0.2.0';   // B's tablets approved, B's phones held
    const s = await call('GET', '/app-update/android/status?surface=android-till', { token: ownerToken });
    assert.equal(s.body.surface, 'mobile'); assert.equal(s.body.approvedVersion, null); assert.equal(s.body.offer, null);
    assert.equal((await call('GET', '/app-update/android/v/0.2.0/apk', { token: ownerToken })).status, 403);
    db.businesses[1].mobile_approved_version = '0.2.0';
    assert.equal((await call('GET', '/app-update/android/status', { token: ownerToken })).body.approvedVersion, '0.2.0');
  });
  await ok('a stored value that is not x.y.z counts as HELD', async () => {
    db.businesses[0].android_till_approved_version = 'latest';
    assert.equal((await call('GET', '/app-update/android/status', { token: tillToken })).body.held, true);
    db.businesses[0].android_till_approved_version = '0.1.0';
  });
  await ok('before migration 189: held, with a warning naming it (never a 500)', async () => {
    columnsMissing = true;
    const s = await call('GET', '/app-update/android/status', { token: tillToken });
    columnsMissing = false;
    assert.equal(s.status, 200); assert.equal(s.body.held, true); assert.match(s.body.warning, /migration 189/);
  });

  // ── 4. The admin portal ──
  await ok('the releases with the client\'s approvals', async () => {
    const r = await call('GET', `/admin/android/releases?client=${A}`, { token: AGENT });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.releases.map((x) => x.version), ['0.2.0', '0.1.0']);
    assert.deepEqual(r.body.approvals, { 'android-till': '0.1.0', mobile: null });
    assert.equal(r.body.latest, '0.2.0');
    assert.equal((await call('GET', '/admin/android/releases')).status, 401);
  });
  await ok('an agent cannot approve; a super admin approves one surface, audited', async () => {
    assert.equal((await call('PATCH', `/admin/android/clients/${A}/version`, { token: AGENT, body: { surface: 'mobile', version: '0.2.0' } })).status, 403);
    const r = await call('PATCH', `/admin/android/clients/${A}/version`, { token: SUPER, body: { surface: 'mobile', version: '0.2.0' } });
    assert.equal(r.status, 200); assert.deepEqual(r.body.approvals, { 'android-till': '0.1.0', mobile: '0.2.0' });
    const a = db.admin_audit_log.at(-1);
    assert.equal(a.action, 'android_update.approve'); assert.deepEqual(a.after_data, { surface: 'mobile', version: '0.2.0' });
    assert.deepEqual(a.before_data, { surface: 'mobile', version: null });
  });
  await ok('hold (null) is audited as a hold; a bad surface, a bad version, an incomplete release are refused', async () => {
    const h = await call('PATCH', `/admin/android/clients/${A}/version`, { token: SUPER, body: { surface: 'mobile', version: null } });
    assert.equal(h.status, 200); assert.equal(db.admin_audit_log.at(-1).action, 'android_update.hold');
    assert.equal((await call('PATCH', `/admin/android/clients/${A}/version`, { token: SUPER, body: { surface: 'desktop', version: '0.2.0' } })).status, 400);
    assert.equal((await call('PATCH', `/admin/android/clients/${A}/version`, { token: SUPER, body: { surface: 'mobile', version: 'v0.2.0' } })).status, 400);
    assert.equal((await call('PATCH', `/admin/android/clients/${A}/version`, { token: SUPER, body: { surface: 'mobile' } })).status, 400, 'no version is not a hold');
    gh.releases = [androidRelease(6, '0.3.0', { digest: null }), ...gh.releases]; fresh();
    assert.equal((await call('PATCH', `/admin/android/clients/${A}/version`, { token: SUPER, body: { surface: 'mobile', version: '0.3.0' } })).status, 409);
    gh.releases = gh.releases.slice(1); fresh();
  });
  await ok('the download link: an agent gets the newest or the client\'s approved one; a super admin any; audited', async () => {
    const latest = await call('POST', '/admin/android/releases/0.2.0/link', { token: AGENT, body: {} });
    assert.equal(latest.status, 200); assert.equal(latest.body.sha256, HASH('a')); assert.match(latest.body.url, /signed\/31\?/);
    assert.equal(db.admin_audit_log.at(-1).action, 'android.apk.download');
    assert.equal((await call('POST', '/admin/android/releases/0.1.0/link', { token: AGENT, body: {} })).status, 403);
    assert.equal((await call('POST', '/admin/android/releases/0.1.0/link', { token: AGENT, body: { client: A } })).status, 200, 'approved for A');
    assert.equal(db.admin_audit_log.at(-1).business_id, A);
    assert.equal((await call('POST', '/admin/android/releases/0.1.0/link', { token: SUPER, body: {} })).status, 200);
    assert.equal((await call('POST', '/admin/android/releases/9.9.9/link', { token: SUPER, body: {} })).status, 404);
  });

  // ── 5. Crash and error reports → the admin portal's alerts ──
  const report = (over = {}) => ({ surface: 'android-till', kind: 'crash', appVersion: '0.1.0', message: 'java.lang.IllegalStateException: boom', stack: 'at com.zaptill.app.MainActivity.onCreate(MainActivity.java:12)', device: 'Android 14 (API 34), Samsung SM-T220', ...over });
  await ok('the category is one of the admin\'s alert categories (the bell; never an email per crash)', () => {
    const c = P.ALERT_CATEGORIES.find((x) => x.id === 'app_errors');
    assert.ok(c); assert.equal(c.group, 'client'); assert.equal(c.instantDefault, false);
  });
  await ok('a report signed out → 202, one bell row (no business), category app_errors', async () => {
    const before = db.admin_notifications.length;
    const r = await call('POST', '/app-errors', { body: report() });
    assert.equal(r.status, 202); assert.equal(r.body.notified, true);
    const n = db.admin_notifications.at(-1);
    assert.equal(db.admin_notifications.length, before + 1);
    assert.equal(n.category, 'app_errors'); assert.equal(n.business_id, null);
    assert.match(n.title, /ZapTill for Android 0\.1\.0 \(Shop POS\) crashed/); assert.match(n.detail, /Samsung SM-T220/);
  });
  await ok('the same crash from another device rings once in the window; another crash rings again', async () => {
    const before = db.admin_notifications.length;
    assert.equal((await call('POST', '/app-errors', { body: report({ device: 'Android 13, Tecno' }) })).body.notified, false);
    assert.equal(db.admin_notifications.length, before);
    assert.equal((await call('POST', '/app-errors', { body: report({ message: 'NullPointerException' }) })).body.notified, true);
    const g = new E.ErrorGate(1000);
    assert.equal(g.shouldNotify('x', 0), true); assert.equal(g.shouldNotify('x', 999), false); assert.equal(g.shouldNotify('x', 1000), true);
  });
  await ok('signed in: the bell row names the business', async () => {
    await call('POST', '/app-errors', { token: tillToken, body: report({ message: 'only from A' }) });
    assert.equal(db.admin_notifications.at(-1).business_id, A);
  });
  await ok('a token in a report is removed before it is kept; fields are trimmed', async () => {
    const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz012345';
    const clean = E.cleanErrorReport(report({ message: `refresh failed: Authorization: Bearer ${jwtLike}`, stack: 'x'.repeat(10_000) }));
    assert.ok(!clean.message.includes(jwtLike), clean.message);
    assert.ok(clean.stack.length <= C.APP_ERROR_LIMITS.stack);
  });
  await ok('not a report → 400 (a bad surface, kind or version, no message)', async () => {
    for (const bad of [report({ surface: 'desktop' }), report({ kind: 'oops' }), report({ appVersion: 'dev' }), report({ message: '   ' })]) {
      assert.equal((await call('POST', '/app-errors', { body: bad })).status, 400, JSON.stringify(bad).slice(0, 60));
    }
  });

  // ── 6. The admin portal's words (apps/admin/src/androidVersions.ts, bundled: CI installs no admin packages) ──
  const esbuild = require('esbuild');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-android-'));
  await esbuild.build({ entryPoints: [path.join(ROOT, 'apps/admin/src/androidVersions.ts')], bundle: true, format: 'cjs', platform: 'node',
    outfile: path.join(tmp, 'words.cjs'), logLevel: 'silent', nodePaths: [path.join(ROOT, 'apps/server/node_modules')] });
  const W = require(path.join(tmp, 'words.cjs'));
  fs.rmSync(tmp, { recursive: true, force: true });
  await ok('the card says held, approved, and when a newer release waits — in POS words', () => {
    assert.equal(W.surfaceLine('android-till', null, '0.2.0'), 'Shop POS: held — nothing approved; 0.2.0 is the newest release.');
    assert.equal(W.surfaceLine('mobile', null, null), 'Owner / manager phone: held — nothing approved, and no release yet.');
    assert.match(W.surfaceLine('android-till', '0.1.0', '0.2.0'), /approved 0\.1\.0\..* 0\.2\.0 is out — not approved yet\.$/);
    assert.ok(!/0\.1\.0 is out/.test(W.surfaceLine('mobile', '0.1.0', '0.1.0')));
    for (const s of ['android-till', 'mobile']) assert.ok(!/\btill\b/i.test(W.surfaceLine(s, '0.1.0', '0.2.0')));
  });
  await ok('the picker: an incomplete release says what it lacks; a draft is not approvable', () => {
    const rel = { version: '0.3.0', draft: false, prerelease: true, complete: false, missing: ['ZapTill-0.3.0.apk'], sha256: null, size: null, published_at: null };
    assert.equal(W.releaseOption(rel), '0.3.0 (pre-release) — missing ZapTill-0.3.0.apk');
    assert.equal(W.approvable(rel), false);
    assert.equal(W.approvable({ ...rel, complete: true, draft: true }), false);
    assert.equal(W.approvable({ ...rel, complete: true }), true);
  });

  // ── 7. The app's own words (apps/android/src/updates/words.ts — type imports only, run as it is) ──
  const AW = await import(pathToFileURL(path.join(ROOT, 'apps/android/src/updates/words.ts')).href);
  await ok('the app says what the cloud answered, in POS words — and a Shop POS never updates mid-service', () => {
    const signedOut = { surface: 'android-till', signedIn: false, approvedVersion: null, held: true, latestVersion: '0.2.0', offer: null };
    assert.match(AW.updateSummary({ kind: 'held' }, signedOut), /joined to your business \(newest release: 0\.2\.0\)/);
    assert.match(AW.updateSummary({ kind: 'held' }, { ...signedOut, signedIn: true }), /approves each update/);
    assert.match(AW.updateSummary({ kind: 'wait-for-shift', version: '0.2.0' }, signedOut), /after the shift is closed/);
    assert.equal(AW.updateSummary({ kind: 'ready', offer: status().offer }, signedOut), 'Version 0.2.0 is ready to install.');
    for (const v of [{ kind: 'held' }, { kind: 'current' }, { kind: 'not-ready', version: '1.0.0' }, { kind: 'wait-for-shift', version: '1.0.0' }]) {
      assert.ok(!/\btill\b/i.test(AW.updateSummary(v, signedOut)), v.kind);
    }
    assert.equal(AW.sizeLabel(12_345_678), '11.8 MB'); assert.equal(AW.sizeLabel(null), '');
  });
} finally {
  server.close();
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
