// offline-reversal.test.mjs — 0.6.30 (A336 stage 3): void and refund while the till cannot reach the cloud.
//
// Owner, 2026-10-01: "Void window yes let it remain 30 min but i thing we can add a feature for owner to either increase
// or reduce the threshold but default is 30, we will set it to manager only not cashier … for offline we will let the
// owner decide the refund method in the managers setting which methods are allow we need to add that to the web also.
// scope leave it to till own sales but let it be a feature on the owners page also".
//
// Runs the BUILT main process (dist/main) against a real SQLite file, with a stand-in cloud for the replay.
//
// MUTATIONS TO CONFIRM BITE:
//   - voidWindowOpen ignores the owner                                  → "the owner voids at any age" fails
//   - reverseOffline skips the window                                   → "past the owner's window: refused" fails
//   - offlineRefundBlockedMethods allows every method                   → "an M-Pesa sale is not refunded offline" fails
//   - offlineScopeAllows ignores the setting                            → "a web sale: only with the owner's setting" fails
//   - mayReverseLocal lets a cashier                                    → "a cashier cannot" fails
//   - the push replays before the sale is on the cloud                  → "waits for the sale itself" fails
//   - replayOutcome treats ALREADY_VOIDED as a refusal                  → "a lost answer: done" fails
//   - the handler goes offline on any error (source pin)                → "only when the cloud cannot be reached" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0630-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const R = require(path.join(dist, 'reversalRules.js'));
const O = require(path.join(dist, 'offlineReversal.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const threw = (f) => { try { f(); return null; } catch (e) { return e; } };

console.log('0.6.30 — offline void / refund\n');

// ── The rules (shared/reversalRules.ts) ──────────────────────────────────────
const d = R.parseReversalRules(null);
ok('defaults: 30 minutes, cash only, the till\'s own sales', d.voidWindowMinutes === 30
  && JSON.stringify(d.offlineRefundMethods) === '["cash"]' && d.offlineReverseWebSales === false);
const stored = R.parseReversalRules([{ key: 'void_window_minutes', value: '"45"' }, { key: 'offline_refund_methods', value: '["cash","MPESA"]' },
  { key: 'offline_reverse_web_sales', value: 'true' }]);
ok('stored settings are read whatever their JSON wrapping', stored.voidWindowMinutes === 45
  && JSON.stringify(stored.offlineRefundMethods) === '["cash","mpesa"]' && stored.offlineReverseWebSales === true, JSON.stringify(stored));
ok('a bad value falls back to the default (never no window)', R.parseReversalRules({ void_window_minutes: '0' }).voidWindowMinutes === 30
  && R.parseReversalRules({ void_window_minutes: 99999 }).voidWindowMinutes === 30 && R.parseReversalRules({ void_window_minutes: 'abc' }).voidWindowMinutes === 30);
ok('the cloud stores only an accepted value', R.reversalSettingValue('void_window_minutes', 60) === '60'
  && R.reversalSettingValue('void_window_minutes', -5) === null && R.reversalSettingValue('offline_refund_methods', ['cash', 'card']) === '["cash","card"]'
  && R.reversalSettingValue('offline_reverse_web_sales', 'yes') === null && R.reversalSettingValue('receipt_footer', 'x') === null);
ok('the window: a manager within it, the owner at any age', R.voidWindowOpen(30, d, false) && !R.voidWindowOpen(31, d, false) && R.voidWindowOpen(500, d, true));
ok('a refund offline: every leg must be an allowed method', R.offlineRefundBlockedMethods([{ method: 'cash' }], d).length === 0
  && JSON.stringify(R.offlineRefundBlockedMethods([{ method: 'cash' }, { method: 'mpesa' }], d)) === '["mpesa"]');
ok('the window label', R.windowLabel(30) === '30 minutes' && R.windowLabel(60) === '1 hour' && R.windowLabel(90) === '1 hour 30 minutes');

// ── The till ─────────────────────────────────────────────────────────────────
const db = L.getLocalDb();
ok('local schema 61: pending_reversals and device_config.reversal_rules', L.LOCAL_SCHEMA_VERSION >= 61
  && db.prepare(`PRAGMA table_info(pending_reversals)`).all().length > 0
  && db.prepare(`PRAGMA table_info(device_config)`).all().some((c) => c.name === 'reversal_rules'));
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B', '2026-10-01T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
ok('until told: the defaults', C.getReversalRules().voidWindowMinutes === 30);
C.setReversalRules({ voidWindowMinutes: 20, offlineRefundMethods: ['cash'], offlineReverseWebSales: false });
ok('the pulled rules are kept on the till', C.getReversalRules().voidWindowMinutes === 20);
C.setReversalRules(undefined);
ok('an older cloud (no rules sent): the till keeps what it had', C.getReversalRules().voidWindowMinutes === 20);
C.saveDeviceConfig({ device_name: 'Front' });
ok('a config save never touches the owner\'s rules', C.getReversalRules().voidWindowMinutes === 20);

const NOW = new Date('2026-10-01T12:00:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
let n = 0;
const sale = (legs, { age = 5, origin = null, synced = true } = {}) => {
  const id = `ord-${++n}`;
  const total = legs.reduce((s, l) => s + l.amount, 0);
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, created_at, device_id, sync_status, origin)
    VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, ?, 'dev-T1', ?, ?)`).run(id, `T1-${n}`, total, total, minsAgo(age), synced ? 'synced' : 'pending', origin);
  for (const l of legs) db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, status, created_at, sync_status)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, 'synced')`).run(`${id}-${l.method}`, id, l.method, l.amount, l.amount, minsAgo(age));
  return id;
};
const manager = { id: 'u-mary', name: 'Mary', roleName: 'manager', permissions: { 'orders.void': true } };
const owner = { id: 'u-owner', name: 'Owner', roleName: 'owner', permissions: { '*': true } };
const cashier = { id: 'u-amy', name: 'Amy', roleName: 'cashier', permissions: {} };
const rules = { voidWindowMinutes: 20, offlineRefundMethods: ['cash'], offlineReverseWebSales: false };
const go = (kind, orderId, approver = manager, actor = manager, r = rules) =>
  O.reverseOffline({ kind, orderId, reason: 'Wrong items ordered', actor, approver, rules: r, deviceId: 'dev-T1', now: NOW }, db);
