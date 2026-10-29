// A602 — going online later, the POS's side: new sales first (with what they need), the history as a bulk backfill in
// quiet hours (paused the moment a sale starts), at most 500 sales a call, marked synced exactly as the normal push marks
// a sale (so the normal push never sends it again), back as far as the owner chooses (older sales 'local_only', never
// "waiting"), an interrupted run resuming, and a 100,000-sale queue drained in about 200 calls.
//
// Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 6, final): "New sales go first. History goes up as a bulk
// backfill in quiet hours, back as far as the owner chooses. Interruptions are safe." The cloud's side:
// tests/history-backfill-a602.test.mjs.
//
// Drives the REAL compiled dist/main (localDb, syncEngine, historyUpload, cloudBackup, activityTracker) on a REAL SQLite
// file in a temp userData, electron shimmed, with a stand-in cloud; the manager's notice from src/renderer/lib/syncNotice.ts.
//
//   cd apps/desktop && npm run build:main && node test/history-upload-a602.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted — 2026-10-28):
//   syncEngine pushPendingOrders without the 48-hour cutoff (new first off)    → 16 fail ("the 5 new sales, newest first" …)
//   historyUploadRules splitRecentCash holding nothing back                     → 4 fail ("its drawer and day went first" …)
//   historyUploadRules quietVerdict ignoring a sale under way                   → fails ("a sale under way pauses it"; the run stops)
//   historyUpload startBacklog without applyHistoryWindow                       → 6 fail ("the default window" …)
//   historyUpload without markSynced for a stored sale                          → fails ("marked synced exactly as …"; the run stops)
//   historyUploadRules BATCH_MAX 5000                                           → fails ("the first call: 500 sales"; the run stops)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(dist, 'historyUpload.js'))) { console.error('dist/main not built. Run:  npm run build:main'); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a602-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.23', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true }, powerMonitor: { getSystemIdleTime: () => 0 } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const DC = require(path.join(dist, 'deviceConfig.js'));
const CB = require(path.join(dist, 'cloudBackup.js'));
const HU = require(path.join(dist, 'historyUpload.js'));
const AT = require(path.join(dist, 'activityTracker.js'));
const SN = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'syncNotice.ts')).href);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Fries', '2026-10-28T00:00:00Z')`).run();
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });

// ── the stand-in cloud ──────────────────────────────────────────────────────────────────────────────────────────────
let cloudBackup = { on: true, phase: 'none', cutoffAt: null };
const calls = [];            // "METHOD path"
const orderPosts = [];       // the order ids of each POST /api/orders, in order
const backfills = [];        // each backfill call: { orders: [ids], shifts: [ids], days: [ids], floats: [ids], gz: bool }
const syncPushes = [];       // each /api/sync/push body
const cloudHas = new Set();  // order ids stored on the cloud
let onBackfill = null;       // a hook: (n) => void | 'throw' | 'store-then-throw'
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const upserted = (b) => ({ shifts: (b.shifts ?? []).length, floats: (b.floats ?? []).length, expenses: (b.expenses ?? []).length, businessDays: (b.business_days ?? []).length, kitchenVoids: (b.kitchen_voids ?? []).length });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url).replace('http://cloud', ''); const method = String(init.method ?? 'GET').toUpperCase();
  calls.push(`${method} ${u}`);
  if (u.startsWith('/api/pos/init')) return json(200, { branchId: 'br-1', products: [], categories: [], paymentMethods: [], cloudBackup });
  if (method === 'GET') return json(200, []);
  if (u.endsWith('/api/orders')) {
    const id = new Headers(init.headers).get('x-idempotency-key'); orderPosts.push(id);
    const dup = cloudHas.has(id); cloudHas.add(id);
    return json(dup ? 200 : 201, dup ? { orderId: `c-${id}`, duplicate: true } : { orderId: `c-${id}` });
  }
  if (u.endsWith('/api/sync/push')) { const b = JSON.parse(String(init.body ?? '{}')); syncPushes.push(b); return json(200, { ok: true, upserted: upserted(b), rejected: [] }); }
  if (u.endsWith('/api/sync/backfill')) {
    const h = new Headers(init.headers);
    const gz = h.get('content-encoding') === 'gzip';
    const b = JSON.parse((gz ? zlib.gunzipSync(Buffer.from(init.body)) : Buffer.from(init.body)).toString('utf8'));
    backfills.push({ orders: b.orders.map((o) => o.id), shifts: (b.shifts ?? []).map((s) => s.id), days: (b.business_days ?? []).map((d) => d.id), floats: (b.floats ?? []).map((f) => f.id), gz });
    const hook = onBackfill ? onBackfill(backfills.length, b) : null;
    if (hook === 'throw') throw new TypeError('fetch failed');
    const results = b.orders.map((o) => {
      if (o.body?.shift_id === 'sh-missing') return { id: o.id, status: 'waiting', http: 424, code: 'shift_not_synced', error: 'This sale\'s drawer has not reached the cloud yet' };
      if (o.body?.refuse) return { id: o.id, status: 'refused', http: 400, error: 'Missing required fields: items' };
      const dup = cloudHas.has(o.id); cloudHas.add(o.id);
      return { id: o.id, status: dup ? 'duplicate' : 'accepted', http: dup ? 200 : 201, orderId: `c-${o.id}` };
    });
    if (hook === 'store-then-throw') throw new TypeError('fetch failed');   // the cloud stored them; the answer was lost
    return json(200, { ok: true, cash: { ok: true, upserted: upserted(b), rejected: [] }, results, counts: {} });
  }
  if (u.endsWith('/api/changes')) return json(200, { results: [] });
  return json(200, { ok: true });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');
