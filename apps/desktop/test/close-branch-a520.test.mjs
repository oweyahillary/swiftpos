// A520 — Close Branch never deadlocks on a till it cannot hear from; the server's Close page is Close Branch alone; the
// branch totals' cash arithmetic; Close Day and Close Branch as two rights.
// Owner, 2026-10-17, KRUNCH & CO (all on 1.0.15: a branch server + T1, T2 Center, T3 Left): tills locked ("Trading day
// 2026-10-15 was never closed on this till"), the server's Close Branch refused ("Center (T2) has not been heard from in
// the last 2 minutes; Left (T3) …") — "why does the server lock day closing yet there is no trading happening … it has not
// heard from the till leading to a deadlock? this is not good"; "Server should not have close day, it should have close
// branch only"; and (rights) "break close day and close branch as two, supervisor can have close day but not branch, a
// manager can both".
//
// Drives the REAL compiled dist/main (branchClose, dayService, shiftService, nodeServer over real HTTP, the IPC handlers)
// on a REAL SQLite file, electron shimmed. This machine is the branch server; the tills' reports arrive as the node records
// them, and a till's own side (its report, its close instruction) is run by switching this machine's identity to it.
//
//   cd apps/desktop && npm run build:main && node test/close-branch-a520.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - assessBranchClose blocking every stale till with its day open again   → "the deadlock: stale tills with only an open
//     day do not hold the close" fails
//   - collectInstructions without the wait_for_till exception               → "…kept beyond 24 h" fails
//   - the stale open-drawer line without "switch it on"                      → "a stale till with a drawer open still
//     blocks, saying what to do" fails
//   - reportDayState rethrowing                                              → "a locked till still reports" fails
//   - managerNav giving the server Close Day                                 → "server Close page tabs" fails
//   - closeBranch on shifts.close_day again                                  → "a supervisor (close_day only) cannot close
//     the branch" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A520_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, A520_TS: '1' } });
  process.exit(r.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a520-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.18', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).startsWith('http://127.0.0.1') ? realFetch(url, init) : Promise.reject(new TypeError('fetch failed')));

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
db.prepare(`INSERT INTO users (id, name) VALUES ('u-mary', 'Mary'), ('u-amos', 'Amos'), ('u-sup', 'Sue')`).run();
const signIn = (id, name, role, perms) => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-17T06:00:00Z')`).run(id, name, role, JSON.stringify(perms));
const MANAGER = { 'catalogue.v2': true, 'shifts.close_day': true, 'shifts.close_branch': true, 'shifts.confirm': true, 'orders.create': true, 'shifts.cash_movements': true, 'menu.edit': true };
const SUPERVISOR = { 'catalogue.v2': true, 'shifts.close_day': true, 'shifts.confirm': true, 'orders.create': true };
const B = require(path.join(dist, 'branchClose.js'));
const S = require(path.join(dist, 'shiftService.js'));
const Dy = require(path.join(dist, 'dayService.js'));
const NS = require(path.join(dist, 'nodeServer.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const state = (o) => ({ business_date: '2026-10-15', day_open: true, open_drawer: null, drawers_on_day: 0, cashiers_counted_total: 0,
  shifts: [], clock: iso(), ...o });
const peer = (id, st, msAgo) => db.prepare(`INSERT OR REPLACE INTO node_peer_state (device_id, state, updated_at) VALUES (?, ?, ?)`).run(id, JSON.stringify(st), iso(msAgo));
const confirmedShift = (id, who) => ({ id, cashier_name: who, opened_at: iso(9e6), closed_at: iso(8e6), state: 'confirmed', orders: 2, sales: 1000,
  by_method: { cash: 1000 }, expected: { cash: 3500 }, methods: ['cash'], declared: null,
  cash: { opening_float: 2500, cash_sales: 1000, float_in: 0, float_out: 0, expenses: 0 }, confirmed: { by_name: 'Mary', at: iso(7e6), counted: { cash: 3500 } } });

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nThe deadlock — tills not heard from, with only an open day\n');
signIn('u-mary', 'Mary', 'Manager', MANAGER);
const HOUR = 3_600_000;
peer('dev-T2', state({ terminal: { code: 'T2', name: 'Center' }, business_date: '2026-10-15', shifts: [confirmedShift('sh-t2', 'Amos')] }), 3 * HOUR);
peer('dev-T3', state({ terminal: { code: 'T3', name: 'Left' }, business_date: '2026-10-12' }), 3 * HOUR);
{
  const ov = await H['branchClose:overview'](null);
  ok('the deadlock: stale tills with only an open day do not hold the close (KRUNCH: "has not been heard from")',
    ov.close && ov.close.blockers.length === 0, JSON.stringify(ov.close));
  ok('…they are "not connected" — their day closes when they next connect',
    ov.close.held.map((h) => h.label).sort().join('|') === 'Center (T2)|Left (T3)', JSON.stringify(ov.close.held));
  ok('…the screen shows the server\'s rule (no blocker list of its own) and the "not connected" line',
    /ov\.close\?\.blockers/.test(read('src/renderer/pages/BranchCloseTab.tsx')) && /not connected; its day/.test(read('src/renderer/pages/BranchCloseTab.tsx'))
    && !/has not been heard from in the last 2 minutes/.test(read('src/renderer/pages/BranchCloseTab.tsx')));
  const r = await H['branchClose:closeBranch'](null, { totals_confirmed: true });
  ok('Close Branch closes: each unheard till gets a close that waits for it',
    r.ok === true && r.results.filter((x) => x.held).map((x) => x.device_id).sort().join() === 'dev-T2,dev-T3', JSON.stringify(r));
  const row = db.prepare(`SELECT payload FROM node_instructions WHERE device_id = 'dev-T3' AND kind = 'close_day' AND status = 'pending'`).get();
  ok('…marked wait_for_till, with no count (each till closes with its confirmed shifts\' cash)',
    JSON.parse(row.payload).wait_for_till === true && JSON.parse(row.payload).counted_cash === null, row?.payload);
  const later = B.collectInstructions('dev-T3', Date.now() + 3 * 86_400_000);
  ok('…kept beyond 24 h: collected three days later, never expired',
    later.some((i) => i.kind === 'close_day' && i.payload.wait_for_till === true)
    && db.prepare(`SELECT status FROM node_instructions WHERE device_id = 'dev-T3' AND kind = 'close_day'`).get().status === 'pending');
  B.createCloseInstruction('dev-P9', { business_date: '2026-10-17', counted_cash: null }, 'u-mary');
  B.collectInstructions('dev-P9', Date.now() + 25 * HOUR);
  ok('…an ordinary close still expires after 24 h (F11 kept)',
    db.prepare(`SELECT status FROM node_instructions WHERE device_id = 'dev-P9'`).get().status === 'expired');
  const ov2 = await H['branchClose:overview'](null);
  const t3 = ov2.tills.find((t) => t.device_id === 'dev-T3');
  ok('the card: its close is pending and waits for the till (the screen says "not connected — its day closes when it next connects")',
    t3.instruction.status === 'pending' && t3.instruction.payload.wait_for_till === true
    && /not connected — its day closes when it next connects/.test(read('src/renderer/pages/BranchCloseTab.tsx')));
  const again = await H['branchClose:closeBranch'](null, { totals_confirmed: true });
  ok('the next evening\'s close is not held by it either — a newer close replaces the waiting one (one per till)',
    again.ok === true && db.prepare(`SELECT count(*) AS n FROM node_instructions WHERE device_id = 'dev-T3' AND kind = 'close_day' AND status = 'pending'`).get().n === 1, JSON.stringify(again));
}

console.log('\nThe till comes back and applies it — every old day it has open\n');
{
  const ins = B.collectInstructions('dev-T3', Date.now() + 2 * 86_400_000).find((i) => i.kind === 'close_day');
  asTill('dev-T3', 'T3', 'Left');
  const day = (id, date) => db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, opened_by, status, created_at, sync_status)
    VALUES (?, 'biz-1', 'br-1', 'dev-T3', 'T3', ?, ?, 'u-amos', 'open', ?, 'synced')`).run(id, date, iso(5 * 86_400_000), iso(5 * 86_400_000));
  day('bd-12', '2026-10-12');   // one open day per till (business_days_one_open_per_till)
  // A523: an old day with nothing left to count closes itself (dayService autoCloseEmptyDay) — this one has a shift the
  // cashier counted and no manager confirmed yet, so the till is locked on it as before; the shift is confirmed further
  // down, before the branch's close is applied.
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, closed_at, status, opening_float, closing_float, expected_cash,
      created_at, sync_status, device_id, terminal_code, business_day_id, declared_methods)
    VALUES ('sh-t3-12', 'biz-1', 'br-1', 'u-amos', ?, ?, 'closed', 0, 500, 500, ?, 'synced', 'dev-T3', 'T3', 'bd-12', '{"cash":500}')`)
    .run(iso(5 * 86_400_000), iso(5 * 86_400_000 - 3_600_000), iso(5 * 86_400_000));
  const gate = Dy.checkDayGate();
  ok('the till is locked on its oldest day — and the text says where a manager closes it (Close Day, or the server\'s Close Branch)',
    gate.canTrade === false && gate.needsManager && /2026-10-12/.test(gate.reason) && /Manager › Close › Close Day/.test(gate.reason) && /branch server/.test(gate.reason), gate.reason);
  const st = B.reportDayState();
  ok('a locked till still reports (its day, no drawer — the poll is never skipped)', st.day_open === true && st.business_date === '2026-10-12' && st.open_drawer === null && Array.isArray(st.shifts));
  ok('…the peer loop polls with reportDayState, whatever the day gate says',
    /pollNodeInstructions\(reportDayState\(\)\)/.test(read('src/main/index.ts')) && !/peerInstructionTick[\s\S]{0,400}checkDayGate/.test(read('src/main/index.ts')));
  // A523: the manager confirms that shift (on the till, the server or the web) — then the branch's waiting close applies.
  ok('(the shift on the old day is confirmed)', B.executeConfirmShift({ shift_id: 'sh-t3-12', counts: { cash: 500 }, confirmer: { id: 'u-mary', name: 'Mary' } }).ok === true);
  const ack = B.executeCloseDay(ins.payload);
  ok('applied on reconnect: it closes its old day (2026-10-12) with its confirmed shifts\' cash, noted as the branch\'s close',
    ack.ok && ack.summary.closedDate === '2026-10-12' && !Dy.getOpenDay()
    && /closed with the branch's/.test(db.prepare(`SELECT notes FROM business_days WHERE id = 'bd-12'`).get().notes ?? ''), JSON.stringify(ack));
  ok('…and the till may trade again (only a drawer to open)', Dy.checkDayGate().needsShift === true && !Dy.checkDayGate().needsManager);
  ok('…a second delivery answers "already closed"', B.executeCloseDay(ins.payload).already_closed === true);
  asServer();
  ok('…its ack retires the instruction', B.recordAck(ins.id, { ok: true }, { deviceId: 'dev-T3', uid: ins.uid }) === true);
}

