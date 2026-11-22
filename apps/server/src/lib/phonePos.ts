/**
 * phonePos.ts — PURE (import-free, so Node 24 type-strips it and a test loads it with no build) resolution of who sees the
 * "Open POS" shortcut in the OWNER / MANAGER PHONE app. The IO (reading the stored map) is in phonePosRoles.ts.
 *
 * Owner, 2026-11-22: "on the mobile app remove pos on the menu on the owner and other senior management, only the hotel
 * manager and cashier should have that option" → a per-role switch. Presentational only (the POS still enforces the sell
 * right; the browser dashboard and desktop POS are untouched). See phonePosRoles.ts for the full why.
 */

export const PHONE_POS_SETTING_KEY = 'phone_pos_roles';

/** The owner's explicit per-role choice: { [roleId]: boolean }. A role left out uses the default (phonePosFor). */
export type PhonePosMap = Record<string, boolean>;

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }

/** The stored value (text JSON or already-parsed) as a clean { roleId: boolean } map — anything else is dropped. */
export function asPhonePosMap(raw: unknown): PhonePosMap {
  const o = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: PhonePosMap = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (typeof v === 'boolean' && k) out[k] = v;
  return out;
}

/**
 * Does this person see "Open POS" in the phone app? An explicit per-role override wins; otherwise the default is:
 * a selling role (`sells`) that is not the owner shows it; the owner and non-selling (back-office) roles do not.
 */
export function phonePosFor(map: PhonePosMap, roleId: string | null | undefined, isOwner: boolean, sells: boolean): boolean {
  if (roleId && Object.prototype.hasOwnProperty.call(map, roleId)) return map[roleId] === true;
  return !isOwner && sells;
}