HU._setHistorySeams({ sleep: async () => {} });

// ── the POS's own records ───────────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.now();
const isoAgo = (ms) => new Date(NOW - ms).toISOString();
const H = 3_600_000, DAY = 24 * H;
const insOrder = db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, sync_status, device_id, shift_id)
  VALUES (@id, 'biz-1', 'br-1', @id, 100, 0, 100, @at, 'pending', 'dev-T1', @shift)`);
const insQueue = db.prepare(`INSERT INTO sync_queue (order_id, payload, created_at, status) VALUES (@id, @payload, @at, 'pending')`);
const sell = (id, at, shift, extra = {}) => {
  insOrder.run({ id, at, shift });
  insQueue.run({ id, at, payload: JSON.stringify({ id, order_number: id, branch_id: 'br-1', shift_id: shift, created_at: at, items: [{}], payments: [{}], ...extra }) });
};
const sellMany = (n, firstAt, stepMs, shift, prefix) => db.transaction(() => { for (let i = 0; i < n; i++) sell(`${prefix}-${String(i).padStart(6, '0')}`, new Date(firstAt + i * stepMs).toISOString(), shift); })();
const drawer = (id, { openedAt, closedAt = null, day = null }) => db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, closed_at, status, created_at, device_id, sync_status, business_day_id)
  VALUES (?, 'biz-1', 'br-1', 'u-owner', ?, ?, ?, ?, 'dev-T1', 'pending', ?)`).run(id, openedAt, closedAt, closedAt ? 'closed' : 'open', openedAt, day);
