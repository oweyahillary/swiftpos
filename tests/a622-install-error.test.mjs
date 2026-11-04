/**
 * a622-install-error.test.mjs — A622, the cloud and admin halves: a till says why its last install did not take
 * ("installer exit 2"), and the admin portal's Desktop updates line shows it.
 *
 * Owner, 2026-11-04: TJS T1 showed "an earlier install of it while idle did not take" for 6 days — the installer's own
 * exit code was only in a file on that PC.
 *
 *   node tests/a622-install-error.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-11-04):
 *   - cleanUpdateState without install_error                         → "the cloud keeps install_error" fails
 *   - downloadedLine without the install_error branch                → "the admin line: the install failed" fails
 */
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const U = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/updateState.ts')).href);
const V = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/desktopVersions.ts')).href);

console.log('\nA622 — why the last install did not take\n');

await ok('the cloud keeps install_error, cut to size and one line', () => {
  const c = U.cleanUpdateState({ running: '1.0.20', state: 'downloaded', version: '1.0.23', install_error: '1.0.23: installer\nexit 2' + ' x'.repeat(200) });
  assert.ok(c.install_error.startsWith('1.0.23: installer exit 2'), c.install_error);
  assert.equal(c.install_error.length, 160);
});
await ok('an older till (no field): null', () => {
  assert.equal(U.cleanUpdateState({ running: '1.0.20', state: 'idle' }).install_error, null);
});
await ok('the admin line: the install failed, with the installer\'s reason, and that it tries again at each start', () => {
  const now = Date.parse('2026-11-04T09:00:00Z');
  const line = V.downloadedLine({ state: 'downloaded', install_error: '1.0.23: installer exit 2', blocker: 'an earlier install of it while idle did not take',
    downloaded_at: '2026-10-28T10:15:00Z', task: true }, '1.0.23', now);
  assert.equal(line, 'Downloaded 1.0.23 — the install failed (installer exit 2); it tries again each time ZapTill starts · ready for 6 days');
});
await ok('without it the line reads as before (the blocker)', () => {
  const line = V.downloadedLine({ state: 'downloaded', blocker: 'an earlier install of it while idle did not take', task: true }, '1.0.21', Date.now());
  assert.equal(line, 'Downloaded 1.0.21 — can\'t install by itself: an earlier install of it while idle did not take');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
