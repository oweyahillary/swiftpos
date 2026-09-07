// Types for the generated escposRenderer.js (built from shared/printing via
// scripts/build-escpos-renderer.mjs). Renders a receipt to ESC/POS in the browser.
import type { ReceiptOrder, ReceiptBusinessConfig } from './buildReceiptOrder';
type Render = (order: ReceiptOrder, business: ReceiptBusinessConfig, paperWidth: 58 | 80) => Uint8Array;
export const renderEscPos: Render;         // customer receipt (back-compat alias)
export const renderReceiptEscPos: Render;  // customer receipt
export const renderKitchenEscPos: Render;  // kitchen ticket (all items, no prices)
export const renderDispatchEscPos: Render; // dispatch/packaging ticket

export function isExcludedFromKitchen(name: string, exclusions: string[]): boolean;

export interface WebStation { id: string; kind: 'receipt' | 'kitchen' | 'dispatch'; paperWidthMm: 58 | 80; }
export function renderStationEscPos(order: ReceiptOrder, business: ReceiptBusinessConfig, station: WebStation): Uint8Array;
export interface StationIds { kitchen: string[]; dispatch: string[]; }
export interface CategoryRouting { byCategory: Record<string, string[]>; kitchenCategories: Set<string>; }
export function idsByKind(stations: any[]): StationIds;
export function stationsForCategory(categoryId: string | null | undefined, ids: StationIds, routing: CategoryRouting): string[];
export function toUnits(line: any, ids: StationIds, lineStationIds: string[], routing: CategoryRouting): any[];
