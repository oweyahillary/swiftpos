// A500 (2026-10-15) — a bill number never refuses a sale, and never keeps a sale off the branch.
//
// The till log: "distribution: refused 1 orders row(s) … (UNIQUE constraint failed: orders.order_number)", receipts
// "T3--5". A wiped / reinstalled till gets its old terminal code back (A182) under a NEW device id with its counter at 0,
// while the branch still holds its earlier self's T3--1…; the local orders.order_number is UNIQUE across own sales AND
// replicas. Checks, on the REAL compiled dist/main and a REAL SQLite file:
//   - the branch server / a till's pull keeps a clashing replica under `<number>~<device>` instead of refusing it;
//   - nextBillNumber carries on past every number the machine holds (never mints a held one);
//   - a sale rung here keeps its number — a replica holding it yields; a stale own reservation gets the next number;
//   - the once-only repair re-offers what was refused / skipped before this build.
//
//   cd apps/desktop && npm run build:main && node test/bill-number-clash.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - applyPeerRows without the replicaOrderNumber alias            → "server: a second till's T3--5 is kept" fails
//   - nextBillNumber without the jump past highestBillSeq           → "a wiped till carries on" fails
//   - claimOrderNumberForOwnSale not renaming the replica            → "a replica holding the number yields" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a500-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.16', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('E:' + s, 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8').slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u', 'biz-1', 'Shop', '2026-10-15T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
const I = require(path.join(dist, 'nodeIngest.js'));
const BN = require(path.join(dist, 'billNumber.js'));

const order = (id, device, seq, number) => ({ id, business_id: 'biz-1', branch_id: 'br-1', order_number: number, status: 'completed',
  subtotal: 100, vat_amount: 0, total: 100, created_at: '2026-10-15T08:00:00.000Z', device_id: device, seq });
const numberOf = (id) => db.prepare(`SELECT order_number FROM orders WHERE id = ?`).get(id)?.order_number;

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nThe branch server: a clashing number is kept, never refused\n');
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.invalid', branch_id: 'br-1', device_id: 'dev-SRV',
  device_role: 'node', terminal_code: 'S1', node_url: null });
{
  const a = I.applyPeerRows('orders', 'dev-OLDT3', [order('old-5', 'dev-OLDT3', 5, 'T3--5')]);
  ok('the old T3\'s sale is applied', a.applied === 1 && numberOf('old-5') === 'T3--5', JSON.stringify(a));
  const b = I.applyPeerRows('orders', 'dev-NEWT3', [order('new-5', 'dev-NEWT3', 5, 'T3--5'), order('new-6', 'dev-NEWT3', 6, 'T3--6')]);
  ok('server: a second till\'s T3--5 is kept (not refused)', b.rejected.length === 0 && b.applied === 2, JSON.stringify(b));
  ok('…under <number>~<device>; the first keeps its own', numberOf('new-5') === 'T3--5~dev-NEWT' && numberOf('old-5') === 'T3--5', numberOf('new-5'));
  ok('…named held (the till marks it delivered)', b.applied_ids.includes('new-5') && b.applied_ids.includes('new-6'));
  const again = I.applyPeerRows('orders', 'dev-NEWT3', [order('new-5', 'dev-NEWT3', 5, 'T3--5')]);
  ok('a re-offer is a duplicate, not a third copy', again.duplicate === 1 && db.prepare(`SELECT COUNT(*) n FROM orders WHERE id='new-5'`).get().n === 1);
  const third = I.applyPeerRows('orders', 'dev-NEWT3B', [order('x-5', 'dev-NEWT3B', 1, 'T3--5')]);
  ok('a third clash gets its own alias', third.applied === 1 && numberOf('x-5') === 'T3--5~dev-NEWT~2', numberOf('x-5'));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nA till\'s pull: the clashing sale lands instead of being skipped\n');