console.log('\nA locked till reports over the real branch server\n');
{
  const SECRET = C.ensureNodeSecret();
  NS.startNodeServer();
  await new Promise((r) => setTimeout(r, 300));
  const NODE = `http://127.0.0.1:${NS.getNodePort()}`;
  db.prepare(`INSERT OR IGNORE INTO node_enrol_allowed (device_id, noted_at) VALUES ('dev-T2', ?)`).run(iso());
  asTill('dev-T2', 'T2', 'Center');
  db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, opened_by, status, created_at, sync_status)
    VALUES ('bd-t2', 'biz-1', 'br-1', 'dev-T2', 'T2', '2026-10-15', ?, 'u-amos', 'open', ?, 'synced')`).run(iso(2 * 86_400_000), iso(2 * 86_400_000));
  // A523: money on the old day (a drawer still open), so the till is locked — an empty one would have closed itself.
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id, terminal_code, business_day_id)
    VALUES ('sh-t2-15', 'biz-1', 'br-1', 'u-amos', ?, 'open', 0, ?, 'synced', 'dev-T2', 'T2', 'bd-t2')`).run(iso(2 * 86_400_000), iso(2 * 86_400_000));
  const locked = Dy.checkDayGate().needsManager === true;
  const body = { device_id: 'dev-T2', branch_id: 'br-1', state: B.reportDayState() };
  asServer();
  const res = await realFetch(`${NODE}/node/instructions/poll`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Node-Secret': SECRET, 'X-Device-Id': 'dev-T2', 'X-Device-Token': 'c'.repeat(64) }, body: JSON.stringify(body) });
  const got = await res.json();
  const row = db.prepare(`SELECT state, updated_at FROM node_peer_state WHERE device_id = 'dev-T2'`).get();
  ok('a locked till (day gate shut) still reports: the server records it, "last seen" just now',
    locked && res.status === 200 && Date.now() - Date.parse(row.updated_at) < 10_000 && JSON.parse(row.state).business_date === '2026-10-15', JSON.stringify({ status: res.status, got }));
  ok('…and it collects the close left for it', got.instructions.some((i) => i.kind === 'close_day' && i.payload.wait_for_till === true), JSON.stringify(got));
  NS.stopNodeServer?.();
}

