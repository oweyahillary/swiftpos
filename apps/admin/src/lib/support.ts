/**
 * support.ts — 0.6.35 (A384): who a shop calls for help — its own tech, or SwiftPOS support.
 *
 * Owner, 2026-10-03: "add the number 0717675635 or 0782972023. Also add the feature in admin where i can allocate a tech
 * to a shop and the number appears instead of a fixed number". A tech is a SwiftPOS team member (admin portal › Team,
 * with a phone); the admin allocates one to a client (admin portal › client). The till's and the web's Help show that
 * tech's name and number; a client with no tech (or a tech with no number) shows SwiftPOS support's two numbers.
 *
 * ONE file: shared/support.ts, copied to the cloud, the till (main + renderer), the web and the admin portal
 * (scripts/check-shared-sync.mjs).
 */

/** SwiftPOS support — shown when a client has no tech allocated. */
export const DEFAULT_SUPPORT_NAME = 'ZapTill support';
export const DEFAULT_SUPPORT_PHONES = ['0717675635', '0782972023'] as const;

/**
 * A Kenyan mobile number in its local form "07XXXXXXXX" / "01XXXXXXXX". Accepts spaces, dashes, "+254…" and "254…".
 * '' / null / undefined = no number (null). undefined = not a number we accept (the caller refuses it).
 */
export function cleanPhone(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (s === '') return null;
  if (s.startsWith('+')) s = s.slice(1);
  if (/^254[17]\d{8}$/.test(s)) s = '0' + s.slice(3);
  return /^0[17]\d{8}$/.test(s) ? s : undefined;
}

/** "0717 675 635" — easy to read out and dial. */
export function displayPhone(phone: string): string {
  const p = cleanPhone(phone);
  return p ? `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}` : String(phone ?? '');
}

/** "254717675635" — for a wa.me link. */
export function whatsappNumber(phone: string): string | null {
  const p = cleanPhone(phone);
  return p ? '254' + p.slice(1) : null;
}

/** What the cloud sends (pos/init, /business/support): the client's tech, or null when none (or none with a number). */
export interface SupportWire { name: string | null; phone: string | null }

/** Who to call, ready to show. assigned = the client's own tech; otherwise SwiftPOS support's numbers. */
export interface SupportContact { name: string; phones: string[]; assigned: boolean }

/** The wire value (or anything stored) → who to call. Never throws; anything unusable → SwiftPOS support. */
export function supportContact(raw: unknown): SupportContact {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const phone = r ? cleanPhone(r.phone) : null;
  if (phone) {
    const name = typeof r!.name === 'string' && r!.name.trim() ? r!.name.trim().slice(0, 80) : 'Your ZapTill technician';
    return { name, phones: [phone], assigned: true };
  }
  return { name: DEFAULT_SUPPORT_NAME, phones: [...DEFAULT_SUPPORT_PHONES], assigned: false };
}

/** The wire value cleaned for storing on the till: a tech with a number, or null (= SwiftPOS support). */
export function supportWire(raw: unknown): SupportWire | null {
  const c = supportContact(raw);
  return c.assigned ? { name: c.name, phone: c.phones[0] } : null;
}
