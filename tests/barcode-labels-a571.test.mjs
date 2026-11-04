// A571 — generate barcodes, and print labels on ANY printer and ANY label size (the shared encoders and layout, the
// cloud's generate / label-settings routes, the web's print page, and the till scanner's matching).
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/barcode-labels-a571.test.mjs
//
// Owner, 2026-10-22: "we do not have barcode generation mechanism, what does it entail can we add it?" — then: "for now
// i cant tell what my clients will use as their printer or the label size can we do all?"
//
//   E  encoders (packages/core/src/barcode.ts): GS1 check digits, EAN-13 / UPC-A decoded back with the published L/G/R tables and
//      first-digit parity, the Code 128 table (every symbol 11 modules, an even bar sum, all distinct), known values and
//      checksums, subset B/C switching, module strings decoded back to symbol values.
//   G  in-store codes: prefix 20, the check digit, the next free number, 21–29 and manufacturer codes left alone.
//   L  layout (packages/core/src/labels.ts): every preset size and a custom one — the text and the bars inside the label, rows not
//      overlapping, whole-dot modules, the quiet zones on the label; the sheet grid; "start at label N".
//   P  the printer languages: TSPL and ZPL golden strings, the ESC/POS bytes (GS k EAN-13, CODE128 subsets, raster).
//   H  the web's print page: one SVG per label and @page the label's size; sheets on A4 with the cells where they belong.
//   S  scanning: a generated code is found by the till's matcher and the web POS's (source pins: POSPage is A566's).
//   C  the cloud over HTTP (the COMPILED routers, real requireAuth / requirePermission, the database in memory):
//      POST /api/products/barcodes/generate — menu.edit only; dry run; prefix 20, unique, never over a barcode (one set
//      between the read and the write included); two at once never duplicate (the unique index, simulated); this
//      business only; GET/PUT /api/products/labels/settings — cleaned, PUT menu.edit only.
//
// A574 (owner, 2026-10-22, after testing: "label should contain barcodes"; then "i should also be able to set barcode
// start sequence, number of digits i need etc") — the deliberate changes to the cases above (a label is never made
// without bars, so the A571 cases that laid out an item with no barcode now give it one), and:
//   B  no barcode toggle: cleanLabelSettings forces showBarcode true; neither settings screen offers the switch.
//   N  a row without a barcode is never rendered bar-less, on all four paths — the browser page (HTML/SVG, roll), the
//      sheet, TSPL / ZPL, ESC/POS; a code that cannot be encoded as EAN / UPC still prints as Code 128; EAN-8 drawn.
//   M  barcode numbering (packages/core/src/barcode.ts): each format, length, prefix, start, check digit, the range used up.
//   W  the web page generates the missing codes before printing (source), and prints the rest without menu.edit.
//   C+ the cloud: GET/PUT /api/products/barcodes/settings (cleaned, PUT menu.edit only); generate follows the numbering
//      (format, prefix, start, after the highest used); a range used up refuses before anything is written.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A571 register entry):
//   - gs1CheckDigit weighting from the left instead of the right             → E "check digits" fails
//   - EAN_PARITY row 5 swapped                                               → E "EAN-13 decodes" fails
//   - code128Segments switching to C on 4 digits mid-text                    → E "subset switching" fails
//   - IN_STORE_PREFIX '21'                                                   → G "prefix 20" fails
//   - layoutLabel without the floor() on the module width                    → L "whole dots" fails
//   - placeOnSheets ignoring startAt                                         → L "start at label N" fails
//   - the generate route's update without the is('barcode', null) condition → C "never over a barcode" fails
//   - the generate route not retrying on 23505                               → C "two at once" fails
//   - the generate route without requirePermission('menu.edit')              → C "a cashier is refused" fails
// A574 mutations (each made, seen to fail, reverted — listed in the A574 register entry):
//   - cleanLabelSettings keeping a stored showBarcode: false                  → B "no barcode toggle" fails
//   - layoutLabel without its NO_BARCODE throw (bars optional again)          → N "never bar-less" fails
//   - labelSvg / tsplLabel / zplLabel without assertLabelBars                 → N "a hand-made layout without bars" fails
//   - escposLabel without its NO_BARCODE throw                                → N "ESC/POS refuses" fails
//   - nextNumberedCodes starting at `start` + 1 (top = start)                → M "start number" fails
//   - numberedCode without the check digit                                    → M "each format" fails
//   - the generate route without the range-full refusal                       → C+ "a range used up" fails
//   - LabelsPage printing without generating first                            → W "generates before printing" fails
//   - clashesWithScaleCodes never true for EAN-13                             → M "prefix warnings" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/products.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

const BC = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/barcode.ts')).href);
const LB = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/labels.ts')).href);
const PG = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/paginate.ts')).href);

