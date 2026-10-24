// A465 — a manager on the BRANCH SERVER records a cash in, cash out or expense on ANY running shift of the branch.
// Owner, 2026-10-13. The server never writes another till's row: it queues a 'shift_money' instruction; the till that
// holds the drawer records it on its own books (its device id) — its Z-report, its push and Close Branch stay one story.
//
// Drives the REAL compiled dist/main (branchClose, shiftService, the IPC handlers) on a REAL SQLite file, electron
// shimmed. This machine plays the branch server (and a till); a peer's report arrives as the node records it. Then the
// same machine is turned into a plain till to prove nothing changed there.
//
//   cd apps/desktop && npm run build:main && node test/server-drawer-money.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - executeShiftMoney without the row_id check            → "the same instruction twice records once" fails
//   - branchClose:shiftMoney without the server-role check  → "a plain till cannot" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8').replace(/\r\n/g, '\n');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a465-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  const sent = (global.__sent = []);
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.11', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return [{ isDestroyed: () => false, webContents: { send: (ch, p) => sent.push({ ch, p }) } }]; } static getFocusedWindow() { return null; } },
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
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-S', 'biz-1', 'Pizza House', '2026-10-13T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-S', device_role: 'node', terminal_code: 'S1', device_name: 'Server' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-amira', 'Amira'), ('u-mary', 'Mary')`).run();
// A490: a role's NAME decides nothing on the till — a manager is the permissions an older cloud sent a manager.
const A490_MANAGER = '{"orders.void":true,"settings.manage":true}';
const signIn = (id, name, role, perms = ['manager', 'supervisor'].includes(role) ? A490_MANAGER : '{}') => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-13T06:00:00Z')`).run(id, name, role, perms);
const sale = (() => { let n = 0; return (shiftId, method, amount) => {
  const id = `o${++n}`;
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, ?, ?, 'synced', 'dev-S')`).run(id, id, amount, amount, shiftId, new Date().toISOString());
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`p-${id}`, id, method, amount, amount, new Date().toISOString());
}; })();

const S = require(path.join(dist, 'shiftService.js'));
const B = require(path.join(dist, 'branchClose.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const mary = { id: 'u-mary', name: 'Mary' };
const expected = (id) => S.computeZReport(id).totals.expectedCash;

console.log('\nThe POS records what the server sent, on its own books\n');
signIn('u-amira', 'Amira', 'cashier');
const sh = S.openShift(500);
sale(sh.id, 'cash', 1000);
ok('to start: float 500 + cash sales 1,000', expected(sh.id) === 1500, String(expected(sh.id)));
{
  const r = B.executeShiftMoney({ row_id: 'r-in-1', shift_id: sh.id, kind: 'float_in', amount: 200, reason: 'change', approver: mary, recorded_by: mary });
  const row = db.prepare(`SELECT * FROM float_transactions WHERE id = 'r-in-1'`).get();
  ok('a cash in lands on the till\'s open shift — its id, this till\'s device, pending push — and expected cash goes up',
    r.ok && !r.already && row?.shift_id === sh.id && row.device_id === 'dev-S' && row.type === 'float_in' && row.sync_status === 'pending'
    && expected(sh.id) === 1700 && r.summary?.expected_cash === 1700, JSON.stringify({ r, row }));
  const again = B.executeShiftMoney({ row_id: 'r-in-1', shift_id: sh.id, kind: 'float_in', amount: 200, approver: mary });
  ok('the same instruction twice records once (answered done)',
    again.ok && again.already === true && db.prepare(`SELECT COUNT(*) AS n FROM float_transactions WHERE shift_id = ?`).get(sh.id).n === 1 && expected(sh.id) === 1700,
    JSON.stringify(again));
}
{
  const r = B.executeShiftMoney({ row_id: 'r-out-1', shift_id: sh.id, kind: 'float_out', amount: 300, reason: 'banked', approver: mary });
  const row = db.prepare(`SELECT approved_by, approved_by_name FROM float_transactions WHERE id = 'r-out-1'`).get();
  ok('a cash out comes off, approved by the server\'s manager', r.ok && expected(sh.id) === 1400 && row?.approved_by === 'u-mary' && row.approved_by_name === 'Mary', JSON.stringify(row));
}
{
  const r = B.executeShiftMoney({ row_id: 'r-exp-1', shift_id: sh.id, kind: 'expense', amount: 50, description: 'Gas refill', payment_method: 'cash', approver: mary, recorded_by: mary });
  const row = db.prepare(`SELECT * FROM expenses WHERE id = 'r-exp-1'`).get();
  ok('a cash expense lowers expected cash — on this shift, this till\'s device, approved, its business and branch',
    r.ok && expected(sh.id) === 1350 && row?.shift_id === sh.id && row.device_id === 'dev-S' && row.approved_by === 'u-mary'
    && row.payment_method === 'cash' && row.business_id === 'biz-1' && row.branch_id === 'br-1' && row.paid_by === 'u-mary', JSON.stringify(row));
  const m = B.executeShiftMoney({ row_id: 'r-exp-2', shift_id: sh.id, kind: 'expense', amount: 80, description: 'Delivery', payment_method: 'mpesa', approver: mary });
  ok('an M-Pesa expense is recorded but does not touch the cash', m.ok && expected(sh.id) === 1350
    && db.prepare(`SELECT payment_method FROM expenses WHERE id = 'r-exp-2'`).get()?.payment_method === 'mpesa');
  const twice = B.executeShiftMoney({ row_id: 'r-exp-1', shift_id: sh.id, kind: 'expense', amount: 50, description: 'Gas refill', approver: mary });
  ok('…an expense delivered twice records once', twice.ok && twice.already && db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE id = 'r-exp-1'`).get().n === 1);
}
{
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id)
              VALUES ('sh-other', 'biz-1', 'br-1', 'u-amira', ?, 'open', 0, ?, 'synced', 'dev-P')`).run(new Date().toISOString(), new Date().toISOString());
  const r = B.executeShiftMoney({ row_id: 'r-x', shift_id: 'sh-other', kind: 'float_in', amount: 10, approver: mary });
  ok('another till\'s shift (a replicated copy) is refused with the message', r.ok === false && r.error === B.SHIFT_MONEY_CLOSED
    && !db.prepare(`SELECT 1 FROM float_transactions WHERE id = 'r-x'`).get(), JSON.stringify(r));
  const bad = B.executeShiftMoney({ row_id: 'r-y', shift_id: sh.id, kind: 'float_in', amount: 0, approver: mary });
  const odd = B.executeShiftMoney({ row_id: 'r-z', shift_id: sh.id, kind: 'refund', amount: 5, approver: mary });
  ok('an amount of zero, or an unknown kind, is refused (never throws)', bad.ok === false && odd.ok === false);
}
ok('the till reports its name and code with its state (the server\'s lists name it)',
  B.ownDayState().terminal?.code === 'S1' && B.ownDayState().terminal?.name === 'Server');

console.log('\nThe branch server\'s IPC\n');
signIn('u-mary', 'Mary', 'manager', '{"*":true}');
const now = () => new Date().toISOString();
const peerShift = (state = 'open') => ({ id: 'sh-peer', cashier_name: 'Brian', opened_at: now(), closed_at: null, state, orders: 1, sales: 100,
  by_method: { cash: 100 }, expected: { cash: 300 }, methods: ['cash'], declared: null,
  cash: { opening_float: 200, cash_sales: 100, float_in: 0, float_out: 0, expenses: 0 }, confirmed: null });
const peerReport = (shifts) => B.recordPeerState('dev-P', { business_date: '2026-10-13', day_open: true, open_drawer: { cashier_name: 'Brian' },
  drawers_on_day: 0, cashiers_counted_total: 0, shifts, clock: now(), terminal: { code: 'T2', name: 'Bar POS' } });
{
  global.__sent.length = 0;
  const r = await H['branchClose:shiftMoney'](null, { device_id: 'dev-S', shift_id: sh.id, kind: 'float_in', amount: 100, reason: 'top-up' });
  ok('the server\'s own drawer: recorded at once, and its screens told to reload', r.ok && r.direct && expected(sh.id) === 1450
    && !!db.prepare(`SELECT 1 FROM float_transactions WHERE id = ?`).get(r.row_id) && global.__sent.some((x) => x.ch === 'shift:changedElsewhere'), JSON.stringify(r));
}
peerReport([peerShift('open')]);
let sentId;
{
  const r = await H['branchClose:shiftMoney'](null, { device_id: 'dev-P', shift_id: 'sh-peer', kind: 'float_out', amount: 150, reason: 'banked' });
  sentId = r.instruction_id;
  const pending = db.prepare(`SELECT * FROM node_instructions WHERE id = ?`).get(r.instruction_id);
  const p = pending ? JSON.parse(pending.payload) : {};
  ok('another till\'s drawer: an instruction for that till, nothing written here',
    r.ok && !r.direct && pending?.kind === 'shift_money' && pending.device_id === 'dev-P' && p.row_id === r.row_id && p.shift_id === 'sh-peer'
    && p.kind === 'float_out' && p.amount === 150 && p.approver?.name === 'Mary'
    && !db.prepare(`SELECT 1 FROM float_transactions WHERE id = ?`).get(r.row_id), JSON.stringify({ r, pending }));
  const ov = await H['branchClose:overview'](null);
  const peer = ov.tills.find((t) => t.device_id === 'dev-P');
  ok('the screen shows it waiting for the till, and the till by its name', peer?.money?.some((m) => m.id === r.instruction_id && m.status === 'pending'
    && m.amount === 150 && m.kind === 'float_out' && m.shift_id === 'sh-peer' && m.note === 'banked') && peer.state.terminal.name === 'Bar POS', JSON.stringify(peer?.money));
  const second = await H['branchClose:shiftMoney'](null, { device_id: 'dev-P', shift_id: 'sh-peer', kind: 'expense', amount: 40, description: 'Ice', payment_method: 'cash' });
  ok('a second one is its own instruction — the first is kept', second.ok && !!db.prepare(`SELECT 1 FROM node_instructions WHERE id = ?`).get(r.instruction_id)
    && B.collectInstructions('dev-P').filter((i) => i.kind === 'shift_money').length === 2);
  B.recordAck(second.instruction_id, { ok: false, error: B.SHIFT_MONEY_CLOSED });
  const ov2 = await H['branchClose:overview'](null);
  ok('a refusal shows with the till\'s reason', ov2.tills.find((t) => t.device_id === 'dev-P').money.some((m) => m.id === second.instruction_id && m.status === 'failed' && m.error === B.SHIFT_MONEY_CLOSED));
  const c = await H['branchClose:cancelShiftMoney'](null, { instruction_id: sentId });
  const c2 = await H['branchClose:cancelShiftMoney'](null, { instruction_id: second.instruction_id });
  ok('one the till answered cannot be withdrawn', c2.ok === false && !!db.prepare(`SELECT 1 FROM node_instructions WHERE id = ?`).get(second.instruction_id));
  // sentId was delivered above (collectInstructions): the till may have recorded it already, so it is not withdrawn
  ok('one the till has picked up cannot be withdrawn (it may be on its books already)', c.ok === false && !!db.prepare(`SELECT 1 FROM node_instructions WHERE id = ?`).get(sentId));
  const fresh = await H['branchClose:shiftMoney'](null, { device_id: 'dev-P', shift_id: 'sh-peer', kind: 'float_in', amount: 5 });
  const c3 = await H['branchClose:cancelShiftMoney'](null, { instruction_id: fresh.instruction_id });
  ok('Cancel withdraws one the till has not picked up', fresh.ok && c3.ok && !db.prepare(`SELECT 1 FROM node_instructions WHERE id = ?`).get(fresh.instruction_id));
}
{
  db.prepare(`UPDATE node_peer_state SET updated_at = ? WHERE device_id = 'dev-P'`).run(new Date(Date.now() - 5 * 60_000).toISOString());
  const r = await H['branchClose:shiftMoney'](null, { device_id: 'dev-P', shift_id: 'sh-peer', kind: 'float_in', amount: 10 });
  // A521 (#13, owner 2026-10-17: "never wait on an absent till … queue the rest for when it reconnects"): a till that is
  // off is no longer refused — the row waits for it (no 24-h expiry, Cancel until it is picked up), said plainly.
  ok('a till not heard from is queued for when it reconnects, said plainly (A521)',
    r.ok === true && r.queued_offline === true && r.message === 'The POS is not connected — this applies when it reconnects.', JSON.stringify(r));
  await H['branchClose:cancelShiftMoney'](null, { instruction_id: r.instruction_id });
  peerReport([peerShift('awaiting')]);
  const c = await H['branchClose:shiftMoney'](null, { device_id: 'dev-P', shift_id: 'sh-peer', kind: 'float_in', amount: 10 });
  ok('a shift its till reports closed is refused', c.ok === false && /no longer open/.test(c.error ?? ''), JSON.stringify(c));
  peerReport([peerShift('open')]);
}
{
  signIn('u-amira', 'Amira', 'cashier');
  const r = await H['branchClose:shiftMoney'](null, { device_id: 'dev-P', shift_id: 'sh-peer', kind: 'float_in', amount: 10 });
  ok('a cashier signed in on the server cannot', r.ok === false && /manager/i.test(r.error ?? ''), JSON.stringify(r));
  signIn('u-mary', 'Mary', 'manager', '{"*":true}');
  const e = await H['branchClose:shiftMoney'](null, { device_id: 'dev-P', shift_id: 'sh-peer', kind: 'expense', amount: 10, description: '  ' });
  ok('an expense needs a description', e.ok === false && /Description/.test(e.error ?? ''));
}

console.log('\nA plain POS: unchanged\n');
DC.saveDeviceConfig({ device_role: 'till' });
{
  const r = await H['branchClose:shiftMoney'](null, { device_id: 'dev-P', shift_id: 'sh-peer', kind: 'float_in', amount: 10 });
  ok('a plain till cannot record on another till\'s shift', r.ok === false && /branch server/.test(r.error ?? ''), JSON.stringify(r));
  const before = db.prepare(`SELECT COUNT(*) AS n FROM float_transactions WHERE shift_id = ?`).get(sh.id).n;
  signIn('u-amira', 'Amira', 'cashier');
  await H['shift:float'](null, { type: 'float_in', amount: 25, reason: 'coins' });
  const row = db.prepare(`SELECT * FROM float_transactions WHERE shift_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sh.id);
  ok('its own cash in still lands on its own open shift, no approver needed',
    db.prepare(`SELECT COUNT(*) AS n FROM float_transactions WHERE shift_id = ?`).get(sh.id).n === before + 1 && row.amount === 25 && row.approved_by === null
    && row.device_id === 'dev-S' && expected(sh.id) === 1475, JSON.stringify(row));
  signIn('u-mary', 'Mary', 'manager', '{"*":true}');
  const x = await H['expense:create'](null, { description: 'Soap', amount: 30, payment_method: 'cash' });
  const ex = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(x.id);
  ok('its own expense still comes out of its own open drawer, approved by the signed-in manager',
    ex?.shift_id === sh.id && ex.device_id === 'dev-S' && ex.approved_by === 'u-mary' && /^[0-9a-f-]{36}$/.test(ex.id) && expected(sh.id) === 1445, JSON.stringify(ex));
  S.closeShift(1445, 'counted', null, {});
  const r2 = B.executeShiftMoney({ row_id: 'r-late', shift_id: sh.id, kind: 'float_in', amount: 5, approver: mary });
  ok('an instruction for a shift closed since is refused with the message', r2.ok === false && r2.error === 'That shift is closed on this POS — record it on the shift now open', JSON.stringify(r2));
  const noShift = await H['expense:create'](null, { description: 'Paper', amount: 12, payment_method: 'cash' });
  ok('with no drawer open, an expense is paid outside any drawer (as before)', db.prepare(`SELECT shift_id FROM expenses WHERE id = ?`).get(noShift.id)?.shift_id === null);
}

