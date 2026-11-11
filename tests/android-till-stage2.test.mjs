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
 *   C  the offline read cache (shop/offlineReads.ts): cold start — a catalogue GET is cached online and served offline.
 *   P  the offline PIN (shop/offlinePin.ts, shop/pinVerify.ts): a provisional sign-in for a cached person, the LOCAL bcrypt
 *      check (a wrong PIN refused at the till), the reconnect upgrade / refusal.
 *   S  checked in source (cannot run here): the shared rule is imported once (no copy); the seam is opt-in; the status bar.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - enqueue buffering a GET                                → B "a read is never queued"
 *   - runReplay dropping a retried sale                      → R "a transport failure keeps the sale (retry)"
 *   - ackFromStatus making a 400 a retry                     → R "a 400 is a permanent refusal (failed)"
 *   - offlineDecision buffering an unknown write             → O "an unknown write is refused offline"
 *   - the seam not caching a read online                     → C "online: the catalogue read is cached as it passes through"
 *   - the seam reaching the cloud for a cached read offline  → C "offline: the catalogue is served from cache with NO cloud call"
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
  export { offlineDecision, provisionalOrderResponse, installOfflineWrites } from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/offlineWrites.ts'))};
  export { isCacheableRead, readCacheKey, cachedResponse } from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/offlineReads.ts'))};
  export { beginOfflineSignIn, upgradeDecision, deferVerify, OfflinePinRefused, rosterFromWire, OFFLINE_PENDING } from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/offlinePin.ts'))};
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
  eq('a table move is buffered (restaurant, offline)', M.offlineDecision('POST', '/api/orders/abc/move-table'), 'buffer');
  eq('firing a course is buffered (restaurant, offline)', M.offlineDecision('POST', '/api/orders/abc/fire-course'), 'buffer');
  eq('an unknown write is refused offline', M.offlineDecision('POST', '/api/settings/theme'), 'refuse');
  {
    const r = M.provisionalOrderResponse('/api/orders', { uuid: 'O9', order_number: 'ORD-9', total: 10 }, '2026-11-07T10:00:00Z');
    ok('the provisional answer carries the uuid and offline flag', r.id === 'O9' && r.uuid === 'O9' && r.offline === true && r.status === 'completed');
    // The web POS (PaymentModal) reads camelCase { orderId, orderNumber }; without them the receipt shows a blank number.
    eq('the provisional answer gives the orderId + orderNumber the web POS reads', [r.orderId, r.orderNumber], ['O9', 'ORD-9']);
    eq('the provisional answer carries the ring-up time (created_at)', r.created_at, '2026-11-07T10:00:00Z');
  }
  {
    // The seam end-to-end: offline, a sale POST is buffered (created_at stamped into the queued body for replay pricing)
    // and answered provisionally with NO cloud call; online, a call passes straight through.
    const store = new M.InMemoryBuffer();
    const realFetch = globalThis.fetch;
    let passedThrough = 0;
    const fakeCloud = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (...a) => { passedThrough++; return fakeCloud(...a); };
    let offline = true;
    const restore = M.installOfflineWrites({ store, isOffline: () => offline, cloudBase: 'https://dev-api.zaptill.co.ke', now: () => '2026-11-07T11:00:00Z' });
    const res = await globalThis.fetch('https://dev-api.zaptill.co.ke/api/orders', { method: 'POST', body: JSON.stringify({ uuid: 'Z1', order_number: 'ORD-Z1', total: 50 }) });
    const ans = await res.json();
    ok('offline: a sale is answered provisionally with no cloud call', res.status === 200 && ans.orderId === 'Z1' && ans.offline === true && passedThrough === 0);
    eq('offline: the queued body carries created_at for replay pricing', (await store.all())[0].req.body.created_at, '2026-11-07T11:00:00Z');
    offline = false;
    await globalThis.fetch('https://dev-api.zaptill.co.ke/api/pos/init', { method: 'GET' });
    ok('online: a call passes straight through to the cloud', passedThrough === 1);
    restore();
    globalThis.fetch = realFetch;
  }

  console.log('\nC. The offline read cache — cold start (shop/offlineReads.ts)');
  eq('pos/init is a cacheable catalogue read', M.isCacheableRead('/api/pos/init?branch_id=BR1'), true);
  eq('tables (parking bays) is cacheable', M.isCacheableRead('/api/tables?branch_id=BR1&slot_type=parking_bay'), true);
  eq('a sale is NOT a cacheable read', M.isCacheableRead('/api/orders'), false);
  eq('an unrelated GET is NOT cached', M.isCacheableRead('/api/settings/theme'), false);
  eq('the cache key keeps the query (dining vs parking never collide)', M.readCacheKey('/api/tables?branch_id=BR1&slot_type=parking_bay'), '/api/tables?branch_id=BR1&slot_type=parking_bay');
  {
    // The read half of the seam end-to-end: online, a catalogue GET passes through AND is cached; offline, the same GET is
    // answered from the cache (so usePOSData opens the real catalogue); an uncached read offline falls through to the screen.
    const mem = new Map();
    const reads = {
      get: async (k) => mem.get(k) ?? null,
      put: async (k, status, body, at) => { mem.set(k, { status, body, at }); },
    };
    const realFetch = globalThis.fetch;
    let cloudCalls = 0;
    globalThis.fetch = async () => { cloudCalls++; return new Response(JSON.stringify({ products: [{ id: 'P1' }], businessType: 'restaurant' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const store = new M.InMemoryBuffer();
    let offline = false;
    const restore = M.installOfflineWrites({ store, isOffline: () => offline, cloudBase: 'https://dev-api.zaptill.co.ke', reads, now: () => '2026-11-10T12:00:00Z' });

    const liveRes = await globalThis.fetch('https://dev-api.zaptill.co.ke/api/pos/init?branch_id=BR1', { method: 'GET' });
    const live = await liveRes.json();
    ok('online: the catalogue read reaches the cloud and is answered', cloudCalls === 1 && live.products[0].id === 'P1');
    ok('online: the catalogue read is cached as it passes through', mem.has('/api/pos/init?branch_id=BR1'));

    offline = true;
    const cachedRes = await globalThis.fetch('https://dev-api.zaptill.co.ke/api/pos/init?branch_id=BR1', { method: 'GET' });
    const cached = await cachedRes.json();
    ok('offline: the catalogue is served from cache with NO cloud call', cloudCalls === 1 && cached.products[0].id === 'P1' && cachedRes.headers.get('x-zaptill-offline-cache') === '2026-11-10T12:00:00Z');

    const missRes = await globalThis.fetch('https://dev-api.zaptill.co.ke/api/tables?branch_id=BR1', { method: 'GET' });
    ok('offline: an uncached catalogue read falls through to the screen (its own error)', cloudCalls === 2 && missRes.status === 200);

    restore();
    globalThis.fetch = realFetch;
  }

  console.log('\nP. The offline PIN (shop/offlinePin.ts)');
  {
    // rosterFromWire: the cloud's branch-staff rows → the cached roster, keeping only a usable (id + name) row.
    const wire = [
      { staff_id: 'ST1', name: 'Jane', role_name: 'cashier', permissions: { 'sales.create': true }, pin_hash: '$2b$x' },
      { staff_id: '', name: 'No id', role_name: 'cashier', permissions: {}, pin_hash: '$2b$y' },
      { name: 'No staff_id' },
    ];
    const mapped = M.rosterFromWire(wire);
    eq('rosterFromWire keeps only the usable row (id + name)', mapped.length, 1);
    eq('rosterFromWire maps staff_id/role_name/pin_hash', [mapped[0].id, mapped[0].role, mapped[0].pinHash], ['ST1', 'cashier', '$2b$x']);
    eq('rosterFromWire on a non-array is empty', M.rosterFromWire(null), []);
  }
  const roster = [{ id: 'ST1', name: 'Jane', role: 'cashier', permissions: { 'sales.create': true }, pinHash: '$2b$x' }];
  {
    const { session, held } = M.beginOfflineSignIn(roster, till, 'ST1', '1234', M.deferVerify);
    ok('a provisional session for a cached person (no token)', session.staffId === 'ST1' && session.staffName === 'Jane' && session.token === '' && held.pin === '1234');
    eq('the provisional session carries the OFFLINE_PENDING chain id (only it takes the upgrade)', session.refreshToken, M.OFFLINE_PENDING);
  }
  ok('a person not on this POS is refused', (() => { try { M.beginOfflineSignIn(roster, till, 'NOPE', '1', M.deferVerify); return false; } catch (e) { return e instanceof M.OfflinePinRefused; } })());
  ok('a local verifier that says no is refused', (() => { try { M.beginOfflineSignIn(roster, till, 'ST1', 'x', () => 'no'); return false; } catch { return true; } })());
  {
    // The offline sign-in honours a LOCAL verifier so a wrong PIN is refused AT THE TILL, not only on reconnect. The real
    // verifier is shop/pinVerify.ts bcryptVerify (bcryptjs) — source-checked below and bundled into the APK by android.yml;
    // bcryptjs is not installed for this node suite, so the seam is proven here with a stand-in verifier.
    const who = [{ id: 'ST1', name: 'Jane', role: 'cashier', permissions: {}, pinHash: '$2b$x' }];
    const verify = (_hash, pin) => (pin === '1234' ? 'ok' : 'no');
    ok('offline sign-in refuses a wrong PIN locally', (() => { try { M.beginOfflineSignIn(who, till, 'ST1', '9999', verify); return false; } catch (e) { return e instanceof M.OfflinePinRefused; } })());
    ok('offline sign-in accepts the right PIN', M.beginOfflineSignIn(who, till, 'ST1', '1234', verify).session.staffId === 'ST1');
  }
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
  ok('the offline-writes seam returns a restore fn and is wired in the Shop POS entry', /export function installOfflineWrites/.test(read('apps/android/src/shop/offlineWrites.ts')) && read('apps/android/src/screens/shop/ShopPos.tsx').includes('installOfflineWrites'));
  ok('the Shop POS drains the queue on reconnect (runReplay) and mounts the status bar', (() => { const s = read('apps/android/src/screens/shop/ShopPos.tsx'); return s.includes('runReplay') && s.includes('SyncStatusBar'); })());
  ok('offline: the old "can\'t sell" cover is gone — offline selling + offline PIN work, the SyncStatusBar shows the state', (() => { const s = read('apps/android/src/screens/shop/ShopPos.tsx'); return !s.includes('NoConnection') && s.includes('SyncStatusBar') && !fs.existsSync(path.join(ROOT, 'apps/android/src/screens/shop/NoConnection.tsx')); })());
  ok('the status bar reads the buffer status and the live online state', (() => { const s = read('apps/android/src/screens/shop/SyncStatusBar.tsx'); return s.includes('bufferStatusOf') && s.includes('useOnline'); })());
  ok('offline PIN upgrades on reconnect (verify-pin), the desktop model', read('apps/android/src/shop/offlinePin.ts').includes('verify-pin') || read('apps/android/src/shop/offlinePin.ts').includes('upgradeDecision'));
  // Cold start — the sign-in half (Part B): the roster is pulled while online, the PIN pad signs in offline from the
  // cache, the held PIN lives in the Keystore, and a reconnect upgrades it (or signs the person out).
  ok('the roster is pulled from branch-staff and cached (shop/roster.ts)', (() => { const s = read('apps/android/src/shop/roster.ts'); return s.includes('/pos/branch-staff') && s.includes('cacheRoster'); })());
  ok('the PIN screen signs in offline from the cached roster', (() => { const s = read('apps/android/src/screens/shop/PinScreen.tsx'); return s.includes('beginOfflineSignIn') && s.includes('readRoster') && s.includes('holdPin'); })());
  ok('the offline PIN is checked locally with bcrypt (shop/pinVerify.ts), not only on reconnect', (() => { const v = read('apps/android/src/shop/pinVerify.ts'); const p = read('apps/android/src/screens/shop/PinScreen.tsx'); return v.includes("from 'bcryptjs'") && v.includes('compareSync') && p.includes('bcryptVerify'); })());
  ok('the held PIN lives in the Keystore (secrets pos.heldPin) and is cleared on a fresh PIN screen', read('apps/android/src/device/secrets.ts').includes('pos.heldPin') && read('apps/android/src/screens/shop/PinScreen.tsx').includes('clearHeldPin'));
  ok('the Shop POS refreshes the roster and upgrades a held PIN when online (shop/offlineUpgrade.ts)', (() => { const s = read('apps/android/src/screens/shop/ShopPos.tsx'); return s.includes('refreshRoster') && s.includes('attemptUpgrade') && s.includes('swiftpos:pos-token'); })());
  ok('the status bar styles exist', read('apps/android/src/styles.css').includes('.sync-bar'));
  ok('the design doc describes Till stage 2', /### Till stage 2 — Keeps selling offline/.test(read('docs/ANDROID-APP-DESIGN.md')));
};

run().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error(e); process.exit(1); });