const status = (id) => db.prepare(`SELECT status, refunded_at, refunded_amount FROM orders WHERE id=?`).get(id);
const queued = (id) => db.prepare(`SELECT * FROM pending_reversals WHERE order_id=?`).all(id);

const a = sale([{ method: 'cash', amount: 1000 }], { age: 10 });
go('void', a);
ok('a void within the window: the sale is voided here and queued with its approver',
  status(a).status === 'voided' && queued(a).length === 1 && queued(a)[0].approved_by === 'u-mary' && queued(a)[0].kind === 'void', JSON.stringify(queued(a)));
const b = sale([{ method: 'cash', amount: 1000 }], { age: 25 });
const eB = threw(() => go('void', b));
ok('past the owner\'s window: refused, nothing changed (and it says refund instead)',
  /past the 20 minutes void window\. Refund it instead\./.test(eB?.message ?? '') && status(b).status === 'completed' && queued(b).length === 0, eB?.message);
go('void', b, owner);
ok('the owner voids at any age', status(b).status === 'voided');
const c = sale([{ method: 'cash', amount: 1000 }]);
ok('a cashier cannot (signed in or as approver)',
  /Only a manager or the owner/.test(threw(() => go('void', c, manager, cashier))?.message ?? '')
  && /PIN was not recognised/.test(threw(() => go('void', c, cashier, manager))?.message ?? '') && status(c).status === 'completed');
const dd = sale([{ method: 'cash', amount: 600 }, { method: 'mpesa', amount: 400 }], { age: 120 });
const eD = threw(() => go('refund', dd));
ok('an M-Pesa sale is not refunded offline (cash only allowed) — and the message says which',
  /refund only cash\. This sale was paid by M-Pesa/.test(eD?.message ?? '') && !status(dd).refunded_at, eD?.message);
go('refund', dd, manager, manager, { ...rules, offlineRefundMethods: ['cash', 'mpesa'] });
const pays = db.prepare(`SELECT method, amount FROM payments WHERE order_id=? AND status='refunded' ORDER BY method`).all(dd);
ok('allowed by the owner: refunded here, each leg in its own method, queued',
  status(dd).refunded_amount === 1000 && pays.length === 2 && pays[0].amount === -600 && pays[1].amount === -400
  && queued(dd)[0]?.kind === 'refund' && queued(dd)[0]?.amount === 1000, JSON.stringify(pays));
ok('a second refund is refused', /already been refunded/.test(threw(() => go('refund', dd))?.message ?? ''));
const w = sale([{ method: 'cash', amount: 500 }], { origin: 'web' });
ok('a web sale: only with the owner\'s setting', /only void or refund the sales it rang itself/.test(threw(() => go('void', w))?.message ?? '')
  && status(w).status === 'completed');
go('void', w, manager, manager, { ...rules, offlineReverseWebSales: true });
ok('…and with it, voided', status(w).status === 'voided');
const unsynced = sale([{ method: 'cash', amount: 300 }], { synced: false });
go('void', unsynced);
ok('a sale not on this till: refused', threw(() => go('void', 'nope'))?.message === O.OFFLINE_NOT_ON_TILL);

// ── The replay ───────────────────────────────────────────────────────────────
ok('a lost answer: done', O.replayOutcome('void', 400, { code: 'ALREADY_VOIDED' }) === 'done'
  && O.replayOutcome('refund', 400, { code: 'ALREADY_REFUNDED' }) === 'done');
