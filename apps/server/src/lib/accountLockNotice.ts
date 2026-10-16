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
 */
import { supabase } from './supabase';
import { sendEmailChecked } from './mailer';
import { ACCOUNT_LOCK_MS } from './pinAttempts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Fire-and-forget: tell the account its sign-in was paused. `where`: 'the web dashboard' / 'the web POS'. */
export function notifyAccountLocked(email: unknown, ip: string | null | undefined, where: string): void {
  const to = String(email ?? '').trim().toLowerCase();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return;
  void (async () => {
    try {
      const { data, error } = await supabase.from('users').select('id, name').ilike('email', to).limit(1);
      if (error || !data?.length) return;   // not a ZapTill account — never write to a stranger
      const name = (data[0] as { name?: string | null }).name;
      const minutes = Math.round(ACCOUNT_LOCK_MS / 60_000);
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
      const sent = await sendEmailChecked({
        to,
        subject: 'ZapTill: sign-in paused after wrong attempts',
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">
  <p>Hi${name ? ` ${esc(name)}` : ''},</p>
  <p>There were too many wrong sign-in attempts for this account on ${esc(where)}, so signing in with it is paused for
  ${minutes} minutes (${esc(when)}, East Africa time${ip ? `, from address ${esc(ip)}` : ''}).</p>
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
