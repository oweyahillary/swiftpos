/**
 * receipt-pay-block.test — A551: the payment block on the standard (classic) receipt.
 *
 * Owner, 2026-10-21, on paper: "change in the payment details we just write `PAY BILL/BUY GOODS:` newline `123445` and we
 * center it and increase the font size and thickness, We remove the wordings payment details".
 *
 * A539 printed "Payment Details: Buy Goods - 777111" (bold, left), a rule, the payments. Now: the label alone ("BUY GOODS:"
 * / "PAYBILL:", from business.tillLabel), then the number, each centred (ESC a 1), double height (GS ! 0x01) and bold
 * (ESC E 1); a Paybill's account ("4098201, Account WEST1", A492) on a third line, centred, normal size: "Account: WEST1";
 * then the rule, the payments and CHANGE as before. No till number: no heading, and no rule of its own. The compact
 * opt-in keeps A530's block ("Buy Goods: 000000" under the payments).
 *
 * A557 (owner, 2026-10-21, on paper: "also reduce the font size of paybill a bit by 3 points"): A551 printed the label
 * and the number double size (GS ! 0x11) and fell back to double height when they did not fit half the line. ESC/POS
 * has no size in between, so the step down is double HEIGHT only (GS ! 0x01) — always, the glyphs one column wide — and
 * a long label or number wraps at the full line (48 / 32), every row tall, centred, bold. Section 3.
 *
 * MUTATION-CHECKED (rule 10/23), each red on its own: not centred (1, 2); not bold (1); the "Payment Details" heading back
 * (1, 4); the account not split off (2); a heading printed with no till number (4). A557: 'large' back for the block
 * (1, 2, 3).
 */
import { renderTicket, toEscPos, receiptPreset, type PrintContext, type BusinessConfig, type Document } from '../src/index';
import { order, business } from './fixture';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const ESC = 0x1b, GS = 0x1d;
const st = (w: 58 | 80) => receiptPreset('st-till', 'Till', w);
const bytesOf = (ctx: PrintContext) => toEscPos(renderTicket(ctx), { cut: ctx.station.cutPaper, openDrawer: ctx.station.openCashDrawer,
  feedBeforeCut: ctx.station.feedBeforeCut });
const has = (buf: Buffer, seq: number[] | string) => buf.indexOf(typeof seq === 'string' ? Buffer.from(seq, 'latin1') : Buffer.from(seq)) >= 0;
const bytes = (...parts: Array<number[] | string>) => parts.flatMap(p => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p));
const blocks = (doc: Document, from: string, n: number) => {
  const at = doc.blocks.findIndex(b => b.kind === 'text' && b.text === from);
  return at < 0 ? [] : doc.blocks.slice(at, at + n);
};
const text = (doc: Document) => doc.blocks.flatMap(b => (b.kind === 'text' ? [b.text.trim()] : []));
/** The tall, bold, centred rows of the payment block — the label's and the number's, in order. */
const payRows = (doc: Document) => doc.blocks.flatMap(b => (b.kind === 'text' && b.size === 'tall' && b.bold && b.align === 'center'
  && !/^PAY: /.test(b.text) ? [b.text] : []));

