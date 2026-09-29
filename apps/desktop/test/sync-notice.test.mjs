/**
 * sync-notice.test.mjs — A363 (desktop 0.6.20): sync status for managers only; a notice at the bottom; "Last synced";
 * the Z-report note.
 *
 * Owner, 2026-09-29: "we lock it under the manager? they can get a small notification at the bottom with a resync
 * option" · on a till offline for long "that message will be confusing" · "add the note on the zreport".
 *
 *   node test/sync-notice.test.mjs
 *
 * RUNS the real src/renderer/lib/syncNotice.ts (type-stripped), then pins the screens that use it (React is not run).
 *
 * MUTATIONS TO CONFIRM BITE: maySeeSync true for a cashier → "never a cashier" fails; syncNotice putting pending before
 * refusals → "refusals first" fails; the POS header status not gated on canSeeSync → its pin fails; the Z-report view
 * without zBackupNote → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.SYNC_NOTICE_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, SYNC_NOTICE_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = await import(pathToFileURL(path.join(DESKTOP, 'src/renderer/lib/syncNotice.ts')).href);
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

ok('who sees sync: owner, manager, supervisor — never a cashier', () => {
  assert.equal(N.maySeeSync({ permissions: { '*': true } }), true);
  assert.equal(N.maySeeSync({ role: 'Manager', permissions: { 'orders.create': true } }), true);
  assert.equal(N.maySeeSync({ role: 'Branch Supervisor', permissions: {} }), true);
  assert.equal(N.maySeeSync({ role: 'Cashier', permissions: { 'orders.void': true } }), true, 'a role granted reversals is a manager in practice');
  assert.equal(N.maySeeSync({ role: 'Cashier', permissions: { 'orders.create': true } }), false);
  assert.equal(N.maySeeSync({ role: 'Waiter', permissions: {} }), false);
  assert.equal(N.maySeeSync(null), false);
});

const NOW = new Date(2026, 8, 29, 11, 28);
ok('"Last synced": today / yesterday / a date / never — local time', () => {
  assert.equal(N.lastSyncedLabel(new Date(2026, 8, 29, 10, 15).toISOString(), NOW), 'today 10:15');
  assert.equal(N.lastSyncedLabel(new Date(2026, 8, 28, 18, 2).toISOString(), NOW), 'yesterday 18:02');
  assert.equal(N.lastSyncedLabel(new Date(2026, 8, 25, 9, 5).toISOString(), NOW), '25 Sep 09:05');
  assert.equal(N.lastSyncedLabel(null, NOW), 'never');
  assert.equal(N.lastSyncedLabel('garbage', NOW), 'never');
});

const at = new Date(2026, 8, 29, 10, 15).toISOString();
ok('nothing waits → no notice at all (a quiet till is not nagged)', () => {
  assert.equal(N.syncNotice({ online: true, pendingCount: 0, failedCount: 0, parkedCount: 0, lastSyncedAt: at }, NOW), null);
  assert.equal(N.syncNotice({ online: false, pendingCount: 0, failedCount: 0, lastSyncedAt: null }, NOW), null, 'offline alone is not a notice');
});
ok('waiting → a quiet notice with the count, last synced and Sync now', () => {
  const n = N.syncNotice({ online: false, pendingCount: 4, failedCount: 0, lastSyncedAt: at }, NOW);
  assert.deepEqual(n, { tone: 'quiet', action: 'sync', text: '4 records waiting to sync (offline) · last synced today 10:15' });
});
ok('refusals first (red, the reason) — this morning\'s case; then failures (red, Retry)', () => {
  const s = { online: true, pendingCount: 2, failedCount: 1, failedReason: 'bad date', parkedCount: 2,
    parkedReason: 'This till already has an open trading day. It must be closed before this one can sync.', lastSyncedAt: null };
  const n = N.syncNotice(s, NOW);
  assert.equal(n.tone, 'alert'); assert.equal(n.action, 'sync');
  assert.equal(n.text, 'The cloud refused 2 records: This till already has an open trading day. It must be closed before this one can sync. · last synced never');
  const f = N.syncNotice({ ...s, parkedCount: 0 }, NOW);
  assert.deepEqual(f, { tone: 'alert', action: 'retry-failed', text: '1 sale failed to sync: bad date · last synced never' });
});
ok('the Z-report note: refused drawer, sales not up yet, or nothing', () => {
  assert.equal(N.zBackupNote({ sales: 0, drawerRefused: true }), 'NOT BACKED UP: the cloud refused this shift — a manager must check the sync notice.');
  assert.equal(N.zBackupNote({ sales: 2, drawerRefused: false }), 'NOT BACKED UP YET: 2 sales of this shift are only on this till until it syncs.');
  assert.equal(N.zBackupNote({ sales: 1, drawerRefused: false }), 'NOT BACKED UP YET: 1 sale of this shift is only on this till until it syncs.');
  assert.equal(N.zBackupNote({ sales: 0, drawerRefused: false }), null);
  assert.equal(N.zBackupNote(undefined), null);
});

const pos = read('src/renderer/pages/POSPage.tsx');
ok('POS: the header status is inside canSeeSync; the bottom notice only for managers', () => {
  const i = pos.indexOf('{canSeeSync && (<>');
  assert.ok(i > 0, 'the gate');
  const j = pos.indexOf('{/* Sync indicator */}');
  const k = pos.indexOf('</>)}', i);
  assert.ok(j > i && j < k, 'the sync indicator sits inside the gate');
  assert.ok(pos.indexOf('⟳ {syncStatus.failedCount} failed') < k, 'the failed/retry button too');
  assert.match(pos, /const notice = canSeeSync \? syncNotice\(syncStatus\) : null;/);
  assert.match(pos, /\{notice && \(\s*<div\s+data-testid="sync-notice"/);
  assert.match(pos, /if \(notice\.action === 'retry-failed'\) await posApi\.sync\.retryFailed\(\);\s+else await posApi\.sync\.trigger\(\);/);
  assert.match(read('src/renderer/App.tsx'), /canSeeSync=\{maySeeSync\(staff as any\)\}/);
});
ok('manager screen: a neutral "Last synced" line', () => {
  const mp = read('src/renderer/pages/ManagerPage.tsx');
  assert.match(mp, /data-testid="last-synced" className="text-\[11px\] text-gray-400">Last synced: \{lastSyncedLabel\(lastSynced\)\}/);
});
ok('Z-report: on screen and on paper, the same words', () => {
  assert.match(read('src/renderer/components/ZReportView.tsx'), /\{zBackupNote\(report\.notBackedUp\) && \(/);
  assert.match(read('src/renderer/lib/printShiftReport.ts'), /backupNote: zBackupNote\(report\.notBackedUp\),/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
