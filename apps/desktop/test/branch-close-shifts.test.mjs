// A452 — Close Branch on the branch server, rebuilt around the shifts.
// Owner, 2026-10-12 (screenshot: "This till's open trading day is 2026-10-11, not 2026-10-12. Check the clocks before
// closing centrally"): "I thought it would show running shifts per till like the shift report, and when a cashier closes
// a shift the manager gets a confirm shift just like on the till … when all shifts are closed and confirmed they get a
// close branch … all tills reset to a new day and the server time is the final time"; "let the manager see what the
// system holds … the variance before confirming"; expenses: "what payment method was used, a filter to payment method,
// who paid, and a subtotal per method".
//
// Drives the REAL compiled dist/main (branchClose, shiftService, dayService, the IPC handlers) on a REAL SQLite file,
// electron shimmed. This machine is the branch server (and a till); another till is a peer whose report arrives as the
// node records it.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/branch-close-shifts.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - ownDayState without the shifts                         → "each till reports its shifts" fails
//   - executeCloseDay refusing another date again           → "yesterday's day closes with the branch" fails
//   - closeBranch not checking for shifts to confirm        → "Close branch waits for every shift" fails
//   - the confirm instruction not sent to the peer          → "a peer's shift is confirmed by an instruction" fails
//   - counted_cash null not taken from the confirmed counts → "no second count: the confirmed cash" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a452-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.9', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };   // no cloud: all of this works on the branch

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-S', 'biz-1', 'Pizza House', '2026-10-12T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-amira', 'Amira'), ('u-mary', 'Mary')`).run();
const signIn = (id, name, role, perms = '{}') => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-12T06:00:00Z')`).run(id, name, role, perms);
let n = 0;
const sale = (shiftId, method, amount) => {
  const id = `o${++n}`;
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, ?, ?, 'synced', 'dev-S')`).run(id, id, amount, amount, shiftId, new Date().toISOString());
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`p-${id}`, id, method, amount, amount, new Date().toISOString());
};

const S = require(path.join(dist, 'shiftService.js'));
const Dy = require(path.join(dist, 'dayService.js'));
const B = require(path.join(dist, 'branchClose.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;

console.log('\nEach till reports its shifts, live\n');
signIn('u-amira', 'Amira', 'cashier');
const sh = S.openShift(500);
sale(sh.id, 'cash', 1000); sale(sh.id, 'mpesa', 700);
{
  const st = B.ownDayState().shifts?.find((s) => s.id === sh.id);
  ok('each till reports its shifts — the running one with its sales so far, like the shift report',
    st?.state === 'open' && st.cashier_name === 'Amira' && st.orders === 2 && st.sales === 1700
    && st.by_method.cash === 1000 && st.by_method.mpesa === 700 && st.expected.cash === 1500, JSON.stringify(st));
}
// The day was opened yesterday and never closed (the owner's two tills): its date is the 11th.
db.prepare(`UPDATE business_days SET business_date = '2026-10-11' WHERE status = 'open'`).run();
S.closeShift(1450, 'short 50', null, { mpesa: 700 });   // Amira counts 1,450 cash (50 short) and 700 M-Pesa
{
  const st = B.ownDayState().shifts?.find((s) => s.id === sh.id);
  ok('closed by the cashier: it waits for a manager, with what the till expects per method (cash 1,500, M-Pesa 700)',
    st?.state === 'awaiting' && st.expected.cash === 1500 && st.expected.mpesa === 700 && JSON.stringify(st.methods) === '["cash","mpesa"]', JSON.stringify(st));
  ok('…the cash it expects is explained (float 500 + cash sales 1,000)', st?.cash.opening_float === 500 && st.cash.cash_sales === 1000);
  // 'confirm_shows_cashier_figures' is a standard switch (on unless the owner turned it off): the manager sees them too.
  ok('…with the cashier\'s own count beside it (the standard "show managers the cashier\'s figures")',
    st?.declared?.cash === 1450 && st.declared.mpesa === 700, JSON.stringify(st?.declared));
}

console.log('\nThe branch server\'s screen\n');
signIn('u-mary', 'Mary', 'manager', '{"*":true}');
const now = () => new Date().toISOString();
const peerShift = { id: 'sh-peer', cashier_name: 'Brian', opened_at: now(), closed_at: null, state: 'open', orders: 3, sales: 900,
  by_method: { cash: 900 }, expected: { cash: 1100 }, methods: ['cash'], declared: null,
  cash: { opening_float: 200, cash_sales: 900, float_in: 0, float_out: 0, expenses: 0 }, confirmed: null };
B.recordPeerState('dev-P', { business_date: '2026-10-12', day_open: true, open_drawer: { cashier_name: 'Brian' }, drawers_on_day: 0,
  cashiers_counted_total: 0, shifts: [peerShift], clock: now() });
{
  const ov = await H['branchClose:overview'](null);
  const peer = ov.tills.find((t) => t.device_id === 'dev-P');
  ok('the screen lists every till with its shifts (this one, and the peer as it reported)',
    ov.tills.length === 2 && ov.tills[0].is_self && ov.tills[0].state.shifts.some((s) => s.id === sh.id) && peer.state.shifts[0].cashier_name === 'Brian');
  const r = await H['branchClose:closeBranch'](null, {});
  ok('Close branch waits for every shift: a drawer still open and a shift to confirm are named',
    r.ok === false && r.blockers.some((b) => /Brian's drawer is still open|still has a drawer open \(Brian\)/.test(b)) && r.blockers.some((b) => /1 shift not confirmed yet/.test(b)), JSON.stringify(r));
  ok('…and nothing was closed', !!Dy.getOpenDay());
}
{
  const r = await H['branchClose:confirmShift'](null, { device_id: 'dev-S', shift_id: sh.id, counts: { cash: 1480, mpesa: 700 }, reasons: { cash: 'found 30 under the tray' } });
  const row = db.prepare(`SELECT confirmed_methods, expected_methods, confirmed_by FROM shifts WHERE id = ?`).get(sh.id);
  ok('the manager confirms this till\'s shift here — recorded with what the till expected',
    r.ok && r.self && JSON.parse(row.confirmed_methods).cash === 1480 && JSON.parse(row.expected_methods).cash === 1500 && row.confirmed_by === 'u-mary', JSON.stringify({ r, row }));
  const again = B.executeConfirmShift({ shift_id: sh.id, counts: { cash: 1 }, confirmer: { id: 'u-mary', name: 'Mary' } });
  ok('asked again, it answers done (not a second confirmation)', again.ok && again.already === true && JSON.parse(db.prepare(`SELECT confirmed_methods FROM shifts WHERE id = ?`).get(sh.id).confirmed_methods).cash === 1480);
}
{
  const r = await H['branchClose:confirmShift'](null, { device_id: 'dev-P', shift_id: 'sh-peer', counts: { cash: 1100 } });
  const ins = B.collectInstructions('dev-P');
  ok('a peer\'s shift is confirmed by an instruction the peer collects (its own books record it)',
    r.ok && r.instruction_id && ins.some((i) => i.kind === 'confirm_shift' && i.payload.shift_id === 'sh-peer' && i.payload.counts.cash === 1100 && i.payload.confirmer.name === 'Mary'), JSON.stringify(ins));
  const theirs = B.executeConfirmShift({ shift_id: 'sh-peer', counts: { cash: 1100 }, confirmer: { id: 'u-mary', name: 'Mary' } });
  ok('a till asked to confirm a shift it does not hold says so (the reason reaches the screen)', theirs.ok === false && !!theirs.error);
  signIn('u-amira', 'Amira', 'cashier');
  const c = await H['branchClose:confirmShift'](null, { device_id: 'dev-P', shift_id: 'sh-peer', counts: { cash: 1 } });
  ok('a cashier cannot confirm from the server', c.ok === false && /manager/i.test(c.error ?? ''));
  signIn('u-mary', 'Mary', 'manager', '{"*":true}');
}
{
  B.recordPeerState('dev-P', { business_date: '2026-10-12', day_open: true, open_drawer: null, drawers_on_day: 1, cashiers_counted_total: 1100,
    clock: now() });   // an older till: no shifts in its report
  const r = await H['branchClose:closeBranch'](null, {});
  ok('a till on an older version is named (it cannot report its shifts)', r.ok === false && r.blockers.some((b) => /older version/.test(b)), JSON.stringify(r));
}

console.log('\nClose branch: every till, the server\'s date\n');
{
  B.recordPeerState('dev-P', { business_date: '2026-10-12', day_open: true, open_drawer: null, drawers_on_day: 1, cashiers_counted_total: 1100,
    shifts: [{ ...peerShift, state: 'confirmed', closed_at: now() }], clock: now() });
  const dayBefore = Dy.getOpenDay();
  const r = await H['branchClose:closeBranch'](null, {});
  const closed = db.prepare(`SELECT business_date, status, counted_cash FROM business_days WHERE id = ?`).get(dayBefore.id);
  ok('every shift closed and confirmed: the branch closes', r.ok === true, JSON.stringify(r));
  ok('yesterday\'s day closes with the branch (no "check the clocks" refusal)', closed.status === 'closed' && closed.business_date === '2026-10-11', JSON.stringify(closed));
  ok('no second count: the day\'s cash is the confirmed shift count (1,480)', Number(closed.counted_cash) === 1480, JSON.stringify(closed));
  const ins = B.collectInstructions('dev-P').filter((i) => i.kind === 'close_day');
  ok('the peer is asked to close its day the same way (no count of its own)', ins.length === 1 && ins[0].payload.counted_cash === null, JSON.stringify(ins));
}
{
  // The peer side of that close: a till still on an older day closes it too, with its confirmed counts.
  const r = B.executeCloseDay({ business_date: '2026-10-13', counted_cash: null });
  ok('a till with no day open answers "already closed"', r.ok && r.already_closed === true);
}

console.log('\nExpenses: how it was paid, who paid\n');
{
  db.prepare(`INSERT INTO expenses (id, business_id, branch_id, description, amount, paid_by, expense_date, created_at, sync_status, payment_method, expense_type_name, device_id)
    VALUES ('e1', 'biz-1', 'br-1', 'Gas refill', 1200, 'u-mary', '2026-10-12', ?, 'pending', 'mpesa', 'Utilities', 'dev-S')`).run(new Date().toISOString());
  const r = await H['expense:range'](null, { preset: 'today' });
  const e = r.rows.find((x) => x.id === 'e1');
  ok('the till\'s expense list says how each was paid, its type and who paid', e?.payment_method === 'mpesa' && e.expense_type_name === 'Utilities' && e.paid_by === 'u-mary' && e.paid_by_name === 'Mary', JSON.stringify(e));
  const tab = read('src/renderer/pages/ManagerPage.tsx');
  ok('…the screen filters by method and by who paid, with a subtotal per method while filtered',
    /data-testid="expense-filter-method"/.test(tab) && /data-testid="expense-filter-payer"/.test(tab) && /filtered && rows\.length > 0 && \(\s*<div data-testid="expense-method-subtotals"/.test(tab));
  const web = fs.readFileSync(path.join(here, '..', '..', 'dashboard', 'src', 'pages', 'expenses', 'ExpensesPage.tsx'), 'utf8');
  ok('…and so does the web\'s Expenses page', /data-testid="expense-filter-method"/.test(web) && /data-testid="expense-filter-payer"/.test(web) && /data-testid="expense-method-subtotals"/.test(web));
}

console.log('\nThe wiring\n');
{
  const idx = read('src/main/index.ts');
  ok('a till carries out the server\'s "confirm this shift"', /if \(ins\.kind === 'confirm_shift'\) \{[\s\S]{0,300}executeConfirmShift\(ins\.payload\)/.test(idx));
  const tab = read('src/renderer/pages/BranchCloseTab.tsx');
  ok('the server\'s confirm form shows what the till expects and the variance as typed',
    /data-testid=\{`expected-\$\{c\}`\}/.test(tab) && /data-testid=\{`variance-\$\{c\}`\}/.test(tab) && /posApi\.branchClose\.confirmShift\(/.test(tab));
  const cloudShifts = fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'routes', 'shifts.ts'), 'utf8');
  ok('the web\'s confirm (another till\'s shift, online) shows the expected figures too — to a manager or the owner only',
    /const expected = shift && callerMayConfirm\(req\) \? await expectedByMethod\(shift as any\) : null;/.test(cloudShifts));
  ok('Close branch is one button, held until nothing stands in the way', /disabled=\{closing \|\| blockers\.length > 0 \|\| dayOpen\.length === 0 \|\| waitingClose\.length > 0\}/.test(tab));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