console.log('\nA466: "Not from a drawer" on the server, even with its own shift open\n');
{
  S.openShift(200);
  const own = require(path.join(dist, 'syncEngine.js')).getOpenShift();
  signIn('u-mary', 'Mary', 'manager', '{"*":true}');
  DC.saveDeviceConfig({ device_role: 'node' });
  const before = expected(own.id);
  const out = await H['expense:create'](null, { description: 'Bank charges', amount: 40, payment_method: 'cash', no_drawer: true });
  ok('the server\'s manager records it outside any drawer — its own drawer\'s expected cash is untouched',
    db.prepare(`SELECT shift_id FROM expenses WHERE id = ?`).get(out.id)?.shift_id === null && expected(own.id) === before);
  const inD = await H['expense:create'](null, { description: 'Milk', amount: 15, payment_method: 'cash' });
  ok('…and without the choice it comes out of its own open drawer, as before',
    db.prepare(`SELECT shift_id FROM expenses WHERE id = ?`).get(inD.id)?.shift_id === own.id && expected(own.id) === before - 15);
  DC.saveDeviceConfig({ device_role: 'till' });
  const till = await H['expense:create'](null, { description: 'Sugar', amount: 5, payment_method: 'cash', no_drawer: true });
  ok('a plain till ignores it — its expense still comes out of its open drawer',
    db.prepare(`SELECT shift_id FROM expenses WHERE id = ?`).get(till.id)?.shift_id === own.id);
  const form = read('src/renderer/components/RecordExpenseForm.tsx');
  ok('the form offers "Not from a drawer" on the server while its shift is open',
    form.includes('{isServer && (drawers.length > 0 || shiftOpen) && (') && form.includes('{shiftOpen && <option value={NONE}>Not from a drawer</option>}')
    && form.includes('...(isServer && drawer === NONE ? { no_drawer: true } : {}),'));
}