console.log('\nMoney still holds the close — and the line says what to do\n');
{
  peer('dev-T2', state({ terminal: { code: 'T2', name: 'Center' }, open_drawer: { cashier_name: 'Mary' },
    shifts: [{ ...confirmedShift('sh-open', 'Mary'), state: 'open', confirmed: null, closed_at: null }] }), 3 * HOUR);
  peer('dev-T3', state({ terminal: { code: 'T3', name: 'Left' }, shifts: [{ ...confirmedShift('sh-aw', 'Amos'), state: 'awaiting', confirmed: null }] }), 3 * HOUR);
  const r = await H['branchClose:closeBranch'](null, { totals_confirmed: true });
  ok('a stale till with a drawer open still blocks, saying what to do',
    r.ok === false && r.blockers.includes('Center (T2) last reported a drawer open (Mary) — switch it on so it can close, or close that drawer on it'), JSON.stringify(r.blockers));
  ok('…and a stale till with a shift to confirm',
    r.blockers.some((b) => /^Left \(T3\) last reported 1 shift not confirmed yet — switch it on/.test(b)), JSON.stringify(r.blockers));
  peer('dev-T2', state({ terminal: { code: 'T2', name: 'Center' }, open_drawer: { cashier_name: 'Mary' }, shifts: [] }), 0);
  const r2 = await H['branchClose:closeBranch'](null, { totals_confirmed: true });
  ok('a connected till with a drawer open: "still has a drawer open (Mary)" (as before)',
    r2.blockers.includes('Center (T2) still has a drawer open (Mary)'), JSON.stringify(r2.blockers));
  peer('dev-T2', state({ day_open: false, business_date: null }), 3 * HOUR);
  peer('dev-T3', state({ day_open: false, business_date: null }), 3 * HOUR);
}

