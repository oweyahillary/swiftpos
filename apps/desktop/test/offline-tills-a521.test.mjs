// A521 — nothing may wait on a till that is switched off (the till / branch-server side).
// Owner, 2026-10-17: "check if anything will break or fail to respond because a till has not responded, I know not all
// tills will run 24/7". The rule: act on what is known; never wait on an absent till; queue the rest for when it
// reconnects with no short expiry; where money is involved a manager may go ahead with a clear warning naming whose cash
// is not in tonight's totals.
//
// Drives the REAL compiled dist/main (branchClose, dayService, shiftService, nodeIngest, localChanges, branchStaff,
// deviceConfig, remoteShiftClose, the IPC handlers) on a REAL SQLite file, electron shimmed (safeStorage as identity, so
// PINs check for real with bcrypt). This machine is the branch server; a till's own side is run by switching identity.
//
//   cd apps/desktop && npm run build:main && node test/offline-tills-a521.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main and re-running):
//   - unresolvedBlockers ignoring the ticks (return a.blockers)              → "#1 …ticked, the branch closes without T2" fails
//   - sweepInstructions without the stale upgrade                            → "#2 a close to a till that went off waits for it" fails
//   - recordAck without the wait path                                        → "#1 …'not yet' keeps the close pending" fails
//   - hideTill calling forgetDeviceKey                                       → "#3 Hide keeps its device key" fails
//   - NO_TTL_KINDS emptied                                                   → "#13 a confirmation … still pending after 3 days" fails
//   - freezeExpired always false                                             → "#7 past 12 h … the freeze lifts" fails
//   - overlayLocalChanges without 'relayed'                                  → "#6 the server's next pull no longer wipes it" fails
//   - retryPeerQuarantine giving up at 12 attempts again                     → "#21 still waiting after 3 days" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A521_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A521_TS: '1' } });
  process.exit(r.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a521-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.18', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('E:' + s), decryptString: (b) => b.toString().replace(/^E:/, '') },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
globalThis.fetch = async () => Promise.reject(new TypeError('fetch failed'));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

process.env.SWIFTPOS_NODE_PORT = String(41000 + Math.floor(Math.random() * 15000));
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-S', 'biz-1', 'KRUNCH & CO', '2026-10-17T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
const asServer = () => C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.invalid', branch_id: 'br-1',
  device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server', node_url: null });
const asTill = (id, code, name) => C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.invalid', branch_id: 'br-1',
  device_id: id, device_role: 'till', terminal_code: code, device_name: name, node_url: 'http://127.0.0.1:1' });
