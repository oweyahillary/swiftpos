// A447 — a manager records an expense from Manager › Expenses (it was the cashier's Shift → Expenses only).
// Owner, 2026-10-11: "add a feature or manager recording expenses under expense tab, 'record expense' not just as a cashier
// but as a manager also".
//
// Registers the REAL compiled IPC handlers on a REAL SQLite file (electron shimmed, offline) and records expenses as a
// signed-in manager — with this till's shift open and with none — then reads the Z-report and the Expenses list.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/manager-expense.test.mjs
//
// MUTATIONS TO CONFIRM BITE: payoutApprover asking a signed-in manager for a PIN → "no PIN" fails; the expense not taking
// the open shift → "comes out of the drawer" fails; the Record expense button removed → its pin fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a447-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'device:dev-T1', 'biz-1', 'Biz', '2026-10-11T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-mary', 'Mary'), ('u-tom', 'Tom')`).run();
// A490: a role's NAME decides nothing on the till — a manager is the permissions an older cloud sent a manager.
const A490_MANAGER = '{"orders.void":true,"settings.manage":true,"expenses.manage":true}';   // a manager role held expenses.manage
const signIn = (id, name, role, perms = ['manager', 'supervisor'].includes(role) ? A490_MANAGER : '{}') => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-11T06:00:00Z')`).run(id, name, role, perms);
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const S = require(path.join(dist, 'shiftService.js'));
const row = (id) => db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(id);

console.log('\nA manager records an expense with no shift open on this POS\n');
signIn('u-mary', 'Mary', 'manager');
{
  const r = await H['expense:create'](null, { description: 'Gas refill', amount: 1500, payment_method: 'cash' });
  const e = row(r.id);
  ok('saved with no PIN — the signed-in manager approves it themselves', !!r.id && r.approvedBy === 'Mary' && e.approved_by === 'u-mary', JSON.stringify(r));
  ok('…recorded as paid outside any drawer (no shift on this till)', e.shift_id === null && Number(e.amount) === 1500 && e.payment_method === 'cash');
  ok('…queued to sync like any expense', e.sync_status === 'pending' && e.device_id === 'dev-T1');
}

console.log('\nWith this POS\'s shift open\n');
{
  const shift = S.openShift(2000);
  const before = S.computeZReport(shift.id).totals.expectedCash;
  const r = await H['expense:create'](null, { description: 'Ice', amount: 300, payment_method: 'cash' });
  const after = S.computeZReport(shift.id).totals.expectedCash;
  ok('a cash expense comes out of the open drawer (the shift\'s expected cash goes down by it)', row(r.id).shift_id === shift.id && Math.round((before - after) * 100) === 30000, `${before} → ${after}`);
  const m = await H['expense:create'](null, { description: 'Repairs', amount: 800, payment_method: 'mpesa' });
  ok('…an M-Pesa one does not touch the drawer', Math.round(S.computeZReport(shift.id).totals.expectedCash * 100) === Math.round(after * 100) && row(m.id).payment_method === 'mpesa');
  const list = await H['expense:range'](null, { preset: 'today' });
  ok('the Expenses list shows them, with the total', list.rows.length === 3 && Math.round(list.total) === 2600, JSON.stringify({ n: list.rows.length, t: list.total }));
}

console.log('\nA cashier still needs a manager\n');
signIn('u-tom', 'Tom', 'cashier');
{
  const e = await rejects(H['expense:create'](null, { description: 'Snacks', amount: 100, payment_method: 'cash' }));
  ok('a cashier with no manager PIN is refused, as before (A388)', !!e, String(e));
}

console.log('\nThe screen\n');
{
  const mgr = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'pages', 'ManagerPage.tsx'), 'utf8');
  ok('Manager › Expenses has + Record expense and the form, and the list reloads after a save',
    /data-testid="record-expense"/.test(mgr) && /<RecordExpenseForm currency=\{currency\}/.test(mgr) && /setReload\(\(n\) => n \+ 1\)/.test(mgr));
  const form = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'components', 'RecordExpenseForm.tsx'), 'utf8');
  ok('the form records through the same expense:create as the cashier\'s, and says whether the drawer is touched',
    /posApi\.expense\.create\(\{/.test(form) && /Cash comes out of this POS\\'s drawer/.test(form) && /recorded as cash paid outside any drawer/.test(form));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
