// IPC: A571 — barcode labels on the till (Manager › Stock › Labels), on ANY printer and ANY label size.
//
// Owner, 2026-10-22: "we do not have barcode generation mechanism, what does it entail can we add it?" — then, on the
// label printer and size: "for now i cant tell what my clients will use as their printer or the label size can we do all?"
//
// Three ways out, chosen at print time (labels.ts holds the one layout every way uses):
//   windows  any printer with a Windows driver (a label printer — Xprinter, TSC, Zebra, Godex — or an office printer):
//            one page per label, the page the label's size (printService.printLabelsHtml);
//   tspl     TSC and most Xprinter label models WITHOUT a driver — TSPL bytes to IP:9100 or the USB printer raw;
//   zpl      Zebra without a driver — ZPL bytes, the same way;
//   escpos   the receipt printer: GS k (EAN-13 / UPC-A / CODE128) or the bars as a raster image, on plain thermal paper.
// The items, their barcodes and prices are this till's own catalogue (works offline); the label settings are the
// business's (GET /api/products/labels/settings — the web's Print labels page sets the same), kept here for offline.
// The printer set-up is this till's own (a printer is a machine, not the business's — as station_printers, A250).
//
//   labels:setup   menu.edit | inventory.view (+ the online licence, as the other Stock screens — A460)
//   labels:save    the same keys; the business's settings go to the cloud only with menu.edit
//   labels:print   the same keys
import { getLocalDb } from '../localDb';
import { assertPayload } from '../ipcValidate';
import { signedInCan } from '../tillAccess';
import { sendToPrinter, parseTarget } from '@swiftpos/printing';
import { printLabelsHtml } from '../printService';
import { encodeBarcode } from '../barcode';
import {
  cleanLabelSettings, layoutLabel, layoutLabels, labelsHtml, tsplLabel, zplLabel, escposLabel, textBytes,
  type LabelSettings, type LabelRow,
} from '../labels';
import { type IpcShared } from './shared';

export const LABEL_KEYS = ['menu.edit', 'inventory.view'];
export const LABELS_REFUSED = 'Your role does not print labels (it needs the menu or stock).';
export const LABEL_PATHS = ['windows', 'tspl', 'zpl', 'escpos'] as const;
export type LabelPath = typeof LABEL_PATHS[number];

/** This till's label printer. */
export interface LabelPrinter {
  /** The way it prints when nothing else is chosen. */
  path: LabelPath;
  /** windows: the Windows printer's name ('' = the Windows default). */
  windowsPrinter: string;
  /** tspl / zpl: "192.168.1.50" or "192.168.1.50:9100" (network), or "printer:<Windows name>" (USB, sent raw). */
  rawTarget: string;
  /** escpos: the receipt printer's target ('' = this till's Till station printer). */
  escposTarget: string;
  escposWidthMm: 58 | 80;
  escposMode: 'gsk' | 'raster';
}
export const DEFAULT_LABEL_PRINTER: LabelPrinter = { path: 'windows', windowsPrinter: '', rawTarget: '', escposTarget: '', escposWidthMm: 80, escposMode: 'gsk' };

export function cleanLabelPrinter(raw: unknown): LabelPrinter {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  return {
    path: (LABEL_PATHS as readonly string[]).includes(r.path) ? r.path : DEFAULT_LABEL_PRINTER.path,
    windowsPrinter: str(r.windowsPrinter),
    rawTarget: str(r.rawTarget),
    escposTarget: str(r.escposTarget),
    escposWidthMm: Number(r.escposWidthMm) === 58 ? 58 : 80,
    escposMode: r.escposMode === 'raster' ? 'raster' : 'gsk',
  };
}

// The transports, replaceable by a test (a stubbed printer).
let sendRaw: (target: string, bytes: Buffer) => Promise<void> = (target, bytes) => sendToPrinter(parseTarget(target), bytes);
let printHtml: typeof printLabelsHtml = printLabelsHtml;
export function _setLabelTransport(fn: typeof sendRaw): void { sendRaw = fn; }
export function _setLabelHtmlPrinter(fn: typeof printLabelsHtml): void { printHtml = fn; }

