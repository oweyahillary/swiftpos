/**
 * 0.6.25 — the thermal Z-report / shift report is headed by the client's receipt logo (owner: "add the logo in all
 * documents"). Same raster and switch as the receipt; absent → the report is byte-identical to before.
 *
 * Run: tsc -p tsconfig.test.json && node test-dist/test/shift-report-logo.test.js
 *
 * MUTATION TO CONFIRM BITE: the `if (r.logoRaster) d.image(...)` line removed → "the logo comes first" fails.
 */
import assert from 'node:assert';
import { renderShiftReport, toEscPos, type ShiftReportData } from '../src/index';

let pass = 0, fail = 0;
const ok = (n: string, f: () => void) => { try { f(); pass++; console.log('PASS ' + n); } catch (e: any) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

const base: ShiftReportData = {
  businessName: 'B Foods', currencyCode: 'KES', cashierName: 'T', shiftRef: 'abc12345',
  openedAt: new Date(2026, 8, 30, 8, 0), closedAt: null, status: 'open', byMethod: [], orderCount: 0, grossSales: 0,
  voidCount: 0, openingFloat: 0, cashSales: 0, floatIn: 0, floatOut: 0, expectedCash: 0, countedCash: null, variance: null,
  printedAt: new Date(2026, 8, 30, 12, 0),
} as ShiftReportData;
const logo = { width: 16, height: 2, bytes: new Uint8Array([0xff, 0xff, 0xff, 0xff]) };
const first = (d: any) => (Array.isArray(d) ? d[0] : d.blocks?.[0]);

ok('the logo comes first when given', () => {
  assert.equal(first(renderShiftReport({ ...base, logoRaster: logo }, 80))?.kind, 'image');
});
ok('without a logo nothing changes (no image block; the same bytes as before)', () => {
  const a = renderShiftReport(base, 80);
  assert.notEqual(first(a)?.kind, 'image');
  assert.deepEqual(Array.from(toEscPos(a, { cut: true })), Array.from(toEscPos(renderShiftReport(base, 80), { cut: true })));
});
ok('the logo reaches the printer (GS v 0 raster in the bytes)', () => {
  const bytes = Array.from(toEscPos(renderShiftReport({ ...base, logoRaster: logo }, 80), { cut: true }));
  const i = bytes.findIndex((b, k) => b === 0x1d && bytes[k + 1] === 0x76 && bytes[k + 2] === 0x30);
  assert.ok(i >= 0, 'no GS v 0 in the stream');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
