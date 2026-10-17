// Branch-server audit (2026-10-14) — the defects of the branch server (device_role 'node') and its tills, fixed:
//   F1  a failing row no longer loses the rest of its batch (applied ids named; refused alone; the rest pending)
//   F2  a new server is really offered everything (queue rows re-armed, then /node/cursors skips what it holds)
//   F3  no answer / 5xx / 401 never count toward 'failed'; failed rows re-armed on a server change
//   F4  Close Branch: day-closed tills that went quiet do not block; 7-day age-out; "Forget this till"
//   F5  relayed peer sales are stamped ISO (they no longer sort ahead of the server's own)
//   F7  each till's own device key; relays only for known tills; staff roles from the server's roles, never the change
//   F8  refunds reach the server and the other tills (columns + order_refunded event); truthful report scope
//   F9  the server numbers its own rows, so its tills receive them
//   F10 replication on its own beat
//   F11 a stale close never closes today's day; instructions expire after 24 h
//   F12 acks matched by uid and device
//   F13 one bad event no longer breaks every /node/sync
//   F14 batches capped by size; the server answers 413 by name
//   F15 the server's time zone is compared too
//   F16 PIN checks rate-limited and run without blocking
//   P3  pruning, one join notice per address, a delivered confirmation is not replaced, network note
//
// Drives the REAL compiled dist/main (nodeIngest, nodeServer over real HTTP, branchClose, branchStaff, syncEngine) on a
// REAL SQLite file, electron shimmed (safeStorage as a reversible stand-in).
//
//   cd apps/desktop && npm run build:main && node test/branch-server-audit.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main and re-running):
//   - applyPeerRows `continue` after an insert failure back to `break`        → "F1: the rows after a failing row" fails
//   - settleNodeBatch treating "not rejected" as delivered                     → "F1: a row neither held nor refused" fails
//   - resetOutboxCursors without the node_queue re-arm                          → "F2: a reset re-arms the queue" fails
//   - markNodeQueueFailed(escalate=false) counting an attempt                   → "F3: transport failures never count" fails
//   - vetRelayedStaffChanges taking the role from the change (_local kept)      → "F7: a relayed cashier gets the role's permissions" fails
//   - /node/sync not checking the device key                                    → "F7: a wrong key is refused" fails
//   - applyPendingEvents without the per-event try                             → "F13: one bad event" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-bsa-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.14', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('E:' + s, 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8').slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
const realFetch = globalThis.fetch;
// The cloud is never reached; the branch server (127.0.0.1) is.
globalThis.fetch = async (url, init) => (String(url).startsWith('http://127.0.0.1') ? realFetch(url, init) : Promise.reject(new TypeError('fetch failed')));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

process.env.SWIFTPOS_NODE_PORT = String(41000 + Math.floor(Math.random() * 15000));
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-S', 'biz-1', 'Pizza House', '2026-10-14T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
const asNode = () => C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.invalid', branch_id: 'br-1',
  device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server', node_url: null });
