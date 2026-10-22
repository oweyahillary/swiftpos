/**
 * installer-download-a570.test.mjs — A570: download the ZapTill installer from the admin portal, through our server.
 *
 * Owner, 2026-10-22: "yes this is something i have wanted since in future we will get a vps which will hold our apps and
 * move away from github and make the repo private".
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/installer-download-a570.test.mjs
 *
 * RUNS the COMPILED router (routes/adminInstaller.js, the real admin middleware) over HTTP on the in-memory database
 * (tests/lib-memdb.mjs), with GitHub and the future download server replaced by a stubbed fetch:
 *   1 the source: DESKTOP_DOWNLOAD_BASE_URL wins; GitHub needs GITHUB_RELEASES_TOKEN; neither → a clear 503
 *   2 admin only (no token, a shop's token, a bad link → 401); an agent gets the latest or the client's approved version,
 *     any other is a super admin's; one-use download links
 *   3 the download: streamed (the first bytes reach the admin while the source is still sending — never buffered whole),
 *     the right headers, GitHub asked with the token and Accept: application/octet-stream and the signed link WITHOUT it,
 *     the token never in an answer; audited (who, which version, when); 404 for an unknown version
 *   4 the details: size, SHA-256 (GitHub's digest), SHA-512 (latest.yml, as hex); the portal's offer order
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A570 report):
 *   - installerSource checking GitHub before the VPS URL                             → 1 "the VPS URL wins" fails
 *   - installerSource accepting GitHub with no token                                 → 1 "neither" fails
 *   - githubAsset without the Authorization header                                   → 3 "GitHub with the token" fails
 *   - the ticket check without the used-ticket memory                                → 2 "one use" fails
 *   - mayDownload letting an agent have any version                                  → 2 "an agent" fails
 *   - the download without auditDownload                                             → 3 "audited" fails
 *   - the download reading the whole body (arrayBuffer) before sending              → 3 "streamed" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/adminInstaller.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const S = require(path.join(DIST, 'lib/installerSource.js'));
const DR = require(path.join(DIST, 'lib/desktopReleases.js'));
const O = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/installerOffer.ts')).href);

const SUPER = 'aaaaaaaa-0000-4000-8000-0000000000a1', AGENT = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const B = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'ghp_TEST_ONLY_not_a_real_token';
const reset = () => {
  mem.fail = () => null;
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: [{ id: B, name: 'Pollo', desktop_approved_version: '1.0.18' }],
    admin_audit_log: [],
  };
  adminAuth.forgetAdmin(); DR.clearReleaseCache();
  delete process.env.DESKTOP_DOWNLOAD_BASE_URL; delete process.env.DESKTOP_RELEASES_REPO;
  process.env.GITHUB_RELEASES_TOKEN = TOKEN;
  calls.length = 0; gate = null;
};

// ── The installer's bytes: 6 MB, made lazily in 64 KB chunks (a stream, as a real download) ─────────────────────────────
const CHUNK = 64 * 1024, CHUNKS = 96, SIZE = CHUNK * CHUNKS;
const chunkAt = (i) => Buffer.alloc(CHUNK, i % 251);
const EXPECT_SHA256 = (() => { const h = createHash('sha256'); for (let i = 0; i < CHUNKS; i++) h.update(chunkAt(i)); return h.digest('hex'); })();
const EXPECT_SHA512 = (() => { const h = createHash('sha512'); for (let i = 0; i < CHUNKS; i++) h.update(chunkAt(i)); return h.digest(); })();
let gate = null;   // when set: the source stops after its FIRST chunk until gate.open() — a buffering server never answers
const sourceStream = () => {
  let i = 0;
  return new ReadableStream({
    async pull(ctl) {
      if (i === 1 && gate) await gate.promise;
      if (i >= CHUNKS) { ctl.close(); return; }
      ctl.enqueue(new Uint8Array(chunkAt(i++)));
    },
  });
};
const LATEST_YML = `version: 1.0.20\nfiles:\n  - url: ZapTill-1.0.20.exe\n    sha512: ${EXPECT_SHA512.toString('base64')}\n    size: ${SIZE}\npath: ZapTill-1.0.20.exe\nsha512: ${EXPECT_SHA512.toString('base64')}\nreleaseDate: '2026-10-22T08:00:00.000Z'\n`;
const API = 'https://api.github.com/repos/oweyahillary/swiftpos';
const asset = (id, name, extra = {}) => ({ id, name, url: `${API}/releases/assets/${id}`, browser_download_url: `https://github.com/x/${name}`, size: name.endsWith('.exe') ? SIZE : 300, ...extra });
const RELEASES = [
  { id: 20, tag_name: 'v1.0.20', draft: false, prerelease: true, assets: [asset(201, 'ZapTill-1.0.20.exe', { digest: `sha256:${EXPECT_SHA256}` }), asset(202, 'latest.yml'), asset(203, 'ZapTill-1.0.20.exe.blockmap')] },
  { id: 19, tag_name: 'v1.0.19', draft: false, prerelease: true, assets: [asset(191, 'ZapTill-1.0.19.exe'), asset(192, 'latest.yml')] },
  { id: 18, tag_name: 'v1.0.18', draft: false, prerelease: true, assets: [asset(181, 'ZapTill-1.0.18.exe'), asset(182, 'latest.yml')] },
  { id: 21, tag_name: 'v1.0.21', draft: true, prerelease: true, assets: [asset(211, 'ZapTill-1.0.21.exe'), asset(212, 'latest.yml')] },
];

// ── fetch: the test's own calls go to the app; everything else is GitHub or the download server, stubbed ──────────────────
const calls = [];
const realFetch = globalThis.fetch;
let base = '';
const hdr = (init, k) => { const h = new Headers(init?.headers ?? {}); return h.get(k); };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (base && u.startsWith(base)) return realFetch(url, init);
  calls.push({ url: u, auth: hdr(init, 'authorization'), accept: hdr(init, 'accept'), method: init?.method ?? 'GET', redirect: init?.redirect });
  if (u === `${API}/releases?per_page=50`) return new Response(JSON.stringify(RELEASES), { status: 200, headers: { 'content-type': 'application/json' } });
  const m = /\/releases\/assets\/(\d+)$/.exec(u);
  if (m) return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.test/signed/${m[1]}?X-Amz-Signature=abc` } });
  const s = /signed\/(\d+)\?/.exec(u);
  if (s) {
    if (['202', '192', '182'].includes(s[1])) return new Response(LATEST_YML, { status: 200 });
    return new Response(sourceStream(), { status: 200, headers: { 'content-length': String(SIZE) } });
  }
  if (u === 'https://dl.zaptill.test/apps/ZapTill-1.0.20.exe') {
    return new Response(init?.method === 'HEAD' ? null : sourceStream(), { status: 200, headers: { 'content-length': String(SIZE) } });
  }
  if (u === 'https://dl.zaptill.test/apps/latest-1.0.20.yml') return new Response(LATEST_YML, { status: 200 });
  if (u.startsWith('https://dl.zaptill.test/')) return new Response('Not Found', { status: 404 });
  return new Response('unexpected', { status: 599 });
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin/desktop', require(path.join(DIST, 'routes/adminInstaller.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
base = `http://127.0.0.1:${server.address().port}`;
const tok = (id, role, email) => jwt.sign({ adminId: id, email, role }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const SUPER_T = tok(SUPER, 'super_admin', 'boss@zaptill.test'), AGENT_T = tok(AGENT, 'agent', 'agent@zaptill.test');
const SHOP_T = jwt.sign({ userId: 'u', businessId: B, isOwner: true, sessionId: 's' }, process.env.JWT_SECRET);
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* bytes */ }
  return { status: r.status, body: json, text, headers: r.headers };
};
/** Download fully; the bytes' SHA-256 and length. */
const download = async (p, token) => {
  const r = await fetch(`${base}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (r.status !== 200) return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  const h = createHash('sha256'); let n = 0;
  for await (const c of r.body) { h.update(c); n += c.length; }
  return { status: 200, sha: h.digest('hex'), length: n, headers: r.headers };
};
const audits = () => mem.db.admin_audit_log.filter((a) => a.action === 'desktop.installer.download');

try {
  console.log('\n1. The source\n');
  await ok('DESKTOP_DOWNLOAD_BASE_URL wins over GitHub; GitHub needs its token; neither is none', () => {
    assert.deepEqual(S.installerSource({ DESKTOP_DOWNLOAD_BASE_URL: 'https://dl.zaptill.test/apps/', GITHUB_RELEASES_TOKEN: 't' }), { kind: 'vps', base: 'https://dl.zaptill.test/apps' });
    assert.deepEqual(S.installerSource({ GITHUB_RELEASES_TOKEN: 't' }), { kind: 'github', repo: 'oweyahillary/swiftpos', token: 't' });
    assert.deepEqual(S.installerSource({ GITHUB_RELEASES_TOKEN: 't', DESKTOP_RELEASES_REPO: 'zaptill/desktop' }).repo, 'zaptill/desktop');
    assert.deepEqual(S.installerSource({}), { kind: 'none' });
    assert.deepEqual(S.installerSource({ DESKTOP_DOWNLOAD_BASE_URL: 'ftp://nope' }), { kind: 'none' }, 'not http(s): ignored');
    assert.equal(S.vpsInstallerUrl('https://dl.zaptill.test/apps', '1.0.20'), 'https://dl.zaptill.test/apps/ZapTill-1.0.20.exe');
  });
  await ok('the VPS URL wins: the file comes from {base}/ZapTill-{version}.exe, GitHub is not asked', async () => {
    reset(); process.env.DESKTOP_DOWNLOAD_BASE_URL = 'https://dl.zaptill.test/apps';
    const r = await download('/api/admin/desktop/installer/1.0.20', SUPER_T);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.sha, EXPECT_SHA256); assert.equal(r.length, SIZE);
    assert.ok(calls.some((c) => c.url === 'https://dl.zaptill.test/apps/ZapTill-1.0.20.exe'));
    assert.ok(!calls.some((c) => c.url.includes('github')), 'GitHub never asked');
    assert.equal(audits()[0].after_data.source, 'vps');
  });
  await ok('neither configured: a clear 503 naming both settings', async () => {
    reset(); delete process.env.GITHUB_RELEASES_TOKEN;
    const r = await call('GET', '/api/admin/desktop/installer/1.0.20', SUPER_T);
    assert.equal(r.status, 503); assert.equal(r.body.code, 'INSTALLER_SOURCE_NOT_CONFIGURED');
    assert.match(r.body.error, /DESKTOP_DOWNLOAD_BASE_URL/); assert.match(r.body.error, /GITHUB_RELEASES_TOKEN/);
    const offer = await call('GET', '/api/admin/desktop/installer', SUPER_T);
    assert.equal(offer.body.source, null); assert.match(offer.body.problem, /not set up/);
    assert.equal(audits().length, 0, 'nothing downloaded, nothing audited');
  });

  console.log('\n2. Who may download\n');
  await ok('admin only: no token, a shop\'s token, a bad link → 401', async () => {
    reset();
    assert.equal((await call('GET', '/api/admin/desktop/installer/1.0.20')).status, 401);
    assert.equal((await call('GET', '/api/admin/desktop/installer/1.0.20', SHOP_T)).status, 401);
    assert.equal((await call('GET', '/api/admin/desktop/installer', SHOP_T)).status, 401);
    assert.equal((await call('GET', '/api/admin/desktop/installer/1.0.20?ticket=nonsense')).status, 401);
    assert.equal(audits().length, 0);
  });
  await ok('an agent: the latest and the client\'s approved version — any other is a super admin\'s', async () => {
    reset();
    const offer = await call('GET', `/api/admin/desktop/installer?client=${B}`, AGENT_T);
    assert.equal(offer.status, 200); assert.equal(offer.body.latest, '1.0.20', 'the newest complete, non-draft release');
    assert.equal(offer.body.approved, '1.0.18'); assert.deepEqual(offer.body.versions, [], 'no picker for an agent');
    assert.equal((await download('/api/admin/desktop/installer/1.0.20', AGENT_T)).status, 200);
    assert.equal((await download(`/api/admin/desktop/installer/1.0.18?client=${B}`, AGENT_T)).status, 200);
    const other = await call('GET', '/api/admin/desktop/installer/1.0.19', AGENT_T);
    assert.equal(other.status, 403); assert.equal(other.body.code, 'SUPER_ADMIN_REQUIRED');
    assert.equal((await call('POST', '/api/admin/desktop/installer/1.0.19/ticket', AGENT_T, {})).status, 403);
    const sup = await call('GET', `/api/admin/desktop/installer?client=${B}`, SUPER_T);
    assert.deepEqual(sup.body.versions, ['1.0.20', '1.0.19', '1.0.18'], 'the picker: complete, not drafts, newest first');
    assert.equal((await download('/api/admin/desktop/installer/1.0.19', SUPER_T)).status, 200);
  });
  await ok('a one-use link: the browser downloads without the admin\'s token; used twice or for another version → 401', async () => {
    reset();
    const t = await call('POST', '/api/admin/desktop/installer/1.0.20/ticket', SUPER_T, { client: B });
    assert.equal(t.status, 200, JSON.stringify(t.body)); assert.match(t.body.url, /^\/api\/admin\/desktop\/installer\/1\.0\.20\?ticket=/);
    const first = await download(t.body.url);
    assert.equal(first.status, 200); assert.equal(first.sha, EXPECT_SHA256);
    assert.equal(audits()[0].admin_email, 'boss@zaptill.test'); assert.equal(audits()[0].business_id, B); assert.equal(audits()[0].after_data.via, 'link');
    const again = await download(t.body.url);
    assert.equal(again.status, 401); assert.equal(again.body.code, 'TICKET_USED');
    const t2 = await call('POST', '/api/admin/desktop/installer/1.0.20/ticket', SUPER_T, {});
    const swapped = t2.body.url.replace('/1.0.20?', '/1.0.19?');
    assert.equal((await download(swapped)).status, 401);
  });

  console.log('\n3. The download\n');
  await ok('streamed: the first bytes reach the admin while the source is still sending (never buffered whole)', async () => {
    reset();
    let open; gate = { promise: new Promise((r) => { open = r; }) };
    const r = await Promise.race([
      fetch(`${base}/api/admin/desktop/installer/1.0.20`, { headers: { authorization: `Bearer ${SUPER_T}` } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('no answer while the source held its second chunk — the body was buffered')), 4000)),
    ]);
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const firstRead = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('no bytes before the source finished')), 4000))]);
    assert.ok(firstRead.value?.length > 0, 'bytes arrived');
    open();
    let n = firstRead.value.length;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
    assert.equal(n, SIZE);
  });
  await ok('the headers: attachment with the file name, the length, no caching', async () => {
    reset();
    const r = await download('/api/admin/desktop/installer/1.0.20', SUPER_T);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="ZapTill-1.0.20.exe"');
    assert.equal(r.headers.get('content-length'), String(SIZE));
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
  await ok('GitHub with the token: the asset asked with Authorization and Accept: application/octet-stream; the signed link without it', async () => {
    reset();
    assert.equal((await download('/api/admin/desktop/installer/1.0.20', SUPER_T)).status, 200);
    const list = calls.find((c) => c.url.endsWith('/releases?per_page=50'));
    assert.equal(list.auth, `Bearer ${TOKEN}`, 'the release list is read with the token (a private repository)');
    const a = calls.find((c) => c.url === `${API}/releases/assets/201`);
    assert.ok(a, 'the installer asked by its API url (works for a private repository)');
    assert.equal(a.auth, `Bearer ${TOKEN}`); assert.equal(a.accept, 'application/octet-stream'); assert.equal(a.redirect, 'manual');
    const signed = calls.find((c) => c.url.includes('/signed/201'));
    assert.equal(signed.auth, null, 'the token never goes to the signed link\'s host');
  });
  await ok('the token is never in an answer to the browser', async () => {
    reset();
    for (const p of ['/api/admin/desktop/installer', '/api/admin/desktop/installer/1.0.20/info']) {
      const r = await call('GET', p, SUPER_T);
      assert.equal(r.status, 200); assert.ok(!r.text.includes(TOKEN));
      for (const [, v] of r.headers) assert.ok(!v.includes(TOKEN));
    }
    const t = await call('POST', '/api/admin/desktop/installer/1.0.20/ticket', SUPER_T, {});
    assert.ok(!t.text.includes(TOKEN));
  });
  await ok('audited: who downloaded which version, from where, when', async () => {
    reset();
    const before = new Date().toISOString();
    await download('/api/admin/desktop/installer/1.0.20', SUPER_T);
    const a = audits();
    assert.equal(a.length, 1);
    assert.equal(a[0].admin_id, SUPER); assert.equal(a[0].admin_email, 'boss@zaptill.test');
    assert.deepEqual({ ...a[0].after_data }, { version: '1.0.20', file: 'ZapTill-1.0.20.exe', source: 'github', size: SIZE, via: 'token' });
    assert.ok(!a[0].created_at || a[0].created_at >= before);
  });
  await ok('an unknown version is a 404 (GitHub and the download server); a draft is never offered; not a version → 400', async () => {
    reset();
    const r = await call('GET', '/api/admin/desktop/installer/9.9.9', SUPER_T);
    assert.equal(r.status, 404); assert.equal(r.body.code, 'INSTALLER_NOT_FOUND');
    assert.equal((await call('GET', '/api/admin/desktop/installer/1.0.21', SUPER_T)).status, 404, 'a draft');
    assert.equal((await call('GET', '/api/admin/desktop/installer/latest', SUPER_T)).status, 400);
    process.env.DESKTOP_DOWNLOAD_BASE_URL = 'https://dl.zaptill.test/apps';
    assert.equal((await call('GET', '/api/admin/desktop/installer/9.9.9', SUPER_T)).status, 404);
    assert.equal(audits().length, 0);
  });

  console.log('\n4. The details beside the button\n');
  await ok('GitHub: the size, SHA-256 from GitHub\'s digest, SHA-512 from latest.yml (hex)', async () => {
    reset();
    const r = await call('GET', '/api/admin/desktop/installer/1.0.20/info', SUPER_T);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { version: '1.0.20', fileName: 'ZapTill-1.0.20.exe', source: 'github', size: SIZE, sha256: EXPECT_SHA256, sha512: EXPECT_SHA512.toString('hex') });
    const old = await call('GET', '/api/admin/desktop/installer/1.0.19/info', SUPER_T);
    assert.equal(old.body.sha256, null, 'no digest recorded: none shown');
  });
  await ok('the download server: size from the file, SHA-512 from latest-{version}.yml', async () => {
    reset(); process.env.DESKTOP_DOWNLOAD_BASE_URL = 'https://dl.zaptill.test/apps';
    const r = await call('GET', '/api/admin/desktop/installer/1.0.20/info', SUPER_T);
    assert.deepEqual(r.body, { version: '1.0.20', fileName: 'ZapTill-1.0.20.exe', source: 'vps', size: SIZE, sha256: null, sha512: EXPECT_SHA512.toString('hex') });
  });
  await ok('latest.yml parsing, and the portal\'s offer: the approved version first, then the latest', () => {
    assert.equal(S.parseLatestYml(LATEST_YML, 'ZapTill-1.0.20.exe').size, SIZE);
    assert.equal(S.parseLatestYml('version: 1.0.1\n').sha512Hex, null);
    assert.deepEqual(O.offeredVersions({ approved: '1.0.18', latest: '1.0.20' }).map((x) => x.version), ['1.0.18', '1.0.20']);
    assert.deepEqual(O.offeredVersions({ approved: '1.0.20', latest: '1.0.20' }), [{ version: '1.0.20', label: 'Approved for this client (latest)' }]);
    assert.deepEqual(O.offeredVersions({ approved: null, latest: '1.0.20' }), [{ version: '1.0.20', label: 'Latest release' }]);
  });
} finally {
  server.close();
  globalThis.fetch = realFetch;
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
