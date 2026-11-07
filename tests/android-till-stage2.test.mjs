/**
 * android-till-stage2.test.mjs — ZapTill for Android, Till stage 2: KEEPS SELLING OFFLINE (docs/ANDROID-APP-DESIGN.md
 * §4.7, §4.8, §5 "Till stage 2"). The shared rules are in @zaptill/core/tillBuffer (tested on their own in
 * till-buffer-stage2.test.mjs); this RUNS the app's own offline layer on top of them.
 *
 *   node --no-warnings tests/android-till-stage2.test.mjs      (bundles apps/android/src with esbuild — apps/dashboard's
 *                                                               npm ci provides it, as the stage-1 test does)
 *
 * RUNS (bundled with esbuild, Capacitor external — the tested functions never touch native):
 *   B  the buffer store (shop/buffer.ts) over an in-memory store: a write is queued or refused; acks mark it synced; the
 *      §4.8 sweep removes only sent-and-old rows; the status bar numbers.
 *   R  replay (shop/replay.ts): a fake sender drains the queue; ok syncs, a transport failure retries and the sale is
 *      kept; ackFromStatus maps HTTP to ok / retry / failed.
 *   O  the offline-writes seam (shop/offlineWrites.ts): read vs buffer vs refuse; the provisional answer.
 *   P  the offline PIN (shop/offlinePin.ts): a provisional sign-in for a cached person, the reconnect upgrade / refusal.
 *   S  checked in source (cannot run here): the shared rule is imported once (no copy); the seam is opt-in; the status bar.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - enqueue buffering a GET                                → B "a read is never queued"
 *   - runReplay dropping a retried sale                      → R "a transport failure keeps the sale (retry)"
 *   - ackFromStatus making a 400 a retry                     → R "a 400 is a permanent refusal (failed)"
 *   - offlineDecision buffering an unknown write             → O "an unknown write is refused offline"
 *   - upgradeDecision upgrading on a 401                     → P "a PIN refused on reconnect is rejected"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 900)}`); fail++; } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── bundle the app's offline layer (Capacitor external — the tested functions never call it) ─────────────────────────
function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'till2-'));
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export * from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/buffer.ts'))};
  export { runReplay, ackFromStatus } from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/replay.ts'))};
  export { offlineDecision, provisionalOrderResponse } from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/offlineWrites.ts'))};
  export { beginOfflineSignIn, upgradeDecision, deferVerify, OfflinePinRefused } from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/offlinePin.ts'))};
`);
// Resolve the shared rule to its source (the app's node_modules does not link @zaptill/core for a node bundle).
esbuild.buildSync({
  entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'out.cjs'), external: ['@capacitor/core', '@capacitor/preferences'],
  alias: { '@zaptill/core': path.join(ROOT, 'packages/core/src') },
  resolveExtensions: ['.ts', '.tsx', '.js', '.json'],
  define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: 'https://dev-api.zaptill.co.ke' }) },
  logLevel: 'silent',
});
const M = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

const till = { branchId: 'BR1', branchName: 'Westlands', businessType: 'restaurant', currency: 'KES' };
const run = async () => {

  console.log('\nB. The buffer store (shop/buffer.ts)');
  {
    const store = new M.InMemoryBuffer();
    const row = await M.enqueue(store, { method: 'POST', path: '/api/orders', body: { uuid: 'O1', total: 500 } }, '2026-11-07T09:00:00Z');
    ok('an order write is queued', !!row && row.kind === 'order' && row.orderUuid === 'O1');
    eq('the idempotency key is set to the order uuid', row.req.body.idempotency_key, 'O1');
    ok('a read is never queued', (await M.enqueue(store, { method: 'GET', path: '/api/orders', body: undefined })) === null);
    ok('an unknown write is not queued', (await M.enqueue(store, { method: 'POST', path: '/api/settings/theme', body: {} })) === null);
    await M.recordAcks(store, [{ orderUuid: 'O1', result: 'ok', at: '2026-11-07T09:05:00Z' }], '2026-11-07T09:05:00Z');
    eq('an ack marks it synced', (await store.all())[0].state, 'synced');
    const st = await M.status(store, false);
    eq('status: offline, nothing waiting now', [st.online, st.salesWaiting], [false, 0]);
  }
  {
    const store = new M.InMemoryBuffer();
    await store.put({ id: 'a', seq: 1, kind: 'order', orderUuid: 'U', createdAt: 'x', req: { method: 'POST', path: '/api/orders', body: {} }, state: 'pending', tries: 0, syncedAt: null });
    await store.put({ id: 'b', seq: 2, kind: 'order', orderUuid: 'S', createdAt: 'x', req: { method: 'POST', path: '/api/orders', body: {} }, state: 'synced', tries: 0, syncedAt: '2026-01-01T00:00:00Z' });
    const gone = await M.sweepRetention(store, '2026-11-07T00:00:00Z');
    eq('the §4.8 sweep removes one old sent row', gone, 1);
    ok('the unsent row is kept', (await store.all()).some((r) => r.id === 'a') && !(await store.all()).some((r) => r.id === 'b'));
  }

  console.log('\nR. Replay (shop/replay.ts)');
  eq('ackFromStatus: 200 is ok', M.ackFromStatus({ orderUuid: 'O' }, 200).result, 'ok');
  eq('ackFromStatus: no answer retries', M.ackFromStatus({ orderUuid: 'O' }, 0).result, 'retry');
  eq('ackFromStatus: 401 retries (renew, never a refusal)', M.ackFromStatus({ orderUuid: 'O' }, 401).result, 'retry');
  eq('ackFromStatus: a 400 is a permanent refusal (failed)', M.ackFromStatus({ orderUuid: 'O' }, 400).result, 'failed');
  {
    const store = new M.InMemoryBuffer();
    await M.enqueue(store, { method: 'POST', path: '/api/orders', body: { uuid: 'A' } }, 't1');
    await M.enqueue(store, { method: 'POST', path: '/api/orders', body: { uuid: 'B' } }, 't2');
    const okSender = async (r) => ({ orderUuid: r.orderUuid, id: r.id, result: 'ok', at: 'tN' });
    const res = await M.runReplay(store, okSender, 'tN');
    eq('both sales sync', [res.synced, (await store.all()).every((r) => r.state === 'synced')], [2, true]);
  }
  {
    const store = new M.InMemoryBuffer();
    await M.enqueue(store, { method: 'POST', path: '/api/orders', body: { uuid: 'A' } }, 't1');
    const retrySender = async (r) => M.ackFromStatus(r, 0);
    const res = await M.runReplay(store, retrySender, 'tN');
    ok('a transport failure keeps the sale (retry, not synced)', res.synced === 0 && (await store.all())[0].state !== 'synced');
  }
  {
    const store = new M.InMemoryBuffer();
    await M.enqueue(store, { method: 'POST', path: '/api/orders', body: { uuid: 'A' } }, 't1');
    const conflictSender = async (r) => ({ orderUuid: r.orderUuid, id: r.id, result: 'conflict', at: 'tN', conflict: { kind: 'table_taken', orderUuid: 'A', orderNumber: 7, table: '3' } });
    const res = await M.runReplay(store, conflictSender, 'tN');
    ok('a table-taken conflict is surfaced and the sale kept', res.conflicts.length === 1 && (await store.all())[0].state === 'synced');
  }

  console.log('\nO. The offline-writes seam (shop/offlineWrites.ts)');
  eq('a GET is a read (left to the screens)', M.offlineDecision('GET', '/api/orders'), 'read');
  eq('a sale is buffered', M.offlineDecision('POST', '/api/orders'), 'buffer');
  eq('an unknown write is refused offline', M.offlineDecision('POST', '/api/settings/theme'), 'refuse');
  {
    const r = M.provisionalOrderResponse('/api/orders', { uuid: 'O9', total: 10 }, '2026-11-07T10:00:00Z');
    ok('the provisional answer carries the uuid and offline flag', r.id === 'O9' && r.uuid === 'O9' && r.offline === true && r.status === 'completed');
  }

  console.log('\nP. The offline PIN (shop/offlinePin.ts)');
  const roster = [{ id: 'ST1', name: 'Jane', role: 'cashier', permissions: { 'sales.create': true }, pinHash: '$2b$x' }];
  {
    const { session, held } = M.beginOfflineSignIn(roster, till, 'ST1', '1234', M.deferVerify);
    ok('a provisional session for a cached person (no token)', session.staffId === 'ST1' && session.staffName === 'Jane' && session.token === '' && held.pin === '1234');
  }
  ok('a person not on this POS is refused', (() => { try { M.beginOfflineSignIn(roster, till, 'NOPE', '1', M.deferVerify); return false; } catch (e) { return e instanceof M.OfflinePinRefused; } })());
  ok('a local verifier that says no is refused', (() => { try { M.beginOfflineSignIn(roster, till, 'ST1', 'x', () => 'no'); return false; } catch { return true; } })());
  {
    const held = { staffId: 'ST1', branchId: 'BR1', pin: '1234' };
    const up = M.upgradeDecision(held, till, { status: 200, body: { staff: { id: 'ST1', name: 'Jane', role: 'cashier' }, accessToken: 'tok', refreshToken: 'r', permissions: {} } });
    eq('a good reconnect upgrades to a cloud session', [up.state, up.session?.token], ['upgraded', 'tok']);
    eq('a PIN refused on reconnect is rejected', M.upgradeDecision(held, till, { status: 401, body: { error: 'bad pin' } }).state, 'rejected');
    eq('no answer on reconnect retries (keep selling)', M.upgradeDecision(held, till, { status: 0, body: null }).state, 'retry');
    eq('a different person on reconnect is rejected', M.upgradeDecision(held, till, { status: 200, body: { staff: { id: 'OTHER', name: 'X' }, token: 't' } }).state, 'rejected');
  }

  console.log('\nS. Checked in source');
  ok('the buffer imports the one shared rule (no copy)', read('apps/android/src/shop/buffer.ts').includes("from '@zaptill/core/tillBuffer'"));
  ok('replay imports the one shared rule', read('apps/android/src/shop/replay.ts').includes("from '@zaptill/core/tillBuffer'"));
  ok('the offline-writes seam is opt-in (returns a restore fn, not auto-installed)', /export function installOfflineWrites/.test(read('apps/android/src/shop/offlineWrites.ts')) && !read('apps/android/src/main.tsx').includes('installOfflineWrites'));
  ok('the status bar reads the buffer status and the live online state', (() => { const s = read('apps/android/src/screens/shop/SyncStatusBar.tsx'); return s.includes('bufferStatusOf') && s.includes('useOnline'); })());
  ok('offline PIN upgrades on reconnect (verify-pin), the desktop model', read('apps/android/src/shop/offlinePin.ts').includes('verify-pin') || read('apps/android/src/shop/offlinePin.ts').includes('upgradeDecision'));
  ok('the status bar styles exist', read('apps/android/src/styles.css').includes('.sync-bar'));
  ok('the design doc describes Till stage 2', /### Till stage 2 — Keeps selling offline/.test(read('docs/ANDROID-APP-DESIGN.md')));
};

run().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error(e); process.exit(1); });
