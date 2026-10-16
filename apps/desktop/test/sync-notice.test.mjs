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
 * MUTATIONS TO CONFIRM BITE: backOffice (lib/access.ts, A490) true for a cashier → "never a cashier" fails; syncNotice putting pending before
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
// A490: who sees it is lib/access.ts backOffice — it imports shared/permissions (extensionless), so it is bundled with
// esbuild (as theme-vars.test.mjs) and the bundle imported.
const { createRequire } = await import('node:module');
const accessOut = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'zaptill-access-')), 'access.mjs');
createRequire(import.meta.url)('esbuild').buildSync({ entryPoints: [path.join(DESKTOP, 'src/renderer/lib/access.ts')], bundle: true,
  format: 'esm', outfile: accessOut, logLevel: 'silent' });
const A = await import(pathToFileURL(accessOut).href);
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

// A490: by PERMISSIONS (backOffice: anything beyond the shop floor, or the owner's role) — a role's name decides nothing.
ok('who sees sync: the owner and anyone beyond the shop floor — never a cashier', () => {
  assert.equal(A.backOffice({ permissions: { '*': true } }), true);
  assert.equal(A.backOffice({ role: 'Owner', permissions: {} }), true, 'the owner\'s role');
  assert.equal(A.backOffice({ role: 'Manager', permissions: { 'orders.create': true, 'reports.view': true } }), true);
  assert.equal(A.backOffice({ role: 'Manager', permissions: { 'orders.create': true } }), false, 'a name alone is not a manager');
  assert.equal(A.backOffice({ role: 'Branch Supervisor', permissions: {} }), false);
  assert.equal(A.backOffice({ role: 'Cashier', permissions: { 'orders.void': true } }), true, 'a role granted reversals is a manager in practice');
  assert.equal(A.backOffice({ role: 'Cashier', permissions: { 'orders.create': true } }), false);
  assert.equal(A.backOffice({ role: 'Cashier', permissions: { 'orders.create': true, 'staff.view': true, 'sales.history_all': true, 'catalogue.v2': true } }), false,
    'what every role keeps after migration 134 is not back office');
  assert.equal(A.backOffice({ role: 'Waiter', permissions: {} }), false);
  assert.equal(A.backOffice(null), false);
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
ok('A448: the branch server refusing this till’s access code comes first — red, what to do', () => {
  const n = N.syncNotice({ online: true, pendingCount: 3, failedCount: 1, parkedCount: 1, lastSyncedAt: null,
    nodeRefused: { status: 401, since: '2026-10-12T07:00:00Z' } }, NOW);
  assert.equal(n.tone, 'alert');
  assert.match(n.text, /^The branch server refused this till's access code — sales are kept on this till/);
  assert.match(n.text, /Branch access code/);
  assert.equal(N.syncNotice({ online: true, pendingCount: 0, failedCount: 0, nodeRefused: null }, NOW), null);
});
// A501: the refusal is named by its reason — a device-key, branch or encryption refusal is not an access-code problem.
ok('A501: the refusal names its reason (device key, branch, encryption) — never "access code" for those', () => {
  const t = (reason) => N.syncNotice({ online: true, pendingCount: 0, failedCount: 0, nodeRefused: { status: 401, since: '2026-10-12T07:00:00Z', reason } }, NOW).text;
  assert.match(t('device_key'), /does not recognise this till \(its device key\)/);
  assert.doesNotMatch(t('device_key'), /access code/);
  assert.match(t('branch'), /another branch/);
  assert.doesNotMatch(t('branch'), /access code/);
  assert.match(t('tls'), /unencrypted connection/);
  assert.match(t('access_code'), /access code/);
  assert.match(t(undefined), /access code/);   // an older main process sends no reason
});
ok('A501: the branch-server backlog reaches the manager — refused records red; long waits quiet; short waits nothing', () => {
  const base = { online: true, pendingCount: 0, failedCount: 0, lastSyncedAt: null };
  const red = N.syncNotice({ ...base, nodeBacklog: { pending: 0, failed: 2, failedReason: 'bad row' } }, NOW);
  assert.equal(red.tone, 'alert');
  assert.match(red.text, /The branch server refused 2 records: bad row/);
  const old = new Date(NOW.getTime() - 30 * 60_000).toISOString();
  const quiet = N.syncNotice({ ...base, nodeBacklog: { pending: 4, failed: 0, oldestPendingAt: old } }, NOW);
  assert.equal(quiet.tone, 'quiet');
  assert.match(quiet.text, /4 records waiting for the branch server/);
  const fresh = new Date(NOW.getTime() - 20_000).toISOString();
  assert.equal(N.syncNotice({ ...base, nodeBacklog: { pending: 4, failed: 0, oldestPendingAt: fresh } }, NOW), null);
  // A cloud backlog keeps its own line first, with the branch server's appended.
  assert.match(N.syncNotice({ ...base, pendingCount: 1, nodeBacklog: { pending: 4, failed: 0, oldestPendingAt: old } }, NOW).text, /1 record waiting to sync · 4 waiting for the branch server/);
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
  assert.match(read('src/renderer/App.tsx'), /canSeeSync=\{backOffice\(staff\)\}/);
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