const SETUP_SCHEMA = `CREATE TABLE IF NOT EXISTS label_setup (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  settings   TEXT,
  printer    TEXT,
  updated_at INTEGER NOT NULL
)`;
function setupRow(): { settings: string | null; printer: string | null } | null {
  const db = getLocalDb();
  db.exec(SETUP_SCHEMA);
  return (db.prepare(`SELECT settings, printer FROM label_setup WHERE id = 1`).get() as { settings: string | null; printer: string | null } | undefined) ?? null;
}
function keepSetup(patch: { settings?: LabelSettings; printer?: LabelPrinter }): void {
  const cur = setupRow();
  getLocalDb().prepare(`INSERT INTO label_setup (id, settings, printer, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, printer = excluded.printer, updated_at = excluded.updated_at`).run(
    patch.settings ? JSON.stringify(patch.settings) : cur?.settings ?? null,
    patch.printer ? JSON.stringify(patch.printer) : cur?.printer ?? null,
    Date.now());
}
export function savedLabelSettings(): LabelSettings | null {
  const s = setupRow()?.settings;
  return s ? cleanLabelSettings(s) : null;
}
export function savedLabelPrinter(): LabelPrinter {
  const p = setupRow()?.printer;
  try { return cleanLabelPrinter(p ? JSON.parse(p) : null); } catch { return { ...DEFAULT_LABEL_PRINTER }; }
}

interface LocalProduct { id: string; name: string; barcode: string | null; price: number; category_id: string | null; category: string | null }
/** This till's active products, at this branch's price (branch_price, else the base price). */
export function labelProducts(): LocalProduct[] {
  const db = getLocalDb();
  let rows: any[];
  try {
    rows = db.prepare(`SELECT p.id, p.name, p.barcode, COALESCE(p.branch_price, p.base_price) AS price, p.category_id, c.name AS category
      FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE COALESCE(p.status, 'active') = 'active' ORDER BY p.name`).all() as any[];
  } catch {
    rows = db.prepare(`SELECT id, name, NULL AS barcode, base_price AS price, category_id, NULL AS category FROM products
      WHERE COALESCE(status, 'active') = 'active' ORDER BY name`).all() as any[];
  }
  return rows.map((r) => ({ id: String(r.id), name: String(r.name ?? ''), barcode: r.barcode ? String(r.barcode) : null,
    price: Number(r.price) || 0, category_id: r.category_id ?? null, category: r.category ?? null }));
}

function businessOnTill(): { name: string; currency: string } {
  try {
    const r = getLocalDb().prepare(`SELECT business_name, currency FROM session WHERE id = 1`).get() as { business_name?: string; currency?: string } | undefined;
    return { name: r?.business_name ?? '', currency: r?.currency || 'KES' };
  } catch { return { name: '', currency: 'KES' }; }
}

/** The receipt printer bound on this till (its Till station), for path (d) when none is named. */
export function receiptPrinterTarget(): { target: string; paperWidthMm: 58 | 80 } | null {
  try {
    const r = getLocalDb().prepare(`SELECT sp.target, sp.paper_width_mm FROM station_printers sp
      LEFT JOIN print_stations ps ON ps.id = sp.station_id
      WHERE ps.kind = 'receipt' OR sp.station_id = 'receipt' LIMIT 1`).get() as { target: string; paper_width_mm: number } | undefined;
    return r ? { target: r.target, paperWidthMm: r.paper_width_mm === 58 ? 58 : 80 } : null;
  } catch { return null; }
}

export interface LabelPrintRequest { items: Array<{ product_id: string; copies: number }>; path?: LabelPath }

