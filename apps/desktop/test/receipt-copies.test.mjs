// A456 — two receipts (customer + merchant) on the till's thermal printer too.
// Owner, 2026-10-12: "if i want to be printing 2 copies of a receipt that feature does not exist in the desktop till please
// add it also on web till if its not there also". The till's Copies setting (Settings › Printers) reached only the
// Windows-printer route; a receipt on a thermal Till station printed once. The web till already honours its setting.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/receipt-copies.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - the second queueThermal call removed                → "two copies queue the receipt twice" fails
//   - the second call asking for kitchen tickets too      → "…never a second kitchen ticket" fails
//   - receipt_copies left in the cloud payload             → "the hint never reaches the cloud" fails
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const dash = (p) => fs.readFileSync(path.join(here, '..', '..', 'dashboard', 'src', p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const R = require(path.join(here, '..', 'dist', 'main', 'peerRelay.js'));

console.log('\nThe till\n');
{
  const h = ipcHandlersSource();
  const sale = h.slice(h.indexOf('const printed = queueThermal(\n      orderPayload,'), h.indexOf('return { orderId, printFailed: printed.failed };'));
  ok('two copies queue the receipt twice on the thermal printer', /if \(receiptCopies\(orderPayload\) === 2\) \{\s*const second = queueThermal\(orderPayload, \['receipt'\]\);/.test(sale), sale.slice(0, 400));
  ok('…never a second kitchen ticket (the second call is the receipt only)', !/queueThermal\(orderPayload, \[[^\]]*'kitchen'[^\]]*\]\);/.test(sale.slice(sale.indexOf('receiptCopies'))));
  ok('…and a second copy that fails is reported like the first', /printed\.failed\.push\(\.\.\.second\.failed/.test(sale));
  ok('only 2 means two; anything else is one', /return Number\(payload\?\.receipt_copies\) === 2 \? 2 : 1;/.test(h));
  ok('the sale carries the till\'s Copies setting', /receipt_copies: printerSettings\.copies === 2 \? 2 : 1,/.test(src('renderer/pages/POSPage.tsx')));
  const cloud = R.buildCloudOrderPayload({ order_number: 'T1-1', kot_sent: true, receipt_copies: 2, payments: [{ method: 'cash', amount: 100 }], items: [] }, { shiftId: 's', deviceId: 'd' });
  ok('the hint never reaches the cloud (no such column)', !('receipt_copies' in cloud) && !('kot_sent' in cloud) && cloud.order_number === 'T1-1', JSON.stringify(cloud));
}

console.log('\nThe web till (already there)\n');
{
  const pm = dash('pages/pos/PaymentModal.tsx');
  ok('the thermal bridge prints the receipt as many times as set', /const copies = printerSettings\.copies \?\? 1;\s*for \(let i = 0; i < copies; i\+\+\) \{\s*await printBytesToServer/.test(pm));
  ok('…the browser route duplicates it', /settings\.copies === 2/.test(dash('lib/printReceipt.ts')));
  ok('…and its printer settings offer 2 copies', /\{ label: '2 copies', value: 2 as const \}/.test(dash('pages/pos/PrinterSettingsModal.tsx')));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
