/**
 * shift-drawer-sessions.test.mjs — proves a shift is a terminal's drawer session,
 * not a cashier's, and that the exact A-on-T1/T2 scenario reconciles cleanly.
 *
 *   node shift-drawer-sessions.test.mjs
 *
 * No server, no database. It models the terminal-key resolution and the sale/shift
 * attribution the way shifts.ts and orders.ts now do, then runs the scenario the
 * old cashier-keyed model got wrong:
 *
 *   Cashier A opens a drawer on terminal T1.
 *   Cashier B opens a drawer on terminal T2.
 *   Cashier A logs into T2 and rings a sale.
 *
 * Under the OLD model the sale was stamped with A's T1 shift, so the money (in the
 * T2 drawer) reconciled against the T1 drawer — T1 short, T2 over. Under the new
 * model the sale attaches to T2's session, and both drawers reconcile to zero
 * variance. The test asserts exactly that.
 */

// ── copy of lib/terminalKey.ts ──────────────────────────────────────────────
function terminalKey(deviceId, terminalCode, branchId) {
  return deviceId || terminalCode || `web:${branchId}`;
}

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

const BRANCH = 'branch-1';
const shifts = [];
const orders = [];

function sessionForTerminal(tkey) {
  return shifts.find(s => s.status === 'open' &&
    terminalKey(s.device_id, s.terminal_code, s.branch_id) === tkey) ?? null;
}

function openShift({ cashier, deviceId, openingFloat }) {
  const tkey = terminalKey(deviceId, '', BRANCH);
  if (sessionForTerminal(tkey)) throw new Error(`terminal ${tkey} already open`);
  const shift = {
    id: `shift-${shifts.length + 1}`, branch_id: BRANCH, device_id: deviceId,
    terminal_code: null, cashier_id: cashier, opened_by: cashier,
    opening_float: openingFloat, status: 'open',
  };
  shifts.push(shift);
  return shift;
}

function ringSale({ cashier, atDeviceId, cashAmount }) {
  const tkey = terminalKey(atDeviceId, '', BRANCH);
  const session = sessionForTerminal(tkey);           // resolve by TERMINAL
  orders.push({ cashier_id: cashier, shift_id: session ? session.id : null,
                device_id: atDeviceId, cash: cashAmount });
  return session;
}

function expectedCash(shiftId) {
  const s = shifts.find(x => x.id === shiftId);
  const sales = orders.filter(o => o.shift_id === shiftId).reduce((sum, o) => sum + o.cash, 0);
  return s.opening_float + sales;
}

function physicalCash(deviceId) {
  const s = shifts.find(x => terminalKey(x.device_id, x.terminal_code, x.branch_id)
                             === terminalKey(deviceId, '', BRANCH));
  const dropped = orders.filter(o => o.device_id === deviceId).reduce((sum, o) => sum + o.cash, 0);
  return s.opening_float + dropped;
}

const T1 = 'device-T1', T2 = 'device-T2';
const shiftA = openShift({ cashier: 'A', deviceId: T1, openingFloat: 1000 });
const shiftB = openShift({ cashier: 'B', deviceId: T2, openingFloat: 1000 });

ok('two separate sessions, one per terminal', shifts.length === 2 && shiftA.id !== shiftB.id);

ringSale({ cashier: 'B', atDeviceId: T2, cashAmount: 500 });
ringSale({ cashier: 'A', atDeviceId: T1, cashAmount: 300 });

// THE CASE THAT BROKE: A walks to T2 and rings 700 cash
const s = ringSale({ cashier: 'A', atDeviceId: T2, cashAmount: 700 });

ok("A's sale on T2 attaches to T2's session, not A's T1 session",
   s.id === shiftB.id, `got ${s?.id}, T2 is ${shiftB.id}`);
const lastOrder = orders[orders.length - 1];
ok('the sale still records A as the cashier (attribution tag kept)', lastOrder.cashier_id === 'A');
ok("but its drawer is T2's", lastOrder.shift_id === shiftB.id);

const t1Expected = expectedCash(shiftA.id), t1Physical = physicalCash(T1);
const t2Expected = expectedCash(shiftB.id), t2Physical = physicalCash(T2);

ok('T1 expected == T1 physical (no phantom shortage)',
   t1Expected === t1Physical, `expected ${t1Expected} vs physical ${t1Physical}`);
ok('T2 expected == T2 physical (no phantom surplus)',
   t2Expected === t2Physical, `expected ${t2Expected} vs physical ${t2Physical}`);
ok('T1 drawer = 1000 float + 300 = 1300', t1Physical === 1300, `${t1Physical}`);
ok('T2 drawer = 1000 float + 500 + 700 = 2200', t2Physical === 2200, `${t2Physical}`);

// Contrast: the OLD cashier-keyed model.
function oldSessionForCashier(cashier) {
  return shifts.find(x => x.status === 'open' && x.cashier_id === cashier) ?? null;
}
{
  const oldSession = oldSessionForCashier('A');
  const oldExpectedT1 = shiftA.opening_float + 300 + 700;
  ok("OLD model would have put A's T2 sale on the T1 drawer", oldSession.id === shiftA.id);
  ok('OLD model: T1 reads a 700 phantom shortage',
     oldExpectedT1 - 1300 === 700, `${oldExpectedT1 - 1300}`);
}

// Close authorisation matrix (finding #13)
function canClose({ requester, requesterPerms = [], atDeviceId, shift }) {
  const sameTerminal = terminalKey(atDeviceId, '', BRANCH)
    === terminalKey(shift.device_id, shift.terminal_code, shift.branch_id);
  const openedByRequester = shift.opened_by === requester || shift.cashier_id === requester;
  const isManager = requesterPerms.includes('*') || requesterPerms.includes('shifts.manage');
  return openedByRequester || sameTerminal || isManager;
}

ok('opener can close their own drawer',
   canClose({ requester: 'A', atDeviceId: T1, shift: shiftA }) === true);
ok('a cashier ON that terminal can close its drawer (shared session)',
   canClose({ requester: 'C', atDeviceId: T2, shift: shiftB }) === true);
ok('a manager can close any drawer from anywhere',
   canClose({ requester: 'M', requesterPerms: ['shifts.manage'], atDeviceId: T1, shift: shiftB }) === true);
ok('a stranger on another terminal CANNOT close a drawer they never touched',
   canClose({ requester: 'X', atDeviceId: T1, shift: shiftB }) === false);

console.log(`\n${fail === 0 ? 'All checks passed. Sessions are per-terminal; both drawers reconcile.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