C.saveDeviceConfig({ device_role: 'till', device_id: 'dev-T1', terminal_code: 'T1', node_url: 'http://10.0.0.9:4100' });
{
  const d = I.applyDistribution([{ device_id: 'dev-T2', table: 'orders', rows: [order('t2-9', 'dev-T2', 1, 'T3--6')] }]);
  ok('distribution: applied, not refused', d.applied === 1 && d.rejected === 0, JSON.stringify(d));
  ok('…under an alias', numberOf('t2-9') === 'T3--6~dev-T2', numberOf('t2-9'));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nnextBillNumber: a wiped till carries on, it does not restart\n');
C.saveDeviceConfig({ device_id: 'dev-NEWT3', terminal_code: 'T3' });
{
  db.prepare(`DELETE FROM counters WHERE name = 'bill_seq'`).run();
  // The branch's copies of the old T3's sales reached this (reinstalled) till: T3--1 … T3--7.
  for (let n = 1; n <= 7; n++) I.applyPeerRows('orders', 'dev-OLD', [order(`o${n}`, 'dev-OLD', n, `T3--${n}`)]);
  const n1 = BN.nextBillNumber(db, 'T3');
  ok('a wiped till carries on past what it holds', n1 === 'T3--8', n1);
  ok('…and on', BN.nextBillNumber(db, 'T3') === 'T3--9');
  ok('the highest is read only from all-digit numbers (aliases ignored)', BN.highestBillSeq(db, 'T3') === 7);
  db.prepare(`INSERT INTO held_orders (id, order_number, label, order_type, cart, held_at) VALUES ('h1', 'T3--10', 'x', 'retail', '[]', '2026-10-15')`).run();
  ok('a number on a held bill is not handed out again', BN.nextBillNumber(db, 'T3') === 'T3--11');
  ok('no terminal code: the old unprefixed scheme', /^ORD-\d{6}-\d{3}$/.test(BN.nextBillNumber(db, '')));
  ok('a code with LIKE characters is matched literally', BN.highestBillSeq(db, 'T_') === 0 && BN.highestBillSeq(db, '%') === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nA sale rung here keeps its number\n');
{
  // A replica arrived holding the number this till reserved for the sale on screen (the KOT already shows it).
  I.applyPeerRows('orders', 'dev-OLD', [order('o12', 'dev-OLD', 12, 'T3--12')]);
  const c = BN.claimOrderNumberForOwnSale(db, 'T3--12', 'dev-NEWT3', 'T3');
  ok('a replica holding the number yields — the sale keeps it', c.number === 'T3--12' && c.renamedReplica?.to === 'T3--12~dev-OLD', JSON.stringify(c));
  ok('…the replica is renamed here only (same id)', numberOf('o12') === 'T3--12~dev-OLD');
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, device_id)
              VALUES ('mine-12', 'biz-1', 'br-1', 'T3--12', 1, 0, 1, '2026-10-15', 'dev-NEWT3')`).run();
  const again = BN.claimOrderNumberForOwnSale(db, 'T3--12', 'dev-NEWT3', 'T3');
  ok('a stale own reservation takes the next free number', again.renumbered === true && again.number !== 'T3--12'
    && !db.prepare(`SELECT 1 FROM orders WHERE order_number = ?`).get(again.number), JSON.stringify(again));
  ok('createLocalOrder claims the number inside the sale\'s transaction',
    /db\.transaction\(\(\) => \{\s*\/\/ A500[\s\S]{0,400}claimOrderNumberForOwnSale\(/.test(fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8')));
  ok('the bill-number IPC uses the guarded allocator',
    // A519: the number is handed out only to someone who may sell (sellGate), and noted as an open bill.
    /orders:nextBillNumber[\s\S]{0,900}(return|const n =) nextBillNumber\(getLocalDb\(\)/.test(ipcHandlersSource()));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nThe once-only repair of what was refused before this build\n');
{
  const ins = db.prepare(`INSERT INTO node_queue (table_name, row_id, payload, created_at, status, attempts, last_error) VALUES (?, ?, ?, datetime('now'), ?, ?, ?)`);
  ins.run('orders', 'r-1', JSON.stringify({ id: 'r-1', seq: 1 }), 'failed', 5, 'UNIQUE constraint failed: orders.order_number');
  ins.run('orders', 'r-2', JSON.stringify({ id: 'r-2', seq: 2 }), 'failed', 5, 'row belongs to a different branch');
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('distribution_refused:dev-T9:orders:z1', 'UNIQUE constraint failed: orders.order_number', 'x')`).run();
  I.advanceCursor('dev-T9', 'orders', 40);
  I.advanceCursor('dev-T9', 'shifts', 40);
  const r = I.repairBillNumberRefusals();
  ok('a sale the server refused for its number is offered again', db.prepare(`SELECT status, attempts FROM node_queue WHERE row_id='r-1'`).get().status === 'pending', JSON.stringify(r));
  ok('…a refusal for another reason is left alone', db.prepare(`SELECT status FROM node_queue WHERE row_id='r-2'`).get().status === 'failed');
  ok('the origin whose sale was skipped is pulled again (orders only)', I.getCursor('dev-T9', 'orders') === 0 && I.getCursor('dev-T9', 'shifts') === 40);
  ok('…its note is cleared', !db.prepare(`SELECT 1 FROM maintenance_state WHERE key = 'distribution_refused:dev-T9:orders:z1'`).get());
  I.advanceCursor('dev-T9', 'orders', 40);
  ins.run('orders', 'r-3', JSON.stringify({ id: 'r-3', seq: 3 }), 'failed', 5, 'UNIQUE constraint failed: orders.order_number');
  const r2 = I.repairBillNumberRefusals();
  ok('…once', r2.requeued === 0 && db.prepare(`SELECT status FROM node_queue WHERE row_id='r-3'`).get().status === 'failed' && I.getCursor('dev-T9', 'orders') === 40);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