/** Prints the labels the way asked (else this till's way). Never throws for a printer fault — it answers with it. */
export async function printLabels(req: LabelPrintRequest, settings: LabelSettings, printer: LabelPrinter): Promise<{ ok: boolean; labels: number; bytes?: number; error?: string; warnings?: string[] }> {
  const path: LabelPath = req.path && (LABEL_PATHS as readonly string[]).includes(req.path) ? req.path : printer.path;
  const byId = new Map(labelProducts().map((p) => [p.id, p]));
  const biz = businessOnTill();
  const rows: Array<LabelRow & { id: string }> = [];
  for (const it of req.items ?? []) {
    const p = byId.get(String(it.product_id));
    const copies = Math.max(0, Math.min(999, Math.floor(Number(it.copies) || 0)));
    if (!p || copies === 0) continue;
    rows.push({ id: p.id, item: { name: p.name, price: p.price, currency: biz.currency, business: biz.name }, barcode: p.barcode, copies });
  }
  const labels = rows.reduce((s, r) => s + r.copies, 0);
  if (!labels) return { ok: false, labels: 0, error: 'Choose the items and how many labels of each.' };
  const warnings = new Set<string>();
  try {
    if (path === 'windows') {
      const layouts = layoutLabels(rows, settings, encodeBarcode);
      layouts.forEach((l) => l.warnings.forEach((w) => warnings.add(w)));
      const r = await printHtml({ html: labelsHtml(layouts, { mode: 'roll', title: 'Labels' }), deviceName: printer.windowsPrinter,
        widthMm: settings.widthMm, heightMm: settings.heightMm });
      return r.ok ? { ok: true, labels: layouts.length, warnings: [...warnings] }
        : { ok: false, labels: 0, error: `The labels did not print on ${printer.windowsPrinter || 'the Windows default printer'}: ${r.error ?? 'no answer'}` };
    }
    if (path === 'tspl' || path === 'zpl') {
      if (!printer.rawTarget) return { ok: false, labels: 0, error: 'Set the label printer\'s address (its IP, or the USB printer) first.' };
      const out: number[] = [];
      for (const r of rows) {
        const l = layoutLabel(settings, r.item, encodeBarcode(r.barcode));
        l.warnings.forEach((w) => warnings.add(w));
        out.push(...(path === 'tspl' ? textBytes(tsplLabel(l, settings.gapMm, r.copies)) : textBytes(zplLabel(l, r.copies), true)));
      }
      await sendRaw(printer.rawTarget, Buffer.from(out));
      return { ok: true, labels, bytes: out.length, warnings: [...warnings] };
    }
    // escpos — the receipt printer
    const bound = receiptPrinterTarget();
    const target = printer.escposTarget || bound?.target || '';
    if (!target) return { ok: false, labels: 0, error: 'No receipt printer is set up on this till (Settings › Printing), and none is named here.' };
    const width = printer.escposTarget ? printer.escposWidthMm : (bound?.paperWidthMm ?? printer.escposWidthMm);
    const out: number[] = [];
    for (const r of rows) {
      out.push(...escposLabel(settings, r.item, encodeBarcode(r.barcode), { paperWidthMm: width, mode: printer.escposMode, copies: r.copies }));
    }
    await sendRaw(target, Buffer.from(out));
    return { ok: true, labels, bytes: out.length };
  } catch (e: any) {
    return { ok: false, labels: 0, error: e?.message ?? String(e) };
  }
}

export function registerLabelHandlers(ctx: Pick<IpcShared, 'handle' | 'requireKey' | 'manageFetch' | 'requireOnlineLicence'>) {
  const { handle, requireKey, manageFetch, requireOnlineLicence } = ctx;

  handle('labels:setup', async () => {
    requireOnlineLicence();
    requireKey(LABEL_KEYS, LABELS_REFUSED);
    let settings = savedLabelSettings();
    let from: 'cloud' | 'saved' | 'default' = settings ? 'saved' : 'default';
    try {
      const cloud = cleanLabelSettings(await manageFetch('/api/products/labels/settings', 'GET'));
      settings = cloud; from = 'cloud';
      keepSetup({ settings: cloud });
    } catch { /* offline: the last copy kept here, else the default */ }
    return {
      settings: settings ?? cleanLabelSettings(null), from, printer: savedLabelPrinter(),
      products: labelProducts(), business: businessOnTill(), receiptPrinter: receiptPrinterTarget(),
      canSaveForBusiness: signedInCan('menu.edit'),
    };
  });

  handle('labels:save', async (_e, payload) => {
    const p = assertPayload<{ settings?: unknown; printer?: unknown }>({ settings: { t: 'any', optional: true }, printer: { t: 'any', optional: true } }, payload);
    requireOnlineLicence();
    requireKey(LABEL_KEYS, LABELS_REFUSED);
    const settings = p.settings !== undefined ? cleanLabelSettings(p.settings) : undefined;
    const printer = p.printer !== undefined ? cleanLabelPrinter(p.printer) : undefined;
    keepSetup({ settings, printer });
    let cloud: 'saved' | 'offline' | 'not-allowed' | null = null;
    if (settings) {
      if (!signedInCan('menu.edit')) cloud = 'not-allowed';
      else {
        try { await manageFetch('/api/products/labels/settings', 'PUT', settings); cloud = 'saved'; }
        catch { cloud = 'offline'; }
      }
    }
    return { ok: true, settings: settings ?? savedLabelSettings(), printer: printer ?? savedLabelPrinter(), cloud };
  });

  handle('labels:print', async (_e, payload) => {
    const p = assertPayload<{ items: Array<{ product_id: string; copies: number }>; path?: string; settings?: unknown }>(
      { items: { t: 'any' }, path: { t: 'string', optional: true }, settings: { t: 'any', optional: true } }, payload);
    requireOnlineLicence();
    requireKey(LABEL_KEYS, LABELS_REFUSED);
    if (!Array.isArray(p.items)) return { ok: false, labels: 0, error: 'Choose the items to print.' };
    // The settings on the screen (not yet saved) print as they are shown; else the ones kept here.
    const settings = p.settings !== undefined ? cleanLabelSettings(p.settings) : savedLabelSettings() ?? cleanLabelSettings(null);
    return printLabels({ items: p.items, path: p.path as LabelPath | undefined }, settings, savedLabelPrinter());
  });
}
