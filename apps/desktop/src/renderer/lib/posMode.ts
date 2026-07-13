/**
 * posMode — business-type branching for the till.
 *
 * Mirrors the dashboard's deriveMode() (CashierScreen.tsx) exactly: same
 * values, same normalisation, so a business type chosen at install behaves
 * identically on web and desktop.
 *
 * Desktop reality check: the dashboard's restaurant mode opens with a synced
 * table map, parking with bays, petrol with pumps — all live server queries.
 * The till is offline-first and none of those entities sync locally yet, so
 * the desktop ships the slice that works fully offline:
 *
 *   restaurant/cafe → order types (dine-in/takeaway), manual table number,
 *                     held orders (tabs), send-to-kitchen KOT printing
 *   everything else → the retail grid
 *
 * When tables/pumps/bays get a pull direction in the sync engine, the slot
 * pickers port over the same way the payment legs did.
 */

export type BusinessMode =
  | 'restaurant' | 'cafe' | 'retail' | 'minimart'
  | 'parking' | 'petrol_station' | 'other';

export function deriveMode(raw: string | null | undefined): BusinessMode {
  const t = (raw ?? 'retail').toLowerCase().replace(/\s+/g, '_');
  const valid: BusinessMode[] = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'];
  return valid.includes(t as BusinessMode) ? (t as BusinessMode) : 'other';
}

export interface ModeFlags {
  mode: BusinessMode;
  isRestaurant: boolean;   // restaurant or cafe — order types + tabs + KOT
  isPetrol: boolean;       // petrol_station — pump grid + fuel sales
  defaultOrderType: 'dine_in' | 'retail';
}

export function modeFlags(raw: string | null | undefined): ModeFlags {
  const mode = deriveMode(raw);
  const isRestaurant = mode === 'restaurant' || mode === 'cafe';
  const isPetrol = mode === 'petrol_station';
  return {
    mode,
    isRestaurant,
    isPetrol,
    defaultOrderType: isRestaurant ? 'dine_in' : 'retail',
  };
}