console.log('\n1. Buy Goods: "BUY GOODS:" then the number — centred, double height (A557), bold; no "Payment Details"');
for (const w of [80, 58] as const) {
  const biz: BusinessConfig = { ...business, tillLabel: 'Buy Goods', tillNumber: '777111' };
  const ctx: PrintContext = { order, business: biz, station: st(w) };
  const b = bytesOf(ctx);
  // From the rule under PAY: ESC a 1, GS ! 0x01, ESC E 1, ESC 2 (a double-height line at the default spacing), the label,
  // the number in the same mode, then back to left / normal / not bold / ESC 3 30 for the rule.
  const rule = '-'.repeat(w === 80 ? 48 : 32);
  ok(`${w}: the bytes — ESC a 1, GS ! 0x01, ESC E 1, "BUY GOODS:", "777111", then left / normal for the rule`,
    has(b, bytes(`${rule}\n`, [ESC, 0x61, 1, GS, 0x21, 0x01, ESC, 0x45, 1, ESC, 0x32], 'BUY GOODS:\n777111\n',
      [ESC, 0x61, 0, GS, 0x21, 0x00, ESC, 0x45, 0, ESC, 0x33, 30], `${rule}\nCASH`)));
  const doc = renderTicket(ctx);
  const blk = blocks(doc, 'BUY GOODS:', 2);
  ok(`${w}: both lines align 'center', size 'tall', bold`, blk.length === 2
    && blk.every(x => x.kind === 'text' && x.align === 'center' && x.size === 'tall' && x.bold), JSON.stringify(blk));
  ok(`${w}: A557: never double width — no GS ! 0x11 or 0x10 anywhere on the receipt, no 'large' / 'wide' block`,
    !has(b, [GS, 0x21, 0x11]) && !has(b, [GS, 0x21, 0x10]) && doc.blocks.every(x => x.kind !== 'text' || (x.size !== 'large' && x.size !== 'wide')));
  ok(`${w}: no "Payment Details" / "Buy Goods - " anywhere`, !text(doc).some(t => /payment detail|buy goods -/i.test(t)));
  ok(`${w}: the block sits under PAY's rule, its own rule under it, then the payments`, (() => {
    const t = text(doc);
    const at = t.indexOf('BUY GOODS:');
    return /^PAY: /.test(t[at - 2]) && /^-+$/.test(t[at - 1]) && t[at + 1] === '777111' && /^-+$/.test(t[at + 2]) && /^CASH\s/.test(t[at + 3]);
  })(), text(doc).join(' | '));
}

console.log('\n2. Paybill with an account: "PAYBILL:", the number, then "Account: WEST1" centred in the normal size');
for (const w of [80, 58] as const) {
  const biz: BusinessConfig = { ...business, tillLabel: 'Paybill', tillNumber: '4098201, Account WEST1' };
  const ctx: PrintContext = { order, business: biz, station: st(w) };
  const doc = renderTicket(ctx);
  const blk = blocks(doc, 'PAYBILL:', 3);
  ok(`${w}: PAYBILL: / 4098201 tall bold centred, "Account: WEST1" normal centred`, blk.length === 3
    && blk[0].kind === 'text' && blk[0].size === 'tall' && blk[0].bold && blk[0].align === 'center'
    && blk[1].kind === 'text' && blk[1].text === '4098201' && blk[1].size === 'tall' && blk[1].bold && blk[1].align === 'center'
    && blk[2].kind === 'text' && blk[2].text === 'Account: WEST1' && blk[2].size === 'normal' && !blk[2].bold && blk[2].align === 'center',
    JSON.stringify(blk));
  const b = bytesOf(ctx);
  ok(`${w}: the bytes — ESC a 1, GS ! 0x01, ESC E 1, "PAYBILL:", "4098201"`,
    has(b, bytes([ESC, 0x61, 1, GS, 0x21, 0x01, ESC, 0x45, 1, ESC, 0x32], 'PAYBILL:\n4098201\n')));
  ok(`${w}: the bytes — the number, then GS ! 0 / ESC E 0 / ESC 3 30 (still centred), "Account: WEST1"`,
    has(b, bytes('PAYBILL:\n4098201\n', [GS, 0x21, 0x00, ESC, 0x45, 0, ESC, 0x33, 30], 'Account: WEST1\n', [ESC, 0x61, 0])));
  ok(`${w}: no ", Account" left on the number`, !text(doc).some(t => t.includes(', Account')));
  const lower = renderTicket({ order, business: { ...biz, tillLabel: 'paybill', tillNumber: '4098201' }, station: st(w) });
  ok(`${w}: the label upper-cased with a colon; no account, no Account line`, text(lower).includes('PAYBILL:') && text(lower).includes('4098201')
    && !text(lower).some(t => t.startsWith('Account')));
  const none = renderTicket({ order, business: { ...biz, tillLabel: undefined, tillNumber: '777111' }, station: st(w) });
  ok(`${w}: no label set: "BUY GOODS:"`, text(none).includes('BUY GOODS:'));
}

