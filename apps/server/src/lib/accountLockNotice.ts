/**
 * accountLockNotice — A507: an e-mail to the account when wrong sign-ins pause it.
 *
 * Owner, 2026-10-16, on the A494 per-account pause (10 wrong passwords or PINs for one e-mail in 15 minutes pause that
 * e-mail's sign-in for 15 minutes, from anywhere): "keep it but send an email after the failed attempt". The pause stays;
 * the person whose account it is is told at once — when, from which address, and what to do if it was not them — so a
 * lock-out someone else caused is never a mystery, and a real attack is seen the minute it starts.
 *
 * Sent only to an e-mail that belongs to a ZapTill account (a users row): typing a stranger's address ten times never
 * makes the cloud write to them. At most one per pause (noteAccountFailure says when a pause starts). Never blocks or
 * fails the sign-in answer.
 *
 * A514 (owner, 2026-10-16, on the time in the e-mail: "can it read the region"): the time is the business's own local time.
 * There is no country or time-zone column; the business's currency says where it trades (zoneForCurrency). The account's
 * users row names its business (users.business_id → businesses.currency); no business, an unknown currency → Nairobi as
 * before; a currency used across several zones (EUR, USD) → UTC, named as such.
 */
import { supabase } from './supabase';
import { sendEmailChecked } from './mailer';
import { ACCOUNT_LOCK_MS } from './pinAttempts';

/**
 * A514: currency (ISO 4217) → the IANA time zone the e-mail's time is shown in. One zone per currency; where a country spans
 * zones the capital's (CDF: Kinshasa, West Africa time — Lubumbashi is an hour ahead). EUR and USD are used in many zones
 * and say nothing about the place → UTC. Anything else, or none → Africa/Nairobi (where ZapTill's businesses mostly are).
 */
const ZONE_BY_CURRENCY: Readonly<Record<string, string>> = {
  KES: 'Africa/Nairobi', UGX: 'Africa/Kampala', TZS: 'Africa/Dar_es_Salaam', RWF: 'Africa/Kigali', BIF: 'Africa/Bujumbura',
  ETB: 'Africa/Addis_Ababa', SSP: 'Africa/Juba', SOS: 'Africa/Mogadishu', CDF: 'Africa/Kinshasa', NGN: 'Africa/Lagos',
  GHS: 'Africa/Accra', ZAR: 'Africa/Johannesburg', ZMW: 'Africa/Lusaka', MWK: 'Africa/Blantyre', MZN: 'Africa/Maputo',
  ZWL: 'Africa/Harare', ZWG: 'Africa/Harare', EGP: 'Africa/Cairo', MAD: 'Africa/Casablanca', XOF: 'Africa/Dakar',
  XAF: 'Africa/Douala', AED: 'Asia/Dubai', INR: 'Asia/Kolkata', GBP: 'Europe/London',
  EUR: 'UTC', USD: 'UTC',
};
export const DEFAULT_ZONE = 'Africa/Nairobi';
export function zoneForCurrency(currency: unknown): string {
  const c = String(currency ?? '').trim().toUpperCase();
  return ZONE_BY_CURRENCY[c] ?? DEFAULT_ZONE;
}
/** The East Africa time (UTC+3, no daylight saving) zones — named "East Africa time"; any other zone by its city. */
const EAT_ZONES = new Set(['Africa/Nairobi', 'Africa/Kampala', 'Africa/Dar_es_Salaam', 'Africa/Addis_Ababa', 'Africa/Mogadishu',
  'Africa/Djibouti', 'Africa/Asmara']);
/** A514: how the e-mail names the zone — "East Africa time", "UTC", or the zone's city ("Kigali time"). */
export function zoneLabel(zone: string): string {
  if (EAT_ZONES.has(zone)) return 'East Africa time';
  if (zone === 'UTC') return 'UTC';
  return `${(zone.split('/').pop() ?? zone).replace(/_/g, ' ')} time`;
}
/** A514: the moment, in the zone, as the e-mail prints it ("16 Oct 2026, 14:05"). */
export function localTime(at: Date, zone: string): string {
  return at.toLocaleString('en-GB', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' });
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Fire-and-forget: tell the account its sign-in was paused. `where`: 'the web dashboard' / 'the web POS'. */
export function notifyAccountLocked(email: unknown, ip: string | null | undefined, where: string): void {
  const to = String(email ?? '').trim().toLowerCase();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return;
  void (async () => {
    try {
      const at = new Date();
      const { data, error } = await supabase.from('users').select('id, name, business_id').ilike('email', to).limit(1);
      if (error || !data?.length) return;   // not a ZapTill account — never write to a stranger
      const { name, business_id: businessId } = data[0] as { name?: string | null; business_id?: string | null };
      const minutes = Math.round(ACCOUNT_LOCK_MS / 60_000);
      // A514: the business's own time — its currency says where it trades. Unknown → Nairobi (as before), never a failure.
      let currency: string | null = null;
      if (businessId) {
        const { data: biz } = await supabase.from('businesses').select('currency').eq('id', businessId).limit(1);
        currency = ((biz ?? [])[0] as { currency?: string | null } | undefined)?.currency ?? null;
      }
      const zone = zoneForCurrency(currency);
      const when = localTime(at, zone);
      const sent = await sendEmailChecked({
        to,
        subject: 'ZapTill: sign-in paused after wrong attempts',
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">
  <p>Hi${name ? ` ${esc(name)}` : ''},</p>
  <p>There were too many wrong sign-in attempts for this account on ${esc(where)}, so signing in with it is paused for
  ${minutes} minutes (${esc(when)}, ${esc(zoneLabel(zone))}${ip ? `, from address ${esc(ip)}` : ''}).</p>
  <p>If this was you, wait ${minutes} minutes and try again.</p>
  <p><b>If it was not you</b>, someone may be trying to get into your account: change your password (or PIN) as soon as you
  can, and call ZapTill support.</p></div>`,
      });
      if (!sent.ok) console.error(`[auth] A507: could not send the sign-in pause notice: ${sent.error}`);
      else console.warn(`[auth] A507: sign-in paused after wrong attempts — the account was told by e-mail`);
    } catch (e: any) {
      console.error(`[auth] A507: sign-in pause notice failed: ${e?.message ?? e}`);
    }
  })();
}
