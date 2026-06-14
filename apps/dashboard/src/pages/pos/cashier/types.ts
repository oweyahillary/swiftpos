/**
 * Shared types for the CashierScreen and its sub-components.
 * Single source of truth — import from here, not from CashierScreen.
 */

import type { CartItem } from '../../../lib/cart';
import type { Product, Category, VariantGroup, VariantOption } from '../../../types';
import type { BusinessMode } from '../../../context/POSAuthContext';

export type { BusinessMode };

export interface Table {
  id: string;
  name: string;
  capacity: number;
  sort_order: number;
  slot_type?: 'dining' | 'parking_bay';
  pos_x?: number;
  pos_y?: number;
  zone?: string;
  shape?: 'rect' | 'circle';
}

export interface Pump {
  id: string;
  name: string;
  sort_order: number;
  status: 'idle' | 'dispensing' | 'inactive';
}

export interface ParkingSession {
  id: string;
  bay_id: string;
  vehicle_plate?: string;
  vehicle_type: string;
  rate_per_hour: number;
  started_at: string;
  status: 'open' | 'completed' | 'voided';
}

export interface OpenOrder {
  tableId: string | null;
  tableName: string;
  cart: CartItem[];
  covers: number;
  openedAt: number;
  parkingSessionId?: string;
  vehiclePlate?: string;
  ratePerHour?: number;
  pumpId?: string;
  pumpName?: string;
}

export interface ActivePromo {
  id: string;
  name: string;
  promo_type: string;
  discount_type: 'percentage' | 'fixed' | null;
  discount_value: number | null;
  min_quantity: number;
  free_quantity: number | null;
  applies_to: string;
}

export interface POSInitResponse {
  products: Product[];
  categories: Category[];
  branchId: string | null;
  variantsByProduct: Record<string, VariantGroup[]>;
  businessType: string;
  businessName: string;
  currency: string;
  loyaltyEnabled: boolean;
}

export type { CartItem, Product, Category, VariantGroup, VariantOption };

// ── Floor plan constants ────────────────────────────────────────────────────
export const FLOOR_W = 800;
export const FLOOR_H = 520;
export const TABLE_W = 72;
export const TABLE_H = 52;
export const ZONE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'Main Hall': { bg: '#1e3a5f', border: '#2563eb', text: '#93c5fd' },
  'Terrace':   { bg: '#14532d', border: '#16a34a', text: '#86efac' },
  'Private':   { bg: '#3b0764', border: '#9333ea', text: '#d8b4fe' },
  'Bar':       { bg: '#451a03', border: '#d97706', text: '#fcd34d' },
  'VIP':       { bg: '#500724', border: '#db2777', text: '#f9a8d4' },
};
export const DEFAULT_ZONE = { bg: '#1f2937', border: '#4b5563', text: '#9ca3af' };
export function zoneColor(zone?: string) {
  return zone ? (ZONE_COLORS[zone] ?? DEFAULT_ZONE) : DEFAULT_ZONE;
}

// ── Helpers ───────────────────────────────────────────────────────────────
export const VAT_RATE = 16;

export function fmt(amount: number, currency: string) {
  return `${currency} ${Number(amount).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function timeAgo(ts: number) {
  if (!ts || isNaN(ts)) return '—';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (isNaN(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

export function deriveMode(raw: string): BusinessMode {
  const t = raw.toLowerCase().replace(/\s+/g, '_');
  const valid: BusinessMode[] = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'];
  return valid.includes(t as BusinessMode) ? (t as BusinessMode) : 'other';
}