asNode();
const I = require(path.join(dist, 'nodeIngest.js'));
const B = require(path.join(dist, 'branchClose.js'));
const BS = require(path.join(dist, 'branchStaff.js'));
const NS = require(path.join(dist, 'nodeServer.js'));
const NC = require(path.join(dist, 'nodeClient.js'));
const J = require(path.join(dist, 'serverJoin.js'));
const MR = require(path.join(dist, 'managerReports.js'));
const SE = require(path.join(dist, 'syncEngine.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;

const order = (id, device, seq, extra = {}) => ({ id, business_id: 'biz-1', branch_id: 'br-1', order_number: `N-${id}`, status: 'completed',
  subtotal: 100, vat_amount: 0, total: 100, created_at: '2026-10-14T08:00:00.000Z', device_id: device, seq, ...extra });
const countRows = (sql, ...a) => db.prepare(sql).get(...a).n;

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nF1 — a failing row no longer loses the rest of its batch\n');
{
  const rows = [order('f1-a', 'dev-P', 1), order('f1-b', 'dev-P', 2, { subtotal: { not: 'bindable' } }), order('f1-c', 'dev-P', 3)];
  const r = I.applyPeerRows('orders', 'dev-P', rows);
  ok('F1: the rows after a failing row are applied too', countRows(`SELECT COUNT(*) n FROM orders WHERE id IN ('f1-a','f1-c')`) === 2, JSON.stringify(r));
  ok('…the failing row is refused alone, with its reason', r.rejected.length === 1 && r.rejected[0].id === 'f1-b' && !!r.rejected[0].reason);
  ok('…and the answer names exactly what is held', JSON.stringify(r.applied_ids.sort()) === '["f1-a","f1-c"]');
  const again = I.applyPeerRows('orders', 'dev-P', [order('f1-a', 'dev-P', 1)]);
  ok('a row already held counts as held (a re-offer is free)', again.duplicate === 1 && again.applied_ids[0] === 'f1-a');

  // The till's side: settleNodeBatch.
  const q = (id, row_id, seq, table = 'orders') => ({ id, table_name: table, row_id, payload: JSON.stringify({ id: row_id, seq }), attempts: 0, created_at: 'x' });
  const batch = [q(1, 'f1-a', 1), q(2, 'f1-b', 2), q(3, 'f1-c', 3), q(4, 'f1-d', 4)];
  const s = I.settleNodeBatch(batch, { orders: { ...r, applied_ids: ['f1-a', 'f1-c'] } });
  ok('the till marks delivered only what the server holds', JSON.stringify(s.delivered) === '[1,3]', JSON.stringify(s));
  ok('…refused what it refused', s.refused.length === 1 && s.refused[0].id === 2);
  ok('F1: a row neither held nor refused stays pending (offered again)', JSON.stringify(s.pending) === '[4]', JSON.stringify(s));
  const old = I.settleNodeBatch(batch, { orders: { applied: 1, duplicate: 0, cursor: 1, rejected: [{ id: 'f1-b', table: 'orders', reason: 'x' }] } });
  ok('an older server (no list): held only up to its cursor — the rows after its stop stay pending',
    JSON.stringify(old.delivered) === '[1]' && JSON.stringify(old.pending) === '[3,4]', JSON.stringify(old));
  const none = I.settleNodeBatch(batch, {});
  ok('a table the server did not answer for stays pending', none.pending.length === 4 && !none.delivered.length);

  // Distribution: a bad row is refused alone and the cursor moves past it (no stall), recorded.
  const d = I.applyDistribution([{ device_id: 'dev-Q', table: 'orders', rows: [order('q-1', 'dev-Q', 1), order('q-2', 'dev-Q', 2, { total: { bad: 1 } }), order('q-3', 'dev-Q', 3)] }]);
  ok('distribution: a bad row is refused alone, the rest applied', d.applied === 2 && d.rejected === 1, JSON.stringify(d));
  ok('…the origin\'s cursor moves past it (no stall on one row)', I.getCursor('dev-Q', 'orders') === 3);
  ok('…and the refusal is recorded', !!db.prepare(`SELECT 1 FROM maintenance_state WHERE key = 'distribution_refused:dev-Q:orders:q-2'`).get());
  ok('…and distribution never relays a sale to the cloud', countRows(`SELECT COUNT(*) n FROM sync_queue WHERE order_id LIKE 'q-%'`) === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nF2 / F3 — the outbox: a new server gets everything; transport never counts\n');
{
  const ins = db.prepare(`INSERT INTO node_queue (table_name, row_id, payload, created_at, status, attempts, last_error) VALUES (?, ?, ?, datetime('now'), ?, ?, ?)`);
  ins.run('orders', 'o-del', JSON.stringify({ id: 'o-del', seq: 5 }), 'delivered', 1, null);
  ins.run('orders', 'o-fail', JSON.stringify({ id: 'o-fail', seq: 6 }), 'failed', 5, 'bill number clash');
  ins.run('orders', 'o-new', JSON.stringify({ id: 'o-new', seq: 50 }), 'pending', 0, null);
  db.prepare(`INSERT OR REPLACE INTO outbox_cursors (table_name, last_seq, updated_at) VALUES ('orders', 50, datetime('now'))`).run();
  I.resetOutboxCursors();
  ok('F2: a reset re-arms the queue (delivered and failed rows pending again, attempts cleared)',
    countRows(`SELECT COUNT(*) n FROM node_queue WHERE status = 'pending' AND attempts = 0 AND row_id IN ('o-del','o-fail','o-new')`) === 3);
  ok('…the cursor is gone (rows pruned from the queue are scanned again)', I.getOutboxCursor('orders') === 0);
  ok('…and a /node/cursors skip is owed once', I.nodeRearmSkipOwed() === true);
  const skipped = I.skipHeldByNode([{ table_name: 'orders', last_seq: 10 }]);
  ok('F2: what the new server already holds is skipped — never a row the old one refused',
    skipped === 1 && db.prepare(`SELECT status FROM node_queue WHERE row_id='o-del'`).get().status === 'delivered'
    && db.prepare(`SELECT status FROM node_queue WHERE row_id='o-fail'`).get().status === 'pending'
    && db.prepare(`SELECT status FROM node_queue WHERE row_id='o-new'`).get().status === 'pending', String(skipped));
  ok('…once', I.nodeRearmSkipOwed() === false);

  db.prepare(`DELETE FROM maintenance_state WHERE key = 'node_target'`).run();
  const k1 = I.nodeTargetKey('http://10.0.0.5:4100/', 'SECRET-1');
  ok('the server\'s identity (address + code) is hashed, never stored in clear', !k1.includes('SECRET') && k1 === I.nodeTargetKey('http://10.0.0.5:4100', 'SECRET-1'));
  ok('first pass on this build: noted (and the last 14 days offered again — the F1 repair)', I.noteNodeTarget(k1) === 'first');
  ok('same server: nothing happens', I.noteNodeTarget(k1) === 'same');
  db.prepare(`UPDATE node_queue SET status = 'delivered' WHERE row_id = 'o-new'`).run();
  ok('F2: a new access code (what a 401 a fresh code fixes looks like) re-arms everything',
    I.noteNodeTarget(I.nodeTargetKey('http://10.0.0.5:4100', 'SECRET-2')) === 'changed'
    && db.prepare(`SELECT status FROM node_queue WHERE row_id='o-new'`).get().status === 'pending');

  const id = db.prepare(`SELECT id FROM node_queue WHERE row_id = 'o-new'`).get().id;
  for (let i = 0; i < 7; i++) I.markNodeQueueFailed([id], 'branch server unreachable', false);
  const after = db.prepare(`SELECT status, attempts, last_error FROM node_queue WHERE id = ?`).get(id);
  ok('F3: transport failures never count (seven passes with the server off: still pending, 0 attempts)',
    after.status === 'pending' && after.attempts === 0 && after.last_error.startsWith(I.TRANSPORT_NOTE), JSON.stringify(after));
  for (let i = 0; i < 5; i++) I.markNodeQueueFailed([id], 'row belongs to a different branch', true);
  ok('…a refusal on the row\'s merits still escalates to failed after five', db.prepare(`SELECT status FROM node_queue WHERE id = ?`).get(id).status === 'failed');
  ok('F3: failed rows can be put back in line', I.rearmFailedNodeRows() >= 1 && db.prepare(`SELECT status FROM node_queue WHERE id = ?`).get(id).status === 'pending');

  // F14: by size.
  db.prepare(`DELETE FROM node_queue`).run();
  const big = 'x'.repeat(700_000);
  for (let i = 0; i < 5; i++) ins.run('orders', `big-${i}`, JSON.stringify({ id: `big-${i}`, seq: i + 1, blob: big }), 'pending', 0, null);
  const b = I.takeNodeQueueBatch(200);
  ok('F14: a batch is capped by size (≤ 2 MB) as well as count', b.length === 2, String(b.length));
  ok('…and always at least one row', I.takeNodeQueueBatch(200, 10).length === 1);
  db.prepare(`DELETE FROM node_queue`).run();

  // P3: pruning.
  ins.run('orders', 'old-del', '{}', 'delivered', 1, null);
  db.prepare(`UPDATE node_queue SET created_at = datetime('now', '-9 days') WHERE row_id = 'old-del'`).run();
  ins.run('orders', 'new-del', '{}', 'delivered', 1, null);
  ins.run('orders', 'old-pend', '{}', 'pending', 0, null);
  db.prepare(`UPDATE node_queue SET created_at = datetime('now', '-9 days') WHERE row_id = 'old-pend'`).run();
  ok('P3: delivered outbox rows older than 7 days are pruned — nothing else', I.pruneNodeQueue(7) === 1
    && countRows(`SELECT COUNT(*) n FROM node_queue WHERE row_id IN ('new-del','old-pend')`) === 2);
  db.prepare(`DELETE FROM node_queue`).run();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nF9 / F8 — the server\'s own rows travel; refunds travel\n');
{
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, created_at, sync_status, device_id)
              VALUES ('own-1', 'biz-1', 'br-1', 'S-1', 'completed', 300, 0, 300, '2026-10-14T09:00:00.000Z', 'synced', 'dev-S')`).run();
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at, status) VALUES ('pay-own-1', 'own-1', 'cash', 300, 300, '2026-10-14T09:00:00.000Z', 'completed')`).run();
  const before = I.collectDistribution('dev-P', {}).batches.find((x) => x.device_id === 'dev-S' && x.table === 'orders');
  ok('(before) the server\'s own unnumbered sale is not distributed', !before?.rows.some((r) => r.id === 'own-1'));
  await SE.nodeReplicationTick();
  const n = db.prepare(`SELECT seq FROM orders WHERE id = 'own-1'`).get().seq;
  ok('F9: the server\'s beat numbers its own rows', Number.isInteger(n) && n > 0, String(n));
  const after = I.collectDistribution('dev-P', {}).batches.find((x) => x.device_id === 'dev-S' && x.table === 'orders');
  ok('…so its tills receive them', !!after?.rows.some((r) => r.id === 'own-1'));

  // A refund after the sale crossed: an event, with its legs.
  db.prepare(`UPDATE orders SET refunded_at = '2026-10-14T10:00:00.000Z', refunded_amount = 300, refund_reason = 'cold' WHERE id = 'own-1'`).run();
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, change_given, reference, status, created_at, sync_status)
              VALUES ('ref-own-1', 'own-1', 'cash', -300, 0, 0, 'REFUND-S-1', 'refunded', '2026-10-14T10:00:00.000Z', 'synced')`).run();
  ok('F8: a refund becomes an order_refunded event, once', I.emitRefundEvents() === 1 && I.emitRefundEvents() === 0);
  const ev = db.prepare(`SELECT * FROM events WHERE kind = 'order_refunded' AND target_id = 'own-1'`).get();
  ok('…numbered (it travels) and carrying the refund legs', ev.seq > 0 && JSON.parse(ev.payload).payments?.[0]?.id === 'ref-own-1');
  ok('F8: the order row itself carries the refund columns when offered', I.replicatedColumns('orders').includes('refunded_amount') && I.replicatedColumns('orders').includes('refunded_at'));

  // The same event arriving on a replica (here: an event from dev-P for its order f1-a).
  db.prepare(`INSERT INTO events (id, business_id, branch_id, device_id, seq, kind, target_table, target_id, payload, created_at, applied)
              VALUES ('ev-ref-p', 'biz-1', 'br-1', 'dev-P', 1, 'order_refunded', 'orders', 'f1-a', ?, '2026-10-14T11:00:00Z', 0)`)
    .run(JSON.stringify({ refunded_at: '2026-10-14T11:00:00Z', refunded_amount: 100, refund_reason: 'wrong', payments: [{ id: 'ref-p-1', method: 'mpesa', amount: -100, reference: 'R', status: 'refunded', created_at: '2026-10-14T11:00:00Z' }] }));
  // F13: and a broken one alongside it.
  db.prepare(`INSERT INTO events (id, business_id, branch_id, device_id, seq, kind, target_table, target_id, payload, created_at, applied)
              VALUES ('ev-bad', 'biz-1', 'br-1', 'dev-P', 2, 'order_voided', 'orders', 'f1-c', ?, '2026-10-14T11:00:00Z', 0)`)
    .run(JSON.stringify({ status: { evil: true } }));
  let threw = false, res = null;
  try { res = I.applyPendingEvents(); } catch { threw = true; }
  ok('F13: one bad event does not break the sweep (every /node/sync runs it)', !threw && res.refused >= 1, JSON.stringify(res));
  ok('…it is refused (-1), the others applied', db.prepare(`SELECT applied FROM events WHERE id='ev-bad'`).get().applied === -1
    && db.prepare(`SELECT applied FROM events WHERE id='ev-ref-p'`).get().applied === 1);
  const o = db.prepare(`SELECT refunded_amount, refund_reason FROM orders WHERE id = 'f1-a'`).get();
  const leg = db.prepare(`SELECT amount, status, sync_status FROM payments WHERE id = 'ref-p-1'`).get();
  ok('F8: the replica takes the refund and its legs (stamped peer — never pushed from here)',
    o.refunded_amount === 100 && o.refund_reason === 'wrong' && leg?.amount === -100 && leg.status === 'refunded' && leg.sync_status === 'peer', JSON.stringify({ o, leg }));

  // Report scope on a till that holds copies.
  C.saveDeviceConfig({ ...C.getDeviceConfig(), device_role: 'till' });
  const scope = MR.getReportScope();
  ok('F8: a till holding other tills\' copies says so (not "This till only")', /other till/.test(scope.scopeLabel) && !/only/.test(scope.scopeLabel) && scope.coversBranch === false, scope.scopeLabel);
  asNode();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nF11 / F12 — instructions\n');
{
  const Dy = require(path.join(dist, 'dayService.js'));
  db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
              VALUES (1, 'u-m', 'Mary', 'manager', '{"*":true}', 'br-1', 'tok', '2026-10-14T06:00:00Z')`).run();
  const open = Dy.ensureDayOpen('u-m');
  const r = B.executeCloseDay({ business_date: '2000-01-01', counted_cash: null });
  ok('F11: a close for an earlier date than the day now open is stale — today\'s day stays open',
    r.ok && r.already_closed === true && Dy.getOpenDay()?.id === open.id, JSON.stringify(r));
  const a = B.createCloseInstruction('dev-P', { business_date: '2026-10-14', counted_cash: null }, 'u-m');
  const got = B.collectInstructions('dev-P');
  const mine = got.find((x) => x.id === a.id);
  ok('F12: an instruction carries a uid', typeof mine?.uid === 'string' && mine.uid.length >= 32);
  ok('F12: an ack from another till does not retire it', B.recordAck(a.id, { ok: true }, { deviceId: 'dev-OTHER', uid: mine.uid }) === false);
  ok('…an ack with the uid from its own till does', B.recordAck(null, { ok: true }, { deviceId: 'dev-P', uid: mine.uid }) === true);
  const b2 = B.createCloseInstruction('dev-P', { business_date: '2026-10-14', counted_cash: null }, 'u-m');
  ok('an older till (number only) is still matched', B.recordAck(b2.id, { ok: true }) === true);
  const c = B.createCloseInstruction('dev-P', { business_date: '2026-10-14', counted_cash: null }, 'u-m');
  const later = B.collectInstructions('dev-P', Date.now() + 25 * 3_600_000);
  ok('F11: an instruction not answered within 24 h expires — never handed out again',
    !later.some((x) => x.id === c.id) && db.prepare(`SELECT status FROM node_instructions WHERE id = ?`).get(c.id).status === 'expired');
  // P3: a confirmation the till already collected is not replaced.
  B.createConfirmInstruction('dev-P', { shift_id: 'sh-1', counts: { cash: 1 }, confirmer: { id: 'u-m', name: 'M' } }, 'u-m');
  B.collectInstructions('dev-P');
  let refused = '';
  try { B.createConfirmInstruction('dev-P', { shift_id: 'sh-1', counts: { cash: 2 }, confirmer: { id: 'u-m', name: 'M' } }, 'u-m'); } catch (e) { refused = e.message; }
  ok('P3: a confirmation the till already took is not replaced by a second count', refused === B.CONFIRM_IN_FLIGHT);
  db.prepare(`UPDATE node_instructions SET acked_at = ? WHERE status IN ('acked','expired')`).run(new Date(Date.now() - 8 * 86_400_000).toISOString());
  ok('P3: instructions answered more than 7 days ago are pruned', B.pruneNodeInstructions(7) >= 2);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nF4 — Close Branch lists the tills that matter\n');
{
  const day = (open) => JSON.stringify({ business_date: '2026-10-14', day_open: open, open_drawer: null, drawers_on_day: 0, cashiers_counted_total: 0, shifts: [] });
  db.prepare(`INSERT OR REPLACE INTO node_peer_state (device_id, state, updated_at) VALUES ('dev-GONE', ?, ?)`).run(day(true), new Date(Date.now() - 9 * 86_400_000).toISOString());
  db.prepare(`INSERT OR REPLACE INTO node_peer_state (device_id, state, updated_at) VALUES ('dev-NIGHT', ?, ?)`).run(day(false), new Date(Date.now() - 3 * 3_600_000).toISOString());
  db.prepare(`INSERT OR REPLACE INTO node_peer_state (device_id, state, updated_at) VALUES ('dev-OLDBOX', ?, ?)`).run(day(true), new Date(Date.now() - 3 * 3_600_000).toISOString());
  db.prepare(`UPDATE peer_cursors SET updated_at = datetime('now', '-30 days')`).run();
  const ids = () => B.branchCloseOverview().tills.map((t) => t.device_id);
  ok('F4: a till not heard from in 7 days drops off the list', !ids().includes('dev-GONE') && !ids().includes('dev-Q'), JSON.stringify(ids()));
  ok('…a recent one stays', ids().includes('dev-NIGHT') && ids().includes('dev-OLDBOX'));
  db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
              VALUES (1, 'u-m', 'Mary', 'manager', '{"*":true}', 'br-1', 'tok', '2026-10-14T06:00:00Z')`).run();
  const r1 = await H['branchClose:closeBranch'](null, {});
  ok('F4: a quiet till whose day is closed does not block Close Branch', !(r1.blockers ?? []).some((x) => /dev-NIGH/.test(x)), JSON.stringify(r1.blockers));
  // A520 (KRUNCH deadlock): a quiet till whose day is open but whose last report needs nobody (no drawer, nothing to
  // confirm) no longer blocks — it is "not connected" and gets a close that waits for it. Money still blocks.
  const ovq = B.branchCloseOverview();
  ok('…a quiet till with its day OPEN and nothing to count is not connected — its close waits for it (A520)',
    !(r1.blockers ?? []).some((x) => /dev-OLDB/.test(x)) && ovq.close.held.some((h) => h.device_id === 'dev-OLDBOX'), JSON.stringify({ b: r1.blockers, held: ovq.close.held }));
  const f = await H['branchClose:forgetTill'](null, { device_id: 'dev-OLDBOX' });
  ok('F4: "Forget this till" takes it off the list at once', f.ok && !ids().includes('dev-OLDBOX'), JSON.stringify(f));
  ok('…never the server itself', (await H['branchClose:forgetTill'](null, { device_id: 'dev-S' })).ok === false);
  B.recordPeerState('dev-OLDBOX', JSON.parse(day(true)));
  ok('…and it comes back if it reports again', ids().includes('dev-OLDBOX'));
  const tab = read('src/renderer/pages/BranchCloseTab.tsx');
  // A521 (#3): "Forget this till" is "Revoke this till" (same channel, named for what it does — the key goes), beside
  // "Hide from Close Branch" (keeps the key). Intent kept: a small way off the list on a stale till row.
  ok('the screen: a small "Revoke this till" (was "Forget") and "Hide from Close Branch" on a stale till row; the same day-closed rule',
    /Revoke this till/.test(tab) && /Hide from Close Branch/.test(tab) && /posApi\.branchClose\.forgetTill\(/.test(tab)
    // A520: the day-closed rule moved to the server (branchClose.assessBranchClose) — the screen shows its blockers.
    && /st\.day_open === false && !st\.open_drawer\) continue;/.test(read('src/main/branchClose.ts')) && /ov\.close\?\.blockers/.test(tab));
  ok('the bridge carries it', /'branchClose:forgetTill'/.test(read('src/main/preload.ts')) && /'branchClose:forgetTill'/.test(read('src/main/ipcSchemas.ts')));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nF7 / F5 / F14 / F15 / F16 — the real branch server over HTTP\n');
{
  const SECRET = C.ensureNodeSecret();
  NS.startNodeServer();
  await new Promise((r) => setTimeout(r, 300));
  const NODE = `http://127.0.0.1:${NS.getNodePort()}`;
  const KEY = 'a'.repeat(64), WRONG = 'b'.repeat(64);
  const post = (p, body, h = {}) => realFetch(`${NODE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Node-Secret': SECRET, ...h }, body: JSON.stringify(body) });
  const relayRow = (id, device, seq) => order(id, device, seq, { _items: [{ id: `it-${id}`, order_id: id, product_id: 'p', product_name: 'Pizza', unit_price: 100, quantity: 1, subtotal: 100 }],
    _payments: [{ id: `pay-${id}`, order_id: id, method: 'cash', amount: 100, amount_tendered: 100, change_given: 0, status: 'completed', created_at: '2026-10-14T08:00:00Z' }],
    _relayPayload: { branch_id: 'br-1', order_number: `N-${id}`, items: [{ product_id: 'p', quantity: 1 }], payments: [{ method: 'cash', amount: 100 }], device_id: device } });

  // A496: first-use recording is only for a till this server knew before device keys (node_enrol_allowed, noted once from
  // peer_cursors / node_peer_state) — dev-K is such a till here. A device never seen before must join (branch-server-hardening).
  db.prepare(`INSERT OR IGNORE INTO node_enrol_allowed (device_id, noted_at) VALUES ('dev-K', ?)`).run(new Date().toISOString());
  const s1 = await post('/node/sync', { device_id: 'dev-K', branch_id: 'br-1', tables: { orders: [relayRow('k-1', 'dev-K', 1)] } }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': KEY });
  const b1 = await s1.json();
  ok('F7: a till\'s key is recorded the first time it is shown (older installs keep working)', s1.status === 200 && b1.results.orders.applied_ids?.[0] === 'k-1', JSON.stringify(b1));
  const q = db.prepare(`SELECT created_at FROM sync_queue WHERE order_id = 'k-1'`).get();
  ok('F7: a sale from a till the server knows is relayed to the cloud', !!q);
  ok('F5: the relay is stamped ISO (it no longer sorts ahead of the server\'s own sales)', /^\d{4}-\d{2}-\d{2}T/.test(q?.created_at ?? ''), q?.created_at);
  const s2 = await post('/node/sync', { device_id: 'dev-K', branch_id: 'br-1', tables: { orders: [relayRow('k-2', 'dev-K', 2)] } }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': WRONG });
  ok('F7: a wrong key is refused — the branch code alone no longer speaks as that till', s2.status === 401 && !db.prepare(`SELECT 1 FROM orders WHERE id = 'k-2'`).get());
  const s3 = await post('/node/sync', { device_id: 'dev-K', branch_id: 'br-1', tables: { orders: [relayRow('k-3', 'dev-K', 3)] } });
  ok('…and so is no key, for a till that has one', s3.status === 401);
  const s4 = await post('/node/sync', { device_id: 'dev-K', branch_id: 'br-1', tables: { orders: [] } }, { 'X-Device-Id': 'dev-OTHER', 'X-Device-Token': KEY });
  ok('…and a request naming two different tills', s4.status === 401);
  const s5 = await post('/node/sync', { device_id: 'dev-OLD', branch_id: 'br-1', tables: { orders: [relayRow('old-1', 'dev-OLD', 1)] } });
  ok('F7 back-compat: an older till with no key at all still syncs', s5.status === 200 && !!db.prepare(`SELECT 1 FROM orders WHERE id = 'old-1'`).get());
  ok('…but a device id first seen in that request gets no relay to the cloud', !db.prepare(`SELECT 1 FROM sync_queue WHERE order_id = 'old-1'`).get());

  // /node/changes — staff, with the server's roles.
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('roles_cache', ?, ?)`).run(JSON.stringify([
    { id: '11111111-1111-1111-1111-111111111111', name: 'Cashier', permissions: [{ key: 'orders.create' }] },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Manager', permissions: [{ key: 'staff.manage' }, { key: 'orders.void' }] },
  ]), new Date().toISOString());
  const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const staff = (n, role, extra = {}) => ({ id: uuid(n), entity: 'staff', op: 'create', entity_id: uuid(n + 500), data: { name: `P${n}`, role_id: role, pin: '4321' },
    made_at: new Date().toISOString(), _local: { role_name: 'Owner', permissions: { '*': true }, branch_id: 'br-1' }, ...extra });
  const c0 = await post('/node/changes', { changes: [staff(1, '11111111-1111-1111-1111-111111111111')] });
  ok('F7: /node/changes needs a till that proves which it is', c0.status === 401);
  // A496: a relayed NEW cashier (it carries a PIN) is no longer created here — it reaches the server from the cloud. The
  // F7 rule (the role from the server's roles, never the change) is checked on a relayed role change of someone on the list.
  db.prepare(`INSERT OR REPLACE INTO branch_staff (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, status, updated_at)
              VALUES (?, 'P2', 'Waiter', 'br-1', '{}', 'x', 'active', '2026-10-14')`).run(uuid(502));
  const roleChange = (n, target, role) => ({ id: uuid(n), entity: 'staff', op: 'update', entity_id: target, data: { role_id: role },
    made_at: new Date().toISOString(), _local: { role_name: 'Owner', permissions: { '*': true }, branch_id: 'br-1' } });
  const c1 = await post('/node/changes', { changes: [roleChange(2, uuid(502), '11111111-1111-1111-1111-111111111111'), staff(3, '22222222-2222-2222-2222-222222222222')] }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': KEY });
  const cb = await c1.json();
  const p2 = db.prepare(`SELECT role_name, permissions FROM branch_staff WHERE staff_id = ?`).get(uuid(502));
  ok('F7: a relayed cashier gets the role\'s permissions from the server\'s roles — never the "*" the change claimed',
    c1.status === 200 && p2?.role_name === 'Cashier' && JSON.parse(p2.permissions)['*'] === undefined && JSON.parse(p2.permissions)['orders.create'] === true, JSON.stringify({ cb, p2 }));
  ok('F7: a relayed change never creates a manager', !db.prepare(`SELECT 1 FROM branch_staff WHERE staff_id = ?`).get(uuid(503)) && cb.refused?.some((r) => r.id === uuid(3)));
  const c2b = await (await post('/node/changes', { changes: [staff(4, '11111111-1111-1111-1111-111111111111')] }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': KEY })).json();
  ok('A496: …nor a cashier (a new person carries a PIN — it comes from the cloud)',
    !db.prepare(`SELECT 1 FROM branch_staff WHERE staff_id = ?`).get(uuid(504)) && c2b.refused?.some((r) => r.id === uuid(4)), JSON.stringify(c2b));
  db.prepare(`INSERT OR REPLACE INTO branch_staff (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, status, updated_at)
              VALUES ('mgr-1', 'Boss', 'Manager', 'br-1', '{"staff.manage":true}', 'x', 'active', '2026-10-14')`).run();
  const v = BS.vetRelayedStaffChanges([{ id: uuid(9), entity: 'staff_pin', op: 'update', entity_id: 'mgr-1', data: { pin: '9999' } }], 'br-1');
  ok('F7: a relayed PIN change never touches a manager\'s PIN', v.accepted.length === 0 && v.refused.length === 1);

  // F16: PIN checks.
  db.prepare(`DELETE FROM branch_staff`).run();
  const bcrypt = require(path.join(here, '..', 'node_modules', 'bcryptjs'));
  BS.storeBranchStaff('br-1', [{ staff_id: 'u-c1', name: 'Cash One', role_name: 'Cashier', permissions: {}, pin_hash: bcrypt.hashSync('2468', 4), override_pin_hash: null, status: 'active' }]);
  const pinNoKey = await post('/node/verify-pin', { pin: '2468', branch_id: 'br-1' });
  ok('F7: an older till (no key) gets "unavailable" (503) for PINs — it falls back to its own copy, never a final no', pinNoKey.status === 503);
  NS._resetPinAttempts();
  const pinOk = await post('/node/verify-pin', { pin: '2468', branch_id: 'br-1' }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': KEY });
  const pinBody = await pinOk.json();
  ok('F16: the PIN check (async bcrypt) still answers', pinOk.status === 200 && pinBody.staff?.name === 'Cash One', JSON.stringify(pinBody));
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await post('/node/verify-pin', { pin: '0000', branch_id: 'br-1' }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': KEY })).status;
  ok('F16: more than 10 PINs a minute from one till are refused (429)', last === 429, String(last));
  ok('…per till: another till is not held up', NS.pinAttemptAllowed('dev-OTHER-TILL') === true);
  NS._resetPinAttempts();
  for (let i = 0; i < 10; i++) NS.pinAttemptAllowed('x', 1000);
  ok('…and a minute later it may try again', NS.pinAttemptAllowed('x', 1000) === false && NS.pinAttemptAllowed('x', 62_000) === true);
  ok('F16: the server answers with bcrypt.compare (it no longer freezes on compareSync)', /await verifyPinAtNodeAsync\(pin, branchId\)/.test(read('src/main/nodeServer.ts'))
    && /await bcrypt\.compare\(pin, hash\)/.test(read('src/main/branchStaff.ts')));

  // F15
  const t = await (await realFetch(`${NODE}/node/time`, { headers: { 'X-Node-Secret': SECRET } })).json();
  ok('F15: the server says its time zone too', t.tz_offset === new Date().getTimezoneOffset() && !!t.now);

  // F14: a body over the limit is answered 413 by name.
  let s413 = 0;
  try { s413 = (await post('/node/sync', { device_id: 'dev-K', branch_id: 'br-1', tables: { orders: [{ blob: 'y'.repeat(5_200_000) }] } }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': KEY })).status; }
  catch { s413 = -1; }
  ok('F14: a batch over 5 MB is answered 413 (not a cut connection the till reads as "unreachable")', s413 === 413, String(s413));

  // F12: ack over HTTP with uid and device.
  const ins = B.createCloseInstruction('dev-K', { business_date: '2026-10-14', counted_cash: null }, 'u-m');
  const poll = await (await post('/node/instructions/poll', { device_id: 'dev-K', branch_id: 'br-1' }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': KEY })).json();
  const mine = poll.instructions.find((x) => x.id === ins.id);
  await post('/node/instructions/ack', { instruction_id: ins.id, instruction_uid: mine.uid, device_id: 'dev-K', ok: true }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': KEY });
  ok('F12: the till\'s ack (uid + device) retires its instruction', db.prepare(`SELECT status FROM node_instructions WHERE id = ?`).get(ins.id).status === 'acked');
  const pollBad = await post('/node/instructions/poll', { device_id: 'dev-K', branch_id: 'br-1' }, { 'X-Device-Id': 'dev-K', 'X-Device-Token': WRONG });
  ok('F7: another till\'s instructions are not handed to a wrong key', pollBad.status === 401);

  // Join: the grant carries the till's own key.
  J._resetJoins();
  const jr = await (await realFetch(`${NODE}/node/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_id: 'dev-NEW', name: 'FRONT' }) })).json();
  await J.answerJoin(jr.id, true, async () => ({ cloud_url: 'https://x', business_id: 'bz', branch_id: 'br-1', branch_name: 'T', code: 'ABCDEFGHJK', node_secret: SECRET }));
  const js = await (await realFetch(`${NODE}/node/join/status?id=${jr.id}&token=${jr.token}`)).json();
  ok('F7: a till allowed to join gets its own device key with the grant', /^[0-9a-f]{64}$/.test(js.grant?.device_token ?? '') && !('device_id' in js), JSON.stringify(js).slice(0, 200));
  ok('…which the server knows (and only its hash is kept)', I.checkDeviceKey('dev-NEW', js.grant.device_token) === 'ok'
    && !JSON.stringify(db.prepare(`SELECT * FROM node_device_keys`).all()).includes(js.grant.device_token));
  NS.stopNodeServer();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nThe till side, and wiring\n');
{
  C.saveDeviceConfig({ ...C.getDeviceConfig(), device_role: 'till', node_url: 'http://127.0.0.1:9', node_secret: 'S' });
  const h = NC.nodeHeaders();
  ok('F7: a till sends its id and its own key with the branch code', h['X-Device-Id'] === 'dev-S' && /^[0-9a-f]{64}$/.test(h['X-Device-Token']) && h['X-Node-Secret'] === 'S');
  ok('…the same key every time (made once)', NC.nodeHeaders()['X-Device-Token'] === h['X-Device-Token']);
  ok('…and neither the gateway nor the renewal relay passes it to the cloud', /'x-device-token'/.test(read('src/main/nodeGateway.ts'))
    && /k\.toLowerCase\(\) !== 'x-device-token'/.test(read('src/main/nodeServer.ts')));
  const out = await NC.pushRowsToNode({ orders: [] });
  ok('F3: an unreachable server is "transport", never a refusal', out.kind === 'transport');
  asNode();

  const idx = read('src/main/index.ts');
  ok('F10: replication has its own 15 s beat, independent of the cloud', /setInterval\(\(\) => \{ void nodeReplicationTick\(\); \}, 15_000\);/.test(idx));
  ok('F12: the peer loop acks by uid', /ackNodeInstruction\(ins\.id, ack, undefined, ins\.uid \?\? null\)/.test(idx));
  const se = read('src/main/syncEngine.ts');
  ok('F10: the sync pass and the beat share one single-flight run', /export function replicateToNode\(\)/.test(se) && /if \(_nodePushInFlight\) return _nodePushInFlight;/.test(se));
  ok('F15: the till compares time zones and says so', /tzMismatch/.test(se) && /time zone/.test(se));
  const ipc = read('src/main/ipcHandlers.ts');
  ok('F2: a rejoin re-arms the outbox; the join keeps the till\'s key', /rearmNodeOutbox\(\);/.test(ipc) && /setNodeDeviceToken\(String\(g\.device_token\)\)/.test(ipc));
  ok('Network note on the Tech page and the setup screen', /not the customer Wi-Fi/.test(read('src/renderer/pages/TechPage.tsx')) && /not the customer Wi-Fi/.test(read('src/renderer/pages/InstallPage.tsx')));
  // A521: with { freshStaff: true } — the list just stored is the cloud's (a relayed staff change it shows is done).
  ok('P3: storeBranchStaff lays waiting changes over every stored list', /overlayLocalChanges\(db(, \{ freshStaff: true \})?\)/.test(read('src/main/branchStaff.ts')));

  // P3: join notices capped.
  J._resetJoins();
  const heard = [];
  J.onJoinAsked((r) => heard.push(r));
  for (let i = 0; i < 4; i++) J.createJoinRequest({ device_id: 'spam', name: 'SPAM' }, '10.9.9.9', 1000 + i);
  ok('P3: asking again and again from one address raises one notice a minute', heard.length === 1 && J.pendingJoins(1010).length === 1);
  for (let i = 0; i < 6; i++) J.createJoinRequest({ device_id: `d${i}`, name: 'N' }, `10.8.0.${i}`, 2000);
  ok('…and a few a minute in all', heard.length <= J.MAX_NOTICES_PER_MINUTE, String(heard.length));
  J.onJoinAsked(null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