const tradingDay = (id, date, { openedAt, closedAt = null }) => db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, business_date, opened_at, closed_at, status, created_at, sync_status)
  VALUES (?, 'biz-1', 'br-1', 'dev-T1', ?, ?, ?, ?, ?, 'pending')`).run(id, date, openedAt, closedAt, closedAt ? 'closed' : 'open', openedAt);
const float = (id, shift, at) => db.prepare(`INSERT INTO float_transactions (id, shift_id, branch_id, cashier_id, type, amount, created_at, sync_status, device_id)
  VALUES (?, ?, 'br-1', 'u-owner', 'float_in', 50, ?, 'pending', 'dev-T1')`).run(id, shift, at);
const q = (id) => db.prepare(`SELECT status, attempts, drawer_wait_at FROM sync_queue WHERE order_id = ?`).get(id);
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const wipe = () => {
  for (const t of ['sync_queue', 'orders', 'shifts', 'business_days', 'float_transactions']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`DELETE FROM maintenance_state WHERE key IN ('history_upload', 'history_upload_settings', 'cloud_backup')`).run();
  HU._forgetHistoryMemo(); CB._forgetCloudBackupMemo(); cloudHas.clear(); onBackfill = null;
  calls.length = 0; orderPosts.length = 0; backfills.length = 0; syncPushes.length = 0;
};
const hhmm = (ms) => { const d = new Date(Date.now() + ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const notQuiet = () => { HU.setHistorySettings({ quietFrom: hhmm(2 * H), quietTo: hhmm(3 * H) }); AT._resetActivity(Date.now()); };   // in use, outside the hours
const quietHours = () => { HU.setHistorySettings({ quietFrom: hhmm(-H), quietTo: hhmm(H) }); AT._resetActivity(Date.now()); };      // in the owner's hours
const idle = () => { HU.setHistorySettings({ quietFrom: hhmm(2 * H), quietTo: hhmm(3 * H) }); AT._resetActivity(Date.now() - 11 * 60_000); };   // nobody for 11 min
const passes = async (n = 1) => { for (let i = 0; i < n; i++) await E.syncPush(); };

console.log('\nA602 — the rules\n');
{
  const R = HU;
  const at = (h, m = 0) => new Date(2026, 9, 28, h, m);
  ok('quiet hours wrap midnight (22:00–06:00): 23:30 and 05:59 in, 06:00 and 21:59 out; equal times: never',
    R.inQuietWindow(at(23, 30), '22:00', '06:00') && R.inQuietWindow(at(5, 59), '22:00', '06:00') && !R.inQuietWindow(at(6), '22:00', '06:00')
    && !R.inQuietWindow(at(21, 59), '22:00', '06:00') && R.inQuietWindow(at(13), '12:00', '14:00') && !R.inQuietWindow(at(13), '10:00', '10:00'));
  const s = R.DEFAULT_HISTORY_SETTINGS;
  ok('the defaults: the last 3 months, quiet 22:00–06:00', s.window === '3m' && s.quietFrom === '22:00' && s.quietTo === '06:00');
  const t = at(14).getTime();
  ok('the verdict: a sale under way pauses it even in quiet hours; quiet hours go; 10 min idle goes at any hour; else waits',
    !R.quietVerdict({ now: at(23).getTime(), settings: s, lastUse: 0, busy: 'a sale is in the cart' }).go
    && R.quietVerdict({ now: at(23).getTime(), settings: s, lastUse: at(23).getTime(), busy: null }).go
    && R.quietVerdict({ now: t, settings: s, lastUse: t - 10 * 60_000, busy: null }).go
    && !R.quietVerdict({ now: t, settings: s, lastUse: t - 9 * 60_000, busy: null }).go);
  ok('the window: 3 / 12 calendar months back, everything = no limit', R.windowStart('3m', at(14).getTime()).startsWith('2026-07-28')
    || R.windowStart('3m', at(14).getTime()).startsWith('2026-07-27'), R.windowStart('3m', at(14).getTime()));
  ok('…12 months and all', String(R.windowStart('12m', at(14).getTime())).slice(0, 7) === '2025-10' && R.windowStart('all', t) === null);
  ok('settings: junk replaced by what was there', JSON.stringify(R.cleanHistorySettings({ window: 'forever', quietFrom: '25:00', quietTo: '07:30' }))
    === JSON.stringify({ window: '3m', quietFrom: '22:00', quietTo: '07:30' }));
  ok('progress words: "45% (12,300 of 27,300 sales)"', R.progressLabel(12300, 15000).text === '45% (12,300 of 27,300 sales)', R.progressLabel(12300, 15000).text);
  const cut = isoAgo(48 * H);
  const tables = {
    business_days: [{ id: 'd-old', status: 'closed', closed_at: isoAgo(40 * DAY) }, { id: 'd-old-needed', status: 'closed', closed_at: isoAgo(3 * DAY) }, { id: 'd-now', status: 'open', opened_at: isoAgo(H) }],
    shifts: [{ id: 's-old', status: 'closed', closed_at: isoAgo(40 * DAY), business_day_id: 'd-old' }, { id: 's-open', status: 'open', opened_at: isoAgo(5 * DAY), business_day_id: 'd-old-needed' },
      { id: 's-kept', status: 'closed', closed_at: isoAgo(4 * DAY) }],
    floats: [{ id: 'f-old', shift_id: 's-old' }, { id: 'f-open', shift_id: 's-open' }], expenses: [{ id: 'e-none', shift_id: null }], kitchen_voids: [],
  };
  const sp = R.splitRecentCash(tables, cut, ['s-kept']);
  ok('new first keeps dependencies: an open drawer goes (with its day, closed days ago), an old closed one waits with its float, a drawer of a sale sent now goes',
    sp.send.shifts.map((x) => x.id).join() === 's-open,s-kept' && sp.held.shifts.map((x) => x.id).join() === 's-old'
    && sp.send.business_days.map((x) => x.id).join() === 'd-old-needed,d-now' && sp.held.business_days.map((x) => x.id).join() === 'd-old'
    && sp.send.floats.map((x) => x.id).join() === 'f-open' && sp.held.floats.map((x) => x.id).join() === 'f-old' && sp.send.expenses.length === 1, JSON.stringify(sp));
  const cf = R.cashForShifts(tables, ['s-old']);
  ok('a batch carries its sales\' drawers, their days and their floats', cf.shifts.map((x) => x.id).join() === 's-old' && cf.business_days.map((x) => x.id).join() === 'd-old' && cf.floats.map((x) => x.id).join() === 'f-old');
}

console.log('\nA602 — new first, with its dependencies kept\n');
{
  wipe();
  // A year-old closed day and drawer with 600 sales; today: an open day and drawer with 5 sales; one sale 3 days ago in a
  // drawer closed 3 days ago (older than the 48 h: the backfill's).
  tradingDay('d-old', '2025-11-01', { openedAt: isoAgo(360 * DAY), closedAt: isoAgo(360 * DAY - 12 * H) });
  drawer('s-old', { openedAt: isoAgo(360 * DAY), closedAt: isoAgo(360 * DAY - 11 * H), day: 'd-old' });
  float('f-old', 's-old', isoAgo(360 * DAY - H));
  sellMany(600, NOW - 360 * DAY + 60_000, 60_000, 's-old', 'OLD');
  tradingDay('d-now', '2026-10-28', { openedAt: isoAgo(3 * H) });
  drawer('s-now', { openedAt: isoAgo(3 * H), day: 'd-now' });
  float('f-now', 's-now', isoAgo(2 * H));
  for (let i = 0; i < 5; i++) sell(`NEW-${i}`, isoAgo((5 - i) * 10 * 60_000), 's-now');
  notQuiet();
  await passes(1);
  ok('a queue over 500 starts the history upload (new first)', HU.historyBacklogActive());
  await passes(1);
  ok('the normal push sends the 5 new sales, NEWEST first — not one of the 600 old ones',
    orderPosts.join() === 'NEW-4,NEW-3,NEW-2,NEW-1,NEW-0', orderPosts.join());
  const sent = syncPushes.flatMap((b) => (b.shifts ?? []).map((s) => s.id));
  const days = syncPushes.flatMap((b) => (b.business_days ?? []).map((d) => d.id));
  const floats = syncPushes.flatMap((b) => (b.floats ?? []).map((f) => f.id));
  ok('…its drawer and day went first (the sync push before the orders); the old closed drawer, its day and its float wait for the backfill',
    sent.includes('s-now') && days.includes('d-now') && floats.includes('f-now') && !sent.includes('s-old') && !days.includes('d-old') && !floats.includes('f-old')
    && calls.indexOf('POST /api/sync/push') < calls.indexOf('POST /api/orders'), JSON.stringify({ sent, days, floats }));
  ok('in use and outside the quiet hours: no backfill call', backfills.length === 0, calls.join(', '));
  ok('the old drawer is not closed on the cloud before it is there (no /close 404 every pass)', !calls.some((c) => /\/api\/shifts\/s-old\/close/.test(c)), calls.join(', '));
  const st = E.getSyncStatus();
  ok('getSyncStatus says it: 600 to go, nothing done yet', st.historyUpload?.active === true && st.historyUpload.remaining === 600 && st.historyUpload.done === 0, JSON.stringify(st.historyUpload));
  const n = SN.syncNotice(st);
  ok('the manager reads the history line, not "601 records waiting"', /History upload: 0% \(0 of 600 sales\), in quiet hours/.test(n?.text ?? '') && !/60\d records? waiting/.test(n?.text ?? ''), n?.text);

  console.log('\nA602 — the backfill: quiet hours only, paused by a sale, ≤ 500 a call\n');
  calls.length = 0;
  AT.noteRendererPing({ busy: { cart: true } });
  HU.setHistorySettings({ quietFrom: hhmm(-H), quietTo: hhmm(H) });
  await passes(1);
  ok('a sale in the cart: no backfill, even in the quiet hours', backfills.length === 0 && E.getSyncStatus().historyUpload.why.startsWith('paused'), E.getSyncStatus().historyUpload.why);
  ok('…the notice says it is paused while a sale is under way', /paused while a sale is under way/.test(SN.syncNotice(E.getSyncStatus())?.text ?? ''));
  AT.noteRendererPing({ busy: { cart: false } });
  onBackfill = () => { AT.noteRendererPing({ busy: { cart: true } }); };   // a sale starts while the first batch is on its way
  await passes(1);
  ok('in the quiet hours it goes — and a sale starting stops it after the batch on its way (one call, not two)', backfills.length === 1, String(backfills.length));
  ok('the first call: 500 sales, oldest first, gzip\'d, with their drawer, its day and its float', backfills[0].orders.length === 500 && backfills[0].orders[0] === 'OLD-000000'
    && backfills[0].orders[499] === 'OLD-000499' && backfills[0].gz && backfills[0].shifts.join() === 's-old' && backfills[0].days.join() === 'd-old' && backfills[0].floats.join() === 'f-old',
    JSON.stringify({ ...backfills[0], orders: backfills[0].orders.length }));
  ok('each stored sale is marked synced exactly as the normal push marks it (the queue row and the order)',
    count(`SELECT COUNT(*) n FROM sync_queue WHERE status='synced' AND order_id LIKE 'OLD-%'`) === 500
    && count(`SELECT COUNT(*) n FROM orders WHERE sync_status='synced' AND id LIKE 'OLD-%'`) === 500);
  ok('…progress: 83% (500 of 600 sales)', E.getSyncStatus().historyUpload.progress === '83% (500 of 600 sales)', E.getSyncStatus().historyUpload.progress);
  AT.noteRendererPing({ busy: { cart: false } }); onBackfill = null;
  orderPosts.length = 0;
  idle();
  await passes(1);
  ok('10 minutes without use (outside the hours) is quiet too: the last 100 go in one call', backfills.length === 2 && backfills[1].orders.length === 100, String(backfills.map((b) => b.orders.length)));
  ok('the normal push never sent one of the 600 — no sale went twice', orderPosts.length === 0 && backfills.flatMap((b) => b.orders).length === new Set(backfills.flatMap((b) => b.orders)).size, orderPosts.join());
  await passes(1);
  ok('then the drawer is closed on the cloud (its sales are all there), the history finished, the normal push as before',
    calls.some((c) => c === 'POST /api/shifts/s-old/close') && !HU.historyBacklogActive() && HU.getHistoryState().finishedAt, calls.filter((c) => /close/.test(c)).join(', '));
  orderPosts.length = 0;
  sell('NEW-9', new Date().toISOString(), 's-now');
  await passes(1);
  ok('…a new sale after it goes by the normal push at once', orderPosts.join() === 'NEW-9');
}

console.log('\nA602 — a sale waiting for its drawer, a refusal: as the normal push\n');
{
  wipe(); HU.setHistorySettings({ window: 'all' });
  drawer('s-old', { openedAt: isoAgo(30 * DAY), closedAt: isoAgo(30 * DAY - 8 * H) });
  sellMany(520, NOW - 30 * DAY, 1000, 's-old', 'W');
  sell('W-missing', isoAgo(29 * DAY), 'sh-missing'); sell('W-refused', isoAgo(29 * DAY), 's-old', { refuse: true });
  quietHours();
  await passes(1);
  ok('a sale whose drawer the cloud does not have waits (drawer_wait_at), never counted as a try', q('W-missing').status === 'pending' && q('W-missing').attempts === 0 && !!q('W-missing').drawer_wait_at, JSON.stringify(q('W-missing')));
  ok('a sale the cloud refused counts a try, one a pass (not five in one), as the normal push', q('W-refused').status === 'pending' && q('W-refused').attempts === 1, JSON.stringify(q('W-refused')));
  await passes(4);
  ok('…the fifth try makes it failed (for a person: the red notice)', q('W-refused').status === 'failed' && q('W-refused').attempts === 5 && E.getSyncStatus().failedCount === 1, JSON.stringify(q('W-refused')));
  ok('the waiting sale is not offered again within its 15 minutes', backfills.filter((b) => b.orders.includes('W-missing')).length === 1, String(backfills.length));
}

console.log('\nA602 — how far back: older sales stay on this PC, never "waiting"\n');
{
  wipe();
  // 200 sales 8 months ago (a closed drawer and day), 300 sales 1 month ago, then the cut-off ends: the licence bought.
  tradingDay('d-8m', '2026-02-28', { openedAt: isoAgo(240 * DAY), closedAt: isoAgo(240 * DAY - 12 * H) });
  drawer('s-8m', { openedAt: isoAgo(240 * DAY), closedAt: isoAgo(240 * DAY - 10 * H), day: 'd-8m' });
  float('f-8m', 's-8m', isoAgo(240 * DAY - H));
  sellMany(200, NOW - 240 * DAY, 60_000, 's-8m', 'M8');
  drawer('s-1m', { openedAt: isoAgo(30 * DAY), closedAt: isoAgo(30 * DAY - 10 * H) });
  sellMany(300, NOW - 30 * DAY, 60_000, 's-1m', 'M1');
  cloudBackup = { on: false, phase: 'cut', cutoffAt: isoAgo(300 * DAY) };
  await E.pullCatalogueNow();
  notQuiet();
  await passes(1);
  ok('the backup off (A601): nothing sent, the history waits', backfills.length === 0 && !HU.historyBacklogActive() && HU.getHistoryState().seenOff === true);
  cloudBackup = { on: true, phase: 'none', cutoffAt: null };
  await E.pullCatalogueNow();
  await passes(1);
  ok('the licence bought (backup on again after off): the history upload starts — fewer than 500 waiting, still started', HU.historyBacklogActive() && HU.getHistoryState().fromCut === true);
  ok('the default window (the last 3 months): the 200 sales of 8 months ago are local_only, the 300 of last month pending',
    count(`SELECT COUNT(*) n FROM sync_queue WHERE status='local_only'`) === 200 && count(`SELECT COUNT(*) n FROM sync_queue WHERE status='pending'`) === 300);
  ok('…their order, drawer, day and float are kept on this PC too ("local_only"), the newer drawer still to go',
    count(`SELECT COUNT(*) n FROM orders WHERE sync_status='local_only'`) === 200 && db.prepare(`SELECT sync_status s FROM shifts WHERE id='s-8m'`).get().s === 'local_only'
    && db.prepare(`SELECT sync_status s FROM business_days WHERE id='d-8m'`).get().s === 'local_only' && db.prepare(`SELECT sync_status s FROM float_transactions WHERE id='f-8m'`).get().s === 'local_only'
    && db.prepare(`SELECT sync_status s FROM shifts WHERE id='s-1m'`).get().s === 'pending');
  const st = E.getSyncStatus();
  ok('not "waiting": the POS\'s count, the cloud\'s X-Sync-Pending and the history\'s total leave them out',
    st.pendingCount === 301 && st.historyUpload.remaining === 300 && st.historyUpload.localOnly === 200, JSON.stringify({ p: st.pendingCount, h: st.historyUpload }));
  quietHours();
  await passes(2);
  ok('the backfill sends only the window: the 300, never one of the 200', backfills.flatMap((b) => b.orders).length === 300 && !backfills.some((b) => b.orders.some((id) => id.startsWith('M8'))) && !backfills.some((b) => b.shifts.includes('s-8m')));
  await passes(1);
  ok('done: the 200 stay local_only, nothing left "waiting", no notice', !HU.historyBacklogActive() && count(`SELECT COUNT(*) n FROM sync_queue WHERE status='local_only'`) === 200
    && E.getSyncStatus().pendingCount === 0 && SN.syncNotice(E.getSyncStatus()) === null, JSON.stringify(SN.syncNotice(E.getSyncStatus())));
  HU.setHistorySettings({ window: '12m' });
  ok('the owner widens it to 12 months: the 200 are pending again (sales, orders, drawer, day, float) and the upload starts again',
    count(`SELECT COUNT(*) n FROM sync_queue WHERE status='local_only'`) === 0 && count(`SELECT COUNT(*) n FROM sync_queue WHERE status='pending'`) === 200
    && db.prepare(`SELECT sync_status s FROM shifts WHERE id='s-8m'`).get().s === 'pending' && db.prepare(`SELECT sync_status s FROM float_transactions WHERE id='f-8m'`).get().s === 'pending'
    && HU.historyBacklogActive());
  await passes(2);
  ok('…and they go up (oldest first, with their drawer, day and float)', count(`SELECT COUNT(*) n FROM sync_queue WHERE status='synced' AND order_id LIKE 'M8-%'`) === 200
    && backfills.some((b) => b.shifts.includes('s-8m') && b.days.includes('d-8m') && b.floats.includes('f-8m')));
  ok('a POS that was only offline (no cut-off, owner never chose) sends everything: the window is not applied', (() => {
    wipe();
    sellMany(600, NOW - 200 * DAY, 60_000, null, 'OFF');
    HU.noteHistoryPass(false);
    return HU.historyBacklogActive() && HU.getHistoryState().fromCut === false && count(`SELECT COUNT(*) n FROM sync_queue WHERE status='local_only'`) === 0;
  })());
}

console.log('\nA602 — an interrupted run resumes; nothing is lost or sent twice\n');
{
  wipe(); HU.setHistorySettings({ window: 'all' });
  drawer('s-old', { openedAt: isoAgo(60 * DAY), closedAt: isoAgo(60 * DAY - 8 * H) });
  sellMany(1200, NOW - 60 * DAY, 1000, 's-old', 'I');
  quietHours();
  onBackfill = (n) => (n === 2 ? 'store-then-throw' : null);   // the cloud stored the 2nd batch; the answer never came back
  await passes(1);
  ok('the line dropped on the 2nd call: the 1st batch synced, the 2nd still pending (no answer heard), the rest untouched',
    count(`SELECT COUNT(*) n FROM sync_queue WHERE status='synced'`) === 500 && count(`SELECT COUNT(*) n FROM sync_queue WHERE status='pending'`) === 700 && backfills.length === 2,
    `${count(`SELECT COUNT(*) n FROM sync_queue WHERE status='synced'`)} / ${backfills.length}`);
  ok('…nothing counted as a try (the line, not the sale)', count(`SELECT COUNT(*) n FROM sync_queue WHERE attempts > 0 AND status='pending'`) === 0);
  onBackfill = null;
  HU._forgetHistoryMemo();   // as after a restart: the state is read back from the database
  await passes(2);
  ok('the next run (after a restart) sends the 2nd batch again: the cloud answers duplicate, all 1,200 synced, each stored once',
    count(`SELECT COUNT(*) n FROM sync_queue WHERE status='synced'`) === 1200 && cloudHas.size === 1200 && backfills[2].orders[0] === backfills[1].orders[0], String(backfills.length));
}

console.log('\nA602 — a 100,000-sale queue: about 200 calls, not 100,000\n');
{
  wipe(); HU.setHistorySettings({ window: 'all' });
  const t0 = Date.now();
  const days = 365, perDay = Math.ceil(100_000 / days);
  db.transaction(() => {
    let k = 0;
    for (let d = 0; d < days && k < 100_000; d++) {
      const sh = `S-${d}`;
      const opened = NOW - (days - d) * DAY - 30 * DAY;
      db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, closed_at, status, created_at, device_id, sync_status)
        VALUES (?, 'biz-1', 'br-1', 'u-owner', ?, ?, 'closed', ?, 'dev-T1', 'pending')`).run(sh, new Date(opened).toISOString(), new Date(opened + 12 * H).toISOString(), new Date(opened).toISOString());
      for (let i = 0; i < perDay && k < 100_000; i++, k++) sell(`Y-${String(k).padStart(6, '0')}`, new Date(opened + 60_000 + i * 60_000).toISOString(), sh);
    }
  })();
  ok('100,000 sales queued over 365 drawers', count(`SELECT COUNT(*) n FROM sync_queue WHERE status='pending'`) === 100_000, `${Date.now() - t0} ms`);
  quietHours();
  const t1 = Date.now();
  for (let i = 0; i < 20 && count(`SELECT COUNT(*) n FROM sync_queue WHERE status='pending'`) > 0; i++) await passes(1);
  const bf = calls.filter((c) => c === 'POST /api/sync/backfill').length;
  ok(`drained in ${bf} backfill calls (≈ 200), none over 500, every sale once`, count(`SELECT COUNT(*) n FROM sync_queue WHERE status='pending'`) === 0 && bf >= 200 && bf <= 205
    && backfills.every((b) => b.orders.length <= 500) && cloudHas.size === 100_000, `${bf} calls, ${count(`SELECT COUNT(*) n FROM sync_queue WHERE status='pending'`)} left, ${Date.now() - t1} ms`);
  ok('…and not one per sale: no POST /api/orders for any of them', orderPosts.filter((id) => id.startsWith('Y-')).length === 0);
  console.log(`       (${bf} calls, ${Date.now() - t1} ms here)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