console.log('\n3. A557: always double height only (GS ! 0x01), whatever the length; a long value wraps at the full line');
{
  // A551's "fits half the line → double size" is gone: short, 16-, 17-digit numbers and a long label all print tall.
  for (const w of [80, 58] as const) {
    for (const n of ['000000', '777111', '1234567890123456', '12345678901234567']) {
      const biz: BusinessConfig = { ...business, tillLabel: 'Buy Goods', tillNumber: n };
      const doc = renderTicket({ order, business: biz, station: st(w) });
      ok(`${w}: a ${n.length}-digit number — "BUY GOODS:" / "${n}", both tall, centred, bold; GS ! 0x01 in the bytes`,
        JSON.stringify(payRows(doc)) === JSON.stringify(['BUY GOODS:', n])
        && has(bytesOf({ order, business: biz, station: st(w) }), bytes([ESC, 0x61, 1, GS, 0x21, 0x01, ESC, 0x45, 1, ESC, 0x32], `BUY GOODS:\n${n}\n`)),
        JSON.stringify(payRows(doc)));
    }
  }
  // A number longer than the line (40 digits): one row on 80 mm (48), wrapped at the full 32 on 58 mm — not at 16.
  const forty = '1234567890123456789012345678901234567890';
  const longNo: BusinessConfig = { ...business, tillLabel: 'Buy Goods', tillNumber: forty };
  ok('80: a 40-digit number on one tall row (48 columns)',
    JSON.stringify(payRows(renderTicket({ order, business: longNo, station: st(80) }))) === JSON.stringify(['BUY GOODS:', forty]));
  ok('58: a 40-digit number wraps at 32 — "…9012" / "34567890", both tall',
    JSON.stringify(payRows(renderTicket({ order, business: longNo, station: st(58) })))
      === JSON.stringify(['BUY GOODS:', '12345678901234567890123456789012', '34567890']));
  // A long label wraps at the full line too, at its words.
  const longLabel: BusinessConfig = { ...business, tillLabel: 'Lipa na M-Pesa Till Number For Our Nairobi Branch', tillNumber: '777111' };
  ok('80: a 49-character label wraps at 48 — two tall rows, then the number',
    JSON.stringify(payRows(renderTicket({ order, business: longLabel, station: st(80) })))
      === JSON.stringify(['LIPA NA M-PESA TILL NUMBER FOR OUR NAIROBI', 'BRANCH:', '777111']));
  ok('58: the same label wraps at 32',
    JSON.stringify(payRows(renderTicket({ order, business: longLabel, station: st(58) })))
      === JSON.stringify(['LIPA NA M-PESA TILL NUMBER FOR', 'OUR NAIROBI BRANCH:', '777111']));
  ok('58: a 20-character label — both tall', blocks(renderTicket({ order, business: { ...business, tillLabel: 'Lipa na M-Pesa Till', tillNumber: '777111' },
    station: st(58) }), 'LIPA NA M-PESA TILL:', 2).every(x => x.kind === 'text' && x.size === 'tall'));
  ok('every row of the block within the line (48 / 32)', [80, 58].every(w => [longNo, longLabel].every(biz =>
    payRows(renderTicket({ order, business: biz, station: st(w as 58 | 80) })).every(t => t.length <= (w === 80 ? 48 : 32)))));
  ok('the sample\'s 6-digit Buy Goods: tall at both widths', [58, 80].every(w =>
    blocks(renderTicket({ order, business, station: st(w as 58 | 80) }), 'BUY GOODS:', 2).every(x => x.kind === 'text' && x.size === 'tall')));
}

console.log('\n4. No till number: no heading and no extra rule; the compact opt-in keeps its own block');
for (const w of [80, 58] as const) {
  const t = text(renderTicket({ order, business: { ...business, tillNumber: undefined }, station: st(w) }));
  const pay = t.findIndex(x => x.startsWith('PAY: '));
  ok(`${w}: PAY, its rule, then CASH straight away`, /^-+$/.test(t[pay + 1]) && /^CASH\s/.test(t[pay + 2]), t.slice(pay, pay + 4).join(' | '));
  ok(`${w}: no label, no "Payment Details"`, !t.some(x => /BUY GOODS:|payment detail/i.test(x)));
  const blank = text(renderTicket({ order, business: { ...business, tillNumber: '   ' }, station: st(w) }));
  ok(`${w}: a blank till number is none`, !blank.includes('BUY GOODS:') && JSON.stringify(blank) === JSON.stringify(t));
  const compact = renderTicket({ order, business: { ...business, receiptClassic: { compactLayout: true } }, station: st(w) });
  ok(`${w}: compact — "Buy Goods: 000000" under the payments, normal size, no large block`, text(compact).includes('Buy Goods: 000000')
    && !text(compact).includes('BUY GOODS:') && compact.blocks.every(b => b.kind !== 'text' || b.size !== 'large'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
