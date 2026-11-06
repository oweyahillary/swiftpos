/**
 * mpesa-statement.test.mjs — the M-Pesa statement check (owner, 2026-11-05: Excel/CSV and PDF, "both").
 *
 *   node --no-warnings tests/mpesa-statement.test.mjs
 *
 * RUNS the real @zaptill/core/mpesaStatement on rows shaped like the M-PESA Org Portal's export, and on a REAL PDF made
 * here and read by pdf.js (the dashboard's pdfjs-dist, as the browser does) — so the PDF path is proven end to end:
 *
 *   R  rows: the header found under the portal's account details; codes, Kenyan times → UTC, paid in / withdrawn, rows that
 *      are not transactions counted; dd/mm/yyyy, an Excel serial and a CSV read as text (SheetJS raw — never a guessed date).
 *   P  the PDF: the header found on each page (repeated, not a transaction), a wrapped description and a date and its time
 *      on two lines joined, amounts wider than their titles in the right column, the summary table above ignored.
 *   M  matching: by code (matched / amount differs), then the same amount within 15 minutes (likely), a code a second sale
 *      used again, a code not on the statement, a sale with no code, money in with no sale, failed lines and withdrawals
 *      left out; the totals.
 *   W  wiring (source): the cloud route (reports.payments, the online licence, web only, the branch scope, completed M-Pesa
 *      legs), the tab loaded on demand, a password-protected PDF asks for its password.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - statementTimeOf without the EAT offset                          → R "Kenyan times → UTC"
 *   - pdfRows not joining a continuation line                         → P "wrapped description joined"
 *   - matchStatement taking a likely match at 30 minutes              → M "not beyond 15 minutes"
 *   - a code used twice allowed a likely match                        → M "a code a second sale used again"
 *   - the route without .eq('status', 'completed')                    → W "completed M-Pesa legs"
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 900)}`); fail++; } };

try {
  const S = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/mpesaStatement.ts')).href);

  console.log('\nR. Rows (the Org Portal export)');
  const portal = [
    ['Account Holder:', 'B FOODS LTD'], ['Short Code:', '123456'], ['Time Period:', '04-11-2026 to 05-11-2026'], [],
    ['Receipt No.', 'Completion Time', 'Initiation Time', 'Details', 'Transaction Status', 'Paid In', 'Withdrawn', 'Balance', 'Other Party Info'],
    ['SKA1B2C3D4', '2026-11-04 14:32:10', '2026-11-04 14:32:09', 'Pay Bill from 2547***678', 'Completed', '1,250.00', '', '5,250.00', '2547***678 - JOHN DOE'],
    ['SKB1B2C3D5', '04/11/2026 15:00', '', 'Business Payment to Bank', 'Completed', '', '-3,000.00', '2,250.00', 'EQUITY'],
    ['SKC1B2C3D6', 46331.5, '', 'Pay Bill from 2547***111', 'Completed', 400, '', 2650, '2547***111 - MARY'],
    ['', '', '', 'Total', '', '1,650.00', '3,000.00', '', ''],
  ];
  const r = S.parseStatementRows(portal);
  ok('the header found under the account details; three transactions', r.lines.length === 3, JSON.stringify(r.lines));
  ok('Kenyan times → UTC (14:32:10 EAT = 11:32:10Z)', r.lines[0].at === '2026-11-04T11:32:10.000Z', r.lines[0].at);
  ok('dd/mm/yyyy is Kenyan (4 November, not 11 April)', r.lines[1].at === '2026-11-04T12:00:00.000Z', r.lines[1].at);
  ok('an Excel serial (46331.5 = 5 Nov 2026 12:00 EAT)', r.lines[2].at === '2026-11-05T09:00:00.000Z', r.lines[2].at);
  ok('paid in and withdrawn (a signed withdrawal is money out)', r.lines[0].paidIn === 1250 && r.lines[1].paidIn === 0 && r.lines[1].withdrawn === 3000 && r.lines[2].paidIn === 400);
  ok('the other party and the details', r.lines[0].party === '2547***678 - JOHN DOE' && /Pay Bill/.test(r.lines[0].details));
  ok('the totals row is not a transaction (counted as skipped)', r.skipped === 1, String(r.skipped));
  ok('the statement\'s Kenyan days', r.from === '2026-11-04' && r.to === '2026-11-05', `${r.from} ${r.to}`);
  ok('money: KES 1,250 · (500.00) · text is not money', S.moneyOf('KES 1,250') === 1250 && S.moneyOf('(500.00)') === -500 && Number.isNaN(S.moneyOf('Completed')));
  ok('a time that is not a date: empty', S.statementTimeOf('31/02/2026 10:00') === '' && S.statementTimeOf('soon') === '');
  ok('a code needs letters and digits', S.isMpesaCode('SKA1B2C3D4') && !S.isMpesaCode('1234567890') && !S.isMpesaCode('RECEIPTNO'));
  const dashReq = createRequire(path.join(ROOT, 'apps/dashboard/package.json'));
  const X = dashReq('xlsx');
  const wb = X.read('Receipt No.,Completion Time,Details,Paid In,Withdrawn\nSKD1B2C3D7,04/11/2026 09:05:00,Till,"2,000.00",\n', { type: 'string', raw: true });
  const csv = S.parseStatementRows(X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }));
  ok('a CSV read as text (SheetJS raw): the date as written, the amount with its comma', csv.lines[0]?.at === '2026-11-04T06:05:00.000Z' && csv.lines[0]?.paidIn === 2000, JSON.stringify(csv.lines));

  console.log('\nP. A real PDF, read by pdf.js');
  const pdfjs = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  const page1 = [
    [30, 800, 'SUMMARY'], [30, 788, 'TRANSACTION TYPE'], [520, 788, 'Paid In'], [590, 788, 'Paid Out'],
    [30, 776, 'Customer Transfer'], [515, 776, '1,250.00'], [590, 776, '0.00'],
    [30, 740, 'Receipt No.'], [110, 740, 'Completion Time'], [210, 740, 'Details'], [420, 740, 'Transaction Status'],
    [520, 740, 'Paid In'], [590, 740, 'Withdrawn'], [670, 740, 'Balance'],
    [30, 725, 'SKA1B2C3D4'], [110, 725, '2026-11-04'], [210, 725, 'Merchant Payment from 2547***678 -'], [420, 725, 'Completed'],
    [508, 725, '1,250.00'], [670, 725, '5,250.00'],
    [110, 716, '14:32:10'], [210, 716, 'JOHN DOE'],
    [30, 700, 'SKB1B2C3D5'], [110, 700, '2026-11-04'], [210, 700, 'Business Payment to Bank'], [420, 700, 'Completed'],
    [585, 700, '3,000.00'], [670, 700, '2,250.00'],
    [110, 691, '15:00:00'],
  ];
  const page2 = [
    [30, 800, 'Receipt No.'], [110, 800, 'Completion Time'], [210, 800, 'Details'], [420, 800, 'Transaction Status'],
    [520, 800, 'Paid In'], [590, 800, 'Withdrawn'], [670, 800, 'Balance'],
    [30, 785, 'SKC1B2C3D6'], [110, 785, '2026-11-05 12:00:00'], [210, 785, 'Pay Bill from 2547***111 - MARY'], [420, 785, 'Failed'],
    [515, 785, '400.00'], [670, 785, '2,250.00'],
  ];
  const pdf = makePdf([page1, page2]);
  const doc = await pdfjs.getDocument({ data: pdf, standardFontDataUrl: path.join(ROOT, 'apps/dashboard/node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0 }).promise;
  const items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    for (const it of (await (await doc.getPage(p)).getTextContent()).items) {
      if (it.str?.trim()) items.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, page: p });
    }
  }
  const rows = S.pdfRows(items);
  const pr = S.parseStatementRows(rows);
  ok('three transactions over two pages; the summary table and the repeated header are not', pr.lines.length === 3, JSON.stringify(rows));
  ok('a wrapped description joined', pr.lines[0].details === 'Merchant Payment from 2547***678 - JOHN DOE', pr.lines[0].details);
  ok('a date and its time on two lines joined (EAT → UTC)', pr.lines[0].at === '2026-11-04T11:32:10.000Z' && pr.lines[1].at === '2026-11-04T12:00:00.000Z', `${pr.lines[0].at} ${pr.lines[1].at}`);
  ok('amounts wider than their titles land in their own column', pr.lines[0].paidIn === 1250 && pr.lines[1].withdrawn === 3000 && pr.lines[1].paidIn === 0,
    JSON.stringify(pr.lines.map((l) => [l.paidIn, l.withdrawn])));
  ok('a failed line is read with its status', pr.lines[2].status === 'Failed' && pr.lines[2].paidIn === 400);

  console.log('\nM. Matching');
  const line = (code, at, paidIn, status = 'Completed') => ({ code, at, details: '', party: '', status, paidIn, withdrawn: 0 });
  const sale = (n, reference, amount, at) => ({ order_number: n, reference, amount, at, cashier: 'Amina', branch: 'CBD' });
  const lines = [
    line('SKA0000001', '2026-11-04T08:00:00.000Z', 500),
    line('SKA0000002', '2026-11-04T09:00:00.000Z', 750),
    line('SKA0000003', '2026-11-04T10:00:00.000Z', 300),    // the sale with no code, 10 min later → likely
    line('SKA0000004', '2026-11-04T11:00:00.000Z', 200),    // nothing within 15 min → money with no sale
    line('SKA0000005', '2026-11-04T12:00:00.000Z', 900, 'Failed'),
    { ...line('SKA0000006', '2026-11-04T12:30:00.000Z', 0), withdrawn: 1000 },
    line('SKA0000007', '2026-11-04T13:00:00.000Z', 450),    // a code used twice: no likely match for the second sale
    line('SKA0000008', '2026-11-04T13:05:00.000Z', 450),    // …even with the same amount minutes later (money with no sale)
  ];
  const sales = [
    sale('T1-1', 'ska0000001', 500, '2026-11-04T08:01:00.000Z'),          // matched (lower case typed)
    sale('T1-2', 'Paid SKA0000002', 700, '2026-11-04T09:01:00.000Z'),     // amount differs
    sale('T1-3', '', 300, '2026-11-04T10:10:00.000Z'),                     // likely
    sale('T1-4', null, 200, '2026-11-04T11:30:00.000Z'),                   // 30 minutes: not likely → posOnly no_code
    sale('T1-5', 'SKZ9999999', 120, '2026-11-04T11:40:00.000Z'),          // unknown code
    sale('T1-6', 'SKA0000007', 450, '2026-11-04T13:01:00.000Z'),
    sale('T1-7', 'SKA0000007', 450, '2026-11-04T13:02:00.000Z'),          // the same code again
  ];
  const c = S.matchStatement(lines, sales);
  ok('by code: matched (the code typed in lower case, with other words)', c.matched.map((m) => m.sale.order_number).join() === 'T1-1,T1-6');
  ok('by code: the amount differs', c.amountDiffers.length === 1 && c.amountDiffers[0].sale.order_number === 'T1-2');
  ok('the same amount within 15 minutes: likely', c.likely.length === 1 && c.likely[0].sale.order_number === 'T1-3' && c.likely[0].line.code === 'SKA0000003');
  ok('not beyond 15 minutes', c.posOnly.some((p) => p.sale.order_number === 'T1-4' && p.reason === 'no_code'));
  ok('a code not on the statement', c.posOnly.some((p) => p.sale.order_number === 'T1-5' && p.reason === 'unknown_code'));
  ok('a code a second sale used again', c.posOnly.some((p) => p.sale.order_number === 'T1-7' && p.reason === 'code_used_twice'));
  ok('money in with no sale; failed lines and withdrawals left out', c.statementOnly.map((l) => l.code).join() === 'SKA0000004,SKA0000008', JSON.stringify(c.statementOnly.map((l) => l.code)));
  ok('the totals', c.totals.statementIn === 2650 && c.totals.posMpesa === 2720 && c.totals.matched === 950 && c.totals.statementOnly === 650
    && c.totals.posOnly === 770, JSON.stringify(c.totals));

  console.log('\nW. Wiring');
  const route = read('apps/server/src/routes/mpesaStatement.ts');
  ok('the route: reports.payments, the online licence, web only, the branch scope',
    route.includes("router.get('/sales', requirePermission('reports.payments'),") && route.includes('router.use(requireWebSurface);')
      && route.includes('await c2bLicensed(req.businessId!)') && route.includes('const branchId = branchScope(req);') && route.includes('if (oneBranchOnly(req, res)) return;'));
  ok('completed M-Pesa legs of the caller\'s business, in the Kenyan days',
    route.includes(".eq('business_id', req.businessId).eq('method', 'mpesa').eq('status', 'completed')") && route.includes('businessRangeEAT(days.from, days.to)'));
  ok('mounted under /api/payments/mpesa-statement', read('apps/server/src/routes/index.ts').includes("router.use('/payments/mpesa-statement', mpesaStatementRoutes);"));
  const rp = read('apps/dashboard/src/pages/ReportsPage.tsx');
  ok('the tab loads on demand (SheetJS and pdf.js with it)', rp.includes("const MpesaStatementTab = lazy(() => import('./reports/MpesaStatementTab'));"));
  const sf = read('apps/dashboard/src/lib/statementFile.ts');
  ok('a password-protected PDF asks for its password', sf.includes("if (e?.name === 'PasswordException') throw new StatementPasswordError("));
  ok('a CSV is read as text (no guessed dates); Excel date cells as their wall clock',
    sf.includes("XLSX.read(await file.text(), { type: 'string', raw: true })") && sf.includes('c instanceof Date ? wallClock(c) : c'));
  ok('the statement is never sent: the tab posts nothing', !/api\.(post|put|patch)/.test(read('apps/dashboard/src/pages/reports/MpesaStatementTab.tsx')));
} catch (e) {
  ok('the test ran to its end', false, e?.stack ?? String(e));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/** A small PDF: each page a list of [x, y, text] in Helvetica 9 pt. */
function makePdf(pages) {
  const esc = (s) => s.replace(/[\\()]/g, (m) => `\\${m}`);
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + pages.length * 2;
  const kids = [];
  for (const items of pages) {
    const stream = items.map(([x, y, t]) => `BT /F1 9 Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 842 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => { const at = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
