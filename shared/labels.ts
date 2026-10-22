/**
 * labels.ts — A571: barcode labels of ANY size, for ANY printer.
 *
 * Owner, 2026-10-22, asked which label printer and which size: "for now i cant tell what my clients will use as their
 * printer or the label size can we do all?"
 *
 * One layout, four ways out (the caller picks at print time):
 *   (a) any printer with a Windows or browser driver — an HTML page per label, `@page { size: Wmm Hmm; margin: 0 }`,
 *       the barcode an SVG (crisp at any DPI): labelsHtml(…, 'roll');
 *   (b) A4 / Letter sticker sheets (3×7, 3×8, 4×10, 5×13, or custom rows × columns), "start at label N" so a part-used
 *       sheet is used up: sheetGrid + placeOnSheets + labelsHtml(…, 'sheet');
 *   (c) raw label languages for a printer with no driver, sent to IP:9100 or USB raw by the till: TSPL (TSC, most
 *       Xprinter label models) tsplLabel, ZPL (Zebra) zplLabel — 203 dpi by default, 300 dpi as an option;
 *   (d) the receipt printer (ESC/POS): GS k (EAN-13 / UPC-A / CODE128) or the bars as a raster image — escposLabel.
 *
 * Pure (no DOM, no Node): every renderer returns a string or a byte array. The bars come from barcode.ts
 * (EncodedBarcode), passed in — this file imports nothing, so each copy compiles on its own.
 * Copies (scripts/check-shared-sync.mjs): apps/server/src/lib (cleanLabelSettings), apps/dashboard/src/lib,
 * apps/desktop/src/shared, apps/desktop/src/main.
 *
 * Layout is worked out in printer DOTS at the chosen dpi (8 dots/mm at 203 dpi, 12 at 300), so the bars land on whole
 * dots on a label printer, and the SVG / HTML page is the same picture scaled to millimetres.
 */

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SheetPresetId = '3x7' | '3x8' | '4x10' | '5x13' | 'custom';
export type PaperId = 'A4' | 'Letter';

export interface SheetSettings {
  preset: SheetPresetId;
  paper: PaperId;
  cols: number;
  rows: number;
  /** A preset's label size; a custom sheet's is worked out from the page, margins and gaps (sheetGrid). */
  labelWidthMm: number;
  labelHeightMm: number;
  marginTopMm: number;
  marginLeftMm: number;
  gapXMm: number;
  gapYMm: number;
}

export interface LabelSettings {
  /** The label on a roll (paths a, c, d). */
  widthMm: number;
  heightMm: number;
  /** The gap between labels on the roll (TSPL's GAP). */
  gapMm: number;
  showName: boolean;
  showPrice: boolean;
  showBarcode: boolean;
  /** The human-readable digits under the bars. */
  showDigits: boolean;
  showBusiness: boolean;
  /** Printed after the price, e.g. "per kg" (empty: nothing). */
  unitText: string;
  /** The label printer's resolution (raw languages, and the dot grid the bars are snapped to). */
  dpi: 203 | 300;
  sheet: SheetSettings;
}

/** The common roll sizes (mm), offered as presets; any other size is "custom". */
export const LABEL_SIZE_PRESETS: ReadonlyArray<{ widthMm: number; heightMm: number }> = [
  { widthMm: 30, heightMm: 20 }, { widthMm: 38, heightMm: 25 }, { widthMm: 40, heightMm: 30 }, { widthMm: 50, heightMm: 25 },
  { widthMm: 50, heightMm: 30 }, { widthMm: 58, heightMm: 40 }, { widthMm: 60, heightMm: 40 },
];

export const PAPER_MM: Readonly<Record<PaperId, { w: number; h: number }>> = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } };

/** A4 sticker sheets as sold (Avery-style L7160, L7159, L7654, L7651 layouts). */
export const SHEET_PRESETS: Readonly<Record<Exclude<SheetPresetId, 'custom'>, SheetSettings>> = {
  '3x7':  { preset: '3x7',  paper: 'A4', cols: 3, rows: 7,  labelWidthMm: 63.5, labelHeightMm: 38.1, marginTopMm: 15.1, marginLeftMm: 7.2, gapXMm: 2.5, gapYMm: 0 },
  '3x8':  { preset: '3x8',  paper: 'A4', cols: 3, rows: 8,  labelWidthMm: 63.5, labelHeightMm: 33.9, marginTopMm: 12.9, marginLeftMm: 7.2, gapXMm: 2.5, gapYMm: 0 },
  '4x10': { preset: '4x10', paper: 'A4', cols: 4, rows: 10, labelWidthMm: 45.7, labelHeightMm: 25.4, marginTopMm: 21.5, marginLeftMm: 9.7, gapXMm: 2.6, gapYMm: 0 },
  '5x13': { preset: '5x13', paper: 'A4', cols: 5, rows: 13, labelWidthMm: 38.1, labelHeightMm: 21.2, marginTopMm: 10.7, marginLeftMm: 4.7, gapXMm: 2.5, gapYMm: 0 },
};