console.log('\nThe server used as a till — its own shift closes first\n');
{
  const sh = S.openShift(2500);
  const ov = await H['branchClose:overview'](null);
  ok('this terminal\'s open drawer comes first: "close its shift first"',
    ov.close.self_drawer?.shift_id === sh.id && ov.close.blockers.some((b) => /^This terminal \(branch server\): close its shift first \(Mary's drawer is open\)/.test(b)), JSON.stringify(ov.close));
  const tab = read('src/renderer/pages/BranchCloseTab.tsx');
  ok('…the screen offers "Close this terminal\'s shift" — the shift close everyone knows (ShiftPanel)',
    /This terminal: close its shift first/.test(tab) && /Close this terminal's shift/.test(tab) && /<ShiftPanel /.test(tab));
  S.closeShift(2500, undefined, null, {});
  const ov2 = await H['branchClose:overview'](null);
  ok('…closed, it waits for confirmation like any till\'s', !ov2.close.self_drawer && ov2.close.blockers.some((b) => /This terminal \(branch server\): 1 shift not confirmed yet/.test(b)), JSON.stringify(ov2.close));
  await H['branchClose:confirmShift'](null, { device_id: 'dev-S', shift_id: sh.id, counts: { cash: 2500 } });
  const r = await H['branchClose:closeBranch'](null, { totals_confirmed: true });
  ok('…confirmed, Close Branch closes the server\'s own day with the branch', r.ok === true && !Dy.getOpenDay(), JSON.stringify(r));
}

console.log('\nThe cash totals — 3 shifts × 2,500 float\n');
{
  // Three drawers, each opened with a 2,500 float, sold cash and M-Pesa, counted exactly what they hold and confirmed so.
  let n = 0;
  const sale = (shiftId, method, amount) => {
    const id = `o${++n}`;
    db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
                VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, ?, ?, 'synced', 'dev-S')`).run(id, id, amount, amount, shiftId, iso());
    db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(`p-${id}`, id, method, amount, amount, iso());
  };
  const cash = [2030, 2030, 2030], mpesa = [3700, 3710, 3710];
  const ids = new Set();   // this test's shifts only (the server's earlier one is on the same reopened day)
  const mine = () => B.ownDayState().shifts.filter((x) => ids.has(x.id));
  for (let i = 0; i < 3; i++) {
    const sh = S.openShift(2500); ids.add(sh.id);
    sale(sh.id, 'cash', cash[i]); sale(sh.id, 'mpesa', mpesa[i]);
    S.closeShift(2500 + cash[i], undefined, null, { mpesa: mpesa[i] });
    await H['branchClose:confirmShift'](null, { device_id: 'dev-S', shift_id: sh.id, counts: { cash: 2500 + cash[i], mpesa: mpesa[i] } });
  }
  const T = B.branchMethodTotals(mine());
  const c = T.methods.find((m) => m.method === 'cash'); const m = T.methods.find((x) => x.method === 'mpesa');
  ok('balanced drawers → balanced totals: cash sales 6,090, expected = confirmed = 6,090 + 3 × 2,500 = 13,590, variance 0',
    c.sales === 6090 && c.expected === 13590 && c.confirmed === 13590 && c.variance === 0, JSON.stringify(c));
  ok('…M-Pesa 11,120 / 11,120 / 11,120, balanced', m.sales === 11120 && m.expected === 11120 && m.confirmed === 11120 && m.variance === 0, JSON.stringify(m));
  ok('…the float is counted once per shift (Expected), never again per day', T.total.variance === 0 && T.shifts.confirmed === 3);
  // KRUNCH's 21,090 vs 13,590 (over 7,500): three MORE shifts opened at a float of 0 while the 2,500 stayed in the drawer.
  const extra = [];
  for (let i = 0; i < 3; i++) {
    const sh = S.openShift(0); ids.add(sh.id);
    S.closeShift(2500, 'float left in', null, {});
    await H['branchClose:confirmShift'](null, { device_id: 'dev-S', shift_id: sh.id, counts: { cash: 2500 } });
    extra.push(sh.id);
  }
  const T2 = B.branchMethodTotals(mine());
  const c2 = T2.methods.find((x) => x.method === 'cash');
  ok('the KRUNCH figures reproduced: 6 shifts, Expected 13,590, Confirmed 21,090, over 7,500 = the floats left in drawers opened at 0',
    c2.expected === 13590 && c2.confirmed === 21090 && c2.variance === 7500 && T2.shifts.all === 6, JSON.stringify(c2));
  const tab = read('src/renderer/pages/BranchCloseTab.tsx');
  ok('…the screen names those shifts ("opened with a float of 0 and counted … over")', /opened with a float of 0 and counted/.test(tab) && /data-testid="float-over"/.test(tab));
  ok('…and a blank opening float is no longer opened as 0 (ShiftPanel, like the Open drawer box)',
    /openingFloat\.trim\(\) === ''/.test(read('src/renderer/pages/ShiftPanel.tsx')) && !/posApi\.shift\.open\(Number\(openingFloat\) \|\| 0\)/.test(read('src/renderer/pages/ShiftPanel.tsx')));
}

console.log('\nTwo rights: Close the day, Close the branch\n');
{
  const P = require(path.join(dist, 'permissions.js'));
  const k = (key) => P.PERMISSIONS.find((p) => p.key === key);
  ok('the catalogue: shifts.close_branch "Close the branch" (till, manager default); close_day "Close the day"',
    k('shifts.close_branch')?.label === 'Close the branch' && k('shifts.close_branch').surface === 'till' && k('shifts.close_branch').manager === true
    && k('shifts.close_day').label === 'Close the day');
  ok('settings.manage (legacy) stands for both — nothing lost', P.expandKeys(['settings.manage']).has('shifts.close_branch') && P.expandKeys(['settings.manage']).has('shifts.close_day'));
  const role = (n) => P.BUILT_IN_ROLES.find((r) => r.name === n).keys;
  ok('built-in Manager both; Supervisor Close Day only', role('Manager').includes('shifts.close_branch') && role('Supervisor').includes('shifts.close_day') && !role('Supervisor').includes('shifts.close_branch'));
  signIn('u-sup', 'Sue', 'Supervisor', SUPERVISOR);
  const r = await H['branchClose:closeBranch'](null, { totals_confirmed: true });
  ok('a supervisor (close_day only) cannot close the branch', r.ok === false && /close the branch/i.test(r.error ?? ''), JSON.stringify(r));
  ok('…nor forget a till', (await H['branchClose:forgetTill'](null, { device_id: 'dev-T2' })).ok === false);
  ok('…but still reads the overview (the server\'s expense form needs the drawers)', !!(await H['branchClose:overview'](null)).tills);
  signIn('u-mary', 'Mary', 'Manager', MANAGER);
}

console.log('\nThe server\'s Close page — Close Branch alone\n');
{
  const N = await import(pathToFileURL(path.join(here, '..', 'src/renderer/lib/managerNav.ts')).href);
  const base = { isRestaurant: true, canOverview: true, canOrders: true, canItems: true, canShifts: true, canExpenses: true,
    canCloseDay: true, canCloseBranch: true, canMenu: true, canOffers: true, canSettings: true, canPrinting: true, canStaff: true, showStock: true };
  const close = (a) => N.buildManagerNav(a).find((g) => g.key === 'close')?.tabs.map((t) => t.key).join(',') ?? '';
  ok('server Close page tabs: Close Branch only', close({ ...base, isBranchServer: true }) === 'branchclose');
  ok('a plain till keeps Close Day (and Close Branch)', close({ ...base, isBranchServer: false }) === 'dayclose,branchclose');
  ok('a supervisor on a till: Close Day, no Close Branch', close({ ...base, canCloseBranch: false }) === 'dayclose');
  ok('a supervisor on the server: no Close page', close({ ...base, canCloseBranch: false, isBranchServer: true }) === '');
  const mp = read('src/renderer/pages/ManagerPage.tsx');
  ok('ManagerPage passes the role and the right; "Close day now" on the server lands on Close Branch',
    /canCloseBranch: has\('shifts\.close_branch'\)/.test(mp) && /isBranchServer,/.test(mp) && /active === 'dayclose'[\s\S]{0,80}setActive\('branchclose'\)/.test(mp));
}

console.log('\nChanges not taken by the cloud — the manager can read and clear them\n');
{
  const LC = require(path.join(dist, 'localChanges.js'));
  LC.ensureTable(db);
  db.prepare(`INSERT INTO local_changes (id, entity, op, entity_id, base, data, made_by, made_by_name, made_at, state, message, tries, updated_at)
    VALUES ('lc1', 'category', 'create', 'c1', NULL, '{"name":"Snacks"}', 'u-mary', 'Mary', ?, 'refused', 'That name is taken', 1, ?)`).run(iso(), iso());
  const before = (await H['manage:changeStates'](null)).filter((x) => x.state === 'refused');
  const r = await H['manage:dismissRefusedChanges'](null);
  const after = (await H['manage:changeStates'](null)).filter((x) => x.state === 'refused');
  ok('a refused change lists its reason; "Clear refused" removes it', before.length === 1 && before[0].message === 'That name is taken' && r.ok && r.cleared === 1 && after.length === 0, JSON.stringify({ before, r }));
  ok('…the banner says what they are and offers the clear', /Clear refused/.test(read('src/renderer/components/TillChangesNotice.tsx')) && /the cloud's value stands/.test(read('src/renderer/components/TillChangesNotice.tsx')));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
