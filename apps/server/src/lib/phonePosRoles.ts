/**
 * phonePosRoles.ts — Owner, 2026-11-22: who sees the "Open POS" shortcut in the OWNER / MANAGER PHONE app (the IO side;
 * the pure resolution is in phonePos.ts, kept import-free so a test type-strips it on Node 24 with no build).
 *
 * "on the mobile app remove pos on the menu on the owner and other senior management, only the hotel manager and cashier
 *  should have that option on the mobile app" — then: a per-role switch so the owner picks exactly which roles see it.
 *
 * This is PRESENTATIONAL only. It hides a menu shortcut on ONE surface (the phone app's embedded dashboard); it is not a
 * selling right — the POS still enforces orders.create server-side, and the web browser dashboard and the desktop POS are
 * never touched by it. So it is a business setting, not a permission key in the security catalogue.
 *
 * Stored in business_settings under PHONE_POS_SETTING_KEY as JSON { [roleId]: boolean } — an explicit per-role override.
 * A role NOT in the map uses the default (phonePosFor): a selling role that is not the owner shows it; the owner and
 * back-office (non-selling) roles do not.
 */
import { supabase } from './supabase';
import { PHONE_POS_SETTING_KEY, asPhonePosMap, type PhonePosMap } from './phonePos';

export { PHONE_POS_SETTING_KEY, asPhonePosMap, phonePosFor } from './phonePos';
export type { PhonePosMap } from './phonePos';

export async function readPhonePosMap(businessId: string | undefined | null): Promise<PhonePosMap> {
  if (!businessId) return {};
  const { data } = await supabase.from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', PHONE_POS_SETTING_KEY).maybeSingle();
  return asPhonePosMap((data as { value?: unknown } | null)?.value);
}