export const DEFAULT_LABEL_SETTINGS: LabelSettings = {
  widthMm: 50, heightMm: 30, gapMm: 2,
  showName: true, showPrice: true, showBarcode: true, showDigits: true, showBusiness: false,
  unitText: '', dpi: 203,
  sheet: { ...SHEET_PRESETS['3x8'] },
};

/** The business setting the label designer is kept under (business_settings). */
export const LABEL_SETTINGS_KEY = 'label_settings';

const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.round(Math.min(hi, Math.max(lo, n)) * 10) / 10;
};
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

/** Whatever was stored or sent, as settings every renderer can use (sizes clamped, unknown keys dropped). */
export function cleanLabelSettings(raw: unknown): LabelSettings {
  let r: any = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
  if (!r || typeof r !== 'object') r = {};
  const d = DEFAULT_LABEL_SETTINGS;
  const s: any = r.sheet && typeof r.sheet === 'object' ? r.sheet : {};
  const preset: SheetPresetId = ['3x7', '3x8', '4x10', '5x13', 'custom'].includes(s.preset) ? s.preset : d.sheet.preset;
  const base: SheetSettings = preset === 'custom' ? { ...d.sheet, preset: 'custom' } : { ...SHEET_PRESETS[preset] };
  const sheet: SheetSettings = preset === 'custom' ? {
    preset: 'custom',
    paper: s.paper === 'Letter' ? 'Letter' : 'A4',
    cols: Math.round(num(s.cols, 1, 10, base.cols)),
    rows: Math.round(num(s.rows, 1, 30, base.rows)),
    labelWidthMm: base.labelWidthMm, labelHeightMm: base.labelHeightMm,
    marginTopMm: num(s.marginTopMm, 0, 60, base.marginTopMm),
    marginLeftMm: num(s.marginLeftMm, 0, 60, base.marginLeftMm),
    gapXMm: num(s.gapXMm, 0, 30, base.gapXMm),
    gapYMm: num(s.gapYMm, 0, 30, base.gapYMm),
  } : base;
  return {
    widthMm: num(r.widthMm, 15, 150, d.widthMm),
    heightMm: num(r.heightMm, 10, 200, d.heightMm),
    gapMm: num(r.gapMm, 0, 20, d.gapMm),
    showName: bool(r.showName, d.showName),
    showPrice: bool(r.showPrice, d.showPrice),
    showBarcode: bool(r.showBarcode, d.showBarcode),
    showDigits: bool(r.showDigits, d.showDigits),
    showBusiness: bool(r.showBusiness, d.showBusiness),
    unitText: typeof r.unitText === 'string' ? r.unitText.replace(/[\x00-\x1f]/g, '').trim().slice(0, 20) : d.unitText,
    dpi: Number(r.dpi) === 300 ? 300 : 203,
    sheet: { ...sheet, ...(preset === 'custom' ? customCell(sheet) : {}) },
  };
}

/** A custom sheet's label size: the page less the margins (the same each side) and gaps, shared by the columns / rows. */
function customCell(s: SheetSettings): { labelWidthMm: number; labelHeightMm: number } {
  const page = PAPER_MM[s.paper];
  const w = (page.w - 2 * s.marginLeftMm - (s.cols - 1) * s.gapXMm) / s.cols;
  const h = (page.h - 2 * s.marginTopMm - (s.rows - 1) * s.gapYMm) / s.rows;
  return { labelWidthMm: Math.max(1, Math.floor(w * 10) / 10), labelHeightMm: Math.max(1, Math.floor(h * 10) / 10) };
}

// ── Sheets (path b) ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface SheetCell { x: number; y: number; w: number; h: number }
export interface SheetGrid { pageWidthMm: number; pageHeightMm: number; cols: number; rows: number; cells: SheetCell[]; fits: boolean }

