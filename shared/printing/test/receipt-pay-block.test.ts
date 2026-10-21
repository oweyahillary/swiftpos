/**
 * receipt-pay-block.test — A551: the payment block on the standard (classic) receipt.
 *
 * Owner, 2026-10-21, on paper: "change in the payment details we just write `PAY BILL/BUY GOODS:` newline `123445` and we
 * center it and increase the font size and thickness, We remove the wordings payment details".
 *
 * A539 printed "Payment Details: Buy Goods - 777111" (bold, left), a rule, the payments. Now: the label alone ("BUY GOODS:"
 * / "PAYBILL:", from business.tillLabel), then the number, each centred (ESC a 1), double size (GS ! 0x11) and bold (ESC E 1);
 * a Paybill's account ("4098201, Account WEST1", A492) on a third line, centred, normal size: "Account: WEST1"; then the
 * rule, the payments and CHANGE as before. Double width halves the line (24 on 80 mm, 16 on 58 mm): a label or a number
 * that does not fit prints both double height only (GS ! 0x01). No till number: no heading, and no rule of its own. The
 * compact opt-in keeps A530's block ("Buy Goods: 000000" under the payments).
 *
 * MUTATION-CHECKED (rule 10/23), each red on its own: not centred (1, 2); 'tall' instead of 'large' (1); not bold (1); the
 * "Payment Details" heading back (1, 4); no fallback to double height on 58 mm (3); the account not split off (2); a
 * heading printed with no till number (4).
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

console.log('\n1. Buy Goods: "BUY GOODS:" then the number — centred, double size, bold; no "Payment Details"');
for (const w of [80, 58] as const) {
  const biz: BusinessConfig = { ...business, tillLabel: 'Buy Goods', tillNumber: '777111' };
  const ctx: PrintContext = { order, business: biz, station: st(w) };
  const b = bytesOf(ctx);
  // From the rule under PAY: ESC a 1, GS ! 0x11, ESC E 1, ESC 2 (a double-height line at the default spacing), the label,
  // the number in the same mode, then back to left / normal / not bold / ESC 3 30 for the rule.
  const rule = '-'.repeat(w === 80 ? 48 : 32);
  ok(`${w}: the bytes — ESC a 1, GS ! 0x11, ESC E 1, "BUY GOODS:", "777111", then left / normal for the rule`,
    has(b, bytes(`${rule}\n`, [ESC, 0x61, 1, GS, 0x21, 0x11, ESC, 0x45, 1, ESC, 0x32], 'BUY GOODS:\n777111\n',
      [ESC, 0x61, 0, GS, 0x21, 0x00, ESC, 0x45, 0, ESC, 0x33, 30], `${rule}\nCASH`)));
  const doc = renderTicket(ctx);
  const blk = blocks(doc, 'BUY GOODS:', 2);
  ok(`${w}: both lines align 'center', size 'large', bold`, blk.length === 2
    && blk.every(x => x.kind === 'text' && x.align === 'center' && x.size === 'large' && x.bold), JSON.stringify(blk));
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
  ok(`${w}: PAYBILL: / 4098201 large bold centred, "Account: WEST1" normal centred`, blk.length === 3
    && blk[0].kind === 'text' && blk[0].size === 'large' && blk[0].bold && blk[0].align === 'center'
    && blk[1].kind === 'text' && blk[1].text === '4098201' && blk[1].size === 'large' && blk[1].bold && blk[1].align === 'center'
    && blk[2].kind === 'text' && blk[2].text === 'Account: WEST1' && blk[2].size === 'normal' && !blk[2].bold && blk[2].align === 'center',
    JSON.stringify(blk));
  const b = bytesOf(ctx);
  ok(`${w}: the bytes — the number, then GS ! 0 / ESC E 0 / ESC 3 30 (still centred), "Account: WEST1"`,
    has(b, bytes('PAYBILL:\n4098201\n', [GS, 0x21, 0x00, ESC, 0x45, 0, ESC, 0x33, 30], 'Account: WEST1\n', [ESC, 0x61, 0])));
  ok(`${w}: no ", Account" left on the number`, !text(doc).some(t => t.includes(', Account')));
  const lower = renderTicket({ order, business: { ...biz, tillLabel: 'paybill', tillNumber: '4098201' }, station: st(w) });
  ok(`${w}: the label upper-cased with a colon; no account, no Account line`, text(lower).includes('PAYBILL:') && text(lower).includes('4098201')
    && !text(lower).some(t => t.startsWith('Account')));
  const none = renderTicket({ order, business: { ...biz, tillLabel: undefined, tillNumber: '777111' }, station: st(w) });
  ok(`${w}: no label set: "BUY GOODS:"`, text(none).includes('BUY GOODS:'));
}

console.log('\n3. Double width halves the line: what does not fit prints double height only (GS ! 0x01)');
{
  // 58 mm: 16 a line at double width. A 17-character number does not fit — both lines go double height, full width.
  const long: BusinessConfig = { ...business, tillLabel: 'Buy Goods', tillNumber: '12345678901234567' };
  const d58 = renderTicket({ order, business: long, station: st(58) });
  const blk = blocks(d58, 'BUY GOODS:', 2);
  ok('58: a 17-digit number — label and number both tall, centred, bold', blk.length === 2
    && blk.every(x => x.kind === 'text' && x.size === 'tall' && x.bold && x.align === 'center')
    && has(bytesOf({ order, business: long, station: st(58) }), bytes([ESC, 0x61, 1, GS, 0x21, 0x01, ESC, 0x45, 1, ESC, 0x32], 'BUY GOODS:\n12345678901234567\n')),
    JSON.stringify(blk));
  const d80 = renderTicket({ order, business: long, station: st(80) });
  ok('80: the same number fits 24 — double size', blocks(d80, 'BUY GOODS:', 2).every(x => x.kind === 'text' && x.size === 'large'));
  // A 16-character number fits 58 mm exactly.
  const fits = renderTicket({ order, business: { ...long, tillNumber: '1234567890123456' }, station: st(58) });
  ok('58: a 16-digit number still fits — double size', blocks(fits, 'BUY GOODS:', 2).every(x => x.kind === 'text' && x.size === 'large'));
  // A long label does the same.
  const label = renderTicket({ order, business: { ...business, tillLabel: 'Lipa na M-Pesa Till', tillNumber: '777111' }, station: st(58) });
  ok('58: a 20-character label — both tall', blocks(label, 'LIPA NA M-PESA TILL:', 2).every(x => x.kind === 'text' && x.size === 'tall'));
  ok('the sample\'s 6-digit Buy Goods fits both widths at double size', [58, 80].every(w =>
    blocks(renderTicket({ order, business, station: st(w as 58 | 80) }), 'BUY GOODS:', 2).every(x => x.kind === 'text' && x.size === 'large')));
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