console.log('\nWired end to end (source)\n');
{
  const idx = read('src/main/index.ts');
  const loop = idx.slice(idx.indexOf("if (ins.kind === 'shift_money')"), idx.indexOf("if (ins.kind !== 'close_day')"));
  ok('the till\'s peer loop executes shift_money, pushes, tells its screens and acks',
    loop.includes('executeShiftMoney(ins.payload)') && loop.includes('syncPush()') && loop.includes("'shift:changedElsewhere'") && loop.includes('await sendAck(ins, ack)'));   // F12: acked by uid + device
  const pre = read('src/main/preload.ts');
  ok('the bridge carries the calls and the reload event', pre.includes("'branchClose:shiftMoney'") && pre.includes("'branchClose:cancelShiftMoney'") && pre.includes("ipcRenderer.on('shift:changedElsewhere'"));
  ok('an open shift panel and the POS reload on it', /posApi\.shift\.onChangedElsewhere\(/.test(read('src/renderer/pages/ShiftPanel.tsx')) && /posApi\.shift\.onChangedElsewhere\(/.test(read('src/renderer/pages/POSPage.tsx')));
  const tab = read('src/renderer/pages/BranchCloseTab.tsx');
  ok('Close Branch: Cash in / out and Expense on every open drawer, on the server only',
    tab.includes("const isServer = role === 'node' || role === 'office';") && tab.includes('{isServer && openDrawers.length > 0 && (')
    && tab.includes("s.state === 'open'") && tab.includes('Cash in / out</button>') && tab.includes('Expense</button>') && tab.includes('posApi.branchClose.shiftMoney('));
  ok('…with what was sent: waiting for the till (Cancel), recorded, refused with the reason',
    tab.includes('waiting for the POS') && tab.includes('>recorded<') && tab.includes('refused: {') && tab.includes('posApi.branchClose.cancelShiftMoney('));
  const form = read('src/renderer/components/RecordExpenseForm.tsx');
  ok('Manager › Expenses: "Which drawer" only on the server; another till\'s goes to it, else as before',
    form.includes("if (c?.device_role !== 'node' && c?.device_role !== 'office') return;") && form.includes('{isServer && (drawers.length > 0 || shiftOpen) && (')
    && form.includes("kind: 'expense'") && form.includes('const saved = await posApi.expense.create({'));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { L.closeLocalDb?.(); } catch { /* */ }
process.exit(fail ? 1 : 0);
