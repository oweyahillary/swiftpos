/**
 * desktop-installer-32bit.test.mjs — 0.6.32: ONE Windows installer for 64-bit and 32-bit tills.
 *
 * Owner, 2026-10-02: a client's till is Windows 10 32-bit (4 GB) — "use combined installer". The build settings, the
 * release workflow and the cloud's update feed must agree on the installer: SwiftPOS-<version>.exe carrying both.
 *
 * MUTATIONS TO CONFIRM BITE: drop ia32 from the target → "both 64-bit and 32-bit" fails; the release run builds without
 * --ia32 → its pin fails; the release check still looks for -x64.exe → its pin fails; the cloud requires "-x64" in the
 * installer name → "the update feed serves the combined installer" fails; drop the tag/version check, the draft re-publish
 * or the draft check from release.yml → "a wrong tag or a draft release stops the run" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

delete process.env.SWIFTPOS_ENV;
const cfg = require(path.join(ROOT, 'apps/desktop/electron-builder.config.js'));

ok('the Windows installer carries both 64-bit and 32-bit (one NSIS target)', () => {
  assert.deepStrictEqual(cfg.win.target, [{ target: 'nsis', arch: ['x64', 'ia32'] }]);
});
ok('its name is fixed and carries no arch: ZapTill-<version>.exe', () => {
  assert.strictEqual(cfg.nsis.artifactName, '${productName}-${version}.${ext}');
  assert.strictEqual(cfg.productName, 'ZapTill');   // 0.6.36 (A386)
});
ok('the release run builds both and checks for that exact file', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /npx electron-builder --win nsis --x64 --ia32 --config electron-builder\.config\.js --publish always/);
  assert.match(wf, /for f in latest\.yml "ZapTill-\$V\.exe"; do/);   // 0.6.36 (A386): ZapTill-<version>.exe
  assert.ok(!/SwiftPOS-\$V-x64\.exe/.test(wf), 'the release check still expects the 64-bit-only name');
});
// 2026-10-02: v0.6.32 was tagged on main's A376 merge (0.6.31) three times, then uploaded into a DRAFT release.
ok('a wrong tag or a draft release stops the run (version checked first; a draft re-published, then refused)', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /PKG=\$\(node -p "require\('\.\/apps\/desktop\/package\.json'\)\.version"\)\n\s*if \[ "\$PKG" != "\$V" \]; then/);
  assert.ok(wf.indexOf('Check the tag matches the desktop version') < wf.indexOf('Install desktop deps'), 'the tag check must run before the build');
  assert.match(wf, /--json isDraft --jq \.isDraft\)" = "true" \]; then\n\s*gh release edit "\$TAG" --repo "\$GITHUB_REPOSITORY" --draft=false --prerelease/);
  assert.match(wf, /\[ "\$DRAFT" = "false" \] \|\| \{ echo "::error::\$TAG is a DRAFT/);
});
ok('a local installer build makes the same combined installer', () => {
  assert.match(JSON.parse(read('apps/desktop/package.json')).scripts['pack:installer'], /--win nsis --x64 --ia32/);
});

const DIST = path.join(ROOT, 'apps/server/dist/lib/desktopReleases.js');
if (fs.existsSync(DIST)) {
  process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
  process.env.JWT_SECRET ??= randomBytes(24).toString('hex');
  const L = require(DIST);
  const asset = (id, name) => ({ id, name, url: `https://api.github.com/x/${id}`, browser_download_url: `https://github.com/x/${name}` });
  ok('the update feed serves the combined installer (a release with it is complete; the till may fetch it)', () => {
    assert.deepStrictEqual(L.missingFiles([asset(1, 'latest.yml'), asset(2, 'SwiftPOS-0.6.32.exe')]), []);
    const rel = { version: '0.6.32', assets: [asset(1, 'latest.yml'), asset(2, 'SwiftPOS-0.6.32.exe'), asset(3, 'SwiftPOS-0.6.32.exe.blockmap')] };
    assert.strictEqual(L.assetFor(rel, 'SwiftPOS-0.6.32.exe')?.id, 2);
    assert.strictEqual(L.assetFor(rel, 'SwiftPOS-0.6.32.exe.blockmap')?.id, 3);
  });
} else {
  console.log('SKIP  update feed (apps/server/dist not built)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