// ── independent references (published tables, not the module's own) ──
const L_CODES = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R_CODES = L_CODES.map((c) => [...c].map((b) => (b === '0' ? '1' : '0')).join(''));
const G_CODES = R_CODES.map((c) => [...c].reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLG', 'LGLGGL', 'LGLGLG', 'LGGLGL'];
/** EAN-13 modules → the 13 digits, by the published tables. */
function decodeEan13(m) {
  assert.equal(m.length, 95, '95 modules');
  assert.equal(m.slice(0, 3), '101'); assert.equal(m.slice(45, 50), '01010'); assert.equal(m.slice(92), '101');
  let parity = '', left = '';
  for (let i = 0; i < 6; i++) {
    const s = m.slice(3 + i * 7, 10 + i * 7);
    const l = L_CODES.indexOf(s), g = G_CODES.indexOf(s);
    assert.ok(l >= 0 || g >= 0, `left digit ${i} decodes`);
    parity += l >= 0 ? 'L' : 'G'; left += l >= 0 ? l : g;
  }
  let right = '';
  for (let i = 0; i < 6; i++) { const r = R_CODES.indexOf(m.slice(50 + i * 7, 57 + i * 7)); assert.ok(r >= 0); right += r; }
  return String(PARITY.indexOf(parity)) + left + right;
}
/** Code 128 modules → symbol values, through the width table. */
function decode128(m) {
  const widths = (s) => { const out = []; let i = 0; while (i < s.length) { let j = i; while (s[j] === s[i]) j++; out.push(j - i); i = j; } return out.join(''); };
  const vals = [];
  for (let i = 0; i < m.length - 13; i += 11) vals.push(BC.CODE128_WIDTHS.indexOf(widths(m.slice(i, i + 11))));
  assert.equal(widths(m.slice(m.length - 13)), '2331112', 'the stop');
  return [...vals, 106];
}
const check128 = (vals) => vals.reduce((s, v, i) => s + v * Math.max(1, i), 0) % 103;

try {
  console.log('\nE. encoders\n');
  await ok('check digits: published examples (EAN-13, UPC-A, EAN-8)', () => {
    assert.equal(BC.gs1CheckDigit('400638133393'), 1);   // 4006381333931
    assert.equal(BC.gs1CheckDigit('590123412345'), 7);   // 5901234123457
    assert.equal(BC.gs1CheckDigit('03600029145'), 2);    // UPC-A 036000291452
    assert.equal(BC.gs1CheckDigit('9638507'), 4);        // EAN-8 96385074
    assert.ok(BC.isValidGtin('4006381333931') && BC.isValidGtin('036000291452') && BC.isValidGtin('96385074'));
    assert.ok(!BC.isValidGtin('4006381333932'));
  });
  await ok('EAN-13 decodes back to its digits (published L/G/R tables and first-digit parity)', () => {
    for (const c of ['4006381333931', '5901234123457', '9780306406157', '2000000000015']) assert.equal(decodeEan13(BC.encodeEan13(c).modules), c);
    assert.equal(BC.encodeEan13('400638133393').data, '4006381333931', '12 digits: the check digit added');
    assert.throws(() => BC.encodeEan13('4006381333932'), /check digit/);
  });
  await ok('UPC-A: the EAN-13 bars of 0 + the code, shown as 12 digits', () => {
    const u = BC.encodeUpcA('036000291452');
    assert.equal(decodeEan13(u.modules), '0036000291452');
    assert.deepEqual([u.symbology, u.data, u.text], ['UPCA', '036000291452', '036000291452']);
    assert.equal(BC.encodeUpcA('03600029145').data, '036000291452');
  });
  await ok('the Code 128 table: 107 distinct symbols, 11 modules each (stop 13), an even bar sum', () => {
    const W = BC.CODE128_WIDTHS;
    assert.equal(W.length, 107); assert.equal(new Set(W).size, 107);
    W.forEach((w, i) => {
      const digits = [...w].map(Number);
      assert.equal(digits.reduce((a, b) => a + b, 0), i === 106 ? 13 : 11, `symbol ${i}`);
      assert.equal(digits.filter((_, j) => j % 2 === 0).reduce((a, b) => a + b, 0) % 2, 0, `symbol ${i} bar sum even`);
    });
    // Published patterns: value 0 (space in B), start A, start B, start C, stop.
    assert.deepEqual([W[0], W[103], W[104], W[105], W[106]], ['212222', '211412', '211214', '211232', '2331112']);
  });
  await ok('Code 128: known values and checksums; the modules decode back to them', () => {
    const p = BC.encodeCode128('PJJ123C');   // 3 digits: subset B throughout
    assert.deepEqual(p.values, [104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    assert.equal(check128([104, 48, 42, 42, 17, 18, 19, 35]), 55);
    assert.deepEqual(decode128(p.modules), p.values);
    const n = BC.encodeCode128('1234567890');   // all digits: subset C
    assert.deepEqual(n.values, [105, 12, 34, 56, 78, 90, 85, 106]);
    assert.deepEqual(decode128(n.modules), n.values);
    assert.equal(n.modules.length, 7 * 11 + 13);
  });
  await ok('Code 128 subset switching (B ↔ C)', () => {
    const seg = (t) => BC.code128Segments(t).map((s) => `${s.set}:${s.text}`).join(' ');
    assert.equal(seg('ABC123456'), 'B:ABC C:123456');   // 6 digits at the end
    assert.equal(seg('12345'), 'C:1234 B:5');           // 4+ leading, odd: the last digit in B
    assert.equal(seg('AB1234CD'), 'B:AB1234CD');        // 4 inside: not worth a switch
    assert.equal(seg('X123456Y'), 'B:X C:123456 B:Y');  // 6 inside
    assert.equal(seg('A12345'), 'B:A1 C:2345');         // 5 at the end, odd: the first digit in B
    assert.equal(seg('12'), 'C:12');
    const v = BC.encodeCode128('X123456Y').values;
    assert.deepEqual(v.slice(0, -2), [104, 56, 99, 12, 34, 56, 100, 57]);
    assert.equal(v[v.length - 2], check128(v.slice(0, -2)));
  });
  await ok('any stored code works: EAN-13, UPC-A as they are, anything else Code 128, the unprintable none', () => {
    assert.equal(BC.encodeBarcode('5901234123457').symbology, 'EAN13');
    assert.equal(BC.encodeBarcode('036000291452').symbology, 'UPCA');
    assert.equal(BC.encodeBarcode('5901234123458').symbology, 'CODE128', 'a wrong check digit is still printed (as Code 128)');
    assert.equal(BC.encodeBarcode('SKU-00x7').symbology, 'CODE128');
    assert.equal(BC.encodeBarcode(''), null); assert.equal(BC.encodeBarcode('Café'), null);
  });

  console.log('\nG. in-store codes\n');
  await ok('prefix 20 + a 10-digit item number + the check digit', () => {
    assert.equal(BC.IN_STORE_PREFIX, '20');
    assert.equal(BC.inStoreEan13(1), '2000000000015');
    assert.equal(BC.inStoreEan13(1234567), '2000012345678');
    assert.ok(BC.isValidGtin(BC.inStoreEan13(9_999_999_999)));
    assert.equal(BC.inStoreNumber('2000012345678'), 1234567);
  });
  await ok('the next free numbers: after the highest, skipping taken ones; 21–29 scale codes and manufacturers ignored', () => {
    assert.deepEqual(BC.nextInStoreCodes([], 2), ['2000000000015', '2000000000022']);
    const taken = ['2000000000015', '2000000000039', '2100001002508', '5901234123457', null, ''];
    assert.deepEqual(BC.nextInStoreCodes(taken, 2), ['2000000000046', '2000000000053']);
    assert.equal(BC.isInStoreCode('2100001002508'), false, 'a scale code is not ours');
    assert.ok(BC.lacksBarcode('  ') && BC.lacksBarcode(null) && !BC.lacksBarcode('x'));
  });

  console.log('\nL. layout\n');
  const SAMPLE = { name: 'Crispy Chicken Burger Spicy Large', price: 1250, business: 'Pollo Foods' };
  const sizes = [...LB.LABEL_SIZE_PRESETS.map((s) => [s.widthMm, s.heightMm]), [25, 15], [100, 50]];
  await ok('every size: text and bars inside the label, no overlap, whole-dot modules, the quiet zones on the label', () => {
    for (const dpi of [203, 300]) for (const [w, h] of sizes) for (const code of ['2000000000015', 'SKU-0001234567']) {
      const s = LB.cleanLabelSettings({ widthMm: w, heightMm: h, dpi, showBusiness: true });
      const l = LB.layoutLabel(s, SAMPLE, BC.encodeBarcode(code));
      const at = `${w}×${h} @${dpi} ${code}`;
      assert.equal(l.widthDots, Math.round(w * (dpi === 300 ? 12 : 8)), at);
      const boxes = [...l.texts.map((t) => ({ y: t.y, h: t.h, x: t.x, w: t.w })), { y: l.barsBox.y, h: l.barsBox.h, x: l.barsBox.x, w: l.barsBox.widthDots }]
        .sort((a, b) => a.y - b.y);
      for (const b of boxes) {
        assert.ok(b.x >= 0 && b.x + b.w <= l.widthDots, `${at}: inside across`);
        assert.ok(b.y >= 0 && b.y + b.h <= l.heightDots, `${at}: inside down`);
      }
      for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].y >= boxes[i - 1].y + boxes[i - 1].h, `${at}: rows do not overlap`);
      const bb = l.barsBox, bars = l.bars;
      assert.ok(Number.isInteger(bb.moduleDots) && bb.moduleDots >= 1, `${at}: whole dots`);
      assert.equal(bb.widthDots, bars.modules.length * bb.moduleDots);
      if (!l.warnings.some((x) => /wider than the label/.test(x))) {
        assert.ok(bb.x >= bars.quietLeft * bb.moduleDots && bb.x + bb.widthDots + bars.quietRight * bb.moduleDots <= l.widthDots, `${at}: quiet zones`);
      }
      assert.ok(bb.h >= Math.round(2 * l.dotsPerMm), `${at}: bars at least 2 mm`);
    }
  });
  await ok('auto-fit: the name wraps to two lines, shrinks on a small label, the business name gives way first', () => {
    const big = LB.layoutLabel(LB.cleanLabelSettings({ widthMm: 60, heightMm: 40, showBusiness: true }), SAMPLE, BC.encodeBarcode('2000000000015'));
    assert.equal(big.texts.filter((t) => t.kind === 'name').length, 2); assert.deepEqual(big.warnings, []);
    const tiny = LB.layoutLabel(LB.cleanLabelSettings({ widthMm: 25, heightMm: 15, showBusiness: true }), SAMPLE, BC.encodeBarcode('2000000000015'));
    assert.ok(tiny.warnings.length > 0, 'says what gave way');
    assert.ok(!tiny.texts.some((t) => t.kind === 'business'), 'the business name goes first');
    assert.ok(tiny.warnings.includes('The business name is left off: the label is too small'));
    assert.ok(tiny.texts.some((t) => t.kind === 'name') && tiny.texts.some((t) => t.kind === 'price'), 'the name and the price stay');
    const noPrice = LB.layoutLabel(LB.cleanLabelSettings({ showPrice: false }), SAMPLE, BC.encodeBarcode('2000000000015'));
    assert.ok(!noPrice.texts.some((t) => t.kind === 'price'));
    const unit = LB.layoutLabel(LB.cleanLabelSettings({ unitText: 'per kg' }), { name: 'Sukuma', price: 80 }, BC.encodeBarcode('2000000000015'));   // A574: never without bars
    assert.equal(unit.texts.find((t) => t.kind === 'price').text, 'KES 80 per kg');
    assert.equal(LB.formatLabelPrice(1250.5), 'KES 1,250.50');
  });
  await ok('settings cleaned: sizes clamped, unknown keys dropped, dpi 203 / 300 only', () => {
    const s = LB.cleanLabelSettings({ widthMm: 5, heightMm: 900, dpi: 600, evil: 1, unitText: 'x'.repeat(50) });
    assert.deepEqual([s.widthMm, s.heightMm, s.dpi, s.unitText.length, 'evil' in s], [15, 200, 203, 20, false]);
    assert.deepEqual(LB.cleanLabelSettings('not json'), LB.DEFAULT_LABEL_SETTINGS);
  });
  await ok('the sheet grid: 3×7 on A4 at its margins and pitch, every preset fits, a custom one computed', () => {
    const g = LB.sheetGrid(LB.SHEET_PRESETS['3x7']);
    assert.equal(g.cells.length, 21);
    assert.deepEqual(g.cells[0], { x: 7.2, y: 15.1, w: 63.5, h: 38.1 });
    assert.deepEqual([g.cells[1].x, g.cells[1].y], [73.2, 15.1]);     // 7.2 + 63.5 + 2.5
    assert.deepEqual([g.cells[3].x, g.cells[3].y], [7.2, 53.2]);      // row 2
    for (const id of ['3x7', '3x8', '4x10', '5x13']) assert.ok(LB.sheetGrid(LB.SHEET_PRESETS[id]).fits, id);
    const c = LB.cleanLabelSettings({ sheet: { preset: 'custom', paper: 'A4', cols: 2, rows: 5, marginTopMm: 10, marginLeftMm: 5, gapXMm: 0, gapYMm: 0 } }).sheet;
    assert.deepEqual([c.labelWidthMm, c.labelHeightMm], [100, 55.4]);
    assert.ok(LB.sheetGrid(c).fits);
    assert.ok(!LB.sheetGrid({ ...LB.SHEET_PRESETS['3x7'], marginTopMm: 40 }).fits, 'a grid off the page is said so');
  });
  await ok('"start at label N": a part-used sheet is used up first, then new sheets', () => {
    assert.deepEqual(LB.placeOnSheets(3, 21, 20), [{ page: 0, cell: 19 }, { page: 0, cell: 20 }, { page: 1, cell: 0 }]);
    assert.deepEqual(LB.placeOnSheets(2, 21, 1), [{ page: 0, cell: 0 }, { page: 0, cell: 1 }]);
    assert.deepEqual(LB.placeOnSheets(1, 21, 99), [{ page: 0, cell: 20 }], 'past the end: the last label');
  });

  console.log('\nP. the printer languages\n');
  const s4030 = LB.cleanLabelSettings({ widthMm: 40, heightMm: 30 });
  const milk = LB.layoutLabel(s4030, { name: 'Milk 500ml', price: 65 }, BC.encodeBarcode('2000000000015'));
  const sugar = LB.layoutLabel(LB.cleanLabelSettings({ widthMm: 50, heightMm: 25, dpi: 300 }), { name: 'Sugar 1kg', price: 189.5 }, BC.encodeBarcode('AB-1234567'));
  await ok('TSPL (TSC / Xprinter): golden programs, EAN-13 and Code 128, 203 and 300 dpi', () => {
    assert.equal(LB.tsplLabel(milk, 2, 3),
      'SIZE 40 mm, 30 mm\r\nGAP 2 mm, 0 mm\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\n'
      + 'TEXT 40,16,"4",0,1,1,"Milk 500ml"\r\nTEXT 88,55,"2",0,2,2,"KES 65"\r\nTEXT 56,202,"3",0,1,1,"2000000000015"\r\n'
      + 'BARCODE 65,98,"EAN13",101,0,0,2,2,"200000000001"\r\nPRINT 1,3\r\n');
    assert.equal(LB.tsplLabel(sugar, 2, 1),
      'SIZE 50 mm, 25 mm\r\nGAP 2 mm, 0 mm\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\n'
      + 'TEXT 192,20,"1",0,2,2,"Sugar 1kg"\r\nTEXT 140,72,"4",0,1,1,"KES 189.50"\r\nTEXT 180,250,"3",0,1,1,"AB-1234567"\r\n'
      + 'BARCODE 54,125,"128",118,0,0,4,4,"AB-1234567"\r\nPRINT 1,1\r\n');
    const q = LB.tsplLabel(LB.layoutLabel(s4030, { name: 'Say "hi" …', price: null }, BC.encodeBarcode('2000000000015')), 0);
    assert.ok(q.includes('"Say \\["]hi\\["] ..."') || q.includes('\\["]'), 'a quote escaped, … as dots');
  });
  await ok('ZPL (Zebra): golden programs (^BE EAN-13, ^BC with the B/C invocation codes, ^FH escapes)', () => {
    assert.equal(LB.zplLabel(milk, 3),
      '^XA\n^CI28\n^PW320\n^LL240\n^LH0,0\n^FO14,14^A0N,34^FB292,1,0,C,0^FH^FDMilk 500ml^FS\n'
      + '^FO14,51^A0N,44^FB292,1,0,C,0^FH^FDKES 65^FS\n^FO14,202^A0N,24^FB292,1,0,C,0^FH^FD2000000000015^FS\n'
      + '^FO65,98^BY2^BEN,101,N,N^FD200000000001^FS\n^PQ3\n^XZ\n');
    assert.equal(LB.zplLabel(sugar, 1),
      '^XA\n^CI28\n^PW600\n^LL300\n^LH0,0\n^FO18,18^A0N,42^FB564,1,0,C,0^FH^FDSugar 1kg^FS\n'
      + '^FO18,65^A0N,55^FB564,1,0,C,0^FH^FDKES 189.50^FS\n^FO18,248^A0N,34^FB564,1,0,C,0^FH^FDAB-1234567^FS\n'
      + '^FO54,125^BY4^BCN,118,N,N,N,N^FH^FD>:AB-1>5234567^FS\n^PQ1\n^XZ\n');
    const z = LB.zplLabel(LB.layoutLabel(s4030, { name: 'A^B~C_D', price: null }, BC.encodeBarcode('2000000000015')));
    assert.ok(z.includes('^FDA_5EB_7EC_5FD^FS'), 'a ^ ~ _ in a name cannot start a command');
    assert.equal(LB.zplCode128Data([{ set: 'C', text: '12' }, { set: 'B', text: 'a>b' }]), '>;12>6a><b');
  });
  await ok('ESC/POS (the receipt printer): GS h / w / H / f then GS k — EAN-13 (m 67), CODE128 with {B / {C', () => {
    const hex = (a) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');
    assert.equal(hex(LB.escposLabel(s4030, { name: 'Milk', price: 65 }, BC.encodeBarcode('2000000000015'), { paperWidthMm: 58, mode: 'gsk' })),
      '1b 40 1b 61 01 1b 45 01 4d 69 6c 6b 0a 1b 45 00 1d 21 11 4b 45 53 20 36 35 0a 1d 21 00 '
      + '1d 68 50 1d 77 03 1d 48 02 1d 66 00 1d 6b 43 0c 32 30 30 30 30 30 30 30 30 30 30 31 0a 0a 0a 0a 1d 56 42 00');
    assert.equal(hex(LB.escposBarcodeCommand(BC.encodeBarcode('AB-1234567'))), '1d 6b 49 0b 7b 42 41 42 2d 31 7b 43 17 2d 43');
    assert.equal(hex(LB.escposBarcodeCommand(BC.encodeBarcode('036000291452'))), '1d 6b 41 0b 30 33 36 30 30 30 32 39 31 34 35');
    assert.equal(hex(LB.escposBarcodeCommand(BC.encodeBarcode('a{b'))), '1d 6b 49 06 7b 42 61 7b 7b 62', 'a "{" sent as "{{"');
    const r = LB.escposBarsRaster(BC.encodeBarcode('2000000000015'), 80, 40);
    assert.equal(hex(r.slice(0, 8)), '1d 76 30 00 48 00 28 00', 'GS v 0: 72 bytes × 40 rows');
    assert.equal(r.length, 8 + 72 * 40);
    const two = LB.escposLabel(s4030, { name: 'Milk', price: 65 }, BC.encodeBarcode('2000000000015'), { paperWidthMm: 80, mode: 'gsk', copies: 2 });
    assert.equal(hex(two).split('1d 56 42 00').length - 1, 2, 'one cut per copy');
  });

  console.log('\nH. the web\'s print page\n');
  await ok('roll: one page per label, @page the label\'s size, margin 0, an SVG each (sized in mm)', () => {
    const rows = [{ item: { name: 'Milk', price: 65 }, barcode: '2000000000015', copies: 2 }, { item: { name: 'Bread', price: 60 }, barcode: null, copies: 1 }];
    // A574: Bread (no barcode) is left out — never a page without bars — and said why.
    const left = [];
    const labels = LB.layoutLabels(rows, LB.cleanLabelSettings({ widthMm: 38, heightMm: 25 }), BC.encodeBarcode, { onSkip: (r, why) => left.push([r.item.name, why]) });
    assert.equal(labels.length, 2);
    assert.deepEqual(left, [['Bread', 'it has no barcode yet']]);
    const html = LB.labelsHtml(labels, { mode: 'roll' });
    assert.ok(html.includes('@page{size:38mm 25mm;margin:0}'));
    assert.equal(html.split('<svg').length - 1, 2);
    assert.equal(html.split('class="zt-page"').length - 1, 2);
    assert.ok(html.includes('width="38mm" height="25mm"'));
    assert.ok(/<rect x="\d+" y="\d+" width="\d+" height="\d+"\/>/.test(html), 'bars drawn');
    assert.ok(html.includes('>2000000000015</text>'));
    assert.ok(!LB.labelSvg(LB.layoutLabel(LB.DEFAULT_LABEL_SETTINGS, { name: '<script>x', price: 1 }, BC.encodeBarcode('2000000000015'))).includes('<script>'), 'names escaped');
  });
  await ok('sheet: A4 pages, each label in its cell, "start at label N"', () => {
    const sheet = LB.SHEET_PRESETS['3x7'];
    const labels = LB.layoutLabels([{ item: { name: 'Milk', price: 65 }, barcode: '2000000000015', copies: 3 }], LB.DEFAULT_LABEL_SETTINGS, BC.encodeBarcode,
      { widthMm: sheet.labelWidthMm, heightMm: sheet.labelHeightMm });
    const html = LB.labelsHtml(labels, { mode: 'sheet', sheet, startAt: 20 });
    assert.ok(html.includes('@page{size:210mm 297mm;margin:0}'));
    assert.equal(html.split('class="zt-sheet"').length - 1, 2, 'labels 20, 21 on sheet one, the third on sheet two');
    assert.ok(html.includes('left:73.2mm;top:243.7mm'), 'label 20: row 7, column 2');
    assert.ok(html.includes('left:7.2mm;top:15.1mm'), 'the third: the top-left of the new sheet');
  });
  await ok('the page and the Products page are wired (route, nav, generate, print)', () => {
    const page = read('apps/dashboard/src/pages/products/LabelsPage.tsx');
    for (const pin of ['layoutLabels(toRows(list), settings, encodeBarcode', 'labelsHtml(labels, { mode, sheet: settings.sheet, startAt', 'printHtml(',
      "'/api/products/labels/settings'", '/api/products/labels/restocked', 'reprint']) assert.ok(page.includes(pin), pin);
    assert.ok(read('apps/dashboard/src/App.tsx').includes('path="products/labels"'));
    assert.ok(read('apps/dashboard/src/components/DashboardLayout.tsx').includes("'/dashboard/products/labels'"));
    const prod = read('apps/dashboard/src/pages/products/ProductsPage.tsx');
    assert.ok(prod.includes("'/api/products/barcodes/generate', { product_ids: [editing.id] }") && prod.includes('Generate barcodes') && prod.includes('barcode: form.barcode.trim() || null'));
    const gen = read('apps/dashboard/src/pages/products/GenerateBarcodes.tsx');
    assert.ok(gen.includes('dry_run: true'), 'a count before the confirm');
  });

  // ── A574 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. A574: no barcode toggle\n');
  await ok('no barcode toggle: a stored showBarcode false reads as true; neither settings screen offers the switch', () => {
    assert.equal(LB.cleanLabelSettings({ showBarcode: false }).showBarcode, true);
    assert.equal(LB.cleanLabelSettings('{"showBarcode":false}').showBarcode, true);
    assert.equal(LB.DEFAULT_LABEL_SETTINGS.showBarcode, true);
    for (const f of ['apps/dashboard/src/pages/products/LabelsPage.tsx', 'apps/desktop/src/renderer/components/LabelsTab.tsx']) {
      const src = read(f);
      assert.ok(!/\['showBarcode',/.test(src), `${f}: the Barcode switch is gone`);
      assert.ok(/\['showDigits', 'Digits under the bars'\]/.test(src), `${f}: the digits under the bars stay a choice`);
    }
  });

  console.log('\nN. A574: never a label without bars (all four paths)\n');
  const NB = /No barcode: a label is never printed without one/;
  const milk2 = LB.layoutLabel(LB.cleanLabelSettings({ widthMm: 40, heightMm: 30 }), { name: 'Milk', price: 65 }, BC.encodeBarcode('2000000000015'));
  const noBars = { ...milk2, bars: null, barsBox: null };
  await ok('layout: an item without a barcode has no layout (NO_BARCODE); layoutLabels leaves it out and says why', () => {
    assert.throws(() => LB.layoutLabel(LB.DEFAULT_LABEL_SETTINGS, { name: 'Bread', price: 60 }, null), NB);
    const why = [];
    const out = LB.layoutLabels([
      { item: { name: 'Bread', price: 60 }, barcode: null, copies: 2 },
      { item: { name: 'Eggs', price: 15 }, barcode: '   ', copies: 1 },
      { item: { name: 'Café', price: 300 }, barcode: 'Café', copies: 1 },
      { item: { name: 'Milk', price: 65 }, barcode: '2000000000015', copies: 1 },
    ], LB.DEFAULT_LABEL_SETTINGS, BC.encodeBarcode, { onSkip: (r, w) => why.push(`${r.item.name}: ${w}`) });
    assert.equal(out.length, 1);
    assert.ok(out.every((l) => l.bars && l.barsBox && l.bars.modules.length > 0));
    assert.deepEqual(why.map((w) => w.split(':')[0]), ['Bread', 'Eggs', 'Café']);
    assert.ok(/cannot be drawn/.test(why[2]));
  });
  await ok('the browser page (roll, HTML/SVG): every label has bars; a layout without bars is refused, not drawn', () => {
    const html = LB.labelsHtml(LB.layoutLabels([{ item: { name: 'Milk', price: 65 }, barcode: '2000000000015', copies: 3 },
      { item: { name: 'Bread', price: 60 }, barcode: null, copies: 4 }], LB.DEFAULT_LABEL_SETTINGS, BC.encodeBarcode), { mode: 'roll' });
    assert.equal(html.split('<svg').length - 1, 3);
    assert.equal(html.split('<g fill="#000" shape-rendering="crispEdges"><rect').length - 1, 3, 'each SVG has its bars');
    assert.throws(() => LB.labelSvg(noBars), NB);
    assert.throws(() => LB.labelsHtml([milk2, noBars], { mode: 'roll' }), NB);
  });
  await ok('the sticker sheet: a row without a barcode never reaches the sheet; a layout without bars is refused', () => {
    const sheet = LB.SHEET_PRESETS['3x8'];
    const size = { widthMm: sheet.labelWidthMm, heightMm: sheet.labelHeightMm };
    const labels = LB.layoutLabels([{ item: { name: 'Bread', price: 60 }, barcode: null, copies: 5 },
      { item: { name: 'Milk', price: 65 }, barcode: '2000000000015', copies: 2 }], LB.DEFAULT_LABEL_SETTINGS, BC.encodeBarcode, size);
    const html = LB.labelsHtml(labels, { mode: 'sheet', sheet });
    assert.equal(html.split('class="zt-cell"').length - 1, 2);
    assert.equal(html.split('<g fill="#000"').length - 1, 2);
    assert.throws(() => LB.labelsHtml([noBars], { mode: 'sheet', sheet }), NB);
  });
  await ok('TSPL / ZPL: a layout without bars is refused (no program without BARCODE / ^B)', () => {
    assert.throws(() => LB.tsplLabel(noBars, 2), NB);
    assert.throws(() => LB.zplLabel(noBars), NB);
    assert.ok(LB.tsplLabel(milk2, 2).includes('BARCODE ') && LB.zplLabel(milk2).includes('^BEN'));
  });
  await ok('ESC/POS refuses an item without bars (no slip without a barcode)', () => {
    assert.throws(() => LB.escposLabel(LB.DEFAULT_LABEL_SETTINGS, { name: 'Bread', price: 60 }, null, { paperWidthMm: 80, mode: 'gsk' }), NB);
    assert.throws(() => LB.escposLabel(LB.DEFAULT_LABEL_SETTINGS, { name: 'Bread', price: 60 }, null, { paperWidthMm: 58, mode: 'raster' }), NB);
    const off = LB.escposLabel(LB.cleanLabelSettings({ showBarcode: false }), { name: 'Milk', price: 65 }, BC.encodeBarcode('2000000000015'), { paperWidthMm: 80, mode: 'gsk' });
    assert.ok(off.some((b, i) => b === 0x1d && off[i + 1] === 0x6b), 'GS k sent even when a stored setting said no barcode');
  });
  await ok('a stored code that is not EAN / UPC still prints, as Code 128 (kept from A571)', () => {
    const l = LB.layoutLabels([{ item: { name: 'Soap', price: 99 }, barcode: '5901234123458', copies: 1 }], LB.DEFAULT_LABEL_SETTINGS, BC.encodeBarcode)[0];
    assert.equal(l.bars.symbology, 'CODE128');
  });
  await ok('EAN-8: decodes back by the published tables; TSPL "EAN8", ZPL ^B8, ESC/POS GS k m 68', () => {
    const e = BC.encodeEan8('9638507');
    assert.deepEqual([e.symbology, e.data, e.modules.length], ['EAN8', '96385074', 67]);
    const m = e.modules;
    assert.equal(m.slice(0, 3) + m.slice(31, 36) + m.slice(64), '10101010101');
    let digits = '';
    for (let i = 0; i < 4; i++) digits += L_CODES.indexOf(m.slice(3 + i * 7, 10 + i * 7));
    for (let i = 0; i < 4; i++) digits += R_CODES.indexOf(m.slice(36 + i * 7, 43 + i * 7));
    assert.equal(digits, '96385074');
    assert.equal(BC.symbologyFor('96385074'), 'EAN8');
    assert.throws(() => BC.encodeEan8('96385075'), /check digit/);
    const l = LB.layoutLabel(LB.DEFAULT_LABEL_SETTINGS, { name: 'Gum', price: 10 }, e);
    assert.ok(LB.tsplLabel(l, 2).includes('"EAN8",') && LB.tsplLabel(l, 2).includes('"9638507"'));
    assert.ok(LB.zplLabel(l).includes('^B8N,') && LB.zplLabel(l).includes('^FD9638507^FS'));
    assert.deepEqual(LB.escposBarcodeCommand(e).slice(0, 4), [0x1d, 0x6b, 68, 7]);
  });

  console.log('\nM. A574: barcode numbering\n');
  const NUM = (o) => BC.cleanBarcodeNumbering(o);
  await ok('the default is A571\'s numbering exactly (EAN-13, prefix 20, from 1)', () => {
    assert.deepEqual(BC.DEFAULT_BARCODE_NUMBERING, { format: 'EAN13', prefix: '20', start: 1, length: 13, checkDigit: true });
    assert.deepEqual(NUM(null), BC.DEFAULT_BARCODE_NUMBERING);
    for (const n of [1, 2, 1234567, 9_999_999_999]) assert.equal(BC.numberedCode(BC.DEFAULT_BARCODE_NUMBERING, n), BC.inStoreEan13(n));
    const taken = ['2000000000015', '2000000000039', '2100001002508', '5901234123457'];
    assert.deepEqual(BC.nextNumberedCodes(BC.DEFAULT_BARCODE_NUMBERING, taken, 2).codes, BC.nextInStoreCodes(taken, 2));
  });
  await ok('each format: its length, prefix, zero-padded number and check digit; each prints in its own symbology', () => {
    const e13 = NUM({ format: 'EAN13', prefix: '29', start: 500 });
    assert.equal(BC.numberedCode(e13, 500), '290000000500' + BC.gs1CheckDigit('290000000500'));
    assert.equal(BC.symbologyFor(BC.numberedCode(e13, 500)), 'EAN13');
    const e8 = NUM({ format: 'EAN8', prefix: '20', length: 99 });
    assert.deepEqual([e8.length, e8.checkDigit, BC.sequenceDigits(e8)], [8, true, 5], 'EAN-8: 8 digits fixed');
    const c8 = BC.numberedCode(e8, 1);
    assert.equal(c8, '2000001' + BC.gs1CheckDigit('2000001'));
    assert.ok(BC.isValidGtin(c8)); assert.equal(BC.encodeBarcode(c8).symbology, 'EAN8');
    const up = NUM({ format: 'UPCA', prefix: '4', start: 7, checkDigit: false });
    assert.deepEqual([up.length, up.checkDigit], [12, true], 'UPC-A: 12 digits, always a check digit');
    const cu = BC.numberedCode(up, 7);
    assert.equal(cu, '40000000007' + BC.gs1CheckDigit('40000000007'));
    assert.equal(BC.encodeBarcode(cu).symbology, 'UPCA');
    const c128 = NUM({ format: 'CODE128N', prefix: '9', length: 6, checkDigit: false });
    assert.equal(BC.numberedCode(c128, 1), '900001');
    assert.equal(BC.encodeBarcode('900001').symbology, 'CODE128');
    const c128k = NUM({ format: 'CODE128N', prefix: '9', length: 6, checkDigit: true });
    assert.equal(BC.numberedCode(c128k, 1), '90001' + BC.gs1CheckDigit('90001'));
    assert.equal(BC.sequenceOf(c128k, '900015'.slice(0, 5) + ((BC.gs1CheckDigit('90001') + 1) % 10)), null, 'a wrong check digit is not ours');
    assert.equal(BC.sequenceOf(c128k, BC.numberedCode(c128k, 42)), 42);
  });
  await ok('number of digits: Code 128 numeric 4–20 (clamped); the prefix digits only, leaving one sequence digit', () => {
    assert.equal(NUM({ format: 'CODE128N', length: 2 }).length, 4);
    assert.equal(NUM({ format: 'CODE128N', length: 50 }).length, 20);
    assert.equal(NUM({ format: 'CODE128N', length: 20 }).length, 20);
    assert.equal(NUM({ prefix: 'a1-b2' }).prefix, '12');
    assert.equal(NUM({ prefix: '1234567890123' }).prefix, '12345678901', 'EAN-13: 11 prefix digits at most (1 number + 1 check)');
    assert.equal(NUM({ prefix: '' }).prefix, '');
    assert.equal(BC.describeNumbering(BC.DEFAULT_BARCODE_NUMBERING), '13 digits: prefix 20 (2) + item number (10) + check digit (1)');
    const twenty = NUM({ format: 'CODE128N', length: 20, prefix: '' });
    assert.equal(BC.maxSequence(twenty), Number.MAX_SAFE_INTEGER, 'a 20-digit range counts no further than a number can');
    assert.equal(BC.numberedCode(twenty, 5), '00000000000000000005');
  });
  await ok('start number: the first code is the start; after it, the highest already used + 1 (codes below the start ignored)', () => {
    const s = NUM({ format: 'CODE128N', prefix: '5', length: 6, start: 100 });
    assert.deepEqual(BC.nextNumberedCodes(s, [], 2).codes, ['500100', '500101']);
    assert.deepEqual(BC.nextNumberedCodes(s, ['500050'], 1).codes, ['500100'], 'below the start: ignored');
    assert.deepEqual(BC.nextNumberedCodes(s, ['500150', '600999', 'X'], 1).codes, ['500151'], 'after the highest used');
    assert.deepEqual(BC.nextNumberedCodes(s, ['500100'], 1).codes, ['500101']);
    assert.equal(NUM({ format: 'CODE128N', prefix: '5', length: 4, start: 5000 }).start, 999, 'the start clamped to the range');
    assert.equal(NUM({ start: -3 }).start, 1);
  });
  await ok('the range used up: no code past the top, remaining counted, a plain message', () => {
    const s = NUM({ format: 'CODE128N', prefix: '99', length: 4, checkDigit: false, start: 97 });
    assert.equal(BC.maxSequence(s), 99);
    const r = BC.nextNumberedCodes(s, [], 5);
    assert.deepEqual([r.codes, r.remaining, r.exhausted], [['9997', '9998', '9999'], 3, true]);
    const full = BC.nextNumberedCodes(s, ['9999'], 1);
    assert.deepEqual([full.codes, full.remaining, full.exhausted], [[], 0, true]);
    assert.ok(/used up/.test(BC.rangeFullMessage(0, 1)) && /Only 3 new codes are left/.test(BC.rangeFullMessage(3, 5)));
    const p = BC.numberingPreview(s, ['9999']);
    assert.ok(p.exhausted && p.next.length === 0 && p.remaining === 0);
    assert.ok(p.warnings.some((w) => /only 99 codes/.test(w)));
  });
  await ok('prefix warnings (never a refusal): GS1 in-store 20–29 for EAN, 2 / 4 for UPC, scales on 21–29', () => {
    const w = (o) => BC.numberingWarnings(NUM(o)).join(' | ');
    assert.equal(w({}), '');
    assert.ok(/outside GS1's in-store range/.test(w({ prefix: '59' })));
    assert.ok(/outside GS1's in-store range/.test(w({ format: 'EAN8', prefix: '60' })));
    // A574 (owner, 2026-10-23, via A577's scale barcodes): 21–29 and UPC 2 are the scales' — any way the codes land there.
    for (const o of [{ prefix: '23' }, { prefix: '2' }, { prefix: '291' }, { format: 'UPCA', prefix: '2' }, { format: 'UPCA', prefix: '27' },
      { format: 'CODE128N', length: 13, checkDigit: true, prefix: '25' }, { format: 'CODE128N', length: 12, checkDigit: true, prefix: '2' }]) {
      assert.ok(w(o).includes(BC.SCALE_CLASH_WARNING), JSON.stringify(o));
    }
    for (const o of [{}, { prefix: '20' }, { prefix: '2050' }, { format: 'EAN8', prefix: '25' }, { format: 'UPCA', prefix: '4' },
      { format: 'CODE128N', length: 13, checkDigit: false, prefix: '25' }]) {
      assert.ok(!w(o).includes(BC.SCALE_CLASH_WARNING), JSON.stringify(o));
    }
    assert.ok(/number systems \(2 or 4\)/.test(w({ format: 'UPCA', prefix: '0' })));
    assert.equal(w({ format: 'UPCA', prefix: '4' }), '');
    assert.ok(/print as EAN-13/.test(w({ format: 'CODE128N', length: 13, checkDigit: true })));
    assert.equal(BC.numberedCode(NUM({ prefix: '59' }), 1).length, 13, 'warned, still made');
  });

  console.log('\nW. A574: the web page generates the missing codes before printing\n');
  await ok('Print labels: asks, generates for exactly the items without one, refreshes the rows, then prints; without menu.edit names them and prints the rest', () => {
    const page = read('apps/dashboard/src/pages/products/LabelsPage.tsx');
    const fn = page.slice(page.indexOf('const print = async'), page.indexOf('return (', page.indexOf('const print = async')));
    assert.ok(fn.length > 100, 'the print function is found');
    const at = (s) => { const i = fn.indexOf(s); assert.ok(i >= 0, `print: ${s}`); return i; };
    const ask = at("window.confirm(`${n} item${n === 1 ? ' has' : 's have'} no barcode yet — generate ${n === 1 ? 'it' : 'them'} and print?`)");
    const gen = at("api.post<{ assigned: Array<{ id: string; barcode: string }>; kept: string[] }>('/api/products/barcodes/generate',");
    at('{ product_ids: missing.map((p) => p.id) }');
    const refresh = at("api.get<Product[]>('/api/products')");
    const lay = at('layoutLabels(toRows(list), settings, encodeBarcode');
    const out = at('printHtml(labelsHtml(labels');
    assert.ok(ask < gen && gen < refresh && refresh < lay && lay < out, 'ask → generate → refresh → lay out → print');
    const noRight = at('if (!canGenerate) {');
    at('ask a manager to generate barcodes for: ${missing.map((p) => p.name).join');
    at('list = list.filter((p) => !missing.includes(p));');
    assert.ok(noRight < gen);
    assert.ok(page.includes("const canGenerate = usePermissions().can('menu.edit');"));
    assert.ok(page.includes('missing: picked.filter((p) => lacksBarcode(p.barcode))'));
    assert.ok(page.includes("api.put<BarcodeNumbering>('/api/products/barcodes/settings', numbering)") && page.includes('numberingPreview(numbering, allCodes)'),
      'the Barcode numbering section saves and previews');
    assert.ok(!/prints without bars/.test(page), 'the old "the label prints without bars" note is gone');
  });

  console.log('\nS. scanning\n');
  await ok('a generated code is found by the till\'s scanner rule, the web POS\'s, and the search (exactFirst)', () => {
    const products = [{ id: 'a', name: 'Milk', barcode: '5901234123457', plu: null, status: 'active' },
      { id: 'b', name: 'Bread', barcode: BC.inStoreEan13(2), plu: null, status: 'active' }];
    const scanned = '2000000000022';   // what a scanner types for the EAN-13 printed on the label
    assert.equal(BC.inStoreEan13(2), scanned);
    // The till's rule (POSPage.tsx, read only — A566 owns the file) and the web POS's, as they are written:
    const pos = read('apps/desktop/src/renderer/pages/POSPage.tsx');
    assert.ok(pos.includes('(p as any).barcode === scanned ||') && pos.includes('(p as any).plu === scanned'), 'the till matches barcode then PLU');
    const tillMatch = (list, s) => list.find((p) => p.barcode === s || p.plu === s);
    assert.equal(tillMatch(products, scanned)?.id, 'b');
    assert.ok(read('apps/dashboard/src/pages/pos/CashierScreen.tsx').includes('(p as any).barcode === buffer'));
    assert.equal(PG.exactFirst(products, scanned, (p) => [p.name, p.barcode, p.plu])[0].id, 'b');
  });

  // ── C. the cloud ────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. the cloud\n');
  process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
  process.env.JWT_SECRET = randomBytes(24).toString('hex');
  process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
  process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
  process.env.TILL_SCOPE_ENFORCE = 'true';
  const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
  const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
  const mem = installMemDb(supabase);
  const state = require(path.join(DIST, 'lib/permissionsState.js'));
  const AC = require(path.join(DIST, 'lib/authCache.js'));
  const warn = console.warn; console.warn = () => {};
  const errLog = console.error; console.error = () => {};
  const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111', W = '22222222-2222-4222-8222-222222222222';
  const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MAX = 'aaaaaaaa-0000-4000-8000-000000000002', CATE = 'aaaaaaaa-0000-4000-8000-000000000004';
  const P = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const perms = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
  // The unique index products_barcode_business_idx (business_id, barcode), as Postgres enforces it.
  const uniqueIndex = (table, op, filters, payload) => {
    if (table !== 'products' || !payload || !payload.barcode || (op !== 'update' && op !== 'insert')) return null;
    const clash = mem.db.products.find((r) => r.business_id === (filters.business_id ?? payload.business_id) && r.barcode === payload.barcode && r.id !== filters.id);
    return clash ? { code: '23505', message: 'duplicate key value violates unique constraint "products_barcode_business_idx"' } : null;
  };
  const reset = () => {
    mem.fail = uniqueIndex; mem.latency = () => 0; mem.calls = []; AC._resetAuthCache();
    const user = (id, name, role, branches) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, role_id: role ? `role-${id}` : null,
      roles: role, user_branches: branches.map((b) => ({ branch_id: b })), user_permissions: [] });
    mem.db = {
      businesses: [{ id: B, owner_id: OWNER, name: 'Duka', type: 'retail', currency: 'KES', status: 'active' }],
      branches: [{ id: W, business_id: B, name: 'Westlands', status: 'active', is_main: true }],
      users: [user(OWNER, 'Owner', { name: 'Admin', role_permissions: [] }, []), user(MAX, 'Max', perms('Manager', 'menu.edit', 'products.view'), [W]),
        user(CATE, 'Cate', perms('Cashier', 'orders.create', 'products.view'), [W])],
      products: [
        { id: P(1), business_id: B, name: 'Milk', status: 'active', barcode: '5901234123457' },
        { id: P(2), business_id: B, name: 'Bread', status: 'active', barcode: null },
        { id: P(3), business_id: B, name: 'Eggs', status: 'active', barcode: '' },
        { id: P(4), business_id: B, name: 'Sugar', status: 'active', barcode: '2000000000015' },
        { id: P(5), business_id: B, name: 'Old soap', status: 'inactive', barcode: null },
        { id: P(6), business_id: B, name: 'Rice', status: 'active', barcode: null },
        { id: P(9), business_id: B2, name: 'Theirs', status: 'active', barcode: null }],
      business_settings: [], audit_log: [], feature_flags: [], branch_settings: [], sync_versions: [], sync_changes: [], user_devices: [],
    };
  };
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json());
  app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, isOwner: false, surface: 'dashboard', ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const T = { owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'] }),
    max: sign({ userId: MAX, branchId: W, permissionKeys: ['menu.edit', 'products.view'] }),
    cate: sign({ userId: CATE, branchId: W, permissionKeys: ['orders.create', 'products.view'] }) };
  const call = async (method, p, token, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const code = (id) => mem.db.products.find((p) => p.id === id).barcode;
  const GEN = '/api/products/barcodes/generate';
  state._setPermissionsMigrated(true);

  try {
    reset();
    await ok('a cashier (no menu.edit) is refused — nothing changes', async () => {
      const r = await call('POST', GEN, T.cate, {});
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(code(P(2)), null);
    });
    await ok('dry run: how many would get one (active, without a barcode), the first codes, nothing written', async () => {
      const r = await call('POST', GEN, T.max, { dry_run: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.count, r.body.already], [3, 2]);
      assert.deepEqual(r.body.sample, ['2000000000022', '2000000000039', '2000000000046']);
      assert.equal(code(P(2)), null);
    });
    await ok('generate: prefix 20, valid, unique; a barcode never overwritten; inactive and another business untouched', async () => {
      const r = await call('POST', GEN, T.max, {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.count, 3);
      const got = [code(P(2)), code(P(3)), code(P(6))];
      for (const c of got) { assert.ok(BC.isInStoreCode(c), c); assert.ok(c.startsWith('20')); }
      assert.equal(new Set([...got, '2000000000015']).size, 4, 'unique, and not the one already used');
      assert.equal(code(P(1)), '5901234123457'); assert.equal(code(P(4)), '2000000000015');
      assert.equal(code(P(5)), null); assert.equal(mem.db.products.find((p) => p.id === P(9)).barcode, null);
      const again = await call('POST', GEN, T.max, {});
      assert.equal(again.body.count, 0, 'a second run has nothing to do');
    });
    await ok('ticked products only (an inactive one ticked is given one; another business\'s id is ignored)', async () => {
      reset();
      const r = await call('POST', GEN, T.owner, { product_ids: [P(5), P(1), P(9)] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.assigned.map((a) => a.id), [P(5)]);
      assert.equal(code(P(2)), null); assert.equal(code(P(1)), '5901234123457');
      assert.equal(mem.db.products.find((p) => p.id === P(9)).barcode, null);
    });
    await ok('never over a barcode typed between the read and the write — it is kept', async () => {
      reset();
      let once = false;
      mem.fail = (table, op, filters, payload) => {
        if (table === 'products' && op === 'update' && filters.id === P(2) && !once) {
          once = true; mem.db.products.find((p) => p.id === P(2)).barcode = 'TYPED-1';   // a manager typed it meanwhile
        }
        return uniqueIndex(table, op, filters, payload);
      };
      const r = await call('POST', GEN, T.max, { product_ids: [P(2)] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(code(P(2)), 'TYPED-1'); assert.deepEqual(r.body.kept, [P(2)]); assert.equal(r.body.count, 0);
    });
    await ok('two at once never duplicate: the unique index refuses the clash, the loser takes the next free number', async () => {
      reset();
      for (let n = 10; n < 30; n++) mem.db.products.push({ id: P(n), business_id: B, name: `Item ${n}`, status: 'active', barcode: null });
      let reads = 0, clashes = 0;
      mem.fail = (table, op, filters, payload) => { const e = uniqueIndex(table, op, filters, payload); if (e) clashes++; return e; };
      // A barrier: neither request's first read of the products answers until both have asked — both plan the same codes.
      let release; const both = new Promise((r) => { release = r; });
      mem.latency = (table, op) => {
        if (table !== 'products' || op !== 'select' || reads >= 2) return 0;
        if (++reads === 2) release();
        return both;
      };
      // Two people, two different sets of products, at the same moment: both plan the same next numbers.
      const ids = mem.db.products.filter((p) => p.business_id === B && p.status === 'active' && !p.barcode).map((p) => p.id);
      const half = Math.ceil(ids.length / 2);
      const [a, b] = await Promise.all([call('POST', GEN, T.max, { product_ids: ids.slice(0, half) }), call('POST', GEN, T.owner, { product_ids: ids.slice(half) })]);
      assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(b.status, 200, JSON.stringify(b.body));
      const codes = mem.db.products.filter((p) => p.business_id === B && p.barcode).map((p) => p.barcode);
      assert.equal(codes.length, new Set(codes).size, 'no duplicate');
      assert.equal(mem.db.products.filter((p) => p.business_id === B && p.status === 'active' && !p.barcode).length, 0, 'everyone got one');
      assert.equal(a.body.count + b.body.count, 23);
      assert.ok(clashes > 0, 'the two did clash (and recovered)');
    });
    await ok('label settings: defaults, saved cleaned (menu.edit), a cashier reads but cannot save', async () => {
      reset();
      const d = await call('GET', '/api/products/labels/settings', T.cate);
      assert.equal(d.status, 200); assert.deepEqual(d.body, LB.DEFAULT_LABEL_SETTINGS);
      assert.equal((await call('PUT', '/api/products/labels/settings', T.cate, { widthMm: 38 })).status, 403);
      const put = await call('PUT', '/api/products/labels/settings', T.max, { widthMm: 38, heightMm: 25, dpi: 300, junk: true, showBusiness: true });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.deepEqual([put.body.widthMm, put.body.heightMm, put.body.dpi, 'junk' in put.body], [38, 25, 300, false]);
      const row = mem.db.business_settings.find((r) => r.key === LB.LABEL_SETTINGS_KEY && r.business_id === B);
      assert.ok(row && row.value.widthMm === 38);
      assert.equal((await call('GET', '/api/products/labels/settings', T.cate)).body.heightMm, 25);
    });
    // ── A574: barcode numbering in the cloud ──
    const NUMS = '/api/products/barcodes/settings';
    await ok('A574 numbering settings: the default; saved cleaned (menu.edit); a cashier reads but cannot save', async () => {
      reset();
      const d = await call('GET', NUMS, T.cate);
      assert.equal(d.status, 200); assert.deepEqual(d.body, BC.DEFAULT_BARCODE_NUMBERING);
      assert.equal((await call('PUT', NUMS, T.cate, { prefix: '77' })).status, 403);
      const put = await call('PUT', NUMS, T.max, { format: 'CODE128N', prefix: '7x7', length: 8, start: 5, checkDigit: false, junk: 1 });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.deepEqual(put.body, { format: 'CODE128N', prefix: '77', start: 5, length: 8, checkDigit: false });
      assert.deepEqual(mem.db.business_settings.find((r) => r.key === BC.BARCODE_SETTINGS_KEY && r.business_id === B).value, put.body);
      assert.deepEqual((await call('GET', NUMS, T.cate)).body, put.body);
    });
    await ok('A574 generate follows the numbering: format, prefix, the start, after the highest used; codes there kept', async () => {
      reset();
      await call('PUT', NUMS, T.max, { format: 'CODE128N', prefix: '77', length: 8, start: 5 });
      const dry = await call('POST', GEN, T.max, { dry_run: true });
      assert.deepEqual([dry.body.sample, dry.body.remaining], [['77000005', '77000006', '77000007'], 999995]);
      const r = await call('POST', GEN, T.max, {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([code(P(2)), code(P(3)), code(P(6))].sort(), ['77000005', '77000006', '77000007']);
      assert.equal(code(P(1)), '5901234123457'); assert.equal(code(P(4)), '2000000000015', 'existing codes never change');
      mem.db.products.push({ id: P(40), business_id: B, name: 'Typed', status: 'active', barcode: '77000050' }, { id: P(41), business_id: B, name: 'New', status: 'active', barcode: null });
      await call('POST', GEN, T.max, { product_ids: [P(41)] });
      assert.equal(code(P(41)), '77000051', 'after the highest used');
      await call('PUT', NUMS, T.owner, { format: 'EAN8', prefix: '20' });
      mem.db.products.push({ id: P(42), business_id: B, name: 'Gum', status: 'active', barcode: null });
      await call('POST', GEN, T.max, { product_ids: [P(42)] });
      assert.ok(BC.isValidGtin(code(P(42))) && code(P(42)).length === 8 && code(P(42)).startsWith('20'), code(P(42)));
    });
    await ok('A574 a range used up: refused with a plain message before anything is written (dry run says so too)', async () => {
      reset();
      await call('PUT', NUMS, T.max, { format: 'CODE128N', prefix: '99', length: 4, start: 98 });
      const dry = await call('POST', GEN, T.max, { dry_run: true });
      assert.equal(dry.body.code, 'barcode_range_full'); assert.ok(/Only 2 new codes are left/.test(dry.body.error), dry.body.error);
      const r = await call('POST', GEN, T.max, {});
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, 'barcode_range_full');
      assert.ok(/Barcode numbering/.test(r.body.error));
      assert.deepEqual([code(P(2)), code(P(3)), code(P(6))], [null, '', null], 'nothing written');
      const two = await call('POST', GEN, T.max, { product_ids: [P(2), P(6)] });
      assert.equal(two.status, 200, 'two codes left, two asked: fine');
      assert.deepEqual([code(P(2)), code(P(6))].sort(), ['9998', '9999']);
      const none = await call('POST', GEN, T.max, { product_ids: [P(3)] });
      assert.equal(none.status, 409); assert.ok(/used up/.test(none.body.error));
    });
  } finally {
    console.warn = warn; console.error = errLog;
    server.close();
  }
} catch (e) {
  fail++; console.log(`FAIL  (setup) ${e.stack ?? e}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
