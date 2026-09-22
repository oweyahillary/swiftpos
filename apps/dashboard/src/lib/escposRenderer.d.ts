// Types for the generated escposRenderer.js (built from shared/printing via
// scripts/build-escpos-renderer.mjs). Renders receipts, station tickets and the
// shift report to ESC/POS in the browser.
//
// THIS FILE MIRRORS THE GENERATED BUNDLE. When the bundle is regenerated and its
// export surface changes, update these declarations to match — the bundle is the
// source of truth, not this file (A270: they had drifted, breaking the dashboard
// type-check ratchet).
import type { ReceiptOrder, ReceiptBusinessConfig } from './buildReceiptOrder';

// reprint marker printed on a duplicate; omitted on a first print.
export interface ReprintMeta { at: Date; count: number; }

type Render = (
  order: ReceiptOrder,
  business: ReceiptBusinessConfig,
  paperWidth: 58 | 80,
  reprint?: ReprintMeta,
) => Uint8Array;
export const renderEscPos: Render;         // customer receipt (back-compat alias)
export const renderReceiptEscPos: Render;  // customer receipt
export const renderKitchenEscPos: Render;  // kitchen ticket (all items, no prices)
export const renderDispatchEscPos: Render; // dispatch/packaging ticket

export function isExcludedFromKitchen(name: string, exclusions: string[]): boolean;

// A web printer row rendered as a station. `type` is the branch_printers.type
// (receipt/kitchen/bar/expeditor/kot); the bundle maps it to a station config.
// `proforma` marks the receipt station's output as a BILL, not a fiscal receipt (A269).
export interface WebStation {
  id: string;
  type: 'receipt' | 'kitchen' | 'bar' | 'expeditor' | 'kot';
  paperWidthMm: 58 | 80;
  proforma?: boolean;
}
export function renderStationEscPos(order: ReceiptOrder, business: ReceiptBusinessConfig, station: WebStation): Uint8Array;
// true if this routed station has any printable line for the order (A254: skip blank tickets).
export function stationHasContent(order: ReceiptOrder, business: ReceiptBusinessConfig, station: WebStation): boolean;

// Shift (Z) report, rendered from the server's shift payload.
export function renderShiftReportEscPos(data: any, paperWidthMm: 58 | 80): Uint8Array;

export interface StationIds { kitchen: string[]; dispatch: string[]; }
export interface CategoryRouting { byCategory: Record<string, string[]>; kitchenCategories: Set<string>; }
export function idsByKind(stations: any[]): StationIds;
export function stationsForCategory(categoryId: string | null | undefined, ids: StationIds, routing: CategoryRouting): string[];
export function toUnits(line: any, ids: StationIds, lineStationIds: string[], routing: CategoryRouting): any[];

// A313: receipt-logo raster (shared/printing raster.ts, bundled).
export interface MonoRaster { width: number; height: number; bytes: Uint8Array }
export const RECEIPT_LOGO_MAX_WIDTH: number;
export const RECEIPT_LOGO_MAX_HEIGHT: number;
export function monoRasterFromRGBA(rgba: ArrayLike<number>, width: number, height: number,
  opts?: { threshold?: number; maxWidth?: number; maxHeight?: number }): MonoRaster;
export function monoRasterToString(r: MonoRaster): string;
export function monoRasterFromString(s: string | null | undefined): MonoRaster | null;
export function monoRasterToAscii(r: MonoRaster, black?: string, white?: string): string[];