ok('refused only for good', O.replayOutcome('void', 403, { code: 'NOT_AN_APPROVER' }) === 'refused'
  && O.replayOutcome('void', 404, {}) === 'retry' && O.replayOutcome('void', 503, {}) === 'retry'
  && O.replayOutcome('void', 403, { error: 'Forbidden', detail: 'Missing permission: orders.void' }) === 'retry');

const seen = [];
let answer = (u) => ({ status: 200, body: { ok: true } });
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/\/api\/orders\/[^/]+\/(void|refund)$/.test(u)) {
    seen.push({ u, body: JSON.parse(init.body) });
    const r = answer(u);
    return json(r.status, r.body);
  }
  if (u.endsWith('/api/sync/push')) return json(200, { ok: true, upserted: { shifts: 0, floats: 0, expenses: 0, businessDays: 0, kitchenVoids: 0 }, rejected: [] });
  return json(404, { error: 'not here' });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');
await E.syncPush();
const sentFor = (id) => seen.filter((s) => s.u.includes(`/api/orders/${id}/`));
ok('the replay names the approver, the time and who did it', sentFor(a).length === 1
  && sentFor(a)[0].body.offline_approved_by === 'u-mary' && sentFor(a)[0].body.approved_at === NOW.toISOString()
  && sentFor(a)[0].body.offline_by === 'u-mary' && sentFor(a)[0].body.reason === 'Wrong items ordered', JSON.stringify(sentFor(a)));
ok('a refund goes to /refund', sentFor(dd).length === 1 && sentFor(dd)[0].u.endsWith('/refund'));
ok('waits for the sale itself (an unsynced sale is not replayed yet)', sentFor(unsynced).length === 0
  && queued(unsynced)[0].sync_status === 'pending');
ok('accepted: marked synced', queued(a)[0].sync_status === 'synced' && queued(dd)[0].sync_status === 'synced');
ok('the sync status counts what is waiting', (E.getSyncStatus().pendingBreakdown?.reversals ?? 0) === 1);
db.prepare(`UPDATE orders SET sync_status='synced' WHERE id=?`).run(unsynced);
answer = () => ({ status: 403, body: { error: 'The person who approved this may not approve voids or refunds.', code: 'NOT_AN_APPROVER' } });
await E.syncPush();
ok('refused by the cloud: parked with its words, not retried forever', queued(unsynced)[0].sync_status === 'refused'
  && /may not approve/.test(queued(unsynced)[0].last_error ?? '') && (E.getSyncStatus().parkedCount ?? 0) >= 1, JSON.stringify(queued(unsynced)));

// ── The wiring (source) ──────────────────────────────────────────────────────
const ipc = src('main/ipcHandlers.ts');
ok('only when the cloud cannot be reached (no network, a gateway error, an offline sign-in)',
  /\} catch \{\s*return reverseWhileOffline\('void', String\(orderId\), reason, approvalPin\);/.test(ipc)
  && /if \(cloudUnreachable\(res\.status\)\) return reverseWhileOffline\('refund'/.test(ipc)
  && /const cloudUnreachable = \(status: number\) => status === 502 \|\| status === 503 \|\| status === 504;/.test(ipc)
  && /if \(offlineSessionNow\(\)\) return reverseWhileOffline\('void'/.test(ipc));
ok('the approver\'s PIN: the branch node, else this till\'s saved sign-ins; a manager or the owner only',
  /async function identifyApproverOffline\(pin: string\)/.test(ipc) && /verifyPinOffline\(pin, branchId\)/.test(ipc)
  && /if \(!mayReverseLocal\(p\)\) throw new Error\(NOT_AN_APPROVER\);/.test(ipc));
ok('the owner\'s rules go to the cloud from Manager → Settings and apply here at once',
  /manageFetch\('\/api\/business\/settings', 'POST', \{ key, value: JSON\.parse\(clean\) \}\)/.test(ipc) && /setReversalRules\(\{/.test(ipc));
ok('History and the void window follow the owner\'s window', /reverseAction\(o, Date\.now\(\), voidWindowMin\)/.test(src('renderer/pages/POSPage.tsx'))
  && /windowMin=\{voidWindowMin\}/.test(src('renderer/pages/POSPage.tsx')) && /const isExpired = ageMin > windowMin;/.test(src('renderer/components/VoidModal.tsx')));
ok('Manager → Settings: the owner edits, everyone else reads', /isOwner=\{String\(staff\?\.role \?\? ''\)\.toLowerCase\(\) === 'owner'\}/.test(src('renderer/pages/ManagerPage.tsx'))
  && /const locked = !isOwner \|\| busy;/.test(src('renderer/components/ReversalRulesPanel.tsx')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
