/**
 * a541-update-blockers.test.mjs — A541 (2026-10-21), the cloud and admin halves: why a till or a branch server has not
 * installed its downloaded update, on the admin portal's Desktop updates card.
 * Owner, 2026-10-20: "Something I have noticed since we added the autostart feature most apps are not updating, they are
 * stuck in the old version."
 *
 *   node tests/a541-update-blockers.test.mjs
 *
 *   - the cloud keeps the new report fields, checked and cut to size (apps/server/src/lib/updateState.ts); a report from
 *     an A534 till (none of them) is stored as before, with nulls / false;
 *   - the admin line (apps/admin/src/desktopVersions.ts tillUpdateLine / downloadedLine) for each blocker: no ZapTill
 *     Updater task (what to do — a server: the next Windows sign-in; a till: Quit and accept the prompt), another reason,
 *     a start-up install that did not take, the idle install's reason ("a till was trading"), waiting for the branch
 *     server's copy, "ready for n days"; an A534 report reads exactly as before.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-21):
 *   - cleanUpdateState keeping the blocker outside a download                → "the blocker only with a download" fails
 *   - downloadedLine without the task === false branch                       → "no updater task: what to do" fails
 *   - downloadedLine's server / till wording swapped                         → "a till: Quit and accept the prompt" fails
 *   - tillUpdateLine without the waiting_server branch                       → "waiting for the branch server's copy" fails
 */
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const U = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/updateState.ts')).href);
const V = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/desktopVersions.ts')).href);

console.log('\nA541 — why a downloaded update has not installed\n');

await ok('the cloud keeps the A541 fields, checked', () => {
  const c = U.cleanUpdateState({ running: '1.0.19', state: 'downloaded', version: '1.0.20', task: false,
    blocker: 'Windows asks for permission (UAC) before an install, and nobody is there to give it' + ' x'.repeat(200),
    server: true, waiting_server: true, downloaded_at: '2026-10-17T00:00:00Z', startup_failed: true });
  assert.equal(c.blocker.length, 160); assert.ok(c.blocker.startsWith('Windows asks'));
  assert.equal(c.server, true); assert.equal(c.waiting_server, false, 'not while downloaded');
  assert.equal(c.downloaded_at, '2026-10-17T00:00:00.000Z'); assert.equal(c.startup_failed, true);
});
await ok('the blocker only with a download; waiting_server only without one; odd values dropped', () => {
  const i = U.cleanUpdateState({ state: 'idle', blocker: 'x', waiting_server: true, downloaded_at: '2026-10-17T00:00:00Z', server: 'yes', startup_failed: 1 });
  assert.equal(i.blocker, null); assert.equal(i.waiting_server, true); assert.equal(i.downloaded_at, null);
  assert.equal(i.server, false); assert.equal(i.startup_failed, false);
});
await ok('an A534 report (none of the fields): stored as before, nulls and false', () => {
  const c = U.cleanUpdateState({ running: '1.0.20', state: 'downloaded', version: '1.0.21', idle_note: 'waiting', task: true });
  assert.deepEqual([c.blocker, c.server, c.waiting_server, c.downloaded_at, c.startup_failed], [null, false, false, null, false]);
});

const NOW = Date.parse('2026-10-21T12:00:00Z');
const fresh = { lastSyncAt: '2026-10-21T11:55:00Z', appVersion: '1.0.20', updateStateAt: '2026-10-21T11:58:00Z' };
const line = (s, approved = '1.0.21') => V.tillUpdateLine({ ...fresh, updateState: { running: '1.0.20', state: 'downloaded', version: '1.0.21', ...s } }, approved, NOW).text;

await ok('no updater task: what to do — a server installs at the next Windows sign-in', () => {
  assert.equal(line({ blocker: 'Windows asks for permission (UAC) before an install, and nobody is there to give it', task: false, server: true }),
    "Downloaded 1.0.21 — can't install silently on this PC (no ZapTill Updater task): run the installer once as administrator, or it installs at the next Windows sign-in");
});
await ok('a till: it installs the next time ZapTill is opened (A546)', () => {
  assert.equal(line({ blocker: 'x', task: false, server: false }),
    "Downloaded 1.0.21 — can't install silently on this PC (no ZapTill Updater task): run the installer once as administrator, or it installs the next time ZapTill is opened (Windows will ask)");
});
await ok('another blocker (the task refused it): said as it is', () => {
  assert.equal(line({ blocker: 'the updater task refused it (offline)', task: true }), "Downloaded 1.0.21 — can't install by itself: the updater task refused it (offline)");
});
await ok('a start-up install that did not take', () => {
  assert.equal(line({ startup_failed: true, task: true }), 'Downloaded 1.0.21 — the install at Windows sign-in did not take; it installs when ZapTill is closed');
});
await ok('the idle install\'s reason ("a till was trading"), and "ready for n days" after 3 days', () => {
  const note = 'waiting: in use 3 min ago (a till was trading) — installs after 20 min idle';
  assert.equal(line({ idle_note: note, downloaded_at: '2026-10-21T08:00:00Z' }), `Downloaded 1.0.21 — ${note}`);
  assert.equal(line({ idle_note: note, downloaded_at: '2026-10-17T08:00:00Z' }), `Downloaded 1.0.21 — ${note} · ready for 4 days`);
});
await ok('waiting for the branch server\'s copy', () => {
  assert.match(V.tillUpdateLine({ ...fresh, updateState: { running: '1.0.20', state: 'idle', approved: '1.0.21', waiting_server: true } }, '1.0.21', NOW).text,
    /^Waiting for the branch server's copy of 1\.0\.21 — the server fetches it first/);
});
await ok('an A534 report reads exactly as before', () => {
  const at = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  assert.equal(line({ since: '2026-10-21T10:02:00Z' }), `Downloaded — installs when ZapTill is next closed (waiting since ${at('2026-10-21T10:02:00Z')})`);
  assert.equal(line({ idle_note: 'in use' }), 'Downloaded — installs when ZapTill is next closed · in use');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