/** Every label's place on the page (mm from the top-left corner), row by row, left to right. */
export function sheetGrid(sheet: SheetSettings): SheetGrid {
  const s = sheet.preset === 'custom' ? { ...sheet, ...customCell(sheet) } : sheet;
  const page = PAPER_MM[s.paper];
  const cells: SheetCell[] = [];
  for (let r = 0; r < s.rows; r++) {
    for (let c = 0; c < s.cols; c++) {
      cells.push({
        x: round2(s.marginLeftMm + c * (s.labelWidthMm + s.gapXMm)),
        y: round2(s.marginTopMm + r * (s.labelHeightMm + s.gapYMm)),
        w: s.labelWidthMm, h: s.labelHeightMm,
      });
    }
  }
  const last = cells[cells.length - 1];
  const fits = !!last && last.x + last.w <= page.w + 0.01 && last.y + last.h <= page.h + 0.01;
  return { pageWidthMm: page.w, pageHeightMm: page.h, cols: s.cols, rows: s.rows, cells, fits };
}

/** Where `count` labels go when the first free label on the first sheet is number `startAt` (1 = top-left). */
export function placeOnSheets(count: number, perSheet: number, startAt = 1): Array<{ page: number; cell: number }> {
  const per = Math.max(1, Math.floor(perSheet));
  const first = Math.min(per, Math.max(1, Math.floor(Number(startAt) || 1))) - 1;
  const out: Array<{ page: number; cell: number }> = [];
  for (let k = 0; k < Math.max(0, Math.floor(count)); k++) {
    const i = first + k;
    out.push({ page: Math.floor(i / per), cell: i % per });
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── Layout ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The bars to draw (barcode.ts's EncodedBarcode — only what layout and the renderers read). */
export interface LabelBars {
  symbology: 'EAN13' | 'UPCA' | 'CODE128';
  data: string;
  text: string;
  modules: string;
  quietLeft: number;
  quietRight: number;
  segments?: Array<{ set: 'B' | 'C'; text: string }>;
}

export interface LabelItem {
  name: string;
  /** The item's CURRENT price (labels are reprinted when it changes); null prints no price. */
  price: number | null;
  currency?: string;
  business?: string;
}

export type LabelTextKind = 'business' | 'name' | 'price' | 'digits';
/** A line of text: the box it is centred in (dots from the top-left), its height in dots. */
export interface LabelText { kind: LabelTextKind; text: string; x: number; y: number; w: number; h: number; bold: boolean }
export interface LabelBarsBox { x: number; y: number; h: number; moduleDots: number; widthDots: number }

export interface LabelLayout {
  widthMm: number;
  heightMm: number;
  dpi: 203 | 300;
  dotsPerMm: number;
  widthDots: number;
  heightDots: number;
  texts: LabelText[];
  bars: LabelBars | null;
  barsBox: LabelBarsBox | null;
  warnings: string[];
}

/** Dots per mm: 8 at 203 dpi, 12 at 300 dpi (what TSC, Xprinter and Zebra print with). */
export const dotsPerMm = (dpi: 203 | 300): number => (dpi === 300 ? 12 : 8);

/** "KES 1,250" / "KES 99.50". */
export function formatLabelPrice(price: number, currency = 'KES'): string {
  const whole = Math.round(price * 100) % 100 === 0;
  const n = (whole ? Math.round(price) : Math.round(price * 100) / 100).toFixed(whole ? 0 : 2);
  const [i, f] = n.split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency ? currency + ' ' : ''}${grouped}${f ? '.' + f : ''}`.trim();
}

/** Word-wrap to at most `maxLines` lines of `maxChars`; the last line cut with "…" when the text does not fit. */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const m = Math.max(1, maxChars);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    let w = words[i];
    while (w.length > m) {           // a word longer than the line is split
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, m));
      w = w.slice(m);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= m) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = (last.length >= m ? last.slice(0, m - 1) : last).replace(/\s+$/, '') + '…';
  return kept;
}

export interface LayoutOptions {
  /** The label size, when not the roll's (a sheet's label). */
  widthMm?: number;
  heightMm?: number;
  /** Average character width as a share of its height (0.6 suits the HTML font and the printers' own). */
  charWidth?: number;
}

/**
 * Where everything goes on one label: text auto-fitted (biggest that fits, the name on up to two lines), the barcode
 * the rest of the height (never below ~4 mm when it can be helped), its module a whole number of dots, centred with its
 * quiet zones. Text shrinks first; then the business name goes; then the name keeps one line — each step a warning.
 */
export function layoutLabel(settings: LabelSettings, item: LabelItem, bars: LabelBars | null, opts: LayoutOptions = {}): LabelLayout {
  const widthMm = opts.widthMm ?? settings.widthMm;
  const heightMm = opts.heightMm ?? settings.heightMm;
  const dpmm = dotsPerMm(settings.dpi);
  const ratio = opts.charWidth ?? 0.6;
  const W = Math.round(widthMm * dpmm);
  const H = Math.round(heightMm * dpmm);
  const pad = Math.round(Math.min(2.5, Math.max(1, Math.min(widthMm, heightMm) * 0.06)) * dpmm);
  const innerW = W - 2 * pad;
  const innerH = H - 2 * pad;
  const gap = Math.max(2, Math.round(0.4 * dpmm));
  const minFont = Math.round(1.5 * dpmm);
  const maxFont = Math.round(6 * dpmm);
  const warnings: string[] = [];

  const wantBars = settings.showBarcode && !!bars;
  if (settings.showBarcode && !bars) warnings.push('No barcode to print for this item');
  const priceText = settings.showPrice && item.price != null && Number.isFinite(item.price)
    ? formatLabelPrice(item.price, item.currency ?? 'KES') + (settings.unitText ? ` ${settings.unitText}` : '')
    : (settings.unitText && settings.showPrice ? settings.unitText : '');
  const business = settings.showBusiness ? String(item.business ?? '').trim() : '';
  const name = settings.showName ? String(item.name ?? '').trim() : '';

  // The bars' width is fixed by the label's width — work it out first.
  let barsBox: LabelBarsBox | null = null;
  let barsW = 0;
  let moduleDots = 0;
  if (wantBars && bars) {
    const total = bars.modules.length + bars.quietLeft + bars.quietRight;
    const avail = W - 2 * Math.round(0.5 * dpmm);   // the quiet zones may use the label's padding
    moduleDots = Math.max(1, Math.min(Math.round(0.4 * dpmm), Math.floor(avail / total)));
    barsW = bars.modules.length * moduleDots;
    if (total * moduleDots > W) warnings.push('The barcode is wider than the label: use a wider label or a shorter code');
    else if (moduleDots / dpmm < 0.2) warnings.push('The bars are very thin on this label: test-scan one, or use a wider label');
  }
  const minBars = wantBars ? Math.max(Math.round(innerH * 0.28), Math.round(4 * dpmm)) : 0;
  const maxBars = Math.round(Math.max(minBars, innerH * 0.55));

  type Row = { kind: LabelTextKind; text: string; h: number; bold: boolean };
  const plan = (b: number, nameLines: number, withBusiness: boolean): { rows: Row[]; textH: number } => {
    const rows: Row[] = [];
    const fitH = (t: string, h: number) => Math.max(minFont, Math.min(h, Math.floor(innerW / Math.max(1, t.length * ratio))));
    if (withBusiness && business) {
      const h = Math.max(minFont, Math.round(b * 0.75));
      rows.push({ kind: 'business', text: wrapText(business, Math.floor(innerW / (h * ratio)), 1)[0] ?? '', h, bold: false });
    }
    if (name) {
      for (const line of wrapText(name, Math.floor(innerW / (b * ratio)), nameLines)) rows.push({ kind: 'name', text: line, h: b, bold: true });
    }
    if (priceText) {
      const h = Math.max(minFont, Math.round(b * 1.3));
      const fitted = fitH(priceText, h);
      rows.push({ kind: 'price', text: wrapText(priceText, Math.floor(innerW / (fitted * ratio)), 1)[0] ?? '', h: fitted, bold: true });
    }
    if (wantBars && bars && settings.showDigits) {
      const h = Math.max(Math.round(minFont * 0.8), Math.min(Math.round(b * 0.8), Math.floor(barsW / Math.max(1, bars.text.length * ratio))));
      rows.push({ kind: 'digits', text: bars.text, h, bold: false });
    }
    const textH = rows.reduce((s, r) => s + r.h, 0) + gap * Math.max(0, rows.length - 1 + (wantBars ? 1 : 0));
    return { rows, textH };
  };

  const base = Math.max(minFont, Math.min(maxFont, Math.round(innerH * 0.16)));
  const NO_BIZ = 'The business name is left off: the label is too small';
  const ONE_LINE = 'The name is cut to one line to fit the label';
  const tries: Array<[number, number, boolean, string[]]> = [];
  for (let b = base; b >= minFont; b--) tries.push([b, 2, true, []]);
  for (let b = base; b >= minFont; b--) tries.push([b, 2, false, business ? [NO_BIZ] : []]);
  for (let b = base; b >= minFont; b--) tries.push([b, 1, false, business ? [NO_BIZ, ONE_LINE] : [ONE_LINE]]);
  let chosen = plan(minFont, 1, false);
  let notes: string[] = ['The label is too small for everything: the barcode is short'];
  for (const [b, lines, withBiz, why] of tries) {
    const p = plan(b, lines, withBiz);
    if (innerH - p.textH >= minBars) { chosen = p; notes = why; break; }
  }
  warnings.push(...notes);

  const barsH = wantBars ? Math.max(Math.round(2 * dpmm), Math.min(maxBars, innerH - chosen.textH)) : 0;
  const total = chosen.textH + barsH;
  let y = pad + Math.max(0, Math.floor((innerH - total) / 2));
  const texts: LabelText[] = [];
  for (const r of chosen.rows) {
    if (r.kind === 'digits' && barsBox === null && wantBars) {
      barsBox = { x: Math.round((W - barsW) / 2), y, h: barsH, moduleDots, widthDots: barsW };
      y += barsH + gap;
    }
    texts.push({ kind: r.kind, text: r.text, x: pad, y, w: innerW, h: r.h, bold: r.bold });
    y += r.h + gap;
  }
  if (wantBars && barsBox === null) barsBox = { x: Math.round((W - barsW) / 2), y, h: barsH, moduleDots, widthDots: barsW };

  return { widthMm, heightMm, dpi: settings.dpi, dotsPerMm: dpmm, widthDots: W, heightDots: H, texts,
    bars: wantBars ? bars : null, barsBox, warnings };
}

/** What to print: an item, its stored barcode, how many labels. */
export interface LabelRow { item: LabelItem; barcode: string | null; copies: number }
/** The most labels one print run makes (a mistyped quantity must not send 100 000 pages to a printer). */
export const MAX_LABELS_PER_RUN = 2000;

/** One layout per label (each row's copies), its bars drawn by `encode` (barcode.ts's encodeBarcode). */
export function layoutLabels(rows: LabelRow[], settings: LabelSettings, encode: (code: string | null) => LabelBars | null,
  opts: LayoutOptions = {}): LabelLayout[] {
  const out: LabelLayout[] = [];
  for (const r of rows) {
    const n = Math.max(0, Math.floor(Number(r.copies) || 0));
    if (n === 0) continue;
    const l = layoutLabel(settings, r.item, encode(r.barcode), opts);
    for (let k = 0; k < n && out.length < MAX_LABELS_PER_RUN; k++) out.push(l);
  }
  return out;
}

// ── (a)/(b) SVG and the HTML page ────────────────────────────────────────────────────────────────────────────────────

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The bars as runs: [start module, width in modules] for each dark bar. */
export function barRuns(modules: string): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < modules.length) {
    if (modules[i] === '1') { let j = i; while (modules[j] === '1') j++; runs.push([i, j - i]); i = j; } else i++;
  }
  return runs;
}

/** One label as an SVG sized in millimetres (viewBox in the printer's dots, so the bars sit on its dot grid). */
export function labelSvg(l: LabelLayout): string {
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${l.widthMm}mm" height="${l.heightMm}mm" viewBox="0 0 ${l.widthDots} ${l.heightDots}" class="zt-label">`);
  parts.push(`<rect width="${l.widthDots}" height="${l.heightDots}" fill="#fff"/>`);
  if (l.bars && l.barsBox) {
    const b = l.barsBox;
    const rects = barRuns(l.bars.modules).map(([s, n]) => `<rect x="${b.x + s * b.moduleDots}" y="${b.y}" width="${n * b.moduleDots}" height="${b.h}"/>`);
    parts.push(`<g fill="#000" shape-rendering="crispEdges">${rects.join('')}</g>`);
  }
  for (const t of l.texts) {
    const size = Math.max(1, Math.round(t.h * 0.95));
    parts.push(`<text x="${t.x + t.w / 2}" y="${t.y + Math.round(t.h * 0.82)}" font-size="${size}" text-anchor="middle"`
      + ` font-family="Arial, Helvetica, sans-serif"${t.bold ? ' font-weight="700"' : ''} fill="#000">${xml(t.text)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

export interface LabelsHtmlOptions {
  title?: string;
  /** 'roll': one label per page, the page the label's size (any driver: label printer or office printer). */
  mode: 'roll' | 'sheet';
  /** sheet mode: the sheet, and the first free label on the first sheet. */
  sheet?: SheetSettings;
  startAt?: number;
}

/** A print-ready page: every label an SVG, `@page` the label's size (roll) or the sheet's paper (sheet). */
export function labelsHtml(labels: LabelLayout[], o: LabelsHtmlOptions): string {
  const title = xml(o.title ?? 'Labels');
  const head = (css: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>`
    + `*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}svg{display:block}${css}</style></head><body>`;
  if (o.mode === 'roll') {
    const w = labels[0]?.widthMm ?? 50, h = labels[0]?.heightMm ?? 30;
    const css = `@page{size:${w}mm ${h}mm;margin:0}.zt-page{width:${w}mm;height:${h}mm;overflow:hidden;break-after:page;page-break-after:always}`
      + `.zt-page:last-child{break-after:auto;page-break-after:auto}`;
    return head(css) + labels.map((l) => `<div class="zt-page">${labelSvg(l)}</div>`).join('') + '</body></html>';
  }
  const grid = sheetGrid(o.sheet ?? DEFAULT_LABEL_SETTINGS.sheet);
  const places = placeOnSheets(labels.length, grid.cells.length, o.startAt ?? 1);
  const pages: string[][] = [];
  places.forEach((p, k) => {
    const c = grid.cells[p.cell];
    (pages[p.page] ??= []).push(`<div class="zt-cell" style="left:${c.x}mm;top:${c.y}mm;width:${c.w}mm;height:${c.h}mm">${labelSvg(labels[k])}</div>`);
  });
  const css = `@page{size:${grid.pageWidthMm}mm ${grid.pageHeightMm}mm;margin:0}`
    + `.zt-sheet{position:relative;width:${grid.pageWidthMm}mm;height:${grid.pageHeightMm}mm;overflow:hidden;break-after:page;page-break-after:always}`
    + `.zt-sheet:last-child{break-after:auto;page-break-after:auto}.zt-cell{position:absolute;overflow:hidden}`;
  return head(css) + pages.map((cells) => `<div class="zt-sheet">${(cells ?? []).join('')}</div>`).join('') + '</body></html>';
}

// ── (c) TSPL and ZPL ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Plain printable ASCII for a printer's own fonts ("…" → "...", anything else outside ASCII → "?"). */
export function asciiText(s: string): string {
  return String(s ?? '').replace(/…/g, '...').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?');
}

/** TSPL's bitmap fonts "1"–"5" (width × height in dots) at each resolution. */
const TSPL_FONTS: Record<203 | 300, Array<{ id: string; w: number; h: number }>> = {
  203: [{ id: '1', w: 8, h: 12 }, { id: '2', w: 12, h: 20 }, { id: '3', w: 16, h: 24 }, { id: '4', w: 24, h: 32 }, { id: '5', w: 32, h: 48 }],
  300: [{ id: '1', w: 12, h: 20 }, { id: '2', w: 16, h: 28 }, { id: '3', w: 24, h: 32 }, { id: '4', w: 32, h: 48 }, { id: '5', w: 48, h: 64 }],
};

/** The biggest TSPL font × multiplier no taller than `h` dots whose text fits `w` dots (font 1 × 1 at the least). */
export function tsplFont(dpi: 203 | 300, h: number, text: string, w: number): { id: string; mul: number; cw: number; ch: number } {
  let best: { id: string; mul: number; cw: number; ch: number } | null = null;
  for (const f of TSPL_FONTS[dpi]) {
    for (let mul = 1; mul <= 4; mul++) {
      const ch = f.h * mul, cw = f.w * mul;
      if (ch > h || cw * text.length > w) continue;
      if (!best || ch > best.ch || (ch === best.ch && mul < best.mul)) best = { id: f.id, mul, cw, ch };
    }
  }
  const f1 = TSPL_FONTS[dpi][0];
  return best ?? { id: f1.id, mul: 1, cw: f1.w, ch: f1.h };
}

const tsplQuote = (s: string): string => asciiText(s).replace(/"/g, '\\["]');

/** One label in TSPL (TSC, most Xprinter label models): SIZE / GAP / CLS / TEXT / BARCODE / PRINT, CRLF-ended. */
export function tsplLabel(l: LabelLayout, gapMm: number, copies = 1): string {
  const out: string[] = [
    `SIZE ${l.widthMm} mm, ${l.heightMm} mm`,
    `GAP ${gapMm} mm, 0 mm`,
    'DIRECTION 1',
    'REFERENCE 0,0',
    'CLS',
  ];
  for (const t of l.texts) {
    let text = asciiText(t.text);
    const f = tsplFont(l.dpi, t.h, text, t.w);
    const fit = Math.max(1, Math.floor(t.w / f.cw));
    if (text.length > fit) text = text.slice(0, fit);
    const x = t.x + Math.max(0, Math.floor((t.w - f.cw * text.length) / 2));
    const y = t.y + Math.max(0, t.h - f.ch);
    out.push(`TEXT ${x},${y},"${f.id}",0,${f.mul},${f.mul},"${tsplQuote(text)}"`);
  }
  if (l.bars && l.barsBox) {
    const b = l.barsBox, m = b.moduleDots;
    const [type, data] = l.bars.symbology === 'EAN13' ? ['EAN13', l.bars.data.slice(0, 12)]
      : l.bars.symbology === 'UPCA' ? ['UPCA', l.bars.data.slice(0, 11)] : ['128', l.bars.data];
    out.push(`BARCODE ${b.x},${b.y},"${type}",${b.h},0,0,${m},${m},"${tsplQuote(data)}"`);
  }
  out.push(`PRINT 1,${Math.max(1, Math.floor(copies))}`);
  return out.join('\r\n') + '\r\n';
}

/** ^FH escapes: "_" introduces a hex byte, "^" and "~" would start a command. */
const zplField = (s: string): string => String(s ?? '').replace(/_/g, '_5F').replace(/\^/g, '_5E').replace(/~/g, '_7E');

/** Code 128 data for ZPL's ^BC in mode N: the subset invocation codes (>: start B, >; start C, >5 to C, >6 to B). */
export function zplCode128Data(segments: Array<{ set: 'B' | 'C'; text: string }>): string {
  return segments.map((s, k) => (k === 0 ? (s.set === 'C' ? '>;' : '>:') : (s.set === 'C' ? '>5' : '>6'))
    + (s.set === 'B' ? s.text.replace(/>/g, '><') : s.text)).join('');
}

/** One label in ZPL II (Zebra): ^PW/^LL the label, ^A0 scalable text centred in a field block, ^BE/^BU/^BC the bars. */
export function zplLabel(l: LabelLayout, copies = 1): string {
  const out: string[] = ['^XA', '^CI28', `^PW${l.widthDots}`, `^LL${l.heightDots}`, '^LH0,0'];
  for (const t of l.texts) {
    out.push(`^FO${t.x},${t.y}^A0N,${t.h}^FB${t.w},1,0,C,0^FH^FD${zplField(t.text)}^FS`);
  }
  if (l.bars && l.barsBox) {
    const b = l.barsBox;
    const sym = l.bars.symbology === 'EAN13' ? `^BEN,${b.h},N,N^FD${l.bars.data.slice(0, 12)}`
      : l.bars.symbology === 'UPCA' ? `^BUN,${b.h},N,N,N^FD${l.bars.data.slice(0, 11)}`
      : `^BCN,${b.h},N,N,N,N^FH^FD${zplField(zplCode128Data(l.bars.segments ?? [{ set: 'B', text: l.bars.data }]))}`;
    out.push(`^FO${b.x},${b.y}^BY${b.moduleDots}${sym}^FS`);
  }
  out.push(`^PQ${Math.max(1, Math.floor(copies))}`, '^XZ');
  return out.join('\n') + '\n';
}

/** A string as bytes: TSPL as Latin-1 (asciiText keeps it ASCII), ZPL as UTF-8 (^CI28). */
export function textBytes(s: string, utf8 = false): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 63;
    if (!utf8 || c < 0x80) out.push(c < 0x100 ? c : 63);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

// ── (d) The receipt printer (ESC/POS) ────────────────────────────────────────────────────────────────────────────────

export interface EscposLabelOptions {
  paperWidthMm: 58 | 80;
  /** 'gsk': the printer draws the bars (GS k); 'raster': ZapTill sends them as an image (GS v 0) — for printers whose
   *  GS k is missing or wrong. */
  mode: 'gsk' | 'raster';
  copies?: number;
  /** The bars' height in dots (default 80 — 10 mm). */
  barHeightDots?: number;
}

/** The receipt printer's printable dots: 384 on 58 mm paper, 576 on 80 mm. */
export const escposDots = (paperWidthMm: 58 | 80): number => (paperWidthMm === 58 ? 384 : 576);

/** GS k data for the bars: EAN-13 12 digits (m 67), UPC-A 11 (m 65), CODE128 with its {B / {C subset codes (m 73). */
export function escposBarcodeCommand(bars: LabelBars): number[] {
  if (bars.symbology === 'EAN13') { const d = textBytes(bars.data.slice(0, 12)); return [0x1d, 0x6b, 67, d.length, ...d]; }
  if (bars.symbology === 'UPCA') { const d = textBytes(bars.data.slice(0, 11)); return [0x1d, 0x6b, 65, d.length, ...d]; }
  const data: number[] = [];
  for (const s of bars.segments ?? [{ set: 'B' as const, text: bars.data }]) {
    data.push(0x7b, s.set === 'C' ? 0x43 : 0x42);   // {C / {B
    if (s.set === 'C') for (let i = 0; i < s.text.length; i += 2) data.push(Number(s.text.slice(i, i + 2)));
    else for (const b of textBytes(s.text)) { data.push(b); if (b === 0x7b) data.push(0x7b); }   // "{" is sent as "{{"
  }
  return [0x1d, 0x6b, 73, data.length, ...data];
}

/** The bars as a GS v 0 raster image: `moduleDots` per module, the quiet zones white, centred on the paper. */
export function escposBarsRaster(bars: LabelBars, paperWidthMm: 58 | 80, heightDots: number): number[] {
  const dots = escposDots(paperWidthMm);
  const total = bars.modules.length + bars.quietLeft + bars.quietRight;
  const m = Math.max(1, Math.min(4, Math.floor(dots / total)));
  const widthBytes = dots / 8;
  const left = Math.floor((dots - bars.modules.length * m) / 2);
  const row = new Array<number>(widthBytes).fill(0);
  for (let i = 0; i < bars.modules.length; i++) {
    if (bars.modules[i] !== '1') continue;
    for (let k = 0; k < m; k++) { const x = left + i * m + k; if (x >= 0 && x < dots) row[x >> 3] |= 0x80 >> (x & 7); }
  }
  const out = [0x1d, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, heightDots & 0xff, heightDots >> 8];
  for (let y = 0; y < heightDots; y++) out.push(...row);
  return out;
}

/** A label on the receipt roll: business, name, price, the bars and their digits, then a cut. One per copy. */
export function escposLabel(settings: LabelSettings, item: LabelItem, bars: LabelBars | null, o: EscposLabelOptions): number[] {
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
  const out: number[] = [ESC, 0x40];   // ESC @ — initialise
  const line = (s: string) => { out.push(...textBytes(asciiText(s)), LF); };
  const height = Math.max(16, Math.min(255, Math.floor(o.barHeightDots ?? 80)));
  const copies = Math.max(1, Math.floor(o.copies ?? 1));
  for (let c = 0; c < copies; c++) {
    out.push(ESC, 0x61, 0x01);   // ESC a 1 — centre
    if (settings.showBusiness && item.business) line(item.business);
    if (settings.showName && item.name) { out.push(ESC, 0x45, 0x01); line(item.name); out.push(ESC, 0x45, 0x00); }
    if (settings.showPrice && item.price != null && Number.isFinite(item.price)) {
      out.push(GS, 0x21, 0x11); line(formatLabelPrice(item.price, item.currency ?? 'KES')); out.push(GS, 0x21, 0x00);   // double size
      if (settings.unitText) line(settings.unitText);
    } else if (settings.showPrice && settings.unitText) line(settings.unitText);
    if (settings.showBarcode && bars) {
      if (o.mode === 'gsk') {
        const total = bars.modules.length + bars.quietLeft + bars.quietRight;
        const w = Math.max(2, Math.min(6, Math.floor(escposDots(o.paperWidthMm) / total)));
        out.push(GS, 0x68, height);                              // GS h — bar height
        out.push(GS, 0x77, w);                                   // GS w — module width
        out.push(GS, 0x48, settings.showDigits ? 0x02 : 0x00);   // GS H — digits below (or none)
        out.push(GS, 0x66, 0x00);                                // GS f — digits in font A
        out.push(...escposBarcodeCommand(bars), LF);
      } else {
        out.push(...escposBarsRaster(bars, o.paperWidthMm, height));
        if (settings.showDigits) line(bars.text);
      }
    }
    out.push(LF, LF, LF, GS, 0x56, 0x42, 0x00);   // feed, GS V 66 0 — partial cut
  }
  return out;
}
