/**
 * desktop-releases-stale.test.mjs — A356 (2026-09-28): the admin portal's desktop version list when GitHub refuses,
 * and the list kept short.
 *
 * On 2026-09-28 the portal showed "Could not list releases: … GitHub releases: HTTP 403" — anonymous calls from
 * Render's shared addresses had used GitHub's 60-an-hour allowance, and nothing said the fix was
 * GITHUB_RELEASES_TOKEN. The picker also listed every build back to 0.5.48.
 *
 *   node tests/desktop-releases-stale.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED apps/server/dist/lib/desktopReleases.js against a fake GitHub (fetch stubbed), and the real
 * apps/admin/src/desktopVersions.ts (type-stripped).
 *
 * MUTATIONS TO CONFIRM BITE: listDesktopReleasesOrStale rethrowing instead of serving the cache → "a refusal after a
 * good read" fails; the rate-limit branch dropped → "names the fix" fails; visibleVersions ignoring `approved` →
 * "the approved version is kept" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.RELEASES_STALE_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, RELEASES_STALE_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist/lib/desktopReleases.js');
if (!fs.existsSync(DIST)) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
const require = createRequire(DIST);
const R = require(DIST);
const V = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/desktopVersions.ts')).href);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const asset = (name, id) => ({ id, name, url: `https://api.github.com/assets/${id}`, browser_download_url: `https://x/${name}` });
const good = [
  { id: 2, tag_name: 'v0.6.17', draft: false, prerelease: true, assets: [asset('latest.yml', 21), asset('SwiftPOS-0.6.17-x64.exe', 22)] },
  { id: 1, tag_name: 'v0.6.16', draft: false, prerelease: false, assets: [asset('latest.yml', 11), asset('SwiftPOS-0.6.16-x64.exe', 12)] },
];
let answer = () => new Response(JSON.stringify(good), { status: 200 });
globalThis.fetch = async () => answer();
const rateLimited = () => new Response(JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.' }),
  { status: 403, headers: { 'x-ratelimit-remaining': '0' } });

await ok('describeGitHubFailure: a rate limit names the fix (GITHUB_RELEASES_TOKEN); other refusals say what they are', () => {
  assert.match(R.describeGitHubFailure(403, '0', 'API rate limit exceeded', false), /rate limit reached — set GITHUB_RELEASES_TOKEN/);
  assert.match(R.describeGitHubFailure(429, null, '', false), /GITHUB_RELEASES_TOKEN/);
  assert.match(R.describeGitHubFailure(403, '0', '', true), /even with GITHUB_RELEASES_TOKEN — try again/);
  assert.match(R.describeGitHubFailure(401, null, 'Bad credentials', true), /expired or revoked/);
  assert.match(R.describeGitHubFailure(404, null, 'Not Found', true), /DESKTOP_RELEASES_REPO/);
  assert.equal(R.describeGitHubFailure(500, null, '', false), 'GitHub releases: HTTP 500');
});

await ok('never a good read + GitHub refuses → the error, in words (no bare "HTTP 403")', async () => {
  R.clearReleaseCache();
  answer = rateLimited;
  await assert.rejects(() => R.listDesktopReleasesOrStale({ fresh: true }), /rate limit reached — set GITHUB_RELEASES_TOKEN/);
});

await ok('a refusal after a good read → the last good list, with a warning saying so', async () => {
  R.clearReleaseCache();
  answer = () => new Response(JSON.stringify(good), { status: 200 });
  const first = await R.listDesktopReleasesOrStale({ fresh: true });
  assert.equal(first.warning, null);
  assert.deepEqual(first.releases.map((r) => r.version), ['0.6.17', '0.6.16']);
  answer = rateLimited;
  const again = await R.listDesktopReleasesOrStale({ fresh: true });
  assert.deepEqual(again.releases.map((r) => r.version), ['0.6.17', '0.6.16']);
  assert.match(again.warning, /rate limit reached[\s\S]*Showing the list read 1 minute ago\./);
});

await ok('the routes use it: admin list (?meta=1 → { releases, warning }, else a bare array), approve, the tills\' feed', () => {
  const admin = read('apps/server/src/routes/admin.ts');
  assert.match(admin, /const \{ releases, warning \} = await listDesktopReleasesOrStale\(\{ fresh: req\.query\.fresh === '1' \}\);/);
  assert.match(admin, /res\.json\(req\.query\.meta === '1' \? \{ releases: list, warning \} : list\);/);
  assert.match(admin, /rel = \(await listDesktopReleasesOrStale\(\{ fresh: true \}\)\)\.releases\.find/);
  assert.match(read('apps/server/src/routes/desktopUpdate.ts'), /releases = \(await listDesktopReleasesOrStale\(\)\)\.releases;/);
});

const list = ['0.6.17', '0.6.16', '0.6.15', '0.6.14', '0.6.13', '0.6.12', '0.6.11', '0.5.48'].map((version) => ({ version }));
await ok('portal: the newest five by default; "show all" shows everything', () => {
  assert.deepEqual(V.visibleVersions(list, null, false).map((r) => r.version), ['0.6.17', '0.6.16', '0.6.15', '0.6.14', '0.6.13']);
  assert.equal(V.visibleVersions(list, null, true).length, 8);
  assert.equal(V.visibleVersions(list.slice(0, 3), null, false).length, 3);
});
await ok('portal: the version the client is approved for is kept even when older', () => {
  assert.deepEqual(V.visibleVersions(list, '0.6.11', false).map((r) => r.version).slice(-1), ['0.6.11']);
  assert.equal(V.visibleVersions(list, '0.6.16', false).length, 5, 'already in the newest five: not repeated');
});
await ok('portal: asks for ?meta=1, reads both answer shapes, shows the warning and the short list', () => {
  const p = read('apps/admin/src/AdminPortal.tsx');
  assert.match(p, /req\("GET", "\/desktop-releases\?meta=1"\)/);
  assert.match(p, /setDesktopReleases\(Array\.isArray\(r\) \? r : Array\.isArray\(r\?\.releases\) \? r\.releases : \[\]\);/);
  assert.match(p, /\{desktopWarning && <div/);   // A393: on the client's Desktop updates tab
  assert.match(p, /visibleVersions\(desktopReleases, detail\?\.desktop_approved_version, showAllVersions\)\.map/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