asServer();
db.prepare(`INSERT INTO users (id, name) VALUES ('u-mary', 'Mary'), ('u-eug', 'Eugene'), ('u-amos', 'Amos')`).run();
const signIn = (id, name, role, perms) => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-17T06:00:00Z')`).run(id, name, role, JSON.stringify(perms));
const MANAGER = { 'catalogue.v2': true, 'shifts.close_day': true, 'shifts.close_branch': true, 'shifts.confirm': true, 'orders.create': true, 'shifts.cash_movements': true };
const B = require(path.join(dist, 'branchClose.js'));
const S = require(path.join(dist, 'shiftService.js'));
const Dy = require(path.join(dist, 'dayService.js'));
const I = require(path.join(dist, 'nodeIngest.js'));
const LC = require(path.join(dist, 'localChanges.js'));
const BS = require(path.join(dist, 'branchStaff.js'));
const R = require(path.join(dist, 'remoteShiftClose.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const HOUR = 3_600_000;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const hhmm = (s) => { const d = new Date(s); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const state = (o) => ({ business_date: '2026-10-17', day_open: true, open_drawer: null, drawers_on_day: 0, cashiers_counted_total: 0, shifts: [], clock: iso(), ...o });
const peer = (id, st, msAgo) => db.prepare(`INSERT OR REPLACE INTO node_peer_state (device_id, state, updated_at) VALUES (?, ?, ?)`).run(id, JSON.stringify(st), iso(msAgo));
const shiftOf = (id, who, st) => ({ id, cashier_name: who, opened_at: iso(9e6), closed_at: st === 'open' ? null : iso(8e6), state: st, orders: 2, sales: 1000,
  by_method: { cash: 1000 }, expected: { cash: 3500 }, methods: ['cash'], declared: null,
  cash: { opening_float: 2500, cash_sales: 1000, float_in: 0, float_out: 0, expenses: 0 }, confirmed: null });
const pending = (dev, kind = 'close_day') => db.prepare(`SELECT * FROM node_instructions WHERE device_id = ? AND kind = ? AND status = 'pending' ORDER BY id DESC`).get(dev, kind);
signIn('u-mary', 'Mary', 'Manager', MANAGER);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#1 Close Branch closes what can be closed — a switched-off till with a drawer open is a manager\'s tick\n');
const t2Seen = 3 * HOUR;
peer('dev-T2', state({ terminal: { code: 'T2', name: 'Center' }, open_drawer: { cashier_name: 'Eugene' }, shifts: [shiftOf('sh-t2', 'Eugene', 'open')] }), t2Seen);
peer('dev-T1', state({ terminal: { code: 'T1', name: 'Front' } }), 5_000);
{
  const ov = await H['branchClose:overview'](null);
  const w = ov.close.without.find((x) => x.device_id === 'dev-T2');
  ok('#1 a stale till whose last report showed a drawer open: offered to close the branch without it',
    !!w && w.connected === false && ov.close.blockers.some((b) => /Center \(T2\) last reported a drawer open \(Eugene\)/.test(b)), JSON.stringify(ov.close));
  const at = hhmm(iso(t2Seen));
  ok('#1 …the warning names whose cash is not in tonight\'s totals, when it last reported, and when its day closes',
    w.warning === `Close the branch without Center (T2) — Center (T2) last reported Eugene's drawer open at ${at}; its cash is not in tonight's totals; Center (T2)'s day closes when that drawer is closed and confirmed`, w?.warning);
  const r0 = await H['branchClose:closeBranch'](null, { totals_confirmed: true });
  ok('#1 not ticked: nothing closes, and the answer carries the tick to offer (TILLS_WITH_MONEY)',
    r0.ok === false && r0.code === 'TILLS_WITH_MONEY' && r0.without?.[0]?.device_id === 'dev-T2', JSON.stringify(r0));
  Dy.ensureDayOpen?.();
  const sh = S.openShift(1000); S.closeShift(1000, undefined, null, {});
  await H['branchClose:confirmShift'](null, { device_id: 'dev-S', shift_id: sh.id, counts: { cash: 1000 } });
  ok('(the server has its own day open, its shift confirmed)', !!Dy.getOpenDay());
  const r = await H['branchClose:closeBranch'](null, { totals_confirmed: true, without_tills: ['dev-T2'] });
  ok('#1 ticked, the branch closes without T2: the server\'s own day closes, every connected till is sent its close',
    r.ok === true && !Dy.getOpenDay() && r.results.some((x) => x.device_id === 'dev-T1' && x.sent && !x.held), JSON.stringify(r));
  const t2 = pending('dev-T2');
  ok('#1 …and T2 is left a close that waits for its money (wait_for_till)', r.results.some((x) => x.device_id === 'dev-T2' && x.without) && JSON.parse(t2.payload).wait_for_till === true, t2?.payload);
  ok('#1 …the manager who went past is logged with the warning', /A521 manager .* went past/.test(read('src/main/ipcHandlers.ts')));

  // The till comes back with the drawer still open: "not yet", the close stays pending.
  asTill('dev-T2', 'T2', 'Center');
  db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, opened_by, status, created_at, sync_status)
    VALUES ('bd-t2', 'biz-1', 'br-1', 'dev-T2', 'T2', '2026-10-17', ?, 'u-eug', 'open', ?, 'synced')`).run(iso(10 * HOUR), iso(10 * HOUR));
  signIn('u-eug', 'Eugene', 'Cashier', { 'orders.create': true });
  const tsh = S.openShift(500);
  const ack1 = B.executeCloseDay(JSON.parse(t2.payload));
  ok('#1 on T2, with Eugene\'s drawer still open: "not yet" (wait), never a refusal', ack1.ok === false && ack1.wait === true, JSON.stringify(ack1));
  asServer();
  B.recordAck(t2.id, ack1, { deviceId: 'dev-T2', uid: t2.uid });
  ok('#1 …"not yet" keeps the close pending on the server (handed out again next poll), with the reason kept',
    pending('dev-T2')?.id === t2.id && JSON.parse(pending('dev-T2').ack).wait === true);
  asTill('dev-T2', 'T2', 'Center');
  S.closeShift(500, undefined, null, {});
  const ack2 = B.executeCloseDay(JSON.parse(t2.payload));
  ok('#1 drawer closed but not confirmed: still "not yet"', ack2.ok === false && ack2.wait === true, JSON.stringify(ack2));
  signIn('u-mary', 'Mary', 'Manager', MANAGER);
  S.confirmShift(tsh.id, { id: 'u-mary', name: 'Mary' }, { cash: 500 }, null);
  const ack3 = B.executeCloseDay(JSON.parse(t2.payload));
  ok('#1 …closed and confirmed: T2\'s day closes on that poll', ack3.ok === true && !Dy.getOpenDay(), JSON.stringify(ack3));
  asServer();
  B.recordAck(t2.id, ack3, { deviceId: 'dev-T2', uid: t2.uid });
  ok('#1 …and the close is retired', !pending('dev-T2'));
  ok('#1 an ordinary refusal still retires a close (no wait flag)', B.executeCloseDay({ business_date: '2099-01-01', counted_cash: -1 }).wait === undefined);

  // This terminal's own money is never gone past.
  Dy.ensureDayOpen?.();
  S.openShift(100);
  const r2 = await H['branchClose:closeBranch'](null, { totals_confirmed: true, without_tills: ['dev-S'] });
  ok('#1 this terminal\'s own open drawer can never be ticked past', r2.ok === false && r2.blockers.some((b) => /This terminal \(branch server\): close its shift first/.test(b)), JSON.stringify(r2));
  S.closeShift(100, undefined, null, {});
  const own = B.ownDayState().shifts.find((x) => x.state === 'awaiting');
  if (own) await H['branchClose:confirmShift'](null, { device_id: 'dev-S', shift_id: own.id, counts: { cash: 100 } });
  const tab = read('src/renderer/pages/BranchCloseTab.tsx');
  ok('#1 the screen: one tick per till with money, its warning as the label; the server applies the same rule',
    /data-testid="close-without"/.test(tab) && /\{w\.warning\}/.test(tab) && /closeBranch\(undefined, totalsOk, ticked\.map/.test(tab));
  peer('dev-T2', state({ terminal: { code: 'T2', name: 'Center' }, day_open: false, business_date: null }), 3 * HOUR);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#2 / #14 a close to a till that went off waits for it, and never holds the button\n');
{
  peer('dev-T4', state({ terminal: { code: 'T4', name: 'Bar' } }), 5_000);
  B.createCloseInstruction('dev-T4', { business_date: '2026-10-17', counted_cash: null }, 'u-mary');
  ok('#2 a close to a connected till is an ordinary one', JSON.parse(pending('dev-T4').payload).wait_for_till !== true);
  peer('dev-T4', state({ terminal: { code: 'T4', name: 'Bar' } }), 10 * 60_000);   // switched off before its poll
  B.collectInstructions('dev-T1');   // ANOTHER till's poll sweeps every till
  ok('#2 a close to a till that went off waits for it (the sweep runs for every till, on any poll)', JSON.parse(pending('dev-T4').payload).wait_for_till === true, pending('dev-T4')?.payload);
  B.sweepInstructions(Date.now() + 3 * 86_400_000);
  ok('#2 …still pending three days later', !!pending('dev-T4'));
  const tab = read('src/renderer/pages/BranchCloseTab.tsx');
  ok('#2 the Close branch button is never held by a till still to answer', !/waitingClose\.length > 0\}/.test(tab) && !/\|\| waitingClose\.length > 0/.test(tab));
  // #14: closeTill to a till that is off keeps it a waiting close (it replaced it with a 24-h one).
  const r = await H['branchClose:closeTill'](null, { device_id: 'dev-T4', counted_cash: 0 });
  ok('#14 a per-till close to a till that is off stays a close that waits for it — and says so',
    r.ok && r.queued_offline === true && JSON.parse(pending('dev-T4').payload).wait_for_till === true && /not connected — this applies when it reconnects/.test(r.message ?? ''), JSON.stringify(r));
  ok('#14 …one per till', db.prepare(`SELECT count(*) AS n FROM node_instructions WHERE device_id = 'dev-T4' AND kind = 'close_day' AND status = 'pending'`).get().n === 1);
  B.createCloseInstruction('dev-NEVER', { business_date: '2026-10-17', counted_cash: null }, 'u-mary');
  B.sweepInstructions(Date.now() + 25 * HOUR);
  ok('#2 an ordinary close to a till never heard from still expires after 24 h (F11 kept)',
    db.prepare(`SELECT status FROM node_instructions WHERE device_id = 'dev-NEVER'`).get().status === 'expired');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#13 confirmations and cash in / out wait for a till that is off — no 24-h expiry\n');
{
  peer('dev-T5', state({ terminal: { code: 'T5', name: 'Side' }, open_drawer: { cashier_name: 'Amos' },
    shifts: [shiftOf('sh-t5-aw', 'Amos', 'awaiting'), shiftOf('sh-t5-open', 'Amos', 'open')] }), 2 * HOUR);
  const c = await H['branchClose:confirmShift'](null, { device_id: 'dev-T5', shift_id: 'sh-t5-aw', counts: { cash: 3500 } });
  ok('#13 a confirmation sent to a till that is off: queued, and "applies when it reconnects"', c.ok && c.queued_offline === true && /applies when it reconnects/.test(c.message ?? ''), JSON.stringify(c));
  const m = await H['branchClose:shiftMoney'](null, { device_id: 'dev-T5', shift_id: 'sh-t5-open', kind: 'float_in', amount: 200, reason: 'change' });
  ok('#13 a cash in to a till that is off: queued too (it was refused), said so', m.ok && m.queued_offline === true, JSON.stringify(m));
  B.sweepInstructions(Date.now() + 3 * 86_400_000);
  ok('#13 a confirmation and a cash in are still pending after 3 days', !!pending('dev-T5', 'confirm_shift') && !!pending('dev-T5', 'shift_money'));
  ok('#13 …the kinds that never expire', JSON.stringify(B.NO_TTL_KINDS) === '["confirm_shift","shift_money"]');
  const ov = await H['branchClose:overview'](null);
  ok('#13 the waiting cash in shows on the screen however old (pending), with when it was picked up',
    ov.tills.find((t) => t.device_id === 'dev-T5').money.some((x) => x.id === m.instruction_id && 'delivered_at' in x));
  ok('#13 Cancel still withdraws it before the till picks it up', (await H['branchClose:cancelShiftMoney'](null, { instruction_id: m.instruction_id })).ok === true);
  db.prepare(`DELETE FROM node_instructions WHERE device_id = 'dev-T5'`).run();
  peer('dev-T5', state({ day_open: false, business_date: null }), 3 * HOUR);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#12 a till that never reported, or an older build, is held with a note — never a blocker\n');
{
  db.prepare(`INSERT OR REPLACE INTO peer_cursors (device_id, table_name, last_seq, updated_at) VALUES ('dev-GHOST', 'orders', 3, ?)`).run(iso(HOUR));
  peer('dev-OLD', { business_date: '2026-10-16', day_open: true, open_drawer: null, drawers_on_day: 1, cashiers_counted_total: 0 }, 2 * HOUR);
  const ov = await H['branchClose:overview'](null);
  const ghost = ov.close.held.find((h) => h.device_id === 'dev-GHOST');
  const old = ov.close.held.find((h) => h.device_id === 'dev-OLD');
  ok('#12 never reported → held with a note, not "has never reported in" as a blocker',
    ghost && ghost.close === false && /never reported/.test(ghost.note) && !ov.close.blockers.some((b) => /never reported/.test(b)), JSON.stringify(ov.close));
  ok('#12 an older build that is off → held with a note ("update it"), not a blocker',
    old && old.close === false && /older version/.test(old.note) && !ov.close.blockers.some((b) => /older version/.test(b)), JSON.stringify(ov.close));
  Dy.ensureDayOpen?.();
  const r = await H['branchClose:closeBranch'](null, { totals_confirmed: true });
  ok('#12 Close Branch closes with them there — and sends them nothing (an older build would close at a count of 0)',
    r.ok === true && !pending('dev-OLD') && !pending('dev-GHOST') && r.results.some((x) => x.device_id === 'dev-OLD' && x.skipped), JSON.stringify(r));
  peer('dev-OLD', { business_date: '2026-10-16', day_open: true, open_drawer: { cashier_name: 'Old' }, drawers_on_day: 1, cashiers_counted_total: 0 }, 2 * HOUR);
  const ov2 = await H['branchClose:overview'](null);
  ok('#12 an older build that last reported a drawer open: a tick, like any till with money', ov2.close.without.some((w) => w.device_id === 'dev-OLD'), JSON.stringify(ov2.close.without));
  db.prepare(`DELETE FROM node_peer_state WHERE device_id = 'dev-OLD'`).run();
  db.prepare(`DELETE FROM peer_cursors WHERE device_id = 'dev-GHOST'`).run();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#3 Hide from Close Branch keeps the till; Revoke this till lets it go\n');
{
  I.prepareDeviceEnrolment();
  db.prepare(`INSERT OR IGNORE INTO node_enrol_allowed (device_id, noted_at) VALUES ('dev-T6', ?)`).run(iso());
  const key = 'd'.repeat(64);
  ok('(T6 holds a key)', I.checkDeviceKey('dev-T6', key) === 'enrolled' && I.holdsDeviceKey('dev-T6'));
  peer('dev-T6', state({ terminal: { code: 'T6', name: 'Spare' }, day_open: true }), 5 * HOUR);
  B.createCloseInstruction('dev-T6', { business_date: '2026-10-17', counted_cash: null, wait_for_till: true }, 'u-mary');
  const ids = async () => (await H['branchClose:overview'](null)).tills.map((t) => t.device_id);
  const h = await H['branchClose:hideTill'](null, { device_id: 'dev-T6' });
  ok('#3 Hide takes it off the list now', h.ok && !(await ids()).includes('dev-T6'), JSON.stringify(h));
  ok('#3 Hide keeps its device key, its right to reconnect and the close waiting for it',
    I.holdsDeviceKey('dev-T6') && I.checkDeviceKey('dev-T6', key) === 'ok' && !!pending('dev-T6'));
  await new Promise((r) => setTimeout(r, 5));
  B.recordPeerState('dev-T6', state({ terminal: { code: 'T6', name: 'Spare' } }));
  ok('#3 …and it is listed again the moment it reports', (await ids()).includes('dev-T6'));
  ok('#3 Hide never the server itself', (await H['branchClose:hideTill'](null, { device_id: 'dev-S' })).ok === false);
  const f = await H['branchClose:forgetTill'](null, { device_id: 'dev-T6' });
  ok('#3 Revoke this till removes its key — it must join again', f.ok && !I.holdsDeviceKey('dev-T6') && I.checkDeviceKey('dev-T6', key) === 'unknown');
  const tab = read('src/renderer/pages/BranchCloseTab.tsx');
  ok('#3 the screen: "Hide from Close Branch" and "Revoke this till", the revoke warning saying it is refused until it joins again',
    /Hide from Close Branch/.test(tab) && /Revoke this till/.test(tab) && /until it joins again/.test(tab) && !/it comes back if it reports again/.test(tab));
  const ns = read('src/main/nodeServer.ts');
  ok('#3 the key-refused text says how to re-join (revoke at the server, then Find my server on the till)',
    /To re-join: on the branch server, Close Branch → Show tills → Revoke this till; then on this till, Find my server/.test(ns) && !/forget it there and let it reconnect/.test(ns));
  ok('#3 the bridge carries Hide', /'branchClose:hideTill'/.test(read('src/main/preload.ts')) && /'branchClose:hideTill'/.test(read('src/main/ipcSchemas.ts')));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#15 / #19 test-data clears before any push; the web\'s day close on a 90 s beat\n');
{
  const se = read('src/main/syncEngine.ts');
  const sa = se.slice(se.indexOf('export async function syncAll'), se.indexOf('export async function pullCatalogueNow'));
  ok('#15 syncAll: the clears come before the push', sa.indexOf('await runTestDataClears()') > 0 && sa.indexOf('await runTestDataClears()') < sa.indexOf('pushed = await runPushStages(errors)'));
  const once = se.slice(se.indexOf('async function runPushStagesOnce'));
  ok('#15 every push pass asks first (testClearsBeforePush — at most every 90 s)', once.indexOf("stage('test-data clears'") > 0 && once.indexOf("stage('test-data clears'") < once.indexOf("stage('shift push'"));
  const ix = read('src/main/index.ts');
  const step = ix.slice(ix.indexOf("name: 'push'"));
  ok('#15 the start-up push step asks before it sends anything (the branch server included)', step.indexOf('await testClearsBeforePush()') > 0 && step.indexOf('await testClearsBeforePush()') < step.indexOf('await nodeReplicationTick()'));
  const E = require(path.join(dist, 'syncEngine.js'));
  ok('#19 the remote day close has its own 90 s beat', E.REMOTE_CLOSE_BEAT_MS === 90_000 && /setInterval\(\(\) => \{ remoteCloseBeat\(\)/.test(ix));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#7 a stock-count freeze lifts by itself after 12 h unheard; a manager\'s PIN sells a frozen item\n');
{
  asTill('dev-T1', 'T1', 'Front');
  C.saveDeviceConfig({ node_url: null });
  const now = Date.now();
  C.setStockCountFreeze({ ref: 'ST-0009', productIds: ['p-coke'] }, now);
  ok('#7 the list is stamped when the cloud confirmed it', C.getStockCountFreeze(now).productIds.includes('p-coke') && !!C.getStockCountFreeze(now).heard_at);
  ok('#7 …in force for 11 h without hearing', C.getStockCountFreeze(now + 11 * HOUR).productIds.length === 1);
  ok('#7 past 12 h without the cloud confirming it, the freeze lifts by itself', C.getStockCountFreeze(now + 13 * HOUR).productIds.length === 0);
  C.setStockCountFreeze({ ref: 'ST-0009', productIds: ['p-coke'], heard_at: new Date(now - 13 * HOUR).toISOString() }, now);
  ok('#7 from a branch server\'s bundle the SERVER\'s time is kept — a server offline that long lifts it on its tills too', C.getStockCountFreeze(now).productIds.length === 0);
  C.setStockCountFreeze({ ref: 'ST-0009', productIds: ['p-coke'] }, now);
  const bcrypt = require(path.join(here, '..', 'node_modules', 'bcryptjs'));
  asServer();
  BS.storeBranchStaff('br-1', [
    { staff_id: 'u-mary', name: 'Mary', role_name: 'Manager', permissions: MANAGER, pin_hash: bcrypt.hashSync('4321', 4), override_pin_hash: null, status: 'active' },
    { staff_id: 'u-eug', name: 'Eugene', role_name: 'Cashier', permissions: { 'orders.create': true }, pin_hash: bcrypt.hashSync('1111', 4), override_pin_hash: null, status: 'active' },
  ]);
  signIn('u-eug', 'Eugene', 'Cashier', { 'orders.create': true });
  const bad = await H['pos:approveFrozenSale'](null, { pin: '1111', product_id: 'p-coke' });
  ok('#7 a cashier\'s PIN does not release it', bad.ok === false, JSON.stringify(bad));
  const good = await H['pos:approveFrozenSale'](null, { pin: '4321', product_id: 'p-coke' });
  ok('#7 a manager\'s PIN does', good.ok === true && good.approvedBy === 'Mary', JSON.stringify(good));
  const F = require(path.join(dist, 'stockCountFreeze.js'));
  ok('#7 the refusal says "or ask a manager"; the sale screen offers the PIN under it (no new banner)',
    /or ask a manager\.$/.test(F.frozenMessage('ST-0009', 'Coke')) && /data-testid="frozen-approve"/.test(read('src/renderer/pages/POSPage.tsx')) && /approveFrozenSale\(/.test(read('src/renderer/pages/POSPage.tsx')));
  signIn('u-mary', 'Mary', 'Manager', MANAGER);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#6 staff changes relayed through the server stay until the cloud has them, and the server forwards them\n');
{
  const secrets = { wrap: (s) => `raw:${s}`, unwrap: (s) => s.replace(/^raw:/, ''), seal: (s) => `E:${s}` };
  const bcrypt = require(path.join(here, '..', 'node_modules', 'bcryptjs'));
  const cloudList = (amosStatus = 'active', amosName = 'Amos') => [
    { staff_id: 'u-mary', name: 'Mary', role_name: 'Manager', permissions: MANAGER, pin_hash: bcrypt.hashSync('4321', 4), override_pin_hash: null, status: 'active' },
    { staff_id: 'u-amos', name: amosName, role_name: 'Cashier', permissions: {}, pin_hash: bcrypt.hashSync('2222', 4), override_pin_hash: null, status: amosStatus },
  ];
  BS.storeBranchStaff('br-1', cloudList());
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  db.prepare(`UPDATE branch_staff SET staff_id = ? WHERE staff_id = 'u-amos'`).run(id(900));
  const amos = () => db.prepare(`SELECT name, status FROM branch_staff WHERE staff_id = ?`).get(id(900));
  const list = (status, name) => cloudList(status, name).map((s) => (s.staff_id === 'u-amos' ? { ...s, staff_id: id(900) } : s));
  // T2 (no internet) deactivates Amos; it hands the change to the server, then is switched off.
  const deact = { id: id(1), entity: 'staff', op: 'update', entity_id: id(900), base: { status: 'active' }, data: { status: 'inactive' }, made_by: 'u-mary', made_by_name: 'Mary', made_at: iso() };
  const v = BS.vetRelayedStaffChanges([deact], 'br-1');
  LC.acceptRelayedChanges(db, v.accepted, secrets, 'dev-T2');
  ok('#6 applied on the server at once', amos().status === 'inactive');
  BS.storeBranchStaff('br-1', list('active'));
  ok('#6 the server\'s next pull from the cloud (Amos still active there) no longer wipes it', amos().status === 'inactive', JSON.stringify(amos()));
  db.prepare(`UPDATE local_changes SET updated_at = ? WHERE id = ?`).run(iso(8 * 86_400_000), id(1));
  const posted = [];
  const deps = (answer) => ({ post: async (c) => { posted.push(...c); return { ok: true, status: 200, json: async () => ({ results: c.map((x) => ({ id: x.id, status: answer })) }) }; }, state: async () => [], secrets });
  await LC.pushLocalChanges(db, deps('awaiting'));
  ok('#6 not dropped after 7 days while it waits', !!db.prepare(`SELECT 1 FROM local_changes WHERE id = ?`).get(id(1)));
  const fwd = posted.find((c) => c.id === id(1));
  ok('#6 the server forwards it to the cloud: the maker kept (the cloud checks the maker\'s own proof), the till it came from named',
    fwd && fwd.made_by === 'u-mary' && fwd.relayed_for === 'dev-T2' && fwd.data.status === 'inactive' && !('_relayed_for' in fwd.data), JSON.stringify(fwd));
  ok('#6 held for the owner by the cloud: still laid over every pull', db.prepare(`SELECT state FROM local_changes WHERE id = ?`).get(id(1)).state === 'relayed_awaiting'
    && (BS.storeBranchStaff('br-1', list('active')), amos().status === 'inactive'));
  BS.storeBranchStaff('br-1', list('inactive'));
  ok('#6 once the cloud\'s list shows it, it is done (no longer laid over)', db.prepare(`SELECT state FROM local_changes WHERE id = ?`).get(id(1)).state === 'done');
  // A relayed re-activation never beats the cloud's deactivation.
  const react = { id: id(2), entity: 'staff', op: 'update', entity_id: id(900), base: { status: 'inactive' }, data: { status: 'active', name: 'Amos K' }, made_by: 'u-mary', made_by_name: 'Mary', made_at: iso() };
  LC.acceptRelayedChanges(db, BS.vetRelayedStaffChanges([react], 'br-1').accepted, secrets, 'dev-T2');
  BS.storeBranchStaff('br-1', list('inactive'));
  ok('#6 a deactivation always wins over a relayed change still waiting (the rename stays, the re-activation waits for the cloud)',
    amos().status === 'inactive' && amos().name === 'Amos K', JSON.stringify(amos()));
  // A PIN change from a till: not applied here (A496), only forwarded.
  const pinCh = { id: id(3), entity: 'staff_pin', op: 'update', entity_id: id(900), data: { pin: '7777' }, made_by: 'u-mary', made_by_name: 'Mary', made_at: iso() };
  const vp = BS.vetRelayedStaffChanges([pinCh], 'br-1');
  const before = db.prepare(`SELECT pin_hash_enc FROM branch_staff WHERE staff_id = ?`).get(id(900)).pin_hash_enc;
  const nf = LC.acceptForwardOnly(db, vp.forward, secrets, 'dev-T2');
  ok('#6 a relayed PIN change is still never applied on the server (A496) — kept to forward',
    vp.accepted.length === 0 && nf === 1 && db.prepare(`SELECT pin_hash_enc FROM branch_staff WHERE staff_id = ?`).get(id(900)).pin_hash_enc === before
    && db.prepare(`SELECT state FROM local_changes WHERE id = ?`).get(id(3)).state === 'forward');
  posted.length = 0;
  await LC.pushLocalChanges(db, deps('applied'));
  const pf = posted.find((c) => c.id === id(3));
  ok('#6 …forwarded with its PIN, the maker named; applied → done', pf?.data?.pin === '7777' && pf.made_by === 'u-mary'
    && db.prepare(`SELECT state FROM local_changes WHERE id = ?`).get(id(3)).state === 'done', JSON.stringify(pf));
  const ns = read('src/main/nodeServer.ts');
  ok('#6 /node/changes keeps both, with the till it came from', /acceptRelayedChanges\(getLocalDb\(\), vetted\.accepted, nodeSecrets, who\.device\)/.test(ns) && /acceptForwardOnly\(getLocalDb\(\), vetted\.forward, nodeSecrets, who\.device\)/.test(ns));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#21 a row waiting on another till\'s data keeps trying for 7 days\n');
{
  const row = { id: 'o-late', business_id: 'biz-1', branch_id: 'br-OTHER', order_number: 'T9-1', status: 'completed', subtotal: 1, vat_amount: 0, total: 1,
    created_at: iso(), device_id: 'dev-T9', seq: 1 };
  const t0 = Date.now();
  I.quarantinePeerRow('dev-T9', 'orders', row, 'waiting', t0);
  const qr = () => db.prepare(`SELECT attempts, status FROM peer_quarantine WHERE row_id = 'o-late'`).get();
  let t = t0;
  while (t < t0 + 3 * 86_400_000) { t += HOUR + 1000; I.retryPeerQuarantine({ now: t }); }
  ok('#21 still waiting after 3 days of hourly tries (it gave up after ~6.5 h)', qr().status === 'waiting' && qr().attempts > I.QUARANTINE_MAX_ATTEMPTS, JSON.stringify(qr()));
  while (t < t0 + 7 * 86_400_000 + 2 * HOUR) { t += HOUR + 1000; I.retryPeerQuarantine({ now: t }); }
  ok('#21 …given up after 7 days, kept for the Tech page Retry', qr().status === 'given_up' && I.QUARANTINE_GIVE_UP_MS === 7 * 86_400_000);
  ok('#21 Retry gives it a fresh 7 days', I.rearmPeerQuarantine() >= 1 && qr().status === 'waiting');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n#9 / #10 the till keeps its own figures when the web closed its drawer\n');
{
  const [web] = R.closesToAdopt(['s1'], [{ id: 's1', status: 'closed', closed_at: iso(), close_method: 'web', closed_by: 'u-mary', closed_by_name: 'Mary',
    closing_float: '5000', cash_variance: '-500', expected_cash: '5500', notes: null }]);
  const c = R.keepOwnExpected(web, 6200);
  ok('#9 the till keeps its own expected cash (6,200 from its rows), the variance against it (5,000 − 6,200)',
    c.expected_cash === 6200 && c.cash_variance === -1200 && c.closing_float === 5000, JSON.stringify(c));
  ok('#9 …the web\'s figures recorded as the web\'s', /The web's figures: expected 5500, variance -500; this till expects 6200/.test(c.note), c.note);
  ok('#9 …no own figure → the web\'s, as before', R.keepOwnExpected(web, null).expected_cash === 5500);
  ok('#9 pullShiftCloses applies keepOwnExpected with the till\'s own Z report', /const c = keepOwnExpected\(web, own\);/.test(read('src/main/syncEngine.ts')) && /own = computeZReport\(web\.id\)\.totals\.expectedCash/.test(read('src/main/syncEngine.ts')));
  const E = require(path.join(dist, 'syncEngine.js'));
  E.noteCountKeptAfterClose('sh-x', 'close', { cash: 4800 }, { status: 'closed_unreconciled' });
  const kept = db.prepare(`SELECT value FROM maintenance_state WHERE key = 'count_kept_after_close:sh-x'`).get();
  ok('#10 a 409 over the till\'s own count: the count kept on record, never silently', kept && JSON.parse(kept.value).counts.cash === 4800);
  const se = read('src/main/syncEngine.ts');
  ok('#10 …on both the close and the confirmation 409', /noteCountKeptAfterClose\(shift\.id, 'close'/.test(se) && /noteCountKeptAfterClose\(r\.id, 'confirmation'/.test(se));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
