/**
 * shift-report-backup.test.ts — A363 (desktop 0.6.20): the PRINTED Z-report says what of the shift is not on the cloud.
 *
 * Owner, 2026-09-29: "add the note on the zreport". The till passes the words (desktop lib/syncNotice zBackupNote); this
 * proves the paper carries them, whole and wrapped at both widths, and that a report with nothing to say is unchanged.
 *
 * MUTATION-CHECKED: drop the backupNote block from shiftReport.ts → the first two checks go red.
 */
import assert from 'node:assert';
import { renderShiftReport, toPreview } from '../src/index';

let passed = 0, failed = 0;
const ok = (n: string, f: () => void) => { try { f(); passed++; console.log(`PASS  ${n}`); } catch (e: any) { failed++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const base = {
  businessName: 'B Foods', currencyCode: 'KES', cashierName: 'Eugene', shiftRef: '6425f8ed',
  openedAt: new Date('2026-09-29T06:55:40Z'), closedAt: new Date('2026-09-29T15:00:00Z'), status: 'closed',
  byMethod: [{ method: 'cash', orders: 1, amount: 139000 }], orderCount: 1, grossSales: 139000, voidCount: 0,
  openingFloat: 300000, cashSales: 139000, floatIn: 0, floatOut: 0, expectedCash: 439000, countedCash: 439000, variance: 0,
  printedAt: new Date('2026-09-29T15:00:05Z'),
};
const NOTE = 'NOT BACKED UP YET: 2 sales of this shift are only on this till until it syncs.';
const text = (r: any, w: 58 | 80) => toPreview(renderShiftReport(r, w));

ok('80mm: the note is on the paper, whole', () => {
  const t = text({ ...base, backupNote: NOTE }, 80).replace(/\s+/g, ' ');
  assert.ok(t.includes(NOTE), t);
});
ok('58mm: wrapped, every word still there', () => {
  const t = text({ ...base, backupNote: NOTE }, 58).replace(/\s+/g, ' ');
  assert.ok(t.includes(NOTE), t);
});
ok('nothing to say → the report is exactly as before', () => {
  assert.equal(text({ ...base, backupNote: null }, 80), text({ ...base }, 80));
  assert.ok(!/BACKED UP/.test(text({ ...base }, 80)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
