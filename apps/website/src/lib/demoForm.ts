/**
 * The demo request form's checks (Phase 3, front end only). The cloud route that will receive it does not exist yet:
 * it is server work (a migration, the admin list, the Telegram notice; WEBSITE-BRIEF §7). The server must repeat every
 * check here; these only save the visitor a wasted send.
 *
 * Spam protection planned (brief §7): Turnstile, a honeypot, a time check, rate limits, Kenyan phone and email checks.
 * This file covers what the browser can: the honeypot, the time check, the phone and the email shape.
 */

export const BUSINESS_TYPES = [
  { value: 'restaurant', label: 'Restaurant or café' },
  { value: 'bar', label: 'Bar or lounge' },
  { value: 'quick_service', label: 'Quick service or takeaway' },
  { value: 'retail', label: 'Shop or minimart' },
  { value: 'petrol_station', label: 'Petrol station' },
  { value: 'other', label: 'Something else' },
] as const;

/** A form sent sooner than this after the page opened is treated as a bot. */
export const MIN_FILL_MS = 4000;

export interface DemoRequest {
  name: string;
  business: string;
  type: string;
  branches: string;
  phone: string;
  email: string;
  town: string;
  message: string;
  /** The honeypot: hidden from people, so anything in it means a bot. */
  website: string;
}

/**
 * A Kenyan mobile or landline-style number in any common spelling, as +254 and nine digits, or null.
 * "0717 675 635", "0717675635", "+254 717 675 635", "254717675635" and "0110 123 456" all pass.
 */
export function kenyanPhone(raw: string): string | null {
  const d = String(raw ?? '').replace(/[\s\-().]/g, '');
  let rest: string | null = null;
  if (/^\+254\d{9}$/.test(d)) rest = d.slice(4);
  else if (/^254\d{9}$/.test(d)) rest = d.slice(3);
  else if (/^0\d{9}$/.test(d)) rest = d.slice(1);
  if (!rest || !/^[17]\d{8}$/.test(rest)) return null;
  return `+254${rest}`;
}

/** A plain shape check; the server checks the domain. Empty is allowed (the email is optional). */
export function emailOk(raw: string): boolean {
  const e = String(raw ?? '').trim();
  return e === '' || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

export type FieldErrors = Partial<Record<keyof DemoRequest | 'form', string>>;

/** What is wrong with the form, field by field, in plain words. Empty: fine to send. */
export function checkDemoRequest(r: DemoRequest, openedAt: number, now: number): FieldErrors {
  const e: FieldErrors = {};
  if (r.website.trim() !== '' || now - openedAt < MIN_FILL_MS) {
    e.form = 'Please try again in a moment.';
    return e;
  }
  if (r.name.trim().length < 2) e.name = 'Please tell us your name.';
  if (r.business.trim().length < 2) e.business = "Please tell us your business's name.";
  if (!BUSINESS_TYPES.some((t) => t.value === r.type)) e.type = 'Please choose what kind of business it is.';
  if (!kenyanPhone(r.phone)) e.phone = 'Please give a Kenyan phone number, like 0717 675 635.';
  if (!emailOk(r.email)) e.email = 'That email address does not look right.';
  if (r.branches.trim() !== '' && !/^\d{1,3}$/.test(r.branches.trim())) e.branches = 'Please give the number of branches.';
  if (r.message.length > 1000) e.message = 'Please keep the message under 1,000 characters.';
  return e;
}
