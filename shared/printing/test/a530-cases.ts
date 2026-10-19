/**
 * a530-cases — the receipts the A530 golden pins (test/golden/a530-classic.json).
 *
 * The golden was written by the renderer as it was BEFORE A530 (1.0.19), so with all four classic switches on the
 * receipt must still be those bytes exactly — that is the promise the admin portal's switches make to a client who
 * wants the old receipt back. Every shape of receipt the layout change touches is here: plain, tip, delivery fee, free
 * delivery, a discount with an offer, dine-in, a proforma bill, a duplicate, a void, a logo up to the old 288-dot cap,
 * a non-zero round-off, a zero-rated business, both paper widths.
 */
import {
  receiptPreset, monoRasterFromRGBA,
  type PrintContext, type BusinessConfig, type Order, type MonoRaster,
} from '../src/index';
import { order, business } from './fixture';

/** A 300 x 288 logo (the old height cap): a ring, a bar and a stripe block — black and white, nothing all one colour. */
export function bigLogo(): MonoRaster {
  const w = 300, h = 288;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - 150, dy = y - 110, r = Math.sqrt(dx * dx + dy * dy);
    const black = (r > 70 && r < 100)               // a ring 30 px thick
      || (y >= 230 && y < 250 && x >= 30 && x < 270)   // a bar under it
      || (y >= 260 && y < 280 && x >= 30 && x < 270 && (x >> 3) % 2 === 0);   // 8-px stripes (text-like)
    const p = (y * w + x) * 4;
    px[p] = px[p + 1] = px[p + 2] = black ? 0 : 255; px[p + 3] = 255;
  }
  // maxHeight passed explicitly: the default upload cap is 120 since A530, this is a logo stored before it.
  return monoRasterFromRGBA(px, w, h, { maxHeight: 288 });
}

const roundOrder: Order = {
  // The incumbent's photographed 435.00 receipt (sample.ts): at 16% + 2% CTL the net split loses a cent — Round Off 0.01.
  ...order,
  lines: [{ name: 'Chicken Wrap', quantity: 1, unitPrice: 43500, lineTotal: 43500, stationIds: [], units: [] }],
  total: 43500, payments: [{ label: 'M-Pesa', amount: 43500 }], changeGiven: 0,
};

export interface Case { name: string; ctx: PrintContext }

export function cases(classic?: BusinessConfig['receiptClassic']): Case[] {
  const out: Case[] = [];
  const biz = (b: Partial<BusinessConfig> = {}): BusinessConfig => ({ ...business, ...b, ...(classic ? { receiptClassic: classic } : {}) });
  for (const w of [80, 58] as const) {
    const st = receiptPreset('st-till', 'Till', w);
    const add = (name: string, ctx: Omit<PrintContext, 'station'>) => out.push({ name: `${name}-${w}`, ctx: { ...ctx, station: st } });
    add('plain', { order, business: biz() });
    add('tip', { order: { ...order, tip: 20000 }, business: biz() });
    add('delivery-fee', { order: { ...order, orderType: 'delivery', deliveryPerson: 'Otieno', deliveryFee: 15000 }, business: biz() });
    add('delivery-free', { order: { ...order, orderType: 'delivery', deliveryPerson: 'Otieno', deliveryFee: 15000, deliveryFree: true }, business: biz() });
    add('offer', { order: { ...order, total: 300000, discount: 30000, offers: [{ name: 'Happy Hour', amount: 20000 }],
      payments: [{ label: 'Cash', amount: 300000 }], changeGiven: 0 }, business: biz() });
    add('dine-in-note', { order: { ...order, orderType: 'dine_in', tableNumber: '12', note: 'Birthday table' }, business: biz() });
    add('proforma', { order, business: biz(), proforma: true });
    add('duplicate', { order, business: biz(), reprint: { at: new Date(2026, 7, 5, 21, 6, 9), count: 2 } });
    add('void', { order, business: biz(), voided: { at: new Date(2026, 7, 5, 20, 1, 0), by: 'Manager Jane' } });
    add('logo', { order, business: biz({ logoRaster: bigLogo() }) });
    add('round-off', { order: roundOrder, business: biz() });
    add('zero-rated', { order, business: biz({ vatRate: 0, ctlRate: 0, header: 'Moi Avenue\nNairobi' }) });
    add('long-cashier', { order: { ...order, cashierName: 'Wanjiku Kamau-Njoroge' }, business: biz() });
  }
  return out;
}

/** The till's and the web's call: the station's cut, feed and drawer straight through. */
export const optsFor = (ctx: PrintContext) => ({
  cut: ctx.station.cutPaper, openDrawer: ctx.station.openCashDrawer, feedBeforeCut: ctx.station.feedBeforeCut,
});
